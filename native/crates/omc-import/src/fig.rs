use super::*;
use omc_model::{Node, NodeKind, Page};
use omc_scene::Affine;
use serde_json::{Value, json};
use std::{
    cell::Cell,
    collections::BTreeSet,
    io::{Read, Seek},
};

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
    let decoded = decode_fig(binary, options, usize::MAX)?;
    let mut images = |key: &str, resources: &mut Vec<ImportedResource>| {
        files
            .get(&format!("images/{key}"))
            .map(|bytes| image_resource(bytes, resources))
            .transpose()
    };
    convert(
        &decoded,
        &mut images,
        &digest(bytes),
        source_version(bytes),
        options,
        None,
    )
}

type ImageLookup<'a> =
    dyn FnMut(&str, &mut Vec<ImportedResource>) -> Result<Option<String>, ImportError> + 'a;

fn source_version(bytes: &[u8]) -> u32 {
    u32::from_le_bytes(
        bytes
            .get(8..12)
            .unwrap_or(&[0, 0, 0, 0])
            .try_into()
            .unwrap_or([0, 0, 0, 0]),
    )
}

/// Import a seekable source without retaining its archive or all image bytes.
/// The sink may stage immutable assets. Publish the document only after this returns successfully.
/// `working_bytes` limits logical importer reservations, not process RSS or allocations inside
/// the sink/ZIP codec. The synchronous sink must finish staging before returning; it must not
/// retain copies of asset bytes in memory. Failed imports may leave unreferenced immutable assets.
pub fn import_fig_reader<R: Read + Seek>(
    mut reader: R,
    options: &ImportOptions,
    working_bytes: usize,
    sink: &mut dyn FnMut(&[u8], &str, &str) -> Result<(), ImportError>,
    check: &mut dyn FnMut() -> Result<(), ImportError>,
) -> Result<ImportResult, ImportError> {
    validate_input(&[], options)?;
    if working_bytes == 0 || working_bytes > 512 * 1024 * 1024 {
        return Err(ImportError::ResourceLimit(
            "FIG working reservation limit".into(),
        ));
    }
    let (source_hash, header, source_bytes) = source_identity(&mut reader, options, check)?;
    let version = source_version(&header);
    if !header.starts_with(b"PK") {
        return import_fig_raw_reader(
            reader,
            options,
            working_bytes,
            source_hash,
            version,
            source_bytes,
            check,
        );
    }
    let mut archive = super::archive::Archive::new(reader, options)?;
    let raw = archive
        .read("canvas.fig", working_bytes)?
        .ok_or_else(|| invalid("FIG archive has no canvas.fig"))?;
    let decoded = decode_fig(&raw, options, working_bytes.saturating_sub(raw.capacity()))?;
    drop(raw);
    let budget = Cell::new(working_bytes.saturating_sub(decoded.allocation));
    let mut cached = BTreeMap::<String, Option<String>>::new();
    let mut images = |key: &str, _resources: &mut Vec<ImportedResource>| {
        check()?;
        if let Some(hash) = cached.get(key) {
            return Ok(hash.clone());
        }
        let hash = if let Some(bytes) = archive.read(&format!("images/{key}"), budget.get())? {
            let (hash, media) = image_identity(&bytes)?;
            if !cached
                .values()
                .any(|stored| stored.as_deref() == Some(hash.as_str()))
            {
                sink(&bytes, media, &hash)?;
            }
            Some(hash)
        } else {
            None
        };
        charge(
            Some(&budget),
            key.len() + hash.as_ref().map_or(0, String::len) + 128,
        )?;
        cached.insert(key.into(), hash.clone());
        Ok(hash)
    };
    let result = convert(
        &decoded,
        &mut images,
        &source_hash,
        version,
        options,
        Some(&budget),
    )?;
    drop(images);
    drop(decoded);
    drop(cached);
    let mut reader = archive.finish(check)?;
    let (after, _, count) = source_identity(&mut reader, options, check)?;
    if after != source_hash || count != source_bytes {
        return Err(invalid("FIG source changed during import"));
    }
    Ok(result)
}

