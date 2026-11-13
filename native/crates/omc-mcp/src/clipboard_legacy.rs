//! Interchange with the Electron OMC clipboard, whose layer geometry is in page coordinates.
use super::*;
use base64::Engine;
use omc_model::{NodeKind, initial_rank};
use omc_scene::{Affine, Scene, SceneItem};
use serde_json::Map;
use std::{collections::BTreeSet, fmt::Write};
use svgtypes::{SimplePathSegment, SimplifyingPathParser};

pub(crate) const KIND: &str = "oh-my-canvas/shapes";
const MAX_NODES: usize = 100;
const APPEARANCE: &[&str] = &[
    "name",
    "opacity",
    "locked",
    "clipContent",
    "blendMode",
    "fills",
    "strokes",
    "strokeWidth",
    "strokeAlignment",
    "strokeCap",
    "strokeJoin",
    "strokeDashArray",
    "strokeSides",
    "effects",
    "shadows",
    "blur",
    "backgroundBlur",
    "radii",
    "cornerSmoothing",
    "fillRule",
];
const TEXT_STYLE: &[&str] = &[
    "fontFamily",
    "fontSize",
    "fontWeight",
    "fontStyle",
    "lineHeight",
    "letterSpacing",
    "textAlign",
    "textDecoration",
    "textTransform",
    "paragraphSpacing",
    "paragraphIndent",
];

fn invalid(message: impl std::fmt::Display) -> EngineError {
    EngineError::invalid(message.to_string())
}

fn finite(value: &Value) -> Result<f64> {
    value
        .as_f64()
        .filter(|n| n.abs() <= 1e9)
        .ok_or_else(|| invalid("Invalid legacy clipboard coordinate"))
}

fn world(shape: &Value) -> Result<Affine> {
    let (x, y, w, h) = (
        finite(&shape["x"])?,
        finite(&shape["y"])?,
        finite(&shape["width"])?,
        finite(&shape["height"])?,
    );
    if w < 0. || h < 0. {
        return Err(invalid("Invalid legacy layer size"));
    }
    let (a, b, c, d) = if let Some(matrix) = shape.get("transform") {
        (
            finite(&matrix["a"])?,
            finite(&matrix["b"])?,
            finite(&matrix["c"])?,
            finite(&matrix["d"])?,
        )
    } else {
        let (sin, cos) = shape["rotation"]
            .as_f64()
            .unwrap_or(0.)
            .to_radians()
            .sin_cos();
        let flip = |axis| if shape[axis] == true { -1. } else { 1. };
        (
            cos * flip("flipX"),
            sin * flip("flipX"),
            -sin * flip("flipY"),
            cos * flip("flipY"),
        )
    };
    let matrix = Affine([
        a,
        b,
        c,
        d,
        x + w / 2. - a * w / 2. - c * h / 2.,
        y + h / 2. - b * w / 2. - d * h / 2.,
    ]);
    if matrix.inverse().is_none() {
        return Err(invalid("Singular legacy clipboard layer"));
    }
    Ok(matrix)
}

fn set_geometry(node: &mut Node, matrix: Affine) {
    let [a, b, c, d, x, y] = matrix.0;
    node.properties.insert("x".into(), json!(x));
    node.properties.insert("y".into(), json!(y));
    if [a, b, c, d] != [1., 0., 0., 1.] {
        node.properties
            .insert("transform".into(), json!([a, b, c, d, 0., 0.]));
    }
}

fn text_attributes(value: &Value) -> Properties {
    let mut attributes = TEXT_STYLE
        .iter()
        .filter_map(|key| Some(((*key).to_owned(), value.get(*key)?.clone())))
        .collect::<Properties>();
    if let Some(color) = value["fills"]
        .as_array()
        .and_then(|paints| paints.first())
        .and_then(|paint| paint["color"].as_str())
        .or_else(|| value["color"].as_str())
    {
        attributes.insert("fill".into(), json!(color));
    }
    attributes
}

