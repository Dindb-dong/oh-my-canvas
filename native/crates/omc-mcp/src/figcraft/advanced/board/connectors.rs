use super::*;

pub(super) const CONNECTOR: &str = "boardConnector";
const LABEL: &str = "boardConnectorLabel";
const STYLES: &[&str] = &["straight", "elbow", "curved"];
const SIDES: &[&str] = &["auto", "top", "right", "bottom", "left"];
const CAPS: &[&str] = &[
    "none",
    "lineArrow",
    "triangleArrow",
    "triangle",
    "circleFilled",
    "circle",
    "diamondFilled",
    "diamond",
    "squareFilled",
    "square",
    "round",
];

pub(super) fn command(context: &Context, action: &str) -> Result<Value> {
    let p = context.params;
    if action == "connector" {
        let mut connector = json!({
            "from":endpoint(context,&p["from"],&p["fromSide"],&p["fromAt"])?,
            "to":endpoint(context,&p["to"],&p["toSide"],&p["toAt"])?,
            "style":"elbow","startCap":"none","endCap":"triangleArrow",
        });
        settings(&mut connector, p)?;
        let root = &context.snapshot.nodes[&context.state.root];
        let rank = append_rank(context.snapshot, &root.id)?;
        let (node, label, edits) = build(root, rank, connector, p["label"].as_str())?;
        context.commit(edits)?;
        select(context, &node.id);
        return Ok(response(context, &node, label.as_ref(), false));
    }
    let raw = context.one()?;
    let mut node = &context.snapshot.nodes[&raw];
    if node.properties.get(LABEL) == Some(&Value::Bool(true))
        && let Some(parent) = &node.parent_id
    {
        node = &context.snapshot.nodes[parent];
    }
    let mut connector = node
        .properties
        .get(CONNECTOR)
        .cloned()
        .ok_or_else(|| EngineError::invalid("Choose a connector or its label"))?;
    let existing_label = children(context.snapshot, &node.id)
        .into_iter()
        .find(|node| node.properties.get(LABEL) == Some(&Value::Bool(true)));
    if action == "label" {
        let text = string(p, "text")?.trim();
        let mut label = None;
        let mut commands = Vec::new();
        if let Some(existing) = existing_label {
            if text.is_empty() {
                commands.push(Command::NodeDelete {
                    node_ids: vec![existing.id.clone()],
                });
            } else {
                commands.push(context.patch(&existing.id, "text", json!(text)));
                commands.push(context.patch(&existing.id, "width", json!(label_width(text))));
                label = Some(existing.clone());
            }
        } else if !text.is_empty() {
            let created = new_label(node, text)?;
            commands.push(Command::NodeCreate {
                node: created.clone(),
            });
            label = Some(created);
        }
        context.commit(commands)?;
        return Ok(response(context, node, label.as_ref(), true));
    }
    match action {
        "reattach" => {
            let end = enumeration(&p["end"], "end", &["from", "to"], None)?;
            connector[end] = endpoint(context, &p["target"], &p["side"], &p["at"])?;
            connector["control"] = Value::Null;
            validate_ends(&connector)?;
        }
        "reshape" => {
            if connector["style"] == "straight" {
                return Err(EngineError::invalid(
                    "A straight connector has no movable portion",
                ));
            }
            let portion = index(p, "portion")?;
            let scene = paths::scene(context.snapshot, &context.state.page_id)?;
            let portions = scene
                .item(&node.id)
                .and_then(|item| item.properties.get("boardConnectorPortions"))
                .and_then(Value::as_u64)
                .unwrap_or(0);
            if (portion as u64) >= portions {
                return Err(EngineError::invalid(
                    "Connector portion is outside the route",
                ));
            }
            connector["control"] = json!([required_number(p, "x")?, required_number(p, "y")?]);
            connector["portion"] = json!(portion);
        }
        _ => return Err(EngineError::invalid("Unknown connector action")),
    }
    context.commit(vec![context.patch(&node.id, CONNECTOR, connector)])?;
    Ok(json!({"id":context.alias(&node.id)}))
}

fn response(context: &Context, node: &Node, label: Option<&Node>, include_empty: bool) -> Value {
    let mut result = json!({"id":context.alias(&node.id)});
    if include_empty || label.is_some() {
        result["label"] = json!(label.map(|label| context.alias(&label.id)));
    }
    result
}

