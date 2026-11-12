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
        let mut commands = Vec::new();
        let mut select = None;
        let result = if name.starts_with("component.") {
            let id = self.fig_layer(session, snapshot, target)?;
            let frame = &snapshot.nodes[&id];
            let owner = owning_component(snapshot, frame)?;
            let mut definitions = array(owner.properties.get(DEFINITIONS));
            if name == "component.makeSlot" {
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
                let mut preferred = Vec::new();
                if let Some(items) = params.get("preferred").filter(|value| !value.is_null()) {
                    let items = items
                        .as_array()
                        .filter(|items| items.len() <= 500)
                        .ok_or_else(|| {
                            EngineError::invalid("preferred must contain component or set IDs")
                        })?;
                    for item in items {
                        let raw = self.fig_layer(session, snapshot, item)?;
                        let node = &snapshot.nodes[&raw];
                        if node.kind != NodeKind::Component
                            && node.properties.get("isVariantSet") != Some(&Value::Bool(true))
                        {
                            return Err(EngineError::invalid(
                                "preferred must contain component or set IDs",
                            ));
                        }
                        if !preferred.contains(&raw) {
                            preferred.push(raw);
                        }
                    }
                }
                let property = omc_model::new_id("component_prop");
                definitions.push(json!({"id":property,"name":title,"type":"slot","layer":id,"preferred":preferred}));
                commands.push(Command::NodeSet {
                    node_id: id.clone(),
                    properties: Properties::from([
                        (SLOT_ID.into(), json!(property)),
                        (SLOT_NAME.into(), json!(title)),
                    ]),
                });
                commands.push(set(owner, DEFINITIONS, json!(definitions)));
                json!({"id":target,"name":title,"property":property})
            } else {
                let property = frame
                    .string(SLOT_ID)
                    .ok_or_else(|| EngineError::invalid("frame is not a component slot"))?;
                let title = frame.string(SLOT_NAME).unwrap_or_default();
                definitions.retain(|entry| entry["id"] != property);
                commands.push(set(owner, DEFINITIONS, json!(definitions)));
                commands.push(Command::NodeUnset {
                    node_id: id.clone(),
                    properties: vec![SLOT_ID.into(), SLOT_NAME.into()],
                });
                let contents = snapshot
                    .nodes
                    .values()
                    .filter(|node| node.string(SLOT_CONTENT) == Some(&id))
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
                    replacements.retain(|key, _| key.rsplit('/').next() != Some(&id));
                    if replacements.len() != before {
                        commands.push(set(
                            instance,
                            SLOT_REPLACEMENTS,
                            Value::Object(replacements),
                        ));
                    }
                }
                json!({"id":target,"name":title})
            }
        } else {
            let projected = omc_scene::resolve_components(snapshot, Some(&state.page_id));
            let raw = self.fig_layer(session, &projected.snapshot, target)?;
            let (instance, projected_instance, frame, projected_slot) =
                instance_slot(snapshot, &projected.snapshot, &raw, params["slot"].as_str())?;
            let slot_alias = self.fig_alias(session, &snapshot.id, &projected_slot.id);
            let scope =
                (instance.id != projected_instance.id).then_some(projected_instance.id.as_str());
            let replacement_key =
                scope.map_or_else(|| frame.id.clone(), |scope| format!("{scope}/{}", frame.id));
            let custom = children(snapshot, &instance.id)
                .into_iter()
                .filter(|node| {
                    node.string(SLOT_CONTENT) == Some(&frame.id)
                        && node.string("slotInstanceFor") == scope
                })
                .collect::<Vec<_>>();
            let mut replacements = replacement_map(instance);
            if name == "instance.resetSlot" {
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
                json!({"id":slot_alias,"changed":replaced || !custom.is_empty()})
            } else {
                let component = self.fig_layer(session, snapshot, &params["component"])?;
                let component = main_component(snapshot, &component)?;
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
                        .and_then(|id| projected.snapshot.nodes.get(id));
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
                    children(&projected.snapshot, &projected_slot.id)
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
                let id = self.fig_alias(session, &snapshot.id, &node.id);
                select = Some(json!(id));
                commands.push(Command::NodeCreate { node });
                json!({"id":id,"slot":slot_alias})
            }
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
    let node = &snapshot.nodes[id];
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
    let node = &projected.nodes[raw];
    let slot = if let Some(name) = name {
        if node.kind != NodeKind::Instance {
            return Err(EngineError::invalid("named slot requires an instance"));
        }
        projected.nodes.values().find(|candidate| {
            candidate.string("instanceId") == Some(raw) && candidate.string(SLOT_NAME) == Some(name)
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
