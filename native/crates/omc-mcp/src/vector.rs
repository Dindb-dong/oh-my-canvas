use super::*;
use omc_model::NodeKind;
use omc_scene::{Affine, Scene, SceneItem};
use std::collections::BTreeSet;

pub(super) fn build(
    snapshot: &DocumentSnapshot,
    page: &str,
    name: &str,
    ids: &[String],
    args: &Value,
) -> Result<Vec<Command>> {
    let scene = paths::scene(snapshot, page)?;
    let unique: BTreeSet<&str> = ids.iter().map(String::as_str).collect();
    if ids.is_empty() || ids.len() != unique.len() {
        return Err(EngineError::invalid("choose distinct vector layers"));
    }
    let items = ids
        .iter()
        .map(|id| {
            if !snapshot.nodes.contains_key(id) || !paths::editable(&scene, id) {
                return Err(EngineError::invalid(
                    "layer is locked, hidden or outside the selected page",
                ));
            }
            let item = scene.item(id).unwrap();
            let mut parent = item.parent;
            while let Some(index) = parent {
                let ancestor = &scene.items[index];
                if unique.contains(ancestor.id.as_str()) {
                    return Err(EngineError::invalid(
                        "choose layers without selected ancestors",
                    ));
                }
                parent = ancestor.parent;
            }
            if item.parent.is_none() {
                return Err(EngineError::invalid("cannot convert a page root"));
            }
            Ok(item)
        })
        .collect::<Result<Vec<_>>>()?;
    if name == "boolean" {
        return boolean(snapshot, &scene, &items, string(args, "operation")?);
    }
    let kind = string(args, "kind")?;
    let mut commands = Vec::new();
    for item in items {
        commands.extend(outline(snapshot, &scene, item, kind)?);
    }
    Ok(commands)
}

fn boolean(
    snapshot: &DocumentSnapshot,
    scene: &Scene,
    items: &[&SceneItem],
    operation: &str,
) -> Result<Vec<Command>> {
    let first = items[0];
    let flatten = operation == "flatten";
    let parent_index = first.parent.unwrap();
    let parent = &scene.items[if items.iter().all(|item| item.parent == Some(parent_index)) {
        parent_index
    } else {
        scene.root
    }];
    let inverse = inverse(parent)?;
    let path = omc_scene::combine_paths(items.iter().copied(), &scene.items, inverse, operation)
        .ok_or_else(|| {
            EngineError::invalid(
                "Boolean requires supported vector shapes and at most 10000 path verbs",
            )
        })?;
    if flatten && path.is_empty() {
        return Err(EngineError::invalid("Boolean geometry is empty"));
    }
    let mut result = sibling(snapshot, first, parent, NodeKind::Path);
    let (svg, bounds, fill_rule) = omc_scene::normalize_path(path, Affine::IDENTITY);
    let [x, y, width, height] = bounds;
    set_position(&mut result.properties, x, y, width, height);
    set_path(&mut result.properties, svg, fill_rule);
    result.properties.insert(
        "name".into(),
        json!(match operation {
            "union" => "Union",
            "subtract" => "Subtract",
            "intersect" => "Intersect",
            "exclude" => "Exclude",
            _ => "Flattened",
        }),
    );
    copy_boolean_paint(first, &mut result);
    copy_effects(first, &mut result);
    if flatten {
        result.properties.insert(
            "flattenSourceIds".into(),
            json!(items.iter().map(|item| &item.id).collect::<Vec<_>>()),
        );
    } else {
        result
            .properties
            .insert("booleanOperation".into(), json!(operation));
    }
    let id = result.id.clone();
    let mut commands = vec![Command::NodeCreate { node: result }];
    let child_space = Affine::translation(-x, -y).multiply(inverse);
    for (index, item) in items.iter().enumerate() {
        if flatten {
            commands.push(hide(&item.id));
            continue;
        }
        let properties = absolute_placement(item, child_space.multiply(item.world));
        commands.push(Command::NodeSet {
            node_id: item.id.clone(),
            properties,
        });
        commands.push(Command::NodeMove {
            node_id: item.id.clone(),
            parent_id: Some(id.clone()),
            rank: format!(
                "{:032x}",
                (u128::MAX / (items.len() as u128 + 1)) * (index as u128 + 1)
            ),
        });
    }
    Ok(commands)
}

