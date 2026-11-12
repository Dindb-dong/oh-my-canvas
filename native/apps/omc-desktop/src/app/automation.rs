use super::*;
use base64::Engine;
use serde::Deserialize;
use std::time::{SystemTime, UNIX_EPOCH};

pub(crate) type Reply = SyncSender<Result<Value, String>>;

#[derive(Deserialize)]
pub(crate) struct Job {
    session: String,
    method: String,
    arguments: Value,
    expires: u64,
}

#[derive(Default)]
pub(super) struct State {
    pub(super) gesture: Option<Gesture>,
    pub(super) waiting: Option<Reply>,
    queued: Option<(Job, Reply)>,
    pub(super) last_frame: Option<f64>,
    pub(super) frames_drawn: u64,
}

pub(super) struct Gesture {
    owner: String,
    document: String,
    page: Option<String>,
    expires: Instant,
    camera: Camera,
}

impl App {
    pub(super) fn cancel_automation_gesture(&mut self) {
        if self.automation.gesture.take().is_some() {
            self.drag = None;
            self.move_cache.get_mut().clear();
        }
    }

    pub(super) fn expire_automation_gesture(&mut self) {
        if self.automation.gesture.as_ref().is_some_and(|gesture| {
            gesture.expires <= Instant::now()
                || self.active.as_ref() != Some(&gesture.document)
                || self.page != gesture.page
        }) {
            self.cancel_automation_gesture();
            self.redraw();
        }
    }

    pub(super) fn resume_automation(&mut self) {
        if let Some((job, reply)) = self.automation.queued.take() {
            self.handle_automation(job, reply);
        }
    }

    pub(super) fn finish_automation(&mut self, error: Option<String>) {
        if let Some(reply) = self.automation.waiting.take() {
            let _ = reply.try_send(error.map_or_else(|| Ok(self.automation_result()), Err));
        }
    }

    pub(super) fn handle_automation(&mut self, job: Job, reply: Reply) {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default();
        if now.as_millis() >= u128::from(job.expires) || self.closing {
            let _ = reply.try_send(Err(
                "The desktop request expired before it could run.".into()
            ));
            return;
        }
        if job.method == "inspect_ui" {
            let _ = reply.try_send(Ok(self.inspect_automation()));
            return;
        }
        if self.automation.waiting.is_some() || self.pending || self.drag_button.is_some() {
            let _ = reply.try_send(Err(
                "Wait for the current edit or pointer gesture to finish.".into(),
            ));
            return;
        }
        if let Some(target) = job.arguments["document"].as_str() {
            let parsed = Uuid::parse_str(target)
                .ok()
                .map(|id| format!("doc_{}", id.simple()));
            if self
                .active
                .as_deref()
                .is_none_or(|active| active != target && parsed.as_deref() != Some(active))
            {
                let _ = reply.try_send(Err(
                    "The requested document is not the active desktop tab.".into(),
                ));
                return;
            }
        }
        if job.method == "screenshot" {
            let _ = reply.try_send(self.automation_screenshot(&job.arguments));
            return;
        }
        if self.document().is_none() {
            let _ = reply.try_send(Err(
                "Open a document in the desktop before sending canvas input.".into(),
            ));
            return;
        }
        self.expire_automation_gesture();
        if job.method == "pointer" && self.scene_pending {
            self.automation.queued = Some((job, reply));
            return;
        }
        if job.method == "pointer" && self.scene.is_none() {
            let _ = reply.try_send(Err("The active canvas did not render.".into()));
            return;
        }
        let old_modifiers = self.modifiers;
        self.modifiers = modifiers(&job.arguments);
        self.error = None;
        let result = match job.method.as_str() {
            "pointer" => self.automation_pointer(&job.session, &job.arguments),
            "key" if self.automation.gesture.is_none() => self.automation_key(&job.arguments),
            "type_text" if self.automation.gesture.is_none() => {
                self.automation_text(&job.arguments)
            }
            "key" | "type_text" => Err("Finish the active pointer gesture first.".into()),
            _ => Err("Unknown desktop automation method.".into()),
        };
        self.modifiers = old_modifiers;
        self.redraw();
        match result {
            Err(error) => {
                let _ = reply.try_send(Err(error));
            }
            Ok(()) if self.pending => self.automation.waiting = Some(reply),
            Ok(()) => {
                let result = self
                    .error
                    .clone()
                    .map_or_else(|| Ok(self.automation_result()), Err);
                let _ = reply.try_send(result);
            }
        }
    }

    fn automation_result(&self) -> Value {
        let root = self.current_root();
        json!({
            "documentId": self.active,
            "pageId": self.page,
            "selection": self.selected.iter().filter(|id| root.as_ref() != Some(*id)).collect::<Vec<_>>(),
            "tool": tool_name(self.tool),
        })
    }

