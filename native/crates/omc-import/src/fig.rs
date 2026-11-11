use super::*;
use omc_model::{Node, NodeKind, Page};
use omc_scene::Affine;
use serde_json::{Value, json};
use std::{collections::BTreeSet, io::Read};

pub fn import_fig(bytes: &[u8], options: &ImportOptions) -> Result<ImportResult, ImportError> {
    validate_input(bytes, options)?;
    let files = if bytes.starts_with(b"PK") {
        super::archive::unpack(bytes, options)?
    } else {
        BTreeMap::new()
    };
    let binary = if files.is_empty() {
        bytes
    } else {
        files
            .get("canvas.fig")
            .ok_or_else(|| invalid("FIG archive has no canvas.fig"))?
            .as_slice()
    };
    if binary.get(..8) != Some(b"fig-kiwi") || binary.len() < 12 {
        return Err(invalid("expected fig-kiwi header"));
    }
    let mut at = 12;
    let mut chunks = Vec::new();
    while at < binary.len() {
        let length = u32::from_le_bytes(
            binary
                .get(at..at + 4)
                .ok_or_else(|| invalid("truncated FIG chunk length"))?
                .try_into()
                .map_err(|_| invalid("FIG chunk length"))?,
        ) as usize;
        at += 4;
        let end = at
            .checked_add(length)
            .ok_or_else(|| invalid("FIG chunk overflow"))?;
        chunks.push(
            binary
                .get(at..end)
                .ok_or_else(|| invalid("truncated FIG chunk"))?,
        );
        at = end;
        if chunks.len() > 32 {
            return Err(ImportError::ResourceLimit("FIG chunk limit".into()));
        }
    }
    if chunks.len() < 2 {
        return Err(invalid("FIG requires a schema and a message chunk"));
    }
    let maximum = options
        .max_input_bytes
        .saturating_mul(4)
        .min(512 * 1024 * 1024);
    let schema = decompress(chunks[0], maximum)?;
    let message = decompress(chunks[1], maximum.saturating_sub(schema.len()))?;
    let decoded = super::kiwi::decode(&schema, &message, maximum)?;
    convert(&decoded, &files, bytes, options)
}
fn decompress(bytes: &[u8], maximum: usize) -> Result<Vec<u8>, ImportError> {
    let mut reader: Box<dyn Read + '_> = if bytes.starts_with(&[0x28, 0xb5, 0x2f, 0xfd]) {
        Box::new(zstd::stream::read::Decoder::new(bytes).map_err(|e| invalid(&e.to_string()))?)
    } else {
        Box::new(flate2::read::DeflateDecoder::new(bytes))
    };
    let mut output = Vec::new();
    reader
        .by_ref()
        .take(maximum as u64 + 1)
        .read_to_end(&mut output)
        .map_err(|e| invalid(&e.to_string()))?;
    if output.len() > maximum {
        return Err(ImportError::ResourceLimit(
            "FIG expanded chunk limit".into(),
        ));
    }
    Ok(output)
}

