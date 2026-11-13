use super::*;
use omc_style::prototype::{CLICK, Environment, Expr, INTERACTIONS, Kind, Literal};

pub(super) fn command(context: &Context, name: &str) -> Result<Value> {
    let environment = Environment::new(context.snapshot);
    if name == "evaluate" {
        let expr = expression(&environment, context.params, "expr")?;
        let source = context
            .params
            .get("id")
            .map(|id| context.resolve(id))
            .transpose()?;
        let value = environment
            .evaluate(&expr, source.as_deref())
            .map_err(EngineError::invalid)?;
        return Ok(
            json!({"value":value.wire(),"type":value.kind().unwrap().id(),"text":environment.display(&expr)}),
        );
    }
    let (family, action) = name
        .split_once('.')
        .ok_or_else(|| EngineError::invalid("Unknown prototype command"))?;
    let mut changes = Vec::new();
    let mut output = json!({"ok":true});
    for id in context.many()? {
        let node = &context.snapshot.nodes[&id];
        if context
            .page(&id)
            .is_none_or(|page| page.id != context.state.page_id)
            || node.parent_id.is_none()
        {
            return Err(EngineError::invalid("Select a layer on the current page"));
        }
        let mut interactions = stored(node);
        if family == "interaction" {
            output = edit_interactions(context, &environment, &id, &mut interactions, action)?;
        } else {
            let entry = interactions
                .get_mut(index(context.params, "index")?)
                .ok_or_else(|| EngineError::invalid("No interaction at that index"))?;
            let actions = entry["actions"]
                .as_array_mut()
                .ok_or_else(|| EngineError::invalid("Interaction has no actions"))?;
            output = if family == "action" {
                edit_actions(context, &environment, &id, actions, action)?
            } else {
                edit_blocks(context, &environment, actions, action)?
            };
        }
        let simple = matches!(interactions.as_slice(), [entry]
            if entry["trigger"]["type"] == "onClick"
                && entry["transition"]["type"] == "instant"
                && entry["delay_ms"] == 0
                && entry["actions"].as_array().is_some_and(|actions| matches!(actions.as_slice(), [action]
                    if action["type"] == "navigate" && action["preserve_scroll"] != true)));
        let mut unset = Vec::new();
        if simple {
            changes.push(context.patch(&id, CLICK, interactions[0]["actions"][0]["dest"].clone()));
        } else if node.properties.contains_key(CLICK) {
            unset.push(CLICK.into());
        }
        if !simple && !interactions.is_empty() {
            changes.push(context.patch(&id, INTERACTIONS, json!(interactions)));
        } else if node.properties.contains_key(INTERACTIONS) {
            unset.push(INTERACTIONS.into());
        }
        if !unset.is_empty() {
            changes.push(Command::NodeUnset {
                node_id: id,
                properties: unset,
            });
        }
    }
    context.commit(changes)?;
    Ok(output)
}

pub(in crate::figcraft) fn stored(node: &Node) -> Vec<Value> {
    if let Some(value) = node.properties.get(INTERACTIONS) {
        return array(Some(value));
    }
    node.string(CLICK)
        .map(|dest| {
            let mut entry = default_interaction();
            entry["actions"] = json!([{"type":"navigate","dest":dest}]);
            vec![entry]
        })
        .unwrap_or_default()
}

fn default_interaction() -> Value {
    json!({"trigger":{"type":"onClick"},"actions":[],"transition":{"type":"instant"},
        "duration_ms":300,"delay_ms":0,"easing":"easeInOut"})
}

fn edit_interactions(
    context: &Context,
    env: &Environment,
    source: &str,
    items: &mut Vec<Value>,
    action: &str,
) -> Result<Value> {
    let params = context.params;
    let mut output = json!({"ok":true});
    match action {
        "clear" => items.clear(),
        "remove" => {
            let index = index(params, "index")?;
            if index >= items.len() {
                return Err(EngineError::invalid("No interaction at that index"));
            }
            items.remove(index);
        }
        "add" | "set" => {
            let index = if action == "add" {
                items.len()
            } else {
                index(params, "index")?
            };
            let mut item = if action == "add" {
                default_interaction()
            } else {
                items
                    .get(index)
                    .cloned()
                    .ok_or_else(|| EngineError::invalid("No interaction at that index"))?
            };
            if let Some(whole) = params.get("interaction") {
                if !whole.is_object() {
                    return Err(EngineError::invalid("interaction must be an object"));
                }
                item = default_interaction();
                patch_interaction(context, env, source, &mut item, whole)?;
            }
            patch_interaction(context, env, source, &mut item, params)?;
            if item["actions"].as_array().is_none_or(Vec::is_empty) {
                return Err(EngineError::invalid("Provide an action or a destination"));
            }
            if action == "add" {
                if items.len() >= 64 {
                    return Err(EngineError::invalid("Layer already has 64 interactions"));
                }
                items.push(item);
                output = json!({"index":index});
            } else {
                items[index] = item;
            }
        }
        _ => return Err(EngineError::invalid("Unknown prototype interaction action")),
    }
    Ok(output)
}

