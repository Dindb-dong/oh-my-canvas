//! Authored CSS remains separate from its viewport-dependent computed projection.
//! This module never reads files, loads URLs, or invokes a browser.
mod color;
mod css;
mod length;
mod references;
mod selectors;
pub use references::{ReferenceContext, catalog_entities};

pub use color::{Color, parse_color};
pub use css::{Declaration, Rule, StyleSheet, parse_declarations, parse_stylesheet};
pub use length::{LengthContext, resolve_length};

use omc_model::{DocumentSnapshot, Node};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

pub const PROFILE: &str = "omc.design-css/1";

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Diagnostic {
    pub code: String,
    pub severity: String,
    pub node_id: Option<String>,
    pub property: Option<String>,
    pub original: String,
    pub action: String,
    pub fidelity_lost: bool,
}

impl Diagnostic {
    pub fn unsupported(node: Option<&str>, property: Option<&str>, original: &str) -> Self {
        Self {
            code: "unsupported_feature".into(),
            severity: "warning".into(),
            node_id: node.map(str::to_owned),
            property: property.map(str::to_owned),
            original: original.to_owned(),
            action: "Retained authored value; native rendering is incomplete for this construct"
                .into(),
            fidelity_lost: true,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StyleSource {
    pub rule_id: Option<String>,
    pub authored_value: String,
    pub important: bool,
    pub inherited_from: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputedStyle {
    pub values: BTreeMap<String, String>,
    pub provenance: BTreeMap<String, StyleSource>,
    pub diagnostics: Vec<Diagnostic>,
}

impl ComputedStyle {
    pub fn get(&self, property: &str) -> Option<&str> {
        self.values.get(property).map(String::as_str)
    }
    pub fn number(&self, property: &str, fallback: f64) -> f64 {
        self.get(property)
            .and_then(|s| s.parse().ok())
            .filter(|v: &f64| v.is_finite())
            .unwrap_or(fallback)
    }
    pub fn color(&self, property: &str) -> Option<Color> {
        self.get(property).and_then(parse_color)
    }
}

/// Stable document/source order; incoming maps are not a cascade order.
pub fn compute_styles(
    snapshot: &DocumentSnapshot,
    viewport: (f64, f64),
) -> BTreeMap<String, ComputedStyle> {
    let sheet = snapshot
        .metadata
        .get("css")
        .and_then(Value::as_str)
        .map(parse_stylesheet)
        .unwrap_or_default();
    let mut result = BTreeMap::new();
    let references = ReferenceContext::new(snapshot);
    let (token_variables, token_diagnostics) = references.token_variables();
    let mut pending: BTreeSet<_> = snapshot.nodes.keys().cloned().collect();
    while !pending.is_empty() {
        let ready: Vec<_> = pending
            .iter()
            .filter(|id| {
                snapshot.nodes[*id]
                    .parent_id
                    .as_ref()
                    .is_none_or(|p| result.contains_key(p) || !pending.contains(p))
            })
            .cloned()
            .collect();
        if ready.is_empty() {
            // Engine repairs containment cycles. Keep read-only inspection bounded even for an unvalidated caller.
            break;
        }
        for id in ready {
            let node = &snapshot.nodes[&id];
            let parent = node.parent_id.as_ref().and_then(|p| result.get(p));
            let (properties, mut reference_diagnostics) = references.properties(node);
            let mut effective = node.clone();
            effective.properties = properties;
            let mut computed = compute_one(
                &effective,
                snapshot,
                parent,
                &sheet,
                viewport,
                &token_variables,
            );
            computed.diagnostics.append(&mut reference_diagnostics);
            if node.parent_id.is_none() {
                computed.diagnostics.extend(token_diagnostics.clone());
                computed.diagnostics.extend(
                    sheet.unsupported.iter().map(|value| {
                        Diagnostic::unsupported(Some(&node.id), Some("css-rule"), value)
                    }),
                );
            }
            result.insert(id.clone(), computed);
            pending.remove(&id);
        }
    }
    result
}

fn compute_one(
    node: &Node,
    snapshot: &DocumentSnapshot,
    parent: Option<&ComputedStyle>,
    sheet: &StyleSheet,
    viewport: (f64, f64),
    token_variables: &BTreeMap<String, String>,
) -> ComputedStyle {
    let mut out = ComputedStyle::default();
    out.values.extend(token_variables.clone());
    let mut winning: BTreeMap<String, ((bool, u32, usize), Declaration, Option<String>)> =
        BTreeMap::new();
    if let Some(parent) = parent {
        for (key, value) in &parent.values {
            if inherited(key) || key.starts_with("--") {
                out.values.insert(key.clone(), value.clone());
                out.provenance.insert(
                    key.clone(),
                    StyleSource {
                        rule_id: None,
                        authored_value: value.clone(),
                        important: false,
                        inherited_from: node.parent_id.clone(),
                    },
                );
            }
        }
    }
    for rule in &sheet.rules {
        if rule.min_width.is_some_and(|v| viewport.0 < v)
            || rule.max_width.is_some_and(|v| viewport.0 > v)
        {
            continue;
        }
        for selector in &rule.selectors {
            match selectors::matches(selector, node, snapshot) {
                Ok(Some(specificity)) => {
                    for declaration in &rule.declarations {
                        let priority = (declaration.important, specificity, rule.order);
                        if winning
                            .get(&declaration.name)
                            .is_none_or(|v| priority >= v.0)
                        {
                            winning.insert(
                                declaration.name.clone(),
                                (priority, declaration.clone(), Some(rule.id.clone())),
                            );
                        }
                    }
                }
                Ok(None) => (),
                Err(()) => out.diagnostics.push(Diagnostic::unsupported(
                    Some(&node.id),
                    Some("selector"),
                    selector,
                )),
            }
        }
    }
    let mut declarations = Vec::new();
    if let Some(style) = node.properties.get("style") {
        match style {
            Value::String(text) => declarations.extend(parse_declarations(text)),
            Value::Object(properties) => {
                for (key, value) in properties {
                    if let Some(value) = css_value(value) {
                        let important = value.trim_end().ends_with("!important");
                        let value = if important {
                            value
                                .trim_end()
                                .trim_end_matches("!important")
                                .trim_end()
                                .to_owned()
                        } else {
                            value
                        };
                        declarations.push(Declaration {
                            name: kebab(key),
                            value,
                            important,
                        });
                    }
                }
            }
            _ => out.diagnostics.push(Diagnostic::unsupported(
                Some(&node.id),
                Some("style"),
                &style.to_string(),
            )),
        }
    }
    // UI/MCP properties are explicit local overrides, while their original references remain authored.
    for (key, value) in &node.properties {
        let name = match key.as_str() {
            "fill" => {
                if node.kind == omc_model::NodeKind::Text {
                    "color"
                } else {
                    "background-color"
                }
            }
            "stroke" => "border-color",
            "strokeWidth" => "border-width",
            "fontFamily" => "font-family",
            "fontSize" => "font-size",
            "fontWeight" => "font-weight",
            "fontStyle" => "font-style",
            "textDecoration" => "text-decoration",
            "textAlign" => "text-align",
            "lineHeight" => "line-height",
            "letterSpacing" => "letter-spacing",
            "wordSpacing" => "word-spacing",
            "cornerRadius" => "border-radius",
            "x" => "left",
            "y" => "top",
            "width" | "height" | "opacity" | "color" | "display" => key,
            _ => continue,
        };
        if let Some(value) = css_value(value) {
            declarations.push(Declaration {
                name: name.into(),
                value,
                important: false,
            });
        }
    }
    for (i, declaration) in declarations.into_iter().enumerate() {
        let priority = (declaration.important, 1_000_000, sheet.rules.len() + i);
        if winning
            .get(&declaration.name)
            .is_none_or(|v| priority >= v.0)
        {
            winning.insert(declaration.name.clone(), (priority, declaration, None));
        }
    }
    for (key, (_, decl, rule)) in &winning {
        out.values.insert(key.clone(), decl.value.clone());
        out.provenance.insert(
            key.clone(),
            StyleSource {
                rule_id: rule.clone(),
                authored_value: decl.value.clone(),
                important: decl.important,
                inherited_from: None,
            },
        );
    }
    let authored = out.values.clone();
    for (key, value) in &authored {
        if key.starts_with("--") {
            continue;
        }
        match resolve_vars(value, &authored, &mut BTreeSet::new(), 0) {
            Ok(resolved) => {
                if resolved == "inherit" {
                    if let Some(value) = parent.and_then(|p| p.values.get(key)) {
                        out.values.insert(key.clone(), value.clone());
                    } else {
                        out.values.remove(key);
                    }
                } else {
                    out.values.insert(key.clone(), resolved);
                }
            }
            Err(()) => {
                out.values.remove(key);
                out.diagnostics.push(Diagnostic {
                    code: "invalid_css_variable".into(),
                    severity: "warning".into(),
                    node_id: Some(node.id.clone()),
                    property: Some(key.clone()),
                    original: value.clone(),
                    action:
                        "Invalid declaration omitted from computed style; authored source retained"
                            .into(),
                    fidelity_lost: true,
                });
            }
        }
    }
    expand_box_shorthand(&mut out, "padding");
    expand_box_shorthand(&mut out, "margin");
    out
}

fn expand_box_shorthand(style: &mut ComputedStyle, key: &str) {
    let Some(value) = style.values.get(key).cloned() else {
        return;
    };
    let parts: Vec<_> = value.split_whitespace().collect();
    let expanded = match parts.as_slice() {
        [a] => [*a, *a, *a, *a],
        [a, b] => [*a, *b, *a, *b],
        [a, b, c] => [*a, *b, *c, *b],
        [a, b, c, d] => [*a, *b, *c, *d],
        _ => return,
    };
    for (side, value) in ["top", "right", "bottom", "left"].into_iter().zip(expanded) {
        style
            .values
            .entry(format!("{key}-{side}"))
            .or_insert_with(|| value.to_owned());
    }
}

fn inherited(property: &str) -> bool {
    matches!(
        property,
        "color"
            | "font-family"
            | "font-size"
            | "font-style"
            | "font-weight"
            | "line-height"
            | "letter-spacing"
            | "word-spacing"
            | "text-align"
            | "direction"
            | "white-space"
            | "visibility"
    )
}

pub fn css_value(value: &Value) -> Option<String> {
    match value {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

fn kebab(value: &str) -> String {
    let mut out = String::new();
    for c in value.chars() {
        if c.is_ascii_uppercase() {
            out.push('-');
            out.push(c.to_ascii_lowercase());
        } else {
            out.push(c);
        }
    }
    out
}

fn resolve_vars(
    input: &str,
    values: &BTreeMap<String, String>,
    seen: &mut BTreeSet<String>,
    depth: usize,
) -> Result<String, ()> {
    if depth > 32 {
        return Err(());
    }
    let Some(start) = input.find("var(") else {
        return Ok(input.into());
    };
    let mut nesting = 1usize;
    let mut end = None;
    for (i, ch) in input[start + 4..].char_indices() {
        match ch {
            '(' => nesting += 1,
            ')' => {
                nesting -= 1;
                if nesting == 0 {
                    end = Some(start + 4 + i);
                    break;
                }
            }
            _ => (),
        }
    }
    let end = end.ok_or(())?;
    let body = &input[start + 4..end];
    let mut parts = body.splitn(2, ',');
    let name = parts.next().ok_or(())?.trim();
    let fallback = parts.next().map(str::trim);
    if !name.starts_with("--") {
        return Err(());
    }
    let replacement = if seen.insert(name.into()) {
        let result = values
            .get(name)
            .map(|value| resolve_vars(value, values, seen, depth + 1))
            .unwrap_or(Err(()));
        seen.remove(name);
        result
    } else {
        Err(())
    };
    let replacement = match replacement {
        Ok(v) => v,
        Err(()) => resolve_vars(fallback.ok_or(())?, values, seen, depth + 1)?,
    };
    resolve_vars(
        &format!("{}{}{}", &input[..start], replacement, &input[end + 1..]),
        values,
        seen,
        depth + 1,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use omc_model::{DocumentContent, NodeKind};
    use serde_json::json;
    fn snapshot() -> DocumentSnapshot {
        let c = DocumentContent::empty("test");
        DocumentSnapshot {
            id: "doc_00000000000000000000000000000001".into(),
            title: c.title,
            epoch: "test".into(),
            sequence: 0,
            pages: c.pages,
            nodes: c.nodes,
            metadata: c.metadata,
        }
    }
    #[test]
    fn cascade_preserves_source_and_resolves_variables() {
        let mut s = snapshot();
        let root = s.pages[0].root_node_id.clone();
        s.metadata.insert("css".into(),json!(".card { --accent: #123456; color: var(--accent); width: 50%; } #chosen { color: red !important; }"));
        let mut n = Node::new(NodeKind::Rect);
        n.parent_id = Some(root);
        n.properties.insert("class".into(), json!("card"));
        n.properties.insert("htmlId".into(), json!("chosen"));
        n.properties.insert("style".into(), json!("color: blue;"));
        let id = n.id.clone();
        s.nodes.insert(id.clone(), n);
        let styles = compute_styles(&s, (1440., 900.));
        assert_eq!(styles[&id].get("color"), Some("red"));
        assert_eq!(styles[&id].get("width"), Some("50%"));
        assert!(styles[&id].provenance["color"].important);
    }
    #[test]
    fn word_spacing_inherits_and_accepts_authored_overrides() {
        let mut s = snapshot();
        let root = s.pages[0].root_node_id.clone();
        s.metadata
            .insert("css".into(), json!(":root { word-spacing: 8px; }"));
        let mut node = Node::new(NodeKind::Text);
        node.parent_id = Some(root.clone());
        let id = node.id.clone();
        s.nodes.insert(id.clone(), node);
        let styles = compute_styles(&s, (1440., 900.));
        assert_eq!(styles[&id].get("word-spacing"), Some("8px"));
        assert_eq!(
            styles[&id].provenance["word-spacing"]
                .inherited_from
                .as_deref(),
            Some(root.as_str())
        );

        s.nodes
            .get_mut(&id)
            .unwrap()
            .properties
            .insert("wordSpacing".into(), json!(12));
        assert_eq!(
            compute_styles(&s, (1440., 900.))[&id].get("word-spacing"),
            Some("12")
        );
    }
    #[test]
    fn invalid_variable_cycle_uses_fallback_without_hanging() {
        let vars = BTreeMap::from([
            ("--a".into(), "var(--b)".into()),
            ("--b".into(), "var(--a)".into()),
        ]);
        assert_eq!(
            resolve_vars("var(--a, green)", &vars, &mut BTreeSet::new(), 0),
            Ok("green".into())
        );
    }
}
