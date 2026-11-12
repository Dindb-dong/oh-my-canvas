use super::*;

impl ToolRouter {
    pub(super) fn fig_selection_set_paint(
        &self,
        session: &str,
        snapshot: &DocumentSnapshot,
        args: &Value,
    ) -> Result<Value> {
        let targets = args["targets"]
            .as_array()
            .filter(|targets| (1..=1024).contains(&targets.len()))
            .ok_or_else(|| EngineError::invalid("targets must have 1–1024 paint slots"))?;
        let paint = args
            .get("paint")
            .ok_or_else(|| EngineError::invalid("paint is required"))?;
        let paint = design::normalize_selection_paint(Some(paint), "#000000")?;
        let refs = omc_style::ReferenceContext::new(snapshot);
        let mut stacks = std::collections::BTreeMap::new();
        let mut commands = Vec::new();
        for target in targets {
            let id = self.fig_layer(session, snapshot, &target["id"])?;
            let node = &snapshot.nodes[&id];
            if node.properties.get("locked") == Some(&Value::Bool(true)) {
                return Err(EngineError::invalid("paint target layer is locked"));
            }
            let fills = target["fills"]
                .as_bool()
                .ok_or_else(|| EngineError::invalid("paint target fills must be a boolean"))?;
            let index = target["index"]
                .as_u64()
                .and_then(|index| usize::try_from(index).ok())
                .ok_or_else(|| EngineError::invalid("paint target index is required"))?;
            let (stack, single, _) = paint_keys(fills);
            if !target["range"].is_null() {
                let range = target["range"]
                    .as_array()
                    .filter(|range| range.len() == 2 && range.iter().all(|v| v.is_u64()))
                    .ok_or_else(|| EngineError::invalid("text paint range requires [start,end]"))?;
                if !fills || index != 0 {
                    return Err(EngineError::invalid(
                        "a text range has one foreground paint",
                    ));
                }
                text::mark_selection_paint(node, range, &paint, &mut commands)?;
                continue;
            }
            let entry = stacks.entry((id, fills)).or_insert_with(|| {
                let (properties, _) = refs.properties(node);
                let before = design::paint_stack(&properties, node.kind, stack, single);
                (before.clone(), before)
            });
            let slot = entry
                .1
                .get_mut(index)
                .ok_or_else(|| EngineError::invalid("selection paint slot no longer exists"))?;
            *slot = paint.clone();
        }
        for ((id, fills), (before, mut paints)) in stacks {
            if before == paints {
                continue;
            }
            let (stack, single, link) = paint_keys(fills);
            let node = &snapshot.nodes[&id];
            let reference_exists = node.properties.contains_key(link);
            if !reference_exists {
                let authored = design::paint_stack(&node.properties, node.kind, stack, single);
                for (index, current) in paints.iter_mut().enumerate() {
                    if before.get(index) == Some(current)
                        && let Some(value) = authored.get(index)
                    {
                        *current = value.clone();
                    }
                }
            }
            let top = paints
                .iter()
                .rev()
                .find(|paint| paint["visible"] != false && paint["hidden"] != true)
                .and_then(|value| value["color"].as_str())
                .unwrap_or("transparent")
                .to_owned();
            if reference_exists {
                commands.push(Command::NodeUnset {
                    node_id: id.clone(),
                    properties: vec![link.into()],
                });
            }
            commands.push(Command::NodeSet {
                node_id: id,
                properties: Properties::from([
                    (stack.into(), json!(paints)),
                    (single.into(), json!(top)),
                ]),
            });
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
        Ok(json!({"ok":true}))
    }
}

fn paint_keys(fills: bool) -> (&'static str, &'static str, &'static str) {
    if fills {
        ("fills", "fill", "fillStyleId")
    } else {
        ("strokes", "stroke", "strokeStyleId")
    }
}
