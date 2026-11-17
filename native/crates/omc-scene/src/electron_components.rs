use omc_model::{DocumentSnapshot, Node, electron::COMPONENT_FIELDS};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

/// Electron stores editable copies of instance layers. Project source changes onto those
/// same layers, leaving the imported appearance and local edits in the authored document.
pub(super) fn project(snapshot: &DocumentSnapshot) -> Option<DocumentSnapshot> {
    let mut cache = BTreeMap::new();
    let mut visiting = BTreeSet::new();
    for node in snapshot
        .nodes
        .values()
        .filter(|node| node.properties.contains_key("electronComponentLink"))
    {
        resolve(node, snapshot, &mut visiting, &mut cache);
    }
    if !cache.is_empty() {
        project_children(snapshot, &mut cache);
    }
    cache.retain(|id, projected| snapshot.nodes.get(id) != Some(projected));
    if cache.is_empty() {
        return None;
    }
    let mut result = snapshot.clone();
    result.nodes.extend(cache);
    Some(result)
}

fn project_children(snapshot: &DocumentSnapshot, cache: &mut BTreeMap<String, Node>) {
    let mut children: BTreeMap<&str, Vec<&Node>> = BTreeMap::new();
    for child in snapshot.nodes.values() {
        if let Some(parent) = child.parent_id.as_deref() {
            children.entry(parent).or_default().push(child);
        }
    }
    let children_of = |id: &str| children.get(id).map(Vec::as_slice).unwrap_or_default();
    for node in snapshot.nodes.values() {
        let Some(link) = node.properties.get("electronComponentLink") else {
            continue;
        };
        let Some(source) = link["nodeId"]
            .as_str()
            .filter(|id| snapshot.nodes.contains_key(*id))
        else {
            continue;
        };
        let Some(baseline) = link["sourceChildren"].as_array() else {
            continue;
        };
        let before: BTreeSet<_> = baseline.iter().filter_map(Value::as_str).collect();
        let now = children_of(source);
        let is_current = |id: &str| now.iter().any(|child| child.id == id);
        let local = children_of(&node.id);
        let local_link = |child: &&Node| {
            child
                .properties
                .get("electronComponentLink")
                .and_then(|link| link["nodeId"].as_str())
                .map(str::to_owned)
        };
        for child in local {
            if local_link(child).is_some_and(|id| before.contains(id.as_str()) && !is_current(&id))
                && let Some(rendered) = cache.get_mut(&child.id)
            {
                rendered
                    .properties
                    .insert("visible".into(), Value::Bool(false));
            }
        }
        let local_sources: BTreeSet<_> = local.iter().filter_map(local_link).collect();
        let mut pending: Vec<_> = now
            .iter()
            .filter(|child| {
                !before.contains(child.id.as_str()) && !local_sources.contains(&child.id)
            })
            .map(|child| (*child, node.id.clone(), 0))
            .collect();
        while let Some((child, parent, depth)) = pending.pop() {
            if depth >= 64 || cache.len() >= 100_000 {
                break;
            }
            let id = super::components::derived_id(&parent, &child.id);
            if cache.contains_key(&id) || snapshot.nodes.contains_key(&id) {
                continue;
            }
            let mut derived = child.clone();
            derived.id = id.clone();
            derived.parent_id = Some(parent);
            derived.home_shard = node.home_shard.clone();
            derived
                .properties
                .insert("sourceNodeId".into(), Value::String(child.id.clone()));
            cache.insert(id.clone(), derived);
            pending.extend(
                children_of(&child.id)
                    .iter()
                    .map(|child| (*child, id.clone(), depth + 1)),
            );
        }
    }
}

fn resolve(
    node: &Node,
    snapshot: &DocumentSnapshot,
    visiting: &mut BTreeSet<String>,
    cache: &mut BTreeMap<String, Node>,
) {
    if cache.contains_key(&node.id) || visiting.len() >= 64 || !visiting.insert(node.id.clone()) {
        return;
    }
    let mut projected = node.clone();
    let link = node
        .properties
        .get("electronComponentLink")
        .unwrap_or(&Value::Null);
    if let Some(source) = link["nodeId"]
        .as_str()
        .and_then(|id| snapshot.nodes.get(id))
        && !visiting.contains(&source.id)
        && let Some(fields) = link["fields"].as_object()
    {
        if source.properties.contains_key("electronComponentLink") {
            resolve(source, snapshot, visiting, cache);
        }
        let source = cache.get(&source.id).unwrap_or(source);
        for field in COMPONENT_FIELDS {
            let Some(pair) = fields
                .get(*field)
                .and_then(Value::as_array)
                .filter(|values| values.len() == 2)
            else {
                continue;
            };
            let current = source.properties.get(*field).unwrap_or(&Value::Null);
            let local = node.properties.get(*field).unwrap_or(&Value::Null);
            if current != &pair[0] && local == &pair[1] {
                if current.is_null() {
                    projected.properties.remove(*field);
                } else {
                    let mut value = current.clone();
                    if *field == "electronLayout" && value.is_object() && local.is_object() {
                        value["original"] = local["original"].clone();
                    }
                    projected.properties.insert((*field).into(), value);
                }
            }
        }
    }
    apply_local_values(snapshot, node, &mut projected);
    visiting.remove(&node.id);
    cache.insert(node.id.clone(), projected);
}