fn import_text(shape: &Value, node: &mut Node) -> Result<()> {
    let mut text = String::new();
    let mut runs = Vec::new();
    if let Some(paragraphs) = shape["content"]["children"].as_array() {
        for (index, paragraph) in paragraphs.iter().enumerate() {
            if index > 0 {
                text.push('\n');
                runs.push(json!({"text":"\n","attributes":{}}));
            }
            let attributes = text_attributes(paragraph);
            let children = paragraph["children"]
                .as_array()
                .ok_or_else(|| invalid("Invalid legacy text paragraph"))?;
            for run in children {
                let part = string(run, "text")?;
                if part.is_empty() {
                    continue;
                }
                let mut run_style = attributes.clone();
                run_style.extend(text_attributes(run));
                text.push_str(part);
                runs.push(json!({"text":part,"attributes":run_style}));
            }
        }
    } else {
        text = shape["text"].as_str().unwrap_or_default().to_owned();
    }
    if runs.len() > 4000 || text.len() > 100_000 {
        return Err(invalid("Legacy clipboard text is too large"));
    }
    node.properties.insert("text".into(), json!(text));
    if !runs.is_empty() {
        node.properties.insert("textRuns".into(), json!(runs));
    }
    Ok(())
}

fn import_path(shape: &Value, inverse: Affine) -> Result<String> {
    let records = shape["content"]
        .as_array()
        .or_else(|| shape["segments"].as_array())
        .filter(|segments| segments.len() <= 10000)
        .ok_or_else(|| invalid("Legacy clipboard paths require editable segments"))?;
    let mut path = String::new();
    let point = |record: &Value, x: &str, y: &str| -> Result<(f64, f64)> {
        Ok(inverse.point(finite(&record[x])?, finite(&record[y])?))
    };
    for segment in records {
        let command = segment["command"]
            .as_str()
            .or_else(|| segment["type"].as_str())
            .unwrap_or("");
        if matches!(command, "close" | "z" | "Z") {
            path.push('Z');
            continue;
        }
        let (x, y) = point(segment, "x", "y")?;
        match command {
            "move" | "M" => write!(path, "M{x} {y}").unwrap(),
            "line" | "L" => write!(path, "L{x} {y}").unwrap(),
            "curve" | "cubic" | "C" => {
                let (x1, y1) = point(segment, "x1", "y1")?;
                let (x2, y2) = point(segment, "x2", "y2")?;
                write!(path, "C{x1} {y1} {x2} {y2} {x} {y}").unwrap();
            }
            "quadratic" | "Q" => {
                let (x1, y1) = point(segment, "x1", "y1")?;
                write!(path, "Q{x1} {y1} {x} {y}").unwrap();
            }
            _ => return Err(invalid("Unsupported legacy clipboard path segment")),
        }
    }
    Ok(path)
}

fn appearance(shape: &Value) -> Properties {
    let mut props = APPEARANCE
        .iter()
        .filter_map(|key| Some(((*key).to_owned(), shape.get(*key)?.clone())))
        .collect::<Properties>();
    if let Some(color) = shape["fills"]
        .as_array()
        .and_then(|paints| paints.first())
        .and_then(|paint| paint["color"].as_str())
    {
        props.insert("fill".into(), json!(color));
    }
    if let Some(paint) = shape["strokes"]
        .as_array()
        .and_then(|paints| paints.first())
    {
        if let Some(color) = paint["color"].as_str() {
            props.insert("stroke".into(), json!(color));
        }
        if let Some(width) = paint["width"].as_f64() {
            props.entry("strokeWidth".into()).or_insert(json!(width));
        }
    }
    if let Some(radius) = shape.get("radius") {
        props.insert("cornerRadius".into(), radius.clone());
    }
    if shape["hidden"] == true {
        props.insert("visible".into(), json!(false));
    }
    props
}

