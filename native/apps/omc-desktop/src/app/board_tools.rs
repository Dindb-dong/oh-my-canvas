use super::*;

pub(super) struct BoardTools {
    sticky_color: String,
    connector_style: &'static str,
    stamp: &'static str,
}

impl Default for BoardTools {
    fn default() -> Self {
        Self {
            sticky_color: "#ffe78a".into(),
            connector_style: "elbow",
            stamp: "thumbsUp",
        }
    }
}

impl App {
    pub(super) fn configure_board_tool(
        &mut self,
        action: &str,
        args: &Value,
    ) -> Result<Value, String> {
        let (tool, settings) = match action {
            "connector" => {
                if let Some(style) = args.get("style") {
                    self.board_tools.connector_style = match style.as_str() {
                        Some("straight") => "straight",
                        Some("elbow") => "elbow",
                        Some("curved") => "curved",
                        _ => return Err("style must be straight, elbow, or curved".into()),
                    };
                }
                (
                    Tool::Connector,
                    json!({"style":self.board_tools.connector_style}),
                )
            }
            "stamp" => {
                if let Some(stamp) = args.get("stamp") {
                    self.board_tools.stamp = omc_style::board_stamp_name(stamp)?;
                }
                (Tool::Stamp, json!({"stamp":self.board_tools.stamp}))
            }
            "sticky" => {
                if let Some(color) = args.get("color") {
                    self.board_tools.sticky_color = omc_style::board_ink_color(color)?;
                }
                (Tool::Sticky, json!({"color":self.board_tools.sticky_color}))
            }
            _ => return Err("Unknown board tool".into()),
        };
        self.action(Action::Tool(tool));
        let mut result = settings;
        result["tool"] = json!(action);
        Ok(result)
    }

    pub(super) fn finish_board_tool(
        &mut self,
        tool: Tool,
        start: (f64, f64),
        end: (f64, f64),
    ) -> bool {
        let (x, y) = start;
        match tool {
            Tool::Sticky => self.create_board_tool(
                "board.sticky",
                json!({"x":x,"y":y,"color":self.board_tools.sticky_color}),
            ),
            Tool::Stamp => self.create_board_tool(
                "board.stamp",
                json!({"x":x,"y":y,"stamp":self.board_tools.stamp}),
            ),
            Tool::Connector => {
                if (start.0 - end.0).hypot(start.1 - end.1) * self.camera.zoom < 3. {
                    return true;
                }
                let from = self.connector_target(start);
                let to = self.connector_target(end);
                if from != to {
                    self.create_board_tool(
                        "board.connector",
                        json!({"from":from,"to":to,"style":self.board_tools.connector_style}),
                    );
                }
            }
            _ => return false,
        }
        true
    }

    fn connector_target(&self, point: (f64, f64)) -> Value {
        if let Some(hit) = self.hit_canvas_item(point)
            && let Some(snapshot) = self.document()
            && let Some(node) = snapshot.nodes.get(&hit.id)
        {
            let parent = node
                .parent_id
                .as_ref()
                .and_then(|id| snapshot.nodes.get(id));
            let target = parent
                .filter(|parent| {
                    matches!(
                        parent.string("boardItemType"),
                        Some("sticky" | "shape" | "stamp")
                    )
                })
                .unwrap_or(node);
            if target.string("boardItemType") != Some("connector") {
                return json!(target.id);
            }
        }
        json!({"x":point.0,"y":point.1})
    }

    pub(super) fn create_board_tool(&mut self, command: &'static str, params: Value) {
        let (Some(doc), Some(page)) = (self.document(), self.page.clone()) else {
            return;
        };
        let request = Request::BoardTool {
            id: doc.id.clone(),
            epoch: doc.epoch.clone(),
            sequence: doc.sequence,
            page,
            command,
            params,
        };
        self.clear_text_preview();
        self.pending = true;
        self.status = "Saving…".into();
        self.error = None;
        self.send(request);
    }
}