fn source_identity<R: Read + Seek>(
    reader: &mut R,
    options: &ImportOptions,
    check: &mut dyn FnMut() -> Result<(), ImportError>,
) -> Result<(String, Vec<u8>, usize), ImportError> {
    reader
        .rewind()
        .map_err(|error| invalid(&error.to_string()))?;
    let mut hash = Sha256::new();
    let mut header = Vec::new();
    let mut buffer = [0_u8; 64 * 1024];
    let mut count = 0usize;
    loop {
        check()?;
        let size = reader
            .read(&mut buffer)
            .map_err(|error| invalid(&error.to_string()))?;
        if size == 0 {
            break;
        }
        count = count
            .checked_add(size)
            .ok_or_else(|| ImportError::ResourceLimit("input byte limit".into()))?;
        if count > options.max_input_bytes {
            return Err(ImportError::ResourceLimit("input byte limit".into()));
        }
        if header.len() < 12 {
            header.extend_from_slice(&buffer[..size.min(12 - header.len())]);
        }
        hash.update(&buffer[..size]);
    }
    reader
        .rewind()
        .map_err(|error| invalid(&error.to_string()))?;
    Ok((
        hash.finalize()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect(),
        header,
        count,
    ))
}

fn import_fig_raw_reader<R: Read + Seek>(
    mut reader: R,
    options: &ImportOptions,
    working: usize,
    source_hash: String,
    version: u32,
    source_bytes: usize,
    check: &mut dyn FnMut() -> Result<(), ImportError>,
) -> Result<ImportResult, ImportError> {
    if source_bytes > working {
        return Err(ImportError::ResourceLimit(
            "FIG working reservation limit".into(),
        ));
    }
    let mut bytes = vec![0_u8; source_bytes];
    reader
        .read_exact(&mut bytes)
        .map_err(|error| invalid(&error.to_string()))?;
    let decoded = decode_fig(&bytes, options, working.saturating_sub(bytes.capacity()))?;
    drop(bytes);
    let mut missing = |_key: &str, _resources: &mut Vec<ImportedResource>| Ok(None);
    let budget = Cell::new(working.saturating_sub(decoded.allocation));
    let result = convert(
        &decoded,
        &mut missing,
        &source_hash,
        version,
        options,
        Some(&budget),
    )?;
    drop(decoded);
    let (after, _, count) = source_identity(&mut reader, options, check)?;
    if after != source_hash || count != source_bytes {
        return Err(invalid("FIG source changed during import"));
    }
    Ok(result)
}

