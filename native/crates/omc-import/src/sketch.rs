use super::*;
use omc_model::{Node, NodeKind, Page};
use serde_json::{Value, json};
use std::collections::BTreeSet;

pub fn import_sketch(bytes: &[u8], options: &ImportOptions) -> Result<ImportResult, ImportError> {
    let files = super::archive::unpack(bytes, options)?;
    let document = parse_json(&files, "document.json")?;
    let refs = document
        .get("pages")
        .and_then(Value::as_array)
        .ok_or_else(|| ImportError::Invalid("Sketch document pages missing".into()))?;
    if refs.is_empty() || refs.len() > 100 {
        return Err(ImportError::ResourceLimit(
            "Sketch page count must be 1..100".into(),
        ));
    }
    let mut pages = Vec::new();
    let mut ids = BTreeMap::new();
    let mut symbols = BTreeMap::new();
    let mut count = 0usize;
    for reference in refs {
        let name = reference
            .get("_ref")
            .and_then(Value::as_str)
            .ok_or_else(|| ImportError::Invalid("Sketch page reference missing".into()))?;
        let page = parse_json(&files, &format!("{name}.json"))?;
        scan(&page, &mut ids, &mut symbols, &mut count, options, 0)?;
        pages.push(page);
    }
    let mut result = ImportResult {
        content: DocumentContent {
            title: document
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("Imported Sketch")
                .into(),
            pages: Vec::new(),
            nodes: BTreeMap::new(),
            metadata: BTreeMap::new(),
        },
        resources: Vec::new(),
        diagnostics: Vec::new(),
        source_map: BTreeMap::new(),
    };
    for (index, page) in pages.iter().enumerate() {
        let mut root = Node::new(NodeKind::Frame);
        root.properties.extend([
            ("width".into(), json!(options.width)),
            ("height".into(), json!(options.height)),
            (
                "name".into(),
                json!(page.get("name").and_then(Value::as_str).unwrap_or("Page")),
            ),
        ]);
        let root_id = root.id.clone();
        result.content.nodes.insert(root_id.clone(), root);
        let mut native_page = Page::new(
            page.get("name").and_then(Value::as_str).unwrap_or("Page"),
            &root_id,
        );
        native_page.rank = rank(index);
        result.content.pages.push(native_page);
        for (order, layer) in page
            .get("layers")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .enumerate()
        {
            visit(
                layer,
                &root_id,
                order,
                &ids,
                &symbols,
                &files,
                &mut result,
                options,
                0,
            )?;
        }
    }
    result
        .content
        .metadata
        .insert("sourceFormat".into(), json!("sketch"));
    result
        .content
        .metadata
        .insert("sourceSha256".into(), json!(digest(bytes)));
    finish(result, options)
}
fn parse_json(files: &BTreeMap<String, Vec<u8>>, name: &str) -> Result<Value, ImportError> {
    serde_json::from_slice(
        files
            .get(name)
            .ok_or_else(|| ImportError::Invalid(format!("missing archive entry {name}")))?,
    )
    .map_err(|e| ImportError::Invalid(e.to_string()))
}
fn scan(
    value: &Value,
    ids: &mut BTreeMap<String, String>,
    symbols: &mut BTreeMap<String, String>,
    count: &mut usize,
    options: &ImportOptions,
    depth: usize,
) -> Result<(), ImportError> {
    if depth > 100 || !value.is_object() {
        return Err(ImportError::Invalid(
            "invalid/deep Sketch layer tree".into(),
        ));
    }
    *count += 1;
    if *count > options.max_nodes {
        return Err(ImportError::ResourceLimit("Sketch layer limit".into()));
    }
    if let Some(id) = value.get("do_objectID").and_then(Value::as_str) {
        if ids.insert(id.into(), omc_model::new_id("node")).is_some() {
            return Err(ImportError::Invalid("duplicate Sketch object ID".into()));
        }
        if value.get("_class").and_then(Value::as_str) == Some("symbolMaster") {
            if let Some(symbol) = value.get("symbolID").and_then(Value::as_str) {
                symbols.insert(symbol.into(), id.into());
            }
        }
    }
    if let Some(children) = value.get("layers") {
        for child in children
            .as_array()
            .ok_or_else(|| ImportError::Invalid("Sketch layers must be an array".into()))?
        {
            scan(child, ids, symbols, count, options, depth + 1)?;
        }
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn visit(
    source: &Value,
    parent: &str,
    order: usize,
    ids: &BTreeMap<String, String>,
    symbols: &BTreeMap<String, String>,
    files: &BTreeMap<String, Vec<u8>>,
    result: &mut ImportResult,
    options: &ImportOptions,
    depth: usize,
) -> Result<(), ImportError> {
    if depth > 100 || result.content.nodes.len() >= options.max_nodes {
        return Err(ImportError::ResourceLimit("Sketch tree limit".into()));
    }
    let class = source
        .get("_class")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    let kind = match class {
        "artboard" => NodeKind::Frame,
        "symbolMaster" => NodeKind::Component,
        "symbolInstance" => NodeKind::Instance,
        "group" | "shapeGroup" => NodeKind::Group,
        "rectangle" | "slice" => NodeKind::Rect,
        "oval" => NodeKind::Ellipse,
        "text" => NodeKind::Text,
        "bitmap" => NodeKind::Image,
        "shapePath" => NodeKind::Path,
        _ => {
            result
                .diagnostics
                .push(Diagnostic::unsupported(None, Some("sketch-layer"), class));
            NodeKind::Group
        }
    };
    let mut node = Node::new(kind);
    if let Some(id) = source.get("do_objectID").and_then(Value::as_str) {
        node.id = ids[id].clone();
        result
            .source_map
            .insert(format!("sketch:{id}"), node.id.clone());
    }
    node.parent_id = Some(parent.into());
    node.rank = rank(order);
    let frame = source.get("frame").unwrap_or(&Value::Null);
    let width = num(frame, "width", 0.)?;
    let height = num(frame, "height", 0.)?;
    if width < 0. || height < 0. {
        return Err(ImportError::Invalid("negative Sketch size".into()));
    }
    let style = source.get("style").unwrap_or(&Value::Null);
    let fills = paints(style.get("fills"), files, result, &node.id)?;
    let mut strokes = paints(style.get("borders"), files, result, &node.id)?;
    let enabled: Vec<_> = style
        .get("borders")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|v| v.get("isEnabled") != Some(&Value::Bool(false)))
        .collect();
    for (stroke, original) in strokes.iter_mut().zip(enabled) {
        stroke["width"] = json!(num(original, "thickness", 1.)?);
        stroke["alignment"] = json!(match original.get("position").and_then(Value::as_u64) {
            Some(1) => "inside",
            Some(2) => "outside",
            _ => "center",
        });
    }
    node.properties.extend([
        ("x".into(), json!(num(frame, "x", 0.)?)),
        ("y".into(), json!(num(frame, "y", 0.)?)),
        ("width".into(), json!(width)),
        ("height".into(), json!(height)),
        ("rotation".into(), json!(-num(source, "rotation", 0.)?)),
        (
            "flipX".into(),
            json!(source.get("isFlippedHorizontal") == Some(&Value::Bool(true))),
        ),
        (
            "flipY".into(),
            json!(source.get("isFlippedVertical") == Some(&Value::Bool(true))),
        ),
        (
            "name".into(),
            json!(source.get("name").and_then(Value::as_str).unwrap_or(class)),
        ),
        (
            "visible".into(),
            json!(source.get("isVisible") != Some(&Value::Bool(false))),
        ),
        (
            "locked".into(),
            json!(source.get("isLocked") == Some(&Value::Bool(true))),
        ),
        (
            "opacity".into(),
            json!(num(
                style.get("contextSettings").unwrap_or(&Value::Null),
                "opacity",
                1.
            )?),
        ),
        ("fills".into(), json!(fills)),
        ("strokes".into(), json!(strokes)),
    ]);
    if class == "artboard" {
        node.properties.insert("clipContent".into(), json!(true));
    }
    if class == "shapePath" {
        node.properties
            .insert("path".into(), json!(path(source, width, height)?));
    }
    if class == "rectangle" {
        if let Some(points) = source.get("points").and_then(Value::as_array) {
            let radii: Vec<_> = points
                .iter()
                .map(|p| num(p, "cornerRadius", 0.))
                .collect::<Result<_, _>>()?;
            if radii.windows(2).all(|p| p[0] == p[1]) {
                if let Some(radius) = radii.first() {
                    node.properties.insert("cornerRadius".into(), json!(radius));
                }
            } else {
                node.properties.insert("cornerRadii".into(), json!(radii));
                result.diagnostics.push(Diagnostic::unsupported(
                    Some(&node.id),
                    Some("cornerRadii"),
                    "Unequal Sketch corner radii",
                ));
            }
        }
    }
    if kind == NodeKind::Text {
        let attributed = source.get("attributedString").unwrap_or(&Value::Null);
        let text = attributed
            .get("string")
            .and_then(Value::as_str)
            .unwrap_or("");
        let defaults = style
            .get("textStyle")
            .and_then(|v| v.get("encodedAttributes"))
            .unwrap_or(&Value::Null);
        node.properties.extend(text_attributes(defaults)?);
        node.properties.insert("text".into(), json!(text));
        node.properties
            .insert("textRuns".into(), json!(text_runs(attributed, defaults)?));
        node.properties.remove("fills");
    }
    if kind == NodeKind::Image {
        let reference = source
            .get("image")
            .and_then(|i| i.get("_ref"))
            .and_then(Value::as_str)
            .ok_or_else(|| ImportError::Invalid("Sketch bitmap reference missing".into()))?;
        let hash = asset(reference, files, result)?;
        node.properties.insert("assetHash".into(), json!(hash));
        node.properties.remove("fills");
    }
    if kind == NodeKind::Instance {
        if let Some(definition) = source
            .get("symbolID")
            .and_then(Value::as_str)
            .and_then(|id| symbols.get(id))
            .and_then(|id| ids.get(id))
        {
            node.properties
                .insert("componentId".into(), json!(definition));
        } else {
            result.diagnostics.push(Diagnostic::unsupported(
                Some(&node.id),
                Some("componentId"),
                "Missing Sketch symbol master",
            ));
        }
        let mut overrides = serde_json::Map::new();
        for entry in source
            .get("overrideValues")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let name = entry
                .get("overrideName")
                .and_then(Value::as_str)
                .unwrap_or("");
            let Some((source_id, field)) = name.rsplit_once('_') else {
                continue;
            };
            let Some(target) = ids.get(source_id) else {
                result.diagnostics.push(Diagnostic::unsupported(
                    Some(&node.id),
                    Some("override"),
                    name,
                ));
                continue;
            };
            if field == "stringValue" {
                overrides.entry(target.clone()).or_insert(json!({}))["text"] =
                    entry.get("value").cloned().unwrap_or(json!(""));
            } else {
                result.diagnostics.push(Diagnostic::unsupported(
                    Some(&node.id),
                    Some("override"),
                    name,
                ));
            }
        }
        node.properties
            .insert("overrides".into(), Value::Object(overrides));
    }
    let mut shadows = Vec::new();
    for (key, kind) in [("shadows", "drop"), ("innerShadows", "inner")] {
        for shadow in style
            .get(key)
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter(|v| v.get("isEnabled") != Some(&Value::Bool(false)))
        {
            shadows.push(json!({"style":kind,"color":rgba(shadow.get("color").unwrap_or(&Value::Null))?,"offsetX":num(shadow,"offsetX",0.)?,"offsetY":num(shadow,"offsetY",0.)?,"blur":num(shadow,"blurRadius",0.)?,"spread":num(shadow,"spread",0.)?}));
        }
    }
    if !shadows.is_empty() {
        node.properties.insert("shadows".into(), json!(shadows));
    }
    if let Some(blur) = style
        .get("blur")
        .filter(|b| b.get("isEnabled") == Some(&Value::Bool(true)))
    {
        if blur.get("type").and_then(Value::as_u64).unwrap_or(0) == 0 {
            node.properties
                .insert("blur".into(), json!(num(blur, "radius", 0.)?));
        } else {
            result.diagnostics.push(Diagnostic::unsupported(
                Some(&node.id),
                Some("sketch-blur"),
                &blur.to_string(),
            ));
        }
    }
    if source.get("hasClippingMask") == Some(&Value::Bool(true)) {
        result.diagnostics.push(Diagnostic::unsupported(
            Some(&node.id),
            Some("sketch-mask"),
            "Sibling clipping mask chain retained in source metadata",
        ));
    }
    node.properties.insert(
        "extensions".into(),
        json!({"omc.source":{"format":"sketch","id":source.get("do_objectID"),"class":class}}),
    );
    let id = node.id.clone();
    result.content.nodes.insert(id.clone(), node);
    for (order, child) in source
        .get("layers")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .enumerate()
    {
        visit(
            child,
            &id,
            order,
            ids,
            symbols,
            files,
            result,
            options,
            depth + 1,
        )?;
    }
    Ok(())
}

