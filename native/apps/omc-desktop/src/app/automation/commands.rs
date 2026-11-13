use super::*;
mod legacy_view;
use serde::Serialize;
use std::io::Write;
use unicode_segmentation::UnicodeSegmentation;
use winit::window::{Fullscreen, Theme};

pub(in crate::app) struct EditorView {
    pub left: f64,
    pub right: f64,
    pub hide_left: bool,
    pub hide_ui: bool,
    pub legacy_multi_select: bool,
    pub compact: bool,
    pub grids: bool,
    pub pixel_grid: bool,
    pub rulers: bool,
    pub show_peers: bool,
    pub frame_outlines: bool,
    pub outlines: bool,
    pub outlines_selection: bool,
    pub outlines_hidden: bool,
    pub outlines_bounds: bool,
    pub mask_outlines: bool,
    pub pixel_preview: Option<u8>,
    pub proof_documents: BTreeSet<String>,
    pixel_density: u8,
    pub prefs: EditorPreferences,
    pub presenting: bool,
    frame: Option<String>,
    placement: Option<(f64, f64)>,
    resize_center: Option<(Instant, (f64, f64))>,
    effective_ui_scale: f64,
}
impl Default for EditorView {
    fn default() -> Self {
        Self {
            left: LEFT,
            right: RIGHT,
            hide_left: false,
            hide_ui: false,
            legacy_multi_select: false,
            compact: false,
            grids: true,
            pixel_grid: false,
            rulers: false,
            show_peers: true,
            frame_outlines: false,
            outlines: false,
            outlines_selection: false,
            outlines_hidden: false,
            outlines_bounds: false,
            mask_outlines: false,
            pixel_preview: None,
            proof_documents: BTreeSet::new(),
            pixel_density: 1,
            prefs: EditorPreferences::default(),
            presenting: false,
            frame: None,
            placement: None,
            resize_center: None,
            effective_ui_scale: 1.,
        }
    }
}

#[derive(Clone, Copy, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
enum ThemeChoice {
    #[default]
    Light,
    Dark,
    System,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub(in crate::app) struct EditorPreferences {
    pub keep_tool: bool,
    pub highlight_hover: bool,
    pub show_dimensions: bool,
    pub number_keys_opacity: bool,
    pub wheel_zoom: bool,
    pub nudge_small: f64,
    pub nudge_big: f64,
    pub start_home: bool,
    pub reduce_motion: bool,
    pub snap_pixel: bool,
    pub snap_objects: bool,
    pub snap_geometry: bool,
    pub show_slices: bool,
    pub ui_scale: f64,
    theme: ThemeChoice,
}

impl Default for EditorPreferences {
    fn default() -> Self {
        Self {
            keep_tool: false,
            highlight_hover: false,
            show_dimensions: true,
            number_keys_opacity: true,
            wheel_zoom: false,
            nudge_small: 1.,
            nudge_big: 10.,
            start_home: false,
            reduce_motion: false,
            snap_pixel: false,
            snap_objects: false,
            snap_geometry: true,
            show_slices: true,
            ui_scale: 1.,
            theme: ThemeChoice::Light,
        }
    }
}

impl EditorPreferences {
    pub(in crate::app) fn read(profile: &std::path::Path) -> Self {
        let mut prefs: Self = std::fs::read(profile.join("native-v1/desktop-preferences.json"))
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default();
        prefs.ui_scale = prefs.ui_scale.clamp(0.75, 3.);
        prefs
    }

    fn write(&self, profile: &std::path::Path) -> Result<(), String> {
        let directory = profile.join("native-v1");
        let mut file =
            tempfile::NamedTempFile::new_in(&directory).map_err(|error| error.to_string())?;
        serde_json::to_writer(file.as_file_mut(), self).map_err(|error| error.to_string())?;
        file.flush().map_err(|error| error.to_string())?;
        file.persist(directory.join("desktop-preferences.json"))
            .map_err(|error| error.error.to_string())?;
        Ok(())
    }
}

impl App {
    pub fn theme_preference(&self) -> Option<Theme> {
        match self.automation.view.prefs.theme {
            ThemeChoice::Light => Some(Theme::Light),
            ThemeChoice::Dark => Some(Theme::Dark),
            ThemeChoice::System => None,
        }
    }
    pub fn dark_theme(&self) -> bool {
        self.theme_preference()
            .or_else(|| self.window.as_ref().and_then(|window| window.theme()))
            == Some(Theme::Dark)
    }
    pub(in crate::app) fn invalidate_chrome_theme(&mut self) {
        self.scene_cache.get_mut().clear();
        self.pan_cache.get_mut().clear();
        self.move_cache.get_mut().clear();
    }

    pub fn ui_scale(&self) -> f64 {
        self.automation.view.effective_ui_scale
    }

    pub(in crate::app) fn update_window_metrics(
        &mut self,
        window: &Window,
        size: winit::dpi::PhysicalSize<u32>,
    ) {
        let scale = window.scale_factor();
        let logical = (size.width as f64 / scale, size.height as f64 / scale);
        let available = (logical.0 / 760.).min(logical.1 / 520.).max(0.75);
        let interface = self.automation.view.prefs.ui_scale.min(available);
        self.automation.view.effective_ui_scale = interface;
        self.width = logical.0 / interface;
        self.height = logical.1 / interface;
    }

    pub(super) fn automation_ui_scale_state(&self) -> Value {
        let relative = self.automation.view.prefs.ui_scale;
        json!({"choice":relative,"zoom":self.ui_scale(),"drawn":self.window.as_ref().map_or(1., |window| window.scale_factor())*self.ui_scale(),
            "limited":self.ui_scale()<relative})
    }

