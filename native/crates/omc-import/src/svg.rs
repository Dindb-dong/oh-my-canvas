use super::*;
use omc_model::{Node, NodeKind};
use omc_scene::Affine;
use serde_json::json;

pub fn import_svg(source: &str, options: &ImportOptions) -> Result<ImportResult, ImportError> {
    validate_input(source.as_bytes(), options)?;
    let document = roxmltree::Document::parse_with_options(
        source,
        roxmltree::ParsingOptions {
            allow_dtd: false,
            nodes_limit: options.max_nodes.min(u32::MAX as usize) as u32,
            ..Default::default()
        },
    )
    .map_err(|e| ImportError::Invalid(e.to_string()))?;
    let source_root = document.root_element();
    if source_root.tag_name().name() != "svg" {
        return Err(ImportError::Invalid("expected an SVG root".into()));
    }
    let mut result = ImportResult {
        content: DocumentContent::empty("Imported SVG"),
        resources: Vec::new(),
        diagnostics: Vec::new(),
        source_map: BTreeMap::new(),
    };
    let inherited = presentation(source_root, &BTreeMap::new());
    let root = result.content.pages[0].root_node_id.clone();
    let width = number(source_root, "width").unwrap_or(options.width);
    let height = number(source_root, "height").unwrap_or(options.height);
    result
        .content
        .nodes
        .get_mut(&root)
        .ok_or_else(|| ImportError::Invalid("missing root".into()))?
        .properties
        .extend([
            ("width".into(), json!(width)),
            ("height".into(), json!(height)),
            ("clipContent".into(), json!(true)),
            ("tag".into(), json!("svg")),
        ]);
    if let Some(viewbox) = source_root.attribute("viewBox") {
        let parts = parse_numbers(viewbox)?;
        if parts.len() != 4 || parts[2] <= 0. || parts[3] <= 0. {
            return Err(ImportError::Invalid("invalid SVG viewBox".into()));
        }
        let preserve = source_root
            .attribute("preserveAspectRatio")
            .unwrap_or("xMidYMid meet");
        let (sx, sy, dx, dy) = if preserve == "none" {
            (width / parts[2], height / parts[3], 0., 0.)
        } else {
            let scale = (width / parts[2]).min(height / parts[3]);
            (
                scale,
                scale,
                (width - parts[2] * scale) / 2.,
                (height - parts[3] * scale) / 2.,
            )
        };
        // A child content group carries the viewBox transform; root output geometry remains unchanged.
        let mut group = Node::new(NodeKind::Group);
        group.parent_id = Some(root.clone());
        group.properties.extend([
            ("width".into(), json!(parts[2])),
            ("height".into(), json!(parts[3])),
            (
                "transform".into(),
                json!([sx, 0., 0., sy, dx - parts[0] * sx, dy - parts[1] * sy]),
            ),
        ]);
        let group_id = group.id.clone();
        result.content.nodes.insert(group_id.clone(), group);
        let mut count = 1;
        for child in source_root.children().filter(|n| n.is_element()) {
            visit(
                child,
                &group_id,
                &mut result,
                options,
                &mut count,
                0,
                &inherited,
            )?;
        }
    } else {
        let mut count = 0;
        for child in source_root.children().filter(|n| n.is_element()) {
            visit(
                child,
                &root,
                &mut result,
                options,
                &mut count,
                0,
                &inherited,
            )?;
        }
    }
    result
        .content
        .metadata
        .insert("sourceFormat".into(), json!("svg"));
    finish(result, options)
}

