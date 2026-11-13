use super::*;
use omc_model::NodeKind;
use serde::{Deserialize, Serialize};
use skia_safe::{FontMgr, font_style::Slant};
use std::collections::BTreeSet;
use unicode_segmentation::UnicodeSegmentation;

pub(super) const COMMANDS: &[(&str, &str, bool, &str)] = &[
    (
        "text.onPath",
        "Text on path",
        true,
        "text?, path?, start?, flip?",
    ),
    (
        "text.pathOptions",
        "Text path options",
        true,
        "start?, flip?, ids?",
    ),
    ("text.removeFromPath", "Remove text from path", true, "ids?"),
    (
        "text.preview",
        "Preview a change",
        false,
        "command, params?",
    ),
    ("text.endPreview", "End text preview", false, ""),
    ("text.set", "Set text", true, "id?, characters | text"),
    (
        "text.style",
        "Style text range",
        true,
        "id?, start?, end?, fontFamily?, fontStyle?, fontWeight?, fontSize?, lineHeight?, letterSpacing?, textDecoration?, textDecorationStyle?, textDecorationThickness?, textDecorationColor?, textCase?, fontVariations?, hyperlink?, textFills?",
    ),
    ("text.caseOriginal", "Original case", true, "ids?"),
    ("text.caseUpper", "Uppercase", true, "ids?"),
    ("text.caseLower", "Lowercase", true, "ids?"),
    ("text.caseTitle", "Title case", true, "ids?"),
    ("text.caseSmallCaps", "Small caps", true, "ids?"),
    ("text.case", "Letter case", true, "case, ids?"),
    (
        "text.setVariations",
        "Variable font axes",
        true,
        "variations, replace?, id?/ids?",
    ),
    (
        "text.fit",
        "Fit text to its box",
        true,
        "ids?, maxLines?, minSize?, orphans?",
    ),
    ("text.bold", "Bold", true, "ids?"),
    ("text.italic", "Italic", true, "ids?"),
    ("text.underline", "Underline", true, "ids?"),
    ("text.strikethrough", "Strikethrough", true, "ids?"),
    ("text.link", "Create link", true, "url, ids?"),
    ("text.openLink", "Open link", false, ""),
    ("text.bulletList", "Bulleted list", true, "ids?"),
    ("text.numberList", "Numbered list", true, "ids?"),
    ("text.listStyle", "List style", true, "style | list, ids?"),
    ("text.listIndent", "Indent list", true, ""),
    ("text.listOutdent", "Outdent list", true, ""),
    (
        "text.paragraphIndent",
        "Paragraph indent",
        true,
        "indent, ids?",
    ),
    (
        "text.paragraphSpacing",
        "Paragraph spacing",
        true,
        "spacing, ids?",
    ),
    ("text.wrapStyle", "Wrap style", true, "style, ids?"),
    ("text.alignLeft", "Align left", true, "ids?"),
    ("text.alignCenter", "Align center", true, "ids?"),
    ("text.alignRight", "Align right", true, "ids?"),
    ("text.alignJustify", "Justify", true, "ids?"),
    ("text.sizeUp", "Increase font size", true, "ids?"),
    ("text.sizeDown", "Decrease font size", true, "ids?"),
    ("text.weightUp", "Increase font weight", true, "ids?"),
    ("text.weightDown", "Decrease font weight", true, "ids?"),
    ("text.lineHeightUp", "Increase line height", true, "ids?"),
    ("text.lineHeightDown", "Decrease line height", true, "ids?"),
    ("text.trackingUp", "Increase letter spacing", true, "ids?"),
    ("text.trackingDown", "Decrease letter spacing", true, "ids?"),
    ("text.decoration", "Decoration", true, "decoration, ids?"),
    ("text.direction", "Text direction", true, "direction, ids?"),
    ("text.directionAuto", "Text direction: auto", true, "ids?"),
    (
        "text.directionLtr",
        "Text direction: left to right",
        true,
        "ids?",
    ),
    (
        "text.directionRtl",
        "Text direction: right to left",
        true,
        "ids?",
    ),
    ("text.maxLines", "Max lines", true, "lines, ids?"),
    (
        "text.setFeatures",
        "OpenType features",
        true,
        "features, replace?, id?/ids?",
    ),
    ("text.edit.begin", "Edit text", false, "id, caret?"),
    ("text.edit.insert", "Type text", true, "text"),
    ("text.edit.key", "Text key", true, "key, shift?, alt?, cmd?"),
    ("text.edit.caret", "Set caret", false, "index, extend?"),
    ("text.edit.selectWord", "Select word", false, "index"),
    ("text.edit.selectLine", "Select line", false, "index"),
    (
        "text.edit.preedit",
        "Compose text (IME)",
        false,
        "text, cursor?",
    ),
    ("text.edit.selection", "Text selection", false, ""),
    ("text.edit.end", "Stop editing text", false, ""),
    ("font.download", "Download font", true, "family"),
    ("font.downloads", "Font downloads", false, ""),
    ("text.loadFont", "Load font file", true, "path | data"),
    ("text.rescanFonts", "Rescan installed fonts", true, ""),
    ("text.refit", "Fit text to fonts", true, "ids?"),
    (
        "text.fonts",
        "List fonts",
        false,
        "family?, style?, features?, axes?",
    ),
    ("text.missingFonts", "Missing fonts", false, ""),
];

const MAX_FONT_FILE: usize = 16 * 1024 * 1024;

#[derive(Default)]
pub(crate) struct SessionFonts {
    files: BTreeMap<String, LoadedFont>,
    system: Option<BTreeMap<String, usize>>,
    measured: BTreeMap<String, (String, u64, BTreeMap<String, [f64; 2]>)>,
}

struct LoadedFont {
    bytes: usize,
    faces: Vec<skia_safe::Typeface>,
}

fn provider(fonts: Option<&SessionFonts>, profile: &std::path::Path) -> Option<FontMgr> {
    let installed = omc_text::profile_font_manager(profile);
    let Some(fonts) = fonts.filter(|fonts| !fonts.files.is_empty()) else {
        return installed;
    };
    let mut provider = skia_safe::textlayout::TypefaceFontProvider::new();
    for font in fonts.files.values() {
        for face in &font.faces {
            provider.register_typeface(face.clone(), None);
        }
    }
    if let Some(installed) = installed {
        for family in installed.family_names() {
            let mut styles = installed.match_family(&family);
            for index in 0..styles.count() {
                if let Some(face) = styles.new_typeface(index) {
                    provider.register_typeface(face, None);
                }
            }
        }
    }
    Some(provider.into())
}

fn system_families() -> BTreeMap<String, usize> {
    let manager = FontMgr::default();
    manager
        .family_names()
        .map(|family| {
            let count = manager.match_family(&family).count();
            (family, count)
        })
        .collect()
}

fn family_managers() -> (FontMgr, Option<FontMgr>, FontMgr) {
    (
        FontMgr::default(),
        omc_text::session_fonts(),
        omc_text::bundled_font_manager(),
    )
}

#[derive(Serialize, Deserialize)]
struct Edit {
    node: String,
    digest: String,
    caret: usize,
    anchor: usize,
    preedit: Option<Value>,
}

fn text_of(node: &Node) -> &str {
    node.string("text").unwrap_or_default()
}

fn text_digest(source: &str) -> String {
    use sha2::{Digest, Sha256};
    hex::encode(Sha256::digest(source.as_bytes()))
}

fn character_to_byte(source: &str, offset: usize) -> usize {
    source
        .char_indices()
        .nth(offset)
        .map_or(source.len(), |(i, _)| i)
}

fn utf16_offset(source: &str, offset: usize) -> u32 {
    source[..character_to_byte(source, offset)]
        .encode_utf16()
        .count() as u32
}

fn index(value: &Value, field: &str, default: usize, max: usize) -> Result<usize> {
    match value.get(field) {
        None => Ok(default),
        Some(value) => value
            .as_u64()
            .map(|number| (number as usize).min(max))
            .ok_or_else(|| EngineError::invalid(format!("{field} must be a nonnegative integer"))),
    }
}

fn number(value: &Value, field: &str, min: f64, max: f64) -> Result<f64> {
    value
        .as_f64()
        .filter(|n| (min..=max).contains(n))
        .ok_or_else(|| EngineError::invalid(format!("{field} must be between {min} and {max}")))
}

fn format_length(value: &Value, field: &str, min: f64, max: f64) -> Result<Value> {
    if field == "lineHeight" && value == "auto" {
        return Ok(json!("normal"));
    }
    if let Some(percent) = value.as_str().and_then(|s| s.strip_suffix('%')) {
        let ratio = percent
            .parse::<f64>()
            .ok()
            .filter(|n| (min..=max).contains(n))
            .ok_or_else(|| EngineError::invalid(format!("invalid {field} percentage")))?;
        return Ok(json!(format!("{}em", ratio / 100.)));
    }
    Ok(json!(format!("{}px", number(value, field, min, max)?)))
}

