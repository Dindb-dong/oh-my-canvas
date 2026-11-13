use super::*;
use omc_model::new_id;
use omc_scene::Affine;
use std::collections::BTreeSet;

pub(super) const COMMANDS: &[(&str, &str, bool, &str)] = &[
    ("edit.copy", "Copy", false, "ids?"),
    ("edit.cut", "Cut", true, "ids?"),
    ("edit.paste", "Paste", true, "parent?, x?, y?"),
    (
        "edit.pasteDesignLayers",
        "Paste design layers",
        true,
        "html | data, parent?, x?, y?",
    ),
    ("edit.pasteOver", "Paste over selection", true, ""),
    ("edit.pasteReplace", "Paste to replace", true, "ids?"),
    ("edit.copyProperties", "Copy properties", false, "id?"),
    ("edit.pasteProperties", "Paste properties", true, "ids?"),
];

#[derive(Default)]
pub(crate) struct Clipboard {
    layers: Option<LayerCopy>,
    props: Option<Properties>,
}

#[derive(Clone)]
struct LayerCopy {
    source: String,
    cut: bool,
    roots: Vec<ClipRoot>,
    bounds: [f64; 4],
}

#[derive(Clone)]
struct ClipRoot {
    nodes: Vec<Node>,
    world: Affine,
}