fn patch_interaction(
    context: &Context,
    env: &Environment,
    source: &str,
    item: &mut Value,
    params: &Value,
) -> Result<()> {
    if let Some(trigger) = params.get("trigger") {
        let kind = trigger
            .as_str()
            .or_else(|| trigger["type"].as_str())
            .ok_or_else(|| EngineError::invalid("Invalid trigger"))?;
        item["trigger"] = match kind {
            "onClick" | "onHover" | "onPress" | "onDrag" | "mouseEnter" | "mouseLeave"
            | "mouseDown" | "mouseUp" => json!({"type":kind}),
            "afterDelay" => json!({"type":kind,"ms":milliseconds(&trigger["ms"])?}),
            "keyPress" => json!({"type":kind,"key":checked_text(trigger,"key",100)?}),
            _ => return Err(EngineError::invalid("Unknown prototype trigger")),
        };
    }
    if let Some(value) = params.get("transition") {
        let kind = value
            .as_str()
            .or_else(|| value["type"].as_str())
            .ok_or_else(|| EngineError::invalid("Invalid transition"))?;
        item["transition"] = match kind {
            "instant" | "dissolve" | "smartAnimate" => json!({"type":kind}),
            "moveIn" | "moveOut" | "push" | "slideIn" | "slideOut" => {
                let direction = value["direction"].as_str().unwrap_or("left");
                if !matches!(direction, "left" | "right" | "top" | "bottom") {
                    return Err(EngineError::invalid("Unknown transition direction"));
                }
                json!({"type":kind,"direction":direction})
            }
            _ => return Err(EngineError::invalid("Unknown prototype transition")),
        };
    }
    if let Some(value) = params.get("easing") {
        item["easing"] = easing(value)?;
    }
    for (key, alias) in [("duration_ms", "durationMs"), ("delay_ms", "delayMs")] {
        if let Some(value) = params.get(alias).or_else(|| params.get(key)) {
            item[key] = json!(milliseconds(value)?);
        }
    }
    if let Some(values) = params.get("actions") {
        item["actions"] = json!(normalize_actions(context, env, source, values, 0)?);
    } else if let Some(value) = params.get("action").cloned().or_else(|| {
        params
            .get("dest")
            .map(|dest| json!({"type":"navigate","dest":dest}))
    }) {
        let mut value = value;
        if !value.is_object() {
            return Err(EngineError::invalid("action must be an object"));
        }
        if value.get("dest").is_none()
            && let Some(dest) = params.get("dest")
        {
            value["dest"] = dest.clone();
        }
        let action = normalize_action(context, env, source, &value, 0)?;
        let list = item["actions"].as_array_mut().unwrap();
        if list.is_empty() {
            list.push(action);
        } else {
            list[0] = action;
        }
    }
    Ok(())
}

fn easing(value: &Value) -> Result<Value> {
    if value.as_str().is_some_and(|value| {
        matches!(
            value,
            "linear"
                | "easeIn"
                | "easeOut"
                | "easeInOut"
                | "easeInBack"
                | "easeOutBack"
                | "easeInOutBack"
                | "gentle"
                | "quick"
                | "bouncy"
                | "slow"
        )
    }) {
        return Ok(value.clone());
    }
    if let Some(curve) = value.get("customBezier") {
        let valid = ["x1", "x2"]
            .iter()
            .all(|key| curve[key].as_f64().is_some_and(|n| (0. ..=1.).contains(&n)))
            && ["y1", "y2"]
                .iter()
                .all(|key| curve[key].as_f64().is_some_and(|n| n.is_finite()));
        if valid {
            return Ok(value.clone());
        }
    }
    if let Some(spring) = value.get("customSpring") {
        let valid = ["mass", "stiffness", "damping"].iter().all(|key| {
            spring[key]
                .as_f64()
                .is_some_and(|n| n.is_finite() && n > 0.)
        });
        if valid {
            return Ok(value.clone());
        }
    }
    Err(EngineError::invalid("Invalid prototype easing"))
}

