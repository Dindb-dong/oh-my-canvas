use omc_model::{DocumentSnapshot, Node, NodeKind};
use omc_style::Diagnostic;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    borrow::Cow,
    collections::{BTreeMap, BTreeSet},
};

pub struct ComponentProjection<'a> {
    pub snapshot: Cow<'a, DocumentSnapshot>,
    pub diagnostics: Vec<Diagnostic>,
}

/// Resolve only instances reachable from the requested page/root. Definitions stay authored;
/// derived descendants have deterministic definition-relative IDs and retain source IDs.
pub fn resolve_components<'a>(
    snapshot: &'a DocumentSnapshot,
    page_or_root: Option<&str>,
) -> ComponentProjection<'a> {
    let root = page_or_root
        .and_then(|id| {
            snapshot
                .pages
                .iter()
                .find(|p| p.id == id)
                .map(|p| p.root_node_id.as_str())
                .or_else(|| snapshot.nodes.get(id).map(|n| n.id.as_str()))
        })
        .or_else(|| snapshot.pages.first().map(|p| p.root_node_id.as_str()));
    let Some(root) = root else {
        return ComponentProjection {
            snapshot: Cow::Borrowed(snapshot),
            diagnostics: Vec::new(),
        };
    };
    let mut children: BTreeMap<&str, Vec<&Node>> = BTreeMap::new();
    for node in snapshot.nodes.values() {
        if let Some(parent) = node.parent_id.as_deref() {
            children.entry(parent).or_default().push(node);
        }
    }
    for values in children.values_mut() {
        values.sort_by(|a, b| a.rank.cmp(&b.rank).then(a.id.cmp(&b.id)));
    }
    let mut pending = vec![(root, None)];
    let mut seen = BTreeSet::new();
    let mut instances = Vec::new();
    let mut bindings = Vec::new();
    while let Some((id, owner)) = pending.pop() {
        if !seen.insert(id) {
            continue;
        }
        let Some(node) = snapshot.nodes.get(id) else {
            continue;
        };
        if node.properties.contains_key("slotContentFor") {
            continue;
        }
        let owner = if node.kind == NodeKind::Component {
            Some(node)
        } else {
            owner
        };
        if let Some(owner) = owner
            && node.properties.contains_key("componentPropertyRefs")
        {
            let mut bound = node.clone();
            apply_bindings(&mut bound, node, owner, None, None);
            if bound.properties != node.properties {
                bindings.push(bound.clone());
            }
            if node.kind == NodeKind::Instance && bound.properties.contains_key("componentId") {
                instances.push(bound);
            }
        } else if node.kind == NodeKind::Instance && node.properties.contains_key("componentId") {
            instances.push(node.clone());
        }
        if let Some(nodes) = children.get(id) {
            pending.extend(nodes.iter().map(|n| (n.id.as_str(), owner)));
        }
    }
    if instances.is_empty() && bindings.is_empty() {
        return ComponentProjection {
            snapshot: Cow::Borrowed(snapshot),
            diagnostics: Vec::new(),
        };
    }
    let mut output = snapshot.clone();
    let mut diagnostics = Vec::new();
    for bound in bindings {
        output.nodes.insert(bound.id.clone(), bound);
    }
    for node in instances {
        expand(
            &node,
            snapshot,
            &children,
            &mut output,
            &mut BTreeSet::new(),
            &mut diagnostics,
            0,
        );
    }
    ComponentProjection {
        snapshot: Cow::Owned(output),
        diagnostics,
    }
}