    fn inspect_automation(&self) -> Value {
        let canvas = self.canvas_rect();
        let center = self.camera.world(canvas.width * 0.5, canvas.height * 0.5);
        let title = self
            .document()
            .map_or("Oh My Canvas", |doc| doc.title.as_str());
        let mut result = self.automation_result();
        result["attached"] = true.into();
        result["view"] = json!({"zoom":self.camera.zoom, "center":[center.0,center.1]});
        result["status"] = json!(self.status);
        result["tool"] = json!({"id":tool_name(self.tool),"overlay":{}});
        result["canvas"] = json!([canvas.x, canvas.y, canvas.width, canvas.height]);
        result["panels"] = json!({
            "left": LEFT, "right": if self.inspector_visible() { RIGHT } else { 0. },
            "leftCollapsed": false, "leftTab": if self.library_open { "assets" } else { "file" },
            "rightTab":format!("{:?}",self.inspector).to_lowercase()
        });
        result["frameMs"] = json!(self.automation.last_frame);
        result["framesDrawn"] = json!(self.automation.frames_drawn);
        result["window"] = json!(1);
        result["windows"] = json!([{
            "id":1,"title":title,"main":true,"focused":self.window.as_ref().is_some_and(|window| window.has_focus()),"active":self.active,
            "activeIndex":self.tabs.iter().position(|tab| self.active.as_ref() == Some(tab)),
            "files": self.tabs.iter().filter_map(|id| self.snapshots.get(id).map(|doc| {
                json!({"id":id,"title":doc.title,"active":self.active.as_ref()==Some(id)})
            })).collect::<Vec<_>>()
        }]);
        result
    }

    fn automation_screenshot(&self, args: &Value) -> Result<Value, String> {
        if args["window"] != true && args["window"].as_u64() != Some(1) {
            return Err("No native window with that ID.".into());
        }
        if self.occluded
            || self
                .window
                .as_ref()
                .and_then(|window| window.is_minimized())
                == Some(true)
        {
            return Err("Show the native window before capturing it.".into());
        }
        let (width, height, png) = crate::paint::screenshot_png(self)?;
        let data = png.as_bytes();
        if data.len() > 6 * 1024 * 1024 {
            return Err("Window PNG exceeds the MCP response size limit.".into());
        }
        Ok(json!({
            "format":"png", "mimeType":"image/png", "width":width, "height":height,
            "base64":base64::engine::general_purpose::STANDARD.encode(data)
        }))
    }

    fn automation_pointer(&mut self, session: &str, args: &Value) -> Result<(), String> {
        let kind = args["kind"].as_str().unwrap_or("click");
        if self.prototype_frame.is_some() {
            return Err("Close prototype preview before sending canvas gestures.".into());
        }
        let point = coordinate_pair(&args["x"], &args["y"])?;
        for name in ["pressure", "pressureTo"] {
            if let Some(pressure) = args.get(name)
                && pressure
                    .as_f64()
                    .is_none_or(|value| !(0. ..=1.).contains(&value))
            {
                return Err("Pen pressure must be between 0 and 1.".into());
            }
        }
        let drag = if kind == "drag" {
            let end = args["to"]
                .as_array()
                .filter(|end| end.len() == 2)
                .ok_or("A drag requires a destination [x, y].")?;
            let end = coordinate_pair(&end[0], &end[1])?;
            let steps = args
                .get("steps")
                .map_or(Some(8), Value::as_u64)
                .filter(|steps| *steps <= 256)
                .ok_or("Drag steps must be an integer from 0 to 256.")?;
            Some((end, steps))
        } else {
            None
        };
        if !matches!(
            kind,
            "click" | "double" | "drag" | "down" | "move" | "up" | "hover"
        ) {
            return Err("Unknown pointer gesture.".into());
        }
        if let Some(gesture) = &self.automation.gesture {
            if gesture.owner != session || !matches!(kind, "move" | "up") {
                return Err("Finish the active pointer gesture before starting another.".into());
            }
        } else if kind == "up" {
            return Err("Start a pointer gesture before releasing it.".into());
        }
        if let Some(tool) = args.get("tool") {
            let tool = match tool.as_str() {
                Some("move") => Tool::Select,
                Some("hand") => Tool::Pan,
                Some("frame") => Tool::Frame,
                Some("rectangle") => Tool::Rect,
                Some("ellipse") => Tool::Ellipse,
                Some("text") => Tool::Text,
                _ => return Err("This pointer tool is unavailable in the native desktop.".into()),
            };
            if self.automation.gesture.is_some() {
                return Err("A pointer gesture cannot change tools midway.".into());
            }
            if tool != self.tool {
                if self.editing.is_some() {
                    return Err("Finish editing text before switching pointer tools.".into());
                }
                self.action(Action::Tool(tool));
            }
        }
        let canvas = self.canvas_rect();
        let camera = self
            .automation
            .gesture
            .as_ref()
            .map_or(self.camera, |gesture| gesture.camera);
        let screen = |(x, y)| {
            (
                canvas.x + camera.x + x * camera.zoom,
                canvas.y + camera.y + y * camera.zoom,
            )
        };
        let start = screen(point);
        if matches!(kind, "move" | "hover" | "up") {
            self.pointer_move(start.0, start.1);
            if kind == "up" {
                self.automation.gesture = None;
                self.pointer_up();
            } else if let Some(gesture) = self.automation.gesture.as_mut() {
                gesture.expires = Instant::now() + Duration::from_secs(15);
            }
            return Ok(());
        }
        self.cursor = start;
        self.last_click = (kind == "double").then(|| (Instant::now(), start));
        self.pointer_down(MouseButton::Left, true);
        self.last_click = None;
        if kind == "down" {
            self.automation.gesture = Some(Gesture {
                owner: session.into(),
                document: self.active.clone().unwrap(),
                page: self.page.clone(),
                expires: Instant::now() + Duration::from_secs(15),
                camera,
            });
            return Ok(());
        }
        if let Some((end, steps)) = drag {
            let end = screen(end);
            for step in 1..=steps + 1 {
                let ratio = step as f64 / (steps + 1) as f64;
                self.pointer_move(
                    start.0 + (end.0 - start.0) * ratio,
                    start.1 + (end.1 - start.1) * ratio,
                );
            }
        }
        self.pointer_up();
        Ok(())
    }