fn milliseconds(value: &Value) -> Result<u64> {
    value
        .as_u64()
        .filter(|n| *n <= 600_000)
        .ok_or_else(|| EngineError::invalid("Duration must be 0–600000 milliseconds"))
}

fn checked_text<'a>(params: &'a Value, key: &str, limit: usize) -> Result<&'a str> {
    let value = string(params, key)?;
    if value.is_empty() || value.chars().count() > limit || value.chars().any(char::is_control) {
        return Err(EngineError::invalid(format!("Invalid {key}")));
    }
    Ok(value)
}

fn point(value: &Value) -> Result<Value> {
    if value.as_array().is_some_and(|xy| {
        xy.len() == 2
            && xy
                .iter()
                .all(|n| n.as_f64().is_some_and(|n| n.abs() <= 1_000_000.))
    }) {
        return Ok(value.clone());
    }
    Err(EngineError::invalid("Expected [x, y] coordinates"))
}

fn expression(env: &Environment, params: &Value, key: &str) -> Result<Expr> {
    let expr = if let Some(text) = params.get("expression") {
        env.parse(
            text.as_str()
                .ok_or_else(|| EngineError::invalid("expression must be text"))?,
        )
    } else {
        env.expression(
            params
                .get(key)
                .ok_or_else(|| EngineError::invalid("Provide expression text or JSON"))?,
        )
    };
    expr.map_err(EngineError::invalid)
}

fn condition(env: &Environment, params: &Value) -> Result<Expr> {
    let expr = expression(env, params, "condition")?;
    if env.kind(&expr).map_err(EngineError::invalid)? != Kind::Boolean {
        return Err(EngineError::invalid("Condition must give true or false"));
    }
    Ok(expr)
}

fn normalize_actions(
    context: &Context,
    env: &Environment,
    source: &str,
    values: &Value,
    depth: usize,
) -> Result<Vec<Value>> {
    let values = values
        .as_array()
        .filter(|values| values.len() <= 64)
        .ok_or_else(|| EngineError::invalid("Expected at most 64 prototype actions"))?;
    values
        .iter()
        .map(|value| normalize_action(context, env, source, value, depth))
        .collect()
}

