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
    let mut pending = vec![root];
    let mut seen = BTreeSet::new();
    let mut instances = Vec::new();
    while let Some(id) = pending.pop() {
        if !seen.insert(id) {
            continue;
        }
        if let Some(node) = snapshot.nodes.get(id) {
            if node.kind == NodeKind::Instance && node.properties.contains_key("componentId") {
                instances.push(node.clone());
            }
        }
        if let Some(nodes) = children.get(id) {
            pending.extend(nodes.iter().map(|n| n.id.as_str()));
        }
    }
    if instances.is_empty() {
        return ComponentProjection {
            snapshot: Cow::Borrowed(snapshot),
            diagnostics: Vec::new(),
        };
    }
    let mut output = snapshot.clone();
    let mut diagnostics = Vec::new();
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
    let mut projected = instance.clone();
    let mut properties = definition.properties.clone();
    properties.remove("x");
    properties.remove("y");
    if let Some(root_overrides) = overrides
        .and_then(|o| o.get(definition_id))
        .and_then(Value::as_object)
    {
        properties.extend(root_overrides.iter().map(|(k, v)| (k.clone(), v.clone())));
    }
    properties.extend(instance.properties.clone());
    properties.remove("componentId");
    properties.insert("sourceComponentId".into(), json!(definition_id));
    projected.properties = properties;
    output.nodes.insert(projected.id.clone(), projected.clone());
    let mut pending: Vec<(&Node, String, usize)> = children
        .get(definition_id)
        .into_iter()
        .flatten()
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
        if let Some(overrides) = overrides
            .and_then(|o| o.get(&node.id))
            .and_then(Value::as_object)
        {
            clone
                .properties
                .extend(overrides.iter().map(|(k, v)| (k.clone(), v.clone())));
        }
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
        } else if let Some(descendants) = children.get(node.id.as_str()) {
            pending.extend(
                descendants
                    .iter()
                    .map(|child| (*child, clone.id.clone(), level + 1)),
            );
        }
    }
    stack.remove(definition_id);
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
