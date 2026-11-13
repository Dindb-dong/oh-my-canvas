use super::*;
use html5ever::{parse_document, tendril::TendrilSink};
use markup5ever_rcdom::{Handle, NodeData, RcDom};
use omc_model::{Node, NodeKind};
use serde_json::{Value, json};

const MAX_HTML_DEPTH: usize = 256;

pub fn import_html(source: &str, options: &ImportOptions) -> Result<ImportResult, ImportError> {
    validate_input(source.as_bytes(), options)?;
    let dom = parse_document(RcDom::default(), Default::default()).one(source);
    let mut result = ImportResult {
        content: DocumentContent::empty("Imported HTML"),
        resources: Vec::new(),
        diagnostics: Vec::new(),
        source_map: BTreeMap::new(),
    };
    let root = result.content.pages[0].root_node_id.clone();
    result
        .content
        .nodes
        .get_mut(&root)
        .ok_or_else(|| ImportError::Invalid("missing root".into()))?
        .properties
        .extend([
            ("width".into(), json!(options.width)),
            ("height".into(), json!(options.height)),
            ("tag".into(), json!("html")),
            ("style".into(), json!("display:block")),
        ]);
    let mut css = String::new();
    let mut counter = 0;
    let mut pending = vec![(dom.document.clone(), root, 0)];
    while let Some((node, parent, depth)) = pending.pop() {
        if let Some(parent) = visit(
            &node,
            &parent,
            &mut result,
            &mut css,
            options,
            &mut counter,
            depth,
        )? {
            pending.extend(
                node.children
                    .borrow()
                    .iter()
                    .rev()
                    .map(|child| (child.clone(), parent.clone(), depth + 1)),
            );
        }
    }
    result.content.metadata.insert("css".into(), json!(css));
    result
        .content
        .metadata
        .insert("cssProfile".into(), json!(omc_style::PROFILE));
    for unsupported in
        omc_style::parse_stylesheet(result.content.metadata["css"].as_str().unwrap_or(""))
            .unsupported
    {
        result.diagnostics.push(Diagnostic::unsupported(
            None,
            Some("css-rule"),
            &unsupported,
        ));
    }
    finish(result, options)
}

