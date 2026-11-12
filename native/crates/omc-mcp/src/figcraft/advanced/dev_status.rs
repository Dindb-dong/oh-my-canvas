use super::*;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

pub(crate) const STATUS: &str = "devStatus";
pub(crate) const BASELINE: &str = "devMarkedContent";
pub(crate) const NOTE: &str = "devStatusNote";
pub(crate) const ARCHIVE_CHANGED: &str = "changed-in-archive";

pub(crate) fn parse(value: &Value) -> Result<Value> {
    if value.is_null() || value == "none" {
        return Ok(Value::Null);
    }
    let status = ["readyForDev", "completed"]
        .into_iter()
        .find(|status| {
            value
                .as_str()
                .is_some_and(|v| status.eq_ignore_ascii_case(v))
        })
        .ok_or_else(|| EngineError::invalid("devStatus must be readyForDev, completed or none"))?;
    Ok(json!(status))
}

fn is_section(node: &Node) -> bool {
    node.string("primitive") == Some("section")
}

pub(crate) fn can_mark(snapshot: &DocumentSnapshot, id: &str) -> bool {
    let node = &snapshot.nodes[id];
    is_section(node)
        || matches!(node.kind, NodeKind::Frame | NodeKind::Component)
            && node
                .parent_id
                .as_ref()
                .and_then(|id| snapshot.nodes.get(id))
                .is_some_and(|parent| parent.parent_id.is_none() || is_section(parent))
}

pub(crate) struct Tree<'a> {
    pub(super) nodes: &'a BTreeMap<String, Node>,
    pub(super) children: BTreeMap<&'a str, Vec<&'a Node>>,
}

impl<'a> Tree<'a> {
    pub(crate) fn new(nodes: &'a BTreeMap<String, Node>) -> Self {
        let mut children = BTreeMap::<&str, Vec<&Node>>::new();
        for node in nodes.values() {
            if let Some(parent) = &node.parent_id {
                children.entry(parent).or_default().push(node);
            }
        }
        for kids in children.values_mut() {
            kids.sort_by(|a, b| (&a.rank, &a.id).cmp(&(&b.rank, &b.id)));
        }
        Self { nodes, children }
    }

    pub(crate) fn hash(&self, root: &str) -> String {
        let mut hash = Sha256::new();
        let mut stack = vec![&self.nodes[root]];
        while let Some(node) = stack.pop() {
            let kids = self.children.get(node.id.as_str());
            let properties = node
                .properties
                .iter()
                .filter(|(key, _)| compared_property(key))
                .collect::<BTreeMap<_, _>>();
            let payload = (&node.id, node.kind, kids.map_or(0, Vec::len), properties);
            let data = serde_json::to_vec(&payload).expect("validated node properties");
            hash.update((data.len() as u64).to_le_bytes());
            hash.update(data);
            stack.extend(kids.into_iter().flatten().rev().copied());
        }
        hex::encode(hash.finalize())
    }
}

pub(super) fn compared_property(key: &str) -> bool {
    !matches!(
        key,
        STATUS
            | BASELINE
            | NOTE
            | super::dev_diff::SNAPSHOT
            | "annotations"
            | "devResources"
            | "codeLinks"
    )
}

pub(super) fn ready(context: &Context) -> Result<Value> {
    let wanted = context
        .params
        .get("status")
        .map(|value| {
            value
                .as_str()
                .ok_or_else(|| EngineError::invalid("status must be a string"))
        })
        .transpose()?
        .unwrap_or("readyForDev")
        .to_ascii_lowercase();
    if !matches!(
        wanted.as_str(),
        "readyfordev" | "changed" | "completed" | "any" | "all"
    ) {
        return Err(EngineError::invalid(
            "status must be readyForDev, changed, completed or any",
        ));
    }
    let selected = context
        .params
        .get("page")
        .map(|value| {
            let id = context.resolve(value)?;
            context
                .snapshot
                .pages
                .iter()
                .any(|page| page.root_node_id == id)
                .then_some(id)
                .ok_or_else(|| EngineError::invalid("page must be a page id"))
        })
        .transpose()?;
    let tree = Tree::new(&context.snapshot.nodes);
    let mut items = Vec::new();
    for page in &context.snapshot.pages {
        if selected.as_ref().is_some_and(|id| id != &page.root_node_id) {
            continue;
        }
        let mut stack = vec![&context.snapshot.nodes[&page.root_node_id]];
        while let Some(node) = stack.pop() {
            if let Some(status) = node
                .string(STATUS)
                .filter(|_| can_mark(context.snapshot, &node.id))
            {
                let ready = status == "readyForDev";
                let matches = match wanted.as_str() {
                    "readyfordev" | "changed" => ready,
                    "completed" => status == "completed",
                    _ => true,
                };
                if matches {
                    let changed = ready
                        && node
                            .string(BASELINE)
                            .is_some_and(|baseline| baseline != tree.hash(&node.id));
                    if wanted != "changed" || changed {
                        items.push(json!({
                            "id":context.alias(&node.id),
                            "name":node.string("name").unwrap_or_default(),
                            "page":context.alias(&page.root_node_id),
                            "status":status,
                            "changed":changed,
                        }));
                        if items.len() >= 5000 {
                            return Ok(json!({"items":items}));
                        }
                    }
                }
            }
            stack.extend(
                tree.children
                    .get(node.id.as_str())
                    .into_iter()
                    .flatten()
                    .rev()
                    .copied(),
            );
        }
    }
    Ok(json!({"items":items}))
}
