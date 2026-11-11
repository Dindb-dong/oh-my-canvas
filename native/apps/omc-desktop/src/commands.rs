//! UI gestures prepare protocol commands; the service owns validation and commits.
use omc_model::{DocumentSnapshot, Node, NodeKind, new_id, rank_between};
use serde_json::{Value, json};
use std::collections::BTreeSet;

fn number(node: &Node, key: &str, fallback: f64) -> f64 {
    node.properties
        .get(key)
        .and_then(Value::as_f64)
        .unwrap_or(fallback)
}
fn siblings<'a>(document: &'a DocumentSnapshot, parent: &str) -> Vec<&'a Node> {
    let mut nodes: Vec<_> = document
        .nodes
        .values()
        .filter(|n| n.parent_id.as_deref() == Some(parent))
        .collect();
    nodes.sort_by(|a, b| a.rank.cmp(&b.rank).then(a.id.cmp(&b.id)));
    nodes
}
pub fn append_rank(
    document: &DocumentSnapshot,
    parent: &str,
) -> Result<(Vec<Value>, String), String> {
    let nodes = siblings(document, parent);
    if let Some(rank) = rank_between(nodes.last().map(|n| n.rank.as_str()), None) {
        return Ok((vec![], rank));
    }
    let spacing = u128::MAX / (nodes.len() as u128 + 2);
    let last = format!("{:032x}", spacing * nodes.len() as u128);
    let rank = rank_between(Some(&last), None).ok_or("No layer-order capacity is available.")?;
    Ok((
        vec![json!({"type":"node.rebalance","parentId":parent})],
        rank,
    ))
}

pub fn reorder(document: &DocumentSnapshot, id: &str, forward: bool) -> Result<Value, String> {
    let node = document.nodes.get(id).ok_or("Select a layer first.")?;
    let parent = node
        .parent_id
        .as_deref()
        .ok_or("The page root cannot be reordered.")?;
    let nodes = siblings(document, parent);
    let index = nodes
        .iter()
        .position(|n| n.id == id)
        .ok_or("The selected layer is unavailable.")?;
    if (forward && index + 1 == nodes.len()) || (!forward && index == 0) {
        return Err("The layer is already at the end of this stack.".into());
    }
    let (left, right) = if forward {
        (
            Some(nodes[index + 1].rank.as_str()),
            nodes.get(index + 2).map(|n| n.rank.as_str()),
        )
    } else {
        (
            index.checked_sub(2).map(|i| nodes[i].rank.as_str()),
            Some(nodes[index - 1].rank.as_str()),
        )
    };
    if let Some(rank) = rank_between(left, right) {
        return Ok(json!({"type":"node.move","nodeId":id,"parentId":parent,"rank":rank}));
    }
    let spacing = u128::MAX / (nodes.len() as u128 + 2);
    let (left, right) = if forward {
        (
            spacing * (index as u128 + 2),
            if index + 2 < nodes.len() {
                spacing * (index as u128 + 3)
            } else {
                u128::MAX
            },
        )
    } else {
        (
            if index >= 2 {
                spacing * (index as u128 - 1)
            } else {
                0
            },
            spacing * index as u128,
        )
    };
    let rank = format!("{:032x}", left + (right - left) / 2);
    Ok(
        json!({"type":"batch","commands":[{"type":"node.rebalance","parentId":parent},{"type":"node.move","nodeId":id,"parentId":parent,"rank":rank}]}),
    )
}