impl ToolRouter {
    pub(crate) fn import_legacy_clipboard(&self, payload: &Value) -> Result<Value> {
        let shapes = payload["shapes"]
            .as_array()
            .filter(|shapes| (1..=MAX_NODES).contains(&shapes.len()))
            .ok_or_else(|| invalid("Legacy clipboard requires 1–100 shapes"))?;
        let roots = payload["roots"]
            .as_array()
            .filter(|roots| !roots.is_empty())
            .ok_or_else(|| invalid("Legacy clipboard roots are required"))?;
        let mut source = BTreeMap::new();
        for shape in shapes {
            let id = string(shape, "id")?;
            if id.is_empty()
                || id.len() > 256
                || matches!(id, "root" | "__proto__" | "constructor" | "prototype")
                || source.insert(id, shape).is_some()
            {
                return Err(invalid("Invalid legacy clipboard layer ID"));
            }
        }
        let mut root_ids = BTreeSet::new();
        for root in roots {
            if !root
                .as_str()
                .is_some_and(|root| source.contains_key(root) && root_ids.insert(root))
            {
                return Err(invalid("Invalid legacy clipboard root"));
            }
        }
        let matrices = source
            .iter()
            .map(|(id, shape)| Ok((*id, world(shape)?)))
            .collect::<Result<BTreeMap<_, _>>>()?;
        let mut nodes = Vec::new();
        let mut geometry = Map::new();
        let mut visited = BTreeSet::new();
        let mut pending = roots
            .iter()
            .rev()
            .map(|root| (root.as_str().unwrap(), None, 0))
            .collect::<Vec<_>>();
        while let Some((id, parent, index)) = pending.pop() {
            if !visited.insert(id) {
                return Err(invalid("Cyclic or repeated legacy clipboard layer"));
            }
            let shape = source[id];
            let kind = match string(shape, "type")? {
                "frame" => NodeKind::Frame,
                "group" => NodeKind::Group,
                "rect" => NodeKind::Rect,
                "ellipse" => NodeKind::Ellipse,
                "path" => NodeKind::Path,
                "text" => NodeKind::Text,
                "image" => NodeKind::Image,
                _ => return Err(invalid("Unsupported legacy clipboard layer type")),
            };
            let mut node = Node::new(kind);
            node.id = id.to_owned();
            node.parent_id = parent.map(str::to_owned);
            node.rank = if parent.is_none() {
                initial_rank()
            } else {
                format!("{:032x}", (u128::MAX / 101) * (index as u128 + 1))
            };
            node.properties = appearance(shape);
            let w = finite(&shape["width"])?;
            let h = finite(&shape["height"])?;
            node.properties.insert("width".into(), json!(w));
            node.properties.insert("height".into(), json!(h));
            let world = matrices[id];
            let local = parent.map_or(world, |parent: &str| {
                matrices[parent].inverse().unwrap().multiply(world)
            });
            set_geometry(&mut node, local);
            if kind == NodeKind::Text {
                import_text(shape, &mut node)?;
            }
            if kind == NodeKind::Path {
                node.properties.insert(
                    "path".into(),
                    json!(import_path(shape, world.inverse().unwrap())?),
                );
            }
            if kind == NodeKind::Image {
                let source = shape["image"]["src"]
                    .as_str()
                    .or_else(|| {
                        shape["assetId"]
                            .as_str()
                            .and_then(|id| payload["assetDefinitions"][id]["src"].as_str())
                    })
                    .ok_or_else(|| invalid("Legacy clipboard image requires an embedded asset"))?;
                let (mime, bytes) = resources::decode_data_url(source)?;
                if !matches!(mime.as_str(), "image/png" | "image/jpeg" | "image/webp")
                    || resources::detect_mime(&bytes)? != mime
                {
                    return Err(invalid("Legacy clipboard raster media type does not match"));
                }
                let asset = self.resources()?.0.ingest(&bytes, &mime)?;
                node.properties
                    .insert("assetHash".into(), json!(asset.hash));
            }
            if parent.is_none() {
                geometry.insert(
                    id.to_owned(),
                    json!({"matrix":world.0,"bounds":world.bounds(w,h)}),
                );
            }
            let explicit = shape["childIds"].as_array();
            let children = if let Some(explicit) = explicit {
                explicit
                    .iter()
                    .map(|child| {
                        child
                            .as_str()
                            .ok_or_else(|| invalid("Invalid legacy child ID"))
                    })
                    .collect::<Result<Vec<_>>>()?
            } else {
                shapes
                    .iter()
                    .filter(|shape| shape["parentId"] == id)
                    .filter_map(|shape| shape["id"].as_str())
                    .collect()
            };
            for (index, child) in children.into_iter().enumerate().rev() {
                if root_ids.contains(child)
                    || source
                        .get(child)
                        .is_none_or(|record| record["parentId"] != id)
                {
                    return Err(invalid("Invalid legacy clipboard child tree"));
                }
                pending.push((child, Some(id), index));
            }
            nodes.push(node);
        }
        if visited.len() != source.len() {
            return Err(invalid("Legacy clipboard includes unreachable layers"));
        }
        Ok(json!({"format":"omc.clipboard/1","roots":roots,"nodes":nodes,"rootGeometry":geometry}))
    }

