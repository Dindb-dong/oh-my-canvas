use super::*;
use omc_model::{Node, NodeKind};
use std::collections::{BTreeMap, BTreeSet};

pub fn export_html(
    snapshot: &DocumentSnapshot,
    page_id: Option<&str>,
) -> Result<(String, Vec<Diagnostic>), ExportError> {
    let (prepared, css, mut diagnostics) = super::code_context::prepare(snapshot, page_id);
    let snapshot = &prepared;
    let root = root(snapshot, page_id)?;
    let body = element(
        snapshot,
        root,
        false,
        false,
        &mut BTreeSet::new(),
        &mut diagnostics,
        0,
        None,
    )?;
    // A literal closing style tag cannot be allowed to terminate the element.
    let css = css.replace('<', "\\3c ");
    Ok((
        format!(
            "<!doctype html>\n<html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><meta name=\"omc-css-profile\" content=\"{}\"><title>{}</title><style>{css}</style></head><body>{body}</body></html>\n",
            omc_style::PROFILE,
            escape(&snapshot.title)
        ),
        diagnostics,
    ))
}
pub fn export_react(
    snapshot: &DocumentSnapshot,
    page_id: Option<&str>,
    tailwind: bool,
) -> Result<(String, Vec<Diagnostic>), ExportError> {
    let (prepared, css, mut diagnostics) = super::code_context::prepare(snapshot, page_id);
    let snapshot = &prepared;
    let root = root(snapshot, page_id)?;
    let body = element(
        snapshot,
        root,
        true,
        tailwind,
        &mut BTreeSet::new(),
        &mut diagnostics,
        0,
        None,
    )?;
    let css = serde_json::to_string(&css).map_err(|e| ExportError::Invalid(e.to_string()))?;
    Ok((
        format!(
            "// Static design output. Requires React{}; contains no application behavior.\nexport default function CanvasDesign() {{\n  return (<>\n    <style>{{{css}}}</style>\n    {body}\n  </>);\n}}\n",
            if tailwind {
                " and a Tailwind CSS build that scans this file"
            } else {
                ""
            }
        ),
        diagnostics,
    ))
}

pub fn inspect_web(
    snapshot: &DocumentSnapshot,
    id: &str,
    language: &str,
    root_font_size: Option<f64>,
    component: Option<(&str, &BTreeMap<String, String>)>,
    mobile: Option<&str>,
) -> Result<String, ExportError> {
    let (prepared, css, mut diagnostics) = super::code_context::prepare(snapshot, Some(id));
    let node = prepared
        .nodes
        .get(id)
        .ok_or_else(|| ExportError::Invalid("unknown export layer".into()))?;
    let mobile_styles = mobile
        .map(|mobile| responsive_styles(&prepared, id, snapshot, mobile))
        .unwrap_or_default();
    let options = InspectOptions {
        root_font_size,
        component: component.map(|(_, properties)| properties),
        language,
        mobile_styles,
    };
    if language == "css" {
        return Ok(format!(
            "{};",
            authored_style(node)
                .into_iter()
                .map(|(key, value)| { format!("{key}: {}", options.units(value)) })
                .collect::<Vec<_>>()
                .join(";\n")
        ));
    }
    let jsx = matches!(language, "react" | "tailwind");
    let body = element(
        &prepared,
        id,
        jsx,
        language == "tailwind",
        &mut BTreeSet::new(),
        &mut diagnostics,
        0,
        Some(&options),
    )?;
    let name = component.map_or("CanvasDesign", |(name, _)| name);
    let css = options.units(css);
    let style = css.replace('<', "\\3c ");
    Ok(match language {
        "react" | "tailwind" => {
            let style =
                serde_json::to_string(&css).map_err(|e| ExportError::Invalid(e.to_string()))?;
            format!(
                "export default function {name}(props = {{}}) {{\n  return (<>\n    <style>{{{style}}}</style>\n    {body}\n  </>);\n}}"
            )
        }
        "vue" => {
            let script = if component.is_some() {
                "<script setup>\nconst props = defineProps(".to_owned()
                    + &json!(options.vue_props(&prepared)).to_string()
                    + ")\n</script>\n\n"
            } else {
                String::new()
            };
            format!("{script}<template>\n  {body}\n</template>\n<style>\n{style}\n</style>")
        }
        "leptos" => {
            let fields = options.leptos_props(&prepared).join(", ");
            format!(
                "use leptos::prelude::*;\n\n#[component]\npub fn {name}({fields}) -> impl IntoView {{\n    view! {{ <style>{{{css:?}}}</style> {body} }}\n}}"
            )
        }
        _ if style.is_empty() => body,
        _ => format!("<style>{style}</style>\n{body}"),
    })
}