fn expand(
    instance: &Node,
    source: &DocumentSnapshot,
    children: &BTreeMap<&str, Vec<&Node>>,
    output: &mut DocumentSnapshot,
    stack: &mut BTreeSet<String>,
    diagnostics: &mut Vec<Diagnostic>,
    depth: usize,
) {
    let Some(definition_id) = instance
        .properties
        .get("componentId")
        .and_then(Value::as_str)
    else {
        return;
    };
    let Some(definition) = source
        .nodes
        .get(definition_id)
        .filter(|n| n.kind == NodeKind::Component)
    else {
        diagnostics.push(unresolved(
            &instance.id,
            definition_id,
            "Component definition is unavailable",
        ));
        return;
    };
    if depth > 64 || !stack.insert(definition_id.into()) {
        diagnostics.push(unresolved(
            &instance.id,
            definition_id,
            "Component dependency cycle or depth limit",
        ));
        return;
    }
    let overrides = instance
        .properties
        .get("overrides")
        .and_then(Value::as_object);
    let property_values = instance
        .properties
        .get("componentProperties")
        .or_else(|| instance.properties.get("propertyValues"))
        .and_then(Value::as_object);
    let mut projected = instance.clone();
    let mut properties = definition.properties.clone();
    properties.remove("x");
    properties.remove("y");
    if let Some(root_overrides) = overrides
        .and_then(|o| o.get(definition_id))
        .and_then(Value::as_object)
    {
        apply_overrides(&mut properties, root_overrides);
    }
    properties.extend(instance.properties.clone());
    properties.remove("componentId");
    properties.insert("sourceComponentId".into(), json!(definition_id));
    projected.properties = properties;
    apply_bindings(
        &mut projected,
        definition,
        definition,
        property_values,
        overrides
            .and_then(|rows| rows.get(definition_id))
            .and_then(Value::as_object),
    );
    output.nodes.insert(projected.id.clone(), projected.clone());
    if let Some(nodes) = children.get(instance.id.as_str()) {
        for child in nodes
            .iter()
            .filter(|node| node.properties.contains_key("slotContentFor"))
        {
            output.nodes.remove(&child.id);
        }
    }
    let mut anchor = instance;
    while !source.nodes.contains_key(&anchor.id) {
        let Some(ancestor) = anchor
            .string("instanceId")
            .and_then(|id| output.nodes.get(id))
        else {
            break;
        };
        anchor = ancestor;
    }
    let anchor = (anchor.id != instance.id).then(|| anchor.id.clone());
    let mut pending: Vec<(&Node, String, usize)> = children
        .get(definition_id)
        .into_iter()
        .flatten()
        .filter(|node| !node.properties.contains_key("slotContentFor"))
        .map(|n| (*n, instance.id.clone(), depth + 1))
        .collect();
    while let Some((node, parent, level)) = pending.pop() {
        if level > 256 || output.nodes.len() >= 1_000_000 {
            diagnostics.push(unresolved(
                &instance.id,
                definition_id,
                "Component projection resource limit",
            ));
            break;
        }
        let mut clone = (*node).clone();
        clone.id = derived_id(&instance.id, &node.id);
        clone.parent_id = Some(parent);
        clone.home_shard = instance.home_shard.clone();
        let node_overrides = overrides
            .and_then(|o| o.get(&node.id))
            .and_then(Value::as_object);
        if let Some(overrides) = node_overrides {
            apply_overrides(&mut clone.properties, overrides);
        }
        apply_bindings(
            &mut clone,
            node,
            definition,
            property_values,
            node_overrides,
        );
        clone
            .properties
            .insert("sourceNodeId".into(), json!(node.id));
        clone
            .properties
            .insert("instanceId".into(), json!(instance.id));
        output.nodes.insert(clone.id.clone(), clone.clone());
        if clone.kind == NodeKind::Instance && clone.properties.contains_key("componentId") {
            expand(
                &clone,
                source,
                children,
                output,
                stack,
                diagnostics,
                depth + 1,
            );
        } else {
            let slot = node.properties.get("slotPropertyId").is_some();
            let scoped_replacement = slot
                && anchor.as_ref().is_some_and(|id| {
                    let key = format!("{}/{}", instance.id, node.id);
                    source.nodes[id]
                        .properties
                        .get("slotReplacements")
                        .and_then(|items| items.get(key))
                        == Some(&Value::Bool(true))
                });
            let replace = scoped_replacement
                || (slot
                    && instance
                        .properties
                        .get("slotReplacements")
                        .and_then(|items| items.get(&node.id))
                        == Some(&Value::Bool(true)));
            if !replace {
                if let Some(descendants) = children.get(node.id.as_str()) {
                    pending.extend(
                        descendants
                            .iter()
                            .filter(|child| !child.properties.contains_key("slotContentFor"))
                            .map(|child| (*child, clone.id.clone(), level + 1)),
                    );
                }
            }
            if slot {
                let owner = instance.string("sourceNodeId").unwrap_or(&instance.id);
                let defaults = children
                    .get(owner)
                    .into_iter()
                    .flatten()
                    .filter(|child| {
                        !scoped_replacement && child.string("slotInstanceFor").is_none()
                    })
                    .map(|child| (*child, owner != instance.id));
                let edits = anchor
                    .as_ref()
                    .and_then(|id| children.get(id.as_str()))
                    .into_iter()
                    .flatten()
                    .filter(|child| child.string("slotInstanceFor") == Some(&instance.id))
                    .map(|child| (*child, false));
                for (custom, derive) in defaults
                    .chain(edits)
                    .filter(|(child, _)| child.string("slotContentFor") == Some(&node.id))
                {
                    let mut placed = (*custom).clone();
                    if derive {
                        placed.id = derived_id(&instance.id, &custom.id);
                        placed
                            .properties
                            .insert("sourceNodeId".into(), json!(custom.id));
                    }
                    placed
                        .properties
                        .insert("instanceId".into(), json!(instance.id));
                    placed.parent_id = Some(clone.id.clone());
                    placed.home_shard = instance.home_shard.clone();
                    output.nodes.insert(placed.id.clone(), placed.clone());
                    if placed.kind == NodeKind::Instance {
                        expand(
                            &placed,
                            source,
                            children,
                            output,
                            stack,
                            diagnostics,
                            depth + 1,
                        );
                    }
                }
            }
        }
    }
    stack.remove(definition_id);
}

