//! Catalog references are resolved into a derived projection, never copied back to authored nodes.
use crate::{Diagnostic, css_value};
use omc_model::{DocumentSnapshot, Node, Properties};
use serde_json::{Map, Value, json};
use std::collections::{BTreeMap, BTreeSet};

pub fn catalog_entities(snapshot: &DocumentSnapshot, namespace: &str) -> BTreeMap<String, Value> {
    let prefix = format!("{namespace}/");
    let mut entities: BTreeMap<String, Value> = BTreeMap::new();
    for (key, value) in &snapshot.metadata {
        let Some((id, field)) = key.strip_prefix(&prefix).and_then(|k| k.split_once('/')) else {
            continue;
        };
        if id.is_empty() || field.is_empty() {
            continue;
        }
        if let Some(object) = entities
            .entry(id.into())
            .or_insert_with(|| json!({"id":id}))
            .as_object_mut()
        {
            object.insert(field.into(), value.clone());
        }
    }
    entities.retain(|_, entity| entity.get("deleted") != Some(&Value::Bool(true)));
    entities
}

pub struct ReferenceContext<'a> {
    snapshot: &'a DocumentSnapshot,
    styles: BTreeMap<String, Value>,
    tokens: BTreeMap<String, Value>,
    active_mode: Option<String>,
}

impl<'a> ReferenceContext<'a> {
    pub fn new(snapshot: &'a DocumentSnapshot) -> Self {
        Self {
            snapshot,
            styles: catalog_entities(snapshot, "styles"),
            tokens: catalog_entities(snapshot, "tokens"),
            active_mode: snapshot
                .metadata
                .get("tokenMode")
                .and_then(Value::as_str)
                .map(str::to_owned),
        }
    }

    pub fn token_variables(&self) -> (BTreeMap<String, String>, Vec<Diagnostic>) {
        let mut variables = BTreeMap::new();
        let mut diagnostics = Vec::new();
        for (id, token) in &self.tokens {
            let name = token.get("name").and_then(Value::as_str).unwrap_or(id);
            match self.token(id, None, &mut BTreeSet::new(), 0) {
                Ok(value) => {
                    if let Some(value) = css_value(&value) {
                        variables.insert(format!("--{}", name.trim_start_matches("--")), value);
                    }
                }
                Err(reason) => diagnostics.push(reference_diagnostic(None, "token", id, &reason)),
            }
        }
        (variables, diagnostics)
    }