fn outline(
    snapshot: &DocumentSnapshot,
    scene: &Scene,
    item: &SceneItem,
    kind: &str,
) -> Result<Vec<Command>> {
    let parent = &scene.items[item.parent.unwrap()];
    let transform = inverse(parent)?.multiply(item.world);
    let mut parts = Vec::new();
    let title = if kind == "text" {
        let runs = item.properties.get("textRuns").and_then(Value::as_array);
        let unsupported_run = runs.into_iter().flatten().any(|run| {
            run.get("attributes")
                .and_then(Value::as_object)
                .is_some_and(|style| {
                    style.keys().any(|key| {
                        matches!(
                            key.as_str(),
                            "color"
                                | "text-decoration"
                                | "textDecoration"
                                | "background-color"
                                | "backgroundColor"
                        )
                    })
                })
        });
        let visible_paint = |paint: &Value| paint["visible"] != false && paint["hidden"] != true;
        let has_stroke = item
            .properties
            .get("strokes")
            .and_then(Value::as_array)
            .is_some_and(|paints| paints.iter().any(visible_paint))
            || item
                .style
                .color("border-color")
                .is_some_and(|color| color.a > 0.);
        let unsupported_fill = item
            .properties
            .get("fills")
            .and_then(Value::as_array)
            .is_some_and(|paints| {
                paints.len() > 1
                    || paints.iter().any(|paint| {
                        paint.get("gradient").is_some()
                            || paint.get("image").is_some()
                            || paint
                                .get("type")
                                .and_then(Value::as_str)
                                .is_some_and(|kind| !matches!(kind, "solid" | "color"))
                    })
            });
        if unsupported_run
            || has_stroke
            || unsupported_fill
            || item
                .properties
                .get("textBackground")
                .is_some_and(|value| !value.is_null())
            || item
                .style
                .color("background-color")
                .is_some_and(|color| color.a > 0.)
            || item
                .style
                .get("text-decoration")
                .is_some_and(|value| value != "none")
        {
            return Err(EngineError::invalid(
                "text outline requires a solid color without decorations, background or stroke",
            ));
        }
        let shape = item
            .text_outline()
            .map_err(|error| EngineError::invalid(error.to_string()))?;
        let mut fill = json!({"type":"solid","color":item.style.get("color").unwrap_or("#000000")});
        if let Some(source) = item
            .properties
            .get("fills")
            .and_then(Value::as_array)
            .filter(|v| v.len() == 1)
            .and_then(|v| v.first())
        {
            for key in ["opacity", "visible", "hidden"] {
                if let Some(value) = source.get(key) {
                    fill[key] = value.clone();
                }
            }
        }
        parts.push((shape, vec![fill]));
        "Text outline"
    } else {
        if !matches!(
            item.kind,
            NodeKind::Rect | NodeKind::Ellipse | NodeKind::Path | NodeKind::Line | NodeKind::Frame
        ) || (!item.children.is_empty() && item.boolean_operation().is_none())
        {
            return Err(EngineError::invalid(
                "stroke outline requires a vector shape without content layers",
            ));
        }
        let strokes = omc_render::stroke_outlines(item)
            .map_err(|error| EngineError::invalid(error.to_string()))?;
        let fills = solid_fills(item)?;
        if !fills.is_empty() {
            let shape =
                omc_scene::shape_path(item).ok_or_else(|| EngineError::invalid("invalid shape"))?;
            parts.push((shape, fills));
        }
        parts.extend(strokes.into_iter().map(|(shape, fill)| (shape, vec![fill])));
        "Stroke outline"
    };
    let mut commands = Vec::new();
    let mut paths: Vec<Node> = parts
        .into_iter()
        .map(|(shape, fills)| {
            let (svg, [x, y, width, height], fill_rule) =
                omc_scene::normalize_path(shape, transform);
            let mut path = sibling(snapshot, item, parent, NodeKind::Path);
            set_position(&mut path.properties, x, y, width, height);
            set_path(&mut path.properties, svg, fill_rule);
            path.properties.insert("fills".into(), json!(fills));
            path.properties.insert("name".into(), json!(title));
            path.properties
                .insert("outlineSourceId".into(), json!(item.id));
            path
        })
        .collect();
    if paths.len() > 1 {
        let mut group = sibling(snapshot, item, parent, NodeKind::Group);
        group.properties.insert("name".into(), json!(title));
        group
            .properties
            .insert("outlineSourceId".into(), json!(item.id));
        let x = paths
            .iter()
            .map(|path| path.number("x", 0.))
            .fold(f64::INFINITY, f64::min);
        let y = paths
            .iter()
            .map(|path| path.number("y", 0.))
            .fold(f64::INFINITY, f64::min);
        let right = paths
            .iter()
            .map(|path| path.number("x", 0.) + path.number("width", 0.))
            .fold(f64::NEG_INFINITY, f64::max);
        let bottom = paths
            .iter()
            .map(|path| path.number("y", 0.) + path.number("height", 0.))
            .fold(f64::NEG_INFINITY, f64::max);
        set_position(&mut group.properties, x, y, right - x, bottom - y);
        copy_effects(item, &mut group);
        let group_id = group.id.clone();
        commands.push(Command::NodeCreate { node: group });
        let rank_spacing = u128::MAX / (paths.len() as u128 + 1);
        for (index, path) in paths.iter_mut().enumerate() {
            path.parent_id = Some(group_id.clone());
            path.rank = format!("{:032x}", rank_spacing * (index as u128 + 1));
            path.properties
                .insert("x".into(), json!(path.number("x", 0.) - x));
            path.properties
                .insert("y".into(), json!(path.number("y", 0.) - y));
        }
    } else {
        copy_effects(item, &mut paths[0]);
    }
    commands.extend(paths.into_iter().map(|node| Command::NodeCreate { node }));
    commands.push(hide(&item.id));
    Ok(commands)
}