fn value_in<'a>(value: &'a Value, field: &str, options: &[&str]) -> Result<&'a str> {
    value
        .as_str()
        .filter(|s| options.contains(s))
        .ok_or_else(|| {
            EngineError::invalid(format!("{field} must be one of {}", options.join(", ")))
        })
}

fn decoration(value: &Value) -> Result<Value> {
    Ok(json!(match value_in(
        value,
        "decoration",
        &["none", "underline", "strikethrough", "line-through"]
    )? {
        "strikethrough" => "line-through",
        value => value,
    }))
}

fn hyperlink(value: &Value) -> Result<Value> {
    if value.is_null() || value == "" {
        return Ok(json!(""));
    }
    let url = value
        .as_str()
        .filter(|s| s.len() <= 4096 && !s.chars().any(char::is_control))
        .ok_or_else(|| EngineError::invalid("invalid hyperlink"))?;
    Ok(json!(url))
}

fn letter_case(value: &Value) -> Result<&str> {
    value_in(
        value,
        "case",
        &["original", "upper", "lower", "title", "smallCaps"],
    )
}

fn map_tags(value: &Value, current: Option<&Value>, variations: bool) -> Result<Value> {
    let updates = value
        .as_object()
        .ok_or_else(|| EngineError::invalid("OpenType settings must be an object"))?;
    let mut merged = current
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    for (tag, value) in updates {
        if tag.len() != 4
            || !tag
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b' ')
        {
            return Err(EngineError::invalid(
                "OpenType tags require four ASCII characters",
            ));
        }
        if value.is_null() {
            merged.remove(tag);
        } else if variations {
            merged.insert(
                tag.clone(),
                json!(number(value, "axis value", -65536., 65536.)?),
            );
        } else if value.is_boolean() {
            merged.insert(tag.clone(), value.clone());
        } else {
            return Err(EngineError::invalid(
                "OpenType feature values must be boolean or null",
            ));
        }
    }
    Ok(Value::Object(merged))
}

fn style_fields(params: &Value) -> Result<Properties> {
    let mut patch = Properties::new();
    for (key, value) in params
        .as_object()
        .ok_or_else(|| EngineError::invalid("parameters must be an object"))?
    {
        let value = match key.as_str() {
            "id" | "ids" | "start" | "end" => continue,
            "fontFamily" => json!(
                value
                    .as_str()
                    .filter(|s| !s.trim().is_empty() && s.len() <= 1024)
                    .ok_or_else(|| EngineError::invalid("fontFamily must name a font"))?
            ),
            "fontStyle" => {
                let (weight, slant) = super::fig_font_style(value)?;
                patch.entry("fontWeight".into()).or_insert(json!(weight));
                json!(slant)
            }
            "fontWeight" => json!(number(value, key, 1., 1000.)?.round() as u16),
            "fontSize" => json!(number(value, key, 1., 5000.)?),
            "lineHeight" => format_length(value, key, 0., 10000.)?,
            "letterSpacing" => format_length(value, key, -10000., 10000.)?,
            "textDecoration" => decoration(value)?,
            "textDecorationStyle" => json!(value_in(
                value,
                key,
                &["solid", "double", "dashed", "dotted", "wavy"]
            )?),
            "textDecorationThickness" => json!(number(value, key, 0., 1000.)?),
            "textDecorationColor" => json!(color(value)?),
            "textCase" => json!(letter_case(value)?),
            "fontVariations" | "variationSettings" => {
                patch.insert("fontVariations".into(), map_tags(value, None, true)?);
                continue;
            }
            "hyperlink" => {
                patch.insert("link".into(), hyperlink(value)?);
                continue;
            }
            "textFills" => {
                let fills = value
                    .as_array()
                    .filter(|fills| fills.len() == 1)
                    .ok_or_else(|| EngineError::invalid("textFills requires one solid paint"))?;
                let fill = &fills[0];
                if fill["type"] != "solid" && fill["type"] != "SOLID" {
                    return Err(EngineError::invalid("textFills requires a solid paint"));
                }
                let paint = color(&fill["color"])?;
                let alpha = fill
                    .get("opacity")
                    .map(|value| number(value, "paint opacity", 0., 1.))
                    .transpose()?
                    .unwrap_or(1.);
                let parsed = omc_style::parse_color(paint).unwrap();
                patch.insert(
                    "fill".into(),
                    json!(format!(
                        "rgba({}, {}, {}, {})",
                        parsed.r * 255.,
                        parsed.g * 255.,
                        parsed.b * 255.,
                        f64::from(parsed.a) * alpha
                    )),
                );
                continue;
            }
            _ => {
                return Err(EngineError::new(
                    "unsupported_feature",
                    format!("text style property {key} is unavailable"),
                ));
            }
        };
        patch.insert(key.clone(), value);
    }
    Ok(patch)
}

fn color(value: &Value) -> Result<&str> {
    value
        .as_str()
        .filter(|s| omc_style::parse_color(s).is_some())
        .ok_or_else(|| EngineError::invalid("expected a CSS color"))
}

fn node_attribute<'a>(node: &'a Node, key: &str) -> Option<&'a Value> {
    node.properties.get(key).or_else(|| {
        let css = css_attribute(key);
        node.properties
            .get("style")
            .and_then(|style| style.get(css))
    })
}

fn css_attribute(key: &str) -> &str {
    match key {
        "fontWeight" => "font-weight",
        "fontSize" => "font-size",
        "fontStyle" => "font-style",
        "fontFamily" => "font-family",
        "lineHeight" => "line-height",
        "letterSpacing" => "letter-spacing",
        "textDecoration" => "text-decoration",
        _ => key,
    }
}

fn attribute<'a>(node: &'a Node, runs: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    runs.and_then(|values| {
        values
            .get(key)
            .or_else(|| values.get(css_attribute(key)))
            .filter(|value| !value.is_null())
    })
    .or_else(|| node_attribute(node, key))
}

fn font_number(value: Option<&Value>, default: f64) -> f64 {
    value
        .and_then(|v| {
            v.as_f64()
                .or_else(|| v.as_str()?.trim_end_matches("px").parse().ok())
        })
        .filter(|n| f64::is_finite(*n))
        .unwrap_or(default)
}

fn length(value: Option<&Value>, size: f64, default: f64, unitless_ratio: bool) -> f64 {
    if let Some(text) = value.and_then(Value::as_str) {
        if let Some(number) = text.strip_suffix("em").and_then(|s| s.parse::<f64>().ok()) {
            return number * size;
        }
        if let Some(number) = text.strip_suffix('%').and_then(|s| s.parse::<f64>().ok()) {
            return number * size / 100.;
        }
        if unitless_ratio && let Ok(ratio) = text.parse::<f64>() {
            return ratio * size;
        }
    }
    font_number(value, default)
}

fn text_runs(node: &Node) -> Vec<(usize, usize, Option<&Value>)> {
    if let Some(runs) = node
        .properties
        .get("textRuns")
        .and_then(Value::as_array)
        .filter(|runs| !runs.is_empty())
    {
        let mut offset = 0;
        return runs
            .iter()
            .map(|run| {
                let start = offset;
                offset += run["text"].as_str().unwrap_or_default().chars().count();
                (start, offset, run.get("attributes"))
            })
            .collect();
    }
    vec![(0, text_of(node).chars().count(), None)]
}

fn allow_text(node: &Node) -> Result<()> {
    if node.kind != NodeKind::Text {
        return Err(EngineError::invalid("target is not a text layer"));
    }
    if node.properties.get("locked") == Some(&Value::Bool(true)) {
        return Err(EngineError::invalid("text layer is locked"));
    }
    Ok(())
}

fn push_style(
    commands: &mut Vec<Command>,
    node: &Node,
    start: usize,
    end: usize,
    patch: Properties,
) {
    let source = text_of(node);
    if patch.is_empty() {
        return;
    }
    let full = start == 0 && end == source.chars().count();
    if full {
        commands.push(Command::NodeSet {
            node_id: node.id.clone(),
            properties: patch.clone(),
        });
    }
    if start < end
        && (!full
            || node
                .properties
                .get("textRuns")
                .and_then(Value::as_array)
                .is_some_and(|runs| {
                    runs.iter()
                        .any(|run| run["attributes"].as_object().is_some_and(|a| !a.is_empty()))
                }))
    {
        commands.push(Command::TextMark {
            node_id: node.id.clone(),
            start: utf16_offset(source, start),
            end: utf16_offset(source, end),
            attributes: patch,
        });
    }
}