impl ToolRouter {
    pub(super) fn fig_clipboard_command(
        &self,
        session: &str,
        snapshot: &DocumentSnapshot,
        state: &ViewState,
        selection: &[Value],
        name: &str,
        params: &Value,
    ) -> Result<Value> {
        let id = &snapshot.id;
        let valid_id = json!({"type":"integer","minimum":1});
        let ids_type = json!({"type":"array","maxItems":200,"items":valid_id});
        let fields = match name {
            "edit.copy" | "edit.cut" | "edit.pasteReplace" | "edit.pasteProperties" => {
                json!({"ids":ids_type})
            }
            "edit.copyProperties" => json!({"id":valid_id}),
            "edit.paste" => json!({"parent":valid_id,"x":{"type":"number"},"y":{"type":"number"}}),
            "edit.pasteDesignLayers" => {
                json!({"parent":valid_id,"x":{"type":"number"},"y":{"type":"number"},"html":{"type":"string"},"data":{"type":"string"}})
            }
            _ => json!({}),
        };
        schema::check(
            &json!({"type":"object","properties":fields,"additionalProperties":false}),
            params,
            "params",
        )?;
        let raw = self.fig_layers(session, snapshot, fig_ids(params, selection)?)?;
        let key = (session.into(), id.clone());
        let mut commands = Vec::new();
        if name == "edit.copyProperties" {
            let chosen = if let Some(value) = params.get("id") {
                self.fig_layer(session, snapshot, value)?
            } else {
                raw.first()
                    .ok_or_else(|| EngineError::invalid("select a layer to copy its properties"))?
                    .clone()
            };
            let node = &snapshot.nodes[&chosen];
            if node.parent_id.is_none() {
                return Err(EngineError::invalid("a page is not a layer"));
            }
            let props = omc_style::copy_appearance_keys(node)
                .filter_map(|key| {
                    node.properties
                        .get(key)
                        .map(|value| (key.into(), value.clone()))
                })
                .collect::<Properties>();
            self.fig_clipboards
                .lock()
                .unwrap()
                .entry(session.into())
                .or_default()
                .props = Some(props.clone());
            return Ok(json!(props));
        }
        if name == "edit.pasteProperties" {
            let props = self
                .fig_clipboards
                .lock()
                .unwrap()
                .get(session)
                .and_then(|clip| clip.props.clone())
                .ok_or_else(|| EngineError::invalid("no copied properties"))?;
            if raw.is_empty() {
                return Err(EngineError::invalid(
                    "select layers to apply the copied properties",
                ));
            }
            for id in &raw {
                let node = &snapshot.nodes[id];
                if node.parent_id.is_none() {
                    return Err(EngineError::invalid("a page is not a layer"));
                }
                let (mut set, mut unset) = (Properties::new(), Vec::new());
                for key in omc_style::copy_appearance_keys(node) {
                    if let Some(value) = props.get(key) {
                        set.insert(key.into(), value.clone());
                    } else if omc_style::is_appearance_key(key) && node.properties.contains_key(key) {
                        unset.push(key.into());
                    }
                }
                if !set.is_empty() {
                    commands.push(Command::NodeSet {
                        node_id: id.clone(),
                        properties: set,
                    });
                }
                if !unset.is_empty() {
                    commands.push(Command::NodeUnset {
                        node_id: id.clone(),
                        properties: unset,
                    });
                }
            }
            if !commands.is_empty() {
                self.submit(
                    session,
                    id,
                    Command::Batch { commands },
                    &Value::Null,
                    Some(snapshot.sequence),
                )?;
            }
            return Ok(json!({"ok":true}));
        }
        let scene = paths::scene(snapshot, &state.page_id)?;
        if matches!(name, "edit.copy" | "edit.cut") {
            let cut = name == "edit.cut";
            let roots = top_targets(snapshot, &raw)?;
            let mut stored = Vec::new();
            let mut all_bounds: Option<[f64; 4]> = None;
            let mut count = 0;
            for node in roots {
                let item = scene
                    .item(&node.id)
                    .ok_or_else(|| EngineError::invalid("layer is not on the current page"))?;
                let [x, y, w, h] = item.bounds;
                let bounds = [x, y, x + w, y + h];
                all_bounds = Some(match all_bounds {
                    Some([a, b, c, d]) => [x.min(a), y.min(b), (x + w).max(c), (y + h).max(d)],
                    None => bounds,
                });
                let mut pending = vec![node];
                let mut nodes = Vec::new();
                while let Some(node) = pending.pop() {
                    count += 1;
                    if count > 100 {
                        return Err(EngineError::new(
                            "resource_limit",
                            "clipboard exceeds 100 layers",
                        ));
                    }
                    nodes.push(node.clone());
                    pending.extend(children(snapshot, &node.id).into_iter().rev());
                }
                stored.push(ClipRoot {
                    nodes,
                    world: item.world,
                });
            }
            let bounds = all_bounds.ok_or_else(|| EngineError::invalid("select layers to copy"))?;
            if cut {
                self.submit(
                    session,
                    id,
                    Command::NodeDelete {
                        node_ids: stored.iter().map(|root| root.nodes[0].id.clone()).collect(),
                    },
                    &Value::Null,
                    Some(snapshot.sequence),
                )?;
                self.fig_selection(&key, &[]);
            }
            self.fig_clipboards
                .lock()
                .unwrap()
                .entry(session.into())
                .or_default()
                .layers = Some(LayerCopy {
                source: id.clone(),
                cut,
                roots: stored,
                bounds,
            });
            return Ok(json!({"ok":true}));
        }
        let mut foreign = None;
        let clip = if name == "edit.pasteDesignLayers" {
            let (clip, warnings, missing) = self.fig_foreign_clipboard(params)?;
            foreign = Some((warnings, missing));
            clip
        } else {
            self.fig_clipboards
                .lock()
                .unwrap()
                .get(session)
                .and_then(|clip| clip.layers.clone())
                .ok_or_else(|| EngineError::invalid("no copied layers"))?
        };
        let bounds_for = |layer: &str| {
            scene
                .bounds(layer)
                .ok_or_else(|| EngineError::invalid("target layer is not on the current page"))
        };
        let [left, top, right, bottom] = clip.bounds;
        let targets = if name == "edit.pasteReplace" {
            let targets = top_targets(snapshot, &raw)?;
            if targets.is_empty() {
                return Err(EngineError::invalid("select layers to replace"));
            }
            targets
                .into_iter()
                .map(|node| {
                    let [x, y, _, _] = bounds_for(&node.id)?;
                    Ok((node.parent_id.clone().unwrap(), Some(node), Some((x, y))))
                })
                .collect::<Result<Vec<_>>>()?
        } else if name == "edit.pasteOver" {
            if let Some(node) = raw.first().map(|raw| &snapshot.nodes[raw]) {
                let [x, y, _, _] = bounds_for(&node.id)?;
                vec![(
                    node.parent_id.clone().unwrap_or_else(|| state.root.clone()),
                    None,
                    Some((x, y)),
                )]
            } else {
                vec![(state.root.clone(), None, None)]
            }
        } else {
            let explicit = params
                .get("parent")
                .map(|value| self.fig_layer(session, snapshot, value))
                .transpose()?;
            let selected = (raw.len() == 1)
                .then(|| &snapshot.nodes[&raw[0]])
                .filter(|node| node.kind == NodeKind::Frame);
            let parent = explicit
                .or_else(|| selected.map(|node| node.id.clone()))
                .unwrap_or_else(|| state.root.clone());
            if !matches!(
                snapshot.nodes[&parent].kind,
                NodeKind::Frame | NodeKind::Group | NodeKind::Component
            ) {
                return Err(EngineError::invalid("paste parent is not a container"));
            }
            let at = match (params["x"].as_f64(), params["y"].as_f64()) {
                (Some(x), Some(y)) => Some((x, y)),
                (None, None) if parent != state.root => {
                    let [x, y, w, h] = bounds_for(&parent)?;
                    (left < x || top < y || right > x + w || bottom > y + h)
                        .then_some((x + (w - right + left) / 2., y + (h - bottom + top) / 2.))
                }
                (None, None) => None,
                _ => return Err(EngineError::invalid("supply both x and y")),
            };
            vec![(parent, None, at)]
        };
        let mut output = Vec::new();
        for (parent, replaced, at) in targets {
            let inverse = scene
                .item(&parent)
                .and_then(|item| item.world.inverse())
                .ok_or_else(|| EngineError::invalid("paste parent transform is not invertible"))?;
            let delta = at.map_or(Affine::IDENTITY, |(x, y)| {
                Affine::translation(x - left, y - top)
            });
            let siblings = children(snapshot, &parent);
            let (before, after) = if let Some(node) = replaced {
                let i = siblings.iter().position(|s| s.id == node.id).unwrap();
                (
                    i.checked_sub(1).and_then(|i| siblings.get(i)),
                    siblings.get(i + 1),
                )
            } else {
                (siblings.last(), None)
            };
            let mut rank = before.map(|n| n.rank.clone());
            let after = after.map(|n| n.rank.as_str());
            let map = clip
                .roots
                .iter()
                .flat_map(|root| &root.nodes)
                .map(|node| (node.id.clone(), new_id("node")))
                .collect::<BTreeMap<_, _>>();
            for root in &clip.roots {
                let main = &root.nodes[0];
                let instance = !clip.cut
                    && clip.source == *id
                    && main.kind == NodeKind::Component
                    && snapshot.nodes.contains_key(&main.id);
                for source in root
                    .nodes
                    .iter()
                    .take(if instance { 1 } else { root.nodes.len() })
                {
                    let mut node = source.clone();
                    node.id = map[&source.id].clone();
                    node.home_shard = new_id("shard");
                    if source.id == main.id {
                        rank = Some(rank_between(rank.as_deref(), after).ok_or_else(|| {
                            EngineError::new("resource_limit", "sibling rank exhausted")
                        })?);
                        node.rank = rank.clone().unwrap();
                        node.parent_id = Some(parent.clone());
                        let local = inverse.multiply(delta).multiply(root.world);
                        node.properties.insert("x".into(), json!(local.0[4]));
                        node.properties.insert("y".into(), json!(local.0[5]));
                        node.properties.insert(
                            "transform".into(),
                            json!([local.0[0], local.0[1], local.0[2], local.0[3], 0, 0]),
                        );
                        if instance {
                            node.kind = NodeKind::Instance;
                            node.properties.retain(|key, _| {
                                matches!(
                                    key.as_str(),
                                    "x" | "y" | "name" | "width" | "height" | "transform"
                                )
                            });
                        }
                        output.push(json!(self.fig_alias(session, id, &node.id)));
                    } else {
                        node.parent_id = source
                            .parent_id
                            .as_ref()
                            .and_then(|id| map.get(id))
                            .cloned();
                    }
                    remap_values(&mut node.properties, &map);
                    if instance {
                        node.properties.insert("componentId".into(), json!(main.id));
                    }
                    if let Some(component) = node.string("componentId")
                        && !snapshot.nodes.contains_key(component)
                        && !map.values().any(|value| value == component)
                    {
                        return Err(EngineError::invalid(
                            "paste requires a component definition unavailable in the target document",
                        ));
                    }
                    commands.push(Command::NodeCreate { node });
                }
            }
            if let Some(node) = replaced {
                commands.push(Command::NodeDelete {
                    node_ids: vec![node.id.clone()],
                });
            }
            if commands.len() > 100 {
                return Err(EngineError::new(
                    "resource_limit",
                    "paste exceeds 100 atomic operations",
                ));
            }
        }
        self.submit(
            session,
            id,
            Command::Batch { commands },
            &Value::Null,
            Some(snapshot.sequence),
        )?;
        self.fig_selection(&key, &output);
        if let Some((warnings, missing)) = foreign {
            self.fig_clipboards
                .lock()
                .unwrap()
                .entry(session.into())
                .or_default()
                .layers = Some(clip);
            Ok(json!({"ids":output,"warnings":warnings,"missingImages":missing}))
        } else {
            Ok(json!({"ids":output}))
        }
    }

