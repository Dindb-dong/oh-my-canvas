use super::*;
use omc_scene::{Scene, SceneOptions};
use std::collections::BTreeSet;

pub(super) const COMMANDS: &[(&str, &str, bool, &str)] = &[
    (
        "node.find",
        "Find layers",
        false,
        "root?, name?, type?, text?, component?, limit?",
    ),
    ("node.reorder", "Reorder layer", true, "id, index"),
    (
        "node.reparent",
        "Move layer into",
        true,
        "ids?, parent, index?",
    ),
    ("select.layersAt", "Layers at a point", false, "x, y"),
    (
        "select.area",
        "Select area",
        false,
        "x, y, width, height, add?, deep?",
    ),
    ("object.rename", "Rename", true, "ids?, name"),
    (
        "object.toggleVisible",
        "Show/Hide selection",
        true,
        "ids?, visible?",
    ),
    (
        "object.toggleLock",
        "Lock/Unlock selection",
        true,
        "ids?, locked?",
    ),
    (
        "object.opacityKeys",
        "Opacity from number keys",
        true,
        "ids?, digits",
    ),
    ("object.removeFill", "Remove fill", true, "ids?"),
    ("object.removeStroke", "Remove stroke", true, "ids?"),
    ("object.group", "Group selection", true, "ids?, name?"),
    (
        "object.frameSelection",
        "Frame selection",
        true,
        "ids?, name?",
    ),
    ("object.ungroup", "Ungroup selection", true, "ids?"),
    ("object.removeFrame", "Remove frame", true, "ids?"),
    ("object.mask", "Use as mask", true, "ids?"),
    ("object.releaseMask", "Release mask", true, "ids?"),
    ("align.left", "Align left", true, "ids?"),
    ("align.hcenter", "Align horizontal centers", true, "ids?"),
    ("align.right", "Align right", true, "ids?"),
    ("align.top", "Align top", true, "ids?"),
    ("align.vcenter", "Align vertical centers", true, "ids?"),
    ("align.bottom", "Align bottom", true, "ids?"),
    ("arrange.tidy", "Tidy up", true, "ids?, spacing?"),
    ("arrange.roundToPixels", "Round to pixels", true, "ids?"),
    ("arrange.front", "Bring to front", true, "ids?"),
    ("arrange.forward", "Bring forward", true, "ids?"),
    ("arrange.backward", "Send backward", true, "ids?"),
    ("arrange.back", "Send to back", true, "ids?"),
];

