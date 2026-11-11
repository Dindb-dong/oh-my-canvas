use omc_model::{DocumentSnapshot, Node};

// Supported combinators are descendant and child. Unknown syntax is never treated as a match.
pub fn matches(
    selector: &str,
    node: &Node,
    snapshot: &DocumentSnapshot,
) -> Result<Option<u32>, ()> {
    let (tokens, specificity) = tokenize(selector)?;
    let mut position = tokens.len() - 1;
    let mut candidate = node;
    if !simple(&tokens[position], candidate, snapshot)? {
        return Ok(None);
    }
    while position > 0 {
        position -= 1;
        if tokens[position] == ">" {
            position -= 1;
            let Some(parent) = candidate
                .parent_id
                .as_ref()
                .and_then(|id| snapshot.nodes.get(id))
            else {
                return Ok(None);
            };
            if !simple(&tokens[position], parent, snapshot)? {
                return Ok(None);
            }
            candidate = parent;
        } else {
            let mut ancestor = candidate
                .parent_id
                .as_ref()
                .and_then(|id| snapshot.nodes.get(id));
            let mut found = None;
            let mut limit = 0;
            while let Some(n) = ancestor {
                limit += 1;
                if limit > snapshot.nodes.len() {
                    return Err(());
                }
                if simple(&tokens[position], n, snapshot)? {
                    found = Some(n);
                    break;
                }
                ancestor = n.parent_id.as_ref().and_then(|id| snapshot.nodes.get(id));
            }
            let Some(n) = found else {
                return Ok(None);
            };
            candidate = n;
        }
    }
    Ok(Some(specificity))
}
fn tokenize(input: &str) -> Result<(Vec<String>, u32), ()> {
    let mut result = Vec::new();
    let mut current = String::new();
    let mut close = None;
    let mut quote = None;
    let mut specificity = 0u32;
    for ch in input.chars() {
        if let Some(q) = quote {
            current.push(ch);
            if ch == q {
                quote = None;
            }
            continue;
        }
        if let Some(end) = close {
            match ch {
                c if c == end => close = None,
                '\'' | '"' if end == ']' => quote = Some(ch),
                '[' | ']' | '(' | ')' | '\'' | '"' => return Err(()),
                _ => (),
            }
            current.push(ch);
            continue;
        }
        if ch == '>' || ch.is_whitespace() {
            if !current.is_empty() {
                result.push(std::mem::take(&mut current));
            }
            if ch == '>' {
                if result.last().is_none_or(|token| token == ">") {
                    return Err(());
                }
                result.push(">".into());
            }
            continue;
        }
        let weight = match ch {
            '[' => {
                close = Some(']');
                100
            }
            '(' => {
                close = Some(')');
                0
            }
            '#' => 10000,
            '.' | ':' => 100,
            '+' | '~' | '|' | ']' | ')' | '\'' | '"' => return Err(()),
            c => u32::from(current.is_empty() && c.is_ascii_alphabetic()),
        };
        specificity = specificity.checked_add(weight).ok_or(())?;
        current.push(ch);
    }
    if close.is_some() || quote.is_some() {
        return Err(());
    }
    if !current.is_empty() {
        result.push(current);
    }
    if result.last().is_none_or(|token| token == ">") {
        return Err(());
    }
    Ok((result, specificity))
}
fn simple(input: &str, node: &Node, snapshot: &DocumentSnapshot) -> Result<bool, ()> {
    let bytes = input.as_bytes();
    let mut p = 0;
    if bytes.first() == Some(&b'*') {
        p = 1;
    } else if bytes.first().is_some_and(u8::is_ascii_alphabetic) {
        while p < bytes.len() && (bytes[p].is_ascii_alphanumeric() || bytes[p] == b'-') {
            p += 1;
        }
        let tag = node
            .properties
            .get("tag")
            .and_then(|v| v.as_str())
            .unwrap_or("div");
        if !tag.eq_ignore_ascii_case(&input[..p]) {
            return Ok(false);
        }
    }
    while p < bytes.len() {
        let marker = bytes[p];
        p += 1;
        if marker == b'.' || marker == b'#' {
            let start = p;
            while p < bytes.len()
                && (bytes[p].is_ascii_alphanumeric() || bytes[p] == b'_' || bytes[p] == b'-')
            {
                p += 1;
            }
            if start == p {
                return Err(());
            }
            let term = &input[start..p];
            let value = node
                .properties
                .get(if marker == b'.' { "class" } else { "htmlId" })
                .and_then(|v| v.as_str())
                .unwrap_or("");
            if if marker == b'.' {
                !value.split_whitespace().any(|v| v == term)
            } else {
                value != term
            } {
                return Ok(false);
            }
        } else if marker == b'[' {
            let start = p;
            let mut quote = None;
            let Some(end) = input[p..]
                .find(|ch| {
                    if let Some(q) = quote {
                        if ch == q {
                            quote = None;
                        }
                        false
                    } else {
                        if matches!(ch, '\'' | '"') {
                            quote = Some(ch);
                        }
                        ch == ']'
                    }
                })
                .map(|i| i + p)
            else {
                return Err(());
            };
            p = end + 1;
            let selector = input[start..end].trim();
            let (attribute, expected) = if let Some((attribute, value)) = selector.split_once('=') {
                let value = value.trim();
                let expected = match value.chars().next() {
                    Some(q @ ('\'' | '"')) => value
                        .strip_prefix(q)
                        .and_then(|s| s.strip_suffix(q))
                        .ok_or(())?,
                    Some(_) if !value.contains(char::is_whitespace) => value,
                    _ => return Err(()),
                };
                (attribute.trim(), Some(expected))
            } else {
                (selector, None)
            };
            if attribute.is_empty() || attribute.contains(['~', '|', '^', '$', '*']) {
                return Err(());
            }
            let value = node
                .properties
                .get("attributes")
                .and_then(|v| v.get(attribute))
                .and_then(|v| v.as_str());
            if value.is_none() || expected.is_some_and(|e| value != Some(e)) {
                return Ok(false);
            }
        } else if marker == b':' {
            let start = p;
            while p < bytes.len() && (bytes[p].is_ascii_alphabetic() || bytes[p] == b'-') {
                p += 1;
            }
            let pseudo = &input[start..p];
            let siblings = || {
                snapshot
                    .nodes
                    .values()
                    .filter(|n| n.parent_id == node.parent_id)
            };
            let key = (&node.rank, &node.id);
            let matched = match pseudo {
                "root" => node.parent_id.is_none(),
                "first-child" => siblings().all(|n| (&n.rank, &n.id) >= key),
                "last-child" => siblings().all(|n| (&n.rank, &n.id) <= key),
                "nth-child" => {
                    if bytes.get(p) != Some(&b'(') {
                        return Err(());
                    }
                    p += 1;
                    let Some(end) = input[p..].find(')').map(|i| i + p) else {
                        return Err(());
                    };
                    let expr = input[p..end].trim();
                    p = end + 1;
                    let index = siblings().filter(|n| (&n.rank, &n.id) < key).count() + 1;
                    nth_child(expr, index)?
                }
                _ => return Err(()),
            };
            if !matched {
                return Ok(false);
            }
        } else {
            return Err(());
        }
    }
    Ok(true)
}
fn nth_child(expr: &str, index: usize) -> Result<bool, ()> {
    if expr.eq_ignore_ascii_case("odd") {
        return Ok(index % 2 == 1);
    }
    if expr.eq_ignore_ascii_case("even") {
        return Ok(index % 2 == 0);
    }
    // shortcut: An+B uses 32-bit signed integers, expand if larger CSS integer literals are required.
    let Some((a, b)) = expr.split_once(['n', 'N']) else {
        return Ok(i128::from(expr.parse::<i32>().map_err(|_| ())?) == index as i128);
    };
    let step = match a {
        "" | "+" => 1,
        "-" => -1,
        _ => a.parse::<i32>().map_err(|_| ())?,
    };
    let offset = b.trim_start();
    let offset = if offset.is_empty() {
        0
    } else {
        let sign = offset
            .chars()
            .next()
            .filter(|c| matches!(c, '+' | '-'))
            .ok_or(())?;
        let digits = offset[1..].trim_start();
        if !digits.bytes().all(|b| b.is_ascii_digit()) {
            return Err(());
        }
        let magnitude = digits.parse::<i64>().map_err(|_| ())?;
        i32::try_from(if sign == '-' { -magnitude } else { magnitude }).map_err(|_| ())?
    };
    let delta = index as i128 - i128::from(offset);
    let step = i128::from(step);
    Ok(if step == 0 {
        delta == 0
    } else {
        delta % step == 0 && delta / step >= 0
    })
}
