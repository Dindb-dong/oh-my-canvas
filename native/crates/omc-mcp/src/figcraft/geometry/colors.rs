use super::*;

pub(super) fn paint_list(node: &Node, properties: &Properties, fills: bool) -> Vec<Value> {
    if fills {
        design::paint_stack(properties, node.kind, "fills", "fill")
    } else {
        design::paint_stack(properties, node.kind, "strokes", "stroke")
    }
}

pub(super) fn run_fills(node: &Node, base: &[Value]) -> Vec<(Option<[usize; 2]>, Vec<Value>)> {
    let Some(runs) = node
        .properties
        .get("textRuns")
        .and_then(Value::as_array)
        .filter(|runs| runs.iter().any(|run| run["attributes"]["fill"].is_string()))
    else {
        return vec![(None, base.to_vec())];
    };
    let mut cursor = 0;
    let mut lists = Vec::new();
    for run in runs {
        let start = cursor;
        cursor += run["text"].as_str().unwrap_or_default().chars().count();
        if cursor > start {
            let color = run["attributes"]["fill"].as_str();
            let paints = color.map_or_else(
                || base.to_vec(),
                |color| vec![json!({"type":"solid","color":color})],
            );
            lists.push((Some([start, cursor]), paints));
        }
    }
    lists
}

pub(super) fn canonical_paint(paint: &Value) -> Value {
    let mut paint = paint.clone();
    if let Some(fields) = paint.as_object_mut() {
        for key in ["width", "align", "cap", "join", "dash"] {
            fields.remove(key);
        }
        for (key, default) in [
            ("visible", json!(true)),
            ("hidden", json!(false)),
            ("opacity", json!(1.)),
        ] {
            if fields.get(key) == Some(&default) {
                fields.remove(key);
            }
        }
        if let Some(value) = fields.get_mut("color") {
            if let Some(hex) = value.as_str().filter(|color| color.starts_with('#')) {
                *value = json!(hex.to_ascii_uppercase());
            }
        }
    }
    paint
}