impl ToolRouter {
    pub(super) fn fig_core_command(
        &self,
        session: &str,
        snapshot: &DocumentSnapshot,
        state: &ViewState,
        selection: &[Value],
        name: &str,
        params: &Value,
    ) -> Result<Value> {
        let document = &snapshot.id;
        let alias = |id: &str| self.fig_alias(session, document, id);
        let aliases = |ids: &[String]| ids.iter().map(|id| json!(alias(id))).collect::<Vec<_>>();
        let select = |ids: &[String]| {
            let selection = aliases(ids);
            self.fig_selection(&(session.into(), document.clone()), &selection);
            json!({"selection":selection})
        };
        if name == "node.find" {
            let root = params
                .get("root")
                .map(|value| self.fig_layer(session, snapshot, value))
                .transpose()?
                .unwrap_or_else(|| state.root.clone());
            let limit = optional_index(params, "limit")?.unwrap_or(100).min(10_000);
            let filters = ["name", "text", "component", "type"]
                .map(|key| {
                    params
                        .get(key)
                        .map(|_| string(params, key).map(str::to_lowercase))
                        .transpose()
                })
                .into_iter()
                .collect::<Result<Vec<_>>>()?;
            let mut matches = Vec::new();
            let mut by_parent: BTreeMap<&str, Vec<&Node>> = BTreeMap::new();
            for node in snapshot.nodes.values() {
                if let Some(parent) = node.parent_id.as_deref() {
                    by_parent.entry(parent).or_default().push(node);
                }
            }
            for siblings in by_parent.values_mut() {
                siblings.sort_by(|left, right| {
                    right
                        .rank
                        .cmp(&left.rank)
                        .then_with(|| right.id.cmp(&left.id))
                });
            }
            let mut pending = by_parent.remove(root.as_str()).unwrap_or_default();
            while let Some(node) = pending.pop() {
                let text_match = |index: usize, value: &str| {
                    filters[index]
                        .as_ref()
                        .is_none_or(|term| value.to_lowercase().contains(term))
                };
                let component = node
                    .string("componentId")
                    .and_then(|id| snapshot.nodes.get(id))
                    .and_then(|source| source.string("name"))
                    .unwrap_or("");
                if text_match(0, node.string("name").unwrap_or(""))
                    && text_match(1, node.string("text").unwrap_or(""))
                    && text_match(2, component)
                    && filters[3]
                        .as_ref()
                        .is_none_or(|kind| kind.eq_ignore_ascii_case(layer_type(node)))
                {
                    matches.push(node.id.clone());
                }
                pending.extend(by_parent.remove(node.id.as_str()).into_iter().flatten());
            }
            return Ok(
                json!({"ids":aliases(&matches[..matches.len().min(limit)]),"total":matches.len()}),
            );
        }
        if matches!(name, "select.layersAt" | "select.area") {
            let scene = page_scene(snapshot, state)?;
            let x = number(params, "x")?;
            let y = number(params, "y")?;
            if name == "select.layersAt" {
                let layers = scene.items.iter().rev().filter_map(|item| {
                    let node = snapshot.nodes.get(&item.id)?;
                    let depth = selectable_depth(&scene, item, Some((x,y)))?;
                    item.contains(x,y).then(|| json!({"id":alias(&node.id),"name":node.string("name").unwrap_or(""),"type":layer_type(node),"depth":depth}))
                }).collect::<Vec<_>>();
                return Ok(json!({"layers":layers}));
            }
            let width = number(params, "width")?;
            let height = number(params, "height")?;
            let (left, right) = (x.min(x + width), x.max(x + width));
            let (top, bottom) = (y.min(y + height), y.max(y + height));
            let mut selected = if params["add"] == true {
                self.fig_layers(session, snapshot, selection)?
            } else {
                Vec::new()
            };
            for item in &scene.items {
                let Some(depth) = selectable_depth(&scene, item, None) else {
                    continue;
                };
                let [x, y, w, h] = item.bounds;
                if snapshot.nodes.contains_key(&item.id)
                    && (depth == 0 || params["deep"] == true)
                    && x + w >= left
                    && x <= right
                    && y + h >= top
                    && y <= bottom
                {
                    if let Some(index) = selected.iter().position(|id| id == &item.id) {
                        selected.remove(index);
                    } else {
                        selected.push(item.id.clone());
                    }
                }
            }
            return Ok(select(&selected));
        }

        let mut ids = if name == "node.reorder" {
            vec![self.fig_layer(session, snapshot, &params["id"])?]
        } else {
            self.fig_layers(session, snapshot, fig_ids(params, selection)?)?
        };
        let mut seen = BTreeSet::new();
        ids.retain(|id| seen.insert(id.clone()));
        if ids.is_empty() {
            return Ok(json!({"ids":[]}));
        }
        if ids.iter().any(|id| snapshot.nodes[id].parent_id.is_none()) {
            return Err(EngineError::invalid("cannot edit a page root as a layer"));
        }
        let mut commands = Vec::new();
        let mut selected = None;
        match name {
            "node.reorder" | "node.reparent" | "arrange.front" | "arrange.back" => {
                let parent = if name == "node.reparent" {
                    self.fig_layer(session, snapshot, &params["parent"])?
                } else {
                    common_parent(snapshot, &ids)?.to_owned()
                };
                let nodes = &snapshot.nodes;
                if name == "node.reparent" {
                    let mut ancestor = Some(parent.as_str());
                    while let Some(candidate) = ancestor {
                        if seen.contains(candidate) {
                            return Err(EngineError::invalid("a layer cannot contain itself"));
                        }
                        ancestor = nodes[candidate].parent_id.as_deref();
                    }
                    if nodes[&parent].parent_id.is_some()
                        && !matches!(
                            nodes[&parent].kind,
                            NodeKind::Frame | NodeKind::Group | NodeKind::Component
                        )
                    {
                        return Err(EngineError::invalid("target layer is not a container"));
                    }
                }
                let siblings = children(snapshot, &parent);
                let mut order = siblings
                    .iter()
                    .filter(|n| !seen.contains(&n.id))
                    .map(|n| n.id.clone())
                    .collect::<Vec<_>>();
                let default = if name == "arrange.back" {
                    0
                } else {
                    order.len()
                };
                let index = optional_index(params, "index")?;
                if index.is_none() && name == "node.reorder" {
                    return Err(EngineError::invalid("index is required"));
                }
                let index = index.unwrap_or(default).min(order.len());
                let mut moved = ids.clone();
                if name != "node.reparent" {
                    moved.sort_by(|left, right| {
                        nodes[left]
                            .rank
                            .cmp(&nodes[right].rank)
                            .then_with(|| left.cmp(right))
                    });
                }
                order.splice(index..index, moved.clone());
                if name == "node.reparent"
                    && moved
                        .iter()
                        .any(|id| nodes[id].parent_id.as_deref() != Some(&parent))
                {
                    let scene = page_scene(snapshot, state)?;
                    let new_parent = scene.item(&parent).ok_or_else(|| {
                        EngineError::invalid("target is outside the current page")
                    })?;
                    let inverse = new_parent
                        .world
                        .inverse()
                        .ok_or_else(|| EngineError::invalid("target transform is singular"))?;
                    for id in &moved {
                        if nodes[id].parent_id.as_deref() != Some(&parent) {
                            let item = scene.item(id).ok_or_else(|| {
                                EngineError::invalid("layer is outside the current page")
                            })?;
                            let mut local = inverse.multiply(item.world).0;
                            let [x, y] = [local[4], local[5]];
                            local[4] = 0.;
                            local[5] = 0.;
                            commands.push(Command::NodeSet {
                                node_id: id.clone(),
                                properties: properties(&json!({"x":x,"y":y,"transform":local}))?,
                            });
                        }
                    }
                }
                order_moves(snapshot, &parent, &order, &moved, index, &mut commands)?;
            }
            "object.group" | "object.frameSelection" => {
                let parent = common_parent(snapshot, &ids)?;
                let nodes = &snapshot.nodes;
                let [x, y, w, h] = bounds(ids.iter().map(|id| {
                    let node = &nodes[id];
                    [
                        node.number("x", 0.),
                        node.number("y", 0.),
                        node.number("width", 0.),
                        node.number("height", 0.),
                    ]
                }));
                let frame = name == "object.frameSelection";
                let mut group = Node::new(if frame {
                    NodeKind::Frame
                } else {
                    NodeKind::Group
                });
                group.home_shard = nodes[parent].home_shard.clone();
                group.parent_id = Some(parent.into());
                group.rank = ids.iter().map(|id| &nodes[id].rank).min().unwrap().clone();
                group.properties = properties(
                    &json!({"name":params["name"].as_str().unwrap_or(if frame {"Frame"} else {"Group"}),"x":x,"y":y,"width":w,"height":h}),
                )?;
                let group_id = group.id.clone();
                commands.push(Command::NodeCreate { node: group });
                for id in &ids {
                    let node = &nodes[id];
                    commands.push(Command::NodeSet {
                        node_id: id.clone(),
                        properties: position(node.number("x", 0.) - x, node.number("y", 0.) - y),
                    });
                    commands.push(Command::NodeMove {
                        node_id: id.clone(),
                        parent_id: Some(group_id.clone()),
                        rank: node.rank.clone(),
                    });
                }
                selected = Some(vec![group_id]);
            }
            "object.ungroup" | "object.removeFrame" => {
                let scene = page_scene(snapshot, state)?;
                let mut ungrouped = Vec::new();
                for id in &ids {
                    let node = &snapshot.nodes[id];
                    let expected = if name == "object.ungroup" {
                        NodeKind::Group
                    } else {
                        NodeKind::Frame
                    };
                    if node.effective_kind() != expected {
                        return Err(EngineError::invalid(
                            "selected layer is not the requested container type",
                        ));
                    }
                    if node
                        .parent_id
                        .as_ref()
                        .is_some_and(|parent| seen.contains(parent))
                    {
                        return Err(EngineError::invalid("select separate containers"));
                    }
                    let parent = node.parent_id.as_ref().unwrap();
                    let inverse = scene
                        .item(parent)
                        .and_then(|item| item.world.inverse())
                        .ok_or_else(|| {
                            EngineError::invalid("container parent transform is unavailable")
                        })?;
                    let siblings = children(snapshot, parent);
                    let mut order = siblings.iter().map(|n| n.id.clone()).collect::<Vec<_>>();
                    let index = order.iter().position(|raw| raw == id).unwrap();
                    let moved = children(snapshot, id)
                        .into_iter()
                        .map(|n| n.id.clone())
                        .collect::<Vec<_>>();
                    for child in &moved {
                        let item = scene
                            .item(child)
                            .ok_or_else(|| EngineError::invalid("child geometry is unavailable"))?;
                        let mut local = inverse.multiply(item.world).0;
                        let [x, y] = [local[4], local[5]];
                        local[4] = 0.;
                        local[5] = 0.;
                        commands.push(Command::NodeSet {
                            node_id: child.clone(),
                            properties: properties(&json!({"x":x,"y":y,"transform":local}))?,
                        });
                    }
                    order.splice(index..index + 1, moved.clone());
                    order_moves(snapshot, parent, &order, &moved, index, &mut commands)?;
                    commands.push(Command::NodeDelete {
                        node_ids: vec![id.clone()],
                    });
                    ungrouped.extend(moved);
                }
                selected = Some(ungrouped);
            }
            "align.left" | "align.right" | "align.hcenter" | "align.top" | "align.bottom"
            | "align.vcenter" => {
                let scene = page_scene(snapshot, state)?;
                let measured = ids
                    .iter()
                    .map(|id| {
                        scene
                            .item(id)
                            .ok_or_else(|| EngineError::invalid("layer outside current page"))
                    })
                    .collect::<Result<Vec<_>>>()?;
                let [x, y, w, h] = bounds(measured.iter().map(|item| item.bounds));
                for item in measured {
                    let [left, top, width, height] = item.bounds;
                    let (dx, dy) = match name {
                        "align.left" => (x - left, 0.),
                        "align.right" => (x + w - left - width, 0.),
                        "align.hcenter" => (x + (w - width) / 2. - left, 0.),
                        "align.top" => (0., y - top),
                        "align.bottom" => (0., y + h - top - height),
                        _ => (0., y + (h - height) / 2. - top),
                    };
                    let parent = item
                        .parent
                        .and_then(|parent| scene.items[parent].world.inverse())
                        .ok_or_else(|| EngineError::invalid("parent transform is singular"))?;
                    let (local_x, local_y) = parent.point(dx, dy);
                    let (origin_x, origin_y) = parent.point(0., 0.);
                    let node = &snapshot.nodes[&item.id];
                    commands.push(Command::NodeSet {
                        node_id: item.id.clone(),
                        properties: position(
                            node.number("x", 0.) + local_x - origin_x,
                            node.number("y", 0.) + local_y - origin_y,
                        ),
                    });
                }
            }
            "arrange.forward" | "arrange.backward" | "arrange.tidy" | "object.mask"
            | "object.releaseMask" => {
                let mut args = match name {
                    "arrange.tidy" => json!({"action":"tidy","ids":ids}),
                    "object.mask" => json!({"action":"mask","ids":ids}),
                    "object.releaseMask" => json!({"action":"unmask","ids":ids}),
                    _ => {
                        json!({"action":"order","mode":if name=="arrange.forward" {"forward"} else {"backward"},"ids":ids})
                    }
                };
                args["revision"] = json!(snapshot.sequence);
                if let Some(spacing) = params.get("spacing") {
                    args["gap"] = spacing.clone();
                }
                let result = self.mutate(session, document, "edit_shapes", &args, &Value::Null)?;
                if name == "object.mask" {
                    let created = result["rawIds"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(|raw| raw.as_str().map(str::to_owned))
                        .collect::<Vec<_>>();
                    return Ok(select(&created));
                }
                return Ok(json!({"ids":aliases(&ids)}));
            }
            _ => {
                let all_visible = ids
                    .iter()
                    .all(|id| snapshot.nodes[id].properties.get("visible") != Some(&json!(false)));
                let all_locked = ids
                    .iter()
                    .all(|id| snapshot.nodes[id].properties.get("locked") == Some(&json!(true)));
                for id in &ids {
                    let node = &snapshot.nodes[id];
                    let patch = match name {
                        "object.rename" => json!({"name":string(params,"name")?}),
                        "object.toggleVisible" => {
                            json!({"visible":boolean(params,"visible")?.unwrap_or(!all_visible)})
                        }
                        "object.toggleLock" => {
                            json!({"locked":boolean(params,"locked")?.unwrap_or(!all_locked)})
                        }
                        "object.opacityKeys" => {
                            json!({"opacity":opacity(string(params,"digits")?)?})
                        }
                        "object.removeFill" => json!({"fill":"transparent","fills":[]}),
                        "object.removeStroke" => json!({"stroke":"transparent","strokes":[]}),
                        "arrange.roundToPixels" => {
                            json!({"x":node.number("x",0.).round(),"y":node.number("y",0.).round(),"width":node.number("width",0.).round(),"height":node.number("height",0.).round()})
                        }
                        _ => return Err(EngineError::invalid("unknown layer command")),
                    };
                    commands.push(Command::NodeSet {
                        node_id: id.clone(),
                        properties: properties(&patch)?,
                    });
                }
            }
        }
        if !commands.is_empty() {
            self.submit(
                session,
                document,
                Command::Batch { commands },
                &Value::Null,
                Some(snapshot.sequence),
            )?;
        }
        Ok(selected
            .as_ref()
            .map_or_else(|| json!({"ids":aliases(&ids)}), |ids| select(ids)))
    }
}

fn number(value: &Value, key: &str) -> Result<f64> {
    value[key]
        .as_f64()
        .filter(|value| value.is_finite())
        .ok_or_else(|| EngineError::invalid(format!("{key} must be a number")))
}

fn optional_index(value: &Value, key: &str) -> Result<Option<usize>> {
    value
        .get(key)
        .map(|v| {
            v.as_u64()
                .and_then(|n| usize::try_from(n).ok())
                .ok_or_else(|| {
                    EngineError::invalid(format!("{key} must be a non-negative integer"))
                })
        })
        .transpose()
}

fn boolean(value: &Value, key: &str) -> Result<Option<bool>> {
    value
        .get(key)
        .map(|v| {
            v.as_bool()
                .ok_or_else(|| EngineError::invalid(format!("{key} must be a boolean")))
        })
        .transpose()
}

fn opacity(digits: &str) -> Result<f64> {
    if !(1..=2).contains(&digits.len()) || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(EngineError::invalid(
            "digits must contain one or two decimal digits",
        ));
    }
    let value = digits.parse::<u8>().unwrap();
    Ok(match (digits.len(), value) {
        (1, 0) => 1.,
        (1, value) => f64::from(value) / 10.,
        (_, value) => f64::from(value) / 100.,
    })
}