struct InspectOptions<'a> {
    root_font_size: Option<f64>,
    component: Option<&'a BTreeMap<String, String>>,
    language: &'a str,
    mobile_styles: BTreeMap<String, BTreeMap<String, String>>,
}

impl InspectOptions<'_> {
    fn units(&self, value: String) -> String {
        let Some(base) = self.root_font_size else {
            return value;
        };
        Self::lengths_in_rem(&value, base)
    }

    fn prop_name<'a>(&'a self, node: &Node, kind: &str) -> Option<&'a str> {
        let key = node
            .properties
            .get("componentPropertyRefs")?
            .get(kind)?
            .as_str()?;
        self.component?.get(key).map(String::as_str)
    }

    fn property(&self, node: &Node, kind: &str) -> Option<String> {
        let property = self.prop_name(node, kind)?;
        if self.language == "leptos" {
            let name = leptos_prop(property);
            let fallback = if kind == "characters" {
                format!("{:?}.to_owned()", node.string("text").unwrap_or_default())
            } else {
                (node.properties.get("visible") != Some(&Value::Bool(false))).to_string()
            };
            return Some(format!("{name}.clone().unwrap_or_else(|| {fallback})"));
        }
        serde_json::to_string(property)
            .ok()
            .map(|key| format!("props[{key}]"))
    }

    fn vue_props(&self, snapshot: &DocumentSnapshot) -> BTreeMap<String, Value> {
        self.bound_props(snapshot)
            .into_iter()
            .map(|(property, (kind, fallback))| {
                let value = if kind == "characters" {
                    json!(fallback)
                } else {
                    json!(fallback == "true")
                };
                (property, json!({"default":value}))
            })
            .collect()
    }

    fn lengths_in_rem(value: &str, base: f64) -> String {
        let mut result = String::with_capacity(value.len());
        let mut rest = value;
        let mut previous = None;
        let mut quote = None;
        while let Some(ch) = rest.chars().next() {
            if let Some(delimiter) = quote {
                result.push(ch);
                rest = &rest[ch.len_utf8()..];
                if ch == '\\' {
                    if let Some(escaped) = rest.chars().next() {
                        result.push(escaped);
                        rest = &rest[escaped.len_utf8()..];
                    }
                } else if ch == delimiter {
                    quote = None;
                }
            } else {
                if ch == '\'' || ch == '"' {
                    quote = Some(ch);
                }
                let start = ch.is_ascii_digit() || matches!(ch, '+' | '-' | '.');
                let separate = previous
                    .is_none_or(|ch: char| !ch.is_alphanumeric() && !matches!(ch, '-' | '_' | '.'));
                if start && separate {
                    let end = rest
                        .char_indices()
                        .take_while(|(index, ch)| {
                            ch.is_ascii_digit()
                                || *ch == '.'
                                || *index == 0 && matches!(ch, '+' | '-')
                        })
                        .last()
                        .map_or(0, |(index, ch)| index + ch.len_utf8());
                    let (number, suffix) = rest.split_at(end);
                    if let Some(after) = suffix.strip_prefix("px")
                        && after.chars().next().is_none_or(|ch| {
                            !ch.is_alphanumeric() && !matches!(ch, '-' | '_' | '.')
                        })
                        && let Ok(pixels) = number.parse::<f64>()
                        && let rem = pixels / base
                        && rem.is_finite()
                    {
                        let rendered = format!("{rem:.6}");
                        result.push_str(rendered.trim_end_matches('0').trim_end_matches('.'));
                        result.push_str("rem");
                        rest = after;
                        previous = Some('x');
                        continue;
                    }
                }
                result.push(ch);
                rest = &rest[ch.len_utf8()..];
            }
            previous = Some(ch);
        }
        result
    }

    fn leptos_props(&self, snapshot: &DocumentSnapshot) -> Vec<String> {
        self.bound_props(snapshot)
            .into_iter()
            .map(|(property, (kind, _))| {
                let param = leptos_prop(&property);
                let typ = if kind == "characters" {
                    "String"
                } else {
                    "bool"
                };
                format!("#[prop(optional)] {param}: Option<{typ}>")
            })
            .collect()
    }

    fn bound_props(&self, snapshot: &DocumentSnapshot) -> BTreeMap<String, (&'static str, String)> {
        let mut properties = BTreeMap::new();
        for node in snapshot.nodes.values() {
            for kind in ["characters", "visible"] {
                if let Some(name) = self.prop_name(node, kind) {
                    let fallback = if kind == "characters" {
                        node.string("text").unwrap_or_default().to_owned()
                    } else {
                        (node.properties.get("visible") != Some(&Value::Bool(false))).to_string()
                    };
                    properties.insert(name.to_owned(), (kind, fallback));
                }
            }
        }
        properties
    }
}
fn leptos_prop(name: &str) -> String {
    format!(
        "prop_{}",
        name.chars()
            .map(|c| if c.is_ascii_alphanumeric() {
                c.to_ascii_lowercase()
            } else {
                '_'
            })
            .collect::<String>()
    )
}

