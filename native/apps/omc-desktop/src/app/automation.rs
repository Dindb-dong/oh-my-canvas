use super::*;
mod commands;
mod libraries;
mod plugin_manager;
pub(super) mod workspace;
use base64::Engine;
use serde::Deserialize;
use std::time::{SystemTime, UNIX_EPOCH};

pub(super) fn desktop_preferences(profile: &std::path::Path) -> State {
    let mut state = State::default();
    state.view.prefs = commands::EditorPreferences::read(profile);
    state
}

pub(crate) type Reply = SyncSender<Result<Value, String>>;

#[derive(Deserialize)]
pub(crate) struct Job {
    pub(super) session: String,
    pub(super) method: String,
    pub(super) arguments: Value,
    pub(super) expires: u64,
}

#[derive(Default)]
pub(super) struct State {
    library_description: String,
    library_page: usize,
    plugin_manager: plugin_manager::Panel,
    dev_focus_reply: Option<(Value, Reply)>,
    pub(super) gesture: Option<Gesture>,
    pub(super) waiting: Option<Reply>,
    queued: Option<(Job, Reply)>,
    pub(super) last_frame: Option<f64>,
    pub(super) frames_drawn: u64,
    pub(super) view: commands::EditorView,
    pub(super) default_shape: Option<omc_model::Properties>,
    pub(super) default_text: Option<omc_model::Properties>,
    pub(super) pick_only: bool,
    pub(super) picked_color: Option<String>,
    workspace_tab: Option<(String, bool, Reply)>,
    pub(super) text_preview: Option<Preview>,
    pub(super) preview_generation: u64,
    preview_reply: Option<(u64, Reply)>,
}

pub(super) struct Preview {
    owner: String,
    pub(super) snapshot: Arc<DocumentSnapshot>,
    pub(super) version: bool,
}

pub(super) struct Gesture {
    owner: String,
    document: String,
    page: Option<String>,
    expires: Instant,
    camera: Camera,
}

impl App {
    pub(super) fn finish_dev_focus_reply(&mut self, error: Option<String>) {
        if let Some((value, reply)) = self.automation.dev_focus_reply.take() {
            let _ = reply.try_send(error.map_or(Ok(value), Err));
        }
    }

