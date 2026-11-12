use super::*;
use omc_scene::SceneItem;

impl ToolRouter {
    pub(super) fn fig_layout(
        &self,
        session: &str,
        snapshot: &DocumentSnapshot,
        state: &ViewState,
        ids: &[String],
        action: &str,
        params: &Value,
        commands: &mut Vec<Command>,
    ) -> Result<Value> {
        let scene = paths::scene(snapshot, &state.page_id)?;
        let mut targets = root_targets(snapshot, ids);
        let alias = |id: &str| self.fig_alias(session, &snapshot.id, id);
        if action == "setTrack" {
            for id in &targets {
                set_track(snapshot, &scene, id, params, commands)?;
            }
            return Ok(json!({"ok":true}));
        }
        if matches!(action, "remove" | "removeAll") {
            let mut removed = BTreeSet::new();
            let mut adjusted = BTreeSet::new();
            while let Some(id) = targets.pop() {
                let node = &snapshot.nodes[&id];
                if node.kind == NodeKind::Instance {
                    continue;
                }
                let item = find(&scene, &id)?;
                if action == "removeAll" {
                    targets.extend(
                        item.children
                            .iter()
                            .map(|index| scene.items[*index].id.clone())
                            .filter(|id| snapshot.nodes.contains_key(id)),
                    );
                }
                if !auto_layout(node) || !removed.insert(id.clone()) {
                    continue;
                }
                let patch = remove_layout_properties(node, item);
                commands.push(set(&id, patch)?);
                for index in &item.children {
                    let child = &scene.items[*index];
                    if snapshot.nodes.contains_key(&child.id)
                        && !child.hidden
                        && adjusted.insert(child.id.clone())
                    {
                        let mut patch = local_patch(child.local);
                        patch["width"] = json!(child.width);
                        patch["height"] = json!(child.height);
                        commands.push(set(&child.id, patch)?);
                    }
                }
            }
            return Ok(if action == "removeAll" {
                json!({"removed":removed.iter().map(|id|alias(id)).collect::<Vec<_>>()})
            } else {
                json!({"ok":true})
            });
        }
        let direction = params
            .get("direction")
            .map(|_| string(params, "direction"))
            .transpose()?;
        if direction.is_some_and(|dir| {
            !matches!(dir, "horizontal" | "vertical" | "row" | "column" | "grid")
        }) {
            return Err(EngineError::invalid(
                "direction must be horizontal, vertical or grid",
            ));
        }
        let suggest = action == "suggest";
        let mut warnings = Vec::new();
        if suggest
            && targets.iter().any(|id| {
                let mut current = Some(id.as_str());
                while let Some(id) = current {
                    let node = &snapshot.nodes[id];
                    if node.kind == NodeKind::Instance {
                        return true;
                    }
                    current = node.parent_id.as_deref();
                }
                false
            })
        {
            return Err(EngineError::invalid(
                "detach the instance before suggesting auto layout",
            ));
        }
        let in_place = targets.iter().all(|id| {
            let node = &snapshot.nodes[id];
            matches!(node.kind, NodeKind::Frame | NodeKind::Component) && !auto_layout(node)
        }) || targets.len() == 1
            && snapshot.nodes[&targets[0]].kind == NodeKind::Group;
        if in_place {
            for id in &targets {
                let item = find(&scene, id)?;
                let members = item
                    .children
                    .iter()
                    .map(|index| &scene.items[*index])
                    .filter(|child| snapshot.nodes.contains_key(&child.id))
                    .map(|child| {
                        (
                            child.id.as_str(),
                            child.local,
                            child.local.bounds(child.width, child.height),
                            child.hidden || child.style.get("position") == Some("absolute"),
                            child.properties.get("mask") == Some(&json!(true)),
                        )
                    })
                    .collect::<Vec<_>>();
                Flow::new(snapshot, commands, &mut warnings).build(
                    id,
                    [item.width, item.height],
                    &members,
                    direction,
                    suggest,
                    0,
                    false,
                )?;
            }
        } else {
            let parent = snapshot.nodes[&targets[0]].parent_id.as_deref().unwrap();
            if targets
                .iter()
                .any(|id| snapshot.nodes[id].parent_id.as_deref() != Some(parent))
            {
                return Err(EngineError::invalid(
                    "auto layout needs layers under one parent",
                ));
            }
            let members = targets
                .iter()
                .map(|id| {
                    let item = find(&scene, id)?;
                    Ok((
                        id.as_str(),
                        item.local,
                        item.local.bounds(item.width, item.height),
                        item.hidden,
                        false,
                    ))
                })
                .collect::<Result<Vec<_>>>()?;
            let mut flow = Flow::new(snapshot, commands, &mut warnings);
            let new_id = flow.wrap(parent, &members, direction, suggest, 0, None)?;
            targets = vec![new_id];
        }
        let ids = targets.iter().map(|id| alias(id)).collect::<Vec<_>>();
        Ok(if suggest {
            json!({"ids":ids,"warnings":warnings})
        } else {
            json!({"ids":ids})
        })
    }
}