    fn automation_key(&mut self, args: &Value) -> Result<(), String> {
        let raw = args["key"].as_str().ok_or("A key is required.")?;
        let command = self.modifiers.control_key() || self.modifiers.super_key();
        let key: Key = match raw.to_ascii_lowercase().as_str() {
            "escape" | "esc" => Key::Named(NamedKey::Escape),
            "delete" => Key::Named(NamedKey::Delete),
            "backspace" => Key::Named(NamedKey::Backspace),
            "enter" | "return" => Key::Named(NamedKey::Enter),
            "arrowleft" | "left" => Key::Named(NamedKey::ArrowLeft),
            "arrowright" | "right" => Key::Named(NamedKey::ArrowRight),
            "arrowup" | "up" => Key::Named(NamedKey::ArrowUp),
            "arrowdown" | "down" => Key::Named(NamedKey::ArrowDown),
            "home" => Key::Named(NamedKey::Home),
            "end" => Key::Named(NamedKey::End),
            "tab" => Key::Named(NamedKey::Tab),
            "space" | " " => Key::Named(NamedKey::Space),
            value if command && matches!(value, "g" | "a" | "z" | "y" | "0") => {
                Key::Character(value.into())
            }
            value
                if !command
                    && (self.editing.is_some() && raw.chars().count() == 1
                        || matches!(
                            value,
                            "v" | "f" | "r" | "o" | "t" | "h" | "+" | "=" | "-" | "plus" | "minus"
                        )
                        || value.len() == 1 && value.as_bytes()[0].is_ascii_digit()) =>
            {
                Key::Character(raw.into())
            }
            _ => return Err("This keyboard shortcut is unavailable in the native desktop.".into()),
        };
        if self.editing.is_none() {
            match &key {
                Key::Named(NamedKey::Tab) if !command => {
                    self.automation_select_sibling();
                    return Ok(());
                }
                Key::Named(NamedKey::Enter) => {
                    self.automation_select_hierarchy();
                    return Ok(());
                }
                Key::Character(value) if command && value == "g" => {
                    self.action(if self.modifiers.shift_key() {
                        Action::Ungroup
                    } else {
                        Action::Group(false)
                    });
                    return Ok(());
                }
                Key::Character(value) if !command => match value.to_ascii_lowercase().as_str() {
                    "+" | "=" | "plus" | "-" | "minus" => {
                        let canvas = self.canvas_rect();
                        let factor = if matches!(value.to_ascii_lowercase().as_str(), "-" | "minus")
                        {
                            0.8
                        } else {
                            1.25
                        };
                        self.pan_view = false;
                        self.camera
                            .zoom_at(factor, canvas.width / 2., canvas.height / 2.);
                        self.remember_camera();
                        return Ok(());
                    }
                    digit if digit.len() == 1 && digit.as_bytes()[0].is_ascii_digit() => {
                        let digit = digit.as_bytes()[0] - b'0';
                        let opacity = if digit == 0 {
                            1.
                        } else {
                            f64::from(digit) / 10.
                        };
                        let commands: Vec<_> = self.selected.iter().filter(|id| self.layer_transformable(id)).map(|id| {
                                json!({"type":"node.set","nodeId":id,"properties":{"opacity":opacity}})
                            }).collect();
                        if !commands.is_empty() {
                            self.mutate(json!({"type":"batch","commands":commands}), "opacity");
                        }
                        return Ok(());
                    }
                    _ => {}
                },
                _ => {}
            }
        }
        if self.editing.is_none()
            && matches!(
                key,
                Key::Named(NamedKey::Home | NamedKey::End | NamedKey::Space)
            )
        {
            return Err("This keyboard shortcut is unavailable on the native canvas.".into());
        }
        self.key_input(
            &key,
            (raw.chars().count() == 1 || key == Key::Named(NamedKey::Space)).then_some(
                if key == Key::Named(NamedKey::Space) {
                    " "
                } else {
                    raw
                },
            ),
            true,
        );
        Ok(())
    }

