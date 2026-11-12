use super::*;
use omc_style::prototype::{CLICK, INTERACTIONS, color_hex};

pub(super) fn decode(node: &mut Node, records: &Value, ids: &BTreeMap<u64, String>) -> Result<()> {
    let mut interactions = records
        .as_array()
        .filter(|items| items.len() <= 64)
        .cloned()
        .ok_or_else(|| invalid("invalid prototype interactions"))?;
    for interaction in &mut interactions {
        if !interaction.is_object() {
            return Err(invalid("invalid prototype interaction"));
        }
        for (key, default) in [("trigger", "onClick"), ("transition", "instant")] {
            match interaction.get(key) {
                None | Some(Value::Null) => interaction[key] = json!({"type":default}),
                Some(Value::String(kind)) => interaction[key] = json!({"type":kind}),
                Some(value) if value["type"].is_string() => {}
                _ => return Err(invalid("invalid prototype trigger or transition")),
            }
        }
        let actions = interaction
            .get_mut("actions")
            .ok_or_else(|| invalid("missing prototype actions"))?;
        convert(
            actions,
            &|dest| {
                dest.as_u64()
                    .and_then(|number| ids.get(&number))
                    .map(|id| json!(id))
                    .ok_or_else(|| invalid("invalid prototype action destination"))
            },
            false,
            0,
        )?;
        if actions.as_array().is_some_and(Vec::is_empty) {
            return Err(invalid("empty prototype interaction"));
        }
        if interaction.get("delay_ms").is_none() {
            interaction["delay_ms"] = json!(0);
        }
    }
    if let [entry] = interactions.as_slice()
        && entry["trigger"]["type"] == "onClick" && entry["transition"]["type"] == "instant"
        && entry["delay_ms"] == 0 && entry["actions"].as_array().is_some_and(|actions|
            matches!(actions.as_slice(),[action] if action["type"] == "navigate" && action["preserve_scroll"] != true))
    {
        node.properties.insert(CLICK.into(), entry["actions"][0]["dest"].clone());
    } else if !interactions.is_empty() {
        node.properties.insert(INTERACTIONS.into(), json!(interactions));
    }
    Ok(())
}

pub(super) fn encode(interactions: &Value, ids: &BTreeMap<String, usize>) -> Result<Value> {
    let mut interactions = interactions.clone();
    let items = interactions
        .as_array_mut()
        .ok_or_else(|| invalid("invalid prototype interactions"))?;
    for item in items {
        let actions = item
            .get_mut("actions")
            .ok_or_else(|| invalid("missing prototype actions"))?;
        convert(
            actions,
            &|dest| {
                dest.as_str()
                    .and_then(|raw| ids.get(raw))
                    .map(|id| json!(id))
                    .ok_or_else(|| invalid("invalid prototype action destination"))
            },
            true,
            0,
        )?;
    }
    Ok(interactions)
}

fn convert(
    actions: &mut Value,
    destination: &impl Fn(&Value) -> Result<Value>,
    encoding: bool,
    depth: usize,
) -> Result<()> {
    if depth > 10 {
        return Err(invalid("too many nested prototype actions"));
    }
    let actions = actions
        .as_array_mut()
        .filter(|items| items.len() <= 64)
        .ok_or_else(|| invalid("invalid prototype actions"))?;
    for action in actions {
        let kind = action["type"]
            .as_str()
            .ok_or_else(|| invalid("missing prototype action type"))?;
        match kind {
            "navigate" | "scrollTo" | "openOverlay" | "swapOverlay" | "changeTo" => {
                let overlay = kind == "openOverlay";
                action["dest"] = destination(&action["dest"])?;
                if overlay && !action["background"].is_null() {
                    action["background"] = if encoding {
                        let color = action["background"]
                            .as_str()
                            .ok_or_else(|| invalid("invalid overlay background"))?;
                        encode_color(color)?
                    } else {
                        json!(
                            color_hex(&action["background"])
                                .ok_or_else(|| invalid("invalid overlay background"))?
                        )
                    };
                }
            }
            "back" | "closeOverlay" => {}
            "openUrl" => {
                let open = if encoding {
                    action.as_object_mut().unwrap().remove("open_in_new_tab")
                } else {
                    action.as_object_mut().unwrap().remove("new_tab")
                };
                if let Some(open) = open {
                    action[if encoding {
                        "new_tab"
                    } else {
                        "open_in_new_tab"
                    }] = open;
                }
            }
            "setVariable" => {
                if encoding && action.get("value").is_none() {
                    action["value"] = Value::Null;
                }
            }
            "setVariableMode" => {}
            "conditional" => {
                let blocks = action["blocks"]
                    .as_array_mut()
                    .filter(|items| (1..=32).contains(&items.len()))
                    .ok_or_else(|| invalid("invalid prototype conditional blocks"))?;
                for block in blocks {
                    if !block.is_object() {
                        return Err(invalid("invalid prototype conditional block"));
                    }
                    if block.get("actions").is_none() {
                        block["actions"] = json!([]);
                    }
                    convert(&mut block["actions"], destination, encoding, depth + 1)?;
                }
            }
            _ => return Err(unsupported(format!("prototype action {kind}"))),
        }
    }
    Ok(())
}