fn auto_layout(node: &Node) -> bool {
    node.properties
        .get("layout")
        .and_then(Value::as_object)
        .is_some_and(|layout| layout.get("type") != Some(&json!("none")))
        || node.properties.get("style").is_some_and(|style| {
            matches!(
                style["display"].as_str(),
                Some("flex" | "inline-flex" | "grid" | "inline-grid")
            )
        })
}

fn find<'a>(scene: &'a Scene, id: &str) -> Result<&'a SceneItem> {
    scene
        .item(id)
        .ok_or_else(|| EngineError::invalid("layer is outside the selected page"))
}

fn remove_layout_properties(node: &Node, item: &SceneItem) -> Value {
    let mut style = node
        .properties
        .get("style")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    style.retain(|key, _| {
        !key.starts_with("flex-")
            && !key.starts_with("grid-")
            && !key.starts_with("padding-")
            && !matches!(
                key.as_str(),
                "display"
                    | "gap"
                    | "row-gap"
                    | "column-gap"
                    | "padding"
                    | "align-items"
                    | "align-content"
                    | "justify-items"
                    | "justify-content"
            )
    });
    json!({"layout":{"type":"none"},"style":style,"width":item.width,"height":item.height})
}

fn local_patch(local: Affine) -> Value {
    let [a, b, c, d, x, y] = local.0;
    json!({"x":x,"y":y,"transform":[a,b,c,d,0.,0.]})
}

type Member<'a> = (&'a str, Affine, [f64; 4], bool, bool);

struct Flow<'a> {
    snapshot: &'a DocumentSnapshot,
    commands: &'a mut Vec<Command>,
    warnings: &'a mut Vec<String>,
}
impl<'a> Flow<'a> {
    fn new(
        snapshot: &'a DocumentSnapshot,
        commands: &'a mut Vec<Command>,
        warnings: &'a mut Vec<String>,
    ) -> Self {
        Self {
            snapshot,
            commands,
            warnings,
        }
    }