fn solid_fills(item: &SceneItem) -> Result<Vec<Value>> {
    if item
        .style
        .get("background-image")
        .is_some_and(|image| image != "none")
    {
        return Err(EngineError::invalid("stroke outline requires solid fill"));
    }
    if let Some(fills) = item.properties.get("fills").and_then(Value::as_array) {
        if fills.iter().any(|fill| {
            fill.get("type")
                .and_then(Value::as_str)
                .is_some_and(|kind| !matches!(kind, "solid" | "color"))
                || fill.get("gradient").is_some()
                || fill.get("image").is_some()
        }) {
            return Err(EngineError::invalid("stroke outline requires solid fill"));
        }
        return Ok(fills.clone());
    }
    Ok(item
        .style
        .get("background-color")
        .map(|color| json!({"type":"solid","color":color}))
        .into_iter()
        .collect())
}

fn copy_boolean_paint(source: &SceneItem, target: &mut Node) {
    for key in ["fills", "strokes"] {
        if let Some(value) = source.properties.get(key) {
            target.properties.insert(key.into(), value.clone());
        }
    }
    for key in [
        "background-color",
        "background-image",
        "border-color",
        "border-width",
    ] {
        if let Some(value) = source.style.get(key) {
            target.properties.get_mut("style").unwrap()[key] = json!(value);
        }
    }
}

fn copy_effects(source: &SceneItem, target: &mut Node) {
    for key in ["blendMode", "effects", "shadows", "blur"] {
        if let Some(value) = source.properties.get(key) {
            target.properties.insert(key.into(), value.clone());
        }
    }
    target
        .properties
        .insert("opacity".into(), json!(source.style.number("opacity", 1.)));
}

