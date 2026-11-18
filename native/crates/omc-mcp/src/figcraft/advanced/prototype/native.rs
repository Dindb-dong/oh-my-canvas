use super::*;
use crate::figcraft::advanced::prototype_actions::{
    click_destination, click_navigation, interaction_commands, native_interactions, stored,
};

impl ToolRouter {
    pub(crate) fn prototype_mutation(
        &self,
        session: &str,
        snapshot: &DocumentSnapshot,
        args: &Value,
    ) -> Result<(Vec<Command>, Properties)> {
        let state = self.state(session, &snapshot.id)?;
        let root = snapshot
            .nodes
            .get(&state.root)
            .ok_or_else(|| EngineError::invalid("Current page is unavailable"))?;
        let resolve = |key| self.resolve(session, &snapshot.id, string(args, key)?);
        let action = string(args, "action")?;
        if !matches!(action, "inspect" | "preview_playback" | "inspect_deck")
            && root.properties.get("locked") == Some(&Value::Bool(true))
        {
            return Err(EngineError::invalid("Page root is locked"));
        }
        let mut result = Properties::from([("pageId".into(), json!(state.page_id))]);
        let commands = match action {
            "inspect_deck" => {
                result.extend(deck::inspect(snapshot, root));
                Vec::new()
            }
            "set_deck" => {
                let (edits, deck) = deck::set(snapshot, root, args, |value| {
                    self.resolve(
                        session,
                        &snapshot.id,
                        value
                            .as_str()
                            .ok_or_else(|| EngineError::invalid("Choose a layer ID"))?,
                    )
                })?;
                result.extend(deck);
                edits
            }
            "preview_playback" => {
                let frame = resolve("frameId")?;
                result.extend(preview::preview(
                    self,
                    session,
                    snapshot,
                    &state.page_id,
                    &root.id,
                    &frame,
                    args,
                )?);
                Vec::new()
            }
            "inspect" => {
                let flows = array(root.properties.get(FLOWS));
                let invalid_starts = flows
                    .iter()
                    .filter_map(|entry| entry["start"].as_str())
                    .filter(|start| !visible_frame(snapshot, &root.id, start))
                    .collect::<Vec<_>>();
                result.insert("invalidStarts".into(), json!(invalid_starts));
                result.insert("flows".into(), json!(flows));
                if args.get("sourceId").is_some() {
                    let source_id = resolve("sourceId")?;
                    frame_owner(snapshot, &root.id, &source_id, false)?;
                    result.insert("sourceId".into(), json!(source_id));
                    result.insert(
                        "interactions".into(),
                        json!(stored(&snapshot.nodes[&source_id])),
                    );
                }
                Vec::new()
            }
            "set_flow" | "remove_flow" => {
                let frame = resolve("frameId")?;
                if action == "set_flow" && !visible_frame(snapshot, &root.id, &frame) {
                    return Err(EngineError::invalid(
                        "A flow starts at a visible top-level frame on the current page",
                    ));
                }
                let original = array(root.properties.get(FLOWS));
                let mut flows = original.clone();
                let index = flows.iter().position(|flow| flow["start"] == frame);
                let output = if action == "remove_flow" {
                    if let Some(index) = index {
                        flows.remove(index);
                    }
                    Value::Null
                } else {
                    let index = match index {
                        Some(index) => index,
                        None => append_flow(&mut flows, &frame, args)?,
                    };
                    update_flow(&mut flows[index], args)?;
                    flows[index].clone()
                };
                result.insert("flow".into(), output);
                if flows == original {
                    Vec::new()
                } else {
                    vec![Command::NodeSet {
                        node_id: root.id.clone(),
                        properties: Properties::from([(FLOWS.into(), json!(flows))]),
                    }]
                }
            }
            "set_interactions" => {
                let source_id = resolve("sourceId")?;
                let owner = frame_owner(snapshot, &root.id, &source_id, true)?;
                if !visible_frame(snapshot, &root.id, owner) {
                    return Err(EngineError::invalid(
                        "Interactions need a visible source frame",
                    ));
                }
                let interactions = native_interactions(
                    snapshot,
                    &root.id,
                    &source_id,
                    &|value| {
                        self.resolve(
                            session,
                            &snapshot.id,
                            value.as_str().ok_or_else(|| {
                                EngineError::invalid("A destination needs a native layer ID")
                            })?,
                        )
                    },
                    &args["interactions"],
                )?;
                let source = &snapshot.nodes[&source_id];
                result.insert("sourceId".into(), json!(source_id));
                result.insert("interactions".into(), json!(interactions));
                if interactions == stored(source) {
                    Vec::new()
                } else {
                    interaction_commands(source, &interactions)
                }
            }
            "set_navigation" | "remove_navigation" => {
                let source_id = resolve("sourceId")?;
                let owner = frame_owner(snapshot, &root.id, &source_id, true)?;
                if !visible_frame(snapshot, &root.id, owner) {
                    return Err(EngineError::invalid(
                        "Navigation must start on a visible top-level frame or its descendant",
                    ));
                }
                let destination = if action == "set_navigation" {
                    let id = resolve("destinationId")?;
                    if id == owner || !visible_frame(snapshot, &root.id, &id) {
                        return Err(EngineError::invalid(
                            "Destination must be a different visible top-level frame on the current page",
                        ));
                    }
                    Some(id)
                } else {
                    None
                };
                let source = &snapshot.nodes[&source_id];
                let commands = set_navigation(source, destination.as_deref())?;
                result.insert("sourceId".into(), json!(source_id));
                result.insert("destinationId".into(), json!(destination));
                commands
            }
            _ => return Err(EngineError::invalid("Unknown native prototype action")),
        };
        Ok((commands, result))
    }
}