    pub fn left_width(&self) -> f64 {
        let view = &self.automation.view;
        if !self.library_open && (self.ui_hidden() || view.compact || view.hide_left) {
            0.
        } else {
            view.left
        }
    }
    pub fn right_width(&self) -> f64 {
        if self.inspector_visible() {
            self.automation.view.right
        } else {
            0.
        }
    }
    pub fn header_height(&self) -> f64 {
        let view = &self.automation.view;
        if !self.library_open && (self.ui_hidden() || view.compact) {
            0.
        } else {
            HEADER
        }
    }
    pub fn ui_hidden(&self) -> bool {
        let view = &self.automation.view;
        (view.hide_ui || view.presenting && self.prototype_playback.options["hideUi"] != false)
            && !self.library_open
    }
    pub fn show_layout_grids(&self) -> bool {
        self.automation.view.grids
    }
    pub fn show_pixel_grid(&self) -> bool {
        self.automation.view.pixel_grid
    }
    pub fn show_rulers(&self) -> bool {
        self.automation.view.rulers
    }
    pub fn canvas_outlines(&self) -> bool {
        self.automation.view.outlines
    }
    pub fn selection_outlines(&self) -> bool {
        self.automation.view.outlines_selection
    }
    pub fn hidden_outlines(&self) -> bool {
        self.automation.view.outlines_hidden
    }
    pub fn object_bounds_outlines(&self) -> bool {
        self.automation.view.outlines_bounds
    }
    pub fn mask_outlines(&self) -> bool {
        self.automation.view.mask_outlines
    }
    pub(in crate::app) fn reduce_motion(&self) -> bool {
        self.automation.view.prefs.reduce_motion
    }
    pub(in crate::app) fn apply_window_motion(&self, window: &Window) {
        #[cfg(target_os = "macos")]
        let _ = window_motion(window, Some(self.reduce_motion()));
        #[cfg(not(target_os = "macos"))]
        let _ = (window, self.reduce_motion());
    }
    pub(super) fn window_animation_reduced(&self) -> Option<bool> {
        #[cfg(target_os = "macos")]
        return self
            .window
            .as_ref()
            .and_then(|window| window_motion(window, None));
        #[cfg(not(target_os = "macos"))]
        None
    }
    pub fn pixel_preview_density(&self) -> Option<u8> {
        self.automation.view.pixel_preview
    }

    pub fn show_frame_outlines(&self) -> bool {
        self.automation.view.frame_outlines
    }
    pub fn show_slices(&self) -> bool {
        self.automation.view.prefs.show_slices
    }
    pub fn show_dimensions(&self) -> bool {
        self.automation.view.prefs.show_dimensions
    }
    pub fn hovered_canvas_item_at(&self, point: (f64, f64)) -> Option<&omc_scene::SceneItem> {
        if !self.automation.view.prefs.highlight_hover
            || self.tool != Tool::Select
            || self.drag.is_some()
            || self.prototype_frame.is_some()
            || !self.canvas_rect().contains(point.0, point.1)
        {
            return None;
        }
        let scene = self.scene.as_ref()?;
        let (x, y) = self.world(point.0, point.1);
        self.hit_canvas_item((x, y)).filter(|item| {
            item.id != scene.items[scene.root].id && !self.selected.contains(&item.id)
        })
    }
    pub fn show_peer_cursors(&self) -> bool {
        self.automation.view.show_peers
    }
    pub fn placement_crosshair(&self) -> Option<(f64, f64)> {
        self.automation.view.placement
    }

    pub(in crate::app) fn finish_automation_resize(&mut self) {
        if let Some((at, center)) = self.automation.view.resize_center.take()
            && at.elapsed() < Duration::from_secs(2)
        {
            self.center_camera(center);
            self.remember_camera();
        }
    }

    fn control_region(&self, control: &Control) -> usize {
        let canvas = self.canvas_rect();
        let rect = control.rect;
        let point = (rect.x + rect.width * 0.5, rect.y + rect.height * 0.5);
        if crate::paint::palette_rect(self).is_some_and(|dock| dock.contains(point.0, point.1))
            || rect.y < canvas.y
        {
            0
        } else if point.0 < canvas.x {
            1
        } else if point.0 >= canvas.x + canvas.width {
            3
        } else {
            2
        }
    }

    pub(super) fn automation_focus_state(&self) -> Value {
        let control = self
            .controls
            .iter()
            .find(|control| control.id == self.focus);
        let region = control.map_or(2, |control| self.control_region(control));
        let region = ["toolbar", "layers", "canvas", "properties"][region];
        json!({"region":region,
            "keyboard":self.keyboard_focus_visible,"control":control.map_or("",|control| control.label.as_str())})
    }

    pub(in crate::app) fn step_focus_region(&mut self, previous: bool) {
        let mut controls = [None, None, Some(0), None];
        for control in &self.controls {
            if self.action_available(&control.action) {
                let region = self.control_region(control);
                if controls[region].is_none() {
                    controls[region] = Some(control.id);
                }
            }
        }
        let current = self
            .controls
            .iter()
            .find(|control| control.id == self.focus)
            .map_or(2, |control| self.control_region(control));
        let step = if previous { controls.len() - 1 } else { 1 };
        let mut next = (current + step) % controls.len();
        while controls[next].is_none() {
            next = (next + step) % controls.len();
        }
        self.focus = controls[next].unwrap_or(0);
        self.keyboard_focus_visible = true;
    }