pub fn wrap(
    document: &DocumentSnapshot,
    selection: &BTreeSet<String>,
    component: bool,
) -> Result<(Value, String), String> {
    let nodes: Vec<_> = selection
        .iter()
        .filter_map(|id| document.nodes.get(id))
        .filter(|node| {
            !node
                .parent_id
                .as_ref()
                .is_some_and(|p| selection.contains(p))
        })
        .collect();
    if nodes.is_empty() || nodes.len() > 500 {
        return Err("Select between 1 and 500 sibling layers to group.".into());
    }
    let parent = nodes[0]
        .parent_id
        .as_deref()
        .ok_or("Page roots cannot be grouped.")?;
    if nodes
        .iter()
        .any(|node| node.parent_id.as_deref() != Some(parent))
    {
        return Err("Group layers that share the same parent.".into());
    }
    let x = nodes
        .iter()
        .map(|n| number(n, "x", 0.))
        .fold(f64::INFINITY, f64::min);
    let y = nodes
        .iter()
        .map(|n| number(n, "y", 0.))
        .fold(f64::INFINITY, f64::min);
    let right = nodes
        .iter()
        .map(|n| number(n, "x", 0.) + number(n, "width", 100.))
        .fold(f64::NEG_INFINITY, f64::max);
    let bottom = nodes
        .iter()
        .map(|n| number(n, "y", 0.) + number(n, "height", 100.))
        .fold(f64::NEG_INFINITY, f64::max);
    let mut group = Node::new(if component {
        NodeKind::Component
    } else {
        NodeKind::Group
    });
    group.parent_id = Some(parent.into());
    group.rank = nodes
        .iter()
        .map(|n| n.rank.clone())
        .min()
        .unwrap_or_else(omc_model::initial_rank);
    group.properties=serde_json::from_value(json!({"name":if component{"Component"}else{"Group"},"x":x,"y":y,"width":(right-x).max(1.),"height":(bottom-y).max(1.)})).map_err(|e|e.to_string())?;
    let id = group.id.clone();
    let mut commands = vec![json!({"type":"node.create","node":group})];
    for node in nodes {
        commands.push(json!({"type":"node.move","nodeId":node.id,"parentId":id,"rank":node.rank}));
        commands.push(json!({"type":"node.set","nodeId":node.id,"properties":{"x":number(node,"x",0.)-x,"y":number(node,"y",0.)-y}}));
    }
    Ok((json!({"type":"batch","commands":commands}), id))
}

pub fn ungroup(document: &DocumentSnapshot, id: &str) -> Result<Value, String> {
    let node = document.nodes.get(id).ok_or("Select a group first.")?;
    if node.kind != NodeKind::Group {
        return Err("Select a group. Component definitions must retain their identity.".into());
    }
    if number(node, "rotation", 0.) != 0. || node.properties.contains_key("transform") {
        return Err("Reset the group's transform before ungrouping in this preview.".into());
    }
    let parent = node
        .parent_id
        .as_deref()
        .ok_or("A page root cannot be ungrouped.")?;
    let children = siblings(document, id);
    if children.len() > 500 {
        return Err(
            "Ungrouping more than 500 direct children requires a larger operation budget.".into(),
        );
    }
    let mut commands = vec![];
    for child in children {
        commands.push(
            json!({"type":"node.move","nodeId":child.id,"parentId":parent,"rank":child.rank}),
        );
        commands.push(json!({"type":"node.set","nodeId":child.id,"properties":{"x":number(child,"x",0.)+number(node,"x",0.),"y":number(child,"y",0.)+number(node,"y",0.)}}));
    }
    commands.push(json!({"type":"node.delete","nodeIds":[id]}));
    Ok(json!({"type":"batch","commands":commands}))
}

pub fn instance(document: &DocumentSnapshot, id: &str) -> Result<(Value, String), String> {
    let definition = document
        .nodes
        .get(id)
        .filter(|n| n.kind == NodeKind::Component)
        .ok_or("Select a component definition to add an instance.")?;
    let parent = definition
        .parent_id
        .as_deref()
        .ok_or("The component has no page.")?;
    let (mut commands, rank) = append_rank(document, parent)?;
    let mut instance = Node::new(NodeKind::Instance);
    instance.parent_id = Some(parent.into());
    instance.rank = rank;
    instance.properties=serde_json::from_value(json!({"name":"Instance","componentId":id,"x":number(definition,"x",0.)+number(definition,"width",100.)+24.,"y":number(definition,"y",0.)})).map_err(|e|e.to_string())?;
    let id = instance.id.clone();
    commands.push(json!({"type":"node.create","node":instance}));
    Ok((json!({"type":"batch","commands":commands}), id))
}

