use super::dev_status::{BASELINE, NOTE, STATUS, Tree, can_mark, compared_property};
use super::*;
use std::collections::BTreeMap;

pub(crate) const SNAPSHOT: &str = "devMarkedSnapshot";
const NODE_LIMIT: usize = 1000;
const BYTE_LIMIT: usize = 192 * 1024;
const CHANGE_LIMIT: usize = 1000;

#[derive(serde::Deserialize, serde::Serialize)]
pub(crate) struct Baseline {
    nodes: Vec<Layer>,
    truncated: bool,
}

#[derive(serde::Deserialize, serde::Serialize)]
struct Layer {
    id: String,
    name: String,
    kind: String,
    native_kind: NodeKind,
    rank: String,
    depth: usize,
    index: usize,
    parent: Option<String>,
    properties: BTreeMap<String, Value>,
}

impl Baseline {
    pub(crate) fn build(tree: &Tree, root: &str) -> Self {
        let mut pending = vec![(&tree.nodes[root], 0, 0)];
        let mut nodes = Vec::new();
        let mut bytes = 0;
        let mut truncated = false;
        while let Some((node, depth, index)) = pending.pop() {
            if nodes.len() == NODE_LIMIT {
                truncated = true;
                break;
            }
            let children = tree.children.get(node.id.as_str());
            let layer = Layer {
                id: node.id.clone(),
                name: node.string("name").unwrap_or_default().to_owned(),
                kind: node
                    .string("primitive")
                    .map(str::to_owned)
                    .unwrap_or_else(|| {
                        serde_json::to_value(node.kind)
                            .unwrap()
                            .as_str()
                            .unwrap_or_default()
                            .to_owned()
                    }),
                native_kind: node.kind,
                rank: node.rank.clone(),
                depth,
                index,
                parent: (depth > 0).then(|| node.parent_id.clone()).flatten(),
                properties: node
                    .properties
                    .iter()
                    .filter(|(key, _)| compared_property(key))
                    .map(|(key, value)| (key.clone(), value.clone()))
                    .collect(),
            };
            bytes += serde_json::to_vec(&layer)
                .expect("valid layer properties")
                .len();
            if bytes > BYTE_LIMIT {
                truncated = true;
                break;
            }
            nodes.push(layer);
            if let Some(children) = children {
                pending.extend(
                    children
                        .iter()
                        .enumerate()
                        .rev()
                        .map(|(index, node)| (*node, depth + 1, index)),
                );
            }
        }
        Self { nodes, truncated }
    }

    pub(crate) fn value(self) -> Value {
        json!(self)
    }
}

impl ToolRouter {
    pub fn fig_comparison_images(
        &self,
        session: &str,
        document: &str,
        comparison: &Value,
    ) -> Result<Value> {
        let snapshot = self.workspace.snapshot(document)?;
        let id = self.fig_layer(session, &snapshot, &comparison["id"])?;
        let before = if let Some(version) = comparison["version"]["id"].as_str() {
            let catalog = self.workspace.catalog.lock().unwrap();
            let bytes = catalog.version_bytes(document, version)?;
            drop(catalog);
            let content: DocumentContent = serde_json::from_slice(&bytes)
                .map_err(|error| EngineError::new("corrupt_state", error.to_string()))?;
            Some(DocumentSnapshot {
                nodes: content.nodes,
                pages: content.pages,
                metadata: content.metadata,
                title: content.title,
                ..snapshot.clone()
            })
        } else {
            snapshot.nodes[&id]
                .properties
                .get(SNAPSHOT)
                .cloned()
                .and_then(|value| serde_json::from_value::<Baseline>(value).ok())
                .and_then(|baseline| baseline.snapshot(&snapshot, &id))
        };
        let preview =
            |snapshot: &DocumentSnapshot| self.comparison_image(snapshot, &id).ok().flatten();
        Ok(json!({"before":before.as_ref().and_then(preview),"after":preview(&snapshot)}))
    }

    fn comparison_image(&self, snapshot: &DocumentSnapshot, id: &str) -> Result<Option<String>> {
        let Some(mut node) = snapshot.nodes.get(id) else {
            return Ok(None);
        };
        for _ in 0..512 {
            let Some(parent) = node
                .parent_id
                .as_ref()
                .and_then(|id| snapshot.nodes.get(id))
            else {
                break;
            };
            node = parent;
        }
        let Some(page) = snapshot
            .pages
            .iter()
            .find(|page| page.root_node_id == node.id)
        else {
            return Ok(None);
        };
        let scene = crate::paths::scene(snapshot, &page.id)?;
        let Some([x, y, width, height]) = scene
            .bounds(id)
            .filter(|bounds| bounds[2] > 0. && bounds[3] > 0.)
        else {
            return Ok(None);
        };
        let args = json!({"format":"png","pageId":page.id,"ids":[id],"strict":false,
            "scale":(180. / width.max(height)).min(4.),
            "bounds":{"x":x,"y":y,"width":width,"height":height}});
        let artifact = self.export_snapshot_native(snapshot.clone(), &args)?;
        Ok(Some(
            base64::engine::general_purpose::STANDARD.encode(artifact.bytes),
        ))
    }
}