    pub(super) fn automation_view_state(&self) -> Value {
        let canvas = self.canvas_rect();
        let (cx, cy) = self.camera.world(canvas.width * 0.5, canvas.height * 0.5);
        json!({"zoom":self.camera.zoom,"cx":cx,"cy":cy,"center":[cx,cy],"vw":canvas.width,"vh":canvas.height})
    }

    pub(super) fn automation_command(
        &mut self,
        name: &str,
        args: &Value,
    ) -> Result<Option<Value>, String> {
        let (namespace, action) = name.split_once('.').unwrap_or_default();
        match namespace {
            "comment" if action == "reveal" => self.reveal_comment(args).map(Some),
            "view" if action == "comments" => Ok(Some(self.toggle_comments(args["on"].as_bool()))),
            "tool" if action == "comment" => self.enable_comment_tool().map(Some),
            "edit" if action == "pickColor" => {
                self.begin_color_pick(args)?;
                Ok(None)
            }
            "libraries" if action == "open" => {
                self.open_library_dialog(UtilityPopup::Libraries).map(Some)
            }
            "libraries" if action == "publish" => self
                .open_library_dialog(UtilityPopup::PublishLibrary)
                .map(Some),
            "dev" if action == "compare.show" => self.open_dev_comparison(args).map(Some),
            "dev" if action == "focus" => self.automation_dev_focus(args).map(Some),
            "dev" if action == "unfocus" => {
                self.exit_dev_focus(true);
                if self.active.is_none() {
                    return Ok(Some(json!({"focused":false})));
                }
                Ok(Some(
                    json!({"focused":false,"documentId":self.active,"pageId":self.page,
                    "selection":self.selected,"devFocusExit":true}),
                ))
            }
            "doc" if action == "home" => {
                if self.editing.is_some() {
                    return Err("Finish editing before opening the library.".into());
                }
                self.action(Action::Library);
                Ok(Some(json!({"home":self.library_open})))
            }
            "layers" if action == "collapseAll" => {
                self.collapsed.extend(
                    self.layers
                        .iter()
                        .filter(|row| row.has_children)
                        .map(|row| row.id.clone()),
                );
                self.layer_scroll = 0;
                self.refresh_visible_layers();
                Ok(Some(json!({"collapsed":self.collapsed.len()})))
            }
            "help" if action == "page" => {
                let url = "https://github.com/Dindb-dong/oh-my-canvas#readme";
                if !self.background {
                    super::workspace::open_url(&json!({"url":url}))?;
                }
                Ok(Some(json!({"url":url})))
            }
            "app" | "help" => {
                let panel = match action {
                    "preferences" => UtilityPopup::Preferences,
                    "actions" => UtilityPopup::Actions,
                    "shortcuts" => UtilityPopup::Shortcuts,
                    "about" => UtilityPopup::About,
                    "gettingStarted" => {
                        let show = bool_arg(args, "show", true)?;
                        if show {
                            if self.editing.is_some() {
                                return Err("Finish editing before opening the library.".into());
                            }
                            self.action(Action::Library);
                        } else {
                            if self.popup == Some(Popup::Utility(UtilityPopup::GettingStarted)) {
                                self.popup = None;
                            }
                            return Ok(Some(json!({"shown":false})));
                        }
                        UtilityPopup::GettingStarted
                    }
                    _ => return Err("Unknown native app panel.".into()),
                };
                self.action(Action::Utility(panel));
                Ok(Some(if panel == UtilityPopup::GettingStarted {
                    json!({"shown":true})
                } else {
                    json!({"open":true,"panel":format!("{panel:?}")})
                }))
            }
            "view" => self.automation_view_command(action, args),
            "pref" => self.automation_preference(action, args),
            "tool" => self.automation_tool_command(action, args),
            "text" => self.automation_text_command(action, args),
            "proto" => self.automation_proto(action, args),
            "window" if action == "focus" => {
                if args["id"].as_u64() != Some(self.proxy.id) {
                    return Err("No native window with that ID.".into());
                }
                if self.background {
                    return Err("Background automation cannot focus the window.".into());
                }
                let window = self.window.as_ref().ok_or("No native window.")?;
                window.set_visible(true);
                window.focus_window();
                Ok(Some(
                    json!({"window":self.proxy.id,"focused":window.has_focus()}),
                ))
            }
            _ => Err("Unknown desktop automation command.".into()),
        }
    }

