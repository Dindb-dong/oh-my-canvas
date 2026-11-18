use super::*;

const SLOT_ID: &str = "slotPropertyId";
const SLOT_NAME: &str = "slotName";
const SLOT_CONTENT: &str = "slotContentFor";
const SLOT_REPLACEMENTS: &str = "slotReplacements";
const DEFINITIONS: &str = "componentPropertyDefinitions";

impl ToolRouter {
    pub(super) fn fig_slot_command(
        &self,
        session: &str,
        snapshot: &DocumentSnapshot,
        state: &ViewState,
        selection: &[Value],
        name: &str,
        params: &Value,
    ) -> Result<Value> {
        let target = params
            .get("id")
            .or_else(|| selection.first())
            .ok_or_else(|| {
                EngineError::invalid("select a slot frame or an instance with a named slot")
            })?;
        let mut select = None;
        let (commands, result) = if name.starts_with("component.") {
            let id = self.fig_layer(session, snapshot, target)?;
            let make = name == "component.makeSlot";
            let preferred = if make {
                preferred_ids(params, |id| self.fig_layer(session, snapshot, id))?
            } else {
                Vec::new()
            };
            let (commands, mut result) = slot_definition(snapshot, &id, make, params, preferred)?;
            result["id"] = target.clone();
            (commands, result)
        } else {
            let projected = omc_scene::resolve_components(snapshot, Some(&state.page_id));
            let raw = self.fig_layer(session, &projected.snapshot, target)?;
            let component = if name == "instance.slotInsert" {
                Some(self.fig_layer(session, snapshot, &params["component"])?)
            } else {
                None
            };
            let (commands, mut result) = slot_contents(
                snapshot,
                &projected.snapshot,
                &raw,
                params,
                component.as_deref(),
            )?;
            let id = string(&result, "id")?;
            result["id"] = json!(self.fig_alias(session, &snapshot.id, id));
            if component.is_some() {
                select = Some(result["id"].clone());
                let slot = string(&result, "slot")?;
                result["slot"] = json!(self.fig_alias(session, &snapshot.id, slot));
            }
            (commands, result)
        };
        if !commands.is_empty() {
            self.submit(
                session,
                &snapshot.id,
                Command::Batch { commands },
                &Value::Null,
                Some(snapshot.sequence),
            )?;
        }
        if let Some(select) = select {
            self.fig_selection(&(session.into(), snapshot.id.clone()), &[select]);
        }
        Ok(result)
    }

    pub(crate) fn native_slot_commands(
        &self,
        session: &str,
        snapshot: &DocumentSnapshot,
        args: &Value,
    ) -> Result<(Vec<Command>, Properties)> {
        let action = string(args, "action")?;
        let state = self.state(session, &snapshot.id)?;
        let id = self.resolve(session, &snapshot.id, string(args, "id")?)?;
        if matches!(action, "slot_create" | "slot_remove") {
            slot_target(snapshot, &state.root, &id, true)?;
            let make = action == "slot_create";
            let preferred = if make {
                preferred_ids(args, |id| {
                    self.resolve(
                        session,
                        &snapshot.id,
                        id.as_str().ok_or_else(|| {
                            EngineError::invalid("invalid preferred component ID")
                        })?,
                    )
                })?
            } else {
                Vec::new()
            };
            let (commands, result) = slot_definition(snapshot, &id, make, args, preferred)?;
            return Ok((commands, properties(&result)?));
        }
        let projected = omc_scene::resolve_components(snapshot, Some(&state.page_id));
        let projected = &projected.snapshot;
        let target = slot_target(projected, &state.root, &id, action != "slot_list")?;
        if action == "slot_list" {
            return Ok((Vec::new(), properties(&list_slots(projected, target)?)?));
        }
        let source = match action {
            "slot_insert" => Some(self.resolve(session, &snapshot.id, string(args, "source")?)?),
            "slot_reset" => None,
            _ => return Err(EngineError::invalid("unknown component slot action")),
        };
        let (commands, result) = slot_contents(snapshot, projected, &id, args, source.as_deref())?;
        let slot_id = string(&result, if source.is_some() { "slot" } else { "id" })?;
        slot_target(projected, &state.root, slot_id, true)?;
        Ok((commands, properties(&result)?))
    }
}