    fn wrap(
        &mut self,
        parent: &str,
        members: &[Member<'_>],
        direction: Option<&str>,
        suggest: bool,
        depth: usize,
        inherited: Option<(&str, &str)>,
    ) -> Result<String> {
        let [x, y, w, h] = union_bounds(members.iter().map(|member| member.2));
        let mut node = Node::new(NodeKind::Frame);
        node.parent_id = Some(parent.into());
        let first = members
            .iter()
            .map(|member| &self.snapshot.nodes[member.0])
            .min_by_key(|node| &node.rank)
            .unwrap();
        node.rank = inherited.map_or_else(|| first.rank.clone(), |(_, rank)| rank.into());
        node.home_shard = inherited.map_or_else(
            || self.snapshot.nodes[parent].home_shard.clone(),
            |(shard, _)| shard.into(),
        );
        node.properties = properties(
            &json!({"name":"Auto layout","x":x,"y":y,"width":w,"height":h,"fill":"transparent","clipContent":false}),
        )?;
        let id = node.id.clone();
        self.commands.push(Command::NodeCreate { node });
        let members = members
            .iter()
            .map(|(id, local, [left, top, w, h], skip, mask)| {
                (
                    *id,
                    Affine::translation(-x, -y).multiply(*local),
                    [*left - x, *top - y, *w, *h],
                    *skip,
                    *mask,
                )
            })
            .collect::<Vec<_>>();
        self.build(&id, [w, h], &members, direction, suggest, depth, true)?;
        Ok(id)
    }

    fn build(
        &mut self,
        frame: &str,
        size: [f64; 2],
        members: &[Member<'_>],
        direction: Option<&str>,
        suggest: bool,
        depth: usize,
        moved: bool,
    ) -> Result<()> {
        let eligible = members
            .iter()
            .filter(|member| !member.3)
            .map(|member| (member.0, member.2))
            .collect::<Vec<_>>();
        let boxes = union_bounds(eligible.iter().map(|item| item.1));
        let grid = direction == Some("grid");
        let can_split =
            suggest && !grid && !members.iter().any(|m| m.4) && depth < 8 && eligible.len() > 1;
        let vertical = match direction {
            Some("vertical" | "column") => true,
            Some("horizontal" | "row") => false,
            _ if can_split => bands(&eligible, 1).len() >= 2,
            _ => boxes[3] > boxes[2],
        };
        let axis = usize::from(vertical);
        let mut bands_on_axis = if can_split {
            bands(&eligible, axis)
        } else {
            Vec::new()
        };
        if can_split && bands_on_axis.len() < 2 {
            self.warnings
                .push("Some layers overlap along the layout direction".into());
            if direction.is_none() && bands(&eligible, 1 - axis).len() < 2 {
                if moved {
                    self.move_children(frame, members)?;
                }
                return Ok(());
            }
        }
        if bands_on_axis.len() < 2 {
            let mut ordered = eligible.clone();
            ordered.sort_by(|a, b| a.1[axis].total_cmp(&b.1[axis]));
            bands_on_axis = ordered.into_iter().map(|item| vec![item]).collect();
        }
        let extents = bands_on_axis
            .iter()
            .map(|band| union_bounds(band.iter().map(|item| item.1)))
            .collect::<Vec<_>>();
        let gaps = extents
            .windows(2)
            .map(|pair| (pair[1][axis] - pair[0][axis] - pair[0][axis + 2]).max(0.))
            .collect::<Vec<_>>();
        let gap = if gaps.is_empty() {
            if suggest { 0. } else { 10. }
        } else if suggest {
            let min = gaps.iter().copied().fold(f64::INFINITY, f64::min);
            let max = gaps.iter().copied().fold(0., f64::max);
            if max - min > 0.5 {
                self.warnings
                    .push("Gaps differ, so the smallest gap is used".into());
            }
            min
        } else {
            (gaps.iter().sum::<f64>() / gaps.len() as f64).round()
        };
        let padding = if eligible.is_empty() {
            [10.; 4]
        } else {
            [
                boxes[1],
                size[0] - boxes[0] - boxes[2],
                size[1] - boxes[1] - boxes[3],
                boxes[0],
            ]
            .map(|value| value.max(0.).round())
        };
        let mut layout = json!({"type":"flex","direction":if vertical {"column"} else {"row"},"alignItems":"flex-start","gap":gap,"padding":padding});
        if grid {
            let columns = bands(&eligible, 0).len().clamp(1, 1000);
            let rows = eligible.len().div_ceil(columns).clamp(1, 1000);
            layout["type"] = json!("grid");
            layout["columns"] = json!(vec!["auto"; columns]);
            layout["rows"] = json!(vec!["auto"; rows]);
        }
        self.commands.push(set(frame, json!({"layout":layout}))?);
        let shard = self
            .snapshot
            .nodes
            .get(frame)
            .map_or_else(
                || self.snapshot.nodes[members[0].0].home_shard.as_str(),
                |node| node.home_shard.as_str(),
            )
            .to_owned();
        if members.iter().any(|member| member.4) {
            if moved {
                self.move_children(frame, members)?;
            }
            return Ok(());
        }
        let mut sorted = members.to_vec();
        sorted.sort_by(|a, b| {
            if grid {
                a.2[1].total_cmp(&b.2[1]).then(a.2[0].total_cmp(&b.2[0]))
            } else {
                a.2[axis].total_cmp(&b.2[axis])
            }
        });
        if can_split && bands_on_axis.iter().any(|band| band.len() > 1) {
            let cross = 1 - axis;
            let first = extents[0][cross];
            if extents
                .iter()
                .any(|extent| (extent[cross] - first).abs() > 0.5)
            {
                self.warnings.push(
                    "Bands start at different offsets, so they are aligned at the smallest offset"
                        .into(),
                );
            }
            for (slot, band) in bands_on_axis.iter().enumerate() {
                let members = sorted
                    .iter()
                    .filter(|member| band.iter().any(|(id, _)| *id == member.0))
                    .copied()
                    .collect::<Vec<_>>();
                let rank = layout_rank(slot, bands_on_axis.len() + sorted.len());
                if members.len() > 1 {
                    self.wrap(
                        frame,
                        &members,
                        None,
                        true,
                        depth + 1,
                        Some((&shard, &rank)),
                    )?;
                } else {
                    self.move_child(frame, members[0], rank, moved)?;
                }
            }
            for (slot, member) in sorted.iter().filter(|member| member.3).copied().enumerate() {
                let rank = layout_rank(
                    bands_on_axis.len() + slot,
                    bands_on_axis.len() + sorted.len(),
                );
                self.move_child(frame, member, rank, moved)?;
            }
        } else {
            self.move_children_with_positions(frame, &sorted, moved)?;
        }
        Ok(())
    }

    fn move_children(&mut self, frame: &str, members: &[Member<'_>]) -> Result<()> {
        self.move_children_with_positions(frame, members, true)
    }
    fn move_children_with_positions(
        &mut self,
        frame: &str,
        members: &[Member<'_>],
        moved: bool,
    ) -> Result<()> {
        for (slot, member) in members.iter().copied().enumerate() {
            self.move_child(frame, member, layout_rank(slot, members.len()), moved)?;
        }
        Ok(())
    }
    fn move_child(
        &mut self,
        frame: &str,
        member: Member<'_>,
        rank: String,
        moved: bool,
    ) -> Result<()> {
        let (id, local, _, _, _) = member;
        self.commands.push(Command::NodeMove {
            node_id: id.into(),
            parent_id: Some(frame.into()),
            rank,
        });
        if moved {
            self.commands.push(set(id, local_patch(local))?);
        }
        Ok(())
    }
}

fn layout_rank(slot: usize, count: usize) -> String {
    format!(
        "{:032x}",
        (u128::MAX / (count as u128 + 1)) * (slot as u128 + 1)
    )
}

fn set_track(
    snapshot: &DocumentSnapshot,
    scene: &Scene,
    id: &str,
    params: &Value,
    commands: &mut Vec<Command>,
) -> Result<()> {
    let axis = match string(params, "axis")? {
        "columns" | "column" | "col" | "x" => 0,
        "rows" | "row" | "y" => 1,
        _ => return Err(EngineError::invalid("axis must be columns or rows")),
    };
    let node = &snapshot.nodes[id];
    let key = if axis == 0 { "columns" } else { "rows" };
    let item = find(scene, id)?;
    let mut layout = node
        .properties
        .get("layout")
        .filter(|layout| layout["type"] == "grid")
        .cloned()
        .ok_or_else(|| EngineError::invalid("layer is not a grid auto layout frame"))?;
    let mut tracks = layout[key]
        .as_array()
        .cloned()
        .ok_or_else(|| EngineError::invalid("grid tracks unavailable"))?;
    let index = optional_index(params, "index")?
        .filter(|index| *index < tracks.len())
        .ok_or_else(|| EngineError::invalid("grid track index out of bounds"))?;
    let value = optional_number(params, "value")?;
    let track = match string(params, "sizing")? {
        "hug" => "auto".into(),
        "fill" => format!("{}fr", value.unwrap_or(1.).clamp(0., 1e4)),
        "fixed" => {
            let old = tracks[index].as_f64().or_else(|| {
                tracks[index]
                    .as_str()?
                    .strip_suffix("px")?
                    .parse::<f64>()
                    .ok()
            });
            let inferred = || {
                let axis_size = if axis == 0 { item.width } else { item.height };
                let gap = layout
                    .get(if axis == 0 { "columnGap" } else { "rowGap" })
                    .or_else(|| layout.get("gap"))
                    .and_then(Value::as_f64)
                    .unwrap_or(0.);
                let padding = layout["padding"].as_array();
                let pad = |i| {
                    padding
                        .and_then(|p| p.get(i))
                        .and_then(Value::as_f64)
                        .unwrap_or(0.)
                };
                let inset = if axis == 0 {
                    pad(1) + pad(3)
                } else {
                    pad(0) + pad(2)
                };
                (axis_size - inset - gap * (tracks.len().saturating_sub(1)) as f64)
                    / tracks.len() as f64
            };
            format!(
                "{}px",
                value.or(old).unwrap_or_else(inferred).clamp(0., 1e6)
            )
        }
        _ => return Err(EngineError::invalid("sizing must be fixed, hug or fill")),
    };
    tracks[index] = json!(track);
    layout[key] = json!(tracks);
    commands.push(set(id, json!({"layout":layout}))?);
    Ok(())
}