impl Baseline {
    fn snapshot(&self, live: &DocumentSnapshot, id: &str) -> Option<DocumentSnapshot> {
        if self.truncated || self.nodes.first().is_none_or(|layer| layer.id != id) {
            return None;
        }
        let tree = Tree::new(&live.nodes);
        let mut removed = BTreeSet::new();
        let mut pending = vec![id];
        while let Some(id) = pending.pop() {
            removed.insert(id);
            pending.extend(
                tree.children
                    .get(id)
                    .into_iter()
                    .flatten()
                    .map(|node| node.id.as_str()),
            );
        }
        let anchor = &live.nodes[id];
        let mut snapshot = live.clone();
        snapshot
            .nodes
            .retain(|id, _| !removed.contains(id.as_str()));
        for layer in &self.nodes {
            let mut node = Node::new(layer.native_kind);
            node.id.clone_from(&layer.id);
            node.rank.clone_from(&layer.rank);
            node.parent_id = if layer.depth == 0 {
                anchor.parent_id.clone()
            } else {
                layer.parent.clone()
            };
            node.properties.clone_from(&layer.properties);
            snapshot.nodes.insert(node.id.clone(), node);
        }
        Some(snapshot)
    }
}

pub(super) fn compare(context: &Context) -> Result<Value> {
    let id = context.one()?;
    if !can_mark(context.snapshot, &id) {
        return Err(EngineError::invalid("Choose a top-level frame or section"));
    }
    if context.params["show"] == true {
        return Err(EngineError::invalid(
            "Opening the comparison view requires the desktop editor",
        ));
    }
    let node = &context.snapshot.nodes[&id];
    let current_tree = Tree::new(&context.snapshot.nodes);
    let (baseline, version, changed) = if let Some(version) = context.params.get("version") {
        let version_id = version
            .as_str()
            .filter(|id| !id.is_empty())
            .ok_or_else(|| EngineError::invalid("version must be a version ID"))?;
        let catalog = context.router.workspace.catalog.lock().unwrap();
        let version = catalog
            .versions(&context.snapshot.id)?
            .into_iter()
            .find(|version| version["id"] == version_id)
            .ok_or_else(|| EngineError::new("not_found", "Version was not found"))?;
        let bytes = catalog.version_bytes(&context.snapshot.id, version_id)?;
        drop(catalog);
        let content: DocumentContent = serde_json::from_slice(&bytes)
            .map_err(|error| EngineError::new("corrupt_state", error.to_string()))?;
        let historical = Tree::new(&content.nodes);
        let baseline = content
            .nodes
            .contains_key(&id)
            .then(|| Baseline::build(&historical, &id));
        let changed = baseline.is_none() || historical.hash(&id) != current_tree.hash(&id);
        let baseline = baseline.or(Some(Baseline {
            nodes: Vec::new(),
            truncated: false,
        }));
        let metadata = json!({"id":version_id,"name":version["name"],"time":version.get("createdAt").or_else(|| version.get("time"))});
        (baseline, metadata, changed)
    } else {
        let baseline = node
            .properties
            .get(SNAPSHOT)
            .cloned()
            .and_then(|value| serde_json::from_value(value).ok());
        let changed = node
            .string(BASELINE)
            .is_some_and(|hash| hash != current_tree.hash(&id));
        (baseline.filter(|_| changed), Value::Null, changed)
    };
    let mut result = json!({"id":context.alias(&id),"name":node.string("name").unwrap_or_default(),
        "changed":changed,"snapshot":baseline.is_some(),"version":version,
        "added":0,"removed":0,"modified":0,"truncated":false,"changes":[]});
    if let Some(previous) = baseline {
        let next = Baseline::build(&current_tree, &id);
        result["truncated"] = json!(previous.truncated || next.truncated);
        let prev = previous
            .nodes
            .iter()
            .map(|layer| (&layer.id, layer))
            .collect::<BTreeMap<_, _>>();
        let now = next
            .nodes
            .iter()
            .map(|layer| (&layer.id, layer))
            .collect::<BTreeMap<_, _>>();
        let mut counts = [0; 3];
        let mut changes = Vec::new();
        for layer in &next.nodes {
            if let Some(before) = prev.get(&layer.id) {
                let properties = differences(before, layer);
                if !properties.is_empty() {
                    counts[2] += 1;
                    let mut row = row(context, layer, "changed");
                    row["properties"] = json!(properties);
                    changes.push(row);
                }
            } else if !previous.truncated
                && layer.parent.as_ref().is_none_or(|id| prev.contains_key(id))
            {
                counts[0] += 1;
                changes.push(whole(context, &next, layer, "added"));
            }
        }
        if !next.truncated {
            for layer in previous.nodes.iter().filter(|layer| {
                !now.contains_key(&layer.id)
                    && layer.parent.as_ref().is_none_or(|id| now.contains_key(id))
            }) {
                counts[1] += 1;
                changes.push(whole(context, &previous, layer, "removed"));
            }
        }
        if changes.len() > CHANGE_LIMIT {
            changes.truncate(CHANGE_LIMIT);
            result["truncated"] = json!(true);
        }
        result["added"] = json!(counts[0]);
        result["removed"] = json!(counts[1]);
        result["modified"] = json!(counts[2]);
        result["changes"] = json!(changes);
    }
    Ok(result)
}