fn responsive_styles(
    desktop: &DocumentSnapshot,
    desktop_root: &str,
    original: &DocumentSnapshot,
    mobile_root: &str,
) -> BTreeMap<String, BTreeMap<String, String>> {
    let (mobile, _, _) = super::code_context::prepare(original, Some(mobile_root));
    let children = |snapshot: &DocumentSnapshot| {
        let mut by_parent = BTreeMap::<String, Vec<(String, String, String)>>::new();
        for node in snapshot.nodes.values() {
            if let Some(parent) = &node.parent_id {
                by_parent.entry(parent.clone()).or_default().push((
                    node.string("name").unwrap_or_default().to_owned(),
                    node.rank.to_string(),
                    node.id.clone(),
                ));
            }
        }
        for nodes in by_parent.values_mut() {
            nodes.sort_by(|a, b| (&a.1, &a.2).cmp(&(&b.1, &b.2)));
        }
        by_parent
    };
    let desktop_children = children(desktop);
    let mobile_children = children(&mobile);
    let mut styles = BTreeMap::new();
    let mut pending = vec![(desktop_root.to_owned(), mobile_root.to_owned())];
    while let Some((desktop_id, mobile_id)) = pending.pop() {
        if styles.contains_key(&desktop_id) {
            continue;
        }
        let Some(node) = mobile.nodes.get(&mobile_id) else {
            continue;
        };
        styles.insert(desktop_id.clone(), authored_style(node));
        let mut used = BTreeSet::new();
        for (name, _, child) in desktop_children.get(&desktop_id).into_iter().flatten() {
            if let Some((_, _, matching)) = mobile_children
                .get(&mobile_id)
                .into_iter()
                .flatten()
                .find(|(candidate, _, matching)| candidate == name && !used.contains(matching))
            {
                used.insert(matching.clone());
                pending.push((child.clone(), matching.clone()));
            }
        }
    }
    styles
}

fn root<'a>(s: &'a DocumentSnapshot, id: Option<&str>) -> Result<&'a str, ExportError> {
    match id {
        Some(id) => s
            .pages
            .iter()
            .find(|p| p.id == id)
            .map(|p| p.root_node_id.as_str())
            .or_else(|| s.nodes.get(id).map(|n| n.id.as_str())),
        None => s.pages.first().map(|p| p.root_node_id.as_str()),
    }
    .ok_or_else(|| ExportError::Invalid("unknown export page or root".into()))
}