    pub(crate) fn export_legacy_clipboard(
        &self,
        snapshot: &DocumentSnapshot,
        scene: &Scene,
        page: &str,
        roots: &[String],
        ids: &BTreeSet<String>,
        max_bytes: usize,
    ) -> Result<Map<String, Value>> {
        let mut shapes = Vec::new();
        let mut assets = Map::<String, Value>::new();
        let size_error = || invalid("Legacy clipboard exceeds the MCP request size");
        if max_bytes == 0 {
            return Err(size_error());
        }
        let mut remaining = max_bytes;
        let mut pending = roots
            .iter()
            .rev()
            .map(|root| (root.as_str(), "root", "root"))
            .collect::<Vec<_>>();
        while let Some((raw, parent, enclosing)) = pending.pop() {
            let node = &snapshot.nodes[raw];
            let item = scene
                .item(raw)
                .ok_or_else(|| invalid("Layer is unavailable in the legacy clipboard"))?;
            let kind = match node.kind {
                NodeKind::Frame | NodeKind::Component => "frame",
                NodeKind::Group => "group",
                NodeKind::Rect => "rect",
                NodeKind::Ellipse => "ellipse",
                NodeKind::Text => "text",
                NodeKind::Image => "image",
                NodeKind::Path | NodeKind::Line => "path",
                NodeKind::Instance => {
                    return Err(invalid(
                        "Legacy clipboard component instances require a standalone conversion",
                    ));
                }
            };
            let width = item.width;
            let height = item.height;
            let [a, b, c, d, _, _] = item.world.0;
            let (cx, cy) = item.world.point(width / 2., height / 2.);
            let x = cx - width / 2.;
            let y = cy - height / 2.;
            let matrix =
                |[a, b, c, d, _, _]: [f64; 6]| json!({"a":a,"b":b,"c":c,"d":d,"e":0,"f":0});
            let inverse = item
                .world
                .inverse()
                .ok_or_else(|| invalid("Singular legacy clipboard layer"))?;
            let corner = |(x, y)| {
                let (x, y) = item.world.point(x, y);
                json!({"x":x,"y":y})
            };
            let mut shape = json!({"id":raw,"type":kind,"parentId":parent,"enclosingFrameId":enclosing,
                "x":x,"y":y,"width":width,"height":height,"name":node.string("name").unwrap_or("Layer"),
                "box":{"x":x,"y":y,"width":width,"height":height},
                "corners":[corner((0.,0.)),corner((width,0.)),corner((width,height)),corner((0.,height))],
                "transform":matrix([a,b,c,d,0.,0.]),"inverseTransform":matrix(inverse.0),
                "rotation":b.atan2(a).to_degrees(),"hidden":item.hidden,"locked":item.locked});
            for field in APPEARANCE {
                if let Some(value) = item.properties.get(*field) {
                    shape[*field] = value.clone();
                }
            }
            if let Some(radius) = item.properties.get("cornerRadius") {
                shape["radius"] = radius.clone();
            }
            let paint = |color: Option<&str>, opacity: f64| {
                color
                    .filter(|color| !matches!(*color, "none" | "transparent"))
                    .map_or_else(
                        || json!([]),
                        |color| json!([{"color":color,"type":"solid","opacity":opacity}]),
                    )
            };
            if shape.get("fills").is_none() {
                shape["fills"] = paint(item.properties.get("fill").and_then(Value::as_str), 1.);
            }
            if shape.get("strokes").is_none() {
                shape["strokes"] = paint(item.properties.get("stroke").and_then(Value::as_str), 1.);
                if let Some(stroke) = shape["strokes"].get_mut(0) {
                    stroke["width"] = json!(node.number("strokeWidth", 1.));
                }
            }
            if kind == "text" {
                shape["content"] = export_text(item);
                shape["fills"] = json!([]);
                shape["autoResize"] = json!("fixed");
            }
            if kind == "path" {
                let path = if node.kind == NodeKind::Line {
                    format!("M0 0L{width} {height}")
                } else {
                    node.string("path").unwrap_or("").to_owned()
                };
                shape["content"] = json!(export_path(&path, item.world)?);
                shape["pathContentVersion"] = json!(1);
            }
            if kind == "image" {
                let hash = node
                    .string("assetHash")
                    .ok_or_else(|| invalid("Image asset unavailable"))?;
                if let Some(asset) = assets.get(hash) {
                    if asset["src"].as_str().unwrap_or_default().len() > remaining {
                        return Err(size_error());
                    }
                } else {
                    // The legacy editor reads the URL from both the shape and its asset definition.
                    let raw_budget = remaining.saturating_sub(64) / 8 * 3;
                    let bytes = self.resources()?.0.read_limited(hash, raw_budget)?;
                    let mime = resources::detect_mime(&bytes)?;
                    if !matches!(mime, "image/png" | "image/jpeg" | "image/webp") {
                        return Err(invalid("Unsupported legacy clipboard raster"));
                    }
                    let src = format!(
                        "data:{mime};base64,{}",
                        base64::engine::general_purpose::STANDARD.encode(bytes)
                    );
                    let asset = json!({"id":hash,"type":"image","src":src,"width":width,"height":height,"mimeType":mime});
                    let bytes = serde_json::to_vec(&asset).map_err(invalid)?.len() + hash.len();
                    remaining = remaining.checked_sub(bytes).ok_or_else(size_error)?;
                    assets.insert(hash.to_owned(), asset);
                }
                shape["image"] = json!({"src":assets[hash]["src"],"width":width,"height":height});
                shape["assetId"] = json!(hash);
            }
            let child_nodes = children(snapshot, raw);
            let children = child_nodes
                .iter()
                .filter(|child| ids.contains(&child.id))
                .collect::<Vec<_>>();
            if matches!(kind, "frame" | "group") {
                shape["childIds"] =
                    json!(children.iter().map(|child| &child.id).collect::<Vec<_>>());
            }
            let frame = if kind == "frame" { raw } else { enclosing };
            pending.extend(
                children
                    .into_iter()
                    .rev()
                    .map(|child| (child.id.as_str(), raw, frame)),
            );
            let bytes = serde_json::to_vec(&shape).map_err(invalid)?.len();
            remaining = remaining.checked_sub(bytes).ok_or_else(size_error)?;
            shapes.push(shape);
        }
        let (mut x, mut y, mut max_x, mut max_y) = (
            f64::INFINITY,
            f64::INFINITY,
            f64::NEG_INFINITY,
            f64::NEG_INFINITY,
        );
        for root in roots {
            let [left, top, width, height] = scene
                .bounds(root)
                .ok_or_else(|| invalid("Legacy clipboard root bounds unavailable"))?;
            x = x.min(left);
            y = y.min(top);
            max_x = max_x.max(left + width);
            max_y = max_y.max(top + height);
        }
        let payload = Map::from_iter([
            ("kind".into(), json!(KIND)),
            ("version".into(), json!(1)),
            ("pageId".into(), json!(page)),
            ("shapes".into(), Value::Array(shapes)),
            ("assetDefinitions".into(), Value::Object(assets)),
            (
                "origin".into(),
                json!({"x":x,"y":y,"width":max_x-x,"height":max_y-y}),
            ),
        ]);
        if serde_json::to_vec(&payload).map_err(invalid)?.len() > max_bytes {
            return Err(size_error());
        }
        Ok(payload)
    }
}

