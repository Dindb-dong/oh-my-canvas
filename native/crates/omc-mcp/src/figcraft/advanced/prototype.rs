use super::*;

const FLOWS: &str = "prototypeFlows";

pub(super) fn command(context: &Context, action: &str) -> Result<Value> {
    if let Some(action) = action.strip_prefix("flow.") {
        return flow(context, action);
    }
    if matches!(action, "settings" | "linkNotice" | "presentOptions") {
        return super::prototype_settings::command(context, action);
    }
    super::prototype_actions::command(context, action)
}

pub(super) fn top_level_frame(context: &Context, raw: &str) -> bool {
    context.snapshot.nodes.get(raw).is_some_and(|node| {
        node.kind == NodeKind::Frame
            && node.parent_id.as_deref() == Some(context.state.root.as_str())
            && node.properties.get("visible") != Some(&Value::Bool(false))
    })
}

fn flow(context: &Context, action: &str) -> Result<Value> {
    let params = context.params;
    let root = &context.state.root;
    let start = params
        .get("start")
        .or_else(|| {
            (action == "add")
                .then(|| context.selection.first())
                .flatten()
        })
        .ok_or_else(|| EngineError::invalid("Select a starting frame or provide start"))
        .and_then(|id| context.resolve(id))?;
    let mut flows = array(context.snapshot.nodes[root].properties.get(FLOWS));
    let position = flows.iter().position(|flow| flow["start"] == start);
    let mut result = json!({"ok":true});
    match action {
        "add" => {
            if !top_level_frame(context, &start) {
                return Err(EngineError::invalid(
                    "A flow starts at a visible top-level frame on the current page",
                ));
            }
            if let Some(index) = position {
                return Ok(json!({"start":context.alias(&start),"name":flows[index]["name"]}));
            }
            if flows.len() >= 100 {
                return Err(EngineError::new(
                    "resource_limit",
                    "Too many flow starting points",
                ));
            }
            let name = params["name"]
                .as_str()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_owned)
                .unwrap_or_else(|| {
                    (flows.len() + 1..)
                        .map(|index| format!("Flow {index}"))
                        .find(|name| !flows.iter().any(|flow| flow["name"] == *name))
                        .unwrap()
                });
            if name.chars().count() > 200 {
                return Err(EngineError::invalid("Flow name exceeds 200 characters"));
            }
            flows.push(json!({"name":name,"start":start,"description":""}));
            result = json!({"start":context.alias(&start),"name":name});
        }
        "rename" => {
            let entry = position
                .map(|index| &mut flows[index])
                .ok_or_else(|| EngineError::invalid("No flow starts at that frame"))?;
            for (key, maximum) in [("name", 200), ("description", 5000)] {
                if let Some(value) = params.get(key) {
                    let value = value
                        .as_str()
                        .ok_or_else(|| EngineError::invalid(format!("{key} must be text")))?;
                    let value = if key == "name" { value.trim() } else { value };
                    if key == "name" && value.is_empty() || value.chars().count() > maximum {
                        return Err(EngineError::invalid(format!("Invalid flow {key}")));
                    }
                    entry[key] = json!(value);
                }
            }
        }
        "remove" => {
            let Some(index) = position else {
                return Ok(result);
            };
            flows.remove(index);
        }
        _ => return Err(EngineError::invalid("Unknown flow action")),
    }
    context.commit(vec![context.patch(root, FLOWS, json!(flows))])?;
    Ok(result)
}
