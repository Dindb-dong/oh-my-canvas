use super::*;

mod connectors;
mod grid;
mod table;
mod templates;

pub(super) const TYPE: &str = "boardItemType";
const SHAPE: &str = "boardShape";
const TIMER: &str = "boardTimer";
const STICKY_SIZE: f64 = 200.;
const STICKY_GAP: f64 = 24.;

pub(super) fn command(context: &Context, action: &str) -> Result<Value> {
    match action {
        "timer" | "timerState" => timer(context, action),
        "vote" | "voteResults" => vote::command(context, action),
        "sticky" | "shape" => make_note(context, action),
        "nextSticky" => {
            if connectors::note(context)?.string(TYPE) == Some("shape") {
                connectors::add_connected(context)
            } else {
                make_note(context, action)
            }
        }
        "template" | "templates" => templates::command(context, action),
        "grid" => grid::preference(context),
        "table" | "tableEdit" => table::command(context, action),
        "addConnected" => connectors::add_connected(context),
        "connector" | "reattach" | "reshape" | "label" => connectors::command(context, action),
        "ink" => ink(context),
        "stamp" => stamp(context),
        "setColor" | "setStyle" => style(context, action),
        _ => Err(EngineError::invalid("Unknown board command")),
    }
}

fn number(params: &Value, key: &str, default: f64) -> Result<f64> {
    params
        .get(key)
        .map(|value| {
            value
                .as_f64()
                .filter(|value| value.is_finite() && value.abs() <= 1_000_000.)
                .ok_or_else(|| EngineError::invalid(format!("Invalid board {key}")))
        })
        .transpose()
        .map(|value| value.unwrap_or(default))
}

fn board_color(value: &Value) -> Result<String> {
    omc_style::board_ink_color(value).map_err(EngineError::invalid)
}

fn new_layer(kind: NodeKind, parent: &Node, rank: String, props: Value) -> Result<Node> {
    let mut node = Node::new(kind);
    node.parent_id = Some(parent.id.clone());
    node.home_shard = parent.home_shard.clone();
    node.rank = rank;
    node.properties = properties(&props)?;
    Ok(node)
}

fn append_rank(snapshot: &DocumentSnapshot, parent: &str) -> Result<String> {
    rank_between(
        children(snapshot, parent)
            .last()
            .map(|node| node.rank.as_str()),
        None,
    )
    .ok_or_else(|| EngineError::new("resource_limit", "Sibling ranks need rebalancing"))
}

fn select(context: &Context, id: &str) {
    context.router.fig_selection(
        &(context.session.into(), context.snapshot.id.clone()),
        &[json!(context.alias(id))],
    );
}

fn edit_note_if_requested(context: &Context, label: &Node) -> Result<()> {
    if context.params["edit"] == true {
        let snapshot = context.router.workspace.snapshot(&context.snapshot.id)?;
        let state = context.router.state(context.session, &snapshot.id)?;
        context.router.fig_text_command(
            context.session,
            &snapshot,
            &state,
            &[],
            "text.edit.begin",
            &json!({"id":context.alias(&label.id)}),
        )?;
    }
    Ok(())
}

fn make_note(context: &Context, action: &str) -> Result<Value> {
    let (note, label, edits) = build_note(context, action)?;
    context.commit(edits)?;
    select(context, &note.id);
    edit_note_if_requested(context, &label)?;
    Ok(json!({"id":context.alias(&note.id),"text":context.alias(&label.id)}))
}