pub(super) fn mark_selection_paint(
    node: &Node,
    range: &[Value],
    paint: &Value,
    commands: &mut Vec<Command>,
) -> Result<()> {
    allow_text(node)?;
    let source = text_of(node);
    let start = range[0].as_u64().unwrap() as usize;
    let end = range[1].as_u64().unwrap() as usize;
    if start >= end || end > source.chars().count() {
        return Err(EngineError::invalid(
            "selection paint range is outside the text",
        ));
    }
    let fill = paint
        .get("color")
        .and_then(Value::as_str)
        .and_then(omc_style::parse_color)
        .filter(|_| paint["type"] == "solid")
        .ok_or_else(|| {
            EngineError::new(
                "unsupported_feature",
                "a text range requires a solid foreground paint",
            )
        })?;
    let opacity = if paint["visible"] == false {
        0.
    } else {
        paint["opacity"].as_f64().unwrap_or(1.)
    };
    let fill = format!(
        "rgba({}, {}, {}, {})",
        fill.r * 255.,
        fill.g * 255.,
        fill.b * 255.,
        f64::from(fill.a) * opacity
    );
    commands.push(Command::TextMark {
        node_id: node.id.clone(),
        start: utf16_offset(source, start),
        end: utf16_offset(source, end),
        attributes: Properties::from([("fill".into(), json!(fill))]),
    });
    Ok(())
}

pub(super) struct FitText {
    pub(super) current: f64,
    pub(super) chosen: f64,
    lines: usize,
    fits: bool,
    orphan: bool,
}

pub(super) fn fit_text_node(
    node: &Node,
    item: &omc_scene::SceneItem,
    params: &Value,
) -> Result<FitText> {
    let limit = index(params, "maxLines", usize::MAX, 10000)?;
    let avoid_orphans = params["orphans"] != false;
    let text_width = item
        .text
        .as_ref()
        .map(|text| text.width)
        .filter(|w| *w > 0.)
        .ok_or_else(|| EngineError::invalid("text has no measurable width"))?;
    if !node.properties.contains_key("width") && !item.style.values.contains_key("width") {
        return Err(EngineError::invalid("fit requires a fixed text width"));
    }
    let height =
        if node.properties.contains_key("height") || item.style.values.contains_key("height") {
            item.height - item.text_offset.1
        } else {
            f64::INFINITY
        };
    let current = item
        .style
        .get("font-size")
        .and_then(|v| v.trim_end_matches("px").parse::<f64>().ok())
        .unwrap_or(16.)
        .clamp(1., 5000.);
    let min = params
        .get("minSize")
        .map(|value| number(value, "minSize", 1., current))
        .transpose()?
        .unwrap_or_else(|| (current * 0.6).max(1.));
    let source = text_of(node);
    let measure = |font_size: f64| -> Result<_> {
        let mut style = item.style.clone();
        style
            .values
            .insert("font-size".into(), format!("{font_size}px"));
        style.values.remove("omc-max-lines");
        let mut runs = node.properties.get("textRuns").cloned();
        if let Some(runs) = runs.as_mut().and_then(Value::as_array_mut) {
            for run in runs {
                if let Some(attrs) = run["attributes"].as_object_mut() {
                    for key in ["fontSize", "font-size"] {
                        if let Some(value) = attrs.get_mut(key) {
                            *value = json!(font_number(Some(value), current) * font_size / current);
                        }
                    }
                }
            }
        }
        omc_text::measure_runs(source, runs.as_ref(), &style, text_width)
            .map_err(|error| EngineError::invalid(error.to_string()))
    };
    let fits = |metrics: &omc_text::TextMeasurement| {
        metrics.height <= height + 0.05 && metrics.line_count <= limit && !metrics.truncated
    };
    let mut lower = min;
    let mut upper = current;
    let mut chosen = current;
    let mut measured = measure(chosen)?;
    if !fits(&measured) || avoid_orphans && measured.orphan {
        let mut best = None;
        let mut best_with_orphan = None;
        for _ in 0..16 {
            let candidate = (lower + upper) * 0.5;
            let result = measure(candidate)?;
            if fits(&result) {
                best_with_orphan = Some((candidate, result));
                if avoid_orphans && result.orphan {
                    upper = candidate;
                } else {
                    best = Some((candidate, result));
                    lower = candidate;
                }
            } else {
                upper = candidate;
            }
            if upper - lower < 0.01 {
                break;
            }
        }
        (chosen, measured) = best.or(best_with_orphan).unwrap_or((min, measure(min)?));
    }
    Ok(FitText {
        current,
        chosen,
        lines: measured.line_count,
        fits: fits(&measured),
        orphan: measured.orphan,
    })
}

impl ToolRouter {
    pub(super) fn fig_text_command(
        &self,
        session: &str,
        snapshot: &DocumentSnapshot,
        state: &ViewState,
        selection: &[Value],
        name: &str,
        params: &Value,
    ) -> Result<Value> {
        if name.starts_with("text.edit.") || name == "text.openLink" {
            return self.fig_text_edit(session, snapshot, state, name, params);
        }
        if matches!(
            name,
            "text.loadFont" | "text.rescanFonts" | "text.refit" | "font.download"
        ) {
            return self.fig_font_command(session, Some((snapshot, state)), name, params);
        }
        if name == "text.missingFonts" {
            return Ok(self.fig_missing_fonts(session, snapshot));
        }
        if name == "text.onPath" {
            return self.fig_put_text_on_path(session, snapshot, state, selection, params);
        }
        let edit: Option<Edit> = serde_json::from_value(state.view["figTextEdit"].clone()).ok();
        let explicit: Vec<_> = match (params.get("id"), params.get("ids")) {
            (Some(id), None) => vec![id.clone()],
            (None, Some(ids)) => ids
                .as_array()
                .cloned()
                .ok_or_else(|| EngineError::invalid("ids must be an array"))?,
            (None, None) => selection.to_vec(),
            _ => return Err(EngineError::invalid("provide either id or ids")),
        };
        let use_edit = edit.is_some()
            && params.get("id").is_none()
            && params.get("ids").is_none()
            && !matches!(name, "text.set" | "text.style");
        let targets = if use_edit {
            vec![edit.as_ref().unwrap().node.clone()]
        } else {
            self.fig_layers(session, snapshot, &explicit)?
        };
        if targets.is_empty() {
            return Err(EngineError::invalid("select one or more text layers"));
        }
        let strict_target = matches!(name, "text.set" | "text.style");
        let mut ids = BTreeSet::new();
        for target in targets {
            if strict_target {
                ids.insert(target);
                continue;
            }
            let mut pending = vec![target];
            while let Some(id) = pending.pop() {
                if snapshot
                    .nodes
                    .get(&id)
                    .is_some_and(|node| node.kind == NodeKind::Text)
                {
                    ids.insert(id.clone());
                }
                pending.extend(
                    children(snapshot, &id)
                        .into_iter()
                        .map(|node| node.id.clone()),
                );
            }
        }
        let range = |node: &Node| -> Result<(usize, usize)> {
            let count = text_of(node).chars().count();
            if use_edit {
                let edit = edit.as_ref().unwrap();
                validate_edit(edit, node)?;
                if edit.anchor != edit.caret
                    || matches!(
                        name,
                        "text.bulletList"
                            | "text.numberList"
                            | "text.listStyle"
                            | "text.listIndent"
                            | "text.listOutdent"
                    )
                {
                    return Ok((edit.anchor.min(edit.caret), edit.anchor.max(edit.caret)));
                }
            }
            if name == "text.style" {
                let start = index(params, "start", 0, count)?;
                let end = index(params, "end", count, count)?;
                return Ok((start.min(end), start.max(end)));
            }
            Ok((0, count))
        };
        let mut text = Vec::new();
        for id in &ids {
            let node = snapshot
                .nodes
                .get(id)
                .ok_or_else(|| EngineError::invalid("text layer no longer exists"))?;
            allow_text(node)?;
            let (start, end) = range(node)?;
            text.push((node, start, end));
        }
        if matches!(
            name,
            "text.bulletList"
                | "text.numberList"
                | "text.listStyle"
                | "text.listIndent"
                | "text.listOutdent"
        ) {
            if matches!(name, "text.listIndent" | "text.listOutdent") && !use_edit {
                return Err(EngineError::invalid(
                    "begin editing text before changing list nesting",
                ));
            }
            return self.fig_text_list(session, snapshot, name, params, &text);
        }
        if matches!(name, "text.pathOptions" | "text.removeFromPath") {
            let mut commands = Vec::new();
            for (node, _, _) in text {
                let Some(mut path) = node.properties.get("textPath").cloned() else {
                    continue;
                };
                if name == "text.removeFromPath" {
                    commands.push(Command::NodeUnset {
                        node_id: node.id.clone(),
                        properties: vec!["textPath".into(), "width".into(), "height".into()],
                    });
                    continue;
                }
                if let Some(start) = params.get("start") {
                    path["start"] = json!(number(start, "start", 0., 1.)?);
                }
                if let Some(flip) = params.get("flip") {
                    path["flip"] = json!(
                        flip.as_bool()
                            .ok_or_else(|| EngineError::invalid("flip must be a boolean"))?
                    );
                }
                commands.push(Command::NodeSet {
                    node_id: node.id.clone(),
                    properties: Properties::from([("textPath".into(), path)]),
                });
            }
            self.submit_text(session, snapshot, commands)?;
            return Ok(json!({"ok":true}));
        }
        if name == "text.fit" {
            return self.fig_fit_text(
                session,
                snapshot,
                state,
                params,
                text.into_iter().map(|(node, _, _)| node),
            );
        }
        let mut commands = Vec::new();
        if name == "text.set" {
            let replacement = params["characters"]
                .as_str()
                .or_else(|| params["text"].as_str())
                .ok_or_else(|| EngineError::invalid("characters required"))?;
            for (node, _, _) in text {
                commands.push(Command::TextReplace {
                    node_id: node.id.clone(),
                    text: replacement.into(),
                });
            }
        } else if name == "text.style" {
            let patch = style_fields(params)?;
            for (node, start, end) in text {
                push_style(&mut commands, node, start, end, patch.clone());
            }
        } else {
            let toggle = match name {
                "text.bold" => Some(("fontWeight", json!(700))),
                "text.italic" => Some(("fontStyle", json!("italic"))),
                "text.underline" => Some(("textDecoration", json!("underline"))),
                "text.strikethrough" => Some(("textDecoration", json!("line-through"))),
                _ => None,
            };
            let off = toggle.as_ref().is_some_and(|(key, value)| {
                text.iter().all(|(node, start, end)| {
                    text_runs(node)
                        .into_iter()
                        .filter(|(a, b, _)| a < end && b > start || start == end)
                        .all(|(_, _, run)| {
                            let current = attribute(node, run, key);
                            if *key == "fontWeight" {
                                font_number(current, 400.) >= 700.
                            } else {
                                current == Some(value)
                            }
                        })
                })
            });
            for (node, start, end) in text {
                let runs = text_runs(node);
                let range_changes = name.starts_with("text.size")
                    || name.starts_with("text.weight")
                    || name.starts_with("text.lineHeight")
                    || name.starts_with("text.tracking")
                    || matches!(name, "text.setFeatures" | "text.setVariations");
                if range_changes && runs.len() > 1 {
                    for (from, to, attributes) in runs {
                        let (a, b) = (start.max(from), end.min(to));
                        if a < b {
                            let patch = self.typography_patch(
                                node,
                                attributes,
                                name,
                                params,
                                toggle.as_ref(),
                                off,
                            )?;
                            push_style(&mut commands, node, a, b, patch);
                        }
                    }
                } else {
                    let patch =
                        self.typography_patch(node, runs[0].2, name, params, toggle.as_ref(), off)?;
                    let (start, end) = if name.starts_with("text.align")
                        || name.starts_with("text.direction")
                        || matches!(
                            name,
                            "text.maxLines"
                                | "text.paragraphIndent"
                                | "text.paragraphSpacing"
                                | "text.wrapStyle"
                        ) {
                        (0, text_of(node).chars().count())
                    } else {
                        (start, end)
                    };
                    push_style(&mut commands, node, start, end, patch);
                }
            }
        }
        self.submit_text(session, snapshot, commands)?;
        Ok(json!({"ok":true}))
    }