pub(super) fn visible_frame(snapshot: &DocumentSnapshot, root: &str, id: &str) -> bool {
    frame_on_page(snapshot, root, id) && !hidden(&snapshot.nodes[id])
}

pub(super) fn hidden(node: &Node) -> bool {
    node.properties.get("hidden") == Some(&Value::Bool(true))
        || node.properties.get("visible") == Some(&Value::Bool(false))
}

fn frame_owner<'a>(
    snapshot: &'a DocumentSnapshot,
    root: &str,
    child: &str,
    writable: bool,
) -> Result<&'a str> {
    let invalid = || EngineError::invalid("Source must belong to the current document and page");
    let mut node = snapshot.nodes.get(child).ok_or_else(invalid)?;
    let mut seen = BTreeSet::new();
    while let Some(parent) = node.parent_id.as_deref() {
        if !seen.insert(&node.id) {
            break;
        }
        if writable && (hidden(node) || node.properties.get("locked") == Some(&Value::Bool(true))) {
            return Err(EngineError::invalid(
                "Source or ancestor is locked or hidden",
            ));
        }
        if parent == root {
            return Ok(&node.id);
        }
        node = snapshot.nodes.get(parent).ok_or_else(invalid)?;
    }
    Err(invalid())
}

fn set_navigation(source: &Node, destination: Option<&str>) -> Result<Vec<Command>> {
    let mut interactions = stored(source);
    let mut on_click = interactions
        .iter()
        .enumerate()
        .filter(|(_, entry)| entry["trigger"]["type"] == "onClick");
    let existing = on_click.next();
    if on_click.next().is_some()
        || existing.is_some_and(|(_, entry)| click_destination(entry).is_none())
    {
        return Err(EngineError::invalid(
            "Source already has advanced click behavior",
        ));
    }
    match (existing, destination) {
        (Some((_, entry)), Some(id)) if click_destination(entry) == Some(id) => return Ok(vec![]),
        (Some((index, _)), Some(id)) => interactions[index] = click_navigation(id),
        (Some((index, _)), None) => {
            interactions.remove(index);
        }
        (None, Some(id)) => {
            if interactions.len() >= 64 {
                return Err(EngineError::invalid("Layer already has 64 interactions"));
            }
            interactions.push(click_navigation(id));
        }
        (None, None) => return Ok(vec![]),
    }
    Ok(interaction_commands(source, &interactions))
}