fn convert(
    decoded: &super::kiwi::Decoded,
    files: &BTreeMap<String, Vec<u8>>,
    source_bytes: &[u8],
    options: &ImportOptions,
) -> Result<ImportResult, ImportError> {
    let sources = decoded
        .root
        .get("nodeChanges")
        .and_then(Value::as_array)
        .ok_or_else(|| invalid("FIG nodeChanges missing"))?;
    if sources.len() > options.max_nodes {
        return Err(ImportError::ResourceLimit("FIG node count limit".into()));
    }
    let mut source_nodes = BTreeMap::new();
    let mut ids = BTreeMap::new();
    let mut children: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for source in sources {
        if source.get("phase").and_then(Value::as_str) == Some("REMOVED") {
            continue;
        }
        let id = guid(source.get("guid").unwrap_or(&Value::Null))
            .ok_or_else(|| invalid("FIG node has no valid guid"))?;
        if source_nodes.insert(id.clone(), source).is_some() {
            return Err(invalid("duplicate FIG node guid"));
        }
        ids.insert(id.clone(), omc_model::new_id("node"));
        if let Some(parent) = source
            .get("parentIndex")
            .and_then(|p| p.get("guid"))
            .and_then(guid)
        {
            children.entry(parent).or_default().push(id);
        }
    }
    let placement = |id: &str| {
        source_nodes
            .get(id)
            .and_then(|s| s.get("parentIndex"))
            .and_then(|p| p.get("position"))
            .and_then(Value::as_str)
            .unwrap_or("")
    };
    for values in children.values_mut() {
        values.sort_by(|a, b| placement(a).cmp(placement(b)).then(a.cmp(b)));
    }
    let mut canvases: Vec<_> = source_nodes
        .iter()
        .filter(|(_, node)| {
            node.get("type").and_then(Value::as_str) == Some("CANVAS")
                && node.get("internalOnly") != Some(&Value::Bool(true))
        })
        .map(|(id, _)| id.clone())
        .collect();
    canvases.sort_by(|a, b| placement(a).cmp(placement(b)).then(a.cmp(b)));
    if canvases.is_empty() || canvases.len() > 100 {
        return Err(invalid("FIG requires 1..100 user pages"));
    }
    let mut result = ImportResult {
        content: DocumentContent {
            title: "Imported FIG".into(),
            pages: Vec::new(),
            nodes: BTreeMap::new(),
            metadata: BTreeMap::new(),
        },
        resources: Vec::new(),
        diagnostics: Vec::new(),
        source_map: BTreeMap::new(),
    };
    for (index, canvas) in canvases.iter().enumerate() {
        let source = source_nodes[canvas];
        let name = source.get("name").and_then(Value::as_str).unwrap_or("Page");
        let mut root = Node::new(NodeKind::Frame);
        root.id = ids[canvas].clone();
        root.properties.extend([
            ("name".into(), json!(name)),
            ("width".into(), json!(options.width)),
            ("height".into(), json!(options.height)),
        ]);
        let root_id = root.id.clone();
        result.content.nodes.insert(root_id.clone(), root);
        let mut page = Page::new(name, &root_id);
        page.rank = rank(index);
        result
            .source_map
            .insert(format!("fig:{canvas}"), root_id.clone());
        result.content.pages.push(page);
        for (order, id) in children.get(canvas).into_iter().flatten().enumerate() {
            visit(
                id,
                &root_id,
                order,
                &source_nodes,
                &ids,
                &children,
                decoded,
                files,
                &mut result,
                options,
                &mut BTreeSet::new(),
                0,
            )?;
        }
    }
    result
        .content
        .metadata
        .insert("sourceFormat".into(), json!("fig"));
    result
        .content
        .metadata
        .insert("sourceSha256".into(), json!(digest(source_bytes)));
    result.content.metadata.insert(
        "figVersion".into(),
        json!(u32::from_le_bytes(
            source_bytes
                .get(8..12)
                .unwrap_or(&[0, 0, 0, 0])
                .try_into()
                .unwrap_or([0, 0, 0, 0])
        )),
    );
    finish(result, options)
}