    fn automation_preference(
        &mut self,
        action: &str,
        args: &Value,
    ) -> Result<Option<Value>, String> {
        let mut prefs = self.automation.view.prefs.clone();
        if matches!(
            action,
            "uiScale" | "uiScaleUp" | "uiScaleDown" | "uiScaleReset"
        ) {
            if action == "uiScale" && args.get("scale").is_none() {
                return Ok(Some(json!({"scale":prefs.ui_scale})));
            }
            let steps = [0.75, 0.875, 1., 1.125, 1.25, 1.5, 1.75, 2., 2.5, 3.];
            prefs.ui_scale = match action {
                "uiScale" if args["scale"] == "auto" => 1.,
                "uiScale" => number_arg(args, "scale", prefs.ui_scale)?.clamp(0.75, 3.),
                "uiScaleUp" => steps
                    .into_iter()
                    .find(|step| *step > prefs.ui_scale)
                    .unwrap_or(3.),
                "uiScaleDown" => steps
                    .into_iter()
                    .rev()
                    .find(|step| *step < prefs.ui_scale)
                    .unwrap_or(0.75),
                _ => 1.,
            };
            prefs.write(&self.profile)?;
            let viewport = self.canvas_rect();
            let center = self.camera.world(viewport.width / 2., viewport.height / 2.);
            self.automation.view.prefs = prefs;
            if let Some(window) = self.window.as_ref().cloned() {
                self.update_window_metrics(&window, window.inner_size());
                self.cursor = (-1., -1.);
                if let Some(id) = self.prototype_frame.clone() {
                    self.show_prototype_frame(id);
                } else {
                    self.center_camera(center);
                }
                self.schedule_scene();
            }
            return Ok(Some(json!({"scale":self.automation.view.prefs.ui_scale})));
        }
        let result = if action == "nudge" {
            let small = number_arg(args, "small", prefs.nudge_small)?;
            let big = number_arg(args, "big", prefs.nudge_big)?;
            if !(0.01..=10000.).contains(&small) || !(0.01..=10000.).contains(&big) {
                return Err("Nudge sizes must be between 0.01 and 10,000.".into());
            }
            prefs.nudge_small = small;
            prefs.nudge_big = big;
            json!({"small":small,"big":big})
        } else {
            let flag = match action {
                "keepTool" => &mut prefs.keep_tool,
                "highlightHover" => &mut prefs.highlight_hover,
                "showDimensions" => &mut prefs.show_dimensions,
                "numberKeysOpacity" => &mut prefs.number_keys_opacity,
                "scrollWheelZoom" => &mut prefs.wheel_zoom,
                "startOnHome" => &mut prefs.start_home,
                "reduceMotion" => &mut prefs.reduce_motion,
                "snapPixel" => &mut prefs.snap_pixel,
                "snapObjects" => &mut prefs.snap_objects,
                "snapGeometry" => &mut prefs.snap_geometry,
                "slices" => &mut prefs.show_slices,
                _ => return Err("Unknown native editor preference.".into()),
            };
            *flag = bool_arg(args, "on", !*flag)?;
            json!({"on":*flag})
        };
        prefs.write(&self.profile)?;
        self.automation.view.prefs = prefs;
        if action == "reduceMotion"
            && let Some(window) = &self.window
        {
            self.apply_window_motion(window);
        }
        Ok(Some(result))
    }

    fn automation_proto(&mut self, action: &str, args: &Value) -> Result<Option<Value>, String> {
        if action == "closePreview" {
            self.action(Action::PrototypeExit);
            return Ok(Some(json!({"ok":true})));
        }
        let scene = self
            .scene
            .as_ref()
            .ok_or("The active canvas did not render.")?;
        let top_frame = |id: &str| {
            let mut item = scene.item(id)?;
            while let Some(parent) = item.parent {
                if parent == scene.root {
                    return (!item.hidden && item.kind == NodeKind::Frame).then(|| item.id.clone());
                }
                item = &scene.items[parent];
            }
            None
        };
        let start = if let Some(id) = args["startLayer"].as_str() {
            top_frame(id).ok_or("Choose a visible prototype frame or a layer inside it.")?
        } else {
            self.selected
                .iter()
                .find_map(|id| top_frame(id))
                .or_else(|| {
                    let root = self.current_root()?;
                    let props = &self.document()?.nodes.get(&root)?.properties;
                    let flows = props.get("prototypeFlows")?.as_array()?;
                    flows
                        .iter()
                        .find_map(|flow| top_frame(flow["start"].as_str()?))
                })
                .or_else(|| {
                    scene
                        .items
                        .iter()
                        .find(|item| {
                            item.parent == Some(scene.root)
                                && !item.hidden
                                && item.kind == NodeKind::Frame
                        })
                        .map(|item| item.id.clone())
                })
                .ok_or("The active page has no visible frame to present.")?
        };
        if self.editing.is_some() {
            return Err("Finish editing text before opening the prototype.".into());
        }
        if self.prototype_frame.is_none() {
            self.editor_camera = Some(self.camera);
        }
        self.reset_prototype(args["presentationOptions"].clone());
        self.prototype_frame = None;
        self.automation.view.presenting = action == "present";
        if !self.show_prototype_frame(start.clone()) {
            self.action(Action::PrototypeExit);
            return Err("The native prototype did not open.".into());
        }
        let mut output = self.automation_result();
        output.as_object_mut().unwrap().remove("selection");
        output["prototypeStart"] = start.into();
        Ok(Some(output))
    }

