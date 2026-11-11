use super::*;
use omc_model::NodeKind;
use std::collections::BTreeMap;

pub(super) fn prepare(
    snapshot: &DocumentSnapshot,
    page: Option<&str>,
) -> (DocumentSnapshot, String, Vec<Diagnostic>) {
    let projection = omc_scene::resolve_components(snapshot, page);
    let mut result = projection.snapshot.into_owned();
    let mut diagnostics = projection.diagnostics;
    let references = omc_style::ReferenceContext::new(snapshot);
    let tokens = omc_style::catalog_entities(snapshot, "tokens");
    let styles = omc_style::catalog_entities(snapshot, "styles");
    let mut variables = BTreeMap::new();
    for (id, token) in &tokens {
        let mode = token
            .get("activeMode")
            .and_then(Value::as_str)
            .or_else(|| snapshot.metadata.get("tokenMode").and_then(Value::as_str));
        let value = mode
            .and_then(|mode| token.get("modes").and_then(|m| m.get(mode)))
            .or_else(|| token.get("value"));
        if let Some(value) = value.and_then(|v| token_value(v, &tokens)) {
            variables.insert(token_name(id, &tokens), value);
        }
    }
    for (id, style) in &styles {
        for (field, value) in style_fields(style) {
            if let Some(value) = token_value(&value, &tokens) {
                variables.insert(
                    style_name(id, &field),
                    with_unit(&field, &value, value.parse::<f64>().is_ok()),
                );
            }
        }
    }
    for node in result.nodes.values_mut() {
        let original = node.properties.clone();
        let (properties, issues) = references.properties(node);
        node.properties = properties;
        diagnostics.extend(issues);
        for (reference, kind) in [
            ("fillStyleId", "fill"),
            ("strokeStyleId", "stroke"),
            ("textStyleId", "text"),
        ] {
            if let Some(id) = original.get(reference).and_then(Value::as_str) {
                if let Some(style) = styles.get(id) {
                    for (field, _) in style_fields(style) {
                        if (kind == "fill" && field != "fill")
                            || (kind == "stroke"
                                && !matches!(field.as_str(), "stroke" | "strokeWidth"))
                        {
                            continue;
                        }
                        let local = original.contains_key(&field)
                            || (kind == "fill" && original.contains_key("fills"))
                            || (kind == "stroke" && original.contains_key("strokes"));
                        if !local {
                            node.properties.insert(
                                field.clone(),
                                json!(format!("var({})", style_name(id, &field))),
                            );
                        }
                    }
                }
            }
        }
        for (key, value) in &original {
            if value.get("$token").is_some() {
                if let Some(value) = token_value(value, &tokens) {
                    node.properties.insert(key.clone(), json!(value));
                }
            }
        }
        if let Some(style) = original.get("style").and_then(Value::as_object) {
            if let Some(target) = node
                .properties
                .get_mut("style")
                .and_then(Value::as_object_mut)
            {
                for (key, value) in style {
                    if value.get("$token").is_some() {
                        if let Some(value) = token_value(value, &tokens) {
                            target.insert(key.clone(), json!(value));
                        }
                    }
                }
            }
        }
        for stack in ["fills", "strokes"] {
            if let Some(paints) = node.properties.get(stack).and_then(Value::as_array) {
                if paints.len() > 1
                    || paints.iter().any(|paint| {
                        paint.get("gradient").is_some()
                            || paint.get("image").is_some()
                            || paint
                                .get("type")
                                .and_then(Value::as_str)
                                .is_some_and(|t| !matches!(t, "solid" | "color"))
                    })
                {
                    diagnostics.push(Diagnostic::unsupported(Some(&node.id),Some(stack),"Semantic code export currently requires solid paint stacks; source native package retains the full appearance"));
                }
            }
        }
        for key in [
            "shadows",
            "backgroundBlur",
            "shader",
            "effect",
            "maskMode",
            "maskType",
            "isMaskGroup",
        ] {
            if let Some(value) = original.get(key).filter(|v| {
                !v.is_null() && *v != &json!(false) && !v.as_array().is_some_and(Vec::is_empty)
            }) {
                diagnostics.push(Diagnostic::unsupported(
                    Some(&node.id),
                    Some(key),
                    &value.to_string(),
                ));
            }
        }
        if node.kind == NodeKind::Instance && node.properties.contains_key("sourceComponentId") {
            node.kind = NodeKind::Frame;
        }
    }
    let snapshot = result.clone();
    for node in result.nodes.values_mut() {
        let parent_flow = node
            .parent_id
            .as_ref()
            .and_then(|id| snapshot.nodes.get(id))
            .is_some_and(|p| {
                p.properties.get("style").is_some_and(|s| {
                    if let Some(s) = s.as_str() {
                        omc_style::parse_declarations(s).iter().any(|d| {
                            d.name == "display" && matches!(d.value.as_str(), "flex" | "grid")
                        })
                    } else {
                        s.get("display")
                            .and_then(Value::as_str)
                            .is_some_and(|s| matches!(s, "flex" | "grid"))
                    }
                })
            });
        if parent_flow
            && !node.properties.contains_key("tag")
            && node.properties.get("absolute") != Some(&json!(true))
        {
            node.properties.remove("x");
            node.properties.remove("y");
            node.properties.insert("codeFlow".into(), json!(true));
        }
    }
    let variables = variables
        .into_iter()
        .map(|(name, value)| format!("{name}:{value}"))
        .collect::<Vec<_>>()
        .join(";");
    let css = format!(
        ":root{{{variables}}}\n{}",
        snapshot
            .metadata
            .get("css")
            .and_then(Value::as_str)
            .unwrap_or("")
    );
    (result, css, diagnostics)
}
fn token_name(id: &str, tokens: &BTreeMap<String, Value>) -> String {
    format!(
        "--{}",
        ident(
            tokens
                .get(id)
                .and_then(|t| t.get("name"))
                .and_then(Value::as_str)
                .unwrap_or(id)
                .trim_start_matches("--")
        )
    )
}
fn style_name(id: &str, field: &str) -> String {
    format!("--omc-style-{}-{}", ident(id), ident(field))
}
fn ident(value: &str) -> String {
    let mut result = String::new();
    for c in value.chars() {
        if c.is_ascii_alphanumeric() || matches!(c, '-' | '_') {
            result.push(c);
        } else {
            result.push_str(&format!("\\{:x} ", c as u32));
        }
    }
    result
}
fn token_value(value: &Value, tokens: &BTreeMap<String, Value>) -> Option<String> {
    if let Some(id) = value.get("$token").and_then(Value::as_str) {
        Some(format!("var({})", token_name(id, tokens)))
    } else {
        omc_style::css_value(value)
    }
}
fn style_fields(style: &Value) -> BTreeMap<String, Value> {
    let value = style
        .get("value")
        .or_else(|| style.get("text"))
        .or_else(|| style.get("paints"))
        .or_else(|| style.get("data"))
        .unwrap_or(&Value::Null);
    if style.get("type").and_then(Value::as_str) == Some("text") {
        return value
            .as_object()
            .map(|v| v.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
            .unwrap_or_default();
    }
    let paints = value.as_array().or_else(|| {
        value
            .get("paints")
            .or_else(|| value.get("fills"))
            .and_then(Value::as_array)
    });
    let Some(paint) = paints.filter(|p| p.len() == 1).and_then(|p| p.first()) else {
        return BTreeMap::new();
    };
    let mut fields = BTreeMap::new();
    if let Some(color) = paint.get("color") {
        fields.insert("fill".into(), color.clone());
        fields.insert("stroke".into(), color.clone());
    }
    if let Some(width) = paint.get("width") {
        fields.insert("strokeWidth".into(), width.clone());
    }
    fields
}
fn with_unit(field: &str, value: &str, numeric: bool) -> String {
    if numeric && matches!(field, "fontSize" | "strokeWidth" | "letterSpacing") {
        format!("{value}px")
    } else {
        value.into()
    }
}