#[allow(clippy::too_many_arguments)]
fn visit(
    id: &str,
    parent: &str,
    order: usize,
    sources: &BTreeMap<String, &Value>,
    ids: &BTreeMap<String, String>,
    children: &BTreeMap<String, Vec<String>>,
    decoded: &super::kiwi::Decoded,
    files: &BTreeMap<String, Vec<u8>>,
    result: &mut ImportResult,
    options: &ImportOptions,
    active: &mut BTreeSet<String>,
    depth: usize,
) -> Result<(), ImportError> {
    if depth > 100 || !active.insert(id.into()) {
        return Err(invalid("FIG containment cycle/depth limit"));
    }
    if result.content.nodes.len() >= options.max_nodes {
        return Err(ImportError::ResourceLimit("FIG node limit".into()));
    }
    let source = sources[id];
    let class = source
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("UNKNOWN");
    let kind = match class {
        "FRAME" => {
            if source.get("resizeToFit") == Some(&Value::Bool(true)) {
                NodeKind::Group
            } else {
                NodeKind::Frame
            }
        }
        "GROUP" | "BOOLEAN_OPERATION" => NodeKind::Group,
        "SYMBOL" => NodeKind::Component,
        "INSTANCE" => NodeKind::Instance,
        "ROUNDED_RECTANGLE" | "RECTANGLE" => NodeKind::Rect,
        "ELLIPSE" => NodeKind::Ellipse,
        "TEXT" => NodeKind::Text,
        "VECTOR" | "LINE" => NodeKind::Path,
        _ => {
            result.diagnostics.push(Diagnostic::unsupported(
                Some(&ids[id]),
                Some("fig-type"),
                class,
            ));
            NodeKind::Group
        }
    };
    let mut node = Node::new(kind);
    node.id = ids[id].clone();
    node.parent_id = Some(parent.into());
    node.rank = rank(order);
    let size = source.get("size").unwrap_or(&Value::Null);
    let width = number(size, "x", 0.)?;
    let height = number(size, "y", 0.)?;
    if width < 0. || height < 0. {
        return Err(invalid("negative FIG size"));
    }
    let transform = source.get("transform").unwrap_or(&Value::Null);
    let matrix = [
        number(transform, "m00", 1.)?,
        number(transform, "m10", 0.)?,
        number(transform, "m01", 0.)?,
        number(transform, "m11", 1.)?,
        number(transform, "m02", 0.)?,
        number(transform, "m12", 0.)?,
    ];
    node.properties.extend([
        ("x".into(), json!(0)),
        ("y".into(), json!(0)),
        ("width".into(), json!(width)),
        ("height".into(), json!(height)),
        ("transform".into(), json!(matrix)),
        (
            "name".into(),
            source.get("name").cloned().unwrap_or(json!(class)),
        ),
        (
            "visible".into(),
            json!(source.get("visible") != Some(&Value::Bool(false))),
        ),
        (
            "locked".into(),
            json!(source.get("locked") == Some(&Value::Bool(true))),
        ),
        ("opacity".into(), json!(number(source, "opacity", 1.)?)),
        (
            "cornerRadius".into(),
            json!(number(source, "cornerRadius", 0.)?),
        ),
    ]);
    if matches!(
        kind,
        NodeKind::Frame | NodeKind::Component | NodeKind::Instance
    ) {
        node.properties.insert(
            "clipContent".into(),
            json!(source.get("frameMaskDisabled") != Some(&Value::Bool(true))),
        );
    }
    let gradient_size = (kind != NodeKind::Text).then_some((width, height));
    let fills = paints(
        source.get("fillPaints"),
        decoded,
        files,
        result,
        &node.id,
        gradient_size,
    )?;
    let mut strokes = paints(
        source.get("strokePaints"),
        decoded,
        files,
        result,
        &node.id,
        gradient_size,
    )?;
    for stroke in &mut strokes {
        stroke["width"] = json!(number(source, "strokeWeight", 1.)?);
        stroke["alignment"] = json!(
            source
                .get("strokeAlign")
                .and_then(Value::as_str)
                .unwrap_or("CENTER")
                .to_ascii_lowercase()
        );
    }
    node.properties.insert("fills".into(), json!(fills));
    node.properties.insert("strokes".into(), json!(strokes));
    if kind == NodeKind::Text {
        let data = source.get("textData").unwrap_or(&Value::Null);
        let text = data.get("characters").and_then(Value::as_str).unwrap_or("");
        let family = source
            .get("fontName")
            .and_then(|v| v.get("family"))
            .and_then(Value::as_str)
            .unwrap_or("sans-serif");
        let font_style = source
            .get("fontName")
            .and_then(|v| v.get("style"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_ascii_lowercase();
        let color = node
            .properties
            .get("fills")
            .and_then(Value::as_array)
            .and_then(|v| v.first())
            .and_then(|v| v.get("color"))
            .cloned()
            .unwrap_or(json!("black"));
        node.properties.extend([
            ("text".into(), json!(text)),
            ("fontFamily".into(), json!(family)),
            ("fontSize".into(), json!(number(source, "fontSize", 16.)?)),
            (
                "fontWeight".into(),
                json!(if font_style.contains("bold") {
                    700
                } else {
                    400
                }),
            ),
            (
                "fontStyle".into(),
                json!(if font_style.contains("italic") {
                    "italic"
                } else {
                    "normal"
                }),
            ),
            ("color".into(), color),
            (
                "textAlign".into(),
                json!(
                    source
                        .get("textAlignHorizontal")
                        .and_then(Value::as_str)
                        .unwrap_or("LEFT")
                        .to_ascii_lowercase()
                        .replace("justified", "justify")
                ),
            ),
        ]);
        node.properties.remove("fills");
        if data
            .get("characterStyleIDs")
            .is_some_and(|v| !v.as_array().is_some_and(Vec::is_empty))
        {
            result.diagnostics.push(Diagnostic::unsupported(
                Some(&node.id),
                Some("fig-rich-text"),
                "Character style IDs require source style-table conversion",
            ));
            node.properties
                .insert("sourceTextStyles".into(), data.clone());
        }
    }
    if kind == NodeKind::Path {
        let mut paths = Vec::new();
        let geometries = source
            .get("fillGeometry")
            .and_then(Value::as_array)
            .filter(|g| !g.is_empty())
            .or_else(|| source.get("strokeGeometry").and_then(Value::as_array));
        for entry in geometries.into_iter().flatten() {
            let index = entry
                .get("commandsBlob")
                .and_then(Value::as_u64)
                .ok_or_else(|| invalid("FIG geometry blob index missing"))?
                as usize;
            let blob = decoded
                .root
                .get("blobs")
                .and_then(Value::as_array)
                .and_then(|v| v.get(index))
                .ok_or_else(|| invalid("FIG geometry blob unavailable"))?;
            let bytes = decoded
                .bytes(blob)
                .or_else(|| blob.get("bytes").and_then(|v| decoded.bytes(v)))
                .ok_or_else(|| invalid("FIG geometry bytes unavailable"))?;
            paths.push(path_bytes(bytes)?);
            if entry.get("windingRule").and_then(Value::as_str) == Some("ODD") {
                node.properties.insert("fillRule".into(), json!("evenodd"));
            }
            if entry
                .get("styleID")
                .and_then(Value::as_u64)
                .is_some_and(|v| v != 0)
            {
                result.diagnostics.push(Diagnostic::unsupported(
                    Some(&node.id),
                    Some("fig-vector-style"),
                    "Geometry style override requires separate path paint regions",
                ));
            }
        }
        if paths.is_empty() && class == "LINE" {
            paths.push(format!("M0 0 L{width} {height}"));
        }
        if paths.is_empty() {
            result.diagnostics.push(Diagnostic::unsupported(
                Some(&node.id),
                Some("fig-vector"),
                "No supported vector command geometry",
            ));
        }
        node.properties
            .insert("path".into(), json!(paths.join(" ")));
    }
    if kind == NodeKind::Instance {
        let definition = source
            .get("symbolData")
            .and_then(|v| v.get("symbolID"))
            .and_then(guid)
            .and_then(|id| ids.get(&id).cloned());
        if let Some(definition) = definition {
            node.properties
                .insert("componentId".into(), json!(definition));
        } else {
            result.diagnostics.push(Diagnostic::unsupported(
                Some(&node.id),
                Some("componentId"),
                "FIG instance definition unavailable",
            ));
        }
        if let Some(overrides) = source
            .get("symbolData")
            .and_then(|v| v.get("symbolOverrides"))
        {
            node.properties
                .insert("sourceOverrides".into(), overrides.clone());
            result.diagnostics.push(Diagnostic::unsupported(
                Some(&node.id),
                Some("fig-overrides"),
                "Source override mapping retained for native conversion",
            ));
        }
    }
    if let Some(mode) = source
        .get("stackMode")
        .and_then(Value::as_str)
        .filter(|m| *m != "NONE")
    {
        node.properties.insert("layout".into(),json!({"type":"flex","direction":if mode=="VERTICAL"{"column"}else{"row"},"gap":number(source,"stackSpacing",0.)?}));
        result.diagnostics.push(Diagnostic::unsupported(
            Some(&node.id),
            Some("fig-auto-layout"),
            "Flex direction/gap imported; source sizing constraints require additional conversion",
        ));
    }
    if let Some(blend) = source.get("blendMode").and_then(Value::as_str) {
        node.properties.insert(
            "blendMode".into(),
            json!(blend.to_ascii_lowercase().replace('_', "-")),
        );
    }
    for key in [
        "effects",
        "isMask",
        "maskType",
        "boundVariables",
        "variableBindings",
    ] {
        if let Some(value) = source.get(key).filter(|v| {
            !v.is_null() && *v != &json!(false) && !v.as_array().is_some_and(Vec::is_empty)
        }) {
            node.properties.insert(
                format!("source{}{}", key[..1].to_ascii_uppercase(), &key[1..]),
                value.clone(),
            );
            result.diagnostics.push(Diagnostic::unsupported(
                Some(&node.id),
                Some(key),
                &value.to_string().chars().take(512).collect::<String>(),
            ));
        }
    }
    if class == "BOOLEAN_OPERATION" {
        result.diagnostics.push(Diagnostic::unsupported(
            Some(&node.id),
            Some("fig-boolean"),
            "Boolean operands retained as an editable group; result operation is not converted",
        ));
    }
    node.properties.insert(
        "extensions".into(),
        json!({"omc.source":{"format":"fig","id":id,"class":class}}),
    );
    let target = node.id.clone();
    result
        .source_map
        .insert(format!("fig:{id}"), target.clone());
    result.content.nodes.insert(target.clone(), node);
    // Instance definitions remain references. Saved materialized instance children are not duplicated.
    if kind != NodeKind::Instance {
        for (order, child) in children.get(id).into_iter().flatten().enumerate() {
            visit(
                child,
                &target,
                order,
                sources,
                ids,
                children,
                decoded,
                files,
                result,
                options,
                active,
                depth + 1,
            )?;
        }
    }
    active.remove(id);
    Ok(())
}
fn paints(
    values: Option<&Value>,
    decoded: &super::kiwi::Decoded,
    files: &BTreeMap<String, Vec<u8>>,
    result: &mut ImportResult,
    id: &str,
    gradient_size: Option<(f64, f64)>,
) -> Result<Vec<Value>, ImportError> {
    let mut output = Vec::new();
    for paint in values.and_then(Value::as_array).into_iter().flatten() {
        let kind = paint.get("type").and_then(Value::as_str).unwrap_or("SOLID");
        let visible = paint.get("visible").and_then(Value::as_bool);
        let hidden = visible == Some(false);
        if hidden && !matches!(kind, "GRADIENT_LINEAR" | "GRADIENT_RADIAL") {
            continue;
        }
        let opacity = match number(paint, "opacity", 1.) {
            Err(_) if hidden => continue,
            result => result?,
        };
        match kind {
            "SOLID" => output.push(json!({"color":rgba(paint.get("color").unwrap_or(&Value::Null))?,"opacity":opacity})),
            "IMAGE" => {
                let source = paint.get("image").and_then(|image| image.get("hash"))
                    .ok_or_else(|| invalid("FIG image hash missing"))?;
                let key = source.as_str().map(str::to_owned)
                    .or_else(|| decoded.bytes(source).map(|bytes| bytes.iter().map(|byte| format!("{byte:02x}")).collect::<String>()))
                    .ok_or_else(|| invalid("FIG image hash encoding"))?;
                if let Some(bytes) = files.get(&format!("images/{key}")) {
                    let media = if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
                        "image/png"
                    } else if bytes.starts_with(b"\xff\xd8\xff") {
                        "image/jpeg"
                    } else if bytes.starts_with(b"GIF") {
                        "image/gif"
                    } else if bytes.starts_with(b"RIFF") {
                        "image/webp"
                    } else {
                        return Err(ImportError::Unsupported("FIG image encoding".into()));
                    };
                    let resource = resource(&format!(
                        "data:{media};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes)
                    ))?;
                    let hash = resource.hash.clone();
                    if !result.resources.iter().any(|asset| asset.hash == hash) {
                        result.resources.push(resource);
                    }
                    output.push(json!({"type":"image","image":{"hash":hash},"opacity":opacity}));
                } else {
                    result.diagnostics.push(Diagnostic::unsupported(Some(id), Some("fig-image"), &key));
                }
            }
            "GRADIENT_LINEAR" | "GRADIENT_RADIAL" => {
                match gradient(paint, kind, opacity, gradient_size) {
                    Ok(mut converted) => {
                        if let Some(visible) = visible {
                            converted["visible"] = json!(visible);
                        }
                        output.push(converted);
                    }
                    Err(_) if hidden => continue,
                    Err(ImportError::Unsupported(reason)) => {
                        output.push(json!({"type":"unsupported","sourceType":kind}));
                        result.diagnostics.push(Diagnostic::unsupported(Some(id), Some("fig-paint"), &format!("{kind}: {reason}")));
                    }
                    Err(error) => return Err(error),
                }
            }
            other => {
                output.push(json!({"type":"unsupported","sourceType":other}));
                result.diagnostics.push(Diagnostic::unsupported(Some(id), Some("fig-paint"), other));
            }
        }
    }
    Ok(output)
}

fn gradient(
    paint: &Value,
    kind: &str,
    opacity: f64,
    size: Option<(f64, f64)>,
) -> Result<Value, ImportError> {
    let unsupported = |reason: &str| ImportError::Unsupported(reason.into());
    let (width, height) = size.ok_or_else(|| unsupported("text gradient paint"))?;
    if width <= 0. || height <= 0. {
        return Err(unsupported("gradient on an empty layer"));
    }
    if [
        "opacityVar",
        "colorVar",
        "gradientVar",
        "paintVar",
        "stopsVar",
        "authoredStops",
    ]
    .into_iter()
    .any(|key| {
        paint
            .get(key)
            .is_some_and(|value| !value.as_array().is_some_and(Vec::is_empty))
    }) || paint
        .get("interpolationColorSpace")
        .is_some_and(|value| value != "DEFAULT")
        || paint
            .get("blendMode")
            .is_some_and(|value| value != "NORMAL")
    {
        return Err(unsupported(
            "gradient bindings, authored colors, interpolation or blend mode",
        ));
    }
    if !(0. ..=1.).contains(&opacity) {
        return Err(invalid("FIG gradient opacity must be 0..1"));
    }
    let stops = paint
        .get("stops")
        .and_then(Value::as_array)
        .ok_or_else(|| invalid("FIG gradient stops missing"))?;
    if stops.len() < 2 {
        return Err(invalid("FIG gradient requires at least two stops"));
    }
    if stops.len() > 128 {
        return Err(unsupported("more than 128 gradient stops"));
    }
    let mut converted = Vec::with_capacity(stops.len());
    let mut previous = 0.;
    for stop in stops {
        let offset = number(stop, "position", f64::NAN)?;
        if !(previous..=1.).contains(&offset) {
            return Err(invalid("FIG gradient stops must be ordered within 0..1"));
        }
        let color = stop
            .get("color")
            .ok_or_else(|| invalid("FIG gradient color missing"))?;
        for key in ["r", "g", "b", "a"] {
            if !(0. ..=1.).contains(&number(color, key, f64::NAN)?) {
                return Err(invalid("FIG gradient color channels must be 0..1"));
            }
        }
        converted.push(json!({"offset":offset,"color":rgba(color)?}));
        previous = offset;
    }

    let transform = match paint.get("transform") {
        Some(transform) => Affine([
            number(transform, "m00", f64::NAN)?,
            number(transform, "m10", f64::NAN)?,
            number(transform, "m01", f64::NAN)?,
            number(transform, "m11", f64::NAN)?,
            number(transform, "m02", f64::NAN)?,
            number(transform, "m12", f64::NAN)?,
        ]),
        None => Affine::IDENTITY,
    };
    if transform.0.iter().any(|value| !value.is_finite()) {
        return Err(invalid("incomplete FIG gradient transform"));
    }
    let inverse = transform
        .inverse()
        .ok_or_else(|| unsupported("singular gradient transform"))?;
    let shape_space = Affine([width, 0., 0., height, 0., 0.]).multiply(inverse);
    let (kind, start, end, aspect) = if kind == "GRADIENT_LINEAR" {
        // A color stop is a line of constant gradient x, so use its perpendicular in pixels.
        let dx = transform.0[0] / width;
        let dy = transform.0[2] / height;
        let length_squared = dx * dx + dy * dy;
        let start = shape_space.point(0., 0.5);
        let end = (start.0 + dx / length_squared, start.1 + dy / length_squared);
        ("linear", start, end, 1.)
    } else {
        // The transformed circle's ellipse comes from the principal axes of A·Aᵀ.
        let [a, b, c, d, _, _] = shape_space.0;
        let xx = a * a + c * c;
        let xy = a * b + c * d;
        let yy = b * b + d * d;
        let major_squared = (xx + yy + (xx - yy).hypot(2. * xy)) / 2.;
        let radius = major_squared.sqrt() / 2.;
        let aspect = (a * d - b * c).abs() / major_squared;
        let (sin, cos) = (0.5 * (2. * xy).atan2(xx - yy)).sin_cos();
        let start = shape_space.point(0.5, 0.5);
        let end = (start.0 + cos * radius, start.1 + sin * radius);
        ("radial", start, end, aspect)
    };
    let coordinates = [start.0, start.1, end.0, end.1].map(|v| v as f32);
    if coordinates.iter().any(|v| !v.is_finite())
        || coordinates[..2] == coordinates[2..]
        || !(aspect as f32).is_finite()
        || aspect as f32 <= 0.
    {
        return Err(unsupported(
            "gradient geometry is outside native renderer range",
        ));
    }
    Ok(json!({
        "type":kind,
        "opacity":opacity,
        "gradient":{
            "start":{"x":start.0/width,"y":start.1/height},
            "end":{"x":end.0/width,"y":end.1/height},
            "aspect":aspect,
            "stops":converted
        }
    }))
}

fn guid(value: &Value) -> Option<String> {
    Some(format!(
        "{}:{}",
        value.get("sessionID")?.as_u64()?,
        value.get("localID")?.as_u64()?
    ))
}
fn number(value: &Value, key: &str, default: f64) -> Result<f64, ImportError> {
    value
        .get(key)
        .map(|v| {
            v.as_f64()
                .filter(|v| v.is_finite())
                .ok_or_else(|| invalid(&format!("nonfinite/invalid FIG {key}")))
        })
        .unwrap_or(Ok(default))
}
fn rgba(value: &Value) -> Result<String, ImportError> {
    Ok(format!(
        "rgba({},{},{},{})",
        number(value, "r", 0.)? * 255.,
        number(value, "g", 0.)? * 255.,
        number(value, "b", 0.)? * 255.,
        number(value, "a", 1.)?
    ))
}
fn invalid(message: &str) -> ImportError {
    ImportError::Invalid(message.into())
}
fn path_bytes(bytes: &[u8]) -> Result<String, ImportError> {
    let mut at = 0;
    let mut result = String::new();
    let mut count = 0;
    while at < bytes.len() {
        count += 1;
        if count > 100_000 {
            return Err(ImportError::ResourceLimit("FIG path command limit".into()));
        }
        let opcode = bytes[at];
        at += 1;
        let (command, numbers) = match opcode {
            0 => ('Z', 0),
            1 => ('M', 2),
            2 => ('L', 2),
            4 => ('C', 6),
            _ => {
                return Err(ImportError::Unsupported(format!(
                    "FIG path opcode {opcode}"
                )));
            }
        };
        result.push(command);
        for _ in 0..numbers {
            let value = f32::from_le_bytes(
                bytes
                    .get(at..at + 4)
                    .ok_or_else(|| invalid("truncated FIG path"))?
                    .try_into()
                    .map_err(|_| invalid("FIG path float"))?,
            );
            if !value.is_finite() {
                return Err(invalid("nonfinite FIG path"));
            }
            at += 4;
            result.push_str(&format!("{value} "));
        }
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cubic_blob_preserves_control_points_and_rejects_truncation() {
        let mut bytes = vec![1];
        for value in [0f32, 0.] {
            bytes.extend(value.to_le_bytes());
        }
        bytes.push(4);
        for value in [1f32, 2., 3., 4., 5., 6.] {
            bytes.extend(value.to_le_bytes());
        }
        bytes.push(0);
        assert_eq!(path_bytes(&bytes).unwrap(), "M0 0 C1 2 3 4 5 6 Z");
        assert!(path_bytes(&bytes[..bytes.len() - 3]).is_err());
    }
}
