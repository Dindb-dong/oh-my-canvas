use super::*;

pub(super) fn object_affine(name: &str, pivot: (f64, f64)) -> Affine {
    let matrix = match name {
        "object.flipH" => [-1., 0., 0., 1., 0., 0.],
        "object.flipV" => [1., 0., 0., -1., 0., 0.],
        "object.rotate180" => [-1., 0., 0., -1., 0., 0.],
        "object.rotateLeft" => [0., -1., 1., 0., 0., 0.],
        "object.rotateRight" => [0., 1., -1., 0., 0., 0.],
        _ => Affine::IDENTITY.0,
    };
    around(pivot, Affine(matrix))
}

impl ToolRouter {
    pub(super) fn fig_set_thumbnail(
        &self,
        session: &str,
        snapshot: &DocumentSnapshot,
        id: &str,
    ) -> Result<Value> {
        if snapshot.nodes[id].parent_id.is_none() {
            return Err(EngineError::invalid(
                "select a layer to use as the thumbnail",
            ));
        }
        if snapshot.nodes[id].properties.get("figThumbnail") != Some(&Value::Bool(true))
            || snapshot
                .nodes
                .values()
                .any(|node| node.id != id && node.properties.contains_key("figThumbnail"))
        {
            let mut commands = Vec::new();
            let mut preview = snapshot.clone();
            for node in preview.nodes.values_mut() {
                if node.id == id {
                    node.properties.insert("figThumbnail".into(), json!(true));
                    commands.push(Command::NodeSet {
                        node_id: id.into(),
                        properties: Properties::from([("figThumbnail".into(), json!(true))]),
                    });
                } else if node.properties.remove("figThumbnail").is_some() {
                    commands.push(Command::NodeUnset {
                        node_id: node.id.clone(),
                        properties: vec!["figThumbnail".into()],
                    });
                }
            }
            self.thumbnail_png(&preview)?
                .ok_or_else(|| EngineError::invalid("selected layer has no thumbnail bounds"))?;
            self.submit(
                session,
                &snapshot.id,
                Command::Batch { commands },
                &Value::Null,
                Some(snapshot.sequence),
            )?;
        }
        Ok(json!({"ok":true}))
    }

    pub(super) fn fig_object_style(
        &self,
        session: &str,
        snapshot: &DocumentSnapshot,
        ids: &[String],
        name: &str,
        params: &Value,
    ) -> Result<Value> {
        let mut names = Vec::new();
        let mut commands = Vec::new();
        if name == "object.batchRename" {
            for (id, name) in rename::plan(snapshot, ids, params)? {
                let alias = self.fig_alias(session, &snapshot.id, &id);
                if snapshot.nodes[&id].string("name") != Some(&name) {
                    commands.push(Command::NodeSet {
                        node_id: id,
                        properties: Properties::from([("name".into(), json!(name))]),
                    });
                }
                names.push(json!({"id":alias,"name":name}));
            }
        } else {
            let refs = omc_style::ReferenceContext::new(snapshot);
            for id in ids {
                let node = &snapshot.nodes[id];
                let (properties, _) = refs.properties(node);
                let fills = design::paint_stack(&properties, node.kind, "fills", "fill");
                let strokes = design::paint_stack(&properties, node.kind, "strokes", "stroke");
                let color = |paints: &[Value]| {
                    paints
                        .iter()
                        .rev()
                        .find(|p| p["visible"] != false && p["hidden"] != true)
                        .and_then(|p| p["color"].as_str())
                        .unwrap_or("transparent")
                        .to_owned()
                };
                let links = ["fillStyleId", "strokeStyleId"]
                    .into_iter()
                    .filter(|key| node.properties.contains_key(*key))
                    .map(str::to_owned)
                    .collect::<Vec<_>>();
                if !links.is_empty() {
                    commands.push(Command::NodeUnset {
                        node_id: id.clone(),
                        properties: links,
                    });
                }
                commands.push(Command::NodeSet {
                    node_id: id.clone(),
                    properties: Properties::from([
                        ("fill".into(), json!(color(&strokes))),
                        ("stroke".into(), json!(color(&fills))),
                        ("fills".into(), json!(strokes)),
                        ("strokes".into(), json!(fills)),
                    ]),
                });
            }
        }
        if !commands.is_empty() {
            self.submit(
                session,
                &snapshot.id,
                Command::Batch { commands },
                &Value::Null,
                Some(snapshot.sequence),
            )?;
        }
        Ok(if name == "object.batchRename" {
            json!({"names":names})
        } else {
            json!({"ok":true})
        })
    }