fn build_note(context: &Context, action: &str) -> Result<(Node, Node, Vec<Command>)> {
    let params = context.params;
    let snapshot = context.snapshot;
    let mut parent_id = params
        .get("parent")
        .map(|id| context.resolve(id))
        .transpose()?
        .unwrap_or_else(|| context.state.root.clone());
    let mut text = params["text"]
        .as_str()
        .unwrap_or_default()
        .replace("\r\n", "\n")
        .replace('\r', "\n");
    if text.chars().count() > 16_000 {
        return Err(EngineError::new(
            "resource_limit",
            "Board note exceeds 16000 characters",
        ));
    }
    let sticky = action != "shape";
    let mut color = params
        .get("color")
        .map(board_color)
        .transpose()?
        .unwrap_or_else(|| {
            if sticky {
                "#ffe78a".into()
            } else {
                "#acd3fa".into()
            }
        });
    let mut x = number(params, "x", 0.)?;
    let mut y = number(params, "y", 0.)?;
    if action == "nextSticky" {
        let raw = context.one()?;
        let mut original = &snapshot.nodes[&raw];
        if original.kind == NodeKind::Text
            && let Some(parent) = original.parent_id.as_ref()
        {
            original = &snapshot.nodes[parent];
        }
        if original.string(TYPE) != Some("sticky") {
            return Err(EngineError::invalid("Choose a sticky note"));
        }
        parent_id = original
            .parent_id
            .clone()
            .ok_or_else(|| EngineError::invalid("The note has no parent"))?;
        x = original.number("x", 0.);
        y = original.number("y", 0.);
        match params["side"].as_str().unwrap_or("right") {
            "right" => x += original.number("width", STICKY_SIZE) + STICKY_GAP,
            "left" => x -= STICKY_SIZE + STICKY_GAP,
            "below" => y += original.number("height", STICKY_SIZE) + STICKY_GAP,
            "above" => y -= STICKY_SIZE + STICKY_GAP,
            _ => {
                return Err(EngineError::invalid(
                    "side must be right, left, below or above",
                ));
            }
        }
        color = original.string("fill").unwrap_or("#ffe78a").into();
        text.clear();
    }
    let width = if sticky {
        STICKY_SIZE
    } else {
        number(params, "width", 160.)?.max(1.)
    };
    let mut height = if sticky {
        STICKY_SIZE
    } else {
        number(params, "height", 160.)?.max(1.)
    };
    let author = match &params["author"] {
        Value::String(name) => name
            .trim()
            .chars()
            .filter(|ch| !ch.is_control())
            .take(64)
            .collect::<String>(),
        Value::Bool(false) => String::new(),
        _ => context
            .router
            .workspace
            .catalog
            .lock()
            .unwrap()
            .preference()?["name"]
            .as_str()
            .unwrap_or_default()
            .chars()
            .take(64)
            .collect(),
    };
    let weight = text.chars().count() + 24 * text.matches('\n').count();
    let size = if !sticky {
        16.
    } else {
        match weight {
            0..=24 => 24.,
            25..=64 => 20.,
            65..=140 => 16.,
            141..=280 => 13.,
            _ => 11.,
        }
    };
    let lines = text
        .lines()
        .map(|line| {
            (line.chars().count() as f64 * size * 0.56 / (width - 32.).max(1.))
                .ceil()
                .max(1.)
        })
        .sum::<f64>()
        .max(1.);
    let text_height = (lines * size * 1.4).max(size * 1.4);
    if sticky {
        height = height.max(text_height + if author.is_empty() { 32. } else { 54. });
    }
    let shape = if sticky { "" } else { string(params, "shape")? };
    let parent = &snapshot.nodes[&parent_id];
    if !matches!(
        parent.kind,
        NodeKind::Frame | NodeKind::Group | NodeKind::Component
    ) || context
        .page(&parent_id)
        .is_none_or(|page| page.id != context.state.page_id)
    {
        return Err(EngineError::invalid(
            "Board parent must be a container on the current page",
        ));
    }
    let mut note = new_layer(
        NodeKind::Frame,
        parent,
        append_rank(snapshot, &parent_id)?,
        json!({
            "name":if sticky { "Sticky" } else { "Board shape" },"x":x,"y":y,"width":width,"height":height,
            "style":{"position":"absolute"},"clipContent":false
        }),
    )?;
    note.properties
        .insert(TYPE.into(), json!(if sticky { "sticky" } else { "shape" }));
    if sticky {
        note.properties.insert("fill".into(), json!(color));
        note.properties.insert("radius".into(), json!(2));
    } else {
        note.properties.insert(SHAPE.into(), json!(shape));
    }
    let mut edits = vec![Command::NodeCreate { node: note.clone() }];
    let mut rank = rank_between(None, None).unwrap();
    if !sticky {
        let background = new_layer(
            NodeKind::Path,
            &note,
            rank.clone(),
            json!({
                "name":"Shape","x":0,"y":0,"width":width,"height":height,"path":shape_path(shape,width,height)?,"fill":color,
                "style":{"position":"absolute"}
            }),
        )?;
        edits.push(Command::NodeCreate { node: background });
        rank = rank_between(Some(&rank), None).unwrap();
    }
    let label = new_layer(
        NodeKind::Text,
        &note,
        rank.clone(),
        json!({
            "name":text.lines().next().filter(|line| !line.trim().is_empty()).map(|line| line.chars().take(64).collect::<String>()).unwrap_or_else(|| "Text".into()),
            "x":16,"y":if sticky {16.} else {(height-text_height).max(0.)/2.},
            "width":(width-32.).max(1.),"height":text_height,"text":text,"fill":"#1e1e1e","fontSize":size,
            "textAlign":if sticky {"left"} else {"center"},"style":{"position":"absolute"}
        }),
    )?;
    edits.push(Command::NodeCreate {
        node: label.clone(),
    });
    if sticky && !author.is_empty() {
        let author = new_layer(
            NodeKind::Text,
            &note,
            rank_between(Some(&rank), None).unwrap(),
            json!({
                "name":"Author","text":author,"x":16,"y":height-26.,"width":width-32.,"height":14.,"fill":"#5c5a55","fontSize":10,"style":{"position":"absolute"}
            }),
        )?;
        edits.push(Command::NodeCreate { node: author });
    }
    Ok((note, label, edits))
}