fn apply_overrides(
    properties: &mut omc_model::Properties,
    overrides: &serde_json::Map<String, Value>,
) {
    for (key, value) in overrides {
        if value.is_null() {
            properties.remove(key);
        } else {
            properties.insert(key.clone(), value.clone());
        }
    }
}

fn apply_bindings(
    node: &mut Node,
    authored: &Node,
    definition: &Node,
    values: Option<&serde_json::Map<String, Value>>,
    overrides: Option<&serde_json::Map<String, Value>>,
) {
    let Some(refs) = authored
        .properties
        .get("componentPropertyRefs")
        .and_then(Value::as_object)
    else {
        return;
    };
    let Some(definitions) = definition
        .properties
        .get("componentPropertyDefinitions")
        .and_then(Value::as_array)
    else {
        return;
    };
    for (field, id) in refs {
        let Some(property) = definitions.iter().find(|property| property["id"] == *id) else {
            continue;
        };
        let explicit = id
            .as_str()
            .and_then(|id| values.and_then(|values| values.get(id)));
        if explicit.is_none()
            && overrides.is_some_and(|overrides| match field.as_str() {
                "visible" => overrides.contains_key("visible") || overrides.contains_key("hidden"),
                "characters" => {
                    overrides.contains_key("text") || overrides.contains_key("textRuns")
                }
                "mainComponent" => overrides.contains_key("componentId"),
                _ => false,
            })
        {
            continue;
        }
        let value = explicit.unwrap_or(&property["default"]);
        match (field.as_str(), property["type"].as_str()) {
            ("visible", Some("boolean")) if value.is_boolean() => {
                node.properties.insert("visible".into(), value.clone());
                node.properties.remove("hidden");
            }
            ("characters", Some("text")) if node.kind == NodeKind::Text && value.is_string() => {
                node.properties.insert("text".into(), value.clone());
                if let Some(runs) = node.properties.get_mut("textRuns") {
                    let attributes = runs[0]["attributes"]
                        .as_object()
                        .cloned()
                        .unwrap_or_default();
                    *runs = if value.as_str() == Some("") {
                        json!([])
                    } else {
                        json!([{"text":value,"attributes":attributes}])
                    };
                }
            }
            ("mainComponent", Some("swap")) if node.kind == NodeKind::Instance => {
                if let Some(id) = value.as_str().filter(|id| !id.is_empty()) {
                    node.properties.insert("componentId".into(), json!(id));
                }
            }
            _ => {}
        }
    }
}

fn derived_id(instance: &str, source: &str) -> String {
    let digest = Sha256::digest(format!("omc.component/1\0{instance}\0{source}").as_bytes());
    format!(
        "node_{}",
        digest[..16]
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>()
    )
}
fn unresolved(id: &str, source: &str, action: &str) -> Diagnostic {
    Diagnostic {
        code: "unresolved_component".into(),
        severity: "error".into(),
        node_id: Some(id.into()),
        property: Some("componentId".into()),
        original: source.into(),
        action: action.into(),
        fidelity_lost: true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use omc_model::DocumentContent;
    #[test]
    fn definition_updates_preserve_override_and_stable_derived_id() {
        let c = DocumentContent::empty("components");
        let mut s = DocumentSnapshot {
            id: "d".into(),
            title: c.title,
            epoch: "e".into(),
            sequence: 0,
            pages: c.pages,
            nodes: c.nodes,
            metadata: c.metadata,
        };
        let root = s.pages[0].root_node_id.clone();
        let mut definition = Node::new(NodeKind::Component);
        definition.parent_id = Some(root.clone());
        let mut child = Node::new(NodeKind::Rect);
        child.parent_id = Some(definition.id.clone());
        child.properties.insert("fill".into(), json!("red"));
        let mut instance = Node::new(NodeKind::Instance);
        instance.parent_id = Some(root);
        instance
            .properties
            .insert("componentId".into(), json!(definition.id));
        instance
            .properties
            .insert("overrides".into(), json!({&child.id:{"width":27}}));
        for node in [definition, child.clone(), instance.clone()] {
            s.nodes.insert(node.id.clone(), node);
        }
        let projected = resolve_components(&s, None);
        let derived = derived_id(&instance.id, &child.id);
        assert_eq!(
            projected.snapshot.nodes[&derived].properties["width"],
            json!(27)
        );
        assert_eq!(
            projected.snapshot.nodes[&derived].properties["fill"],
            json!("red")
        );
        s.nodes
            .get_mut(&child.id)
            .unwrap()
            .properties
            .insert("fill".into(), json!("blue"));
        let next = resolve_components(&s, None);
        assert_eq!(
            next.snapshot.nodes[&derived].properties["fill"],
            json!("blue")
        );
        assert_eq!(next.snapshot.nodes[&derived].properties["width"], json!(27));
        assert!(!s.nodes.contains_key(&derived));
    }
}