fn decode_fig(
    binary: &[u8],
    options: &ImportOptions,
    working_bytes: usize,
) -> Result<super::kiwi::Decoded, ImportError> {
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
        .min(512 * 1024 * 1024)
        .min(working_bytes);
    let decoded = {
        let schema = decompress(chunks[0], maximum)?;
        let message = decompress(chunks[1], maximum.saturating_sub(schema.len()))?;
        if working_bytes == usize::MAX {
            // Preserve the existing byte API's independent decoded-allocation ceiling.
            super::kiwi::decode(&schema, &message, maximum)?
        } else {
            let scratch = schema.capacity().saturating_add(message.capacity());
            super::kiwi::decode_reserved(
                &schema,
                &message,
                working_bytes.checked_sub(scratch).ok_or_else(|| {
                    ImportError::ResourceLimit("FIG chunk reservation exceeded".into())
                })?,
            )?
        }
    };
    Ok(decoded)
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
    images: &mut ImageLookup<'_>,
    source_hash: &str,
    source_version: u32,
    options: &ImportOptions,
    budget: Option<&Cell<usize>>,
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
        // Account for the retained conversion indices as they are populated.
        charge(budget, id.len() * 3 + 256)?;
        if source_nodes.insert(id.clone(), source).is_some() {
            return Err(invalid("duplicate FIG node guid"));
        }
        ids.insert(id.clone(), omc_model::new_id("node"));
        if let Some(parent) = source
            .get("parentIndex")
            .and_then(|p| p.get("guid"))
            .and_then(guid)
        {
            charge(budget, parent.len() + id.len() + 128)?;
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
        charge(budget, node_bytes(&root) + root_id.len() + 64)?;
        result.content.nodes.insert(root_id.clone(), root);
        let mut page = Page::new(name, &root_id);
        page.rank = rank(index);
        result
            .source_map
            .insert(format!("fig:{canvas}"), root_id.clone());
        charge(
            budget,
            std::mem::size_of::<Page>()
                + page.id.len()
                + page.title.len()
                + page.root_node_id.len()
                + page.rank.len()
                + canvas.len()
                + root_id.len()
                + 68,
        )?;
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
                images,
                &mut result,
                options,
                budget,
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
        .insert("sourceSha256".into(), json!(source_hash));
    result
        .content
        .metadata
        .insert("figVersion".into(), json!(source_version));
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
    images: &mut ImageLookup<'_>,
    result: &mut ImportResult,
    options: &ImportOptions,
    budget: Option<&Cell<usize>>,
    active: &mut BTreeSet<String>,
    depth: usize,
) -> Result<(), ImportError> {
    if depth > 100 || !active.insert(id.into()) {
        return Err(invalid("FIG containment cycle/depth limit"));
    }
    if result.content.nodes.len() >= options.max_nodes {
        return Err(ImportError::ResourceLimit("FIG node limit".into()));
    }
    let diagnostic_start = result.diagnostics.len();
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
        images,
        result,
        &node.id,
        gradient_size,
    )?;
    let mut strokes = paints(
        source.get("strokePaints"),
        decoded,
        images,
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
    let mut path_reservation = 0usize;
    if kind == NodeKind::Path {
        let mut path = String::new();
        let mut geometries_seen = 0usize;
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
            if geometries_seen > 0 {
                append_path_text(&mut path, " ", budget)?;
            }
            append_path_bytes(bytes, &mut path, budget)?;
            geometries_seen += 1;
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
        if geometries_seen == 0 && class == "LINE" {
            append_path_text(&mut path, &format!("M0 0 L{width} {height}"), budget)?;
            geometries_seen += 1;
        }
        if geometries_seen == 0 {
            result.diagnostics.push(Diagnostic::unsupported(
                Some(&node.id),
                Some("fig-vector"),
                "No supported vector command geometry",
            ));
        }
        if budget.is_some() {
            path_reservation = path.capacity();
        }
        node.properties.insert("path".into(), Value::String(path));
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
    charge(
        budget,
        node_bytes(&node).saturating_sub(path_reservation) + id.len() + node.id.len() * 2 + 132,
    )?;
    for diagnostic in &result.diagnostics[diagnostic_start..] {
        charge(
            budget,
            std::mem::size_of::<Diagnostic>()
                + diagnostic.code.len()
                + diagnostic.severity.len()
                + diagnostic.node_id.as_ref().map_or(0, String::len)
                + diagnostic.property.as_ref().map_or(0, String::len)
                + diagnostic.original.len()
                + diagnostic.action.len(),
        )?;
    }
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
                images,
                result,
                options,
                budget,
                active,
                depth + 1,
            )?;
        }
    }
    active.remove(id);
    Ok(())
}
// Logical retained-allocation accounting, matching the decoder reservation model.
// This guards materialized output as well as decoded input; it is not a process RSS cap.
fn charge(budget: Option<&Cell<usize>>, bytes: usize) -> Result<(), ImportError> {
    if let Some(budget) = budget {
        budget.set(budget.get().checked_sub(bytes).ok_or_else(|| {
            ImportError::ResourceLimit("FIG conversion reservation exceeded".into())
        })?);
    }
    Ok(())
}
fn value_bytes(value: &Value) -> usize {
    match value {
        Value::String(text) => text.capacity(),
        Value::Array(values) => {
            values.capacity() * std::mem::size_of::<Value>()
                + values.iter().map(value_bytes).sum::<usize>()
        }
        Value::Object(values) => values
            .iter()
            .map(|(key, value)| key.capacity() + 64 + value_bytes(value))
            .sum(),
        _ => 0,
    }
}
fn node_bytes(node: &Node) -> usize {
    std::mem::size_of::<Node>()
        + node.id.capacity()
        + node.parent_id.as_ref().map_or(0, String::capacity)
        + node.rank.capacity()
        + node.home_shard.capacity()
        + node
            .properties
            .iter()
            .map(|(key, value)| key.capacity() + 64 + value_bytes(value))
            .sum::<usize>()
}

