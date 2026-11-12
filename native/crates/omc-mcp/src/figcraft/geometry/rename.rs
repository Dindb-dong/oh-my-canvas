use super::*;
use regex::{Captures, RegexBuilder};

const MAX_NAME: usize = 10_000;

pub(super) fn plan(
    snapshot: &DocumentSnapshot,
    ids: &[String],
    params: &Value,
) -> Result<Vec<(String, String)>> {
    let option = |key| params.get(key).map(|_| string(params, key)).transpose();
    let find = option("find")?.unwrap_or("");
    let replace = option("replace")?.unwrap_or("");
    let template = option("name")?;
    if [find, replace, template.unwrap_or("")]
        .iter()
        .any(|text| text.chars().count() > 1000)
    {
        return Err(EngineError::invalid(
            "rename patterns are limited to 1000 characters",
        ));
    }
    let expression = (!find.is_empty())
        .then(|| {
            let literal;
            let pattern = if optional_flag(params, "regex")? == Some(true) {
                find
            } else {
                literal = regex::escape(find);
                &literal
            };
            RegexBuilder::new(pattern)
                .size_limit(1 << 20)
                .build()
                .map_err(|error| EngineError::invalid(format!("invalid match pattern: {error}")))
        })
        .transpose()?;
    let first = optional_number(params, "start")?
        .unwrap_or(1.)
        .clamp(0., 1e12)
        .round() as u64;
    let mut ranks = ids
        .iter()
        .map(|id| {
            let mut order = Vec::new();
            let mut node = Some(&snapshot.nodes[id]);
            while let Some(current) = node {
                order.push((current.rank.as_str(), current.id.as_str()));
                node = current
                    .parent_id
                    .as_ref()
                    .and_then(|parent| snapshot.nodes.get(parent));
            }
            order.reverse();
            (order, id)
        })
        .collect::<Vec<_>>();
    ranks.sort_unstable();
    Ok(ranks
        .into_iter()
        .enumerate()
        .map(|(index, (_, id))| {
            let old = snapshot.nodes[id].string("name").unwrap_or("");
            let numbers = (first + index as u64, first + (ids.len() - index - 1) as u64);
            let mut edited = String::new();
            let mut end = 0;
            if let Some(expression) = &expression {
                for capture in expression.captures_iter(old) {
                    let matched = capture.get(0).unwrap();
                    append(&mut edited, &old[end..matched.start()]);
                    expand(replace, old, Some(&capture), numbers, &mut edited);
                    end = matched.end();
                    if edited.len() >= MAX_NAME * 4 {
                        break;
                    }
                }
            }
            append(&mut edited, &old[end..]);
            if let Some(template) = template {
                let mut output = String::new();
                expand(template, &edited, None, numbers, &mut output);
                edited = output;
            }
            (id.clone(), edited.chars().take(MAX_NAME).collect())
        })
        .collect())
}

fn append(output: &mut String, text: &str) {
    let end = (MAX_NAME * 4 - output.len()).min(text.len());
    let end = text.floor_char_boundary(end);
    output.push_str(&text[..end]);
}

fn expand(
    pattern: &str,
    name: &str,
    capture: Option<&Captures<'_>>,
    (ascending, descending): (u64, u64),
    output: &mut String,
) {
    let mut chars = pattern.chars().peekable();
    let matched = capture.and_then(|group| group.get(0));
    while let Some(character) = chars.next() {
        if output.len() + 4 > MAX_NAME * 4 {
            break;
        }
        if character != '$' {
            output.push(character);
            continue;
        }
        match chars.peek().copied() {
            Some('&') => append(output, matched.map_or(name, |m| m.as_str())),
            Some('`') => append(output, matched.map_or("", |m| &name[..m.start()])),
            Some('\'') => append(output, matched.map_or("", |m| &name[m.end()..])),
            Some('$') => output.push('$'),
            Some(code @ ('n' | 'N')) => {
                let mut width = 0;
                while chars.peek() == Some(&code) {
                    chars.next();
                    width += 1;
                }
                let number = if code == 'n' { ascending } else { descending };
                append(output, &format!("{number:0width$}", width = width.min(12)));
                continue;
            }
            Some(code @ '1'..='9') => {
                let index = (code as u8 - b'0') as usize;
                if let Some(group) = capture.filter(|group| index < group.len()) {
                    append(output, group.get(index).map_or("", |m| m.as_str()));
                } else {
                    output.extend(['$', code]);
                }
            }
            _ => {
                output.push('$');
                continue;
            }
        }
        chars.next();
    }
}
