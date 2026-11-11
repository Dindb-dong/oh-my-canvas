use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Declaration {
    pub name: String,
    pub value: String,
    pub important: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Rule {
    pub id: String,
    pub selectors: Vec<String>,
    pub declarations: Vec<Declaration>,
    pub order: usize,
    pub min_width: Option<f64>,
    pub max_width: Option<f64>,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct StyleSheet {
    pub rules: Vec<Rule>,
    pub unsupported: Vec<String>,
}

/// Splits only outside quoted strings and balanced function/block delimiters.
pub fn split_top_level(source: &str, separator: char) -> Vec<&str> {
    let mut start = 0;
    let mut quote = None;
    let mut escaped = false;
    let mut depth = 0;
    let mut result = Vec::new();
    for (i, ch) in source.char_indices() {
        if escaped {
            escaped = false;
            continue;
        }
        if ch == '\\' {
            escaped = true;
            continue;
        }
        if let Some(q) = quote {
            if ch == q {
                quote = None;
            }
            continue;
        }
        match ch {
            '\'' | '"' => quote = Some(ch),
            '(' | '[' | '{' => depth += 1,
            ')' | ']' | '}' => depth -= 1,
            _ => (),
        }
        if ch == separator && depth == 0 {
            result.push(source[start..i].trim());
            start = i + ch.len_utf8();
        }
    }
    result.push(source[start..].trim());
    result
}

pub fn parse_declarations(source: &str) -> Vec<Declaration> {
    let cleaned = remove_comments(source);
    split_top_level(&cleaned, ';')
        .into_iter()
        .filter_map(|entry| {
            let (name, value) = entry.split_once(':')?;
            let name = name.trim();
            if name.is_empty() {
                return None;
            }
            let value = value.trim();
            let lower = value.to_ascii_lowercase();
            let important = lower.ends_with("!important");
            let value = if important {
                value[..value.len() - 10].trim()
            } else {
                value
            };
            Some(Declaration {
                name: if name.starts_with("--") {
                    name.into()
                } else {
                    name.to_ascii_lowercase()
                },
                value: value.into(),
                important,
            })
        })
        .collect()
}

pub fn parse_stylesheet(source: &str) -> StyleSheet {
    let mut result = StyleSheet::default();
    parse_rules(&remove_comments(source), None, None, &mut result, 0);
    result
}

fn parse_rules(
    source: &str,
    min_width: Option<f64>,
    max_width: Option<f64>,
    out: &mut StyleSheet,
    depth: usize,
) {
    if depth > 16 {
        out.unsupported.push("CSS nesting exceeds 16".into());
        return;
    }
    let mut cursor = 0;
    while cursor < source.len() {
        let Some(open) = source[cursor..].find('{').map(|i| i + cursor) else {
            break;
        };
        let prelude = source[cursor..open].trim();
        let mut count = 1;
        let mut quote = None;
        let mut escaped = false;
        let mut close = None;
        for (i, ch) in source[open + 1..].char_indices() {
            if escaped {
                escaped = false;
                continue;
            }
            if ch == '\\' {
                escaped = true;
                continue;
            }
            if let Some(q) = quote {
                if ch == q {
                    quote = None;
                }
                continue;
            }
            match ch {
                '\'' | '"' => quote = Some(ch),
                '{' => count += 1,
                '}' => {
                    count -= 1;
                    if count == 0 {
                        close = Some(open + 1 + i);
                        break;
                    }
                }
                _ => (),
            }
        }
        let Some(close) = close else {
            out.unsupported.push(prelude.into());
            break;
        };
        let body = &source[open + 1..close];
        if prelude.starts_with("@media") {
            let lower = prelude.to_ascii_lowercase();
            let min = media_width(&lower, "min-width")
                .map(|v| min_width.map_or(v, |old| old.max(v)))
                .or(min_width);
            let max = media_width(&lower, "max-width")
                .map(|v| max_width.map_or(v, |old| old.min(v)))
                .or(max_width);
            if (lower.contains("min-width") || lower.contains("max-width"))
                && !lower.contains(',')
                && !lower.contains("not ")
            {
                parse_rules(body, min, max, out, depth + 1);
            } else {
                out.unsupported.push(prelude.into());
            }
        } else if prelude.starts_with('@') {
            out.unsupported.push(prelude.into());
        } else {
            let order = out.rules.len();
            out.rules.push(Rule {
                id: format!("rule_{order}"),
                selectors: split_top_level(prelude, ',')
                    .into_iter()
                    .map(str::to_owned)
                    .collect(),
                declarations: parse_declarations(body),
                order,
                min_width,
                max_width,
            });
        }
        cursor = close + 1;
    }
}
fn media_width(input: &str, name: &str) -> Option<f64> {
    let part = input.split(name).nth(1)?.trim_start();
    let part = part.strip_prefix(':')?.trim_start();
    let value = part
        .split(')')
        .next()?
        .trim()
        .strip_suffix("px")?
        .trim()
        .parse::<f64>()
        .ok()?;
    value.is_finite().then_some(value)
}
fn remove_comments(input: &str) -> String {
    let mut result = String::with_capacity(input.len());
    let mut rest = input;
    while let Some(start) = rest.find("/*") {
        result.push_str(&rest[..start]);
        let Some(end) = rest[start + 2..].find("*/") else {
            return result;
        };
        rest = &rest[start + 2 + end + 2..];
    }
    result.push_str(rest);
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn data_url_and_quoted_delimiters_survive() {
        let d = parse_declarations(
            "background:url('data:image/svg+xml;a:b'); color: red!important; --Text: 'a;b:c'",
        );
        assert_eq!(d.len(), 3);
        assert!(d[1].important);
        assert_eq!(d[2].name, "--Text");
    }
    #[test]
    fn nested_media_is_intersected() {
        let s = parse_stylesheet(
            "@media (min-width: 390px) { .a{width:10px} @media(max-width:768px){.b{height:20px}}}",
        );
        assert_eq!(s.rules.len(), 2);
        assert_eq!(s.rules[1].min_width, Some(390.));
        assert_eq!(s.rules[1].max_width, Some(768.));
    }
}