pub(super) fn settings(connector: &mut Value, params: &Value) -> Result<()> {
    for (key, allowed) in [("style", STYLES), ("startCap", CAPS), ("endCap", CAPS)] {
        if !params[key].is_null() {
            connector[key] = json!(enumeration(&params[key], key, allowed, None)?);
        }
    }
    Ok(())
}

fn enumeration<'a>(
    value: &'a Value,
    key: &str,
    allowed: &[&str],
    default: Option<&'a str>,
) -> Result<&'a str> {
    let value = if value.is_null() {
        default
    } else {
        value.as_str()
    };
    value
        .filter(|value| allowed.contains(value))
        .ok_or_else(|| EngineError::invalid(format!("{key} must be {}", allowed.join(", "))))
}

fn endpoint(context: &Context, target: &Value, side: &Value, at: &Value) -> Result<Value> {
    if target.is_object() {
        return Ok(json!({"point":[required_number(target,"x")?,required_number(target,"y")?]}));
    }
    let layer = context.resolve(target)?;
    let node = &context.snapshot.nodes[&layer];
    if node.parent_id.is_none()
        || node.string(TYPE) == Some("connector")
        || context
            .page(&layer)
            .is_none_or(|p| p.id != context.state.page_id)
    {
        return Err(EngineError::invalid(
            "Connector target must be a layer on the current page",
        ));
    }
    let scene = paths::scene(context.snapshot, &context.state.page_id)?;
    let item = scene
        .item(&layer)
        .ok_or_else(|| EngineError::invalid("Connector target is unavailable"))?;
    let fallback = item.world.point(item.width / 2., item.height / 2.);
    let side = enumeration(side, "side", SIDES, Some("auto"))?;
    let mut end = json!({"layer":layer,"side":side,"fallback":[fallback.0,fallback.1]});
    if !at.is_null() {
        end["at"] = json!(pair(at, "at", 0., 1.)?);
    }
    Ok(end)
}

fn pair(value: &Value, key: &str, min: f64, max: f64) -> Result<[f64; 2]> {
    let pair = value
        .as_array()
        .filter(|a| a.len() == 2)
        .and_then(|a| Some([a[0].as_f64()?, a[1].as_f64()?]))
        .filter(|a| a.iter().all(|n| (min..=max).contains(n)));
    pair.ok_or_else(|| {
        EngineError::invalid(format!("{key} must be a pair between {min} and {max}"))
    })
}

fn required_number(params: &Value, key: &str) -> Result<f64> {
    if params[key].is_null() {
        return Err(EngineError::invalid(format!("{key} is required")));
    }
    number(params, key, 0.)
}

fn validate_ends(connector: &Value) -> Result<()> {
    let from = &connector["from"];
    let to = &connector["to"];
    if (!from["layer"].is_null() && from["layer"] == to["layer"])
        || (!from["point"].is_null() && from["point"] == to["point"])
    {
        return Err(EngineError::invalid(
            "Connect two different points or layers",
        ));
    }
    Ok(())
}

fn label_width(text: &str) -> f64 {
    (text
        .lines()
        .map(|line| line.chars().count())
        .max()
        .unwrap_or(1) as f64
        * 7.5
        + 14.)
        .clamp(24., 360.)
}

fn new_label(node: &Node, text: &str) -> Result<Node> {
    if text.chars().count() > 4096 {
        return Err(EngineError::new(
            "resource_limit",
            "Connector label exceeds 4096 characters",
        ));
    }
    new_layer(
        NodeKind::Text,
        node,
        rank_between(None, None).unwrap(),
        json!({
            "name":"Label","text":text,"width":label_width(text),"height":20.,"fontSize":13.,"fill":"#2b2a27",
            "textAlign":"center","boardConnectorLabel":true,"style":{"position":"absolute","background-color":"#fbfaf8"},
        }),
    )
}

pub(super) fn build(
    root: &Node,
    rank: String,
    connector: Value,
    label: Option<&str>,
) -> Result<(Node, Option<Node>, Vec<Command>)> {
    validate_ends(&connector)?;
    let node = new_layer(
        NodeKind::Path,
        root,
        rank,
        json!({
            "name":"Connector","x":0.,"y":0.,"width":1.,"height":1.,"path":"","fill":"#514c47",
            "style":{"position":"absolute"},"boardItemType":"connector","boardConnector":connector,
        }),
    )?;
    let label = label
        .map(str::trim)
        .filter(|label| !label.is_empty())
        .map(|text| new_label(&node, text))
        .transpose()?;
    let mut commands = vec![Command::NodeCreate { node: node.clone() }];
    if let Some(label) = &label {
        commands.push(Command::NodeCreate {
            node: label.clone(),
        });
    }
    Ok((node, label, commands))
}