fn shape_path(shape: &str, w: f64, h: f64) -> Result<String> {
    use std::fmt::Write;
    let polygon = |points: &[(f64, f64)]| {
        let mut path = String::new();
        for (index, (x, y)) in points.iter().enumerate() {
            let _ = write!(
                path,
                "{}{} {} ",
                if index == 0 { "M" } else { "L" },
                x * w,
                y * h
            );
        }
        path.push('Z');
        path
    };
    let regular = |count: usize, phase: f64| {
        let points = (0..count)
            .map(|i| {
                let angle = (i as f64 / count as f64) * std::f64::consts::TAU + phase;
                (0.5 + angle.cos() * 0.5, 0.5 + angle.sin() * 0.5)
            })
            .collect::<Vec<_>>();
        polygon(&points)
    };
    let result = match shape {
        "rectangle" => polygon(&[(0., 0.), (1., 0.), (1., 1.), (0., 1.)]),
        "roundedRectangle" => {
            let r = w.min(h) * 0.12;
            format!(
                "M{r} 0H{}Q{w} 0 {w} {r}V{}Q{w} {h} {} {h}H{r}Q0 {h} 0 {}V{r}Q0 0 {r} 0Z",
                w - r,
                h - r,
                w - r,
                h - r
            )
        }
        "ellipse" => format!(
            "M0 {} A{} {} 0 1 0 {w} {} A{} {} 0 1 0 0 {}Z",
            h / 2.,
            w / 2.,
            h / 2.,
            h / 2.,
            w / 2.,
            h / 2.,
            h / 2.
        ),
        "diamond" => polygon(&[(0.5, 0.), (1., 0.5), (0.5, 1.), (0., 0.5)]),
        "triangle" => polygon(&[(0.5, 0.), (1., 1.), (0., 1.)]),
        "triangleDown" => polygon(&[(0., 0.), (1., 0.), (0.5, 1.)]),
        "parallelogramRight" => polygon(&[(0.2, 0.), (1., 0.), (0.8, 1.), (0., 1.)]),
        "parallelogramLeft" => polygon(&[(0., 0.), (0.8, 0.), (1., 1.), (0.2, 1.)]),
        "trapezoid" => polygon(&[(0.2, 0.), (0.8, 0.), (1., 1.), (0., 1.)]),
        "pentagon" => regular(5, -std::f64::consts::FRAC_PI_2),
        "hexagon" => regular(6, 0.),
        "octagon" => regular(8, std::f64::consts::FRAC_PI_8),
        "star" => {
            let points = (0..10)
                .map(|i| {
                    let angle =
                        (i as f64) * std::f64::consts::TAU / 10. - std::f64::consts::FRAC_PI_2;
                    let radius = if i % 2 == 0 { 0.5 } else { 0.24 };
                    (0.5 + radius * angle.cos(), 0.5 + radius * angle.sin())
                })
                .collect::<Vec<_>>();
            polygon(&points)
        }
        "plus" => polygon(&[
            (0.35, 0.),
            (0.65, 0.),
            (0.65, 0.35),
            (1., 0.35),
            (1., 0.65),
            (0.65, 0.65),
            (0.65, 1.),
            (0.35, 1.),
            (0.35, 0.65),
            (0., 0.65),
            (0., 0.35),
            (0.35, 0.35),
        ]),
        "arrowLeft" | "arrowRight" => {
            let mut points = [
                (0., 0.28),
                (0.56, 0.28),
                (0.56, 0.),
                (1., 0.5),
                (0.56, 1.),
                (0.56, 0.72),
                (0., 0.72),
            ];
            if shape == "arrowLeft" {
                points.iter_mut().for_each(|(x, _)| *x = 1. - *x);
            }
            polygon(&points)
        }
        "chevron" => polygon(&[
            (0., 0.),
            (0.7, 0.),
            (1., 0.5),
            (0.7, 1.),
            (0., 1.),
            (0.3, 0.5),
        ]),
        "speechBubble" => polygon(&[
            (0., 0.),
            (1., 0.),
            (1., 0.8),
            (0.4, 0.8),
            (0.15, 1.),
            (0.15, 0.8),
            (0., 0.8),
        ]),
        "database" => format!(
            "M0 {}Q{} {} {w} {}V{}Q{} {h} 0 {}Z M0 {}Q{} {} {w} {}",
            h * 0.16,
            w / 2.,
            -h * 0.16,
            h * 0.16,
            h * 0.82,
            w / 2.,
            h * 0.82,
            h * 0.16,
            w / 2.,
            h * 0.45,
            h * 0.16
        ),
        "document" => format!(
            "M0 0H{w}V{}Q{} {} {} {}T0 {}Z",
            h * 0.85,
            w * 0.75,
            h,
            w * 0.5,
            h * 0.88,
            h * 0.92
        ),
        "predefinedProcess" => format!("M0 0H{w}V{h}H0Z M{} 0V{h} M{} 0V{h}", w * 0.15, w * 0.85),
        "manualInput" => polygon(&[(0., 0.2), (1., 0.), (1., 1.), (0., 1.)]),
        "internalStorage" => format!("M0 0H{w}V{h}H0Z M{} 0V{h} M0 {}H{w}", w * 0.18, h * 0.2),
        _ => return Err(EngineError::invalid("Unknown board shape")),
    };
    Ok(result)
}

