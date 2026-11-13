use crate::{ToolRouter, children, native_id, schema};
use omc_model::NodeKind;
use omc_protocol::{EngineError, Result};
use serde_json::{Value, json};

pub const FIGCRAFT_COMMANDS: &[(&str, &str, bool, &str)] = &[
    ("libraries.open", "Open Libraries", false, ""),
    (
        "libraries.publish",
        "Open library publication form",
        false,
        "",
    ),
    ("view.get", "Get canvas view", false, ""),
    (
        "view.set",
        "Set canvas view",
        false,
        "zoom?, cx?, cy?, vw?, vh?",
    ),
    ("view.pan", "Pan canvas", false, "dx, dy, big?"),
    ("view.zoomIn", "Zoom in", false, ""),
    ("view.zoomOut", "Zoom out", false, ""),
    ("view.zoom100", "Zoom to 100%", false, ""),
    ("view.zoom50", "Zoom to 50%", false, ""),
    ("view.zoom200", "Zoom to 200%", false, ""),
    ("view.zoomFit", "Fit page", false, ""),
    ("view.zoomSelection", "Fit selection", false, ""),
    (
        "view.zoomAt",
        "Zoom at point",
        false,
        "x, y, out?, width?, height?",
    ),
    ("view.prevFrame", "Fit previous frame", false, ""),
    ("view.nextFrame", "Fit next frame", false, ""),
    ("view.prevPage", "Previous page", false, ""),
    ("view.nextPage", "Next page", false, ""),
    ("view.fullscreen", "Control full screen", false, "on?"),
    ("view.layers", "Show layers", false, ""),
    ("view.assets", "Show assets", false, ""),
    ("view.design", "Show design inspector", false, ""),
    ("view.prototype", "Show prototype inspector", false, ""),
    (
        "view.designPrototype",
        "Switch design and prototype inspector",
        false,
        "",
    ),
    ("view.devMode", "Toggle developer inspector", false, ""),
    ("view.pixelGrid", "Toggle pixel grid", false, "on?"),
    ("view.layoutGrids", "Toggle layout grids", false, "on?"),
    ("view.rulers", "Toggle canvas rulers", false, "on?"),
    (
        "view.multiplayerCursors",
        "Toggle multiplayer cursors",
        false,
        "on?",
    ),
    ("view.leftSidebar", "Toggle left sidebar", false, ""),
    ("view.toggleUi", "Toggle editor controls", false, "on?"),
    ("view.minimize", "Toggle compact editor", false, "on?"),
    (
        "view.panelWidths",
        "Set panel widths",
        false,
        "left?, right?",
    ),
    ("view.nextRegion", "Focus next region", false, ""),
    ("view.previousRegion", "Focus previous region", false, ""),
    ("view.frameOutlines", "Toggle frame outlines", false, "on?"),
    (
        "view.proofSrgb",
        "Mark colors outside the sRGB gamut",
        false,
        "on?",
    ),
    ("view.slices", "Show slice regions", false, "on?"),
    ("pref.keepTool", "Keep tool after drawing", false, "on?"),
    (
        "pref.highlightHover",
        "Highlight hovered layers",
        false,
        "on?",
    ),
    (
        "pref.showDimensions",
        "Show selection dimensions",
        false,
        "on?",
    ),
    (
        "pref.numberKeysOpacity",
        "Use number keys for opacity",
        false,
        "on?",
    ),
    (
        "pref.scrollWheelZoom",
        "Zoom with mouse wheel",
        false,
        "on?",
    ),
    ("pref.nudge", "Set nudge amounts", false, "small?, big?"),
    (
        "view.snapPixel",
        "Snap pointer edits to pixels",
        false,
        "on?",
    ),
    ("pref.startOnHome", "Start on the home screen", false, "on?"),
    (
        "view.snapObjects",
        "Snap moving and resized layers to objects",
        false,
        "on?",
    ),
    (
        "view.snapGeometry",
        "Snap pen points to vector geometry",
        false,
        "on?",
    ),
    ("pref.reduceMotion", "Reduce editor motion", false, "on?"),
    (
        "pref.uiScale",
        "Read or set interface size",
        false,
        "scale?",
    ),
    ("pref.uiScaleUp", "Increase interface size", false, ""),
    ("pref.uiScaleDown", "Decrease interface size", false, ""),
    ("pref.uiScaleReset", "Reset interface size", false, ""),
    (
        "view.outlines",
        "Show layer geometry outlines",
        false,
        "on?",
    ),
    (
        "view.outlinesSelection",
        "Outline selected layers only",
        false,
        "on?",
    ),
    (
        "view.outlinesHiddenLayers",
        "Include hidden layers in outlines",
        false,
        "on?",
    ),
    (
        "view.outlinesObjectBounds",
        "Include object bounds in outlines",
        false,
        "on?",
    ),
    ("view.maskOutlines", "Show mask outlines", false, "on?"),
    (
        "view.pixelPreview",
        "Preview document pixels",
        false,
        "on?, scale?",
    ),
    ("help.page", "Open the editor help page", false, ""),
    ("view.themeLight", "Use light theme", false, ""),
    ("view.themeDark", "Use dark theme", false, ""),
    ("view.themeSystem", "Follow the system theme", false, ""),
    ("doc.home", "Open the local document library", false, ""),
    ("layers.collapseAll", "Collapse the layer tree", false, ""),
    ("app.preferences", "Open preferences", false, ""),
    ("app.actions", "Open actions", false, ""),
    ("help.shortcuts", "Show keyboard shortcuts", false, ""),
    ("help.about", "About Oh My Canvas", false, ""),
    (
        "help.gettingStarted",
        "Show getting started tips",
        false,
        "show?",
    ),
    (
        "view.contextMenu",
        "Open the selected layer menu",
        false,
        "",
    ),
    ("tool.set", "Choose native canvas tool", false, "tool"),
    ("tool.comment", "Comment tool", false, ""),
    ("view.comments", "Show comments", false, "on?"),
    ("tool.move", "Move tool", false, ""),
    ("tool.scale", "Scale tool", false, ""),
    (
        "tool.scaleAnchor",
        "Read or set the scale anchor",
        false,
        "anchor?",
    ),
    ("tool.slice", "Slice tool", false, ""),
    ("tool.shape", "Board shapes tool", false, "shape?"),
    ("tool.hand", "Hand tool", false, ""),
    ("tool.frame", "Frame tool", false, ""),
    ("tool.section", "Section tool", false, ""),
    ("tool.rectangle", "Rectangle tool", false, ""),
    ("tool.ellipse", "Ellipse tool", false, ""),
    ("tool.text", "Text tool", false, ""),
    ("tool.textOnPath", "Text on a path", false, ""),
    ("edit.pickColor", "Pick color", false, "apply?"),
    ("tool.pen", "Pen tool", false, ""),
    ("tool.shapeBuilder", "Shape builder tool", false, ""),
    ("tool.pencil", "Pencil tool", false, ""),
    (
        "tool.pencilBrush",
        "Pencil brush",
        false,
        "preset?, spacing?, sizeJitter?, rotationJitter?, scatter?, seed?",
    ),
    ("tool.marker", "Marker tool", false, "color?"),
    ("tool.highlighter", "Highlighter tool", false, "color?"),
    ("tool.eraser", "Board ink eraser", false, ""),
    ("tool.connector", "Connector", false, "style?"),
    ("tool.stamp", "Stamp", false, "stamp?"),
    ("tool.sticky", "Sticky note", false, "color?"),
    ("tool.line", "Line tool", false, ""),
    ("tool.arrow", "Arrow tool", false, ""),
    ("tool.polygon", "Polygon tool", false, ""),
    ("tool.star", "Star tool", false, ""),
    (
        "tool.crosshair",
        "Move placement crosshair",
        false,
        "dx?, dy?, big?",
    ),
    ("tool.place", "Place canvas object", true, "tool?, x?, y?"),
    (
        "window.new",
        "Open another editor window",
        false,
        "path?, index?",
    ),
    ("window.focus", "Focus native window", false, "id"),
    (
        "dev.focus",
        "Focus one frame or section",
        false,
        "id?, direction?",
    ),
    ("dev.unfocus", "Leave frame focus view", false, ""),
    ("proto.present", "Present prototype", false, "start?"),
    ("proto.preview", "Preview prototype", false, "start?"),
    ("proto.closePreview", "Close prototype preview", false, ""),
];