fn page_scene(snapshot: &DocumentSnapshot, state: &ViewState) -> Result<Scene> {
    omc_scene::build_scene(
        snapshot,
        &SceneOptions {
            page_id: Some(state.page_id.clone()),
            ..Default::default()
        },
    )
    .map_err(|error| EngineError::invalid(error.to_string()))
}

fn selectable_depth(
    scene: &Scene,
    item: &omc_scene::SceneItem,
    point: Option<(f64, f64)>,
) -> Option<usize> {
    let mut parent = item.parent?;
    let mut depth = 0;
    if item.hidden || item.locked {
        return None;
    }
    while parent != scene.root {
        let ancestor = &scene.items[parent];
        if ancestor.hidden
            || ancestor.locked
            || ancestor.clip && point.is_some_and(|(x, y)| !ancestor.contains(x, y))
        {
            return None;
        }
        parent = ancestor.parent?;
        depth += 1;
    }
    Some(depth)
}

fn common_parent<'a>(snapshot: &'a DocumentSnapshot, ids: &[String]) -> Result<&'a str> {
    let parent = snapshot.nodes[&ids[0]].parent_id.as_deref().unwrap();
    if ids
        .iter()
        .any(|id| snapshot.nodes[id].parent_id.as_deref() != Some(parent))
    {
        return Err(EngineError::invalid("selected layers must share a parent"));
    }
    Ok(parent)
}

