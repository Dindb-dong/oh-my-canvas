use crate::{Color, parse_color};
use omc_model::Properties;
use serde_json::{Value, json};

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum ColorProfile {
    #[default]
    Srgb,
    DisplayP3,
}

impl ColorProfile {
    pub fn parse(value: &str) -> Option<Self> {
        let normalized: String = value
            .chars()
            .filter(|ch| !matches!(ch, ' ' | '-' | '_'))
            .flat_map(char::to_lowercase)
            .collect();
        match normalized.as_str() {
            "srgb" => Some(Self::Srgb),
            "displayp3" | "p3" => Some(Self::DisplayP3),
            _ => None,
        }
    }

    pub fn from_metadata(metadata: &Properties) -> Self {
        metadata
            .get("colorProfile")
            .and_then(Value::as_str)
            .and_then(Self::parse)
            .unwrap_or_default()
    }

    pub const fn name(self) -> &'static str {
        match self {
            Self::Srgb => "srgb",
            Self::DisplayP3 => "displayP3",
        }
    }

    pub fn convert(self, target: Self, color: Color) -> Color {
        if self == target {
            return color;
        }
        // D65 primaries. Both profiles use the sRGB transfer function.
        let matrix = match self {
            Self::Srgb => [
                [0.822462, 0.177538, 0.0],
                [0.033194, 0.966806, 0.0],
                [0.017083, 0.072397, 0.910520],
            ],
            Self::DisplayP3 => [
                [1.224940, -0.224940, 0.0],
                [-0.042057, 1.042057, 0.0],
                [-0.019638, -0.078636, 1.098274],
            ],
        };
        let linear = [color.r, color.g, color.b].map(|channel| {
            if channel <= 0.04045 {
                channel / 12.92
            } else {
                ((channel + 0.055) / 1.055).powf(2.4)
            }
        });
        let [r, g, b] = matrix.map(|row| {
            let channel: f32 = row
                .iter()
                .zip(linear)
                .map(|(weight, value)| weight * value)
                .sum();
            if channel <= 0.0031308 {
                (12.92 * channel).max(0.)
            } else {
                (1.055 * channel.powf(1. / 2.4) - 0.055).min(1.)
            }
        });
        Color {
            r,
            g,
            b,
            a: color.a,
        }
    }
}

fn literal(color: Color) -> String {
    format!(
        "rgb({:.6} {:.6} {:.6} / {:.6})",
        color.r * 255.,
        color.g * 255.,
        color.b * 255.,
        color.a
    )
}

fn color_field(key: &str) -> bool {
    matches!(
        key,
        "fill"
            | "stroke"
            | "color"
            | "colors"
            | "documentColors"
            | "background"
            | "fillColor"
            | "strokeColor"
            | "backgroundColor"
            | "background-color"
            | "border-color"
            | "text-decoration-color"
            | "outline-color"
            | "flood-color"
            | "stop-color"
            | "accent-color"
    ) || key.ends_with("-color")
}

pub fn convert_style_color(
    key: &str,
    value: &str,
    from: ColorProfile,
    to: ColorProfile,
) -> Option<String> {
    if from == to {
        return None;
    }
    if color_field(key) || key.starts_with("--") {
        if let Some(color) = parse_color(value) {
            return Some(literal(from.convert(to, color)));
        }
    }
    if matches!(
        key,
        "background"
            | "background-image"
            | "box-shadow"
            | "text-shadow"
            | "filter"
            | "border"
            | "border-top"
            | "border-right"
            | "border-bottom"
            | "border-left"
    ) {
        let converted = convert_css_tokens(value, from, to, 0);
        return (converted != value).then_some(converted);
    }
    None
}