    fn submit_text(
        &self,
        session: &str,
        snapshot: &DocumentSnapshot,
        commands: Vec<Command>,
    ) -> Result<()> {
        if !commands.is_empty() {
            self.submit(
                session,
                &snapshot.id,
                Command::Batch { commands },
                &Value::Null,
                Some(snapshot.sequence),
            )?;
        }
        Ok(())
    }

    fn typography_patch(
        &self,
        node: &Node,
        run: Option<&Value>,
        name: &str,
        params: &Value,
        toggle: Option<&(&str, Value)>,
        off: bool,
    ) -> Result<Properties> {
        let get = |key| attribute(node, run, key);
        if let Some((key, value)) = toggle {
            let off_value = match *key {
                "fontWeight" => json!(400),
                "fontStyle" => json!("normal"),
                _ => json!("none"),
            };
            return Ok(Properties::from([(
                (*key).into(),
                if off { off_value } else { value.clone() },
            )]));
        }
        let size = font_number(get("fontSize"), 16.).clamp(1., 5000.);
        let delta = if name.ends_with("Up") { 1. } else { -1. };
        let pair = match name {
            "text.link" => {
                let link = hyperlink(
                    params
                        .get("url")
                        .ok_or_else(|| EngineError::invalid("url required"))?,
                )?;
                let mut patch = Properties::from([("link".into(), link.clone())]);
                if get("textDecoration").is_none()
                    && link.as_str().is_some_and(|url| !url.is_empty())
                {
                    patch.insert("textDecoration".into(), json!("underline"));
                }
                return Ok(patch);
            }
            "text.alignLeft" => ("textAlign", json!("left")),
            "text.alignCenter" => ("textAlign", json!("center")),
            "text.alignRight" => ("textAlign", json!("right")),
            "text.alignJustify" => ("textAlign", json!("justify")),
            "text.sizeUp" | "text.sizeDown" => ("fontSize", json!((size + delta).clamp(1., 5000.))),
            "text.weightUp" | "text.weightDown" => {
                let weight = font_number(get("fontWeight"), 400.);
                let family = get("fontFamily")
                    .and_then(Value::as_str)
                    .unwrap_or("sans-serif");
                let italic = get("fontStyle").is_some_and(|v| v == "italic");
                (
                    "fontWeight",
                    json!(next_weight(family, weight, italic, delta).round() as u16),
                )
            }
            "text.lineHeightUp" | "text.lineHeightDown" => {
                let next =
                    (length(get("lineHeight"), size, size * 1.21, true).round() + delta).max(0.);
                ("lineHeight", json!(format!("{next}px")))
            }
            "text.trackingUp" | "text.trackingDown" => {
                let next = length(get("letterSpacing"), size, 0., false) / size + delta / 100.;
                ("letterSpacing", json!(format!("{next}em")))
            }
            "text.caseOriginal" => ("textCase", json!("original")),
            "text.caseUpper" => ("textCase", json!("upper")),
            "text.caseLower" => ("textCase", json!("lower")),
            "text.caseTitle" => ("textCase", json!("title")),
            "text.caseSmallCaps" => ("textCase", json!("smallCaps")),
            "text.case" => ("textCase", json!(letter_case(&params["case"])?)),
            "text.decoration" => ("textDecoration", decoration(&params["decoration"])?),
            "text.direction" => (
                "textDirection",
                json!(value_in(
                    &params["direction"],
                    "direction",
                    &["auto", "ltr", "rtl"]
                )?),
            ),
            "text.directionAuto" => ("textDirection", json!("auto")),
            "text.directionLtr" => ("textDirection", json!("ltr")),
            "text.directionRtl" => ("textDirection", json!("rtl")),
            "text.paragraphIndent" => (
                "textParagraphIndent",
                json!(format!(
                    "{}px",
                    number(&params["indent"], "indent", 0., 10000.)?
                )),
            ),
            "text.paragraphSpacing" => (
                "textParagraphSpacing",
                json!(number(&params["spacing"], "spacing", 0., 10000.)?),
            ),
            "text.wrapStyle" => (
                "textWrapStyle",
                json!(value_in(
                    &params["style"],
                    "style",
                    &["auto", "balance", "pretty"]
                )?),
            ),
            "text.maxLines" => ("textMaxLines", json!(index(params, "lines", 0, 10000)?)),
            "text.setFeatures" | "text.setVariations" => {
                let variations = name.ends_with("Variations");
                let (input, key) = if variations {
                    ("variations", "fontVariations")
                } else {
                    ("features", "fontFeatures")
                };
                let current = if params["replace"] == true {
                    None
                } else {
                    get(key)
                };
                (key, map_tags(&params[input], current, variations)?)
            }
            _ => return Err(EngineError::invalid("unknown text command")),
        };
        Ok(Properties::from([(pair.0.into(), pair.1)]))
    }