fn apply_local_values(snapshot: &DocumentSnapshot, node: &Node, projected: &mut Node) {
    let Some(refs) = node
        .properties
        .get("componentPropertyRefs")
        .and_then(Value::as_object)
    else {
        return;
    };
    let root = std::iter::successors(Some(node), |current| {
        current
            .parent_id
            .as_ref()
            .and_then(|id| snapshot.nodes.get(id))
    })
    .take(65)
    .find(|candidate| {
        candidate
            .properties
            .get("electronComponentLink")
            .is_some_and(|value| value["root"] == true)
    });
    let Some(root) = root else { return };
    let link = &root.properties["electronComponentLink"];
    let Some(values) = root
        .properties
        .get("componentProperties")
        .and_then(Value::as_object)
    else {
        return;
    };
    let Some(definition) = link["nodeId"]
        .as_str()
        .and_then(|id| snapshot.nodes.get(id))
    else {
        return;
    };
    let active: serde_json::Map<_, _> = refs
        .iter()
        .filter(|(_, id)| {
            id.as_str().is_some_and(|id| {
                values
                    .get(id)
                    .is_some_and(|current| current != &link["propertyValues"][id])
            })
        })
        .map(|(field, id)| (field.clone(), id.clone()))
        .collect();
    if active.is_empty() {
        return;
    }
    let mut authored = node.clone();
    authored
        .properties
        .insert("componentPropertyRefs".into(), Value::Object(active));
    super::components::apply_bindings(projected, &authored, definition, Some(values), None);
}

#[cfg(test)]
mod tests {
    use super::*;
    use omc_model::{DocumentContent, NodeKind, electron::component_link};
    use serde_json::json;

    #[test]
    fn imported_component_keeps_baseline_and_propagates_source_edits_without_replacing_ids() {
        let mut doc = DocumentContent::empty("Linked layers");
        let mut source = Node::new(NodeKind::Rect);
        source.properties.insert("fill".into(), json!("#ff0000"));
        source.properties.insert("width".into(), json!(50));
        source.properties.insert(
            "electronLayout".into(),
            json!({"layout":{"padding":0},"original":{"width":50}}),
        );
        let mut instance = Node::new(NodeKind::Rect);
        instance.properties.insert(
            "electronLayout".into(),
            json!({"layout":{"padding":0},"original":{"width":55}}),
        );
        instance.properties.insert("fill".into(), json!("#ff0000"));
        instance.properties.insert("width".into(), json!(55));
        let link = component_link(&source, &instance, &json!(["width"]), false);
        instance
            .properties
            .insert("electronComponentLink".into(), link);
        let source_id = source.id.clone();
        let instance_id = instance.id.clone();
        doc.nodes.insert(source_id.clone(), source);
        doc.nodes.insert(instance_id.clone(), instance);
        let mut snapshot = DocumentSnapshot {
            id: "doc".into(),
            epoch: "epoch".into(),
            sequence: 0,
            title: doc.title,
            pages: doc.pages,
            nodes: doc.nodes,
            metadata: doc.metadata,
        };
        assert!(project(&snapshot).is_none());
        snapshot
            .nodes
            .get_mut(&source_id)
            .unwrap()
            .properties
            .extend([
                ("fill".into(), json!("#0000ff")),
                ("width".into(), json!(70)),
            ]);
        let rendered = project(&snapshot).unwrap();
        let projected = &rendered.nodes[&instance_id];
        assert_eq!(projected.properties["fill"], "#0000ff");
        assert_eq!(projected.properties["width"], 55);
        assert_eq!(snapshot.nodes[&instance_id].properties["fill"], "#ff0000");
        snapshot
            .nodes
            .get_mut(&instance_id)
            .unwrap()
            .properties
            .insert("fill".into(), json!("#00ff00"));
        assert!(project(&snapshot).is_none());
        snapshot
            .nodes
            .get_mut(&source_id)
            .unwrap()
            .properties
            .get_mut("electronLayout")
            .unwrap()["layout"]["padding"] = json!(20);
        let rendered = project(&snapshot).unwrap();
        assert_eq!(
            rendered.nodes[&instance_id].properties["electronLayout"],
            json!({
                "layout":{"padding":20},"original":{"width":55}
            })
        );
    }
    #[test]
    fn component_structure_reflows_through_preserved_instance_tree() {
        let doc = DocumentContent::empty("Structural linkage");
        let source = Node::new(NodeKind::Frame);
        let mut source_child = Node::new(NodeKind::Rect);
        source_child.parent_id = Some(source.id.clone());
        let mut copy = Node::new(NodeKind::Frame);
        let mut copy_child = Node::new(NodeKind::Rect);
        copy_child.parent_id = Some(copy.id.clone());
        let mut link = component_link(&source, &copy, &Value::Null, true);
        link["sourceChildren"] = json!([source_child.id]);
        copy.properties.insert("electronComponentLink".into(), link);
        let link = component_link(&source_child, &copy_child, &Value::Null, false);
        copy_child
            .properties
            .insert("electronComponentLink".into(), link);
        let mut snapshot = DocumentSnapshot {
            id: "doc".into(),
            epoch: "epoch".into(),
            sequence: 0,
            title: doc.title,
            pages: doc.pages,
            nodes: doc.nodes,
            metadata: doc.metadata,
        };
        for node in [&source, &source_child, &copy, &copy_child] {
            snapshot.nodes.insert(node.id.clone(), node.clone());
        }
        assert!(project(&snapshot).is_none());
        snapshot.nodes.remove(&source_child.id);
        let mut added = Node::new(NodeKind::Rect);
        added.parent_id = Some(source.id.clone());
        snapshot.nodes.insert(added.id.clone(), added.clone());
        let projection = project(&snapshot).unwrap();
        assert_eq!(
            projection.nodes[&copy_child.id].properties["visible"],
            false
        );
        let new_id = crate::components::derived_id(&copy.id, &added.id);
        assert_eq!(
            projection.nodes[&new_id].parent_id.as_deref(),
            Some(copy.id.as_str())
        );
        assert!(!snapshot.nodes.contains_key(&new_id));
    }
}