fn bounds(items: impl Iterator<Item = [f64; 4]>) -> [f64; 4] {
    let [left, top, right, bottom] = items.fold(
        [
            f64::INFINITY,
            f64::INFINITY,
            f64::NEG_INFINITY,
            f64::NEG_INFINITY,
        ],
        |[left, top, right, bottom], [x, y, w, h]| {
            [left.min(x), top.min(y), right.max(x + w), bottom.max(y + h)]
        },
    );
    [left, top, right - left, bottom - top]
}

fn position(x: f64, y: f64) -> Properties {
    Properties::from([("x".into(), json!(x)), ("y".into(), json!(y))])
}

fn order_moves(
    snapshot: &DocumentSnapshot,
    parent: &str,
    order: &[String],
    moved: &[String],
    index: usize,
    commands: &mut Vec<Command>,
) -> Result<()> {
    let rank = |index: usize| order.get(index).map(|id| snapshot.nodes[id].rank.as_str());
    let mut left = index.checked_sub(1).and_then(rank).map(str::to_owned);
    let right = rank(index + moved.len());
    for id in moved {
        let next = rank_between(left.as_deref(), right).ok_or_else(|| {
            EngineError::new("resource_limit", "sibling ordering requires rank rebalance")
        })?;
        commands.push(Command::NodeMove {
            node_id: id.clone(),
            parent_id: Some(parent.into()),
            rank: next.clone(),
        });
        left = Some(next);
    }
    Ok(())
}