fn stamp(context: &Context) -> Result<Value> {
    // Stamp palette and mark geometry from FigCraft v0.17.0, MIT. See THIRD_PARTY_NOTICES.md.
    let kind = omc_style::board_stamp_name(&context.params["stamp"]).map_err(EngineError::invalid)?;
    let (name, color, marks): (&str, &str, &[(&str, bool)]) = match kind {
        "thumbsUp" => (
            "Thumbs up",
            "#3b82e8",
            &[(
                "M10.5 19 H15 V29 H10.5 Z M16.5 19 L20.6 11.4 C21.6 9.8 24.6 10.6 24.2 13 L23.4 17 H28.2 C29.8 17 30.9 18.5 30.4 20 L28.4 27.3 C28 28.4 27.1 29 25.9 29 H16.5 Z",
                true,
            )],
        ),
        "heart" => (
            "Heart",
            "#e5485f",
            &[(
                "M20 29.5 C12.5 24.5 9.5 20.6 10.4 16.4 C11.3 12.2 16.8 11.2 20 15.4 C23.2 11.2 28.7 12.2 29.6 16.4 C30.5 20.6 27.5 24.5 20 29.5 Z",
                true,
            )],
        ),
        "plusOne" => (
            "Plus one",
            "#2ea063",
            &[("M10 20 H20 M15 15 V25 M24.5 15 L27.5 12.5 V27.5", false)],
        ),
        "star" => (
            "Star",
            "#ee9b1a",
            &[(
                "M20 10.5 L22.8 16.7 L29.5 17.4 L24.5 21.9 L25.9 28.6 L20 25.2 L14.1 28.6 L15.5 21.9 L10.5 17.4 L17.2 16.7 Z",
                true,
            )],
        ),
        "question" => (
            "Question",
            "#845ed8",
            &[
                (
                    "M15.6 16.2 C15.6 10.6 24.4 10.6 24.4 16 C24.4 19.6 20 19.9 20 23.6",
                    false,
                ),
                (
                    "M18.2 28 A1.8 1.8 0 1 0 21.8 28 A1.8 1.8 0 1 0 18.2 28 Z",
                    true,
                ),
            ],
        ),
        "check" => ("Check", "#14968c", &[("M12.5 20.5 L18 26 L28 14.5", false)]),
        _ => return Err(EngineError::invalid("Unknown board stamp")),
    };
    for field in ["x", "y"] {
        if context.params.get(field).is_none() {
            return Err(EngineError::invalid(format!("{field} required")));
        }
    }
    let x = number(context.params, "x", 0.)?;
    let y = number(context.params, "y", 0.)?;
    let author = context
        .router
        .workspace
        .catalog
        .lock()
        .unwrap()
        .preference()?["name"]
        .as_str()
        .unwrap_or_default()
        .chars()
        .take(64)
        .collect::<String>();
    let parent = &context.snapshot.nodes[&context.state.root];
    let node = new_layer(
        NodeKind::Frame,
        parent,
        append_rank(context.snapshot, &parent.id)?,
        json!({"name":name,"boardItemType":"stamp","boardStamp":kind,
            "boardAuthor":author,"x":x-20.,"y":y-20.,"width":40,"height":40,"cornerRadius":20,
            "fill":color,"style":{"position":"absolute"}}),
    )?;
    let mut edits = vec![Command::NodeCreate { node: node.clone() }];
    let mut rank = rank_between(None, None).unwrap();
    for (path, filled) in marks {
        let mut props = json!({"name":"Mark","x":0,"y":0,"width":40,"height":40,"path":path,
            "fill":if *filled { "#ffffff" } else { "none" },"style":{"position":"absolute"}});
        if !filled {
            props["strokes"] = json!([{"type":"solid","color":"#ffffff","width":2.6,"cap":"round","join":"round"}]);
        }
        edits.push(Command::NodeCreate {
            node: new_layer(NodeKind::Path, &node, rank.clone(), props)?,
        });
        rank = rank_between(Some(&rank), None).unwrap();
    }
    context.commit(edits)?;
    Ok(json!({"id":context.alias(&node.id)}))
}