    pub fn properties(&self, node: &Node) -> (Properties, Vec<Diagnostic>) {
        let mut properties = Properties::new();
        let mut diagnostics = Vec::new();
        for (reference, kind) in [
            ("fillStyleId", "fill"),
            ("strokeStyleId", "stroke"),
            ("textStyleId", "text"),
            ("effectStyleId", "effect"),
        ] {
            let Some(id) = node.properties.get(reference).and_then(Value::as_str) else {
                continue;
            };
            let Some(style) = self.styles.get(id) else {
                diagnostics.push(reference_diagnostic(
                    Some(&node.id),
                    reference,
                    id,
                    "Catalog entry is unavailable",
                ));
                continue;
            };
            let value = style
                .get("value")
                .or_else(|| style.get("data"))
                .or_else(|| {
                    style.get(match kind {
                        "text" => "text",
                        "effect" => "effects",
                        _ => "paints",
                    })
                })
                .unwrap_or(&Value::Null);
            match kind {
                "fill" | "stroke" => {
                    let paints = if value.is_array() {
                        Some(value)
                    } else {
                        value
                            .get("paints")
                            .or_else(|| value.get("fills"))
                            .or_else(|| value.get("strokes"))
                    };
                    if let Some(paints) = paints {
                        properties.insert(
                            if kind == "fill" { "fills" } else { "strokes" }.into(),
                            paints.clone(),
                        );
                    } else if value.is_string() || value.get("$token").is_some() {
                        properties.insert(kind.into(), value.clone());
                    } else {
                        diagnostics.push(reference_diagnostic(
                            Some(&node.id),
                            reference,
                            id,
                            "Paint style has no supported value",
                        ));
                    }
                }
                "effect" if value.is_array() => {
                    properties.insert("shadows".into(), value.clone());
                }
                _ => {
                    if let Some(fields) = value.as_object() {
                        for (key, value) in fields {
                            properties.insert(key.clone(), value.clone());
                        }
                    }
                }
            }
        }
        // Only explicitly authored fields override a linked definition. Resolving a style
        // must not materialize its current color as a permanent local override.
        properties.extend(node.properties.clone());
        for (scalar, stack) in [("fill", "fills"), ("stroke", "strokes")] {
            if node.properties.contains_key(scalar) && !node.properties.contains_key(stack) {
                properties.remove(stack);
            }
        }
        if let Some(bindings) = node
            .properties
            .get("figcraftVariableBindings")
            .and_then(Value::as_object)
        {
            for (field, reference) in bindings {
                if matches!(
                    field.as_str(),
                    "width" | "height" | "fontSize" | "strokeWidth" | "opacity"
                ) && reference.get("$token").is_some()
                {
                    match self.resolve(reference, Some(node), &mut BTreeSet::new(), 0) {
                        Ok(value) if value.is_number() => {
                            let value = if field == "opacity" {
                                json!((value.as_f64().unwrap() / 100.).clamp(0., 1.))
                            } else {
                                json!(value.as_f64().unwrap().max(0.))
                            };
                            properties.insert(field.clone(), value);
                        }
                        Ok(_) => diagnostics.push(reference_diagnostic(
                            Some(&node.id),
                            field,
                            &reference.to_string(),
                            "Numeric field resolved to a nonnumeric value",
                        )),
                        Err(reason) => diagnostics.push(reference_diagnostic(
                            Some(&node.id),
                            field,
                            &reference.to_string(),
                            &reason,
                        )),
                    }
                }
            }
        }
        for (key, value) in &mut properties {
            match self.resolve(value, Some(node), &mut BTreeSet::new(), 0) {
                Ok(resolved) => *value = resolved,
                Err(reason) => diagnostics.push(reference_diagnostic(
                    Some(&node.id),
                    key,
                    &value.to_string(),
                    &reason,
                )),
            }
        }
        normalize(&mut properties, &node.id, &mut diagnostics);
        (properties, diagnostics)
    }

    fn mode_for(&self, node: &Node, collection: &str) -> Option<String> {
        let mut current = Some(node);
        // Cap traversal for unvalidated readers as with layout.
        for _ in 0..512 {
            let node = current?;
            if let Some(mode) = node
                .properties
                .get("figcraftVariableModes")
                .and_then(|modes| modes.get(collection))
                .and_then(Value::as_str)
            {
                return Some(mode.to_owned());
            }
            current = node
                .parent_id
                .as_ref()
                .and_then(|id| self.snapshot.nodes.get(id));
        }
        None
    }

    fn token(
        &self,
        id: &str,
        node: Option<&Node>,
        seen: &mut BTreeSet<String>,
        depth: usize,
    ) -> Result<Value, String> {
        if depth > 32 || !seen.insert(id.to_owned()) {
            return Err("Token reference cycle or depth limit".into());
        }
        let token = self
            .tokens
            .get(id)
            .ok_or_else(|| format!("Missing token {id}"))?;
        let inherited = node
            .zip(token.get("collectionId").and_then(Value::as_str))
            .and_then(|(node, collection)| self.mode_for(node, collection));
        let mode = inherited
            .as_deref()
            .or_else(|| token.get("activeMode").and_then(Value::as_str))
            .or(self.active_mode.as_deref());
        let value = mode
            .and_then(|mode| token.get("modes").and_then(|m| m.get(mode)))
            .or_else(|| token.get("value"))
            .ok_or_else(|| format!("Token {id} has no value for the active mode"))?;
        let result = self.resolve(value, node, seen, depth + 1);
        seen.remove(id);
        result
    }

