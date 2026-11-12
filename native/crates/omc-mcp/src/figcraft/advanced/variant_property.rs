use super::*;

pub(super) fn ordered_axes(node: &Node) -> Vec<(String, String)> {
    if let Some(axes) = node
        .properties
        .get("variantProperties")
        .and_then(Value::as_array)
    {
        return axes
            .iter()
            .filter_map(|axis| {
                Some((
                    axis["name"].as_str()?.into(),
                    axis["value"].as_str()?.into(),
                ))
            })
            .collect();
    }
    node.string("name")
        .unwrap_or_default()
        .split(',')
        .filter_map(|part| {
            let (name, value) = part.split_once('=')?;
            Some((name.trim().into(), value.trim().into()))
        })
        .collect()
}

fn label(value: &Value) -> Result<&str> {
    value
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty() && s.chars().count() <= 256 && !s.contains([',', '=']))
        .ok_or_else(|| {
            EngineError::invalid(
                "Variant names and values must be nonempty and omit commas and equals signs",
            )
        })
}

fn default_value<'a>(params: &'a Value) -> Result<Option<&'a str>> {
    params
        .get("default")
        .filter(|value| !value.is_null())
        .map(label)
        .transpose()
}

fn variant_rows(axes: &[(String, String)]) -> Value {
    json!(
        axes.iter()
            .map(|(name, value)| json!({"name":name,"value":value}))
            .collect::<Vec<_>>()
    )
}

pub(super) fn owner<'a>(snapshot: &'a DocumentSnapshot, node: &'a Node) -> Option<&'a Node> {
    if node.properties.get("isVariantSet") == Some(&Value::Bool(true)) {
        return Some(node);
    }
    node.string("variantSetId")
        .and_then(|id| snapshot.nodes.get(id))
}

pub(super) fn change(context: &Context, selected: &Node, action: &str) -> Result<Option<Value>> {
    let add = action == "addProperty" && context.params["type"] == "variant";
    let set = owner(context.snapshot, selected);
    let local = |node: &Node| node.string("libraryId").is_none();
    let components = if let Some(set) = set {
        children(context.snapshot, &set.id)
            .into_iter()
            .filter(|node| node.kind == NodeKind::Component)
            .collect::<Vec<_>>()
    } else if selected.kind == NodeKind::Component {
        vec![selected]
    } else {
        Vec::new()
    };
    let variant_name = context.params["name"].as_str().unwrap_or_default();
    let existing = set.is_some()
        && components.iter().any(|node| {
            ordered_axes(node)
                .iter()
                .any(|(name, _)| name == variant_name)
        });
    if !add && !(existing && matches!(action, "editProperty" | "deleteProperty")) {
        return Ok(None);
    }
    if components.is_empty()
        || components.iter().any(|node| !local(node))
        || set.is_some_and(|set| !local(set))
    {
        return Err(EngineError::invalid(
            "Choose a local component or component set",
        ));
    }
    if context.params.get("preferred").is_some() {
        return Err(EngineError::invalid(
            "preferred applies to instance swap and slot properties",
        ));
    }
    let name = label(&context.params["name"])?;
    let replacement = context
        .params
        .get("newName")
        .filter(|value| !value.is_null())
        .map(label)
        .transpose()?
        .unwrap_or(name);
    if (add || replacement != name)
        && components.iter().any(|node| {
            ordered_axes(node)
                .iter()
                .any(|(name, _)| name == replacement)
                || array(node.properties.get("componentPropertyDefinitions"))
                    .iter()
                    .any(|p| p["name"] == replacement)
        })
    {
        return Err(EngineError::invalid(
            "Component property name is already in use",
        ));
    }
    let (rename, next) = match (context.params.get("value"), context.params.get("newValue")) {
        (Some(before), Some(after)) => (Some(label(before)?), Some(label(after)?)),
        (None, None) => (None, None),
        _ => {
            return Err(EngineError::invalid(
                "value and newValue must be supplied together",
            ));
        }
    };
    if let Some(rename) = rename {
        if !components.iter().any(|node| {
            ordered_axes(node)
                .iter()
                .any(|(key, value)| key == name && value == rename)
        }) {
            return Err(EngineError::invalid("Unknown variant value"));
        }
    }
    let default = default_value(context.params)?;
    let place = context
        .params
        .get("index")
        .filter(|value| !value.is_null())
        .map(|value| {
            value
                .as_u64()
                .and_then(|i| usize::try_from(i).ok())
                .ok_or_else(|| EngineError::invalid("index must be a property position"))
        })
        .transpose()?;
    let (set_id, mut commands) = if let Some(set) = set {
        (set.id.clone(), Vec::new())
    } else {
        context
            .router
            .plan_single_variant_set(context.session, context.snapshot, &selected.id)?
    };
    let mut resulting = Vec::new();
    for component in &components {
        let mut axes = if set.is_some() {
            ordered_axes(component)
        } else {
            Vec::new()
        };
        if add {
            axes.push((name.into(), default.unwrap_or("Default").into()));
        } else if let Some(position) = axes.iter().position(|(key, _)| key == name) {
            let (_, old) = axes.remove(position);
            if action == "editProperty" {
                let value = if rename == Some(old.as_str()) {
                    next.unwrap().into()
                } else {
                    old
                };
                let place = place.unwrap_or(position).min(axes.len());
                axes.insert(place, (replacement.into(), value));
            }
        }
        let canonical = if axes.is_empty() {
            "Default".into()
        } else {
            axes.iter()
                .map(|(name, value)| format!("{name}={value}"))
                .collect::<Vec<_>>()
                .join(", ")
        };
        commands.push(Command::NodeSet {
            node_id: component.id.clone(),
            properties: Properties::from([
                ("name".into(), json!(canonical)),
                ("variantProperties".into(), variant_rows(&axes)),
                ("variantSetId".into(), json!(set_id)),
            ]),
        });
        resulting.push(axes);
    }
    if action == "editProperty"
        && let Some(default) = default
    {
        let preferred = resulting[0]
            .iter()
            .map(|(key, value)| (key, if key == replacement { default } else { value }))
            .collect::<Vec<_>>();
        let index = resulting
            .iter()
            .position(|axes| {
                axes.iter()
                    .map(|(key, value)| (key, value.as_str()))
                    .eq(preferred.iter().copied())
            })
            .or_else(|| {
                resulting.iter().position(|axes| {
                    axes.iter()
                        .any(|(key, value)| key == replacement && value == default)
                })
            })
            .ok_or_else(|| EngineError::invalid("No variant has the requested default value"))?;
        if index != 0 {
            let (first, next) = (components[0], components[index]);
            for (node, place) in [(first, next), (next, first)] {
                commands.push(Command::NodeSet {
                    node_id: node.id.clone(),
                    properties: Properties::from([
                        ("x".into(), json!(place.number("x", 0.))),
                        ("y".into(), json!(place.number("y", 0.))),
                    ]),
                });
                commands.push(Command::NodeMove {
                    node_id: node.id.clone(),
                    parent_id: node.parent_id.clone(),
                    rank: place.rank.clone(),
                });
            }
        }
    }
    context.commit(commands)?;
    if add {
        let id = context.alias(&set_id);
        context.router.fig_selection(
            &(context.session.into(), context.snapshot.id.clone()),
            &[json!(id)],
        );
        Ok(Some(json!({"id":id})))
    } else {
        Ok(Some(json!({"ok":true})))
    }
}