fn ink(context: &Context) -> Result<Value> {
    use std::fmt::Write;
    let params = context.params;
    let path = if let Some(path) = params["path"].as_str() {
        if path.len() > 100_000 {
            return Err(EngineError::new("resource_limit", "Ink path is too large"));
        }
        path.to_owned()
    } else {
        let points = params["points"]
            .as_array()
            .filter(|points| (2..=10_000).contains(&points.len()))
            .ok_or_else(|| EngineError::invalid("Provide a path or between 2 and 10000 points"))?;
        let mut path = String::new();
        for (index, point) in points.iter().enumerate() {
            let point = point
                .as_array()
                .filter(|point| point.len() == 2)
                .ok_or_else(|| EngineError::invalid("Expected [x, y]"))?;
            let coordinate = |index: usize| {
                point[index]
                    .as_f64()
                    .filter(|value| value.is_finite() && value.abs() <= 1_000_000.)
                    .ok_or_else(|| EngineError::invalid("Invalid ink coordinate"))
            };
            let _ = write!(
                path,
                "{}{} {} ",
                if index == 0 { "M" } else { "L" },
                coordinate(0)?,
                coordinate(1)?
            );
        }
        path
    };
    let path = skia_safe::Path::from_svg(&path)
        .filter(|path| !path.is_empty())
        .ok_or_else(|| EngineError::invalid("Invalid ink path"))?;
    let (data, [x, y, width, height], rule) =
        omc_scene::normalize_path(path, omc_scene::Affine::IDENTITY);
    if ![x, y, width, height]
        .iter()
        .all(|value| value.is_finite() && value.abs() <= 1_000_000.)
    {
        return Err(EngineError::invalid("Invalid ink path bounds"));
    }
    let highlighter = params["highlighter"] == true;
    let color = params
        .get("color")
        .map(board_color)
        .transpose()?
        .unwrap_or_else(|| {
            if highlighter {
                "#ffe78a".into()
            } else {
                "#1e1e1e".into()
            }
        });
    let node = new_layer(
        NodeKind::Path,
        &context.snapshot.nodes[&context.state.root],
        append_rank(context.snapshot, &context.state.root)?,
        json!({
            "name":if highlighter {"Highlighter"} else {"Marker"},
            "boardItemType":"ink","x":x,"y":y,"width":width.max(1.),"height":height.max(1.),"path":data,"fillRule":rule,"fill":"none",
            "strokes":[{"type":"solid","color":color,"width":if highlighter {20}else{4},"cap":"round","join":"round"}],
            "opacity":if highlighter {0.45} else {1.},"style":{"position":"absolute"}
        }),
    )?;
    context.commit(vec![Command::NodeCreate { node: node.clone() }])?;
    if params["select"] != false {
        select(context, &node.id);
    }
    Ok(json!({"id":context.alias(&node.id)}))
}