pub(super) fn note<'a>(context: &Context<'a>) -> Result<&'a Node> {
    let node = &context.snapshot.nodes[&context.one()?];
    let node = if node.kind == NodeKind::Text {
        node.parent_id
            .as_ref()
            .and_then(|id| context.snapshot.nodes.get(id))
            .unwrap_or(node)
    } else {
        node
    };
    if matches!(node.string(TYPE), Some("shape" | "sticky")) {
        Ok(node)
    } else {
        Err(EngineError::invalid("Choose a board shape or sticky note"))
    }
}

pub(super) fn add_connected(context: &Context) -> Result<Value> {
    let note = note(context)?;
    let parent = note
        .parent_id
        .as_deref()
        .ok_or_else(|| EngineError::invalid("Board note has no parent"))?;
    let p = context.params;
    let sticky = note.string(TYPE) == Some("sticky");
    let size = [note.number("width", 160.), note.number("height", 160.)];
    let mut x = note.number("x", 0.);
    let mut y = note.number("y", 0.);
    let (from_side, to_side) = match p["side"].as_str().unwrap_or("right") {
        "right" => {
            x += size[0] + STICKY_GAP;
            ("right", "left")
        }
        "left" => {
            x -= size[0] + STICKY_GAP;
            ("left", "right")
        }
        "below" => {
            y += size[1] + STICKY_GAP;
            ("bottom", "top")
        }
        "above" => {
            y -= size[1] + STICKY_GAP;
            ("top", "bottom")
        }
        _ => {
            return Err(EngineError::invalid(
                "side must be right, left, below or above",
            ));
        }
    };
    let scene = paths::scene(context.snapshot, &context.state.page_id)?;
    let parent_world = scene
        .item(parent)
        .ok_or_else(|| EngineError::invalid("Board parent is not on this page"))?
        .world;
    if !p["at"].is_null() {
        let [wx, wy] = pair(&p["at"], "at", -1e6, 1e6)?;
        let inverse = parent_world
            .inverse()
            .ok_or_else(|| EngineError::invalid("Board parent cannot be transformed"))?;
        let local = inverse.point(wx, wy);
        (x, y) = (local.0 - size[0] / 2., local.1 - size[1] / 2.);
    }
    let color = if sticky {
        note.string("fill")
    } else {
        children(context.snapshot, &note.id)
            .into_iter()
            .find(|node| node.kind == NodeKind::Path)
            .and_then(|node| node.string("fill"))
    };
    let params = json!({"parent":context.alias(parent),"x":x,"y":y,"width":size[0],"height":size[1],
        "shape":note.string(SHAPE).unwrap_or("rectangle"),"color":color.unwrap_or("#acd3fa"),"author":false});
    let creation = Context {
        params: &params,
        ..*context
    };
    let (new, label, mut commands) =
        build_note(&creation, if sticky { "sticky" } else { "shape" })?;
    let root = &context.snapshot.nodes[&context.state.root];
    let rank = if parent == root.id {
        rank_between(Some(&new.rank), None)
            .ok_or_else(|| EngineError::new("resource_limit", "Sibling ranks need rebalancing"))?
    } else {
        append_rank(context.snapshot, &root.id)?
    };
    let original = scene
        .item(&note.id)
        .ok_or_else(|| EngineError::invalid("Board shape is unavailable"))?;
    let a = original
        .world
        .point(original.width / 2., original.height / 2.);
    let b = parent_world.point(x + size[0] / 2., y + size[1] / 2.);
    let route = json!({
        "from":{"layer":note.id,"side":from_side,"fallback":[a.0,a.1]},
        "to":{"layer":new.id,"side":if p["at"].is_null(){to_side}else{"auto"},"fallback":[b.0,b.1]},
        "style":"elbow","startCap":"none","endCap":"triangleArrow",
    });
    let (connector, _, route_commands) = build(root, rank, route, None)?;
    commands.extend(route_commands);
    context.commit(commands)?;
    select(context, &new.id);
    edit_note_if_requested(context, &label)?;
    Ok(
        json!({"id":context.alias(&new.id),"text":context.alias(&label.id),"connector":context.alias(&connector.id)}),
    )
}