fn normalize_action(
    context: &Context,
    env: &Environment,
    source: &str,
    action: &Value,
    depth: usize,
) -> Result<Value> {
    if depth > 10 {
        return Err(EngineError::invalid("Too many nested conditional actions"));
    }
    let kind = string(action, "type")?;
    let mut result = json!({"type":kind});
    match kind {
        "back" | "closeOverlay" => {}
        "navigate" | "openOverlay" | "swapOverlay" | "scrollTo" | "changeTo" => {
            let dest = context.resolve(&action["dest"])?;
            let node = &context.snapshot.nodes[&dest];
            let valid = match kind {
                "navigate" | "openOverlay" | "swapOverlay" => {
                    super::prototype::top_level_frame(context, &dest)
                }
                "changeTo" => {
                    node.kind == NodeKind::Component && node.string("variantSetId").is_some()
                }
                _ => {
                    context
                        .page(&dest)
                        .is_some_and(|page| page.id == context.state.page_id)
                        && node.parent_id.is_some()
                }
            };
            if !valid || source == dest && kind == "navigate" {
                return Err(EngineError::invalid("Invalid prototype destination"));
            }
            result["dest"] = json!(dest);
            if kind == "navigate"
                && (action["preserveScroll"] == true || action["preserve_scroll"] == true)
            {
                result["preserve_scroll"] = json!(true);
            }
            if let Some(value) = action.get("offset") {
                result["offset"] = point(value)?;
            }
            if kind == "openOverlay" {
                for (field, choices, default) in [
                    (
                        "anchor",
                        &["screen", "triggerInside", "triggerOutside"][..],
                        "screen",
                    ),
                    (
                        "position",
                        &[
                            "center",
                            "topLeft",
                            "topCenter",
                            "topRight",
                            "bottomLeft",
                            "bottomCenter",
                            "bottomRight",
                            "manual",
                        ][..],
                        "center",
                    ),
                ] {
                    let choice = action[field].as_str().unwrap_or(default);
                    if !choices.contains(&choice) {
                        return Err(EngineError::invalid(format!("Unknown overlay {field}")));
                    }
                    result[field] = json!(choice);
                }
                result["close_on_outside"] =
                    json!(action["close_on_outside"].as_bool().unwrap_or(true));
                if let Some(color) = action.get("background") {
                    result["background"] =
                        json!(omc_style::prototype::color_hex(color).ok_or_else(|| {
                            EngineError::invalid("Invalid overlay background color")
                        })?);
                }
            }
        }
        "openUrl" => {
            let url = checked_text(action, "url", 2048)?;
            let safe = url.split_once(':').is_some_and(|(scheme, target)| {
                let rest = target.strip_prefix("//").unwrap_or_default();
                let host = rest.split(['/', '?', '#']).next().unwrap_or_default();
                match scheme.to_ascii_lowercase().as_str() {
                    "http" | "https" => !host.is_empty() && !host.contains('@'),
                    "mailto" => !target.is_empty(),
                    _ => false,
                }
            }) && !url.chars().any(char::is_whitespace)
                && !url.contains('\\');
            if !safe {
                return Err(EngineError::invalid(
                    "Prototype links require a web or mail URL",
                ));
            }
            result["url"] = json!(url);
            result["open_in_new_tab"] = json!(
                action["openInNewTab"]
                    .as_bool()
                    .or_else(|| action["open_in_new_tab"].as_bool())
                    .unwrap_or(true)
            );
        }
        "setVariable" => {
            let name = checked_text(action, "variable", 256)?;
            let (variable, kind) = env
                .variable(name)
                .ok_or_else(|| EngineError::invalid("Unknown variable"))?;
            let expr = if action.get("expression").is_some() || action.get("expr").is_some() {
                expression(env, action, "expr")?
            } else if let Some(reference) = action["value"]["alias"].as_str() {
                let (id, _) = env
                    .variable(reference)
                    .ok_or_else(|| EngineError::invalid("Unknown variable alias"))?;
                Expr::Value(Literal::Alias(id.into()))
            } else {
                Expr::Value(
                    Literal::from_value(kind, &action["value"]).map_err(EngineError::invalid)?,
                )
            };
            let value_kind = env.kind(&expr).map_err(EngineError::invalid)?;
            if kind != value_kind
                && !(kind == Kind::String && matches!(value_kind, Kind::Boolean | Kind::Number))
            {
                return Err(EngineError::invalid(
                    "Expression does not match the variable type",
                ));
            }
            result["variable"] = json!(variable);
            result["expr"] = json!(expr);
        }
        "setVariableMode" => {
            let collection = env
                .collection(checked_text(action, "collection", 256)?)
                .ok_or_else(|| EngineError::invalid("Unknown collection"))?;
            let mode = env
                .mode(collection, checked_text(action, "mode", 256)?)
                .ok_or_else(|| EngineError::invalid("Unknown collection mode"))?;
            result["collection"] = json!(collection);
            result["mode"] = json!(mode);
        }
        "conditional" => {
            let blocks = action["blocks"]
                .as_array()
                .filter(|blocks| (1..=32).contains(&blocks.len()))
                .ok_or_else(|| EngineError::invalid("Conditional needs 1–32 blocks"))?;
            let mut normalized = Vec::new();
            for (index, block) in blocks.iter().enumerate() {
                let cond = if block.get("expression").is_some() || !block["condition"].is_null() {
                    json!(condition(env, block)?)
                } else if index > 0 && index + 1 == blocks.len() {
                    Value::Null
                } else {
                    return Err(EngineError::invalid(
                        "Only the last block may omit its condition",
                    ));
                };
                let actions =
                    normalize_actions(context, env, source, &block["actions"], depth + 1)?;
                normalized.push(json!({"condition":cond,"actions":actions}));
            }
            result["blocks"] = json!(normalized);
        }
        _ => return Err(EngineError::invalid("Unknown prototype action type")),
    }
    Ok(result)
}

fn path(value: &Value) -> Result<Vec<usize>> {
    let path = value
        .as_array()
        .filter(|path| !path.is_empty() && path.len() % 2 == 1 && path.len() <= 21)
        .ok_or_else(|| {
            EngineError::invalid("Expected an action path [action, block, action, …]")
        })?;
    path.iter()
        .map(|id| {
            id.as_u64()
                .and_then(|id| usize::try_from(id).ok())
                .ok_or_else(|| EngineError::invalid("Path indices must be nonnegative integers"))
        })
        .collect()
}

fn list<'a>(actions: &'a mut Vec<Value>, parents: &[usize]) -> Result<&'a mut Vec<Value>> {
    if parents.is_empty() {
        return Ok(actions);
    }
    let child = actions
        .get_mut(parents[0])
        .filter(|action| action["type"] == "conditional")
        .and_then(|action| action["blocks"].as_array_mut())
        .and_then(|blocks| blocks.get_mut(parents[1]))
        .and_then(|block| block["actions"].as_array_mut())
        .ok_or_else(|| EngineError::invalid("No conditional block at that path"))?;
    list(child, &parents[2..])
}