fn paints(
    list: Option<&Value>,
    files: &BTreeMap<String, Vec<u8>>,
    result: &mut ImportResult,
    id: &str,
) -> Result<Vec<Value>, ImportError> {
    let mut paints = Vec::new();
    for paint in list
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|p| p.get("isEnabled") != Some(&Value::Bool(false)))
    {
        let opacity = num(
            paint.get("contextSettings").unwrap_or(&Value::Null),
            "opacity",
            1.,
        )?;
        let kind = paint.get("fillType").and_then(Value::as_u64).unwrap_or(0);
        let native = match kind {
            0 => {
                json!({"color":rgba(paint.get("color").unwrap_or(&Value::Null))?,"opacity":opacity})
            }
            1 => {
                let gradient = paint.get("gradient").unwrap_or(&Value::Null);
                let start = point(
                    gradient
                        .get("from")
                        .and_then(Value::as_str)
                        .unwrap_or("{0,0}"),
                    1.,
                    1.,
                )?;
                let end = point(
                    gradient
                        .get("to")
                        .and_then(Value::as_str)
                        .unwrap_or("{1,1}"),
                    1.,
                    1.,
                )?;
                let mut stops = Vec::new();
                for stop in gradient
                    .get("stops")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                {
                    stops.push(json!({"offset":num(stop,"position",0.)?,"color":rgba(stop.get("color").unwrap_or(&Value::Null))?}));
                }
                json!({"type":match gradient.get("gradientType").and_then(Value::as_u64){Some(1)=>"radial",Some(2)=>"conic",_=>"linear"},"gradient":{"start":{"x":start.0,"y":start.1},"end":{"x":end.0,"y":end.1},"stops":stops},"opacity":opacity})
            }
            4 => {
                let reference = paint
                    .get("image")
                    .and_then(|i| i.get("_ref"))
                    .and_then(Value::as_str)
                    .ok_or_else(|| {
                        ImportError::Invalid("Sketch image paint has no resource".into())
                    })?;
                json!({"type":"image","image":{"hash":asset(reference,files,result)?},"opacity":opacity})
            }
            _ => {
                result.diagnostics.push(Diagnostic::unsupported(
                    Some(id),
                    Some("sketch-paint"),
                    &kind.to_string(),
                ));
                json!({"type":"unsupported","sourceFillType":kind})
            }
        };
        paints.push(native);
    }
    Ok(paints)
}
fn asset(
    reference: &str,
    files: &BTreeMap<String, Vec<u8>>,
    result: &mut ImportResult,
) -> Result<String, ImportError> {
    let bytes = files
        .get(reference)
        .ok_or_else(|| ImportError::Invalid(format!("missing Sketch resource {reference}")))?;
    let media = image_media(bytes)
        .ok_or_else(|| ImportError::Unsupported("Sketch image encoding".into()))?;
    let asset = resource(&format!(
        "data:{media};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    ))?;
    let hash = asset.hash.clone();
    if !result.resources.iter().any(|a| a.hash == hash) {
        result.resources.push(asset);
    }
    Ok(hash)
}
fn image_media(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if bytes.starts_with(b"\xff\xd8\xff") {
        Some("image/jpeg")
    } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        Some("image/webp")
    } else {
        None
    }
}
fn num(value: &Value, key: &str, default: f64) -> Result<f64, ImportError> {
    value
        .get(key)
        .map(|v| {
            v.as_f64()
                .filter(|v| v.is_finite())
                .ok_or_else(|| ImportError::Invalid(format!("invalid Sketch {key}")))
        })
        .unwrap_or(Ok(default))
}
fn rgba(value: &Value) -> Result<String, ImportError> {
    Ok(format!(
        "rgba({},{},{},{})",
        num(value, "red", 0.)? * 255.,
        num(value, "green", 0.)? * 255.,
        num(value, "blue", 0.)? * 255.,
        num(value, "alpha", 1.)?
    ))
}
fn point(value: &str, width: f64, height: f64) -> Result<(f64, f64), ImportError> {
    let body = value
        .strip_prefix('{')
        .and_then(|v| v.strip_suffix('}'))
        .ok_or_else(|| ImportError::Invalid("invalid Sketch point".into()))?;
    let (x, y) = body
        .split_once(',')
        .ok_or_else(|| ImportError::Invalid("invalid Sketch point".into()))?;
    let parse = |v: &str| {
        v.trim()
            .parse::<f64>()
            .ok()
            .filter(|v| v.is_finite())
            .ok_or_else(|| ImportError::Invalid("invalid Sketch point".into()))
    };
    Ok((parse(x)? * width, parse(y)? * height))
}
fn path(source: &Value, width: f64, height: f64) -> Result<String, ImportError> {
    let points = source
        .get("points")
        .and_then(Value::as_array)
        .ok_or_else(|| ImportError::Invalid("Sketch path points missing".into()))?;
    if points.len() > 20000 {
        return Err(ImportError::ResourceLimit("Sketch path point limit".into()));
    }
    if points.is_empty() {
        return Ok(String::new());
    }
    let xy = |v: &Value, key: &str| {
        point(
            v.get(key)
                .and_then(Value::as_str)
                .ok_or_else(|| ImportError::Invalid("Sketch point value missing".into()))?,
            width,
            height,
        )
    };
    let start = xy(&points[0], "point")?;
    let mut result = format!("M{} {}", start.0, start.1);
    let closed = source.get("isClosed") == Some(&Value::Bool(true));
    for index in 1..points.len() + usize::from(closed) {
        let previous = &points[(index - 1) % points.len()];
        let next = &points[index % points.len()];
        let target = xy(next, "point")?;
        if previous.get("hasCurveFrom") == Some(&Value::Bool(true))
            || next.get("hasCurveTo") == Some(&Value::Bool(true))
        {
            let a = xy(
                previous,
                if previous.get("hasCurveFrom") == Some(&Value::Bool(true)) {
                    "curveFrom"
                } else {
                    "point"
                },
            )?;
            let b = xy(
                next,
                if next.get("hasCurveTo") == Some(&Value::Bool(true)) {
                    "curveTo"
                } else {
                    "point"
                },
            )?;
            result.push_str(&format!(
                " C{} {} {} {} {} {}",
                a.0, a.1, b.0, b.1, target.0, target.1
            ));
        } else {
            result.push_str(&format!(" L{} {}", target.0, target.1));
        }
    }
    if closed {
        result.push_str(" Z");
    }
    Ok(result)
}
fn text_attributes(value: &Value) -> Result<BTreeMap<String, Value>, ImportError> {
    let mut properties = BTreeMap::new();
    if let Some(font) = value
        .get("MSAttributedStringFontAttribute")
        .and_then(|f| f.get("attributes"))
    {
        let name = font
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("sans-serif");
        properties.insert(
            "fontFamily".into(),
            json!(name.split('-').next().unwrap_or(name)),
        );
        properties.insert("fontSize".into(), json!(num(font, "size", 16.)?));
        properties.insert(
            "fontWeight".into(),
            json!(if name.to_ascii_lowercase().contains("bold") {
                700
            } else {
                400
            }),
        );
        properties.insert(
            "fontStyle".into(),
            json!(if name.to_ascii_lowercase().contains("italic") {
                "italic"
            } else {
                "normal"
            }),
        );
    }
    if let Some(color) = value.get("MSAttributedStringColorAttribute") {
        properties.insert("color".into(), json!(rgba(color)?));
    }
    if let Some(kern) = value.get("kerning") {
        properties.insert("letterSpacing".into(), kern.clone());
    }
    if value
        .get("underlineStyle")
        .and_then(Value::as_u64)
        .is_some_and(|v| v > 0)
    {
        properties.insert("textDecoration".into(), json!("underline"));
    }
    Ok(properties)
}
fn text_runs(attributed: &Value, defaults: &Value) -> Result<Vec<Value>, ImportError> {
    let text = attributed
        .get("string")
        .and_then(Value::as_str)
        .unwrap_or("");
    let mut boundaries = BTreeMap::new();
    let mut units = 0usize;
    for (byte, c) in text.char_indices() {
        boundaries.insert(units, byte);
        units += c.len_utf16();
    }
    boundaries.insert(units, text.len());
    let mut points = BTreeSet::from([0, units]);
    let mut ranges = Vec::new();
    for run in attributed
        .get("attributes")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let start = run.get("location").and_then(Value::as_u64).unwrap_or(0) as usize;
        let end = start
            .checked_add(run.get("length").and_then(Value::as_u64).unwrap_or(0) as usize)
            .ok_or_else(|| ImportError::Invalid("Sketch text range overflow".into()))?;
        if !boundaries.contains_key(&start) || !boundaries.contains_key(&end) {
            return Err(ImportError::Invalid(
                "Sketch text range splits a surrogate pair or exceeds text".into(),
            ));
        }
        points.insert(start);
        points.insert(end);
        ranges.push((
            start,
            end,
            text_attributes(run.get("attributes").unwrap_or(&Value::Null))?,
        ));
    }
    if ranges.len() > 10000 {
        return Err(ImportError::ResourceLimit(
            "Sketch text style range limit".into(),
        ));
    }
    let points: Vec<_> = points.into_iter().collect();
    let base = text_attributes(defaults)?;
    let mut output = Vec::new();
    for pair in points.windows(2) {
        let mut properties = base.clone();
        for (start, end, attrs) in &ranges {
            if *start <= pair[0] && *end >= pair[1] {
                properties.extend(attrs.clone());
            }
        }
        output.push(json!({"text":&text[boundaries[&pair[0]]..boundaries[&pair[1]]],"attributes":properties}));
    }
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Cursor, Write};
    #[test]
    fn zipped_sketch_preserves_curves_and_mixed_text() {
        let document = json!({"pages":[{"_ref":"pages/p"}]});
        let page = json!({"_class":"page","do_objectID":"p","name":"Page","layers":[{"_class":"text","do_objectID":"t","frame":{"x":4,"y":5,"width":100,"height":80},"attributedString":{"string":"A😀B","attributes":[{"location":1,"length":2,"attributes":{"MSAttributedStringColorAttribute":{"red":1,"alpha":1}}}]}}]});
        let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
        for (name, value) in [("document.json", document), ("pages/p.json", page)] {
            zip.start_file(name, zip::write::SimpleFileOptions::default())
                .unwrap();
            zip.write_all(value.to_string().as_bytes()).unwrap();
        }
        let bytes = zip.finish().unwrap().into_inner();
        let result = import_sketch(&bytes, &ImportOptions::default()).unwrap();
        let node = &result.content.nodes[&result.source_map["sketch:t"]];
        assert_eq!(node.properties["text"], json!("A😀B"));
        assert_eq!(node.properties["textRuns"][1]["text"], json!("😀"));
        assert!(
            node.properties["textRuns"][1]["attributes"]["color"]
                .as_str()
                .unwrap()
                .starts_with("rgba(255,")
        );
    }
}