    fn resolve(
        &self,
        value: &Value,
        node: Option<&Node>,
        seen: &mut BTreeSet<String>,
        depth: usize,
    ) -> Result<Value, String> {
        if depth > 64 {
            return Err("Reference nesting limit".into());
        }
        if let Some(id) = value.get("$token").and_then(Value::as_str) {
            return self.token(id, node, seen, depth + 1);
        }
        match value {
            Value::Array(values) => values
                .iter()
                .map(|v| self.resolve(v, node, seen, depth + 1))
                .collect::<Result<Vec<_>, _>>()
                .map(Value::Array),
            Value::Object(values) => values
                .iter()
                .map(|(k, v)| Ok((k.clone(), self.resolve(v, node, seen, depth + 1)?)))
                .collect::<Result<Map<_, _>, String>>()
                .map(Value::Object),
            _ => Ok(value.clone()),
        }
    }
}

fn reference_diagnostic(
    node: Option<&str>,
    property: &str,
    original: &str,
    action: &str,
) -> Diagnostic {
    Diagnostic {
        code: "unresolved_reference".into(),
        severity: "error".into(),
        node_id: node.map(str::to_owned),
        property: Some(property.into()),
        original: original.into(),
        action: action.into(),
        fidelity_lost: true,
    }
}

fn normalize(properties: &mut Properties, id: &str, diagnostics: &mut Vec<Diagnostic>) {
    if properties.get("hidden") == Some(&Value::Bool(true)) {
        properties.insert("visible".into(), json!(false));
    }
    if let Some(radius) = properties.get("radii").filter(|v| v.is_number()).cloned() {
        properties.entry("cornerRadius".into()).or_insert(radius);
    }
    // The renderer consumes the complete stacks. Single-paint projection also makes
    // existing inspector/CSS consumers see the same effective solid color.
    for (stack, scalar) in [("fills", "fill"), ("strokes", "stroke")] {
        if let Some(paints) = properties.get(stack).and_then(Value::as_array) {
            let visible: Vec<_> = paints
                .iter()
                .filter(|p| {
                    p.get("hidden") != Some(&Value::Bool(true))
                        && p.get("visible") != Some(&Value::Bool(false))
                })
                .collect();
            if visible.len() == 1 {
                if let Some(color) = visible[0].get("color").filter(|v| v.is_string()).cloned() {
                    properties.entry(scalar.into()).or_insert(color);
                }
            }
        }
    }
    let mut style = match properties.get("style") {
        Some(Value::Object(v)) => v.clone(),
        Some(Value::String(s)) => crate::parse_declarations(s)
            .into_iter()
            .map(|d| {
                (
                    d.name,
                    Value::String(if d.important {
                        format!("{} !important", d.value)
                    } else {
                        d.value
                    }),
                )
            })
            .collect(),
        _ => Map::new(),
    };
    if let Some(layout) = properties.get("layout").and_then(Value::as_object) {
        let kind = layout.get("type").and_then(Value::as_str).unwrap_or("flex");
        if kind != "none" {
            style
                .entry("display")
                .or_insert(json!(if kind == "grid" { "grid" } else { "flex" }));
            for (source, target) in [
                ("direction", "flex-direction"),
                ("alignItems", "align-items"),
                ("alignContent", "align-content"),
                ("justifyContent", "justify-content"),
                ("justifyItems", "justify-items"),
                ("rowGap", "row-gap"),
                ("columnGap", "column-gap"),
            ] {
                if let Some(value) = layout.get(source) {
                    style.entry(target).or_insert(value.clone());
                }
            }
            if let Some(wrap) = layout.get("wrap") {
                style.entry("flex-wrap").or_insert(if wrap.is_boolean() {
                    json!(if wrap == &json!(true) {
                        "wrap"
                    } else {
                        "nowrap"
                    })
                } else {
                    wrap.clone()
                });
            }
            if let Some(gap) = layout.get("gap") {
                if let Some(gap) = gap.as_object() {
                    for (source, target) in [("row", "row-gap"), ("column", "column-gap")] {
                        if let Some(value) = gap.get(source) {
                            style.entry(target).or_insert(value.clone());
                        }
                    }
                } else {
                    style.entry("gap").or_insert(gap.clone());
                }
            }
            if let Some(padding) = layout.get("padding") {
                if let Some(parts) = padding.as_array() {
                    style.entry("padding").or_insert(json!(
                        parts
                            .iter()
                            .filter_map(css_value)
                            .collect::<Vec<_>>()
                            .join(" ")
                    ));
                } else {
                    style.entry("padding").or_insert(padding.clone());
                }
            }
            for (source, target) in [
                ("columns", "grid-template-columns"),
                ("rows", "grid-template-rows"),
            ] {
                if let Some(value) = layout.get(source) {
                    let value = if let Some(parts) = value.as_array() {
                        Value::String(
                            parts
                                .iter()
                                .filter_map(css_value)
                                .collect::<Vec<_>>()
                                .join(" "),
                        )
                    } else {
                        value.clone()
                    };
                    style.entry(target).or_insert(value);
                }
            }
        }
    }
    if properties.get("absolute") == Some(&Value::Bool(true))
        || properties.get("layoutPositioning").and_then(Value::as_str) == Some("absolute")
    {
        style.insert("position".into(), json!("absolute"));
    }
    for (source, target) in [
        ("alignSelf", "align-self"),
        ("justifySelf", "justify-self"),
        ("minWidth", "min-width"),
        ("maxWidth", "max-width"),
        ("minHeight", "min-height"),
        ("maxHeight", "max-height"),
    ] {
        if let Some(value) = properties.get(source) {
            style.entry(target).or_insert(value.clone());
        }
    }
    if let Some(blur) = properties
        .get("blur")
        .and_then(Value::as_f64)
        .filter(|v| *v > 0.)
    {
        if properties.get("blurHidden") != Some(&Value::Bool(true)) {
            style
                .entry("filter")
                .or_insert(json!(format!("blur({blur}px)")));
        }
    }
    if properties
        .get("backgroundBlur")
        .and_then(Value::as_f64)
        .is_some_and(|v| v > 0.)
        && properties.get("backgroundBlurHidden") != Some(&Value::Bool(true))
    {
        diagnostics.push(Diagnostic::unsupported(
            Some(id),
            Some("backgroundBlur"),
            "Backdrop blur requires a backdrop-dependent render group",
        ));
    }
    if !style.is_empty() {
        properties.insert("style".into(), Value::Object(style));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use omc_model::{DocumentContent, NodeKind};
    #[test]
    fn catalog_resolution_preserves_references_and_local_overrides() {
        let c = DocumentContent::empty("catalog");
        let mut s = DocumentSnapshot {
            id: "test".into(),
            title: c.title,
            epoch: "epoch".into(),
            sequence: 1,
            pages: c.pages,
            nodes: c.nodes,
            metadata: c.metadata,
        };
        s.metadata
            .insert("tokens/brand/name".into(), json!("brand"));
        s.metadata
            .insert("tokens/brand/value".into(), json!("#ff0000"));
        s.metadata.insert(
            "styles/accent/value".into(),
            json!([{"color":{"$token":"brand"}}]),
        );
        let mut n = Node::new(NodeKind::Rect);
        n.properties.insert("fillStyleId".into(), json!("accent"));
        let (p, d) = ReferenceContext::new(&s).properties(&n);
        assert!(d.is_empty());
        assert_eq!(p["fill"], json!("#ff0000"));
        assert!(!n.properties.contains_key("fill"));
        s.metadata
            .insert("tokens/brand/value".into(), json!("#00ff00"));
        assert_eq!(
            ReferenceContext::new(&s).properties(&n).0["fill"],
            json!("#00ff00")
        );
        n.properties.insert("fill".into(), json!("blue"));
        assert_eq!(
            ReferenceContext::new(&s).properties(&n).0["fill"],
            json!("blue")
        );
    }
}
