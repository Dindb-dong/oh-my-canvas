use super::*;

#[derive(Default)]
pub(crate) struct CreationDefaults {
    shape: Option<Properties>,
    text: Option<Properties>,
}

impl CreationDefaults {
    fn set(&mut self, text: bool, properties: Properties) {
        if text {
            self.text = Some(properties);
        } else {
            self.shape = Some(properties);
        }
    }

    fn get(&self, kind: &str) -> Option<&Properties> {
        match kind {
            "text" => self.text.as_ref(),
            "rectangle" | "ellipse" | "polygon" | "star" => self.shape.as_ref(),
            _ => None,
        }
    }
}

pub fn headless_tool_command(command: &str) -> bool {
    matches!(
        command,
        "tool.place"
            | "tool.set"
            | "tool.frame"
            | "tool.rectangle"
            | "tool.ellipse"
            | "tool.text"
            | "tool.line"
            | "tool.arrow"
            | "tool.polygon"
            | "tool.star"
            | "tool.move"
            | "tool.hand"
    )
}

impl ToolRouter {
    pub(super) fn fig_creation_defaults(
        &self,
        session: &str,
        snapshot: &DocumentSnapshot,
        state: &ViewState,
        selection: &[Value],
        params: &Value,
    ) -> Result<Value> {
        schema::check(
            &json!({"type":"object","additionalProperties":false,
                "properties":{"id":{"type":"integer","minimum":1}}}),
            params,
            "params",
        )?;
        let choice = params
            .get("id")
            .or_else(|| selection.first())
            .ok_or_else(|| EngineError::invalid("select a layer to set its drawing defaults"))?;
        let id = self.fig_layer(session, snapshot, choice)?;
        let node = &snapshot.nodes[&id];
        if node.parent_id.is_none() {
            return Err(EngineError::invalid("a page is not a layer"));
        }
        let scene = paths::scene(snapshot, &state.page_id)?;
        let item = scene
            .item(&id)
            .ok_or_else(|| EngineError::invalid("source layer is outside the current page"))?;
        let is_text = node.kind == NodeKind::Text;
        let properties = omc_style::drawing_defaults(node, &item.properties, &item.style);
        self.fig_creation_defaults
            .lock()
            .unwrap()
            .entry(session.to_owned())
            .or_default()
            .set(is_text, properties.clone());
        Ok(json!({
            "for":if is_text {"text"}else{"shapes"},
            "properties":properties,
        }))
    }

    pub(super) fn fig_headless_tool(
        &self,
        session: &str,
        snapshot: &DocumentSnapshot,
        state: &ViewState,
        command: &str,
        params: &Value,
    ) -> Result<Value> {
        let key = (session.to_owned(), snapshot.id.clone());
        let fields = match command {
            "tool.place" => {
                json!({"tool":{"type":"string"},"x":{"type":"number"},"y":{"type":"number"}})
            }
            "tool.set" => json!({"tool":{"type":"string"}}),
            _ => json!({}),
        };
        schema::check(
            &json!({"type":"object","additionalProperties":false,"properties":fields}),
            params,
            "params",
        )?;
        let requested = if command == "tool.place" {
            params["tool"]
                .as_str()
                .or_else(|| state.view["figHeadlessTool"].as_str())
                .ok_or_else(|| EngineError::invalid("choose a shape or text tool first"))?
        } else if command == "tool.set" {
            string(params, "tool")?
        } else {
            command.strip_prefix("tool.").unwrap()
        };
        let tool = match requested {
            "rect" | "rectangle" => "rectangle",
            "ellipse" | "oval" => "ellipse",
            "select" | "move" => "move",
            "hand" | "frame" | "line" | "arrow" | "polygon" | "star" | "text" => requested,
            _ => return Err(EngineError::invalid("unsupported headless canvas tool")),
        };
        if command != "tool.place" {
            if let Some(current) = self.states.lock().unwrap().get_mut(&key) {
                current.view["figHeadlessTool"] = json!(tool);
            }
            return Ok(json!({"tool":tool}));
        }
        let (width, height, kind) = match tool {
            "frame" => (320., 240., "frame"),
            "text" => (200., 48., "text"),
            "line" | "arrow" => (100., 0., "line"),
            "rectangle" | "ellipse" | "polygon" | "star" => (100., 100., tool),
            _ => return Err(EngineError::invalid("choose a shape or text tool first")),
        };
        let at = |field: &str, center: &str| -> Result<f64> {
            if let Some(value) = params.get(field) {
                return value
                    .as_f64()
                    .filter(|value| value.is_finite() && value.abs() <= 10_000_000.)
                    .ok_or_else(|| {
                        EngineError::invalid("tool position is outside the canvas limit")
                    });
            }
            Ok(state.view["figViewport"][center]
                .as_f64()
                .unwrap_or_default())
        };
        let mut create = json!({
            "type":kind,"x":at("x","cx")?-width/2.,"y":at("y","cy")?-height/2.,
            "width":width,"height":height,
        });
        if tool == "text" {
            create["text"] = json!("Type something");
        }
        let mut snapshot = snapshot.clone();
        let mut commands = Vec::new();
        let mut selection = Vec::new();
        let result = self.fig_edit(
            session,
            &state.root,
            &mut snapshot,
            &mut selection,
            &mut commands,
            "node.create",
            &create,
        )?;
        let Some(Command::NodeCreate { node }) = commands.last_mut() else {
            return Err(EngineError::new(
                "internal_error",
                "drawing did not prepare a node",
            ));
        };
        let mut appearance = match tool {
            "text" => Properties::from([
                ("fill".into(), json!("#1F2937")),
                ("fontSize".into(), json!(24.)),
            ]),
            "line" | "arrow" => Properties::from([
                ("stroke".into(), json!("#202020")),
                ("strokeWidth".into(), json!(2.)),
            ]),
            "frame" => Properties::from([("fill".into(), json!("#FFFFFF"))]),
            _ => Properties::from([("fill".into(), json!("#A8B5F7"))]),
        };
        if tool == "arrow" {
            appearance.insert("arrowHead".into(), json!(true));
        }
        node.properties.extend(appearance);
        if let Some(defaults) = self
            .fig_creation_defaults
            .lock()
            .unwrap()
            .get(session)
            .and_then(|defaults| defaults.get(tool))
        {
            node.properties.extend(defaults.clone());
        }
        self.submit(
            session,
            &snapshot.id,
            Command::Batch { commands },
            &Value::Null,
            Some(snapshot.sequence),
        )?;
        self.fig_selection(&key, &selection);
        Ok(json!({"id":result["id"],"selection":selection,"tool":tool}))
    }
}