fn element(
    snapshot: &DocumentSnapshot,
    id: &str,
    jsx: bool,
    tailwind: bool,
    visiting: &mut BTreeSet<String>,
    diagnostics: &mut Vec<Diagnostic>,
    depth: usize,
    options: Option<&InspectOptions<'_>>,
) -> Result<String, ExportError> {
    if depth > 512 || !visiting.insert(id.into()) {
        return Err(ExportError::Invalid(
            "cyclic or excessive export tree".into(),
        ));
    }
    let node = snapshot
        .nodes
        .get(id)
        .ok_or_else(|| ExportError::Invalid(format!("missing node {id}")))?;
    let tag = node
        .properties
        .get("tag")
        .and_then(Value::as_str)
        .filter(|t| safe_tag(t))
        .unwrap_or(match node.kind {
            NodeKind::Text => "p",
            NodeKind::Image => "img",
            _ => "div",
        });
    let mut attrs = format!(" data-omc-id=\"{}\"", escape(id));
    if tag == "button" {
        attrs.push_str(" type=\"button\"");
    }
    if let Some(id) = node.properties.get("htmlId").and_then(Value::as_str) {
        attrs.push_str(&format!(" id=\"{}\"", escape(id)));
    }
    let language = options.map_or("", |options| options.language);
    let leptos = language == "leptos";
    let vue = language == "vue";
    let visible = options.and_then(|options| options.property(node, "visible"));
    let text = options.and_then(|options| options.property(node, "characters"));
    let mut styles = authored_style(node);
    if visible.is_some() && matches!(styles.get("display").map(String::as_str), Some("none")) {
        styles.remove("display");
    }
    if vue {
        if let Some(visible) = &visible {
            attrs.push_str(&format!(" v-if=\"{}\"", escape(visible)));
        }
        if let Some(text) = &text {
            attrs.push_str(&format!(" v-text=\"{}\"", escape(text)));
        }
    }
    let mut classes = node
        .properties
        .get("class")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned();
    let mut inline = BTreeMap::new();
    let mobile = options.and_then(|options| options.mobile_styles.get(id));
    let utility = |key: &str, value: &str| {
        value
            .chars()
            .all(|c| !matches!(c, '[' | ']' | '"' | '\'' | '<' | '>' | '\\' | '\n'))
            .then(|| format!("[{key}:{}]", value.replace(' ', "_")))
    };
    if let Some(mobile) = mobile {
        for (key, value) in mobile {
            if styles.get(key) != Some(value) {
                if let Some(class) = utility(key, value) {
                    classes.push_str(&format!(" {class}"));
                    if !styles.contains_key(key) {
                        classes.push_str(&format!(" lg:[{key}:initial]"));
                    }
                }
            }
        }
    }
    for (key, value) in styles {
        let value = match options {
            Some(options) => options.units(value),
            None => value,
        };
        if let Some(class) = tailwind.then(|| utility(&key, &value)).flatten() {
            let breakpoint = if mobile.is_some_and(|styles| styles.get(&key) != Some(&value)) {
                "lg:"
            } else {
                ""
            };
            classes.push_str(&format!(" {breakpoint}{class}"));
        } else {
            inline.insert(key, value);
        }
    }
    if !classes.trim().is_empty() {
        attrs.push_str(&format!(
            " {}=\"{}\"",
            if jsx { "className" } else { "class" },
            escape(classes.trim())
        ));
    }
    if !inline.is_empty() {
        if jsx {
            let object: BTreeMap<_, _> = inline
                .iter()
                .map(|(k, v)| (camel(k), Value::String(v.clone())))
                .collect();
            attrs.push_str(&format!(
                " style={{{}}}",
                serde_json::to_string(&object).map_err(|e| ExportError::Invalid(e.to_string()))?
            ));
        } else {
            attrs.push_str(&format!(
                " style=\"{}\"",
                escape(
                    &inline
                        .iter()
                        .map(|(k, v)| format!("{k}:{v}"))
                        .collect::<Vec<_>>()
                        .join(";")
                )
            ));
        }
    }
    if tag == "img" {
        let hash = node
            .properties
            .get("assetHash")
            .or_else(|| node.properties.get("imageHash"))
            .and_then(Value::as_str)
            .ok_or_else(|| {
                ExportError::Resource(format!("image {} has no asset identity", node.id))
            })?;
        attrs.push_str(&format!(
            " src=\"assets/{}\" alt=\"{}\"",
            escape(hash),
            escape(
                node.properties
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or("")
            )
        ));
        diagnostics.push(Diagnostic {
            code: "external_asset_files_required".into(),
            severity: "info".into(),
            node_id: Some(id.into()),
            property: Some("src".into()),
            original: hash.into(),
            action: "Export the matching verified resource beside this source under assets/".into(),
            fidelity_lost: false,
        });
        visiting.remove(id);
        return Ok(format!(
            "<{tag}{attrs}{}>",
            if jsx || leptos { " /" } else { "" }
        ));
    }
    if matches!(
        node.kind,
        NodeKind::Path | NodeKind::Ellipse | NodeKind::Line
    ) {
        diagnostics.push(Diagnostic::unsupported(
            Some(id),
            Some("geometry"),
            "Vector node requires SVG source conversion in semantic HTML export",
        ));
    }
    if node.kind == NodeKind::Instance {
        diagnostics.push(Diagnostic::unsupported(
            Some(id),
            Some("component"),
            "Component instance must be resolved before code export",
        ));
    }
    let mut body = String::new();
    if let Some(text) = text {
        if jsx {
            let fallback = serde_json::to_string(node.string("text").unwrap_or_default())
                .map_err(|e| ExportError::Invalid(e.to_string()))?;
            body.push_str(&format!("{{{text} ?? {fallback}}}"));
        } else if leptos {
            body.push_str(&format!("{{{text}}}"));
        }
    } else if let Some(runs) = node
        .properties
        .get("textRuns")
        .and_then(Value::as_array)
        .filter(|v| !v.is_empty())
    {
        let mut combined = String::new();
        for run in runs {
            let text = run
                .get("text")
                .and_then(Value::as_str)
                .ok_or_else(|| ExportError::Invalid("rich text run missing text".into()))?;
            combined.push_str(text);
            let mut run_node = Node::new(NodeKind::Text);
            if let Some(attributes) = run.get("attributes").and_then(Value::as_object) {
                run_node
                    .properties
                    .extend(attributes.iter().map(|(k, v)| (k.clone(), v.clone())));
                if attributes.get("bold") == Some(&json!(true)) {
                    run_node.properties.insert("fontWeight".into(), json!(700));
                }
                if attributes.get("italic") == Some(&json!(true)) {
                    run_node
                        .properties
                        .insert("fontStyle".into(), json!("italic"));
                }
                if attributes.get("underline") == Some(&json!(true)) {
                    run_node
                        .properties
                        .insert("textDecoration".into(), json!("underline"));
                }
                if attributes.get("strikethrough") == Some(&json!(true)) {
                    run_node.properties.insert(
                        "textDecoration".into(),
                        json!(if attributes.get("underline") == Some(&json!(true)) {
                            "underline line-through"
                        } else {
                            "line-through"
                        }),
                    );
                }
            }
            run_node.properties.insert("tag".into(), json!("span"));
            let styles = authored_style(&run_node);
            let style = if jsx {
                format!(
                    " style={{{}}}",
                    serde_json::to_string(
                        &styles
                            .iter()
                            .map(|(k, v)| (camel(k), v.clone()))
                            .collect::<BTreeMap<_, _>>()
                    )
                    .map_err(|e| ExportError::Invalid(e.to_string()))?
                )
            } else {
                format!(
                    " style=\"{}\"",
                    escape(
                        &styles
                            .iter()
                            .map(|(k, v)| format!("{k}:{v}"))
                            .collect::<Vec<_>>()
                            .join(";")
                    )
                )
            };
            let text = if leptos {
                format!("{{{text:?}}}")
            } else if jsx {
                format!(
                    "{{{}}}",
                    serde_json::to_string(text).map_err(|e| ExportError::Invalid(e.to_string()))?
                )
            } else {
                escape(text)
            };
            body.push_str(&format!("<span{style}>{text}</span>"));
        }
        if node.properties.get("text").and_then(Value::as_str) != Some(combined.as_str()) {
            return Err(ExportError::Invalid(
                "rich runs differ from canonical text".into(),
            ));
        }
    } else if let Some(text) = node.properties.get("text").and_then(Value::as_str) {
        body.push_str(&if leptos {
            format!("{{{text:?}}}")
        } else if jsx {
            format!(
                "{{{}}}",
                serde_json::to_string(text).map_err(|e| ExportError::Invalid(e.to_string()))?
            )
        } else {
            escape(text)
        });
    }
    let mut children: Vec<_> = snapshot
        .nodes
        .values()
        .filter(|n| n.parent_id.as_deref() == Some(id))
        .collect();
    children.sort_by(|a, b| (&a.rank, &a.id).cmp(&(&b.rank, &b.id)));
    for child in children {
        body.push_str(&element(
            snapshot,
            &child.id,
            jsx,
            tailwind,
            visiting,
            diagnostics,
            depth + 1,
            options,
        )?);
    }
    visiting.remove(id);
    let markup = format!("<{tag}{attrs}>{body}</{tag}>");
    if let Some(visible) = visible {
        if jsx {
            return Ok(format!(
                "{{({visible} ?? {}) && {markup}}}",
                node.properties.get("visible") != Some(&Value::Bool(false))
            ));
        }
        if leptos {
            return Ok(format!(
                "{{if {visible} {{ view! {{ {markup} }}.into_any() }} else {{ ().into_any() }}}}"
            ));
        }
    }
    Ok(markup)
}
fn authored_style(node: &Node) -> BTreeMap<String, String> {
    let mut result = BTreeMap::new();
    if let Some(style) = node.properties.get("style") {
        match style {
            Value::String(text) => {
                for decl in omc_style::parse_declarations(text) {
                    result.insert(
                        decl.name,
                        format!(
                            "{}{}",
                            decl.value,
                            if decl.important { " !important" } else { "" }
                        ),
                    );
                }
            }
            Value::Object(values) => {
                for (k, v) in values {
                    if let Some(value) = omc_style::css_value(v) {
                        result.insert(k.clone(), value);
                    }
                }
            }
            _ => (),
        }
    }
    let native = !node.properties.contains_key("tag");
    if native {
        result.entry("position".into()).or_insert_with(|| {
            if node.parent_id.is_none() || node.properties.get("codeFlow") == Some(&json!(true)) {
                "relative".into()
            } else {
                "absolute".into()
            }
        });
    }
    for (source, target, unit) in [
        ("x", "left", "px"),
        ("y", "top", "px"),
        ("width", "width", "px"),
        ("height", "height", "px"),
        (
            "fill",
            if node.kind == NodeKind::Text {
                "color"
            } else {
                "background-color"
            },
            "",
        ),
        ("stroke", "border-color", ""),
        ("strokeWidth", "border-width", "px"),
        ("fontFamily", "font-family", ""),
        ("fontSize", "font-size", "px"),
        ("fontWeight", "font-weight", ""),
        ("fontStyle", "font-style", ""),
        ("textDecoration", "text-decoration", ""),
        ("letterSpacing", "letter-spacing", "px"),
        ("lineHeight", "line-height", ""),
        ("textAlign", "text-align", ""),
        ("color", "color", ""),
        ("opacity", "opacity", ""),
        ("cornerRadius", "border-radius", "px"),
    ] {
        if let Some(v) = node.properties.get(source) {
            if let Some(value) = omc_style::css_value(v) {
                let value = if v.is_number() {
                    format!("{value}{unit}")
                } else {
                    value
                };
                result.insert(target.into(), value);
            }
        }
    }
    if result.contains_key("border-color") {
        result
            .entry("border-style".into())
            .or_insert_with(|| "solid".into());
    }
    if let Some(matrix) = node
        .properties
        .get("transform")
        .and_then(Value::as_array)
        .filter(|a| a.len() == 6)
    {
        result.insert(
            "transform".into(),
            format!(
                "matrix({})",
                matrix
                    .iter()
                    .filter_map(omc_style::css_value)
                    .collect::<Vec<_>>()
                    .join(",")
            ),
        );
        result.insert("transform-origin".into(), "0 0".into());
    } else {
        let mut transform = Vec::new();
        if let Some(rotation) = node
            .properties
            .get("rotation")
            .and_then(Value::as_f64)
            .filter(|v| *v != 0.)
        {
            transform.push(format!("rotate({rotation}deg)"));
        }
        let x = if node.properties.get("flipX") == Some(&json!(true)) {
            -1
        } else {
            1
        };
        let y = if node.properties.get("flipY") == Some(&json!(true)) {
            -1
        } else {
            1
        };
        if x != 1 || y != 1 {
            transform.push(format!("scale({x},{y})"));
        }
        if !transform.is_empty() {
            result.insert("transform".into(), transform.join(" "));
        }
    }
    if let Some(blur) = node
        .properties
        .get("blur")
        .and_then(Value::as_f64)
        .filter(|v| *v > 0.)
    {
        result.insert("filter".into(), format!("blur({blur}px)"));
    }
    if node.kind == NodeKind::Text {
        result
            .entry("white-space".into())
            .or_insert("pre-wrap".into());
    }
    if node.properties.get("visible") == Some(&Value::Bool(false)) {
        result.insert("display".into(), "none".into());
    }
    if node.properties.get("clipContent") == Some(&Value::Bool(true)) {
        result.insert("overflow".into(), "hidden".into());
    }
    result
}
fn safe_tag(tag: &str) -> bool {
    matches!(
        tag,
        "div"
            | "main"
            | "section"
            | "article"
            | "header"
            | "footer"
            | "nav"
            | "aside"
            | "h1"
            | "h2"
            | "h3"
            | "h4"
            | "h5"
            | "h6"
            | "p"
            | "span"
            | "strong"
            | "em"
            | "b"
            | "i"
            | "u"
            | "s"
            | "ul"
            | "ol"
            | "li"
            | "label"
            | "button"
            | "a"
            | "img"
            | "pre"
            | "code"
            | "blockquote"
    )
}
fn camel(value: &str) -> String {
    if value.starts_with("--") {
        return value.into();
    }
    let mut out = String::new();
    let mut upper = false;
    for c in value.chars() {
        if c == '-' {
            upper = true;
        } else if upper {
            out.push(c.to_ascii_uppercase());
            upper = false;
        } else {
            out.push(c);
        }
    }
    out
}
fn escape(input: &str) -> String {
    input
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn html_and_jsx_escape_text_without_freezing_percentages() {
        let mut c = DocumentContent::empty("<&Title>");
        let root = c.pages[0].root_node_id.clone();
        let mut text = Node::new(NodeKind::Text);
        text.parent_id = Some(root);
        text.properties
            .insert("text".into(), json!("<script>{danger}</script>"));
        text.properties
            .insert("style".into(), json!("width:50%;color:var(--accent)"));
        c.nodes.insert(text.id.clone(), text);
        let s = DocumentSnapshot {
            id: "doc_x".into(),
            title: c.title,
            epoch: "e".into(),
            sequence: 1,
            pages: c.pages,
            nodes: c.nodes,
            metadata: c.metadata,
        };
        let (html, _) = export_html(&s, None).unwrap();
        assert!(html.contains("width:50%"));
        assert!(!html.contains("<script>"));
        let (jsx, _) = export_react(&s, None, false).unwrap();
        assert!(jsx.contains("{\"<script>{danger}</script>\"}"));
        assert!(jsx.contains("\"width\":\"50%\""));
    }
}