fn slot_definition(
    snapshot: &DocumentSnapshot,
    id: &str,
    make: bool,
    params: &Value,
    preferred: Vec<String>,
) -> Result<(Vec<Command>, Value)> {
    let mut commands = Vec::new();
    let result = {
        let frame = snapshot
            .nodes
            .get(id)
            .ok_or_else(|| EngineError::invalid("slot frame does not exist"))?;
        let owner = owning_component(snapshot, frame)?;
        let mut definitions = array(owner.properties.get(DEFINITIONS));
        if make {
            if frame.string(SLOT_ID).is_some() {
                return Err(EngineError::invalid("selected frame is already a slot"));
            }
            let used = |name: &str| definitions.iter().any(|property| property["name"] == name);
            let title = if params.get("name").is_some() {
                let title = string(params, "name")?.trim();
                if title.is_empty() || title.chars().count() > 256 || used(title) {
                    return Err(EngineError::invalid(
                        "slot name must be nonempty and unique in the component",
                    ));
                }
                title.to_owned()
            } else {
                let base = frame
                    .string("name")
                    .filter(|name| !name.is_empty())
                    .unwrap_or("Slot");
                std::iter::once(base.to_owned())
                    .chain((2..).map(|index| format!("{base} {index}")))
                    .find(|name| !used(name))
                    .unwrap()
            };
            let preferred = preferred_components(snapshot, preferred)?;
            let property = omc_model::new_id("component_prop");
            definitions.push(
                json!({"id":property,"name":title,"type":"slot","layer":id,"preferred":preferred}),
            );
            commands.push(Command::NodeSet {
                node_id: id.to_owned(),
                properties: Properties::from([
                    (SLOT_ID.into(), json!(property)),
                    (SLOT_NAME.into(), json!(title)),
                ]),
            });
            commands.push(set(owner, DEFINITIONS, json!(definitions)));
            json!({"id":id,"name":title,"property":property})
        } else {
            let property = frame
                .string(SLOT_ID)
                .ok_or_else(|| EngineError::invalid("frame is not a component slot"))?;
            let title = frame.string(SLOT_NAME).unwrap_or_default();
            definitions.retain(|entry| entry["id"] != property);
            commands.push(set(owner, DEFINITIONS, json!(definitions)));
            commands.push(Command::NodeUnset {
                node_id: id.to_owned(),
                properties: vec![SLOT_ID.into(), SLOT_NAME.into()],
            });
            let contents = snapshot
                .nodes
                .values()
                .filter(|node| node.string(SLOT_CONTENT) == Some(id))
                .map(|node| node.id.clone())
                .collect::<Vec<_>>();
            if !contents.is_empty() {
                commands.push(Command::NodeDelete { node_ids: contents });
            }
            for instance in snapshot
                .nodes
                .values()
                .filter(|node| node.kind == NodeKind::Instance)
            {
                let mut replacements = replacement_map(instance);
                let before = replacements.len();
                replacements.retain(|key, _| key.rsplit('/').next() != Some(id));
                if replacements.len() != before {
                    commands.push(set(
                        instance,
                        SLOT_REPLACEMENTS,
                        Value::Object(replacements),
                    ));
                }
            }
            json!({"id":id,"name":title})
        }
    };
    Ok((commands, result))
}

fn slot_contents(
    snapshot: &DocumentSnapshot,
    projected: &DocumentSnapshot,
    raw: &str,
    params: &Value,
    component: Option<&str>,
) -> Result<(Vec<Command>, Value)> {
    let mut commands = Vec::new();
    let (instance, projected_instance, frame, projected_slot) =
        instance_slot(snapshot, projected, raw, params["slot"].as_str())?;
    let slot_id = &projected_slot.id;
    let scope = (instance.id != projected_instance.id).then_some(projected_instance.id.as_str());
    let replacement_key =
        scope.map_or_else(|| frame.id.clone(), |scope| format!("{scope}/{}", frame.id));
    let custom = children(snapshot, &instance.id)
        .into_iter()
        .filter(|node| {
            node.string(SLOT_CONTENT) == Some(&frame.id) && node.string("slotInstanceFor") == scope
        })
        .collect::<Vec<_>>();
    let mut replacements = replacement_map(instance);
    let result = if let Some(component) = component {
        let component = main_component(snapshot, component)?;
        let mut parent = Some(projected_instance);
        while let Some(owner) = parent {
            if let Some(definition) = owner
                .string("sourceComponentId")
                .or_else(|| owner.string("componentId"))
                && reaches_component(snapshot, &component.id, definition)
            {
                return Err(EngineError::invalid(
                    "slot insertion would create a component cycle",
                ));
            }
            parent = owner
                .string("instanceId")
                .and_then(|id| projected.nodes.get(id));
        }
        let replace = optional_flag(params, "replace")?.unwrap_or(false);
        let index = params
            .get("index")
            .filter(|value| !value.is_null())
            .map(|_| geometry_index(params, "index"))
            .transpose()?;
        if replace && !custom.is_empty() {
            commands.push(Command::NodeDelete {
                node_ids: custom.iter().map(|node| node.id.clone()).collect(),
            });
        }
        let peers = if replace {
            Vec::new()
        } else {
            children(projected, &projected_slot.id)
        };
        let index = index.unwrap_or(peers.len()).min(peers.len());
        let rank = rank_between(
            index
                .checked_sub(1)
                .map(|previous| peers[previous].rank.as_str()),
            peers.get(index).map(|node| node.rank.as_str()),
        )
        .ok_or_else(|| {
            EngineError::new("resource_limit", "slot child order requires rank rebalance")
        })?;
        if replace {
            replacements.insert(replacement_key, Value::Bool(true));
            commands.push(set(
                instance,
                SLOT_REPLACEMENTS,
                Value::Object(replacements),
            ));
        }
        let mut node = Node::new(NodeKind::Instance);
        node.parent_id = Some(instance.id.clone());
        node.home_shard = instance.home_shard.clone();
        node.rank = rank;
        node.properties = properties(&json!({
            "name":component.string("name").unwrap_or("Component"),"componentId":component.id,
            "x":0,"y":0, "slotContentFor":frame.id,
        }))?;
        if let Some(scope) = scope {
            node.properties
                .insert("slotInstanceFor".into(), json!(scope));
        }
        let id = node.id.clone();
        commands.push(Command::NodeCreate { node });
        json!({"id":id,"slot":slot_id})
    } else {
        let replaced = replacements.remove(&replacement_key).is_some();
        if replaced {
            commands.push(set(
                instance,
                SLOT_REPLACEMENTS,
                Value::Object(replacements),
            ));
        }
        if !custom.is_empty() {
            commands.push(Command::NodeDelete {
                node_ids: custom.iter().map(|node| node.id.clone()).collect(),
            });
        }
        json!({"id":slot_id,"changed":replaced || !custom.is_empty()})
    };
    Ok((commands, result))
}