    fn automation_view_command(
        &mut self,
        action: &str,
        args: &Value,
    ) -> Result<Option<Value>, String> {
        let canvas = self.canvas_rect();
        let (cx, cy) = self.camera.world(canvas.width * 0.5, canvas.height * 0.5);
        match action {
            "get" => return Ok(Some(self.automation_view_state())),
            "themeLight" | "themeDark" | "themeSystem" => {
                let mut prefs = self.automation.view.prefs.clone();
                let (theme, name) = match action {
                    "themeLight" => (ThemeChoice::Light, "light"),
                    "themeDark" => (ThemeChoice::Dark, "dark"),
                    _ => (ThemeChoice::System, "system"),
                };
                prefs.theme = theme;
                prefs.write(&self.profile)?;
                self.automation.view.prefs = prefs;
                if let Some(window) = &self.window {
                    window.set_theme(self.theme_preference());
                }
                self.invalidate_chrome_theme();
                return Ok(Some(json!({"theme":name,"dark":self.dark_theme()})));
            }
            "proofSrgb" => {
                let id = self.active.clone().ok_or("No native document is open.")?;
                let documents = &mut self.automation.view.proof_documents;
                let on = bool_arg(args, "on", !documents.contains(&id))?;
                let changed = if on {
                    documents.insert(id)
                } else {
                    documents.remove(&id)
                };
                if changed {
                    self.proof_scene = None;
                    self.schedule_scene();
                }
                return Ok(Some(json!({"on":on})));
            }
            "pixelPreview" => {
                let view = &mut self.automation.view;
                if let Some(density) = args.get("scale") {
                    view.pixel_density = density
                        .as_u64()
                        .filter(|scale| matches!(scale, 1 | 2))
                        .ok_or("Pixel preview scale must be 1 or 2.")?
                        as u8;
                }
                let on = bool_arg(
                    args,
                    "on",
                    args.get("scale").is_some() || view.pixel_preview.is_none(),
                )?;
                view.pixel_preview = on.then_some(view.pixel_density);
                return Ok(Some(json!({"on":on,"scale":view.pixel_density})));
            }
            "contextMenu" => {
                self.open_layer_context();
                if self.popup != Some(Popup::Utility(UtilityPopup::Context)) {
                    return Err("Select a layer before opening its context menu.".into());
                }
                return Ok(Some(json!({"open":true})));
            }
            "snapPixel" | "snapObjects" | "snapGeometry" | "slices" => {
                return self.automation_preference(action, args);
            }
            "nextRegion" | "previousRegion" => {
                self.step_focus_region(action == "previousRegion");
                return Ok(Some(self.automation_focus_state()));
            }
            "set" => {
                let zoom = number_arg(args, "zoom", self.camera.zoom)?.clamp(0.05, 16.);
                let center = (number_arg(args, "cx", cx)?, number_arg(args, "cy", cy)?);
                let width = number_arg(args, "vw", canvas.width)?;
                let height = number_arg(args, "vh", canvas.height)?;
                if width <= 0. || height <= 0. {
                    return Err("Viewport dimensions must be positive.".into());
                }
                self.camera.zoom = zoom;
                self.center_camera(center);
                if args.get("vw").is_some() || args.get("vh").is_some() {
                    let window = self.window.as_ref().ok_or("No native window.")?;
                    let window = window.clone();
                    let requested = LogicalSize::new(
                        ((width + self.left_width() + self.right_width()) * self.ui_scale())
                            .clamp(760., 3840.),
                        ((height + self.header_height()) * self.ui_scale()).clamp(520., 2160.),
                    );
                    if let Some(size) = window.request_inner_size(requested) {
                        self.update_window_metrics(&window, size);
                        self.center_camera(center);
                        self.schedule_scene();
                    } else {
                        self.automation.view.resize_center = Some((Instant::now(), center));
                    }
                }
            }
            "zoomIn" | "zoomOut" | "zoom100" | "zoom50" | "zoom200" => {
                let target = match action {
                    "zoomIn" => self.camera.zoom * 1.25,
                    "zoomOut" => self.camera.zoom * 0.8,
                    "zoom50" => 0.5,
                    "zoom200" => 2.,
                    _ => 1.,
                };
                self.camera.zoom_at(
                    target / self.camera.zoom,
                    canvas.width / 2.,
                    canvas.height / 2.,
                );
                self.pan_view = false;
            }
            "pan" => {
                let step = if bool_arg(args, "big", false)? {
                    200.
                } else {
                    20.
                };
                self.camera.x -= number_arg(args, "dx", 0.)? * step;
                self.camera.y -= number_arg(args, "dy", 0.)? * step;
                self.pan_view = true;
            }
            "zoomAt" => {
                let x = number_arg(args, "x", cx)?;
                let y = number_arg(args, "y", cy)?;
                if args.get("width").is_some() || args.get("height").is_some() {
                    let width = number_arg(args, "width", 0.)?;
                    let height = number_arg(args, "height", 0.)?;
                    if width <= 0. || height <= 0. {
                        return Err("Fit area needs positive width and height.".into());
                    }
                    self.camera
                        .fit([x, y, width, height], canvas.width, canvas.height);
                } else {
                    let factor = if bool_arg(args, "out", false)? {
                        0.8
                    } else {
                        1.25
                    };
                    self.camera.zoom_at(
                        factor,
                        self.camera.x + x * self.camera.zoom,
                        self.camera.y + y * self.camera.zoom,
                    );
                }
                self.pan_view = false;
            }
            "zoomFit" | "zoomSelection" | "prevFrame" | "nextFrame" => {
                self.fit_automation_view(action, canvas)
            }
            "prevPage" | "nextPage" => {
                if self.editing.is_some() {
                    return Err("Finish editing text before changing pages.".into());
                }
                let doc = self.document().ok_or("Open a document first.")?;
                let current = doc
                    .pages
                    .iter()
                    .position(|p| self.page.as_ref() == Some(&p.id))
                    .unwrap_or(0);
                let target = if action == "prevPage" {
                    current.saturating_sub(1)
                } else {
                    (current + 1).min(doc.pages.len() - 1)
                };
                if current != target {
                    self.action(Action::Page(doc.pages[target].id.clone()));
                }
                return Ok(None);
            }
            "fullscreen" => {
                let window = self.window.as_ref().ok_or("No native window.")?;
                let on = bool_arg(args, "on", window.fullscreen().is_none())?;
                if self.background && on {
                    return Err("Background automation cannot enter fullscreen.".into());
                }
                if !self.background {
                    window.set_fullscreen(on.then_some(Fullscreen::Borderless(None)));
                }
                return Ok(Some(json!({"on":on})));
            }
            "layers" => {
                self.automation.view.hide_left = false;
                if matches!(self.inspector, Inspector::Assets | Inspector::Tokens) {
                    self.action(Action::Inspector(Inspector::Design));
                }
                self.center_camera((cx, cy));
            }
            "assets" => self.action(Action::Inspector(Inspector::Assets)),
            "design" => self.action(Action::Inspector(Inspector::Design)),
            "prototype" => self.action(Action::Inspector(Inspector::Prototype)),
            "designPrototype" => {
                self.action(Action::Inspector(if self.inspector == Inspector::Design {
                    Inspector::Prototype
                } else {
                    Inspector::Design
                }))
            }
            "devMode" => self.action(Action::Inspector(if self.inspector == Inspector::Inspect {
                Inspector::Design
            } else {
                Inspector::Inspect
            })),
            "pixelGrid"
            | "layoutGrids"
            | "rulers"
            | "multiplayerCursors"
            | "frameOutlines"
            | "outlines"
            | "outlinesSelection"
            | "outlinesHiddenLayers"
            | "outlinesObjectBounds"
            | "maskOutlines" => {
                let view = &mut self.automation.view;
                let flag = match action {
                    "pixelGrid" => &mut view.pixel_grid,
                    "layoutGrids" => &mut view.grids,
                    "rulers" => &mut view.rulers,
                    "frameOutlines" => &mut view.frame_outlines,
                    "outlines" => &mut view.outlines,
                    "outlinesSelection" => &mut view.outlines_selection,
                    "outlinesHiddenLayers" => &mut view.outlines_hidden,
                    "outlinesObjectBounds" => &mut view.outlines_bounds,
                    "maskOutlines" => &mut view.mask_outlines,
                    _ => &mut view.show_peers,
                };
                *flag = bool_arg(args, "on", !*flag)?;
                return Ok(Some(json!({"on":*flag})));
            }
            "leftSidebar" | "toggleUi" | "minimize" => {
                let view = &mut self.automation.view;
                let on = match action {
                    "leftSidebar" => {
                        view.hide_left = !view.hide_left;
                        !view.hide_left
                    }
                    "toggleUi" => {
                        view.hide_ui = !bool_arg(args, "on", view.hide_ui)?;
                        !view.hide_ui
                    }
                    _ => {
                        view.compact = bool_arg(args, "on", !view.compact)?;
                        view.compact
                    }
                };
                self.popup = None;
                self.center_camera((cx, cy));
                return Ok(Some(json!({"on":on})));
            }
            "panelWidths" => {
                let reset = args.get("left").is_none() && args.get("right").is_none();
                let left = number_arg(
                    args,
                    "left",
                    if reset {
                        LEFT
                    } else {
                        self.automation.view.left
                    },
                )?
                .clamp(LEFT, 450.);
                let right = number_arg(
                    args,
                    "right",
                    if reset {
                        RIGHT
                    } else {
                        self.automation.view.right
                    },
                )?
                .clamp(RIGHT, 450.);
                self.automation.view.left = left;
                self.automation.view.right = right;
                self.center_camera((cx, cy));
                return Ok(Some(json!({"left":left,"right":right})));
            }
            _ => return Err("Unknown native canvas view command.".into()),
        }
        self.remember_camera();
        Ok(Some(self.automation_view_state()))
    }