    fn automation_select_sibling(&mut self) {
        let Some(scene) = &self.scene else {
            return;
        };
        let selected = self.selected.iter().find_map(|id| scene.item(id));
        let parent = selected.and_then(|item| item.parent).unwrap_or(scene.root);
        let siblings: Vec<_> = scene.items[parent]
            .children
            .iter()
            .map(|index| &scene.items[*index])
            .filter(|item| self.layer_transformable(&item.id))
            .collect();
        if siblings.is_empty() {
            return;
        }
        let previous = self.modifiers.shift_key();
        let index = selected
            .and_then(|item| siblings.iter().position(|sibling| sibling.id == item.id))
            .map_or_else(
                || if previous { siblings.len() - 1 } else { 0 },
                |index| (index + if previous { siblings.len() - 1 } else { 1 }) % siblings.len(),
            );
        self.selected = BTreeSet::from([siblings[index].id.clone()]);
    }

    fn automation_select_hierarchy(&mut self) {
        let Some(document) = self.document() else {
            return;
        };
        let Some(root) = self.current_root() else {
            return;
        };
        let upward = self.modifiers.shift_key();
        let mut next = BTreeSet::new();
        for id in &self.selected {
            if upward {
                if let Some(parent) = document
                    .nodes
                    .get(id)
                    .and_then(|node| node.parent_id.as_ref())
                    && parent != &root
                {
                    next.insert(parent.clone());
                }
            } else {
                next.extend(
                    document
                        .nodes
                        .values()
                        .filter(|node| node.parent_id.as_ref() == Some(id))
                        .map(|node| node.id.clone()),
                );
            }
        }
        if !next.is_empty() {
            self.selected = next;
        }
    }

    fn automation_text(&mut self, args: &Value) -> Result<(), String> {
        let text = args["text"].as_str().ok_or("Text is required.")?;
        let edit = self
            .editing
            .as_mut()
            .filter(|edit| matches!(edit.target, EditTarget::Text { .. }))
            .ok_or("Start editing a canvas text layer first.")?;
        if edit.buffer.composing {
            return Err("Finish the current input composition first.".into());
        }
        edit.buffer.insert(text);
        Ok(())
    }
}

fn tool_name(tool: Tool) -> &'static str {
    match tool {
        Tool::Select => "move",
        Tool::Pan => "hand",
        Tool::Frame => "frame",
        Tool::Rect => "rectangle",
        Tool::Ellipse => "ellipse",
        Tool::Text => "text",
    }
}

fn modifiers(args: &Value) -> ModifiersState {
    let mut result = ModifiersState::empty();
    result.set(ModifiersState::SHIFT, args["shift"] == true);
    result.set(ModifiersState::ALT, args["alt"] == true);
    result.set(
        ModifiersState::SUPER,
        cfg!(target_os = "macos") && args["cmd"] == true,
    );
    result.set(
        ModifiersState::CONTROL,
        args["ctrl"] == true || !cfg!(target_os = "macos") && args["cmd"] == true,
    );
    result
}

fn coordinate_pair(x: &Value, y: &Value) -> Result<(f64, f64), String> {
    let coordinate = |value: &Value| value.as_f64().filter(|coordinate| coordinate.abs() <= 1e7);
    coordinate(x)
        .zip(coordinate(y))
        .ok_or_else(|| "Canvas coordinates must be finite numbers within ±10,000,000.".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canvas_coordinates_reject_malformed_and_excessive_input() {
        assert_eq!(
            coordinate_pair(&json!(-100), &json!(200)).unwrap(),
            (-100., 200.)
        );
        assert!(coordinate_pair(&json!(10_000_001), &json!(200)).is_err());
        assert!(coordinate_pair(&json!("1"), &json!(200)).is_err());
    }
}