    pub(super) fn cancel_automation_gesture(&mut self) {
        if self.automation.gesture.take().is_some() {
            self.drag = None;
            self.move_cache.get_mut().clear();
            self.cancel_prototype_pointer();
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

    pub fn version_preview_active(&self) -> bool {
        self.automation
            .text_preview
            .as_ref()
            .is_some_and(|preview| preview.version)
    }

    pub(super) fn clear_text_preview(&mut self) {
        if self.automation.text_preview.take().is_some() {
            self.automation.preview_generation = self.automation.preview_generation.wrapping_add(1);
            if let Some((_, reply)) = self.automation.preview_reply.take() {
                let _ = reply.try_send(Err("The live text preview was interrupted.".into()));
            }
            self.schedule_scene();
        }
    }

    pub(super) fn finish_text_preview(&mut self, generation: u64, error: Option<String>) {
        if self
            .automation
            .preview_reply
            .as_ref()
            .is_some_and(|(pending, _)| *pending == generation)
        {
            let (_, reply) = self.automation.preview_reply.take().unwrap();
            let _ = reply.try_send(error.map_or_else(
                || Ok(json!({"shown": self.automation.text_preview.is_some()})),
                Err,
            ));
        }
    }

    fn handle_text_preview(&mut self, session: String, apply: bool, args: &Value, reply: Reply) {
        let version = args["kind"] == "version";
        if !apply
            && !self
                .automation
                .text_preview
                .as_ref()
                .is_some_and(|preview| {
                    preview.owner == session
                        && preview.version == version
                        && self.active.as_ref() == Some(&preview.snapshot.id)
                        && args["document"].as_str().is_none_or(|target| {
                            target_document_matches(target, &preview.snapshot.id)
                        })
                })
        {
            let _ = reply.try_send(Ok(json!({"shown":false})));
            return;
        }
        let preview = if apply {
            if self.editing.is_some()
                || self.prototype_frame.is_some()
                || (!version && self.version_preview_active())
            {
                let _ = reply.try_send(Err(
                    "Finish editing or exit the current preview first.".into()
                ));
                return;
            }
            let snapshot = serde_json::from_value::<DocumentSnapshot>(args["preview"].clone());
            let Some(snapshot) = snapshot.ok().filter(|preview| {
                self.document().is_some_and(|document| {
                    preview.id == document.id
                        && preview.epoch == document.epoch
                        && preview.sequence == document.sequence
                })
            }) else {
                let _ = reply.try_send(Err(
                    "The source document changed before the preview arrived.".into(),
                ));
                return;
            };
            Some(Preview {
                owner: session,
                snapshot: Arc::new(snapshot),
                version,
            })
        } else {
            None
        };
        if let Some((_, previous)) = self.automation.preview_reply.take() {
            let _ = previous.try_send(Err("Another request replaced the live preview.".into()));
        }
        self.automation.text_preview = preview;
        self.automation.preview_generation = self.automation.preview_generation.wrapping_add(1);
        self.automation.preview_reply = Some((self.automation.preview_generation, reply));
        self.schedule_scene();
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
        if job.method == "inspect_ui"
            || job.method == "workspace" && job.arguments["action"] == "state"
        {
            let _ = reply.try_send(Ok(self.inspect_automation()));
            return;
        }
        if job.method == "plugins.manage" {
            let result = self.show_plugin_manager(&job.arguments);
            let _ = reply.try_send(result);
            return;
        }
        if job.method == "text.preview.clear" {
            self.handle_text_preview(job.session, false, &job.arguments, reply);
            return;
        }
        if self.automation.waiting.is_some()
            || self.automation.dev_focus_reply.is_some()
            || self.pending
            || self.drag_button.is_some()
        {
            let _ = reply.try_send(Err(
                "Wait for the current edit or pointer gesture to finish.".into(),
            ));
            return;
        }
        if job.method == "legacy.view" {
            if self.scene_pending && matches!(job.arguments["action"].as_str(), Some("fit" | "select")) {
                self.automation.queued = Some((job, reply));
            } else if self.automation.gesture.is_some() {
                let _ = reply.try_send(Err("Finish the active pointer gesture before changing the view.".into()));
            } else {
                let _ = reply.try_send(self.legacy_view(&job.arguments));
                self.redraw();
            }
            return;
        }
        if let Some(target) = job.arguments["document"].as_str() {
            if self
                .active
                .as_deref()
                .is_none_or(|active| !target_document_matches(target, active))
            {
                let _ = reply.try_send(Err(
                    "The requested document is not the active desktop tab.".into(),
                ));
                return;
            }
        }
        if job.method == "text.preview.apply" {
            let preview = &job.arguments["preview"];
            if let Some(document) = self.document()
                && preview["id"] == document.id
                && preview["epoch"] == document.epoch
                && preview["sequence"]
                    .as_u64()
                    .is_some_and(|sequence| sequence > document.sequence)
            {
                let id = document.id.clone();
                self.automation.queued = Some((job, reply));
                if !self.poll_pending {
                    self.poll_pending = true;
                    self.send(Request::Snapshot { id });
                }
                return;
            }
            self.handle_text_preview(job.session, true, &job.arguments, reply);
            return;
        }
        if matches!(
            job.method.as_str(),
            "collab.cursorChat.open" | "collab.presence"
        ) {
            self.collaboration_document = self.active.clone();
            self.collaboration = job.arguments["state"].clone();
            let result = if job.method == "collab.presence" {
                self.follow_collaboration_view();
                Ok(json!({"ok":true}))
            } else {
                self.open_cursor_chat()
                    .then(|| json!({"open":true}))
                    .ok_or_else(|| "Cursor chat requires an idle live room.".into())
            };
            let _ = reply.try_send(result);
            return;
        }
        if matches!(job.method.as_str(), "dev.focus" | "proto.preview" | "proto.present")
            && let Some(document) = self.document()
            && job.arguments["minSequence"]
                .as_u64()
                .is_some_and(|sequence| sequence > document.sequence)
        {
            let id = document.id.clone();
            self.automation.queued = Some((job, reply));
            if !self.poll_pending {
                self.poll_pending = true;
                self.send(Request::Snapshot { id });
            }
            return;
        }
        if job.method == "open.url" {
            let result = if self.background {
                Err("Background automation cannot open external applications.".into())
            } else {
                workspace::open_url(&job.arguments)
            };
            let _ = reply.try_send(result);
            return;
        }
        if job.method == "screenshot" {
            let _ = reply.try_send(self.automation_screenshot(&job.arguments));
            return;
        }
        if job.method == "workspace" {
            self.handle_workspace_automation(&job.arguments, reply);
            self.redraw();
            return;
        }
        if self.document().is_none()
            && !matches!(
                job.method.as_str(),
                "window.focus" | "view.fullscreen" | "dev.unfocus"
            )
            && !job.method.starts_with("pref.")
            && !job.method.starts_with("app.")
            && !job.method.starts_with("help.")
            && !job.method.starts_with("view.theme")
            && job.method != "doc.home"
        {
            let _ = reply.try_send(Err(
                "Open a document in the desktop before sending canvas input.".into(),
            ));
            return;
        }
        self.expire_automation_gesture();
        if self.scene_pending
            && matches!(
                job.method.as_str(),
                "pointer"
                    | "proto.preview"
                    | "proto.present"
                    | "text.edit.begin"
                    | "view.zoomFit"
                    | "view.zoomSelection"
                    | "view.nextFrame"
                    | "view.prevFrame"
                    | "dev.focus"
            )
        {
            self.automation.queued = Some((job, reply));
            return;
        }
        if job.method == "edit.setDefaultProperties" {
            let result = self.set_drawing_defaults(&job.arguments);
            let _ = reply.try_send(result);
            return;
        }
        if job.method == "pointer" && self.scene.is_none() {
            let _ = reply.try_send(Err("The active canvas did not render.".into()));
            return;
        }
        if self.version_preview_active()
            && matches!(
                job.method.as_str(),
                "pointer"
                    | "key"
                    | "type_text"
                    | "text.edit.begin"
                    | "tool.place"
                    | "edit.setDefaultProperties"
                    | "edit.pickColor"
                    | "view.contextMenu"
            )
        {
            if job.method == "key"
                && job.arguments["key"]
                    .as_str()
                    .is_some_and(|key| key.eq_ignore_ascii_case("escape"))
            {
                self.handle_text_preview(job.session, false, &json!({"kind":"version"}), reply);
            } else {
                let _ = reply.try_send(Err("Exit version preview before editing.".into()));
            }
            return;
        }
        if self.automation.text_preview.is_some()
            && matches!(
                job.method.as_str(),
                "pointer" | "key" | "type_text" | "text.edit.begin"
            )
        {
            self.clear_text_preview();
            if self.scene_pending && matches!(job.method.as_str(), "pointer" | "text.edit.begin") {
                self.automation.queued = Some((job, reply));
                return;
            }
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
            name if self.automation.gesture.is_none() => {
                match self.automation_command(name, &job.arguments) {
                    Ok(Some(value)) => {
                        self.modifiers = old_modifiers;
                        self.redraw();
                        if matches!(name, "dev.focus" | "dev.unfocus")
                            && self.scene_pending
                            && self.scene.is_none()
                        {
                            self.automation.dev_focus_reply = Some((value, reply));
                            return;
                        }
                        let _ = reply.try_send(Ok(value));
                        return;
                    }
                    Ok(None) => Ok(()),
                    Err(error) => Err(error),
                }
            }
            _ => Err("Finish the active pointer gesture first.".into()),
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

    fn set_drawing_defaults(&mut self, args: &Value) -> Result<Value, String> {
        let id = args["layer"]
            .as_str()
            .or_else(|| self.selected.iter().next().map(String::as_str))
            .or_else(|| args["fallbackLayer"].as_str())
            .ok_or("Select a layer to set its drawing defaults.")?;
        let node = self
            .document()
            .and_then(|document| document.nodes.get(id))
            .filter(|node| node.parent_id.is_some())
            .ok_or("The selected layer no longer exists.")?;
        let item = self
            .scene
            .as_ref()
            .and_then(|scene| scene.item(id))
            .ok_or("The selected layer is outside the current canvas.")?;
        let properties = omc_style::drawing_defaults(node, &item.properties, &item.style);
        let is_text = node.kind == omc_model::NodeKind::Text;
        if is_text {
            self.automation.default_text = Some(properties.clone());
        } else {
            self.automation.default_shape = Some(properties.clone());
        }
        Ok(json!({"for":if is_text {"text"}else{"shapes"},"properties":properties}))
    }

    fn automation_result(&self) -> Value {
        let root = self.current_root();
        let mut result = json!({
            "documentId": self.active,
            "pageId": self.page,
            "selection": self.selected.iter().filter(|id| root.as_ref() != Some(*id)).collect::<Vec<_>>(),
            "tool": if self.comments.tool { "comment" } else { tool_name(self.tool) },
        });
        if let Some(color) = self.picked_color() {
            result["pickedColor"] = json!(color);
        }
        result
    }

    pub(super) fn inspect_automation(&self) -> Value {
        let canvas = self.canvas_rect();

        let title = self
            .document()
            .map_or("Oh My Canvas", |doc| doc.title.as_str());
        let mut result = self.automation_result();
        result["attached"] = true.into();
        result["view"] = self.automation_view_state();
        result["status"] = json!(self.status);
        result["tool"] = json!({"id":if self.comments.tool { "comment" } else { tool_name(self.tool) },"overlay":{}});
        result["canvas"] = json!([canvas.x, canvas.y, canvas.width, canvas.height]);
        result["panels"] = json!({
            "left": self.left_width(), "right": self.right_width(),
            "leftCollapsed": self.left_width() == 0., "leftTab": if self.library_open { "assets" } else { "file" },
            "rightTab":format!("{:?}",self.inspector).to_lowercase()
        });
        result["frameMs"] = json!(self.automation.last_frame);
        result["framesDrawn"] = json!(self.automation.frames_drawn);
        result["window"] = json!(self.proxy.id);
        result["focus"] = self.automation_focus_state();
        result["uiScale"] = self.automation_ui_scale_state();
        result["darkTheme"] = self.dark_theme().into();
        result["proofSrgb"] = json!({"on":self.proof_enabled(),"ready":self.proof_scene.is_some()});
        result["language"] = json!(self.interface_language);
        result["windowMotionReduced"] = json!(self.window_animation_reduced());
        result["home"] = self.library_open.into();
        result["textPreview"] = json!(
            self.automation
                .text_preview
                .as_ref()
                .is_some_and(|preview| !preview.version)
        );
        result["versionPreview"] = self.version_preview_active().into();
        result["dialog"] = json!(self.popup.and_then(|popup| match popup {
            Popup::Utility(panel) => Some(format!("{panel:?}")),
            _ => None,
        }));
        result["libraryDialog"] = self.library_dialog_state();
        result["pluginManager"] = self.plugin_manager_state();
        result["layersCollapsed"] = json!(self.collapsed.len());
        result["devComparison"] = json!(self.dev_comparison().map(|panel| {
            let area = self.dev_compare_rect();
            json!({"id":panel.result["id"],"rows":panel.rows.len(),"scroll":panel.scroll,
                "rect":[area.x, area.y, area.width, area.height],
                "images":panel.images.each_ref().map(Option::is_some)})
        }));
        result["comments"] = json!({"visible":self.comments.visible,"pins":self.comment_pins().len(),
            "draft":self.editing.as_ref().is_some_and(|edit| matches!(edit.target, EditTarget::CanvasComment { .. })),
            "open":self.comments.selected.is_some()});
        result["devFocus"] = self.dev_focus_active().into();
        let prototype = json!(
            self.prototype_frame
                .as_ref()
                .map(|id| json!({"current":id,"overlay":self.prototype_playback.overlay.as_ref().map(|overlay| &overlay.id),"transition":self.prototype_playback.motion.as_ref().map(|motion| &motion.kind),"transitionProgress":self.prototype_playback.motion.as_ref().map(|motion| motion.progress()),"matchedLayers":self.prototype_playback.motion.as_ref().map(|motion| motion.matched())}))
        );
        if self.automation.view.presenting {
            result["presenter"] = prototype;
            result["preview"] = Value::Null;
        } else {
            result["presenter"] = Value::Null;
            result["preview"] = prototype;
        }
        result["windows"] = json!([{
            "id":self.proxy.id,"title":title,"main":self.proxy.id == 1,"focused":self.window.as_ref().is_some_and(|window| window.has_focus()),"active":self.active,
            "activeIndex":self.tabs.iter().position(|tab| self.active.as_ref() == Some(tab)),
            "files": self.tabs.iter().filter_map(|id| self.snapshots.get(id).map(|doc| {
                json!({"id":id,"title":doc.title,"active":self.active.as_ref()==Some(id)})
            })).collect::<Vec<_>>()
        }]);
        result
    }

    fn automation_screenshot(&self, args: &Value) -> Result<Value, String> {
        if args["window"] != true && args["window"].as_u64() != Some(self.proxy.id) {
            return Err("No native window with that ID.".into());
        }
        if !self.background
            && (self.occluded
                || self
                    .window
                    .as_ref()
                    .and_then(|window| window.is_minimized())
                    == Some(true))
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
        if self.prototype_frame.is_some() && args.get("tool").is_some() {
            return Err("A prototype pointer cannot switch editor tools.".into());
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
            let tool = canvas_tool(tool.as_str().unwrap_or_default())?;
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
            "f6" => Key::Named(NamedKey::F6),
            "space" | " " => Key::Named(NamedKey::Space),
            _ if self.prototype_frame.is_some() && raw.chars().count() == 1 => {
                Key::Character(raw.into())
            }
            value if command && matches!(value, "g" | "a" | "z" | "y" | "0") => {
                Key::Character(value.into())
            }
            value
                if !command
                    && (self.editing.is_some() && raw.chars().count() == 1
                        || matches!(
                            value,
                            "v" | "f"
                                | "c"
                                | "r"
                                | "o"
                                | "t"
                                | "h"
                                | "i"
                                | "l"
                                | "s"
                                | "k"
                                | "b"
                                | "+"
                                | "="
                                | "-"
                                | "plus"
                                | "minus"
                        )
                        || value.len() == 1 && value.as_bytes()[0].is_ascii_digit()) =>
            {
                Key::Character(raw.into())
            }
            _ => return Err("This keyboard shortcut is unavailable in the native desktop.".into()),
        };
        if self.prototype_frame.is_some() {
            self.key_input(&key, None, true);
            return Ok(());
        }
        if self.popup == Some(Popup::Utility(UtilityPopup::PickedColor)) {
            self.key_input(&key, None, true);
            return Ok(());
        }
        if self.library_dialog_key(&key) || self.plugin_manager_key(&key) {
            return Ok(());
        }
        if self.editing.is_none() {
            match &key {
                Key::Named(NamedKey::Tab) if !command => {
                    self.automation_select_sibling();
                    return Ok(());
                }
                Key::Named(NamedKey::Enter)
                    if self.tool != Tool::Pen || self.pen_vertices.is_empty() =>
                {
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
                        if self.automation.view.prefs.number_keys_opacity
                            && !self.selected.is_empty()
                        {
                            self.apply_opacity_digit(digit.as_bytes()[0]);
                        } else if digit == "1" {
                            self.camera = Camera::default();
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
            .filter(|edit| {
                edit.target.is_canvas_text()
                    || matches!(edit.target, EditTarget::CanvasComment { .. })
            })
            .ok_or("Start editing a canvas text layer or comment first.")?;
        if edit.buffer.composing {
            return Err("Finish the current input composition first.".into());
        }
        edit.buffer.insert(text);
        self.refresh_path_text_scene();
        Ok(())
    }
}

fn canvas_tool(name: &str) -> Result<Tool, String> {
    match name {
        "move" => Ok(Tool::Select),
        "scale" => Ok(Tool::Scale),
        "hand" => Ok(Tool::Pan),
        "frame" => Ok(Tool::Frame),
        "section" => Ok(Tool::Section),
        "slice" => Ok(Tool::Slice),
        "shape" => Ok(Tool::BoardShape),
        "rectangle" => Ok(Tool::Rect),
        "ellipse" => Ok(Tool::Ellipse),
        "pen" => Ok(Tool::Pen),
        "pencil" => Ok(Tool::Pencil),
        "marker" => Ok(Tool::Marker),
        "highlighter" => Ok(Tool::Highlighter),
        "eraser" => Ok(Tool::Eraser),
        "connector" => Ok(Tool::Connector),
        "stamp" => Ok(Tool::Stamp),
        "sticky" => Ok(Tool::Sticky),
        "shapeBuilder" => Ok(Tool::ShapeBuilder),
        "line" => Ok(Tool::Line),
        "arrow" => Ok(Tool::Arrow),
        "polygon" => Ok(Tool::Polygon),
        "star" => Ok(Tool::Star),
        "text" => Ok(Tool::Text),
        "textOnPath" => Ok(Tool::TextOnPath),
        "eyedropper" => Ok(Tool::Eyedropper),
        _ => Err(format!(
            "The {name} tool is unavailable in the native desktop."
        )),
    }
}

fn tool_name(tool: Tool) -> &'static str {
    match tool {
        Tool::Select => "move",
        Tool::Scale => "scale",
        Tool::Pan => "hand",
        Tool::Frame => "frame",
        Tool::Section => "section",
        Tool::Slice => "slice",
        Tool::BoardShape => "shape",
        Tool::Rect => "rectangle",
        Tool::Ellipse => "ellipse",
        Tool::Pen => "pen",
        Tool::Pencil => "pencil",
        Tool::Marker => "marker",
        Tool::Highlighter => "highlighter",
        Tool::Eraser => "eraser",
        Tool::Connector => "connector",
        Tool::Stamp => "stamp",
        Tool::Sticky => "sticky",
        Tool::ShapeBuilder => "shapeBuilder",
        Tool::Line => "line",
        Tool::Arrow => "arrow",
        Tool::Polygon => "polygon",
        Tool::Star => "star",
        Tool::Text => "text",
        Tool::TextOnPath => "textOnPath",
        Tool::Eyedropper => "eyedropper",
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

fn target_document_matches(target: &str, native: &str) -> bool {
    target == native
        || Uuid::parse_str(target).is_ok_and(|id| format!("doc_{}", id.simple()) == native)
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