pub fn detach(document: &DocumentSnapshot, id: &str) -> Result<Value, String> {
    let instance = document
        .nodes
        .get(id)
        .filter(|n| n.kind == NodeKind::Instance)
        .ok_or("Select an instance to detach.")?;
    let projection = omc_scene::resolve_components(document, Some(id));
    if !projection.diagnostics.is_empty() {
        return Err("The component definition must be available before detaching.".into());
    }
    let root = projection
        .snapshot
        .nodes
        .get(id)
        .ok_or("The instance cannot be resolved.")?;
    let mut properties = root.properties.clone();
    properties.remove("componentId");
    properties.remove("overrides");
    properties.remove("sourceComponentId");
    let mut commands = vec![
        json!({"type":"node.set","nodeId":instance.id,"properties":properties}),
        json!({"type":"node.unset","nodeId":instance.id,"properties":["componentId","overrides"]}),
    ];
    let mut created = BTreeSet::from([id.to_owned()]);
    let mut remaining: Vec<_> = projection
        .snapshot
        .nodes
        .values()
        .filter(|n| !document.nodes.contains_key(&n.id))
        .cloned()
        .collect();
    if remaining.len() > 1000 {
        return Err("This preview detaches at most 1,000 component descendants per action.".into());
    }
    while !remaining.is_empty() {
        let before = remaining.len();
        let mut deferred = vec![];
        for mut node in remaining {
            if node.parent_id.as_ref().is_some_and(|p| created.contains(p)) {
                node.properties.remove("sourceNodeId");
                node.properties.remove("instanceId");
                node.properties.remove("sourceComponentId");
                created.insert(node.id.clone());
                commands.push(json!({"type":"node.create","node":node}));
            } else {
                deferred.push(node);
            }
        }
        if deferred.len() == before {
            return Err("The component descendants could not be ordered.".into());
        }
        remaining = deferred;
    }
    Ok(json!({"type":"batch","commands":commands}))
}

pub fn new_page(document: &DocumentSnapshot) -> Value {
    let mut root = Node::new(NodeKind::Frame);
    root.properties =
        serde_json::from_value(json!({"name":"Page","width":1600,"height":1000,"fill":"#ffffff"}))
            .unwrap_or_default();
    let mut page = omc_model::Page::new(
        format!("Page {}", document.pages.len() + 1),
        root.id.clone(),
    );
    page.rank = rank_between(document.pages.iter().map(|p| p.rank.as_str()).max(), None)
        .unwrap_or_else(omc_model::initial_rank);
    json!({"type":"page.create","page":page,"root":root})
}

pub fn create_catalog(namespace: &str, value: Value, count: usize) -> Value {
    json!({"type":"catalog.set","namespace":namespace,"entityId":new_id(if namespace=="tokens"{"token"}else{"style"}),"properties":{"name":format!("Color {}",count+1),"type":"fill","value":value}})
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn group_preserves_children_parent_coordinates() {
        let content = omc_model::DocumentContent::empty("Group test");
        let mut document = DocumentSnapshot {
            id: "d".into(),
            title: content.title,
            epoch: "e".into(),
            sequence: 0,
            pages: content.pages,
            nodes: content.nodes,
            metadata: content.metadata,
        };
        let parent = document.pages[0].root_node_id.clone();
        let mut ids = BTreeSet::new();
        for (x, y) in [(42., 35.), (120., 78.)] {
            let mut node = Node::new(NodeKind::Rect);
            node.parent_id = Some(parent.clone());
            node.properties =
                serde_json::from_value(json!({"x":x,"y":y,"width":30.,"height":20.})).unwrap();
            ids.insert(node.id.clone());
            document.nodes.insert(node.id.clone(), node);
        }
        let (command, _) = wrap(&document, &ids, false).unwrap();
        let commands = command["commands"].as_array().unwrap();
        let group = &commands[0]["node"]["properties"];
        for command in commands.iter().filter(|c| c["type"] == "node.set") {
            let original = &document.nodes[command["nodeId"].as_str().unwrap()];
            assert_eq!(
                group["x"].as_f64().unwrap() + command["properties"]["x"].as_f64().unwrap(),
                number(original, "x", 0.)
            );
            assert_eq!(
                group["y"].as_f64().unwrap() + command["properties"]["y"].as_f64().unwrap(),
                number(original, "y", 0.)
            );
        }
    }
}