fn preferred_ids(
    params: &Value,
    mut resolve: impl FnMut(&Value) -> Result<String>,
) -> Result<Vec<String>> {
    match params.get("preferred") {
        None | Some(Value::Null) => Ok(Vec::new()),
        Some(items) => items
            .as_array()
            .filter(|items| items.len() <= 500)
            .ok_or_else(|| EngineError::invalid("preferred must contain component or set IDs"))?
            .iter()
            .map(&mut resolve)
            .collect(),
    }
}

fn preferred_components(snapshot: &DocumentSnapshot, ids: Vec<String>) -> Result<Vec<String>> {
    let mut unique = Vec::new();
    for id in ids {
        let node = snapshot
            .nodes
            .get(&id)
            .filter(|node| {
                node.kind == NodeKind::Component
                    || node.properties.get("isVariantSet") == Some(&Value::Bool(true))
            })
            .ok_or_else(|| EngineError::invalid("preferred must contain component or set IDs"))?;
        if !unique.contains(&node.id) {
            unique.push(node.id.clone());
        }
    }
    Ok(unique)
}

fn slot_target<'a>(
    snapshot: &'a DocumentSnapshot,
    root: &str,
    id: &str,
    edit: bool,
) -> Result<&'a Node> {
    let invalid = || EngineError::invalid("slot target is not on the selected page");
    let node = snapshot.nodes.get(id).ok_or_else(invalid)?;
    let mut current = node;
    loop {
        if edit
            && (current.properties.get("locked") == Some(&Value::Bool(true))
                || current.properties.get("hidden") == Some(&Value::Bool(true))
                || current.properties.get("visible") == Some(&Value::Bool(false)))
        {
            return Err(EngineError::invalid(
                "slot target or ancestor is locked or hidden",
            ));
        }
        if current.id == root {
            return Ok(node);
        }
        current = current
            .parent_id
            .as_ref()
            .and_then(|parent| snapshot.nodes.get(parent))
            .ok_or_else(invalid)?;
    }
}

fn list_slots(snapshot: &DocumentSnapshot, node: &Node) -> Result<Value> {
    if node.kind == NodeKind::Component {
        let slots = array(node.properties.get(DEFINITIONS))
            .into_iter()
            .filter(|property| property["type"] == "slot")
            .collect::<Vec<_>>();
        return Ok(json!({"id":node.id,"slots":slots}));
    }
    if node.kind != NodeKind::Instance && node.string(SLOT_ID).is_none() {
        return Err(EngineError::invalid(
            "choose a component, instance, or slot",
        ));
    }
    let slots = if node.kind == NodeKind::Instance {
        snapshot
            .nodes
            .values()
            .filter(|candidate| {
                candidate.string("instanceId") == Some(node.id.as_str())
                    && candidate.string(SLOT_ID).is_some()
            })
            .collect::<Vec<_>>()
    } else {
        vec![node]
    };
    let slots = slots
        .into_iter()
        .map(|slot| {
            let contents = children(snapshot, &slot.id);
            json!({"id":slot.id,"name":slot.string(SLOT_NAME),"property":slot.string(SLOT_ID),
            "sourceNodeId":slot.string("sourceNodeId"),"contentCount":contents.len(),
            "contents":contents.into_iter().take(200).map(|child| json!({
                "id":child.id,"name":child.string("name"),"componentId":child.string("componentId"),
                "sourceNodeId":child.string("sourceNodeId")
            })).collect::<Vec<_>>()})
        })
        .collect::<Vec<_>>();
    Ok(json!({"id":node.id,"slots":slots}))
}