    fn fig_put_text_on_path(
        &self,
        session: &str,
        snapshot: &DocumentSnapshot,
        state: &ViewState,
        selection: &[Value],
        params: &Value,
    ) -> Result<Value> {
        let selected = self.fig_layers(session, snapshot, selection)?;
        let named = |key: &str| {
            params
                .get(key)
                .map(|value| self.fig_layer(session, snapshot, value))
                .transpose()
        };
        let text = named("text")?
            .or_else(|| {
                selected
                    .iter()
                    .find(|id| snapshot.nodes[*id].kind == NodeKind::Text)
                    .cloned()
            })
            .ok_or_else(|| EngineError::invalid("choose a text layer"))?;
        let path = named("path")?
            .or_else(|| selected.iter().find(|id| **id != text).cloned())
            .ok_or_else(|| EngineError::invalid("choose a path or shape"))?;
        let text_node = &snapshot.nodes[&text];
        allow_text(text_node)?;
        let path_node = &snapshot.nodes[&path];
        if !matches!(
            path_node.kind,
            NodeKind::Path | NodeKind::Rect | NodeKind::Ellipse | NodeKind::Line | NodeKind::Frame
        ) {
            return Err(EngineError::invalid("layer has no usable text path"));
        }
        if !children(snapshot, &path).is_empty() {
            return Err(EngineError::invalid("choose a shape without child layers"));
        }
        let parent = path_node
            .parent_id
            .as_ref()
            .ok_or_else(|| EngineError::invalid("choose a shape below the page root"))?;
        let scene = paths::scene(snapshot, &state.page_id)?;
        if !paths::editable(&scene, &text) || !paths::editable(&scene, &path) {
            return Err(EngineError::invalid(
                "choose visible, unlocked layers on the active page",
            ));
        }
        let path_item = scene.item(&path).unwrap();
        let curve = omc_scene::shape_path(path_item)
            .ok_or_else(|| EngineError::invalid("layer has no usable text path"))?;
        if curve.count_verbs() > 20_000
            || skia_safe::PathMeasure::new(&curve, false, None).length() <= 0.
        {
            return Err(EngineError::invalid("path is empty or too complex"));
        }
        let start = params
            .get("start")
            .map(|value| number(value, "start", 0., 1.))
            .transpose()?
            .unwrap_or(0.);
        let flip = params
            .get("flip")
            .map(|value| {
                value
                    .as_bool()
                    .ok_or_else(|| EngineError::invalid("flip must be a boolean"))
            })
            .transpose()?
            .unwrap_or(false);
        let mut patch = Properties::from([
            (
                "textPath".into(),
                json!({"path":curve.to_svg(),"start":start,"flip":flip}),
            ),
            (
                "x".into(),
                json!(path_node.number("x", path_item.local.0[4])),
            ),
            (
                "y".into(),
                json!(path_node.number("y", path_item.local.0[5])),
            ),
            ("width".into(), json!(path_item.width)),
            ("height".into(), json!(path_item.height)),
        ]);
        let mut remove = Vec::new();
        for key in ["transform", "rotation", "flipX", "flipY"] {
            if let Some(value) = path_node.properties.get(key) {
                patch.insert(key.into(), value.clone());
            } else {
                remove.push(key.into());
            }
        }
        if let Some(fills) = path_item
            .properties
            .get("fills")
            .and_then(Value::as_array)
            .filter(|fills| {
                fills
                    .iter()
                    .any(|paint| paint["visible"] != false && paint["hidden"] != true)
            })
        {
            patch.insert("fills".into(), json!(fills));
            remove.push("fill".into());
        } else if let Some(fill) = path_item
            .properties
            .get("fill")
            .filter(|fill| fill.is_string() && *fill != "transparent")
        {
            patch.insert("fill".into(), fill.clone());
            remove.push("fills".into());
        }
        for key in ["effects", "shadows", "blur"] {
            if let Some(value) = path_item.properties.get(key) {
                patch.insert(key.into(), value.clone());
            }
        }
        self.submit_text(
            session,
            snapshot,
            vec![
                Command::NodeDelete {
                    node_ids: vec![path.clone()],
                },
                Command::NodeMove {
                    node_id: text.clone(),
                    parent_id: Some(parent.clone()),
                    rank: path_node.rank.clone(),
                },
                Command::NodeUnset {
                    node_id: text.clone(),
                    properties: remove,
                },
                Command::NodeSet {
                    node_id: text.clone(),
                    properties: patch,
                },
            ],
        )?;
        let alias = self.fig_alias(session, &snapshot.id, &text);
        self.fig_selection(&(session.into(), snapshot.id.clone()), &[json!(alias)]);
        Ok(json!({"id":alias}))
    }

    fn fig_text_list(
        &self,
        session: &str,
        snapshot: &DocumentSnapshot,
        name: &str,
        params: &Value,
        text: &[(&Node, usize, usize)],
    ) -> Result<Value> {
        let requested = match name {
            "text.bulletList" => Some("bulleted"),
            "text.numberList" => Some("numbered"),
            "text.listStyle" => Some(value_in(
                params
                    .get("style")
                    .or_else(|| params.get("list"))
                    .unwrap_or(&Value::Null),
                "style",
                &["none", "bulleted", "numbered"],
            )?),
            _ => None,
        };
        let is_toggle = matches!(name, "text.bulletList" | "text.numberList");
        let mut paragraphs = Vec::new();
        for &(node, start, end) in text {
            let chars = text_of(node).chars().collect::<Vec<_>>();
            let first = line(&chars, start).0;
            let last = line(&chars, if start < end { end - 1 } else { end }).1;
            let runs = text_runs(node);
            let mut current = first;
            loop {
                let stop = line(&chars, current).1;
                let attrs = runs
                    .iter()
                    .find(|(a, b, _)| *a <= current && current < *b)
                    .and_then(|(_, _, attrs)| *attrs);
                let style = attribute(node, attrs, "textListStyle")
                    .and_then(Value::as_str)
                    .unwrap_or("none");
                let depth = attribute(node, attrs, "textListDepth")
                    .and_then(Value::as_u64)
                    .unwrap_or(0)
                    .min(15);
                paragraphs.push((node, current, (stop + 1).min(chars.len()), style, depth));
                if stop >= last {
                    break;
                }
                current = stop + 1;
            }
        }
        let turn_off = is_toggle
            && requested.is_some_and(|style| paragraphs.iter().all(|entry| entry.3 == style));
        let mut commands = Vec::new();
        for (node, start, end, existing, depth) in paragraphs {
            let patch = if let Some(style) = requested {
                let style = if turn_off { "none" } else { style };
                if style == existing {
                    continue;
                }
                Properties::from([
                    ("textListStyle".into(), json!(style)),
                    (
                        "textListDepth".into(),
                        json!(if style == "none" { 0 } else { depth }),
                    ),
                ])
            } else {
                if existing == "none" {
                    continue;
                }
                let next = if name.ends_with("Outdent") {
                    depth.saturating_sub(1)
                } else {
                    (depth + 1).min(15)
                };
                if next == depth {
                    continue;
                }
                Properties::from([("textListDepth".into(), json!(next))])
            };
            if start == end && start != 0 {
                continue;
            }
            push_style(&mut commands, node, start, end, patch);
        }
        let changed = !commands.is_empty();
        self.submit_text(session, snapshot, commands)?;
        if requested.is_none() {
            Ok(json!({"changed":changed}))
        } else {
            Ok(json!({"ok":true}))
        }
    }