fn export_text(item: &SceneItem) -> Value {
    let mut paragraphs = vec![Vec::new()];
    let plain = item
        .properties
        .get("text")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let fallback = [json!({"text":plain,"attributes":{}})];
    let runs = item
        .properties
        .get("textRuns")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&fallback);
    for run in runs {
        let text = run["text"].as_str().unwrap_or_default();
        for (index, part) in text.split('\n').enumerate() {
            if index > 0 {
                paragraphs.push(Vec::new());
            }
            if part.is_empty() {
                continue;
            }
            let mut legacy = json!({"text":part});
            for key in TEXT_STYLE {
                if let Some(value) = run["attributes"]
                    .get(*key)
                    .or_else(|| item.properties.get(*key))
                {
                    legacy[*key] = value.clone();
                }
            }
            if let Some(color) = run["attributes"]["fill"]
                .as_str()
                .or_else(|| run["attributes"]["color"].as_str())
                .or_else(|| item.properties.get("fill").and_then(Value::as_str))
            {
                legacy["fills"] = json!([{"color":color,"type":"solid","opacity":1}]);
            }
            paragraphs.last_mut().unwrap().push(legacy);
        }
    }
    json!({"type":"richText","verticalAlign":"top","children":paragraphs.into_iter().map(|mut children|{
        if children.is_empty(){children.push(json!({"text":""}));}
        json!({"children":children})
    }).collect::<Vec<_>>()})
}

