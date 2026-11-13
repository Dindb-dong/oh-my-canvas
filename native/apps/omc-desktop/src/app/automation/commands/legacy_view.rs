use super::*;

impl App {
    pub(in crate::app) fn legacy_view(&mut self, args: &Value) -> Result<Value, String> {
        let Some(document) = self.document() else {
            return Ok(json!({"attached":false}));
        };
        if document.id != args["documentId"]
            || document.epoch != args["epoch"]
            || self.page.as_deref() != args["pageId"].as_str()
        {
            return Ok(json!({"attached":false}));
        }
        let revision = document.sequence;
        let action = args["action"]
            .as_str()
            .ok_or("A legacy view action is required.")?;
        if action != "get"
            && (self.editing.is_some()
                || self.version_preview_active()
                || self.prototype_frame.is_some())
        {
            return Err(
                "Finish editing or close the current preview before changing the view.".into(),
            );
        }
        match action {
            "get" => {}
            "set" => self.set_legacy_view(args)?,
            "select" => {
                let ids = args["ids"].as_array().ok_or("Select requires layer IDs.")?;
                let root = self.current_root();
                let scene = self
                    .scene
                    .as_ref()
                    .ok_or("The active canvas did not render.")?;
                let selection = ids
                    .iter()
                    .map(|id| {
                        let id = id.as_str().ok_or("Invalid layer ID.")?;
                        scene
                            .item(id)
                            .filter(|_| root.as_deref() != Some(id))
                            .map(|_| id.to_owned())
                            .ok_or("The selected layer is outside the active page.")
                    })
                    .collect::<Result<BTreeSet<_>, _>>()?;
                self.selected = selection;
                self.inspector_scroll = 0.;
            }
            "tool" => {
                let name = args["tool"].as_str().ok_or("A legacy tool is required.")?;
                self.action(Action::Tool(canvas_tool(if name == "rect" {
                    "rectangle"
                } else {
                    name
                })?));
            }
            "fit" => self.fit_legacy_view(args)?,
            _ => return Err("Unknown legacy view action.".into()),
        }
        let canvas = self.canvas_rect();
        let (x, y) = self.camera.world(0., 0.);
        let zoom = self.camera.zoom;
        let view = &self.automation.view;
        let tool = match self.tool {
            Tool::Frame => "frame",
            Tool::Rect => "rect",
            Tool::Ellipse => "ellipse",
            Tool::Polygon => "polygon",
            Tool::Star => "star",
            Tool::Line => "line",
            Tool::Arrow => "arrow",
            Tool::Pencil => "pencil",
            Tool::Pen => "pen",
            Tool::Text | Tool::TextOnPath => "text",
            _ => "move",
        };
        Ok(json!({"attached":true,"revision":revision,"view":{
            "viewport":{"zoom":zoom,"vport":{"width":canvas.width,"height":canvas.height},
                "vbox":{"x":x,"y":y,"width":canvas.width/zoom,"height":canvas.height/zoom}},
            "selection":self.selected,"tool":tool,
            "flags":{"showOutlines":view.outlines,"uiHidden":self.ui_hidden(),
                "pixelSnap":view.prefs.snap_pixel,"showRulers":view.rulers,"showGrids":view.grids,
                "multiSelect":view.legacy_multi_select,"snapping":view.prefs.snap_objects},
        }}))
    }

    fn set_legacy_view(&mut self, args: &Value) -> Result<(), String> {
        let camera = if let Some(viewport) = args.get("viewport") {
            let zoom = viewport["zoom"]
                .as_f64()
                .ok_or("A viewport zoom is required.")?;
            let top_left = ["x", "y"].map(|axis| {
                viewport["vbox"][axis]
                    .as_f64()
                    .filter(|coordinate| coordinate.abs() <= 1_000_000_000.)
            });
            let [Some(x), Some(y)] = top_left else {
                return Err("Viewport coordinates must be within ±1,000,000,000.".into());
            };
            Some(Camera {
                x: -x * zoom,
                y: -y * zoom,
                zoom,
            })
        } else {
            None
        };
        let canvas = self.canvas_rect();
        let center = self.camera.world(canvas.width / 2., canvas.height / 2.);
        let view = &mut self.automation.view;
        if let Some(flags) = args["flags"].as_object() {
            for (key, target) in [
                ("showOutlines", &mut view.outlines),
                ("uiHidden", &mut view.hide_ui),
                ("pixelSnap", &mut view.prefs.snap_pixel),
                ("showRulers", &mut view.rulers),
                ("showGrids", &mut view.grids),
                ("multiSelect", &mut view.legacy_multi_select),
                ("snapping", &mut view.prefs.snap_objects),
            ] {
                if let Some(value) = flags.get(key).and_then(Value::as_bool) {
                    *target = value;
                }
            }
        }
        if let Some(camera) = camera {
            self.stop_following_collaboration_view();
            self.camera = camera;
            self.pan_view = false;
        } else if self.canvas_rect().width != canvas.width
            || self.canvas_rect().height != canvas.height
        {
            self.center_camera(center);
        }
        self.remember_camera();
        Ok(())
    }

    fn fit_legacy_view(&mut self, args: &Value) -> Result<(), String> {
        let scene = self
            .scene
            .as_ref()
            .ok_or("The active canvas did not render.")?;
        let bounds = if let Some(ids) = args["ids"].as_array().filter(|ids| !ids.is_empty()) {
            let mut bounds = Vec::with_capacity(ids.len());
            for id in ids {
                let id = id.as_str().ok_or("Invalid layer ID.")?;
                let item = scene
                    .item(id)
                    .ok_or("The selected layer is outside the active page.")?;
                bounds.push(item.bounds);
            }
            bounds
        } else {
            scene
                .items
                .iter()
                .filter(|item| item.parent == Some(scene.root) && !item.hidden)
                .map(|item| item.bounds)
                .collect()
        };
        if let Some(bounds) = bounds.into_iter().reduce(|a, b| {
            let x = a[0].min(b[0]);
            let y = a[1].min(b[1]);
            [
                x,
                y,
                (a[0] + a[2]).max(b[0] + b[2]) - x,
                (a[1] + a[3]).max(b[1] + b[3]) - y,
            ]
        }) {
            let canvas = self.canvas_rect();
            self.stop_following_collaboration_view();
            self.camera.fit(bounds, canvas.width, canvas.height);
            self.pan_view = false;
            self.remember_camera();
        }
        Ok(())
    }
}