pub fn is_figcraft_command(name: &str) -> bool {
    FIGCRAFT_COMMANDS.iter().any(|command| command.0 == name)
        || is_text_editor_command(name)
        || name == "edit.setDefaultProperties"
}

pub fn is_text_editor_command(name: &str) -> bool {
    matches!(
        name,
        "text.edit.begin"
            | "text.edit.insert"
            | "text.edit.key"
            | "text.edit.caret"
            | "text.edit.selectWord"
            | "text.edit.selectLine"
            | "text.edit.preedit"
            | "text.edit.selection"
            | "text.edit.end"
    )
}

pub fn is_legacy_workspace_action(name: &str) -> bool {
    matches!(
        name,
        "window" | "quit" | "sample_color" | "state" | "focus" | "close" | "show_library"
    )
}
pub fn is_legacy_window_only(name: &str) -> bool {
    matches!(name, "window" | "quit" | "sample_color")
}

impl ToolRouter {
    pub fn fig_desktop_arguments(
        &self,
        session: &str,
        command: &str,
        arguments: &Value,
    ) -> Result<Value> {
        let mut params = arguments
            .get("params")
            .cloned()
            .unwrap_or_else(|| json!({}));
        if !params.is_object() {
            return Err(EngineError::invalid("command params must be an object"));
        }
        if command == "window.new" {
            schema::check(
                &json!({"type":"object","properties":{
                    "index":{"type":"integer","minimum":0},
                    "path":{"type":"string","minLength":1}
                },"additionalProperties":false}),
                &params,
                "params",
            )?;
            if params.get("path").is_some() && params.get("index").is_some() {
                return Err(EngineError::invalid("Choose a path or open tab index"));
            }
            if let Some(path) = params["path"].as_str()
                && !std::path::Path::new(path).is_absolute()
            {
                return Err(EngineError::invalid("The file path must be absolute"));
            }
            return Ok(params);
        }
        if matches!(command, "libraries.open" | "libraries.publish") {
            schema::check(
                &json!({"type":"object","additionalProperties":false}),
                &params,
                "params",
            )?;
        }
        if matches!(command, "view.comments" | "tool.comment") {
            let fields = if command == "view.comments" {
                json!({"on":{"type":"boolean"}})
            } else {
                json!({})
            };
            crate::schema::check(
                &json!({"type":"object","properties":fields,"additionalProperties":false}),
                &params,
                "params",
            )?;
        }
        if matches!(command, "dev.focus" | "dev.unfocus") {
            let schema = if command == "dev.focus" {
                json!({"type":"object","additionalProperties":false,"properties":{
                    "id":{"type":"integer","minimum":1},"direction":{"enum":["next","previous"]}
                }})
            } else {
                json!({"type":"object","additionalProperties":false})
            };
            crate::schema::check(&schema, &params, "params")?;
            if params.get("id").is_some() && params.get("direction").is_some() {
                return Err(EngineError::invalid("Choose a frame or a direction"));
            }
        }
        let target = arguments["document"]
            .as_str()
            .map(native_id)
            .transpose()?
            .or(
                if command.starts_with("pref.")
                    || command.starts_with("app.")
                    || command.starts_with("help.")
                    || command.starts_with("view.theme")
                    || matches!(command, "doc.home" | "view.fullscreen" | "window.focus")
                {
                    None
                } else {
                    self.workspace.session(session)?.binding
                },
            );
        if let Some(document) = target.as_deref() {
            params["document"] = document.into();
        }
        if command == "edit.setDefaultProperties" {
            schema::check(
                &json!({"type":"object","additionalProperties":false,"properties":{
                    "document":{"type":"string"},"id":{"type":"integer","minimum":1},
                }}),
                &params,
                "params",
            )?;
            if let Some(id) = params.get("id") {
                let document = self.workspace.target(session, target.as_deref())?;
                let snapshot = self.workspace.snapshot(&document)?;
                let layer = self.fig_layer(session, &snapshot, id)?;
                params["layer"] = layer.into();
                params["document"] = document.into();
            } else if let Some(document) = target.as_deref()
                && let Ok(state) = self.state(session, document)
                && let Some(alias) = state.view["selection"]
                    .as_array()
                    .and_then(|ids| ids.first())
            {
                let snapshot = self.workspace.snapshot(document)?;
                if let Ok(layer) = self.fig_layer(session, &snapshot, alias) {
                    params["fallbackLayer"] = layer.into();
                }
            }
        }
        if command == "text.edit.begin" {
            let document = self.workspace.target(session, target.as_deref())?;
            let snapshot = self.workspace.snapshot(&document)?;
            let id = self.fig_layer(session, &snapshot, &params["id"])?;
            params["layer"] = id.into();
            params["document"] = document.into();
        }
        if command == "dev.focus" && (target.is_some() || params.get("id").is_some()) {
            let document = self.workspace.target(session, target.as_deref())?;
            let snapshot = self.workspace.snapshot(&document)?;
            if params.get("id").is_some() {
                params["layer"] = self.fig_layer(session, &snapshot, &params["id"])?.into();
            } else if let Ok(state) = self.state(session, &document)
                && let Some(id) = state.view["selection"]
                    .as_array()
                    .and_then(|ids| ids.first())
                && let Ok(layer) = self.fig_layer(session, &snapshot, id)
            {
                params["fallbackLayer"] = layer.into();
            }
            params["document"] = document.into();
            params["minSequence"] = snapshot.sequence.into();
        }
        if matches!(command, "proto.present" | "proto.preview") {
            params["presentationOptions"] =
                self.workspace.catalog.lock().unwrap().preference()?["prototypePresentation"]
                    .clone();
            if params.get("start").is_some() {
                let document = self.workspace.target(session, target.as_deref())?;
                let snapshot = self.workspace.snapshot(&document)?;
                let id = self.fig_layer(session, &snapshot, &params["start"])?;
                params["startLayer"] = id.into();
                params["document"] = document.into();
                params["minSequence"] = snapshot.sequence.into();
            } else if let Some(document) = target.as_deref() {
                params["minSequence"] = self.workspace.context(document)?.revision.sequence.into();
            }
        }
        Ok(params)
    }