fn style(context: &Context, action: &str) -> Result<Value> {
    let ids = context.many()?;
    let params = context.params;
    let color = if action == "setColor" {
        Some(board_color(&params["color"])?)
    } else {
        None
    };
    let size = if params.get("fontSize").is_some() {
        Some(number(params, "fontSize", 16.)?.clamp(1., 500.))
    } else {
        None
    };
    let new_shape = params
        .get("shape")
        .map(|_| string(params, "shape"))
        .transpose()?;
    let mut edits = Vec::new();
    for id in ids {
        let node = &context.snapshot.nodes[&id];
        let items = children(context.snapshot, &id);
        let kind = node
            .string(TYPE)
            .ok_or_else(|| EngineError::invalid("Choose a board object"))?;
        if let Some(color) = &color {
            match kind {
                "sticky" => edits.push(context.patch(&id, "fill", json!(color))),
                "shape" => {
                    let background = items
                        .iter()
                        .find(|node| node.kind == NodeKind::Path)
                        .ok_or_else(|| EngineError::invalid("Board shape background missing"))?;
                    edits.push(context.patch(&background.id, "fill", json!(color)));
                }
                "connector" => edits.push(context.patch(&id, "fill", json!(color))),
                "ink" => {
                    let mut strokes = array(node.properties.get("strokes"));
                    let stroke = strokes
                        .first_mut()
                        .ok_or_else(|| EngineError::invalid("Ink stroke missing"))?;
                    stroke["color"] = json!(color);
                    edits.push(context.patch(&id, "strokes", json!(strokes)));
                }
                _ => return Err(EngineError::invalid("Cannot recolor this board object")),
            }
        }
        if kind == "connector" {
            if let Some(mut connector) = node.properties.get("boardConnector").cloned() {
                connectors::settings(&mut connector, params)?;
                if params.get("style").is_some() {
                    connector["control"] = Value::Null;
                }
                edits.push(context.patch(&id, "boardConnector", connector));
            }
        }
        if let Some(size) = size {
            let label = items
                .iter()
                .find(|node| node.kind == NodeKind::Text)
                .ok_or_else(|| EngineError::invalid("Board text missing"))?;
            edits.push(context.patch(&label.id, "fontSize", json!(size)));
        }
        if let Some(shape) = new_shape {
            let background = items
                .iter()
                .find(|node| node.kind == NodeKind::Path)
                .ok_or_else(|| EngineError::invalid("Choose a board shape"))?;
            edits.push(context.patch(&id, SHAPE, json!(shape)));
            edits.push(context.patch(
                &background.id,
                "path",
                json!(shape_path(
                    shape,
                    node.number("width", 160.),
                    node.number("height", 160.)
                )?),
            ));
        }
    }
    context.commit(edits)?;
    Ok(json!({"ok":true}))
}