fn row(context: &Context, layer: &Layer, change: &str) -> Value {
    json!({"id":context.alias(&layer.id),"name":layer.name,"type":layer.kind,
        "change":change,"depth":layer.depth,"layers":1})
}

fn whole(context: &Context, baseline: &Baseline, layer: &Layer, change: &str) -> Value {
    let count = baseline
        .nodes
        .iter()
        .skip_while(|candidate| candidate.id != layer.id)
        .skip(1)
        .take_while(|candidate| candidate.depth > layer.depth)
        .count()
        + 1;
    let mut change = row(context, layer, change);
    change["layers"] = json!(count);
    change
}

fn differences(before: &Layer, after: &Layer) -> Vec<Value> {
    let mut changes = Vec::new();
    if before.parent != after.parent {
        changes.push(property(
            "parent",
            &json!(before.parent),
            &json!(after.parent),
        ));
    }
    if before.index != after.index && before.parent == after.parent {
        changes.push(property("order", &json!(before.index), &json!(after.index)));
    }
    if before.kind != after.kind {
        changes.push(property("type", &json!(before.kind), &json!(after.kind)));
    }
    for key in before
        .properties
        .keys()
        .chain(after.properties.keys())
        .collect::<BTreeSet<_>>()
    {
        let old = before.properties.get(key).unwrap_or(&Value::Null);
        let new = after.properties.get(key).unwrap_or(&Value::Null);
        if old != new {
            changes.push(property(key, old, new));
        }
    }
    changes
}

fn property(key: &str, before: &Value, after: &Value) -> Value {
    let section = match key {
        "parent" | "order" | "name" | "type" => "Layer",
        "x" | "y" | "rotation" => "Position",
        "width" | "height" | "style" | "layout" | "padding" | "gap" => "Layout",
        "text" | "textRuns" | "fontSize" | "fontFamily" => "Typography",
        "fill" | "fills" => "Fill",
        "stroke" | "strokes" => "Stroke",
        "effects" | "shadows" => "Effects",
        _ => "Appearance",
    };
    let text = |value: &Value| {
        let display = match value {
            Value::Null => "—".into(),
            Value::String(value) => value.clone(),
            Value::Number(value) => value
                .as_f64()
                .map_or_else(|| value.to_string(), |value| value.to_string()),
            _ => value.to_string(),
        };
        let mut chars = display.chars();
        let mut display = chars.by_ref().take(60).collect::<String>();
        if chars.next().is_some() {
            display.push('…');
        }
        display
    };
    let (before, after) = (text(before), text(after));
    json!({"section":section,"property":key,"before":before,"after":after,"text":format!("{key} {before} → {after}")})
}

pub(super) fn resolve(context: &Context) -> Result<Value> {
    let ids = context.many()?;
    let reason = context
        .params
        .get("reason")
        .map(|value| {
            value
                .as_str()
                .filter(|text| text.chars().count() <= 4000)
                .ok_or_else(|| {
                    EngineError::invalid("reason must be a string up to 4000 characters")
                })
        })
        .transpose()?;
    let tree = Tree::new(&context.snapshot.nodes);
    let mut commands = Vec::new();
    let mut resolved = Vec::new();
    for id in ids {
        let node = &context.snapshot.nodes[&id];
        if !can_mark(context.snapshot, &id) || node.string(STATUS) != Some("readyForDev") {
            continue;
        }
        let hash = tree.hash(&id);
        if !node.string(BASELINE).is_some_and(|value| value != hash) {
            continue;
        }
        let mut properties = Properties::from([
            (BASELINE.into(), json!(hash)),
            (SNAPSHOT.into(), Baseline::build(&tree, &id).value()),
        ]);
        if let Some(reason) = reason {
            properties.insert(NOTE.into(), json!(reason));
        }
        resolved.push(context.alias(&id));
        commands.push(Command::NodeSet {
            node_id: id,
            properties,
        });
    }
    context.commit(commands)?;
    Ok(json!({"ids":resolved,"resolved":resolved.len(),"reason":reason}))
}