    pub fn fig_window_result(&self, session: &str, result: Value) -> Result<Value> {
        let document = result["documentId"]
            .as_str()
            .ok_or_else(|| EngineError::invalid("The new window did not open a document"))?;
        let native = native_id(document)?;
        self.workspace.bind(session, &native)?;
        self.fig_record_tab(session, json!({"id":crate::external_id(&native)}))?;
        let result = self.fig_desktop_result(session, result, false, false)?;
        self.fig_adopt_window_file(session, &native);
        Ok(result)
    }

    pub fn native_open_window_file(&self, session: &str, path: &str) -> Result<Value> {
        let opened = self.fig_open_file(session, &json!({"path":path}))?;
        let document = opened["document"]
            .as_str()
            .ok_or_else(|| EngineError::invalid("The file did not open a document"))?;
        Ok(json!(self.workspace.snapshot(&native_id(document)?)?))
    }

    pub fn fig_headless_view(
        &self,
        session: &str,
        command: &str,
        arguments: &Value,
    ) -> Result<Value> {
        let params = self.fig_desktop_arguments(session, command, arguments)?;
        if command == "view.fullscreen" {
            return Ok(json!({"on":false}));
        }
        if command == "help.page" {
            return Ok(json!({"url":"https://github.com/Dindb-dong/oh-my-canvas#readme"}));
        }
        if !matches!(
            command,
            "view.get"
                | "view.set"
                | "view.pan"
                | "view.zoomIn"
                | "view.zoomOut"
                | "view.zoom100"
                | "view.zoom50"
                | "view.zoom200"
                | "view.zoomAt"
                | "view.zoomFit"
                | "view.zoomSelection"
                | "view.nextFrame"
                | "view.prevFrame"
                | "view.nextPage"
                | "view.prevPage"
        ) {
            return Err(EngineError::new(
                "desktop_unavailable",
                "Open the native desktop in this workspace profile",
            ));
        }
        let document = self
            .workspace
            .target(session, params["document"].as_str())?;
        let snapshot = self.workspace.snapshot(&document)?;
        if self
            .states
            .lock()
            .unwrap()
            .get(&(session.into(), document.clone()))
            .is_none_or(|state| state.epoch != snapshot.epoch)
        {
            self.context_from(session, &snapshot)?;
        }
        let mut state = self.state(session, &document)?;
        if matches!(command, "view.prevPage" | "view.nextPage") {
            let index = snapshot
                .pages
                .iter()
                .position(|page| page.id == state.page_id)
                .unwrap_or(0);
            let index = if command == "view.nextPage" {
                (index + 1).min(snapshot.pages.len() - 1)
            } else {
                index.saturating_sub(1)
            };
            let page = &snapshot.pages[index];
            if page.id != state.page_id {
                state.page_id = page.id.clone();
                state.root = page.root_node_id.clone();
                state.aliases.clear();
                state.next_alias = 0;
                state.view["selection"] = json!([]);
                state.view["figViewport"] = Value::Null;
            }
            self.states
                .lock()
                .unwrap()
                .insert((session.into(), document.clone()), state);
            return Ok(
                json!({"page":self.fig_alias(session, &document, &page.root_node_id),"index":index}),
            );
        }
        let number = |source: &Value, key: &str, default: f64| -> Result<f64> {
            match source.get(key) {
                Some(value) => value
                    .as_f64()
                    .filter(|value| value.is_finite() && value.abs() <= 10_000_000.)
                    .ok_or_else(|| {
                        EngineError::invalid(format!(
                            "{key} must be a finite number within ±10,000,000"
                        ))
                    }),
                None => Ok(default),
            }
        };
        let previous = &state.view["figViewport"];
        let (mut x, mut y, mut zoom, mut w, mut h) = (
            number(previous, "cx", 500.)?,
            number(previous, "cy", 400.)?,
            number(previous, "zoom", 1.)?,
            number(previous, "vw", 1000.)?,
            number(previous, "vh", 800.)?,
        );
        match command {
            "view.set" => {
                x = number(&params, "cx", x)?;
                y = number(&params, "cy", y)?;
                zoom = number(&params, "zoom", zoom)?.clamp(0.05, 16.);
                w = number(&params, "vw", w)?;
                h = number(&params, "vh", h)?;
                if w <= 0. || h <= 0. {
                    return Err(EngineError::invalid("viewport dimensions must be positive"));
                }
            }
            "view.zoomIn" => zoom = (zoom * 1.25).min(16.),
            "view.zoomOut" => zoom = (zoom * 0.8).max(0.05),
            "view.zoom100" => zoom = 1.,
            "view.zoom50" => zoom = 0.5,
            "view.zoom200" => zoom = 2.,
            "view.pan" => {
                let step = if params["big"] == true { 200. } else { 20. };
                x += number(&params, "dx", 0.)? * step / zoom;
                y += number(&params, "dy", 0.)? * step / zoom;
            }
            "view.zoomAt" => {
                let px = number(&params, "x", x)?;
                let py = number(&params, "y", y)?;
                if params.get("width").is_some() || params.get("height").is_some() {
                    let width = number(&params, "width", 0.)?;
                    let height = number(&params, "height", 0.)?;
                    if width <= 0. || height <= 0. {
                        return Err(EngineError::invalid(
                            "fit area needs positive width and height",
                        ));
                    }
                    (x, y, zoom) = fit([px, py, width, height], w, h);
                } else {
                    let next =
                        (zoom * if params["out"] == true { 0.8 } else { 1.25 }).clamp(0.05, 16.);
                    x = px + (x - px) * zoom / next;
                    y = py + (y - py) * zoom / next;
                    zoom = next;
                }
            }
            "view.zoomFit" | "view.zoomSelection" | "view.nextFrame" | "view.prevFrame" => {
                let mut nodes = children(&snapshot, &state.root);
                if command == "view.zoomSelection" {
                    nodes = state.view["selection"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(|id| {
                            self.fig_layer(session, &snapshot, id)
                                .ok()
                                .and_then(|id| snapshot.nodes.get(&id))
                        })
                        .collect();
                }
                if matches!(command, "view.nextFrame" | "view.prevFrame") {
                    nodes.retain(|node| node.kind == NodeKind::Frame);
                    if !nodes.is_empty() {
                        let index = state.view["figFrame"].as_u64().map(|index| index as usize);
                        let index = next_index(index, nodes.len(), command == "view.prevFrame");
                        state.view["figFrame"] = json!(index);
                        nodes = vec![nodes[index]];
                    }
                }
                if !nodes.is_empty() {
                    let scene = omc_scene::build_scene(
                        &snapshot,
                        &omc_scene::SceneOptions {
                            page_id: Some(state.page_id.clone()),
                            ..Default::default()
                        },
                    )
                    .map_err(|error| EngineError::invalid(error.to_string()))?;
                    let bounds = nodes
                        .iter()
                        .filter_map(|node| scene.bounds(&node.id))
                        .reduce(union);
                    if let Some(bounds) = bounds {
                        (x, y, zoom) = fit(bounds, w, h);
                    }
                }
            }
            _ => {}
        }
        let output = json!({"cx":x,"cy":y,"zoom":zoom,"vw":w,"vh":h});
        state.view["figViewport"] = output.clone();
        self.states
            .lock()
            .unwrap()
            .insert((session.into(), document), state);
        Ok(output)
    }
}

fn fit([x, y, width, height]: [f64; 4], w: f64, h: f64) -> (f64, f64, f64) {
    (
        x + width / 2.,
        y + height / 2.,
        ((w - 64.) / width.max(1.))
            .min((h - 64.) / height.max(1.))
            .clamp(0.05, 4.),
    )
}

fn union(a: [f64; 4], b: [f64; 4]) -> [f64; 4] {
    let x = a[0].min(b[0]);
    let y = a[1].min(b[1]);
    [
        x,
        y,
        (a[0] + a[2]).max(b[0] + b[2]) - x,
        (a[1] + a[3]).max(b[1] + b[3]) - y,
    ]
}

fn next_index(current: Option<usize>, count: usize, previous: bool) -> usize {
    match (current, previous) {
        (Some(index), true) => (index + count - 1) % count,
        (Some(index), false) => (index + 1) % count,
        (None, true) => count - 1,
        (None, false) => 0,
    }
}