fn timer(context: &Context, command: &str) -> Result<Value> {
    use std::time::{SystemTime, UNIX_EPOCH};
    const MAX: u64 = 24 * 60 * 60 * 1000;
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    let mut timer = context
        .snapshot
        .metadata
        .get(TIMER)
        .cloned()
        .unwrap_or(Value::Null);
    let time_left = |timer: &Value| {
        timer["ends"]
            .as_u64()
            .map_or_else(
                || timer["left"].as_u64().unwrap_or(0),
                |ends| ends.saturating_sub(now),
            )
            .min(MAX)
    };
    if command == "timer" {
        let action = string(context.params, "action")?;
        let duration = || -> Result<u64> {
            let value = number(
                context.params,
                "minutes",
                if action == "start" { 5. } else { 1. },
            )?;
            let millis = (value * 60_000.).round();
            if !(1000. ..=MAX as f64).contains(&millis) {
                return Err(EngineError::invalid(
                    "Timer duration must be between 1 second and 1440 minutes",
                ));
            }
            Ok(millis as u64)
        };
        let left = time_left(&timer);
        let next = match action {
            "start" => json!({"state":"running","ends":now+duration()?}),
            "pause" if timer["state"] == "running" && left > 0 => {
                json!({"state":"paused","left":left})
            }
            "resume" if timer["state"] == "paused" => json!({"state":"running","ends":now+left}),
            "add" if timer["state"] == "paused" => {
                json!({"state":"paused","left":(left+duration()?).min(MAX)})
            }
            "add" if !timer.is_null() => {
                json!({"state":"running","ends":now+(left+duration()?).min(MAX)})
            }
            "stop" => Value::Null,
            "pause" => return Err(EngineError::invalid("Timer is not running")),
            "resume" => return Err(EngineError::invalid("Timer is not paused")),
            "add" => return Err(EngineError::invalid("Start a timer before adding time")),
            _ => return Err(EngineError::invalid("Unknown timer action")),
        };
        if next != timer {
            context.commit(vec![Command::DocumentMetadata {
                properties: Properties::from([(TIMER.into(), next.clone())]),
            }])?;
            timer = next;
        }
    }
    let left = time_left(&timer);
    let secs = left.div_ceil(1000);
    let state = if timer.is_null() {
        "off"
    } else if timer["state"] == "paused" {
        "paused"
    } else if left == 0 {
        "done"
    } else {
        timer["state"].as_str().unwrap_or("off")
    };
    let text = if secs >= 3600 {
        format!("{}:{:02}:{:02}", secs / 3600, (secs / 60) % 60, secs % 60)
    } else {
        format!("{}:{:02}", secs / 60, secs % 60)
    };
    Ok(json!({"state":state,"left":left,"text":text,"ends":timer["ends"]}))
}
