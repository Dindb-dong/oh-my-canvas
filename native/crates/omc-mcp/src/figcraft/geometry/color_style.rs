use super::{
    colors::{canonical_paint, paint_list, run_fills},
    *,
};
use crate::figcraft_catalog::{append_style_apply, catalog, entry, paint_style};
use omc_style::ReferenceContext;

struct Slot<'a> {
    node: &'a Node,
    fills: bool,
    index: usize,
    range: Option<[usize; 2]>,
    inherited: bool,
    effective: Vec<Value>,
    authored: Vec<Value>,
}

impl Slot<'_> {
    fn paint(&self) -> &Value {
        &self.effective[self.index]
    }

    fn style_target(&self) -> &str {
        if self.fills { "fill" } else { "stroke" }
    }

    fn local_paints(&self) -> &[Value] {
        if self.inherited && self.authored.len() == self.effective.len() {
            &self.authored
        } else {
            &self.effective
        }
    }
}

impl ToolRouter {
    fn fig_paint_slots<'a>(
        &self,
        session: &str,
        snapshot: &'a DocumentSnapshot,
        refs: &ReferenceContext<'_>,
        params: &Value,
    ) -> Result<Vec<Slot<'a>>> {
        let targets = params["targets"]
            .as_array()
            .filter(|items| (1..=1024).contains(&items.len()))
            .ok_or_else(|| EngineError::invalid("targets must have 1–1024 paint slots"))?;
        targets
            .iter()
            .map(|target| {
                let raw = self.fig_layer(session, snapshot, &target["id"])?;
                let node = &snapshot.nodes[&raw];
                if node.properties.get("locked") == Some(&Value::Bool(true)) {
                    return Err(EngineError::invalid("paint target layer is locked"));
                }
                let fills = target["fills"]
                    .as_bool()
                    .ok_or_else(|| EngineError::invalid("paint target fills must be a boolean"))?;
                let index = target["index"]
                    .as_u64()
                    .and_then(|index| usize::try_from(index).ok())
                    .ok_or_else(|| EngineError::invalid("invalid paint target index"))?;
                let range = if target["range"].is_null() {
                    None
                } else {
                    let [start, end]: [usize; 2] = serde_json::from_value(target["range"].clone())
                        .map_err(|_| EngineError::invalid("invalid text paint range"))?;
                    if !fills
                        || node.kind != NodeKind::Text
                        || start >= end
                        || end > node.string("text").unwrap_or("").chars().count()
                    {
                        return Err(EngineError::invalid(
                            "text paint range is outside the layer",
                        ));
                    }
                    Some([start, end])
                };
                let (properties, _) = refs.properties(node);
                let base = paint_list(node, &properties, fills);
                let effective = if let Some([start, _]) = range {
                    run_fills(node, &base)
                        .into_iter()
                        .find(|(range, _)| range.is_none_or(|[a, b]| a <= start && start < b))
                        .map(|(_, paints)| paints)
                        .unwrap_or_default()
                } else {
                    base.clone()
                };
                if index >= effective.len() {
                    return Err(EngineError::invalid(
                        "selection paint slot no longer exists",
                    ));
                }
                let inherited = range.is_none_or(|[start, _]| {
                    let mut cursor = 0;
                    node.properties
                        .get("textRuns")
                        .and_then(Value::as_array)
                        .is_none_or(|runs| {
                            runs.iter()
                                .find(|run| {
                                    cursor += run["text"].as_str().unwrap_or("").chars().count();
                                    start < cursor
                                })
                                .is_none_or(|run| run["attributes"]["fill"].is_null())
                        })
                });
                let authored = paint_list(node, &node.properties, fills);
                Ok(Slot {
                    node,
                    fills,
                    index,
                    range,
                    inherited,
                    effective,
                    authored,
                })
            })
            .collect()
    }

    pub(super) fn fig_selection_color_style(
        &self,
        session: &str,
        snapshot: &DocumentSnapshot,
        name: &str,
        params: &Value,
    ) -> Result<Value> {
        let refs = ReferenceContext::new(snapshot);
        let slots = self.fig_paint_slots(session, snapshot, &refs, params)?;
        let styles = resources::catalogs(&snapshot.metadata, "styles");
        let mut commands = Vec::new();
        let output = match name {
            "selection.createColorStyle" => {
                let title = string(params, "name")?.trim();
                if title.is_empty()
                    || title.chars().count() > 256
                    || title.chars().any(char::is_control)
                {
                    return Err(EngineError::invalid(
                        "style name must be 1–256 printable characters",
                    ));
                }
                if styles.values().any(|style| style["name"] == title) {
                    return Err(EngineError::invalid(
                        "a style with that name already exists",
                    ));
                }
                let shared = canonical_paint(slots[0].paint());
                if shared["type"] == "image" || shared["type"] == "pattern" {
                    return Err(EngineError::invalid("choose a solid or gradient paint"));
                }
                let local = canonical_paint(&slots[0].local_paints()[slots[0].index]);
                if slots.iter().any(|slot| {
                    slot.effective.len() != 1
                        || canonical_paint(slot.paint()) != shared
                        || canonical_paint(&slot.local_paints()[slot.index]) != local
                }) {
                    return Err(EngineError::invalid(
                        "targets must have one matching paint and variable binding",
                    ));
                }
                let id = omc_model::new_id("style");
                let paints = json!([local]);
                commands.push(catalog(
                    "styles",
                    &id,
                    json!({
                        "name":title,"type":"paint","value":paints,
                        "description":params["description"].as_str().unwrap_or(""),
                    }),
                )?);
                link(&refs, &slots, &id, &paints, &mut commands)?;
                json!({"id":id})
            }
            "selection.applyColorStyle" => {
                let style = paint_style(
                    snapshot,
                    &styles,
                    string(params, "style")?,
                    params["library"].as_str(),
                )?;
                let id = string(style, "id")?;
                link(&refs, &slots, id, &style["value"], &mut commands)?;
                json!({"ok":true})
            }
            "selection.bindColorVariable" | "selection.detachColor" => {
                let binding = if name == "selection.bindColorVariable" {
                    let tokens = resources::catalogs(&snapshot.metadata, "tokens");
                    let token = entry(&tokens, string(params, "variable")?)?;
                    if token["type"] != "color" || slots.iter().any(|slot| !solid(slot.paint())) {
                        return Err(EngineError::invalid(
                            "a color variable requires solid paint slots",
                        ));
                    }
                    Some(json!({"$token":token["id"]}))
                } else {
                    None
                };
                bind_or_detach(&refs, &slots, binding.as_ref(), &mut commands)?;
                json!({"ok":true})
            }
            _ => unreachable!("only selection color style commands reach this handler"),
        };
        if !commands.is_empty() {
            self.submit(
                session,
                &snapshot.id,
                Command::Batch { commands },
                &Value::Null,
                Some(snapshot.sequence),
            )?;
        }
        Ok(output)
    }
}

