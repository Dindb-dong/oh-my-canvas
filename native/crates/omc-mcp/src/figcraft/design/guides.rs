use super::*;

const MAX_GUIDES: usize = 10_000;

impl ToolRouter {
    pub(super) fn fig_guides(
        &self,
        session: &str,
        snapshot: &DocumentSnapshot,
        state: &ViewState,
        action: &str,
        params: &Value,
    ) -> Result<Value> {
        let key = (session.to_owned(), snapshot.id.clone());
        let index = if params["index"].is_null() {
            None
        } else {
            optional_index(params, "index")?
        };
        let selected = state.view["guide"]["owner"].as_str().zip(
            state.view["guide"]["index"]
                .as_u64()
                .map(|index| index as usize),
        );
        let update_selection = |selection: Value, clear_layers: bool| {
            if let Some(state) = self.states.lock().unwrap().get_mut(&key) {
                if !state.view.is_object() {
                    state.view = json!({});
                }
                state.view["guide"] = selection;
                if clear_layers {
                    state.view["selection"] = json!([]);
                }
            }
        };
        if action == "select" && index.is_none() {
            update_selection(Value::Null, false);
            return Ok(Value::Null);
        }
        let (owner, index) = if action == "remove" && index.is_none() {
            let (owner, index) =
                selected.ok_or_else(|| EngineError::invalid("no guide is selected; pass index"))?;
            (owner.to_owned(), Some(index))
        } else {
            let owner = if !params["frame"].is_null() {
                self.fig_layer(session, snapshot, &params["frame"])?
            } else if !params["page"].is_null() {
                self.fig_layer(session, snapshot, &params["page"])?
            } else {
                state.root.clone()
            };
            (owner, index)
        };
        let node = snapshot
            .nodes
            .get(&owner)
            .ok_or_else(|| EngineError::invalid("no such guide owner"))?;
        if !keeps_guides(snapshot, node) {
            return Err(EngineError::invalid(
                "guides belong on a page or top-level frame",
            ));
        }
        let mut guides = node
            .properties
            .get("guides")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let at = || {
            index
                .filter(|index| *index < guides.len())
                .ok_or_else(|| EngineError::invalid("no such guide"))
        };
        let mut revised_selection = None;
        let result = match action {
            "add" => {
                if guides.len() >= MAX_GUIDES {
                    return Err(EngineError::new("resource_limit", "too many guides"));
                }
                let vertical = if params["vertical"].is_null() {
                    true
                } else {
                    params["vertical"]
                        .as_bool()
                        .ok_or_else(|| EngineError::invalid("vertical must be a boolean"))?
                };
                guides.push(json!({"vertical":vertical,"offset":offset(params)?}));
                json!({"index":guides.len()-1})
            }
            "move" => {
                let index = at()?;
                guides[index]["offset"] = json!(offset(params)?);
                json!({"ok":true})
            }
            "remove" => {
                let index = at()?;
                guides.remove(index);
                if let Some((selected_owner, selected_index)) =
                    selected.filter(|(selected_owner, _)| *selected_owner == owner)
                {
                    if selected_index == index {
                        revised_selection = Some(Value::Null);
                    } else if selected_index > index {
                        revised_selection =
                            Some(json!({"owner":selected_owner,"index":selected_index-1}));
                    }
                }
                json!({"ok":true})
            }
            "select" => {
                let index = at()?;
                update_selection(json!({"owner":owner,"index":index}), true);
                return Ok(
                    json!({"owner":self.fig_alias(session, &snapshot.id, &owner),"index":index}),
                );
            }
            "clear" => {
                guides.clear();
                if selected.is_some_and(|(selected_owner, _)| selected_owner == owner) {
                    revised_selection = Some(Value::Null);
                }
                json!({"ok":true})
            }
            _ => return Err(EngineError::invalid("unknown guide command")),
        };
        self.submit(
            session,
            &snapshot.id,
            set(&owner, json!({"guides":guides}))?,
            &Value::Null,
            Some(snapshot.sequence),
        )?;
        if let Some(selection) = revised_selection {
            update_selection(selection, false);
        }
        Ok(result)
    }
}

fn offset(params: &Value) -> Result<f64> {
    params["offset"]
        .as_f64()
        .filter(|value| value.is_finite())
        .map(|value| value.clamp(-1e7, 1e7))
        .ok_or_else(|| EngineError::invalid("offset must be a finite number"))
}

fn keeps_guides(snapshot: &DocumentSnapshot, node: &Node) -> bool {
    if node.parent_id.is_none() {
        return true;
    }
    if !matches!(
        node.kind,
        NodeKind::Frame | NodeKind::Component | NodeKind::Instance
    ) {
        return false;
    }
    let mut parent = node.parent_id.as_deref();
    while let Some(ancestor) = parent.and_then(|parent| snapshot.nodes.get(parent)) {
        if ancestor.parent_id.is_none() {
            return true;
        }
        if matches!(
            ancestor.kind,
            NodeKind::Frame | NodeKind::Component | NodeKind::Instance
        ) && ancestor.string("primitive") != Some("section")
        {
            return false;
        }
        parent = ancestor.parent_id.as_deref();
    }
    false
}