fn array(value: Option<&Value>) -> Vec<Value> {
    value.and_then(Value::as_array).cloned().unwrap_or_default()
}
fn set(node: &Node, key: &str, value: Value) -> Command {
    Command::NodeSet {
        node_id: node.id.clone(),
        properties: Properties::from([(key.into(), value)]),
    }
}
fn replacement_map(node: &Node) -> serde_json::Map<String, Value> {
    node.properties
        .get(SLOT_REPLACEMENTS)
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default()
}
fn owning_component<'a>(snapshot: &'a DocumentSnapshot, frame: &Node) -> Result<&'a Node> {
    let refuse =
        || EngineError::invalid("only a frame inside an editable main component can become a slot");
    if frame.effective_kind() != NodeKind::Frame
        || frame.properties.get("isSection") == Some(&Value::Bool(true))
    {
        return Err(refuse());
    }
    let mut parent = frame.parent_id.as_ref();
    while let Some(id) = parent {
        let node = &snapshot.nodes[id];
        if node.kind == NodeKind::Instance {
            return Err(refuse());
        }
        if node.kind == NodeKind::Component {
            if node.string("libraryId").is_some() {
                return Err(refuse());
            }
            return Ok(node);
        }
        parent = node.parent_id.as_ref();
    }
    Err(refuse())
}
fn main_component<'a>(snapshot: &'a DocumentSnapshot, id: &str) -> Result<&'a Node> {
    let node = snapshot
        .nodes
        .get(id)
        .ok_or_else(|| EngineError::invalid("component is not in this document"))?;
    if node.kind == NodeKind::Component {
        return Ok(node);
    }
    if node.properties.get("isVariantSet") == Some(&Value::Bool(true)) {
        if let Some(component) = children(snapshot, id)
            .into_iter()
            .find(|node| node.kind == NodeKind::Component)
        {
            return Ok(component);
        }
    }
    Err(EngineError::invalid(
        "component must be a component or component set",
    ))
}
fn instance_slot<'a>(
    snapshot: &'a DocumentSnapshot,
    projected: &'a DocumentSnapshot,
    raw: &str,
    name: Option<&str>,
) -> Result<(&'a Node, &'a Node, &'a Node, &'a Node)> {
    let node = projected
        .nodes
        .get(raw)
        .ok_or_else(|| EngineError::invalid("slot target is not on the selected page"))?;
    let slot = if let Some(name) = name {
        if node.kind != NodeKind::Instance {
            return Err(EngineError::invalid("named slot requires an instance"));
        }
        projected.nodes.values().find(|candidate| {
            candidate.string("instanceId") == Some(raw)
                && (candidate.string(SLOT_NAME) == Some(name)
                    || candidate.string(SLOT_ID) == Some(name))
        })
    } else {
        Some(node)
    }
    .filter(|node| node.string(SLOT_ID).is_some())
    .ok_or_else(|| EngineError::invalid("no matching instance slot"))?;
    let projected_instance = slot
        .string("instanceId")
        .and_then(|id| projected.nodes.get(id))
        .filter(|node| node.kind == NodeKind::Instance)
        .ok_or_else(|| EngineError::invalid("choose an editable instance slot"))?;
    let mut anchor = projected_instance;
    while !snapshot.nodes.contains_key(&anchor.id) {
        anchor = anchor
            .string("instanceId")
            .and_then(|id| projected.nodes.get(id))
            .ok_or_else(|| EngineError::invalid("choose an editable instance slot"))?;
    }
    let instance = &snapshot.nodes[&anchor.id];
    let source = slot
        .string("sourceNodeId")
        .and_then(|id| snapshot.nodes.get(id))
        .ok_or_else(|| EngineError::invalid("slot source no longer exists"))?;
    Ok((instance, projected_instance, source, slot))
}
fn reaches_component(snapshot: &DocumentSnapshot, start: &str, target: &str) -> bool {
    let mut pending = vec![start];
    let mut seen = BTreeSet::new();
    while let Some(id) = pending.pop() {
        if id == target {
            return true;
        }
        if !seen.insert(id) {
            continue;
        }
        if let Some(component) = snapshot
            .nodes
            .get(id)
            .and_then(|node| node.string("componentId"))
        {
            pending.push(component);
        }
        pending.extend(
            children(snapshot, id)
                .into_iter()
                .map(|node| node.id.as_str()),
        );
    }
    false
}