impl ToolRouter {
    pub(super) fn fig_selection_colors(
        &self,
        session: &str,
        snapshot: &DocumentSnapshot,
        state: &ViewState,
        selection: &[Value],
        name: &str,
        params: &Value,
    ) -> Result<Value> {
        let references = omc_style::ReferenceContext::new(snapshot);
        if name == "selection.selectColor" {
            let targets = params["targets"]
                .as_array()
                .filter(|items| (1..=1024).contains(&items.len()))
                .ok_or_else(|| EngineError::invalid("targets must have 1–1024 paint slots"))?;
            let mut layers = BTreeMap::new();
            for target in targets {
                let raw = self.fig_layer(session, snapshot, &target["id"])?;
                let node = &snapshot.nodes[&raw];
                let fills = target["fills"]
                    .as_bool()
                    .ok_or_else(|| EngineError::invalid("paint target fills must be a boolean"))?;
                let index = target["index"]
                    .as_u64()
                    .and_then(|n| usize::try_from(n).ok())
                    .ok_or_else(|| EngineError::invalid("paint target index is required"))?;
                let (properties, _) = references.properties(node);
                let paints = paint_list(node, &properties, fills);
                let count = if target["range"].is_null() {
                    paints.len()
                } else {
                    let [start, end]: [usize; 2] = serde_json::from_value(target["range"].clone())
                        .map_err(|_| EngineError::invalid("invalid text color range"))?;
                    let text = node.string("text").unwrap_or("");
                    if !fills
                        || node.kind != NodeKind::Text
                        || start > end
                        || (start == end && end != 0)
                        || end > text.chars().count()
                    {
                        return Err(EngineError::invalid(
                            "text color range is outside the layer",
                        ));
                    }
                    run_fills(node, &paints)
                        .into_iter()
                        .find(|(range, _)| range.is_none_or(|[a, b]| a <= start && start < b))
                        .map_or(0, |(_, paints)| paints.len())
                };
                if index >= count {
                    return Err(EngineError::invalid(
                        "selection paint slot no longer exists",
                    ));
                }
                let alias = self.fig_alias(session, &snapshot.id, &raw);
                layers.insert(alias, raw);
            }
            if let Some((_, first)) = layers.first_key_value() {
                let mut root = &snapshot.nodes[first];
                while let Some(parent) = root
                    .parent_id
                    .as_ref()
                    .and_then(|id| snapshot.nodes.get(id))
                {
                    root = parent;
                }
                if root.id != state.root {
                    let root = self.fig_alias(session, &snapshot.id, &root.id);
                    self.fig_page_command(
                        session,
                        snapshot,
                        state,
                        "page.select",
                        &json!({"id":root}),
                    )?;
                }
            }
            let ids = layers.keys().map(|id| json!(id)).collect::<Vec<_>>();
            self.fig_selection(&(session.into(), snapshot.id.clone()), &ids);
            return Ok(json!({"ids":ids}));
        }

        let ids = self.fig_layers(session, snapshot, fig_ids(params, selection)?)?;
        let mut pending = ids.iter().rev().map(String::as_str).collect::<Vec<_>>();
        let mut child_index = BTreeMap::<&str, Vec<&Node>>::new();
        for node in snapshot.nodes.values() {
            if let Some(parent) = node.parent_id.as_deref() {
                child_index.entry(parent).or_default().push(node);
            }
        }
        for children in child_index.values_mut() {
            children.sort_by_key(|node| (&node.rank, &node.id));
        }
        let mut visited = BTreeSet::new();
        let mut group_index = BTreeMap::new();
        let mut groups: Vec<(Value, Option<&str>, Option<String>, Vec<Value>)> = Vec::new();
        while let Some(id) = pending.pop() {
            let node = &snapshot.nodes[id];
            if !visited.insert(id) || node.properties.get("mask") == Some(&Value::Bool(true)) {
                continue;
            }
            if node.string("booleanOperation").is_none() {
                if let Some(children) = child_index.get(id) {
                    pending.extend(children.iter().rev().map(|node| node.id.as_str()));
                }
            }
            let (effective, _) = references.properties(node);
            let fills = paint_list(node, &effective, true);
            let strokes = paint_list(node, &effective, false);
            let lists = run_fills(node, &fills)
                .into_iter()
                .map(|(range, paints)| (true, range, paints))
                .chain(std::iter::once((false, None, strokes)));
            for (fills, range, paints) in lists {
                let style_key = if fills {
                    "fillStyleId"
                } else {
                    "strokeStyleId"
                };
                let authored = paint_list(node, &node.properties, fills);
                for (index, paint) in paints.into_iter().enumerate() {
                    if paint["visible"] == false
                        || paint["hidden"] == true
                        || matches!(paint["type"].as_str(), Some("image" | "pattern"))
                    {
                        continue;
                    }
                    let paint = canonical_paint(&paint);
                    let inherits = range.is_none_or(|[start, _]| {
                        let mut cursor = 0;
                        node.properties
                            .get("textRuns")
                            .and_then(Value::as_array)
                            .is_none_or(|runs| {
                                runs.iter()
                                    .find(|run| {
                                        cursor +=
                                            run["text"].as_str().unwrap_or("").chars().count();
                                        start < cursor
                                    })
                                    .is_none_or(|run| run["attributes"]["fill"].is_null())
                            })
                    });
                    let style = inherits.then(|| node.string(style_key)).flatten();
                    let variable = inherits
                        .then(|| {
                            authored
                                .get(index)
                                .and_then(|paint| paint["color"]["$token"].as_str())
                                .map(str::to_owned)
                        })
                        .flatten();
                    let key = (style, variable.clone(), paint.to_string());
                    let target = json!({"id":self.fig_alias(session,&snapshot.id,id),"fills":fills,"index":index,"range":range});
                    if let Some(&group) = group_index.get(&key) {
                        let group: &mut (Value, Option<&str>, Option<String>, Vec<Value>) =
                            &mut groups[group];
                        group.3.push(target);
                    } else {
                        group_index.insert(key, groups.len());
                        groups.push((paint, style, variable, vec![target]));
                    }
                }
            }
        }
        Ok(
            json!({"colors":groups.into_iter().map(|(paint,style,variable,targets)|
            json!({"paint":paint,"style":style,"variable":variable,"targets":targets})).collect::<Vec<_>>() }),
        )
    }
}
