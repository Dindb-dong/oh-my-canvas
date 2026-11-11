use omc_model::{DocumentSnapshot, Node};

// Supported combinators are descendant and child. Unknown syntax is never treated as a match.
pub fn matches(
    selector: &str,
    node: &Node,
    snapshot: &DocumentSnapshot,
) -> Result<Option<u32>, ()> {
    let tokens = tokenize(selector)?;
    if tokens.is_empty() {
        return Err(());
    }
    let specificity = specificity(selector);
    let mut position = tokens.len() - 1;
    let mut candidate = node;
    if !simple(&tokens[position], candidate, snapshot)? {
        return Ok(None);
    }
    while position > 0 {
        position -= 1;
        if tokens[position] == ">" {
            if position == 0 {
                return Err(());
            }
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
fn tokenize(input: &str) -> Result<Vec<String>, ()> {
    let mut result = Vec::new();
    let mut current = String::new();
    let mut depth = 0;
    let mut quote = None;
    for ch in input.chars() {
        if let Some(q) = quote {
            current.push(ch);
            if ch == q {
                quote = None;
            }
            continue;
        }
        match ch {
            '\'' | '"' => {
                quote = Some(ch);
                current.push(ch);
            }
            '[' | '(' => {
                depth += 1;
                current.push(ch);
            }
            ']' | ')' => {
                depth -= 1;
                if depth < 0 {
                    return Err(());
                }
                current.push(ch);
            }
            '+' | '~' | '|' if depth == 0 => return Err(()),
            '>' if depth == 0 => {
                if !current.is_empty() {
                    result.push(std::mem::take(&mut current));
                }
                result.push(">".into());
            }
            c if c.is_whitespace() && depth == 0 => {
                if !current.is_empty() {
                    result.push(std::mem::take(&mut current));
                }
            }
            _ => current.push(ch),
        }
    }
    if depth != 0 || quote.is_some() {
        return Err(());
    }
    if !current.is_empty() {
        result.push(current);
    }
    Ok(result)
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
            let Some(end) = input[p..].find(']').map(|i| i + p) else {
                return Err(());
            };
            p = end + 1;
            let (attribute, expected) = input[start..end]
                .split_once('=')
                .map_or((input[start..end].trim(), None), |(a, v)| {
                    (a.trim(), Some(v.trim().trim_matches(['\'', '"'])))
                });
            if attribute.contains(['~', '|', '^', '$', '*']) {
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
            let mut siblings: Vec<_> = snapshot
                .nodes
                .values()
                .filter(|n| n.parent_id == node.parent_id)
                .collect();
            siblings.sort_by(|a, b| (&a.rank, &a.id).cmp(&(&b.rank, &b.id)));
            let index = siblings.iter().position(|n| n.id == node.id).ok_or(())? + 1;
            let matched = match pseudo {
                "root" => node.parent_id.is_none(),
                "first-child" => index == 1,
                "last-child" => index == siblings.len(),
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
                    match expr {
                        "odd" => index % 2 == 1,
                        "even" => index % 2 == 0,
                        _ => index == expr.parse::<usize>().map_err(|_| ())?,
                    }
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
fn specificity(input: &str) -> u32 {
    let ids = input.bytes().filter(|c| *c == b'#').count() as u32;
    let classes = input
        .bytes()
        .filter(|c| matches!(c, b'.' | b'[' | b':'))
        .count() as u32;
    let types = input
        .split([' ', '>'])
        .filter(|s| s.as_bytes().first().is_some_and(u8::is_ascii_alphabetic))
        .count() as u32;
    ids * 10000 + classes * 100 + types
}