fn export_path(path: &str, matrix: Affine) -> Result<Vec<Value>> {
    let mut out = Vec::new();
    let mut previous = (0., 0.);
    let mut start = previous;
    for segment in SimplifyingPathParser::from(path) {
        use SimplePathSegment::*;
        let mut emit = |kind, point: (f64, f64)| {
            previous = point;
            let (x, y) = matrix.point(point.0, point.1);
            json!({"command":kind,"x":x,"y":y})
        };
        let value = match segment.map_err(invalid)? {
            MoveTo { x, y } => {
                start = (x, y);
                emit("move", (x, y))
            }
            LineTo { x, y } => emit("line", (x, y)),
            CurveTo {
                x1,
                y1,
                x2,
                y2,
                x,
                y,
            } => {
                let mut record = emit("curve", (x, y));
                let (x1, y1) = matrix.point(x1, y1);
                let (x2, y2) = matrix.point(x2, y2);
                record["x1"] = json!(x1);
                record["y1"] = json!(y1);
                record["x2"] = json!(x2);
                record["y2"] = json!(y2);
                record
            }
            Quadratic { x1, y1, x, y } => {
                let (px, py) = previous;
                let c1 = (px + (x1 - px) * 2. / 3., py + (y1 - py) * 2. / 3.);
                let c2 = (x + (x1 - x) * 2. / 3., y + (y1 - y) * 2. / 3.);
                let (x1, y1) = matrix.point(c1.0, c1.1);
                let (x2, y2) = matrix.point(c2.0, c2.1);
                let (tx, ty) = matrix.point(x, y);
                previous = (x, y);
                json!({"command":"curve","x":tx,"y":ty,"x1":x1,"y1":y1,"x2":x2,"y2":y2})
            }
            ClosePath => {
                previous = start;
                json!({"command":"close"})
            }
        };
        out.push(value);
        if out.len() > 10000 {
            return Err(invalid("Legacy clipboard path exceeds 10000 segments"));
        }
    }
    Ok(out)
}