#[allow(clippy::too_many_arguments)]
fn visit(
    source: roxmltree::Node<'_, '_>,
    parent: &str,
    result: &mut ImportResult,
    options: &ImportOptions,
    count: &mut usize,
    depth: usize,
    inherited: &BTreeMap<String, String>,
) -> Result<(), ImportError> {
    if depth > 256 {
        return Err(ImportError::ResourceLimit("SVG tree depth".into()));
    }
    let tag = source.tag_name().name();
    if matches!(tag, "title" | "desc" | "metadata") {
        return Ok(());
    }
    if tag == "defs" {
        for child in source.children().filter(|n| n.is_element()) {
            result.diagnostics.push(Diagnostic::unsupported(
                None,
                Some("svg-definition"),
                child.tag_name().name(),
            ));
        }
        return Ok(());
    }
    let kind = match tag {
        "g" | "svg" => NodeKind::Group,
        "rect" => NodeKind::Rect,
        "circle" | "ellipse" => NodeKind::Ellipse,
        "line" => NodeKind::Line,
        "path" | "polygon" | "polyline" => NodeKind::Path,
        "text" => NodeKind::Text,
        "image" => NodeKind::Image,
        _ => {
            result
                .diagnostics
                .push(Diagnostic::unsupported(None, Some("svg-element"), tag));
            return Ok(());
        }
    };
    *count += 1;
    if *count > options.max_nodes {
        return Err(ImportError::ResourceLimit("SVG node limit".into()));
    }
    let mut node = Node::new(kind);
    node.parent_id = Some(parent.into());
    node.rank = rank(*count);
    let attributes = presentation(source, inherited);
    if let Some(id) = source.attribute("id") {
        result
            .source_map
            .insert(format!("svg:#{id}"), node.id.clone());
        node.properties.insert("htmlId".into(), json!(id));
    }
    node.properties.insert(
        "extensions".into(),
        json!({"omc.source":{"tag":tag,"id":source.attribute("id")}}),
    );
    let (mut x, mut y, mut width, mut height) = (
        number(source, "x").unwrap_or(0.),
        number(source, "y").unwrap_or(0.),
        number(source, "width").unwrap_or(0.),
        number(source, "height").unwrap_or(0.),
    );
    match tag {
        "circle" | "ellipse" => {
            let rx = number(source, if tag == "circle" { "r" } else { "rx" }).unwrap_or(0.);
            let ry = number(source, if tag == "circle" { "r" } else { "ry" }).unwrap_or(0.);
            x = number(source, "cx").unwrap_or(0.) - rx;
            y = number(source, "cy").unwrap_or(0.) - ry;
            width = 2. * rx;
            height = 2. * ry;
        }
        "line" => {
            let x1 = number(source, "x1").unwrap_or(0.);
            let y1 = number(source, "y1").unwrap_or(0.);
            let x2 = number(source, "x2").unwrap_or(0.);
            let y2 = number(source, "y2").unwrap_or(0.);
            node.kind = NodeKind::Path;
            node.properties
                .insert("path".into(), json!(format!("M{x1} {y1} L{x2} {y2}")));
            x = 0.;
            y = 0.;
            width = (x2 - x1).abs();
            height = (y2 - y1).abs();
        }
        "path" => {
            node.properties
                .insert("path".into(), json!(source.attribute("d").unwrap_or("")));
        }
        "polygon" | "polyline" => {
            let values = parse_numbers(source.attribute("points").unwrap_or(""))?;
            if values.len() % 2 != 0 {
                return Err(ImportError::Invalid(
                    "SVG points need coordinate pairs".into(),
                ));
            }
            let mut path = String::new();
            for (i, pair) in values.chunks(2).enumerate() {
                path.push_str(&format!(
                    "{}{} {} ",
                    if i == 0 { "M" } else { "L" },
                    pair[0],
                    pair[1]
                ));
            }
            if tag == "polygon" {
                path.push('Z');
            }
            node.properties.insert("path".into(), json!(path));
        }
        "text" => {
            let text: String = source
                .descendants()
                .filter_map(|n| n.is_text().then(|| n.text()).flatten())
                .collect();
            node.properties.insert("text".into(), json!(text));
            let font_size = attributes
                .get("font-size")
                .and_then(|v| v.parse::<f64>().ok())
                .unwrap_or(16.);
            y -= font_size;
            node.properties.insert("fontSize".into(), json!(font_size));
            width = number(source, "textLength").unwrap_or(10000.);
            height = font_size * 1.5;
            result.diagnostics.push(Diagnostic{code:"svg_text_baseline_conversion".into(),severity:"warning".into(),node_id:Some(node.id.clone()),property:Some("y".into()),original:"SVG baseline y".into(),action:"Converted to a native paragraph top; exact source font baseline requires inspection".into(),fidelity_lost:true});
        }
        "image" => {
            if let Some(href) = source
                .attribute("href")
                .or_else(|| source.attribute(("http://www.w3.org/1999/xlink", "href")))
            {
                match resource(href) {
                    Ok(asset) => {
                        node.properties
                            .insert("assetHash".into(), json!(asset.hash));
                        result.resources.push(asset);
                    }
                    Err(error) => result.diagnostics.push(Diagnostic {
                        code: "resource_unavailable".into(),
                        severity: "warning".into(),
                        node_id: Some(node.id.clone()),
                        property: Some("href".into()),
                        original: href.chars().take(256).collect(),
                        action: error.to_string(),
                        fidelity_lost: true,
                    }),
                }
            }
        }
        _ => (),
    }
    if width < 0. || height < 0. {
        return Err(ImportError::Invalid("negative SVG dimensions".into()));
    }
    node.properties.extend([
        ("x".into(), json!(x)),
        ("y".into(), json!(y)),
        ("width".into(), json!(width.max(0.))),
        ("height".into(), json!(height.max(0.))),
    ]);
    if !matches!(tag, "g" | "svg" | "image") {
        let fill = attributes
            .get("fill")
            .map(String::as_str)
            .unwrap_or("black");
        if fill.starts_with("url(") {
            result
                .diagnostics
                .push(Diagnostic::unsupported(Some(&node.id), Some("fill"), fill));
        } else if fill != "none" {
            node.properties.insert(
                if tag == "text" { "color" } else { "fill" }.into(),
                json!(fill),
            );
        }
    }
    for (source_key, target_key) in [
        ("stroke", "stroke"),
        ("stroke-width", "strokeWidth"),
        ("font-family", "fontFamily"),
        ("font-size", "fontSize"),
        ("font-weight", "fontWeight"),
        ("fill-rule", "fillRule"),
        ("font-style", "fontStyle"),
    ] {
        if let Some(value) = attributes.get(source_key) {
            if value != "none" {
                if matches!(target_key, "fontSize" | "strokeWidth") {
                    if let Some(number) =
                        omc_style::resolve_length(value, omc_style::LengthContext::default())
                    {
                        node.properties.insert(target_key.into(), json!(number));
                    } else {
                        result.diagnostics.push(Diagnostic::unsupported(
                            Some(&node.id),
                            Some(source_key),
                            value,
                        ));
                    }
                } else {
                    node.properties.insert(target_key.into(), json!(value));
                }
            }
        }
    }
    if let Some(radius) = number(source, "rx").filter(|_| tag == "rect") {
        node.properties.insert("cornerRadius".into(), json!(radius));
    }
    if let Some(transform) = source.attribute("transform") {
        let matrix = transform_matrix(transform)?.multiply(Affine::translation(x, y));
        node.properties.insert("x".into(), json!(0));
        node.properties.insert("y".into(), json!(0));
        node.properties.insert("transform".into(), json!(matrix.0));
    }
    if let Some(opacity) = source.attribute("opacity") {
        let opacity = opacity
            .parse::<f64>()
            .ok()
            .or_else(|| {
                opacity
                    .strip_suffix('%')
                    .and_then(|v| v.parse::<f64>().ok())
                    .map(|v| v / 100.)
            })
            .ok_or_else(|| ImportError::Invalid("invalid SVG opacity".into()))?;
        node.properties.insert("opacity".into(), json!(opacity));
    }
    if let Some(style) = source.attribute("style") {
        let retained: Vec<_> = omc_style::parse_declarations(style)
            .into_iter()
            .filter(|d| {
                !matches!(
                    d.name.as_str(),
                    "fill"
                        | "stroke"
                        | "stroke-width"
                        | "font-size"
                        | "font-family"
                        | "font-weight"
                        | "font-style"
                        | "fill-rule"
                        | "color"
                )
            })
            .map(|d| format!("{}:{}", d.name, d.value))
            .collect();
        if !retained.is_empty() {
            node.properties
                .insert("style".into(), json!(retained.join(";")));
        }
    }
    if tag == "svg" && source.attribute("viewBox").is_some() {
        result.diagnostics.push(Diagnostic::unsupported(
            Some(&node.id),
            Some("nested-svg-viewBox"),
            source.attribute("viewBox").unwrap_or(""),
        ));
    }
    for key in [
        "mask",
        "clip-path",
        "filter",
        "stroke-dasharray",
        "vector-effect",
    ] {
        if let Some(value) = source.attribute(key) {
            result
                .diagnostics
                .push(Diagnostic::unsupported(Some(&node.id), Some(key), value));
        }
    }
    let id = node.id.clone();
    result.content.nodes.insert(id.clone(), node);
    if matches!(tag, "g" | "svg") {
        for child in source.children().filter(|n| n.is_element()) {
            visit(child, &id, result, options, count, depth + 1, &attributes)?;
        }
    }
    Ok(())
}
fn presentation(
    source: roxmltree::Node<'_, '_>,
    inherited: &BTreeMap<String, String>,
) -> BTreeMap<String, String> {
    let mut attributes = inherited.clone();
    for key in [
        "fill",
        "stroke",
        "stroke-width",
        "font-size",
        "font-family",
        "font-weight",
        "font-style",
        "fill-rule",
        "color",
    ] {
        if let Some(value) = source.attribute(key) {
            attributes.insert(key.into(), value.into());
        }
    }
    if let Some(style) = source.attribute("style") {
        for declaration in omc_style::parse_declarations(style) {
            if matches!(
                declaration.name.as_str(),
                "fill"
                    | "stroke"
                    | "stroke-width"
                    | "font-size"
                    | "font-family"
                    | "font-weight"
                    | "font-style"
                    | "fill-rule"
                    | "color"
            ) {
                attributes.insert(declaration.name, declaration.value);
            }
        }
    }
    attributes
}