    fn center_camera(&mut self, center: (f64, f64)) {
        let rect = self.canvas_rect();
        self.camera.x = rect.width / 2. - center.0 * self.camera.zoom;
        self.camera.y = rect.height / 2. - center.1 * self.camera.zoom;
        self.pan_view = false;
    }

    fn fit_automation_view(&mut self, action: &str, viewport: Rect) {
        let Some(scene) = &self.scene else {
            return;
        };
        let mut items: Vec<_> = scene
            .items
            .iter()
            .enumerate()
            .filter(|(index, item)| {
                *index != scene.root
                    && !item.hidden
                    && match action {
                        "zoomFit" => true,
                        "zoomSelection" => self.selected.contains(&item.id),
                        _ => item.parent == Some(scene.root) && item.kind == NodeKind::Frame,
                    }
            })
            .map(|(_, item)| item)
            .collect();
        if matches!(action, "prevFrame" | "nextFrame") && !items.is_empty() {
            let previous = action == "prevFrame";
            let count = items.len();
            let current = self
                .automation
                .view
                .frame
                .as_ref()
                .and_then(|id| items.iter().position(|item| &item.id == id));
            let index = current.map_or(if previous { count - 1 } else { 0 }, |current| {
                (current + if previous { count - 1 } else { 1 }) % count
            });
            self.automation.view.frame = Some(items[index].id.clone());
            items = vec![items[index]];
        }
        if let Some(bounds) = items.into_iter().map(|item| item.bounds).reduce(|a, b| {
            let x = a[0].min(b[0]);
            let y = a[1].min(b[1]);
            [
                x,
                y,
                (a[0] + a[2]).max(b[0] + b[2]) - x,
                (a[1] + a[3]).max(b[1] + b[3]) - y,
            ]
        }) {
            self.camera.fit(bounds, viewport.width, viewport.height);
            self.pan_view = false;
        }
    }