/// Converts literal colors in supported CSS shorthands without touching quoted content or URLs.
fn convert_css_tokens(value: &str, from: ColorProfile, to: ColorProfile, depth: usize) -> String {
    if depth >= 24 {
        return value.to_owned();
    }
    let mut cursor = 0;
    let mut output = String::with_capacity(value.len());
    while cursor < value.len() {
        let rest = &value[cursor..];
        let first = rest.chars().next().unwrap();
        let end = if first == '#' || first.is_ascii_alphabetic() || first == '-' {
            rest[1..]
                .find(|c: char| !(c.is_ascii_alphanumeric() || c == '-' || c == '_'))
                .map_or(rest.len(), |index| index + 1)
        } else if matches!(first, '\'' | '"') {
            quoted_end(rest, first)
        } else {
            first.len_utf8()
        };
        let mut length = end;
        let mut replacement = None;
        if matches!(first, '#' | 'a'..='z' | 'A'..='Z') {
            if rest[end..].starts_with('(') {
                if let Some(close) = function_end(&rest[end..]) {
                    length = end + close;
                    let function = &rest[..end];
                    if function.eq_ignore_ascii_case("url") || function.eq_ignore_ascii_case("var")
                    {
                        output.push_str(&rest[..length]);
                        cursor += length;
                        continue;
                    }
                    replacement = parse_color(&rest[..length])
                        .map(|color| literal(from.convert(to, color)))
                        .or_else(|| {
                            let body = &rest[end + 1..length - 1];
                            let converted = convert_css_tokens(body, from, to, depth + 1);
                            (converted != body).then(|| format!("{function}({converted})"))
                        });
                }
            } else {
                replacement =
                    parse_color(&rest[..length]).map(|color| literal(from.convert(to, color)));
            }
        }
        output.push_str(replacement.as_deref().unwrap_or(&rest[..length]));
        cursor += length;
    }
    output
}

fn quoted_end(value: &str, quote: char) -> usize {
    let mut escaped = false;
    for (index, ch) in value.char_indices().skip(1) {
        if !escaped && ch == quote {
            return index + 1;
        }
        escaped = ch == '\\' && !escaped;
    }
    value.len()
}

fn function_end(value: &str) -> Option<usize> {
    let mut depth = 0;
    let mut quote = None;
    let mut escaped = false;
    for (index, ch) in value.char_indices() {
        if escaped {
            escaped = false;
        } else if ch == '\\' {
            escaped = true;
        } else if let Some(delimiter) = quote {
            if ch == delimiter {
                quote = None;
            }
        } else if matches!(ch, '\'' | '"') {
            quote = Some(ch);
        } else if ch == '(' {
            depth += 1;
        } else if ch == ')' {
            depth -= 1;
            if depth == 0 {
                return Some(index + 1);
            }
        }
    }
    None
}

fn convert_css(source: &str, from: ColorProfile, to: ColorProfile, stylesheet: bool) -> String {
    let mut output = String::with_capacity(source.len());
    let mut start = 0;
    let mut colon = None;
    let mut depth = usize::from(!stylesheet);
    let mut cursor = 0;
    while cursor < source.len() {
        let rest = &source[cursor..];
        let ch = rest.chars().next().unwrap();
        let skipped = match ch {
            '\'' | '"' => quoted_end(rest, ch),
            '(' => function_end(rest).unwrap_or(rest.len()),
            '/' if rest.starts_with("/*") => rest[2..].find("*/").map_or(rest.len(), |end| end + 4),
            _ => ch.len_utf8(),
        };
        match ch {
            '{' => {
                output.push_str(&source[start..=cursor]);
                start = cursor + 1;
                colon = None;
                depth += 1;
            }
            ';' | '}' => {
                push_declaration(&mut output, source, start, cursor, colon, from, to);
                output.push(ch);
                start = cursor + 1;
                colon = None;
                if ch == '}' {
                    depth = depth.saturating_sub(1);
                }
            }
            ':' if depth != 0 && colon.is_none() => colon = Some(cursor),
            _ => {}
        }
        cursor += skipped;
    }
    push_declaration(&mut output, source, start, source.len(), colon, from, to);
    output
}

fn push_declaration(
    output: &mut String,
    source: &str,
    start: usize,
    end: usize,
    colon: Option<usize>,
    from: ColorProfile,
    to: ColorProfile,
) {
    if let Some(colon) = colon {
        let name = source[start..colon]
            .rsplit("*/")
            .next()
            .unwrap_or_default()
            .trim();
        let value = &source[colon + 1..end];
        let trimmed = value.trim();
        let body = trimmed
            .strip_suffix("!important")
            .map_or(trimmed, str::trim_end);
        if let Some(replacement) = convert_style_color(name, body, from, to) {
            let leading = value.len() - value.trim_start().len();
            output.push_str(&source[start..colon + 1 + leading]);
            output.push_str(&replacement);
            output.push_str(&value[leading + body.len()..]);
            return;
        }
    }
    output.push_str(&source[start..end]);
}