fn sibling(
    snapshot: &DocumentSnapshot,
    source: &SceneItem,
    parent: &SceneItem,
    kind: NodeKind,
) -> Node {
    let mut node = Node::new(kind);
    node.parent_id = Some(parent.id.clone());
    node.home_shard = snapshot.nodes[&source.id].home_shard.clone();
    node.rank = if source.parent.is_some()
        && snapshot.nodes[&source.id].parent_id.as_deref() == Some(parent.id.as_str())
    {
        snapshot.nodes[&source.id].rank.clone()
    } else {
        "ffffffffffffffffffffffffffffffff".into()
    };
    node.properties
        .insert("style".into(), json!({"position":"absolute"}));
    node
}

fn inverse(item: &SceneItem) -> Result<Affine> {
    item.world
        .inverse()
        .ok_or_else(|| EngineError::invalid("parent transform is not invertible"))
}

pub(super) fn absolute_placement(item: &SceneItem, transform: Affine) -> Properties {
    let [a, b, c, d, x, y] = transform.0;
    let mut properties = Properties::new();
    set_position(&mut properties, x, y, item.width, item.height);
    properties.insert("transform".into(), json!([a, b, c, d, 0., 0.]));
    let mut style = match item.properties.get("style") {
        Some(Value::Object(style)) => style.clone(),
        Some(Value::String(style)) => omc_style::parse_declarations(style)
            .into_iter()
            .map(|declaration| {
                let value = if declaration.important {
                    format!("{} !important", declaration.value)
                } else {
                    declaration.value
                };
                (declaration.name, Value::String(value))
            })
            .collect(),
        _ => Default::default(),
    };
    for key in [
        "left",
        "top",
        "right",
        "bottom",
        "width",
        "height",
        "min-width",
        "max-width",
        "min-height",
        "max-height",
        "margin",
        "margin-left",
        "margin-right",
        "margin-top",
        "margin-bottom",
    ] {
        style.remove(key);
    }
    style.insert("position".into(), json!("absolute"));
    properties.insert("style".into(), Value::Object(style));
    properties
}

fn set_position(properties: &mut Properties, x: f64, y: f64, width: f64, height: f64) {
    properties.extend([
        ("x".into(), json!(x)),
        ("y".into(), json!(y)),
        ("width".into(), json!(width)),
        ("height".into(), json!(height)),
    ]);
}

fn set_path(properties: &mut Properties, svg: String, fill_rule: &str) {
    properties.insert("path".into(), json!(svg));
    properties.insert("fillRule".into(), json!(fill_rule));
}