    fn fig_foreign_clipboard(&self, params: &Value) -> Result<(LayerCopy, Value, Vec<String>)> {
        use base64::engine::general_purpose::{STANDARD, STANDARD_NO_PAD};
        let encoded = match (params["html"].as_str(), params["data"].as_str()) {
            (Some(html), None) => html
                .split_once("(figma)")
                .and_then(|(_, tail)| tail.split_once("(/figma)"))
                .map(|(data, _)| data)
                .ok_or_else(|| EngineError::invalid("the HTML holds no copied design layers"))?,
            (None, Some(data)) => data,
            _ => return Err(EngineError::invalid("supply exactly one of html or data")),
        };
        let compact = encoded
            .chars()
            .filter(|ch| !ch.is_ascii_whitespace())
            .collect::<String>();
        let bytes = STANDARD
            .decode(&compact)
            .or_else(|_| STANDARD_NO_PAD.decode(&compact))
            .map_err(|_| EngineError::invalid("invalid base64 design data"))?;
        let imported = omc_import::import_bytes(
            "fig",
            &bytes,
            &omc_import::ImportOptions {
                strict: false,
                ..Default::default()
            },
        )
        .map_err(|error| EngineError::invalid(error.to_string()))?;
        let store = self.resources()?.0;
        for asset in imported.resources {
            if store.ingest(&asset.bytes, &asset.media_type)?.hash != asset.hash {
                return Err(EngineError::new(
                    "corrupt_state",
                    "import resource identity mismatch",
                ));
            }
        }
        let mut source = DocumentSnapshot {
            id: new_id("doc"),
            epoch: String::new(),
            sequence: 0,
            title: imported.content.title,
            pages: imported.content.pages,
            nodes: imported.content.nodes,
            metadata: imported.content.metadata,
        };
        let mut missing = BTreeSet::new();
        for diagnostic in &imported.diagnostics {
            if diagnostic.property.as_deref() == Some("fig-image")
                && let Some(node) = diagnostic
                    .node_id
                    .as_ref()
                    .and_then(|id| source.nodes.get_mut(id))
            {
                missing.insert(node.string("name").unwrap_or("").to_owned());
                if !node.properties.contains_key("fills") && !node.properties.contains_key("fill") {
                    node.properties.insert("fill".into(), json!("#DADDE1"));
                }
            }
        }
        let mut clip = LayerCopy {
            source: source.id.clone(),
            cut: false,
            roots: vec![],
            bounds: [
                f64::INFINITY,
                f64::INFINITY,
                f64::NEG_INFINITY,
                f64::NEG_INFINITY,
            ],
        };
        let mut count = 0;
        for page in &source.pages {
            let scene = paths::scene(&source, &page.id)?;
            for root in children(&source, &page.root_node_id) {
                let Some(item) = scene.item(&root.id) else {
                    continue;
                };
                let [x, y, w, h] = item.bounds;
                let [left, top, right, bottom] = clip.bounds;
                clip.bounds = [left.min(x), top.min(y), right.max(x + w), bottom.max(y + h)];
                let mut nodes = Vec::new();
                let mut pending = vec![root];
                while let Some(node) = pending.pop() {
                    count += 1;
                    if count > 100 {
                        return Err(EngineError::new(
                            "resource_limit",
                            "paste exceeds 100 atomic operations",
                        ));
                    }
                    nodes.push(node.clone());
                    pending.extend(children(&source, &node.id).into_iter().rev());
                }
                clip.roots.push(ClipRoot {
                    nodes,
                    world: item.world,
                });
            }
        }
        if clip.roots.is_empty() {
            return Err(EngineError::invalid("the copied design is empty"));
        }
        Ok((
            clip,
            json!(imported.diagnostics),
            missing.into_iter().collect(),
        ))
    }
}

fn top_targets<'a>(snapshot: &'a DocumentSnapshot, ids: &[String]) -> Result<Vec<&'a Node>> {
    let selected = ids.iter().map(String::as_str).collect::<BTreeSet<_>>();
    let mut roots = Vec::new();
    for id in &selected {
        let node = &snapshot.nodes[*id];
        let mut parent = Some(
            node.parent_id
                .as_deref()
                .ok_or_else(|| EngineError::invalid("pages are not clipboard layers"))?,
        );
        let mut nested = false;
        while let Some(id) = parent {
            if selected.contains(id) {
                nested = true;
                break;
            }
            parent = snapshot.nodes[id].parent_id.as_deref();
        }
        if !nested {
            roots.push(node);
        }
    }
    roots.sort_by(|a, b| (&a.rank, &a.id).cmp(&(&b.rank, &b.id)));
    Ok(roots)
}