    fn fig_fit_text<'a>(
        &self,
        session: &str,
        snapshot: &DocumentSnapshot,
        state: &ViewState,
        params: &Value,
        nodes: impl Iterator<Item = &'a Node>,
    ) -> Result<Value> {
        let scene = paths::scene(snapshot, &state.page_id)?;
        let mut fitted = Vec::new();
        let mut commands = Vec::new();
        for node in nodes {
            let item = scene
                .item(&node.id)
                .ok_or_else(|| EngineError::invalid("text layer is outside the active page"))?;
            let FitText {
                current,
                chosen,
                lines,
                fits,
                orphan,
            } = fit_text_node(node, item, params)?;
            let source = text_of(node);
            if (current - chosen).abs() > 0.01 {
                for (start, end, attrs) in text_runs(node) {
                    if start == end {
                        continue;
                    }
                    if let Some(size) = attrs
                        .and_then(|attrs| attrs.get("fontSize").or_else(|| attrs.get("font-size")))
                    {
                        commands.push(Command::TextMark {
                            node_id: node.id.clone(),
                            start: utf16_offset(source, start),
                            end: utf16_offset(source, end),
                            attributes: Properties::from([
                                (
                                    "fontSize".into(),
                                    json!(font_number(Some(size), current) * chosen / current),
                                ),
                                (
                                    "font-size".into(),
                                    json!(font_number(Some(size), current) * chosen / current),
                                ),
                            ]),
                        });
                    }
                }
                commands.push(Command::NodeSet {
                    node_id: node.id.clone(),
                    properties: Properties::from([("fontSize".into(), json!(chosen))]),
                });
            }
            fitted.push(
                json!({"id":self.fig_alias(session,&snapshot.id,&node.id),"fontSize":chosen,
                "lines":lines,"fits":fits,"orphan":orphan}),
            );
        }
        self.submit_text(session, snapshot, commands)?;
        Ok(json!({"fitted":fitted}))
    }

    fn store_fig_edit(&self, session: &str, document: &str, edit: Option<Edit>) -> Result<()> {
        let mut states = self.states.lock().unwrap();
        let state = states
            .get_mut(&(session.into(), document.into()))
            .ok_or_else(|| EngineError::invalid("text edit session closed"))?;
        if !state.view.is_object() {
            state.view = json!({});
        }
        state.view["figTextEdit"] =
            serde_json::to_value(edit).map_err(|e| EngineError::invalid(e.to_string()))?;
        Ok(())
    }

    fn fig_text_edit(
        &self,
        session: &str,
        snapshot: &DocumentSnapshot,
        state: &ViewState,
        name: &str,
        params: &Value,
    ) -> Result<Value> {
        let key = &snapshot.id;
        if name == "text.edit.begin" {
            let id = self.fig_layer(session, snapshot, &params["id"])?;
            let node = &snapshot.nodes[&id];
            allow_text(node)?;
            let source = text_of(node);
            let count = source.chars().count();
            let caret = index(params, "caret", count, count)?;
            let anchor = if params.get("caret").is_some() {
                caret
            } else {
                0
            };
            self.store_fig_edit(
                session,
                key,
                Some(Edit {
                    node: id,
                    digest: text_digest(source),
                    caret,
                    anchor,
                    preedit: None,
                }),
            )?;
            return Ok(json!({"ok":true}));
        }
        if name == "text.edit.end" {
            self.store_fig_edit(session, key, None)?;
            return Ok(json!({"ok":true}));
        }
        let mut edit: Edit = match serde_json::from_value(state.view["figTextEdit"].clone()) {
            Ok(edit) => edit,
            Err(_) if name == "text.edit.selection" => return Ok(Value::Null),
            Err(_) => return Err(EngineError::invalid("no text is being edited")),
        };
        let node = snapshot
            .nodes
            .get(&edit.node)
            .ok_or_else(|| EngineError::invalid("text layer no longer exists"))?;
        validate_edit(&edit, node)?;
        let source = text_of(node);
        let count = source.chars().count();
        let (start, end) = (edit.anchor.min(edit.caret), edit.anchor.max(edit.caret));
        if name == "text.edit.selection" {
            return Ok(json!({
                "id":self.fig_alias(session,key,&edit.node),"caret":edit.caret,"anchor":edit.anchor,
                "text":&source[character_to_byte(source,start)..character_to_byte(source,end)],"preedit":edit.preedit
            }));
        }
        if name == "text.openLink" {
            let link_at = |position: usize| {
                text_runs(node)
                    .into_iter()
                    .find(|(from, to, _)| *from <= position && position < *to)
                    .and_then(|(_, _, attributes)| attribute(node, attributes, "link"))
                    .and_then(Value::as_str)
                    .filter(|link| !link.is_empty())
            };
            let link = link_at(start).or_else(|| start.checked_sub(1).and_then(link_at));
            if let Some(url) = link
                && !openable_url(url)
            {
                return Err(EngineError::invalid(
                    "only web and mail links can be opened",
                ));
            }
            return Ok(json!({"url":link}));
        }
        let mut splice = None;
        match name {
            "text.edit.insert" => splice = Some((start, end, string(params, "text")?.to_owned())),
            "text.edit.caret" => {
                edit.caret = index(params, "index", edit.caret, count)?;
                if params["extend"] != true {
                    edit.anchor = edit.caret;
                }
            }
            "text.edit.selectWord" | "text.edit.selectLine" => {
                let i = index(params, "index", edit.caret, count)?;
                let chars = source.chars().collect::<Vec<_>>();
                let (a, b) = if name.ends_with("Word") {
                    word(&chars, i)
                } else {
                    line(&chars, i)
                };
                edit.anchor = a;
                edit.caret = b;
            }
            "text.edit.preedit" => {
                let preedit = string(params, "text")?;
                edit.preedit = if preedit.is_empty() {
                    None
                } else {
                    let n = preedit.chars().count();
                    Some(json!({"text":preedit,"cursor":index(params,"cursor",n,n)?}))
                };
            }
            "text.edit.key" => {
                let pressed = string(params, "key")?;
                let chars = source.chars().collect::<Vec<_>>();
                let extend = params["shift"] == true;
                let jump = params["alt"] == true;
                let command = params["cmd"] == true;
                let i = edit.caret;
                let (line_start, line_end) = line(&chars, i);
                let prev_word = || word(&chars, i.saturating_sub(1)).0;
                let next_word = || word(&chars, i).1;
                let mut boundaries = vec![0];
                for grapheme in source.graphemes(true) {
                    boundaries
                        .push(boundaries.last().copied().unwrap_or(0) + grapheme.chars().count());
                }
                let previous = if command {
                    line_start
                } else if jump {
                    prev_word()
                } else {
                    boundaries
                        .iter()
                        .copied()
                        .rfind(|boundary| *boundary < i)
                        .unwrap_or(0)
                };
                let next = if command {
                    line_end
                } else if jump {
                    next_word()
                } else {
                    boundaries
                        .iter()
                        .copied()
                        .find(|boundary| *boundary > i)
                        .unwrap_or(count)
                };
                let movement = match pressed {
                    "Escape" => {
                        self.store_fig_edit(session, key, None)?;
                        return Ok(json!({"ok":true}));
                    }
                    "SelectAll" => {
                        edit.anchor = 0;
                        edit.caret = count;
                        None
                    }
                    "Left" | "ArrowLeft" => Some(if !extend && start != end {
                        start
                    } else {
                        previous
                    }),
                    "Right" | "ArrowRight" => {
                        Some(if !extend && start != end { end } else { next })
                    }
                    "Home" => Some(if command { 0 } else { line_start }),
                    "End" => Some(if command { count } else { line_end }),
                    "Up" | "ArrowUp" => {
                        let (a, b) = line(&chars, line_start.saturating_sub(1));
                        Some(if line_start == 0 {
                            0
                        } else {
                            (a + i - line_start).min(b)
                        })
                    }
                    "Down" | "ArrowDown" => {
                        let (a, b) = line(&chars, (line_end + 1).min(count));
                        Some(if line_end == count {
                            count
                        } else {
                            (a + i - line_start).min(b)
                        })
                    }
                    "Backspace" => {
                        splice = Some((
                            if start == end { previous } else { start },
                            end,
                            String::new(),
                        ));
                        None
                    }
                    "Delete" => {
                        splice =
                            Some((start, if start == end { next } else { end }, String::new()));
                        None
                    }
                    "Enter" => {
                        splice = Some((start, end, "\n".into()));
                        None
                    }
                    "Tab" => {
                        splice = Some((start, end, "\t".into()));
                        None
                    }
                    _ => return Err(EngineError::invalid("unknown text editing key")),
                };
                if let Some(next) = movement {
                    edit.caret = next;
                    if !extend {
                        edit.anchor = next;
                    }
                }
            }
            _ => return Err(EngineError::invalid("unknown text editing command")),
        }
        if let Some((start, end, replacement)) = splice {
            let mut commands = Vec::new();
            let start_units = utf16_offset(source, start);
            if start != end {
                commands.push(Command::TextDelete {
                    node_id: edit.node.clone(),
                    start: start_units,
                    end: utf16_offset(source, end),
                });
            }
            if !replacement.is_empty() {
                let attributes = text_runs(node)
                    .into_iter()
                    .find(|(a, b, _)| *a <= start && start < *b)
                    .or_else(|| text_runs(node).pop())
                    .and_then(|(_, _, a)| a)
                    .map(|a| properties(a))
                    .transpose()?
                    .unwrap_or_default();
                commands.push(Command::TextInsert {
                    node_id: edit.node.clone(),
                    offset: start_units,
                    text: replacement.clone(),
                    attributes,
                });
            }
            self.submit_text(session, snapshot, commands)?;
            let mut next = source.to_owned();
            next.replace_range(
                character_to_byte(source, start)..character_to_byte(source, end),
                &replacement,
            );
            edit.digest = text_digest(&next);
            edit.caret = start + replacement.chars().count();
            edit.anchor = edit.caret;
            edit.preedit = None;
        }
        self.store_fig_edit(session, key, Some(edit))?;
        Ok(json!({"ok":true}))
    }

    pub(super) fn fig_font_inventory(&self, session: &str, params: &Value) -> Result<Value> {
        if params.get("family").is_none() {
            self.fig_fonts
                .lock()
                .unwrap()
                .entry(session.into())
                .or_default()
                .system
                .get_or_insert_with(system_families);
        }
        fonts(params)
    }

    pub(super) fn fig_font_scope(&self, session: &str) -> omc_text::FontScope {
        let sessions = self.fig_fonts.lock().unwrap();
        omc_text::font_scope(provider(sessions.get(session), &self.workspace.profile))
    }

    pub(super) fn fig_font_command(
        &self,
        session: &str,
        document: Option<(&DocumentSnapshot, &ViewState)>,
        name: &str,
        params: &Value,
    ) -> Result<Value> {
        let before = document
            .map(|(snapshot, state)| automatic_sizes(snapshot, &state.page_id))
            .transpose()?
            .unwrap_or_default();
        if name == "font.download" {
            let family = params["family"]
                .as_str()
                .filter(|family| !family.trim().is_empty())
                .ok_or_else(|| EngineError::invalid("family must name a font"))?;
            let system = FontMgr::default();
            let bundled = omc_text::bundled_font_manager();
            let mut result = if system
                .family_names()
                .chain(bundled.family_names())
                .any(|name| name.eq_ignore_ascii_case(family.trim()))
            {
                json!({"family":family.trim(),"state":"installed"})
            } else {
                self.fig_font_downloads
                    .run(&self.workspace.profile, family)?
            };
            if let Some((snapshot, _)) = document {
                let fitted = self.remember_font_measurements(session, snapshot, &before, None);
                if result["state"] == "installed" {
                    result["refitted"] = json!(fitted);
                }
            } else if result["state"] == "installed" {
                result["refitted"] = json!([]);
            }
            return Ok(result);
        }
        if name == "text.refit" {
            let (snapshot, _) = document
                .ok_or_else(|| EngineError::invalid("open a document to refit its text"))?;
            let mut selected = None;
            if let Some(ids) = params.get("ids") {
                let ids = ids
                    .as_array()
                    .ok_or_else(|| EngineError::invalid("ids must be an array"))?;
                let mut pending = self.fig_layers(session, snapshot, ids)?;
                let mut included = BTreeSet::new();
                while let Some(node) = pending.pop() {
                    if included.insert(node.clone()) {
                        pending.extend(
                            children(snapshot, &node)
                                .into_iter()
                                .map(|child| child.id.clone()),
                        );
                    }
                }
                selected = Some(included);
            }
            let refitted =
                self.remember_font_measurements(session, snapshot, &before, selected.as_ref());
            return Ok(json!({"refitted":refitted}));
        }
        if name == "text.rescanFonts" {
            let system = system_families();
            let added = {
                let mut sessions = self.fig_fonts.lock().unwrap();
                let fonts = sessions.entry(session.to_owned()).or_default();
                let added = fonts
                    .system
                    .as_ref()
                    .map(|previous| {
                        system
                            .keys()
                            .filter(|family| !previous.contains_key(*family))
                            .cloned()
                            .collect::<Vec<_>>()
                    })
                    .unwrap_or_default();
                fonts.system = Some(system);
                added
            };
            let refitted = document
                .map(|(snapshot, _)| {
                    self.remember_font_measurements(session, snapshot, &before, None)
                })
                .unwrap_or_default();
            return Ok(json!({"added":added,"refitted":refitted}));
        }
        let bytes = match (params["data"].as_str(), params["path"].as_str()) {
            (Some(data), None) => {
                let encoded = data
                    .split_once(',')
                    .filter(|(header, _)| header.starts_with("data:"))
                    .map_or(data, |(_, data)| data);
                base64::engine::general_purpose::STANDARD
                    .decode(encoded.trim())
                    .map_err(|error| EngineError::invalid(format!("invalid font data: {error}")))?
            }
            (None, Some(path)) => resources::read_explicit(path, MAX_FONT_FILE)?,
            _ => return Err(EngineError::invalid("provide either path or base64 data")),
        };
        if bytes.is_empty() || bytes.len() > MAX_FONT_FILE {
            return Err(EngineError::invalid("font file is empty or exceeds 16 MiB"));
        }
        let count = omc_text::font_face_count(&bytes);
        if !(1..=64).contains(&count) {
            return Err(EngineError::invalid(
                "font collection has an invalid face count",
            ));
        }
        let id = {
            use sha2::{Digest, Sha256};
            hex::encode(Sha256::digest(&bytes))
        };
        let faces = (0..count)
            .map(|i| {
                FontMgr::default()
                    .new_from_data(&bytes, Some(i))
                    .ok_or_else(|| EngineError::invalid("font file cannot be decoded"))
            })
            .collect::<Result<Vec<_>>>()?;
        let families = faces
            .iter()
            .map(skia_safe::Typeface::family_name)
            .collect::<BTreeSet<_>>();
        let manager = {
            let mut sessions = self.fig_fonts.lock().unwrap();
            let total = sessions
                .values()
                .flat_map(|fonts| fonts.files.values())
                .map(|file| file.bytes)
                .sum::<usize>();
            let fonts = sessions.entry(session.to_owned()).or_default();
            if !fonts.files.contains_key(&id) {
                if fonts.files.len() >= 32 || total + bytes.len() > 64 * 1024 * 1024 {
                    return Err(EngineError::new(
                        "resource_limit",
                        "loaded font cache is full",
                    ));
                }
                fonts.files.insert(
                    id,
                    LoadedFont {
                        bytes: bytes.len(),
                        faces,
                    },
                );
            }
            if fonts.system.is_none() {
                fonts.system = Some(system_families());
            }
            provider(Some(fonts), &self.workspace.profile)
        };
        let _loaded = omc_text::font_scope(manager);
        let refitted = document
            .map(|(snapshot, state)| self.refitted(session, snapshot, state, &before))
            .transpose()?
            .unwrap_or_default();
        Ok(json!({"families":families,"refitted":refitted}))
    }

    fn remember_font_measurements(
        &self,
        session: &str,
        snapshot: &DocumentSnapshot,
        sizes: &BTreeMap<String, [f64; 2]>,
        selected: Option<&BTreeSet<String>>,
    ) -> Vec<u64> {
        let old = {
            let mut sessions = self.fig_fonts.lock().unwrap();
            let measurements = &mut sessions.entry(session.into()).or_default().measured;
            let key = snapshot.id.clone();
            if measurements.len() >= 32 && !measurements.contains_key(&key) {
                measurements.pop_first();
            }
            measurements.insert(
                key,
                (snapshot.epoch.clone(), snapshot.sequence, sizes.clone()),
            )
        };
        old.filter(|(epoch, sequence, _)| {
            epoch == &snapshot.epoch && *sequence == snapshot.sequence
        })
        .map(|(_, _, old)| {
            sizes
                .iter()
                .filter(|(id, _)| selected.is_none_or(|selected| selected.contains(*id)))
                .filter_map(|(id, size)| {
                    old.get(id)
                        .filter(|old| {
                            (old[0] - size[0]).abs() > 0.01 || (old[1] - size[1]).abs() > 0.01
                        })
                        .map(|_| self.fig_alias(session, &snapshot.id, id))
                })
                .collect()
        })
        .unwrap_or_default()
    }

    fn refitted(
        &self,
        session: &str,
        snapshot: &DocumentSnapshot,
        state: &ViewState,
        before: &BTreeMap<String, [f64; 2]>,
    ) -> Result<Vec<u64>> {
        let current = automatic_sizes(snapshot, &state.page_id)?;
        self.remember_font_measurements(session, snapshot, &current, None);
        Ok(current
            .into_iter()
            .filter_map(|(id, size)| {
                before
                    .get(&id)
                    .filter(|old| {
                        (old[0] - size[0]).abs() > 0.01 || (old[1] - size[1]).abs() > 0.01
                    })
                    .map(|_| self.fig_alias(session, &snapshot.id, &id))
            })
            .collect())
    }

    fn fig_missing_fonts(&self, session: &str, snapshot: &DocumentSnapshot) -> Value {
        let (manager, loaded, bundled) = family_managers();
        let installed = manager
            .family_names()
            .chain(loaded.iter().flat_map(FontMgr::family_names))
            .chain(bundled.family_names())
            .map(|s| s.to_lowercase())
            .collect::<BTreeSet<_>>();
        let mut missing: BTreeMap<String, BTreeSet<u64>> = BTreeMap::new();
        let mut add = |value: &Value, layer: Option<u64>| {
            if let Some(value) = value.as_str() {
                for family in value.split(',').map(|s| s.trim().trim_matches(['\'', '"'])) {
                    let lower = family.to_lowercase();
                    if !family.is_empty()
                        && !installed.contains(&lower)
                        && !matches!(
                            lower.as_str(),
                            "sans-serif"
                                | "serif"
                                | "monospace"
                                | "system-ui"
                                | "cursive"
                                | "fantasy"
                        )
                    {
                        let item = missing.entry(family.to_owned()).or_default();
                        item.extend(layer);
                    }
                }
            }
        };
        for node in snapshot
            .nodes
            .values()
            .filter(|node| node.kind == NodeKind::Text)
        {
            let alias = self.fig_alias(session, &snapshot.id, &node.id);
            if let Some(family) = node_attribute(node, "fontFamily") {
                add(family, Some(alias));
            }
            for (_, _, attrs) in text_runs(node) {
                if let Some(attrs) = attrs {
                    if let Some(family) =
                        attrs.get("fontFamily").or_else(|| attrs.get("font-family"))
                    {
                        add(family, Some(alias));
                    }
                }
            }
        }
        for (key, value) in &snapshot.metadata {
            if key.starts_with("styles/")
                && (key.ends_with("/fontFamily") || key.ends_with("/font-family"))
            {
                add(value, None);
            }
        }
        json!({"families":missing.into_iter().map(|(family,layers)|json!({"family":family,"layers":layers,"source":super::font_download::font_source(&family)})).collect::<Vec<_>>()})
    }
}