fn hide(id: &str) -> Command {
    Command::NodeSet {
        node_id: id.into(),
        properties: Properties::from([("visible".into(), json!(false))]),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_mcp_vector_geometry_is_live_then_editable() {
        let profile = tempfile::tempdir().unwrap();
        let workspace = Workspace::open(profile.path(), None).unwrap();
        let session = workspace.session_open(None).unwrap()["sessionId"]
            .as_str()
            .unwrap()
            .to_owned();
        let router = Arc::new(ToolRouter::new(workspace.clone()));
        let call = |name, args| router.call(&session, name, args, Value::Null).unwrap();
        let created = call("create_document", json!({"title":"Vector geometry"}));
        let document_id = created["documentId"].as_str().unwrap();
        let raw_document = native_id(document_id).unwrap();
        let revision = || workspace.snapshot(&raw_document).unwrap().sequence;
        let create = |kind, x, y, width, height, properties| {
            call("create_shape", json!({"documentId":document_id,"type":kind,"x":x,"y":y,"width":width,"height":height,"properties":properties}))
                ["rawIds"][0].as_str().unwrap().to_owned()
        };
        let inspect = |id: &str| call("get_path", json!({"documentId":document_id,"id":id}));
        let convert = |op, ids: &[&str]| {
            call(
                "boolean",
                json!({"documentId":document_id,"operation":op,"ids":ids,"revision":revision()}),
            )["rawIds"][0]
                .as_str()
                .unwrap()
                .to_owned()
        };

        let a = create(
            "rect",
            10,
            10,
            100,
            40,
            json!({"fills":[{"type":"solid","color":"#FF0000"}]}),
        );
        let b = create(
            "rect",
            70,
            10,
            80,
            40,
            json!({"fills":[{"type":"solid","color":"#0000FF"}]}),
        );
        let live = convert("subtract", &[&a, &b]);
        let original = inspect(&live);
        assert_eq!(original["editable"], false);
        let largest_x = |value: &Value| {
            value["segments"]
                .as_array()
                .unwrap()
                .iter()
                .filter_map(|segment| segment["x"].as_f64())
                .fold(0., f64::max)
        };
        assert_eq!(largest_x(&original), 70.);
        let snapshot = workspace.snapshot(&raw_document).unwrap();
        assert_eq!(snapshot.nodes[&a].parent_id.as_deref(), Some(live.as_str()));
        assert_eq!(snapshot.nodes[&b].parent_id.as_deref(), Some(live.as_str()));

        call(
            "edit_shapes",
            json!({"documentId":document_id,"action":"patch","ids":[b],"properties":{"x":40}}),
        );
        assert_eq!(largest_x(&inspect(&live)), 50.);
        let flattened = convert("flatten", &[&live]);
        let result = inspect(&flattened);
        assert_eq!(result["editable"], true);
        assert_eq!(largest_x(&result), 50.);
        assert_eq!(
            workspace.snapshot(&raw_document).unwrap().nodes[&live].properties["visible"],
            false
        );

        let point_x = result["segments"][0]["x"].as_f64().unwrap();
        call(
            "edit_path",
            json!({"documentId":document_id,"id":flattened,"revision":revision(),"action":"move_nodes","indices":[0],"dx":3,"dy":4}),
        );
        assert_eq!(inspect(&flattened)["segments"][0]["x"], point_x + 3.);

        for (operation, expected_right) in [("union", 60.), ("intersect", 50.), ("exclude", 60.)] {
            let a = create("rect", 20, 60, 30, 20, json!({}));
            let b = create("rect", 40, 60, 20, 20, json!({}));
            let result = convert(operation, &[&a, &b]);
            assert_eq!(largest_x(&inspect(&result)), expected_right);
        }
        let group = create("group", 20, 80, 100, 30, json!({}));
        for x in [0, 20] {
            call(
                "create_shape",
                json!({"documentId":document_id,"type":"rect","parentId":group,"x":x,"y":0,"width":20,"height":10}),
            );
        }
        let grouped = convert("flatten", &[&group]);
        assert_eq!(largest_x(&inspect(&grouped)), 60.);

        let line = create(
            "line",
            20,
            100,
            40,
            0,
            json!({"strokes":[{"type":"solid","color":"#123456","width":8,"cap":"round"}]}),
        );
        let text = create(
            "text",
            20,
            150,
            100,
            30,
            json!({"text":"Hi 한글","fills":[{"type":"solid","color":"#123456"}]}),
        );
        for (kind, source) in [("stroke", line), ("text", text)] {
            let result = call(
                "outline",
                json!({"documentId":document_id,"kind":kind,"ids":[source],"revision":revision()}),
            );
            let raw = result["rawIds"][0].as_str().unwrap();
            let path = inspect(raw);
            assert_eq!(path["editable"], true);
            assert!(path["segments"].as_array().unwrap().len() > 4);
            assert_eq!(
                workspace.snapshot(&raw_document).unwrap().nodes[&source].properties["visible"],
                false
            );
        }
        let png = call(
            "export_document",
            json!({"id":document_id,"format":"png","bounds":{"x":0,"y":0,"width":200,"height":200}}),
        );
        assert!(png["base64"].as_str().unwrap().len() > 200);
    }
}