    pub(super) fn fig_container_operation(
        &self,
        session: &str,
        snapshot: &DocumentSnapshot,
        state: &ViewState,
        selection: &[Value],
        name: &str,
        params: &Value,
    ) -> Result<Value> {
        let ids = geometry_targets(self, session, snapshot, selection, params)?;
        let document = &snapshot.id;
        let scene = paths::scene(snapshot, &state.page_id)?;
        let items = geometry_items(&scene, &ids)?;
        let mut output = Vec::new();
        let mut commands = Vec::new();
        let mut new_selection = None;
        match name {
            "object.moveToPage" => {
                let root = self.fig_layer(session, snapshot, &params["page"])?;
                let page = snapshot
                    .pages
                    .iter()
                    .find(|page| page.root_node_id == root)
                    .ok_or_else(|| EngineError::invalid("target must be a page"))?;
                if page.id != state.page_id {
                    let target = paths::scene(snapshot, &page.id)?;
                    let inverse = target.items[target.root].world.inverse().ok_or_else(|| {
                        EngineError::invalid("target page transform is not invertible")
                    })?;
                    let selected = BTreeSet::from_iter(ids.iter().map(String::as_str));
                    let mut moved = items
                        .into_iter()
                        .filter(|item| !has_selected_parent(item, &scene, &selected))
                        .collect::<Vec<_>>();
                    moved.sort_by_key(|item| {
                        scene
                            .items
                            .iter()
                            .position(|other| other.id == item.id)
                            .unwrap_or(usize::MAX)
                    });
                    let siblings = children(snapshot, &root);
                    let mut rank = siblings.last().map(|node| node.rank.clone());
                    for item in moved {
                        commands.push(Command::NodeSet {
                            node_id: item.id.clone(),
                            properties: vector::absolute_placement(
                                item,
                                inverse.multiply(item.world),
                            ),
                        });
                        let next = rank_between(rank.as_deref(), None).ok_or_else(|| {
                            EngineError::new(
                                "resource_limit",
                                "target page ordering requires rank rebalance",
                            )
                        })?;
                        commands.push(Command::NodeMove {
                            node_id: item.id.clone(),
                            parent_id: Some(root.clone()),
                            rank: next.clone(),
                        });
                        rank = Some(next);
                        output.push(item.id.clone());
                    }
                }
                new_selection = Some(Vec::new());
            }
            "object.rasterize" => {
                let scale = optional_number(params, "scale")?.unwrap_or(2.);
                if !(0.01..=8.).contains(&scale) {
                    return Err(EngineError::invalid("raster scale must be 0.01–8"));
                }
                let selected = BTreeSet::from_iter(ids.iter().map(String::as_str));
                let store = self.resources()?.0;
                for item in items
                    .into_iter()
                    .filter(|item| !has_selected_parent(item, &scene, &selected))
                {
                    let parent = &scene.items[item.parent.unwrap()];
                    let inverse = parent.world.inverse().ok_or_else(|| {
                        EngineError::invalid("parent transform is not invertible")
                    })?;
                    let mut drawable = Vec::new();
                    let mut pending = vec![item];
                    while let Some(child) = pending.pop() {
                        if child.hidden {
                            continue;
                        }
                        drawable.push(child.bounds);
                        if !child.clip && child.boolean_operation().is_none() {
                            pending.extend(child.children.iter().map(|&index| &scene.items[index]));
                        }
                    }
                    let [x, y, width, height] = union(drawable.into_iter()).ok_or_else(|| {
                        EngineError::invalid("selection has no drawable geometry")
                    })?;
                    let (width, height) = (width.max(1.), height.max(1.));
                    let artifact = self.export_snapshot_native(
                        snapshot.clone(),
                        &json!({
                            "format":"png","pageId":state.page_id,"ids":[item.id],"scale":scale,
                            "bounds":{"x":x,"y":y,"width":width,"height":height},
                        }),
                    )?;
                    let asset = store.ingest(&artifact.bytes, "image/png")?;
                    let [a, b, c, d, local_x, local_y] =
                        inverse.multiply(Affine::translation(x, y)).0;
                    let mut image = vector::sibling(snapshot, item, parent, NodeKind::Image);
                    vector::set_position(&mut image.properties, local_x, local_y, width, height);
                    image.properties.extend([
                        (
                            "name".into(),
                            json!(
                                snapshot.nodes[&item.id]
                                    .string("name")
                                    .unwrap_or("Rasterized")
                            ),
                        ),
                        ("transform".into(), json!([a, b, c, d, 0., 0.])),
                        ("imageFit".into(), json!("fill")),
                        ("assetHash".into(), json!(asset.hash)),
                    ]);
                    output.push(image.id.clone());
                    commands.push(Command::NodeCreate { node: image });
                    let mut remove = Vec::new();
                    let mut pending = vec![item.id.clone()];
                    while let Some(id) = pending.pop() {
                        pending
                            .extend(children(snapshot, &id).iter().map(|child| child.id.clone()));
                        remove.push(id);
                    }
                    commands.push(Command::NodeDelete { node_ids: remove });
                }
                new_selection = Some(output.clone());
            }
            "object.resizeToFit" => {
                let selected = BTreeSet::from_iter(ids.iter().map(String::as_str));
                for item in items
                    .into_iter()
                    .filter(|item| !has_selected_parent(item, &scene, &selected))
                {
                    if !matches!(item.kind, NodeKind::Frame | NodeKind::Component)
                        || item.children.is_empty()
                    {
                        continue;
                    }
                    let node = &snapshot.nodes[&item.id];
                    if node.properties.get("layout").is_some_and(Value::is_object)
                        || matches!(item.style.get("display"), Some("flex" | "grid"))
                    {
                        let mut style = authored_style(node);
                        style.insert("width".into(), json!("max-content"));
                        style.insert("height".into(), json!("max-content"));
                        commands.push(Command::NodeSet {
                            node_id: item.id.clone(),
                            properties: Properties::from([("style".into(), Value::Object(style))]),
                        });
                    } else {
                        let kids = item
                            .children
                            .iter()
                            .map(|&index| &scene.items[index])
                            .filter(|child| snapshot.nodes.contains_key(&child.id))
                            .collect::<Vec<_>>();
                        let Some([x, y, w, h]) = union(
                            kids.iter()
                                .filter(|child| !child.hidden)
                                .map(|child| child.local.bounds(child.width, child.height)),
                        ) else {
                            continue;
                        };
                        let shift = Affine::translation(x, y);
                        let mut patch =
                            vector::absolute_placement(item, item.local.multiply(shift));
                        patch.insert("width".into(), json!(w.max(0.01)));
                        patch.insert("height".into(), json!(h.max(0.01)));
                        commands.push(Command::NodeSet {
                            node_id: item.id.clone(),
                            properties: patch,
                        });
                        for child in kids {
                            commands.push(Command::NodeSet {
                                node_id: child.id.clone(),
                                properties: vector::absolute_placement(
                                    child,
                                    Affine::translation(-x, -y).multiply(child.local),
                                ),
                            });
                        }
                    }
                    output.push(item.id.clone());
                }
            }
            "object.wrapInSection" => {
                let parent_index = items[0].parent.unwrap();
                let parent = &scene.items[parent_index];
                if items.iter().any(|item| item.parent != Some(parent_index))
                    || parent.id != state.root && !is_section(&snapshot.nodes[&parent.id])
                {
                    return Err(EngineError::invalid(
                        "choose siblings on a page or inside a section",
                    ));
                }
                let title = params
                    .get("name")
                    .map(|_| string(params, "name"))
                    .transpose()?
                    .unwrap_or("Section");
                let [left, top, width, height] = union(
                    items
                        .iter()
                        .map(|item| item.local.bounds(item.width, item.height)),
                )
                .unwrap();
                let pad = 48.;
                let x = left - pad;
                let y = top - pad;
                let mut section = vector::sibling(snapshot, items[0], parent, NodeKind::Frame);
                section.rank = ids
                    .iter()
                    .map(|id| &snapshot.nodes[id].rank)
                    .min()
                    .unwrap()
                    .clone();
                vector::set_position(
                    &mut section.properties,
                    x,
                    y,
                    width + 2. * pad,
                    height + 2. * pad,
                );
                section.properties.extend([
                    ("isSection".into(), json!(true)),
                    ("name".into(), json!(title)),
                    ("fill".into(), json!("#f4f4f4")),
                    ("stroke".into(), json!("#777777")),
                    ("strokeWidth".into(), json!(1.)),
                ]);
                let section_id = section.id.clone();
                commands.push(Command::NodeCreate { node: section });
                for item in items {
                    commands.push(Command::NodeSet {
                        node_id: item.id.clone(),
                        properties: vector::absolute_placement(
                            item,
                            Affine::translation(-x, -y).multiply(item.local),
                        ),
                    });
                    commands.push(Command::NodeMove {
                        node_id: item.id.clone(),
                        parent_id: Some(section_id.clone()),
                        rank: snapshot.nodes[&item.id].rank.clone(),
                    });
                }
                output.push(section_id.clone());
                new_selection = Some(vec![section_id]);
            }
            "object.convertToSection" | "object.convertToFrame" | "object.convertToGroup" => {
                let to_section = name == "object.convertToSection";
                let to_group = name == "object.convertToGroup";
                for item in items {
                    let node = &snapshot.nodes[&item.id];
                    let parent = &scene.items[item.parent.unwrap()];
                    if !matches!(item.kind, NodeKind::Frame | NodeKind::Group) {
                        return Err(EngineError::invalid(
                            "choose a native frame, section or group",
                        ));
                    }
                    let was_section = is_section(node);
                    if to_group && item.kind == NodeKind::Group
                        || to_section && was_section
                        || !to_group && !to_section && item.kind == NodeKind::Frame && !was_section
                    {
                        continue;
                    }
                    if to_section
                        && (item.kind != NodeKind::Frame
                            || parent.id != state.root && !is_section(&snapshot.nodes[&parent.id]))
                    {
                        return Err(EngineError::invalid(
                            "only frames on a page or in a section can become a section",
                        ));
                    }
                    if !to_section
                        && item.children.iter().any(|&index| {
                            snapshot
                                .nodes
                                .get(&scene.items[index].id)
                                .is_some_and(is_section)
                        })
                    {
                        return Err(EngineError::invalid(
                            "remove nested sections before converting the container",
                        ));
                    }
                    if to_group && (item.children.is_empty() || was_section) {
                        return Err(EngineError::invalid("choose a nonempty frame"));
                    }
                    let mut style = authored_style(node);
                    for key in [
                        "display",
                        "overflow",
                        "overflow-x",
                        "overflow-y",
                        "flex-direction",
                        "flex-wrap",
                        "grid-template-columns",
                        "grid-template-rows",
                        "gap",
                        "row-gap",
                        "column-gap",
                    ] {
                        style.remove(key);
                    }
                    let clear_paint = to_group || item.kind == NodeKind::Group;
                    if clear_paint {
                        style.retain(|key, _| {
                            !key.starts_with("background") && !key.starts_with("border")
                        });
                    }
                    let mut patch = Properties::from([
                        ("isSection".into(), json!(to_section)),
                        ("sectionContentsHidden".into(), json!(false)),
                        ("clipContent".into(), json!(false)),
                        ("style".into(), Value::Object(style)),
                        (
                            "containerKindOverride".into(),
                            json!(if to_group { "group" } else { "frame" }),
                        ),
                    ]);
                    let kids = item
                        .children
                        .iter()
                        .map(|&index| &scene.items[index])
                        .filter(|child| snapshot.nodes.contains_key(&child.id))
                        .collect::<Vec<_>>();
                    let mut shift = (0., 0.);
                    if to_group
                        && let Some([x, y, w, h]) = union(
                            kids.iter()
                                .filter(|child| !child.hidden)
                                .map(|child| child.local.bounds(child.width, child.height)),
                        )
                    {
                        let mut fit = vector::absolute_placement(
                            item,
                            item.local.multiply(Affine::translation(x, y)),
                        );
                        // Keep the cleaned authored style and use the fit geometry.
                        fit.remove("style");
                        patch.extend(fit);
                        patch.insert("width".into(), json!(w.max(0.01)));
                        patch.insert("height".into(), json!(h.max(0.01)));
                        shift = (x, y);
                    }
                    let mut unset = ["layout", "layoutGrids", "guides", "scrollOverflow"]
                        .map(str::to_owned)
                        .to_vec();
                    if clear_paint {
                        unset.extend(
                            [
                                "fill",
                                "fills",
                                "fillStyleId",
                                "stroke",
                                "strokes",
                                "strokeStyleId",
                                "strokeWidth",
                                "cornerRadius",
                            ]
                            .map(str::to_owned),
                        );
                    }
                    commands.push(Command::NodeSet {
                        node_id: item.id.clone(),
                        properties: patch,
                    });
                    commands.push(Command::NodeUnset {
                        node_id: item.id.clone(),
                        properties: unset,
                    });
                    for child in kids {
                        commands.push(Command::NodeSet {
                            node_id: child.id.clone(),
                            properties: vector::absolute_placement(
                                child,
                                Affine::translation(-shift.0, -shift.1).multiply(child.local),
                            ),
                        });
                    }
                    output.push(item.id.clone());
                }
            }
            "section.toggleContents" => {
                if items
                    .iter()
                    .any(|item| !is_section(&snapshot.nodes[&item.id]))
                {
                    return Err(EngineError::invalid("choose sections"));
                }
                let hidden = optional_flag(params, "hidden")?.unwrap_or_else(|| {
                    items.iter().any(|item| {
                        item.properties.get("sectionContentsHidden") != Some(&Value::Bool(true))
                    })
                });
                for item in items {
                    commands.push(Command::NodeSet {
                        node_id: item.id.clone(),
                        properties: Properties::from([(
                            "sectionContentsHidden".into(),
                            json!(hidden),
                        )]),
                    });
                    output.push(item.id.clone());
                }
            }
            _ => return Err(EngineError::invalid("unknown container operation")),
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
        let alias = |id: &String| json!(self.fig_alias(session, document, id));
        if let Some(new_selection) = new_selection {
            let new_selection = new_selection.iter().map(alias).collect::<Vec<_>>();
            self.fig_selection(&(session.into(), document.clone()), &new_selection);
        }
        let ids = output.iter().map(alias).collect::<Vec<_>>();
        Ok(json!({"id":ids.first(),"ids":ids}))
    }
}

fn is_section(node: &Node) -> bool {
    node.kind == NodeKind::Frame && node.properties.get("isSection") == Some(&Value::Bool(true))
}

fn authored_style(node: &Node) -> serde_json::Map<String, Value> {
    match node.properties.get("style") {
        Some(Value::Object(style)) => style.clone(),
        Some(Value::String(style)) => omc_style::parse_declarations(style)
            .into_iter()
            .map(|decl| {
                (
                    decl.name,
                    json!(if decl.important {
                        format!("{} !important", decl.value)
                    } else {
                        decl.value
                    }),
                )
            })
            .collect(),
        _ => Default::default(),
    }
}

fn union(bounds: impl Iterator<Item = [f64; 4]>) -> Option<[f64; 4]> {
    bounds
        .map(|[x, y, w, h]| [x, y, x + w, y + h])
        .reduce(|[x, y, r, b], [a, c, d, e]| [x.min(a), y.min(c), r.max(d), b.max(e)])
        .map(|[x, y, r, b]| [x, y, r - x, b - y])
}

fn has_selected_parent(item: &SceneItem, scene: &Scene, selected: &BTreeSet<&str>) -> bool {
    let mut parent = item.parent;
    while let Some(index) = parent {
        if selected.contains(scene.items[index].id.as_str()) {
            return true;
        }
        parent = scene.items[index].parent;
    }
    false
}