fn openable_url(url: &str) -> bool {
    let Some((scheme, value)) = url.split_once(':') else {
        return false;
    };
    if url.chars().any(|ch| ch.is_control() || ch.is_whitespace()) {
        return false;
    }
    if matches!(scheme.to_ascii_lowercase().as_str(), "http" | "https") {
        return value
            .strip_prefix("//")
            .and_then(|rest| rest.split(['/', '?', '#']).next())
            .is_some_and(|host| !host.is_empty() && !host.contains(['@', '\\']));
    }
    scheme.eq_ignore_ascii_case("mailto")
        && value
            .split('?')
            .next()
            .is_some_and(|address| !address.is_empty())
}

fn validate_edit(edit: &Edit, node: &Node) -> Result<()> {
    allow_text(node)?;
    if edit.digest != text_digest(text_of(node)) {
        return Err(EngineError::new(
            "revision_conflict",
            "text changed outside this editing session; begin editing again",
        ));
    }
    Ok(())
}

fn word(chars: &[char], i: usize) -> (usize, usize) {
    if chars.is_empty() {
        return (0, 0);
    }
    let i = i.min(chars.len() - 1);
    let kind = |c: char| {
        if c.is_alphanumeric() || c == '_' {
            0
        } else if c.is_whitespace() {
            1
        } else {
            2
        }
    };
    let k = kind(chars[i]);
    let start = chars[..i]
        .iter()
        .rposition(|c| kind(*c) != k)
        .map_or(0, |n| n + 1);
    let end = chars[i..]
        .iter()
        .position(|c| kind(*c) != k)
        .map_or(chars.len(), |n| i + n);
    (start, end)
}

