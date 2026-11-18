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
        let guides = guides_for_owner(snapshot, &owner)?;
        if action == "select" {
            let index = guide_index(index, guides.len())?;
            update_selection(json!({"owner":owner,"index":index}), true);
            return Ok(
                json!({"owner":self.fig_alias(session, &snapshot.id, &owner),"index":index}),
            );
        }
        let (guides, index) = edit_guides(guides, action, index, params)?;
        let revised_selection = selected
            .filter(|(selected_owner, _)| *selected_owner == owner)
            .and_then(|(selected_owner, selected_index)| match (action, index) {
                ("clear", _) => Some(Value::Null),
                ("remove", Some(index)) if selected_index == index => Some(Value::Null),
                ("remove", Some(index)) if selected_index > index => {
                    Some(json!({"owner":selected_owner,"index":selected_index-1}))
                }
                _ => None,
            });
        let result = if action == "add" {
            json!({"index":index})
        } else {
            json!({"ok":true})
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

    pub(crate) fn native_guide_commands(
        &self,
        session: &str,
        snapshot: &DocumentSnapshot,
        args: &Value,
    ) -> Result<(Vec<Command>, Properties)> {
        let state = self.state(session, &snapshot.id)?;
        let id = args["ownerId"]
            .as_str()
            .map(|id| self.resolve(session, &snapshot.id, id))
            .transpose()?
            .unwrap_or_else(|| state.root.clone());
        if !crate::legacy_read::is_descendant(snapshot, &id, &state.root) {
            return Err(EngineError::invalid(
                "guide owner is outside the selected page",
            ));
        }
        let guides = guides_for_owner(snapshot, &id)?;
        let action = string(args, "action")?;
        let (commands, guides, index) = if action == "list" {
            (Vec::new(), guides, None)
        } else {
            let mut parent = snapshot.nodes.get(&id);
            while let Some(node) = parent {
                if node.properties.get("locked") == Some(&Value::Bool(true)) {
                    return Err(EngineError::invalid("guide owner or ancestor is locked"));
                }
                parent = node
                    .parent_id
                    .as_ref()
                    .and_then(|id| snapshot.nodes.get(id));
            }
            if matches!(action, "move" | "remove") && args.get("revision").is_none() {
                return Err(EngineError::invalid(
                    "edit an indexed guide using the listed revision",
                ));
            }
            let (edited, index) =
                edit_guides(guides.clone(), action, optional_index(args, "index")?, args)?;
            let commands = if edited == guides {
                Vec::new()
            } else {
                vec![set(&id, json!({"guides":edited}))?]
            };
            (commands, edited, index)
        };
        Ok((
            commands,
            Properties::from([
                ("ownerId".into(), json!(id)),
                ("guides".into(), json!(guides)),
                ("index".into(), json!(index)),
            ]),
        ))
    }
}

fn guides_for_owner(snapshot: &DocumentSnapshot, owner: &str) -> Result<Vec<Value>> {
    let node = snapshot
        .nodes
        .get(owner)
        .ok_or_else(|| EngineError::invalid("no such guide owner"))?;
    if !keeps_guides(snapshot, node) {
        return Err(EngineError::invalid(
            "guides belong on a page or top-level frame",
        ));
    }
    Ok(node
        .properties
        .get("guides")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default())
}

fn guide_index(index: Option<usize>, length: usize) -> Result<usize> {
    index
        .filter(|index| *index < length)
        .ok_or_else(|| EngineError::invalid("no such guide"))
}

fn edit_guides(
    mut guides: Vec<Value>,
    action: &str,
    index: Option<usize>,
    params: &Value,
) -> Result<(Vec<Value>, Option<usize>)> {
    let changed = match action {
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
            Some(guides.len() - 1)
        }
        "move" => {
            let index = guide_index(index, guides.len())?;
            guides[index]["offset"] = json!(offset(params)?);
            Some(index)
        }
        "remove" => {
            let index = guide_index(index, guides.len())?;
            guides.remove(index);
            Some(index)
        }
        "clear" => {
            guides.clear();
            None
        }
        _ => return Err(EngineError::invalid("unknown guide command")),
    };
    Ok((guides, changed))
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