fn number(node: roxmltree::Node<'_, '_>, key: &str) -> Option<f64> {
    node.attribute(key)
        .and_then(|v| v.trim_end_matches("px").parse::<f64>().ok())
        .filter(|v| v.is_finite())
}
fn parse_numbers(input: &str) -> Result<Vec<f64>, ImportError> {
    input
        .split([',', ' ', '\t', '\n', '\r'])
        .filter(|v| !v.is_empty())
        .map(|v| {
            v.parse::<f64>()
                .ok()
                .filter(|v| v.is_finite())
                .ok_or_else(|| ImportError::Invalid("nonfinite or invalid SVG number".into()))
        })
        .collect()
}
fn transform_matrix(source: &str) -> Result<Affine, ImportError> {
    let mut matrix = Affine::IDENTITY;
    for token in svgtypes::TransformListParser::from(source) {
        let token = token.map_err(|e| ImportError::Invalid(e.to_string()))?;
        let next = match token {
            svgtypes::TransformListToken::Matrix { a, b, c, d, e, f } => Affine([a, b, c, d, e, f]),
            svgtypes::TransformListToken::Translate { tx, ty } => Affine::translation(tx, ty),
            svgtypes::TransformListToken::Scale { sx, sy } => Affine([sx, 0., 0., sy, 0., 0.]),
            svgtypes::TransformListToken::Rotate { angle } => {
                let a = angle.to_radians();
                Affine([a.cos(), a.sin(), -a.sin(), a.cos(), 0., 0.])
            }
            svgtypes::TransformListToken::SkewX { angle } => {
                Affine([1., 0., angle.to_radians().tan(), 1., 0., 0.])
            }
            svgtypes::TransformListToken::SkewY { angle } => {
                Affine([1., angle.to_radians().tan(), 0., 1., 0., 0.])
            }
        };
        matrix = matrix.multiply(next);
    }
    if matrix.0.iter().any(|v| !v.is_finite()) {
        return Err(ImportError::Invalid("nonfinite SVG transform".into()));
    }
    Ok(matrix)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn vectors_are_editable_and_ids_independent() {
        let source = "<svg width='120' height='80'><g transform='translate(5 10)'><rect id='box' width='40' height='20' fill='#123456'/><path d='M0 0 L10 0 L5 8 Z'/></g></svg>";
        let a = import_svg(source, &ImportOptions::default()).unwrap();
        let b = import_svg(source, &ImportOptions::default()).unwrap();
        assert_eq!(a.content.nodes.len(), 4);
        assert_ne!(a.source_map["svg:#box"], b.source_map["svg:#box"]);
        assert!(a.content.nodes.values().any(|n| n.kind == NodeKind::Path));
    }
    #[test]
    fn external_entities_are_not_resolved() {
        assert!(
            import_svg(
                "<!DOCTYPE svg [<!ENTITY x SYSTEM 'file:///secret'>]><svg>&x;</svg>",
                &ImportOptions::default()
            )
            .is_err()
        );
    }
}