fn line(chars: &[char], i: usize) -> (usize, usize) {
    let start = chars[..i]
        .iter()
        .rposition(|c| *c == '\n')
        .map_or(0, |n| n + 1);
    let end = chars[i..]
        .iter()
        .position(|c| *c == '\n')
        .map_or(chars.len(), |n| i + n);
    (start, end)
}

fn next_weight(family: &str, weight: f64, italic: bool, delta: f64) -> f64 {
    let fonts = FontMgr::default();
    let mut styles = fonts.match_family(family);
    let mut candidate = None::<f64>;
    for index in 0..styles.count() {
        let (style, _) = styles.style(index);
        if (style.slant() != Slant::Upright) != italic {
            continue;
        }
        let next = f64::from(*style.weight());
        if (next - weight) * delta > 0.
            && candidate.is_none_or(|old| (next - weight).abs() < (old - weight).abs())
        {
            candidate = Some(next);
        }
    }
    if styles.count() == 0 {
        (weight + 100. * delta).clamp(100., 900.)
    } else {
        candidate.unwrap_or(weight)
    }
}

fn fonts(params: &Value) -> Result<Value> {
    let (manager, loaded, bundled) = family_managers();
    let Some(family) = params["family"].as_str() else {
        let families = manager
            .family_names()
            .chain(loaded.iter().flat_map(FontMgr::family_names))
            .chain(bundled.family_names())
            .collect::<BTreeSet<_>>();
        return Ok(json!(families));
    };
    let manager = loaded
        .as_ref()
        .filter(|loaded| loaded.match_family(family).count() > 0)
        .or_else(|| (bundled.match_family(family).count() > 0).then_some(&bundled))
        .unwrap_or(&manager);
    let mut styles = manager.match_family(family);
    if params["features"] != true && params["axes"] != true {
        let names = (0..styles.count())
            .map(|i| font_style_name(&mut styles, i))
            .collect::<Vec<_>>();
        return Ok(json!(names));
    }
    let requested = params["style"].as_str().unwrap_or("Regular");
    let found = (0..styles.count())
        .find(|i| font_style_name(&mut styles, *i).eq_ignore_ascii_case(requested));
    let face = found.and_then(|i| styles.new_typeface(i)).or_else(|| {
        if requested.eq_ignore_ascii_case("regular") && styles.count() > 0 {
            manager.match_family_style(family, skia_safe::FontStyle::normal())
        } else {
            None
        }
    });
    if params["features"] == true {
        return Ok(json!(
            face.map(|face| omc_text::open_type_features(&face))
                .unwrap_or_default()
        ));
    }
    let Some(face) = face else {
        return Ok(Value::Null);
    };
    let axes=face.variation_design_parameters().unwrap_or_default().into_iter().map(|axis|{
        let tag=String::from_utf8_lossy(&axis.tag.to_be_bytes()).into_owned();
        json!({"tag":tag,"name":tag,"min":axis.min,"default":axis.def,"max":axis.max,"hidden":axis.is_hidden()})
    }).collect::<Vec<_>>();
    Ok(json!({"family":face.family_name(),"axes":axes,"instances":font_instances(&face)}))
}

fn be16(bytes: &[u8], offset: usize) -> Option<u16> {
    Some(u16::from_be_bytes(
        bytes.get(offset..offset + 2)?.try_into().ok()?,
    ))
}

fn font_style_name(styles: &mut skia_safe::FontStyleSet, index: usize) -> String {
    let (style, name) = styles.style(index);
    name.filter(|s| !s.is_empty()).unwrap_or_else(|| {
        let base = match *style.weight() {
            ..=150 => "Thin",
            151..=250 => "Extra Light",
            251..=350 => "Light",
            351..=450 => "Regular",
            451..=550 => "Medium",
            551..=650 => "Semi Bold",
            651..=750 => "Bold",
            751..=850 => "Extra Bold",
            _ => "Black",
        };
        if style.slant() == Slant::Upright {
            base.to_owned()
        } else if base == "Regular" {
            "Italic".into()
        } else {
            format!("{base} Italic")
        }
    })
}

fn font_instances(face: &skia_safe::Typeface) -> Vec<Value> {
    let Some(fvar) = face.copy_table_data(u32::from_be_bytes(*b"fvar")) else {
        return vec![];
    };
    let Some(names) = face.copy_table_data(u32::from_be_bytes(*b"name")) else {
        return vec![];
    };
    let bytes = fvar.as_bytes();
    let read = |offset| be16(bytes, offset).map(usize::from);
    let (Some(offset), Some(count), Some(axis_size), Some(instances), Some(instance_size)) =
        (read(4), read(8), read(10), read(12), read(14))
    else {
        return vec![];
    };
    if axis_size < 20 || instance_size < 4 + count * 4 || count > 64 || instances > 1024 {
        return vec![];
    }
    let tags = (0..count)
        .filter_map(|i| {
            std::str::from_utf8(bytes.get(offset + i * axis_size..offset + i * axis_size + 4)?).ok()
        })
        .collect::<Vec<_>>();
    if tags.len() != count {
        return vec![];
    }
    let first = offset + count * axis_size;
    (0..instances)
        .filter_map(|i| {
            let offset = first + i * instance_size;
            let name = font_name(names.as_bytes(), be16(bytes, offset)?)?;
            let mut values = BTreeMap::new();
            for (i, tag) in tags.iter().enumerate() {
                let start = offset + 4 + i * 4;
                let coordinate = i32::from_be_bytes(bytes.get(start..start + 4)?.try_into().ok()?);
                values.insert(*tag, f64::from(coordinate) / 65536.);
            }
            Some(json!({"name":name,"variations":values}))
        })
        .collect()
}

fn font_name(bytes: &[u8], name: u16) -> Option<String> {
    let count = usize::from(be16(bytes, 2)?);
    let start = usize::from(be16(bytes, 4)?);
    let mut fallback = None;
    for index in 0..count {
        let pos = 6 + index * 12;
        if be16(bytes, pos + 6)? != name {
            continue;
        }
        let platform = be16(bytes, pos)?;
        if !matches!(platform, 0 | 3) {
            continue;
        }
        let language = be16(bytes, pos + 4)?;
        let len = usize::from(be16(bytes, pos + 8)?);
        let offset = start + usize::from(be16(bytes, pos + 10)?);
        let codeunits = bytes
            .get(offset..offset + len)?
            .chunks_exact(2)
            .map(|chunk| u16::from_be_bytes([chunk[0], chunk[1]]))
            .collect::<Vec<_>>();
        let Ok(decoded) = String::from_utf16(&codeunits) else {
            continue;
        };
        if language == 0x409 {
            return Some(decoded);
        }
        fallback.get_or_insert(decoded);
    }
    fallback
}

fn automatic_sizes(snapshot: &DocumentSnapshot, page: &str) -> Result<BTreeMap<String, [f64; 2]>> {
    let scene = paths::scene(snapshot, page)?;
    Ok(scene
        .items
        .iter()
        .filter(|item| {
            item.kind == NodeKind::Text
                && (matches!(item.style.get("width"), None | Some("auto"))
                    || matches!(item.style.get("height"), None | Some("auto")))
        })
        .map(|item| (item.id.clone(), [item.width, item.height]))
        .collect())
}
