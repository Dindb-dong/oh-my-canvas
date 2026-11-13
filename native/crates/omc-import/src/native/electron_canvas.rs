use super::*;
use serde_json::Map;

pub(super) fn import(value: &Value, options: &ImportOptions) -> Result<ImportResult, ImportError> {
    let pages = value["editorPages"]
        .as_array()
        .filter(|pages| !pages.is_empty())
        .ok_or_else(|| ImportError::Invalid("Electron canvas has no page descriptors".into()))?;
    let boards = value["pages"]
        .as_array()
        .ok_or_else(|| ImportError::Invalid("Electron canvas boards must be an array".into()))?;
    let root_layers = value["editorRootLayers"].as_object();
    let mut import = ImportResult {
        content: DocumentContent {
            title: value["title"]
                .as_str()
                .unwrap_or("Imported Electron canvas")
                .into(),
            pages: Vec::new(),
            nodes: BTreeMap::new(),
            metadata: BTreeMap::from([(
                "migration".into(),
                json!({"source":"electron-canvas-json","independentCopy":true}),
            )]),
        },
        resources: Vec::new(),
        diagnostics: Vec::new(),
        source_map: BTreeMap::new(),
    };
    let mut targets = BTreeMap::new();
    let mut ordered = Vec::new();
    for (index, source) in pages.iter().enumerate() {
        let source_id = source["id"]
            .as_str()
            .filter(|id| !id.is_empty())
            .ok_or_else(|| ImportError::Invalid("Electron page ID is missing".into()))?;
        let mut root = Node::new(NodeKind::Frame);
        root.properties.insert("width".into(), json!(options.width));
        root.properties
            .insert("height".into(), json!(options.height));
        let mut page = omc_model::Page::new(source["name"].as_str().unwrap_or("Page"), &root.id);
        page.rank = rank(index);
        if targets.insert(source_id, root.id.clone()).is_some() {
            return Err(ImportError::Invalid("duplicate Electron page ID".into()));
        }
        import
            .source_map
            .insert(format!("electron:{source_id}"), page.id.clone());
        import.content.nodes.insert(root.id.clone(), root);
        import.content.pages.push(page);
        ordered.push(source_id);
    }
    let mut by_page: BTreeMap<&str, Vec<&Value>> = BTreeMap::new();
    for board in boards {
        let page = board["editorPage"].as_str().unwrap_or(ordered[0]);
        if !targets.contains_key(page) {
            return Err(ImportError::Invalid(
                "Electron board references a missing page".into(),
            ));
        }
        by_page.entry(page).or_default().push(board);
    }
    if let Some(roots) = root_layers {
        for (page, layers) in roots {
            if !targets.contains_key(page.as_str()) {
                return Err(ImportError::Invalid(
                    "Electron root layers reference a missing page".into(),
                ));
            }
            let layers = layers.as_array().ok_or_else(|| {
                ImportError::Invalid("Electron root layers must be an array".into())
            })?;
            let target = by_page.entry(page).or_default();
            if !target.is_empty() && !layers.is_empty() {
                report(
                    &mut import,
                    None,
                    "root-order",
                    "The source stores boards and other top-level layers in separate lists",
                );
            }
            target.extend(layers);
        }
    }
    for page in ordered {
        if let Some(layers) = by_page.remove(page) {
            for (index, source) in layers.into_iter().enumerate() {
                add_layer(source, page, &targets[page], index, 0, &mut import, options)?;
            }
        }
    }
    for (field, message) in [
        (
            "editorComponents",
            "Component definitions and instance connections require migration",
        ),
        ("editorStyles", "Shared style connections require migration"),
        ("editorLibraries", "Library subscriptions require migration"),
    ] {
        if value[field]
            .as_object()
            .is_some_and(|values| !values.is_empty())
        {
            report(&mut import, None, field, message);
        }
    }
    finish(import, options)
}