fn paints(
    values: Option<&Value>,
    decoded: &super::kiwi::Decoded,
    images: &mut ImageLookup<'_>,
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
                if let Some(hash) = images(&key, &mut result.resources)? {
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

fn image_identity(bytes: &[u8]) -> Result<(String, &'static str), ImportError> {
    let media_type = if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
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
    // Preserve the existing data-URI byte ceiling without allocating encoded intermediates.
    if bytes.len().div_ceil(3).saturating_mul(4) > 64 * 1024 * 1024 {
        return Err(ImportError::ResourceLimit("inline resource limit".into()));
    }
    let valid = match media_type {
        "image/gif" => bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a"),
        "image/webp" => bytes.get(8..12) == Some(b"WEBP"),
        _ => true,
    };
    if !valid {
        return Err(invalid("declared image type does not match its signature"));
    }
    Ok((digest(bytes), media_type))
}

fn image_resource(
    bytes: &[u8],
    resources: &mut Vec<ImportedResource>,
) -> Result<String, ImportError> {
    let (hash, media_type) = image_identity(bytes)?;
    if !resources.iter().any(|resource| resource.hash == hash) {
        resources.push(ImportedResource {
            hash: hash.clone(),
            media_type: media_type.into(),
            bytes: bytes.to_vec(),
        });
    }
    Ok(hash)
}

#[cfg(test)]
mod image_resource_tests {
    use super::*;

    #[test]
    fn image_resource_matches_inline_import_and_keeps_one_copy() {
        for (bytes, media) in [
            (b"\x89PNG\r\n\x1a\n".as_slice(), "image/png"),
            (b"\xff\xd8\xff".as_slice(), "image/jpeg"),
            (b"GIF89a".as_slice(), "image/gif"),
            (b"RIFF\x04\x00\x00\x00WEBP".as_slice(), "image/webp"),
        ] {
            let inline = resource(&format!(
                "data:{media};base64,{}",
                base64::engine::general_purpose::STANDARD.encode(bytes)
            ))
            .unwrap();
            let mut resources = Vec::new();
            assert_eq!(image_resource(bytes, &mut resources).unwrap(), inline.hash);
            let allocation = resources[0].bytes.as_ptr();
            assert_eq!(image_resource(bytes, &mut resources).unwrap(), inline.hash);
            assert_eq!(resources.len(), 1);
            assert_eq!(resources[0].bytes.as_ptr(), allocation);
            assert_eq!(resources[0].bytes, inline.bytes);
            assert_eq!(resources[0].media_type, inline.media_type);
        }
    }

    #[test]
    fn image_resource_rejects_invalid_signatures_before_retaining_bytes() {
        let mut resources = Vec::new();
        for bytes in [b"GIFxxx".as_slice(), b"RIFF\0\0\0\0JPEG".as_slice()] {
            assert!(matches!(
                image_resource(bytes, &mut resources),
                Err(ImportError::Invalid(_))
            ));
            assert!(resources.is_empty());
        }
    }
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
#[cfg(test)]
fn path_bytes(bytes: &[u8]) -> Result<String, ImportError> {
    let mut result = String::new();
    append_path_bytes(bytes, &mut result, None)?;
    Ok(result)
}

fn append_path_text(
    result: &mut String,
    text: &str,
    budget: Option<&Cell<usize>>,
) -> Result<(), ImportError> {
    let length = result
        .len()
        .checked_add(text.len())
        .ok_or_else(|| ImportError::ResourceLimit("FIG path allocation overflow".into()))?;
    if length > result.capacity() {
        let available = budget.map_or(usize::MAX, Cell::get);
        let maximum = result.capacity().saturating_add(available);
        let capacity = result.capacity().saturating_mul(2).max(length).min(maximum);
        if capacity < length {
            return Err(ImportError::ResourceLimit(
                "FIG path reservation exceeded".into(),
            ));
        }
        charge(budget, capacity - result.capacity())?;
        result
            .try_reserve_exact(capacity - result.len())
            .map_err(|_| ImportError::ResourceLimit("FIG path allocation failed".into()))?;
        // Allocators may round a requested allocation upward.
        charge(budget, result.capacity().saturating_sub(capacity))?;
    }
    result.push_str(text);
    Ok(())
}

fn append_path_bytes(
    bytes: &[u8],
    result: &mut String,
    budget: Option<&Cell<usize>>,
) -> Result<(), ImportError> {
    let mut at = 0;
    let mut count = 0;
    while at < bytes.len() {
        count += 1;
        if count > 100_000 {
            return Err(ImportError::ResourceLimit("FIG path command limit".into()));
        }
        let opcode = bytes[at];
        at += 1;
        let (command, numbers) = match opcode {
            0 => ("Z", 0),
            1 => ("M", 2),
            2 => ("L", 2),
            4 => ("C", 6),
            _ => {
                return Err(ImportError::Unsupported(format!(
                    "FIG path opcode {opcode}"
                )));
            }
        };
        append_path_text(result, command, budget)?;
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
            append_path_text(result, &format!("{value} "), budget)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn repeated_geometry_stops_at_the_shared_output_reservation() {
        let mut bytes = vec![4];
        for _ in 0..6 {
            bytes.extend(f32::MAX.to_le_bytes());
        }
        let budget = Cell::new(1024);
        let mut path = String::new();
        let error = (0..1000)
            .try_for_each(|_| append_path_bytes(&bytes, &mut path, Some(&budget)))
            .unwrap_err();
        assert!(matches!(error, ImportError::ResourceLimit(_)));
        assert!(path.capacity() <= 1024);
        assert_eq!(path.capacity() + budget.get(), 1024);
    }
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