fn solid(paint: &Value) -> bool {
    paint["type"]
        .as_str()
        .is_some_and(|kind| kind.eq_ignore_ascii_case("solid"))
}

fn resolved_range_paint(refs: &ReferenceContext<'_>, node: &Node, source: Value) -> Result<Value> {
    let mut probe = node.clone();
    probe
        .properties
        .insert("selectionPaintProbe".into(), source);
    let (props, diagnostics) = refs.properties(&probe);
    if diagnostics
        .iter()
        .any(|diag| diag.property.as_deref() == Some("selectionPaintProbe"))
    {
        return Err(EngineError::invalid("could not resolve the selected color"));
    }
    props
        .get("selectionPaintProbe")
        .cloned()
        .ok_or_else(|| EngineError::invalid("could not resolve the selected color"))
}

fn link(
    refs: &ReferenceContext<'_>,
    slots: &[Slot<'_>],
    id: &str,
    value: &Value,
    commands: &mut Vec<Command>,
) -> Result<()> {
    let mut linked = BTreeSet::new();
    for slot in slots {
        if let Some([start, end]) = slot.range {
            let paint = if let Some(paints) = value.as_array() {
                let [paint] = paints.as_slice() else {
                    return Err(EngineError::invalid(
                        "a text range accepts one foreground paint",
                    ));
                };
                paint.clone()
            } else {
                json!({"type":"solid","color":value})
            };
            let paint = resolved_range_paint(refs, slot.node, paint)?;
            text::mark_selection_paint(slot.node, &[json!(start), json!(end)], &paint, commands)?;
        } else if linked.insert((&slot.node.id, slot.fills)) {
            append_style_apply(commands, slot.node.id.clone(), id, slot.style_target())?;
        }
    }
    Ok(())
}

fn bind_or_detach(
    refs: &ReferenceContext<'_>,
    slots: &[Slot<'_>],
    binding: Option<&Value>,
    commands: &mut Vec<Command>,
) -> Result<()> {
    let mut layers = BTreeMap::new();
    for slot in slots {
        if !slot.inherited {
            if let (Some([start, end]), Some(binding)) = (slot.range, binding) {
                let mut paint = slot.paint().clone();
                paint["color"] = binding.clone();
                let paint = resolved_range_paint(refs, slot.node, paint)?;
                text::mark_selection_paint(
                    slot.node,
                    &[json!(start), json!(end)],
                    &paint,
                    commands,
                )?;
            }
            continue;
        }
        let style_link = format!("{}StyleId", slot.style_target());
        let linked = slot.node.properties.contains_key(&style_link);
        let authored = if linked {
            &slot.effective
        } else {
            &slot.authored
        };
        if binding.is_none()
            && !linked
            && authored
                .get(slot.index)
                .is_none_or(|p| p["color"]["$token"].is_null())
        {
            continue;
        }
        let paints = layers
            .entry((&slot.node.id, slot.fills))
            .or_insert_with(|| {
                if authored.len() == slot.effective.len() {
                    authored.clone()
                } else {
                    slot.effective.clone()
                }
            });
        if let Some(binding) = binding {
            paints[slot.index]["color"] = binding.clone();
        } else if !paints[slot.index]["color"]["$token"].is_null() {
            paints[slot.index] = slot.paint().clone();
        }
    }
    for ((id, fills), paints) in layers {
        let (single, stack) = if fills {
            ("fill", "fills")
        } else {
            ("stroke", "strokes")
        };
        commands.push(Command::NodeUnset {
            node_id: id.clone(),
            properties: vec![format!("{single}StyleId"), single.into()],
        });
        commands.push(Command::NodeSet {
            node_id: id.clone(),
            properties: Properties::from([(stack.into(), json!(paints))]),
        });
    }
    Ok(())
}