fn object_color(value: &mut Value, from: ColorProfile, to: ColorProfile) -> bool {
    let keys = if value.get("r").is_some() {
        ["r", "g", "b"]
    } else {
        ["red", "green", "blue"]
    };
    let channels = keys.map(|key| value.get(key).and_then(Value::as_f64));
    if let [Some(r), Some(g), Some(b)] = channels {
        let converted = from.convert(
            to,
            Color {
                r: r as f32,
                g: g as f32,
                b: b as f32,
                a: 1.,
            },
        );
        for (key, channel) in keys.into_iter().zip(converted.rgba()) {
            value[key] = json!(channel);
        }
        return true;
    }
    false
}

pub fn convert_color_property(key: &str, value: &mut Value, from: ColorProfile, to: ColorProfile) {
    if color_field(key)
        || matches!(
            key,
            "style"
                | "fills"
                | "strokes"
                | "effects"
                | "shadows"
                | "textRuns"
                | "layoutGrids"
                | "overrides"
                | "prototypeSettings"
        )
    {
        convert_property(key, value, from, to, false);
    }
}

pub fn convert_color_catalog_entry(
    key: &str,
    value: &mut Value,
    from: ColorProfile,
    to: ColorProfile,
) {
    let scope = key.starts_with("tokens/")
        && matches!(
            key.rsplit('/').next(),
            Some("value" | "values" | "modes" | "modeValues")
        );
    if scope
        || matches!(key, "css" | "documentColors")
        || key.starts_with("styles/") && key.ends_with("/value")
    {
        convert_property(key, value, from, to, scope);
    }
}

fn convert_property(
    key: &str,
    value: &mut Value,
    from: ColorProfile,
    to: ColorProfile,
    inherited_color: bool,
) {
    if from == to {
        return;
    }
    let color = inherited_color || color_field(key);
    if color && value.is_object() && object_color(value, from, to) {
        return;
    }
    match value {
        Value::String(source) => {
            let converted = match key {
                "style" => Some(convert_css(source, from, to, false)),
                "css" => Some(convert_css(source, from, to, true)),
                _ if color => parse_color(source)
                    .map(|value| literal(from.convert(to, value)))
                    .or_else(|| convert_style_color(key, source, from, to)),
                _ => convert_style_color(key, source, from, to),
            };
            if let Some(converted) = converted {
                *source = converted;
            }
        }
        Value::Array(entries) => {
            for entry in entries {
                convert_property(key, entry, from, to, color);
            }
        }
        Value::Object(entries) => {
            for (key, entry) in entries {
                if !key.starts_with('$') || matches!(key.as_str(), "$colorAlpha" | "$colorMix") {
                    convert_property(key, entry, from, to, inherited_color);
                }
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn css_conversion_retains_selectors_urls_and_non_color_content() {
        let source = "/* red */ #fff:hover { color: red !important; background: linear-gradient(#00ff00, blue), url(\"#fff\"); content: 'red'; }";
        let converted = convert_css(source, ColorProfile::Srgb, ColorProfile::DisplayP3, true);
        assert!(converted.starts_with("/* red */ #fff:hover { color: rgb("));
        assert!(converted.contains(" !important; background: linear-gradient(rgb("));
        assert!(converted.contains("), url(\"#fff\"); content: 'red';"));
        assert_ne!(converted, source);
    }

    #[test]
    fn color_calculations_convert_endpoints_without_rewriting_aliases() {
        let mut value =
            json!({"base":{"$colorMix":{"from":"#814e21","to":{"$token":"blue"},"t":0.5}}});
        convert_color_catalog_entry(
            "tokens/brand/modes",
            &mut value,
            ColorProfile::Srgb,
            ColorProfile::DisplayP3,
        );
        let mix = &value["base"]["$colorMix"];
        assert!(mix["from"].as_str().unwrap().starts_with("rgb("));
        assert_eq!(mix["to"], json!({"$token":"blue"}));
        assert_eq!(mix["t"], 0.5);
    }
}