fn add_layer(
    source: &Value,
    page: &str,
    parent: &str,
    index: usize,
    depth: usize,
    import: &mut ImportResult,
    options: &ImportOptions,
) -> Result<(), ImportError> {
    if depth > 64 || import.content.nodes.len() >= options.max_nodes {
        return Err(ImportError::ResourceLimit(
            "Electron canvas nesting or layer limit".into(),
        ));
    }
    let source = source
        .as_object()
        .ok_or_else(|| ImportError::Invalid("Electron layer must be an object".into()))?;
    let wire_kind = source
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("frame");
    let kind = if wire_kind == "figure" {
        source
            .get("subType")
            .and_then(Value::as_str)
            .unwrap_or("rect")
    } else {
        wire_kind
    };
    let native = match kind {
        "frame" => NodeKind::Frame,
        "group" | "boolean" => NodeKind::Group,
        "rect" => NodeKind::Rect,
        "ellipse" => NodeKind::Ellipse,
        "path" => NodeKind::Path,
        "text" => NodeKind::Text,
        "image" | "svg" => NodeKind::Image,
        _ => NodeKind::Group,
    };
    let mut node = Node::new(native);
    node.parent_id = Some(parent.into());
    node.rank = rank(index);
    if let Some(old) = source.get("id").and_then(Value::as_str) {
        if import
            .source_map
            .insert(format!("electron:{page}:{old}"), node.id.clone())
            .is_some()
        {
            return Err(ImportError::Invalid(
                "duplicate Electron layer ID on a page".into(),
            ));
        }
    }
    for key in [
        "name",
        "x",
        "y",
        "width",
        "height",
        "rotation",
        "visible",
        "locked",
        "opacity",
        "blendMode",
        "fills",
        "strokes",
        "fill",
        "stroke",
        "strokeWidth",
        "strokeCap",
        "strokeJoin",
        "flipX",
        "flipY",
        "radii",
        "cornerSmoothing",
        "clipContent",
        "fontFamily",
        "fontSize",
        "fontWeight",
        "fontStyle",
        "letterSpacing",
        "lineHeight",
        "textAlign",
        "verticalAlign",
    ] {
        if let Some(value) = source.get(key).filter(|value| !value.is_null()) {
            node.properties.insert(key.into(), value.clone());
        }
    }
    if let Some(value) = source.get("strokeDashes").filter(|value| value.is_array()) {
        node.properties
            .insert("strokeDashArray".into(), value.clone());
    }
    for (legacy, native) in [("hidden", "visible"), ("blocked", "locked")] {
        if let Some(value) = source.get(legacy).and_then(Value::as_bool) {
            node.properties
                .entry(native.into())
                .or_insert(json!(if legacy == "hidden" { !value } else { value }));
        }
    }
    if let Some(color) = source.get("background").and_then(Value::as_str) {
        node.properties.entry("fill".into()).or_insert(json!(color));
    }
    match native {
        NodeKind::Path => {
            if let Some(path) = source
                .get("editorPath")
                .and_then(|value| value["content"].as_str())
            {
                node.properties.insert("path".into(), json!(path));
            } else {
                report(
                    import,
                    Some(&node.id),
                    "path",
                    "Electron vector has no SVG path data",
                );
            }
        }
        NodeKind::Image => {
            if let Some(data) = source
                .get("src")
                .and_then(Value::as_str)
                .filter(|value| value.starts_with("data:"))
            {
                let image = resource(data)?;
                node.properties
                    .insert("assetHash".into(), json!(image.hash));
                if !import
                    .resources
                    .iter()
                    .any(|other| other.hash == image.hash)
                {
                    import.resources.push(image);
                }
            } else {
                report(
                    import,
                    Some(&node.id),
                    "image",
                    "Electron image has no supported embedded resource",
                );
            }
        }
        NodeKind::Text => migrate_text(source, &mut node, import),
        _ => {}
    }
    for (field, message) in [
        ("editorLayout", "Electron layout rules require migration"),
        ("editorMask", "Electron masking requires migration"),
        (
            "editorComponent",
            "Component metadata and connections require migration",
        ),
        (
            "editorStyleRef",
            "Shared style references require migration",
        ),
        ("editorGrid", "Layout grids require migration"),
        ("editorExport", "Export presets require migration"),
    ] {
        if source
            .get(field)
            .and_then(Value::as_object)
            .is_some_and(|values| !values.is_empty())
        {
            report(import, Some(&node.id), field, message);
        }
    }
    for field in ["shadows", "effects", "blur", "backgroundBlur"] {
        if source.get(field).is_some_and(|value| match value {
            Value::Array(values) => !values.is_empty(),
            Value::Object(values) => !values.is_empty(),
            Value::Number(number) => number.as_f64().is_some_and(|amount| amount > 0.),
            _ => false,
        }) {
            report(
                import,
                Some(&node.id),
                field,
                "Electron effect requires migration",
            );
        }
    }
    if matches!(kind, "boolean") || native == NodeKind::Group && !matches!(kind, "group") {
        report(import, Some(&node.id), "layer-type", kind);
    }
    let id = node.id.clone();
    import.content.nodes.insert(id.clone(), node);
    if let Some(children) = source.get("children") {
        let children = children.as_array().ok_or_else(|| {
            ImportError::Invalid("Electron layer children must be an array".into())
        })?;
        for (index, child) in children.iter().enumerate() {
            add_layer(child, page, &id, index, depth + 1, import, options)?;
        }
    }
    Ok(())
}

fn migrate_text(source: &Map<String, Value>, node: &mut Node, import: &mut ImportResult) {
    let visible = source.get("text").and_then(Value::as_str).unwrap_or("");
    node.properties.insert("text".into(), json!(visible));
    let Some(paragraphs) = source
        .get("editorText")
        .and_then(|value| value["content"]["children"].as_array())
    else {
        return;
    };
    let mut runs = Vec::new();
    let mut text = String::new();
    for (index, paragraph) in paragraphs.iter().enumerate() {
        if index > 0 {
            runs.push(json!({"text":"\n","attributes":{}}));
            text.push('\n');
        }
        let Some(leaves) = paragraph["children"].as_array() else {
            continue;
        };
        for run in leaves {
            let Some(characters) = run["text"].as_str() else {
                continue;
            };
            let mut attributes = Map::new();
            for key in [
                "fontFamily",
                "fontSize",
                "fontWeight",
                "fontStyle",
                "letterSpacing",
                "lineHeight",
            ] {
                if let Some(value) = run.get(key) {
                    attributes.insert(key.into(), value.clone());
                }
            }
            if let Some(color) = run["fills"][0]["color"].as_str() {
                attributes.insert("color".into(), json!(color));
            }
            runs.push(json!({"text":characters,"attributes":attributes}));
            text.push_str(characters);
        }
    }
    if text == visible {
        node.properties.insert("textRuns".into(), json!(runs));
    } else {
        report(
            import,
            Some(&node.id),
            "rich-text",
            "Electron text runs do not match the exported text",
        );
    }
}

fn report(import: &mut ImportResult, node: Option<&str>, field: &str, message: &str) {
    import
        .diagnostics
        .push(Diagnostic::unsupported(node, Some(field), message));
}