    fn automation_tool_command(
        &mut self,
        action: &str,
        args: &Value,
    ) -> Result<Option<Value>, String> {
        if self.editing.is_some() {
            return Err("Finish text editing before changing tools.".into());
        }
        let view = self.automation_view_state();
        let center = (
            view["cx"].as_f64().unwrap_or_default(),
            view["cy"].as_f64().unwrap_or_default(),
        );
        match action {
            "pencilBrush" => {
                if args.get("preset").is_some() {
                    self.vector_ink.pencil_brush = omc_model::parse_stroke_brush(args)?;
                }
                Ok(Some(json!({"brush":self.vector_ink.pencil_brush})))
            }
            "connector" | "stamp" | "sticky" => {
                let result = self.configure_board_tool(action, args)?;
                self.automation.view.placement = None;
                Ok(Some(result))
            }
            "marker" | "highlighter" => {
                let tool = canvas_tool(action)?;
                if let Some(color) = args.get("color") {
                    let color = omc_style::board_ink_color(color)?;
                    if tool == Tool::Marker {
                        self.vector_ink.marker = color;
                    } else {
                        self.vector_ink.highlighter = color;
                    }
                }
                self.action(Action::Tool(tool));
                self.automation.view.placement = None;
                Ok(Some(
                    json!({"tool":tool_name(self.tool),"color":self.vector_ink.color(tool)}),
                ))
            }
            "scaleAnchor" => {
                if let Some(value) = args.get("anchor") {
                    self.scale_anchor = value
                        .as_str()
                        .and_then(crate::app::scale_tool::parse_anchor)
                        .ok_or("Scale anchor must be tl, t, tr, l, c, r, bl, b or br.")?;
                }
                Ok(Some(
                    json!({"anchor":crate::app::scale_tool::anchor_name(self.scale_anchor)}),
                ))
            }
            "crosshair" => {
                if !matches!(
                    self.tool,
                    Tool::Frame
                        | Tool::Section
                        | Tool::Slice
                        | Tool::Rect
                        | Tool::Ellipse
                        | Tool::Line
                        | Tool::Arrow
                        | Tool::Polygon
                        | Tool::Star
                        | Tool::Text
                ) {
                    return Err("Choose a native shape or frame tool first.".into());
                }
                let step = if bool_arg(args, "big", false)? {
                    10.
                } else {
                    1.
                };
                let current = self.automation.view.placement.unwrap_or(center);
                let placement = (
                    current.0 + number_arg(args, "dx", 0.)? * step,
                    current.1 + number_arg(args, "dy", 0.)? * step,
                );
                self.automation.view.placement = Some(placement);
                Ok(Some(json!({"x":placement.0,"y":placement.1})))
            }
            "place" => {
                let tool = args["tool"]
                    .as_str()
                    .map(canvas_tool)
                    .transpose()?
                    .unwrap_or(self.tool);
                let (w, h) = match tool {
                    Tool::Frame | Tool::Section => (320., 240.),
                    Tool::Rect | Tool::Ellipse | Tool::Polygon | Tool::Star | Tool::Slice => {
                        (100., 100.)
                    }
                    Tool::Line | Tool::Arrow => (100., 0.),
                    Tool::Text => (200., 48.),
                    _ => return Err("Choose a native shape or frame tool first.".into()),
                };
                let center = self.automation.view.placement.unwrap_or(center);
                let x = number_arg(args, "x", center.0)?;
                let y = number_arg(args, "y", center.1)?;
                self.create_node(
                    tool,
                    (x - w / 2., y - h / 2.),
                    (x + w / 2., y + h / 2.),
                    None,
                );
                self.automation.view.placement = None;
                Ok(None)
            }
            _ => {
                let tool = canvas_tool(if action == "set" {
                    args["tool"].as_str().ok_or("A tool is required.")?
                } else {
                    action
                })?;
                if tool == Tool::BoardShape {
                    if !self.document().is_some_and(|doc| {
                        doc.metadata.get("boardDocument") == Some(&Value::Bool(true))
                    }) {
                        return Err("Open a board before choosing the Shapes tool.".into());
                    }
                    if let Some(shape) = args.get("shape") {
                        let shape = shape
                            .as_str()
                            .filter(|shape| {
                                matches!(
                                    *shape,
                                    "rectangle"
                                        | "roundedRectangle"
                                        | "ellipse"
                                        | "diamond"
                                        | "triangle"
                                        | "triangleDown"
                                        | "parallelogramRight"
                                        | "parallelogramLeft"
                                        | "trapezoid"
                                        | "pentagon"
                                        | "hexagon"
                                        | "octagon"
                                        | "star"
                                        | "plus"
                                        | "arrowRight"
                                        | "arrowLeft"
                                        | "chevron"
                                        | "speechBubble"
                                        | "database"
                                        | "document"
                                        | "predefinedProcess"
                                        | "manualInput"
                                        | "internalStorage"
                                )
                            })
                            .ok_or("Unknown board shape.")?;
                        self.board_shape = shape.into();
                    }
                }
                self.action(Action::Tool(tool));
                self.automation.view.placement = None;
                Ok(Some(json!({"tool":tool_name(self.tool)})))
            }
        }
    }