fn edit_actions(
    context: &Context,
    env: &Environment,
    source: &str,
    actions: &mut Vec<Value>,
    mode: &str,
) -> Result<Value> {
    let params = context.params;
    let path = if mode == "add" && params.get("path").is_none() {
        vec![actions.len()]
    } else {
        path(&params["path"])?
    };
    let (index, parents) = path.split_last().unwrap();
    let list = list(actions, parents)?;
    if *index > list.len() || *index == list.len() && mode != "add" {
        return Err(EngineError::invalid("No action at that path"));
    }
    match mode {
        "add" | "set" => {
            let replacement =
                normalize_action(context, env, source, &params["action"], parents.len() / 2)?;
            if mode == "add" {
                if list.len() >= 64 {
                    return Err(EngineError::invalid("Action list already has 64 actions"));
                }
                list.insert(*index, replacement);
                return Ok(json!({"path":path}));
            }
            list[*index] = replacement;
        }
        "remove" => {
            if parents.is_empty() && list.len() == 1 {
                return Err(EngineError::invalid("An interaction must keep one action"));
            }
            list.remove(*index);
        }
        "move" => {
            let to = super::index(params, "to")?;
            if to >= list.len() {
                return Err(EngineError::invalid("Action index is out of range"));
            }
            let item = list.remove(*index);
            list.insert(to, item);
            let mut new_path = parents.to_vec();
            new_path.push(to);
            return Ok(json!({"path":new_path}));
        }
        _ => return Err(EngineError::invalid("Unknown action edit")),
    }
    Ok(json!({"ok":true}))
}

fn edit_blocks(
    context: &Context,
    env: &Environment,
    actions: &mut Vec<Value>,
    mode: &str,
) -> Result<Value> {
    let params = context.params;
    let path = path(&params["path"])?;
    let (position, parents) = path.split_last().unwrap();
    let parent = list(actions, parents)?;
    let blocks = parent
        .get_mut(*position)
        .filter(|action| action["type"] == "conditional")
        .and_then(|action| action["blocks"].as_array_mut())
        .ok_or_else(|| EngineError::invalid("No conditional action at that path"))?;
    match mode {
        "addBlock" => {
            if blocks.len() >= 32 {
                return Err(EngineError::invalid("Conditional already has 32 blocks"));
            }
            let has_else = blocks
                .last()
                .is_some_and(|block| block["condition"].is_null());
            let add_else = params["else"] == true;
            if add_else && has_else {
                return Err(EngineError::invalid(
                    "Conditional already has an else block",
                ));
            }
            let expression = if add_else {
                Value::Null
            } else if params.get("expression").is_some() || params.get("condition").is_some() {
                json!(condition(env, params)?)
            } else {
                json!(env.default_condition())
            };
            let block = blocks.len() - usize::from(has_else);
            blocks.insert(block, json!({"condition":expression,"actions":[]}));
            Ok(json!({"block":block}))
        }
        "setCondition" => {
            let block = blocks
                .get_mut(index(params, "block")?)
                .ok_or_else(|| EngineError::invalid("No conditional block at that index"))?;
            block["condition"] = json!(condition(env, params)?);
            Ok(json!({"ok":true}))
        }
        "removeBlock" => {
            let block = index(params, "block")?;
            if block >= blocks.len() {
                return Err(EngineError::invalid("No conditional block at that index"));
            }
            blocks.remove(block);
            let remove = blocks
                .first()
                .is_none_or(|first| first["condition"].is_null());
            if remove {
                if parents.is_empty() && parent.len() == 1 {
                    return Err(EngineError::invalid("An interaction must keep one action"));
                }
                parent.remove(*position);
            }
            Ok(json!({"removedAction":remove}))
        }
        _ => Err(EngineError::invalid("Unknown conditional block action")),
    }
}

pub(in crate::figcraft) fn wire_ids(value: &mut Value, ids: &impl Fn(&str) -> Value) {
    if let Some(action) = value.as_object_mut() {
        if let Some(raw) = action.get("dest").and_then(Value::as_str) {
            action.insert("dest".into(), ids(raw));
        }
        for child in action.values_mut() {
            wire_ids(child, ids);
        }
    } else if let Some(values) = value.as_array_mut() {
        for child in values {
            wire_ids(child, ids);
        }
    }
}