#[allow(clippy::too_many_arguments)]
fn visit(
    handle: &Handle,
    parent: &str,
    result: &mut ImportResult,
    css: &mut String,
    options: &ImportOptions,
    counter: &mut usize,
    depth: usize,
) -> Result<Option<String>, ImportError> {
    if depth > MAX_HTML_DEPTH {
        return Err(ImportError::ResourceLimit("HTML tree depth".into()));
    }
    match &handle.data {
        NodeData::Document => return Ok(Some(parent.into())),
        NodeData::Element { name, attrs, .. } => {
            let tag = name.local.as_ref();
            let attrs: BTreeMap<String, String> = attrs
                .borrow()
                .iter()
                .map(|a| (a.name.local.to_string(), a.value.to_string()))
                .collect();
            if matches!(tag, "style") {
                css.push_str(&text_content(handle));
                css.push('\n');
                return Ok(None);
            }
            if matches!(tag, "script" | "iframe" | "object" | "embed") {
                result.diagnostics.push(Diagnostic {
                    code: "active_content_removed".into(),
                    severity: "warning".into(),
                    node_id: None,
                    property: Some(tag.into()),
                    original: format!("<{tag}>"),
                    action:
                        "Active content was retained only as a diagnostic and was never executed"
                            .into(),
                    fidelity_lost: true,
                });
                return Ok(None);
            }
            if tag == "link" && attrs.get("rel").is_some_and(|v| v == "stylesheet") {
                result.diagnostics.push(Diagnostic::unsupported(
                    None,
                    Some("stylesheet"),
                    attrs
                        .get("href")
                        .map(String::as_str)
                        .unwrap_or("external stylesheet"),
                ));
                return Ok(None);
            }
            if matches!(tag, "head" | "html") {
                if tag == "html" {
                    if let Some(node) = result.content.nodes.get_mut(parent) {
                        for (source, target) in
                            [("style", "style"), ("id", "htmlId"), ("class", "class")]
                        {
                            if let Some(value) = attrs.get(source) {
                                node.properties.insert(target.into(), json!(value));
                            }
                        }
                    }
                }
                return Ok(Some(parent.into()));
            }
            if matches!(tag, "meta" | "title" | "base") {
                return Ok(None);
            }
            if tag == "svg" {
                result.diagnostics.push(Diagnostic::unsupported(
                    None,
                    Some("inline-svg"),
                    "Inline SVG in HTML must be imported through the SVG converter",
                ));
                return Ok(None);
            }
            *counter += 1;
            if *counter > options.max_nodes {
                return Err(ImportError::ResourceLimit("HTML node limit".into()));
            }
            let text_only = is_text_element(tag)
                && handle
                    .children
                    .borrow()
                    .iter()
                    .all(|child| is_inline(child, depth + 1));
            let kind = if tag == "img" {
                NodeKind::Image
            } else if text_only {
                NodeKind::Text
            } else {
                NodeKind::Frame
            };
            let mut node = Node::new(kind);
            node.parent_id = Some(parent.into());
            node.rank = rank(*counter);
            node.properties.insert("tag".into(), json!(tag));
            if let Some(name) = attrs.get("data-name").or_else(|| attrs.get("id")) {
                node.properties.insert("name".into(), json!(name));
            }
            if let Some(id) = attrs.get("id") {
                node.properties.insert("htmlId".into(), json!(id));
                result
                    .source_map
                    .insert(format!("html:#{id}"), node.id.clone());
            }
            if let Some(class) = attrs.get("class") {
                node.properties.insert("class".into(), json!(class));
            }
            if let Some(authored) = attrs.get("style") {
                for declaration in omc_style::parse_declarations(authored) {
                    if declaration.name == "position"
                        && matches!(declaration.value.as_str(), "fixed" | "sticky")
                    {
                        result.diagnostics.push(Diagnostic::unsupported(
                            Some(&node.id),
                            Some("position"),
                            &declaration.value,
                        ));
                    }
                }
                node.properties.insert("style".into(), json!(authored));
            }
            for key in ["width", "height"] {
                if let Some(value) = attrs.get(key) {
                    if let Ok(value) = value.parse::<f64>() {
                        if value.is_finite() {
                            node.properties.insert(key.into(), json!(value));
                        }
                    }
                }
            }
            let inert: BTreeMap<_, _> = attrs
                .iter()
                .filter(|(key, _)| {
                    !key.starts_with("on")
                        && !matches!(key.as_str(), "style" | "class" | "id" | "src")
                })
                .map(|(k, v)| (k.clone(), Value::String(v.clone())))
                .collect();
            node.properties.insert("attributes".into(), json!(inert));
            for key in attrs.keys().filter(|key| key.starts_with("on")) {
                result.diagnostics.push(Diagnostic {
                    code: "event_handler_removed".into(),
                    severity: "warning".into(),
                    node_id: Some(node.id.clone()),
                    property: Some(key.clone()),
                    original: key.clone(),
                    action: "Event handler was not executed or retained as executable content"
                        .into(),
                    fidelity_lost: true,
                });
            }
            if text_only {
                node.properties.insert(
                    "text".into(),
                    json!(collapse_whitespace(&text_content(handle), tag == "pre")),
                );
                if handle
                    .children
                    .borrow()
                    .iter()
                    .any(|child| matches!(child.data, NodeData::Element { .. }))
                {
                    result.diagnostics.push(Diagnostic::unsupported(
                        Some(&node.id),
                        Some("rich-text"),
                        "Inline markup retained as source; mixed formatting conversion is pending",
                    ));
                    node.properties.insert(
                        "extensions".into(),
                        json!({"omc.source":{"inlineText":text_content(handle)}}),
                    );
                }
            }
            if tag == "img" {
                if let Some(source) = attrs.get("src") {
                    match resource(source) {
                        Ok(asset) => {
                            node.properties
                                .insert("assetHash".into(), json!(asset.hash));
                            result.resources.push(asset);
                        }
                        Err(error) => {
                            result.diagnostics.push(Diagnostic {
                                code: "resource_unavailable".into(),
                                severity: "warning".into(),
                                node_id: Some(node.id.clone()),
                                property: Some("src".into()),
                                original: source.chars().take(256).collect(),
                                action: error.to_string(),
                                fidelity_lost: true,
                            });
                        }
                    }
                }
            }
            if matches!(
                tag,
                "table" | "tr" | "td" | "th" | "input" | "select" | "textarea"
            ) {
                result.diagnostics.push(Diagnostic::unsupported(
                    Some(&node.id),
                    Some("html-element"),
                    tag,
                ));
            }
            let id = node.id.clone();
            result.content.nodes.insert(id.clone(), node);
            return Ok((!text_only).then_some(id));
        }
        NodeData::Text { contents } => {
            let text = collapse_whitespace(contents.borrow().as_ref(), false);
            if text.trim().is_empty() {
                return Ok(None);
            }
            *counter += 1;
            if *counter > options.max_nodes {
                return Err(ImportError::ResourceLimit("HTML node limit".into()));
            }
            let mut node = Node::new(NodeKind::Text);
            node.parent_id = Some(parent.into());
            node.rank = rank(*counter);
            node.properties.insert("text".into(), json!(text));
            node.properties.insert("tag".into(), json!("span"));
            result.content.nodes.insert(node.id.clone(), node);
        }
        _ => (),
    }
    Ok(None)
}
fn text_content(handle: &Handle) -> String {
    match &handle.data {
        NodeData::Text { contents } => contents.borrow().to_string(),
        NodeData::Element { name, .. } if name.local.as_ref() == "br" => "\n".into(),
        _ => handle.children.borrow().iter().map(text_content).collect(),
    }
}
fn is_inline(handle: &Handle, depth: usize) -> bool {
    if depth > MAX_HTML_DEPTH {
        return false;
    }
    match &handle.data {
        NodeData::Text { .. } => true,
        NodeData::Element { name, .. } => {
            matches!(
                name.local.as_ref(),
                "span" | "strong" | "b" | "em" | "i" | "u" | "s" | "a" | "br" | "code"
            ) && handle
                .children
                .borrow()
                .iter()
                .all(|child| is_inline(child, depth + 1))
        }
        NodeData::Comment { .. } => true,
        _ => false,
    }
}
fn is_text_element(tag: &str) -> bool {
    matches!(
        tag,
        "p" | "h1"
            | "h2"
            | "h3"
            | "h4"
            | "h5"
            | "h6"
            | "span"
            | "a"
            | "label"
            | "li"
            | "pre"
            | "blockquote"
            | "strong"
            | "em"
    )
}
fn collapse_whitespace(text: &str, pre: bool) -> String {
    if pre {
        text.into()
    } else {
        text.split_whitespace().collect::<Vec<_>>().join(" ")
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn imports_semantic_constraints_without_network() {
        let source = "<style>.grid{display:grid;grid-template-columns:1fr 2fr;gap:12px}</style><section id='cards' class='grid'><p>Hello</p><p style='color:red'>World</p></section>";
        let r = import_html(source, &ImportOptions::default()).unwrap();
        assert!(
            r.content.metadata["css"]
                .as_str()
                .unwrap()
                .contains("grid-template-columns")
        );
        assert!(
            r.content
                .nodes
                .values()
                .any(|n| n.properties.get("text") == Some(&json!("World")))
        );
        assert!(r.source_map.contains_key("html:#cards"));
    }
    #[test]
    fn strict_rejects_scripts_external_resources_and_fixed_layout() {
        for source in [
            "<script>alert(1)</script>",
            "<button onclick='alert(1)'>Click</button>",
            "<img src='file:///secret.png'>",
            "<link rel='stylesheet' href='style.css'>",
            "<div style='position:fixed'>Fixed</div>",
        ] {
            assert!(matches!(
                import_html(source, &ImportOptions::default()),
                Err(ImportError::Unsupported(_))
            ));
        }
        let r = import_html(
            "<img src='file:///secret.png'>",
            &ImportOptions {
                strict: false,
                ..Default::default()
            },
        )
        .unwrap();
        assert!(r.resources.is_empty());
        assert_eq!(r.diagnostics[0].code, "resource_unavailable");
    }

    #[test]
    fn inline_subtrees_obey_the_same_depth_limit() {
        let source = format!("{}한글{}", "<span>".repeat(300), "</span>".repeat(300));
        assert!(matches!(
            import_html(&source, &ImportOptions::default()),
            Err(ImportError::ResourceLimit(_))
        ));
    }
}