    fn automation_text_command(
        &mut self,
        action: &str,
        args: &Value,
    ) -> Result<Option<Value>, String> {
        if action == "edit.begin" {
            if self.editing.is_some() {
                return Err("Finish editing the active layer first.".into());
            }
            let layer = args["layer"].as_str().ok_or("A text layer is required.")?;
            if !self.layer_transformable(layer) {
                return Err("Text layer is hidden, locked or outside the active page.".into());
            }
            let mut caret = None;
            if let Some(value) = args.get("caret") {
                let text = self
                    .document()
                    .and_then(|doc| doc.nodes.get(layer))
                    .and_then(|node| node.properties.get("text"))
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                caret = Some(scalar_offset(text, value)?);
            }
            self.begin_text(layer.into());
            let edit = self
                .editing
                .as_mut()
                .ok_or("The selected layer is not text.")?;
            if let Some(caret) = caret {
                edit.buffer.caret = caret;
                edit.buffer.anchor = caret;
            } else {
                edit.buffer.select_all();
            }
            self.selected = BTreeSet::from([layer.into()]);
            return Ok(None);
        }
        let buffer = &mut self
            .editing
            .as_mut()
            .filter(|edit| edit.target.is_canvas_text())
            .ok_or("Start editing a canvas text layer first.")?
            .buffer;
        match action {
            "edit.end" => {
                self.commit_edit();
                return Ok(None);
            }
            "edit.key" => {
                let key = args["key"].as_str().ok_or("A text key is required.")?;
                if key.eq_ignore_ascii_case("selectall") {
                    buffer.select_all();
                } else if key.eq_ignore_ascii_case("enter") {
                    buffer.insert("\n");
                } else if key.eq_ignore_ascii_case("tab") {
                    buffer.insert("\t");
                } else if matches!(
                    key.to_ascii_lowercase().as_str(),
                    "up" | "down" | "arrowup" | "arrowdown"
                ) {
                    move_text_line(
                        buffer,
                        key.to_ascii_lowercase().ends_with("up"),
                        bool_arg(args, "shift", false)?,
                    );
                } else {
                    self.automation_key(args)?;
                    return Ok(None);
                }
                self.refresh_path_text_scene();
                return Ok(None);
            }
            "edit.insert" => {
                let text = args["text"].as_str().ok_or("Text is required.")?;
                if buffer.composing {
                    buffer.commit_ime(text);
                } else {
                    buffer.insert(text);
                }
            }
            "edit.caret" => {
                buffer.caret = scalar_offset(&buffer.text, &args["index"])?;
                if !bool_arg(args, "extend", false)? {
                    buffer.anchor = buffer.caret;
                }
            }
            "edit.selectWord" | "edit.selectLine" => {
                let index = scalar_offset(&buffer.text, &args["index"])?;
                let span = if action == "edit.selectWord" {
                    buffer
                        .text
                        .split_word_bound_indices()
                        .find(|(start, word)| *start <= index && index < *start + word.len())
                        .map_or(index..index, |(start, word)| start..start + word.len())
                } else {
                    line_at(&buffer.text, index)
                };
                buffer.anchor = span.start;
                buffer.caret = span.end;
            }
            "edit.preedit" => {
                let text = args["text"].as_str().ok_or("Text is required.")?;
                let caret = args
                    .get("cursor")
                    .map(|value| scalar_offset(text, value))
                    .transpose()?;
                buffer.set_preedit(text.into(), caret.map(|index| (index, index)));
            }
            "edit.selection" => {}
            _ => return Err("Unknown text edit command.".into()),
        }
        let count = |byte| buffer.text[..byte].chars().count();
        let result = json!({"start":count(buffer.selection().start),"end":count(buffer.selection().end),
            "caret":count(buffer.caret),"anchor":count(buffer.anchor),"text":buffer.selected_text(),"composing":buffer.composing});
        if matches!(action, "edit.insert" | "edit.preedit") {
            self.refresh_path_text_scene();
        }
        Ok(Some(result))
    }
}

#[cfg(target_os = "macos")]
fn window_motion(window: &Window, change: Option<bool>) -> Option<bool> {
    use objc2_app_kit::{NSView, NSWindowAnimationBehavior};
    use winit::raw_window_handle::{HasWindowHandle, RawWindowHandle};

    let RawWindowHandle::AppKit(handle) = window.window_handle().ok()?.as_raw() else {
        return None;
    };
    // The main-thread Winit window owns this AppKit view for the duration of the call.
    let view: &NSView = unsafe { handle.ns_view.cast().as_ref() };
    let native = view.window()?;
    if let Some(reduced) = change {
        native.setAnimationBehavior(if reduced {
            NSWindowAnimationBehavior::None
        } else {
            NSWindowAnimationBehavior::Default
        });
    }
    Some(native.animationBehavior() == NSWindowAnimationBehavior::None)
}

fn number_arg(args: &Value, key: &str, default: f64) -> Result<f64, String> {
    match args.get(key) {
        Some(value) => value
            .as_f64()
            .filter(|v| v.is_finite() && v.abs() <= 10_000_000.)
            .ok_or_else(|| format!("{key} must be finite and within ±10,000,000.")),
        None => Ok(default),
    }
}

fn bool_arg(args: &Value, key: &str, default: bool) -> Result<bool, String> {
    match args.get(key) {
        Some(value) => value
            .as_bool()
            .ok_or_else(|| format!("{key} must be a boolean.")),
        None => Ok(default),
    }
}

fn scalar_offset(text: &str, value: &Value) -> Result<usize, String> {
    let index = value
        .as_u64()
        .and_then(|value| usize::try_from(value).ok())
        .ok_or("Index must be a nonnegative integer.")?;
    Ok(text
        .char_indices()
        .nth(index)
        .map_or(text.len(), |(offset, _)| offset))
}

fn line_at(text: &str, caret: usize) -> std::ops::Range<usize> {
    text[..caret].rfind('\n').map_or(0, |i| i + 1)
        ..text[caret..].find('\n').map_or(text.len(), |i| caret + i)
}

fn move_text_line(buffer: &mut EditBuffer, up: bool, extend: bool) {
    let current = line_at(&buffer.text, buffer.caret);
    let offset = buffer.text[current.start..buffer.caret].chars().count();
    let next = if up {
        current.start.checked_sub(1)
    } else {
        (current.end < buffer.text.len()).then_some(current.end + 1)
    };
    if let Some(next) = next {
        let target = line_at(&buffer.text, next);
        buffer.caret = buffer.text[target.clone()]
            .char_indices()
            .nth(offset)
            .map_or(target.end, |(index, _)| target.start + index);
        if !extend {
            buffer.anchor = buffer.caret;
        }
    }
}
