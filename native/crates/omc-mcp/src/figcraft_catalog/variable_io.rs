use super::*;
use serde_json::Map;

const INPUT_LIMIT: usize = 256 * 1024 * 1024;

pub(super) fn import(
    collections: &Entries,
    tokens: &Entries,
    input: &Value,
    commands: &mut Vec<Command>,
) -> Result<Value> {
    let parsed;
    let input = if let Some(text) = input.as_str() {
        let data = if text.trim_start().starts_with('{') {
            text.as_bytes().to_vec()
        } else {
            resources::read_explicit(text, INPUT_LIMIT)?
        };
        parsed = omc_protocol::decode_json_with_limit(&data, INPUT_LIMIT)?;
        &parsed
    } else {
        input
    };
    let input = input.get("meta").unwrap_or(input);
    let incoming = input["variableCollections"]
        .as_object()
        .ok_or_else(|| EngineError::invalid("variableCollections must be an object"))?;
    let entries = input["variables"]
        .as_object()
        .ok_or_else(|| EngineError::invalid("variables must be an object"))?;
    let mut warnings = Vec::new();
    let mut plans = BTreeMap::new();
    let mut new_collections = 0;
    for (source, collection) in incoming {
        let title = name(collection)?;
        let current = collections
            .values()
            .find(|c| c["name"] == title && c["libraryId"].is_null());
        let id = current
            .and_then(|c| c["id"].as_str())
            .map_or_else(|| new_id("collection"), str::to_owned);
        let mut modes = current
            .and_then(|c| c["modes"].as_array())
            .cloned()
            .unwrap_or_default();
        let before = modes.len();
        let mut mapping = BTreeMap::new();
        let source_modes = collection["modes"]
            .as_array()
            .filter(|modes| !modes.is_empty() && modes.len() <= 64)
            .ok_or_else(|| EngineError::invalid("Expected 1–64 imported modes"))?;
        let mut source_modes: Vec<_> = source_modes.iter().collect();
        source_modes.sort_by_key(|mode| mode["modeId"] != collection["defaultModeId"]);
        for mode in source_modes {
            let id = string(mode, "modeId")?;
            let title = name(mode)?;
            let found = modes
                .iter()
                .find(|mode| mode["name"] == title)
                .and_then(|mode| mode["id"].as_str());
            let native = found.map_or_else(|| new_id("mode"), str::to_owned);
            if found.is_none() {
                modes.push(json!({"id":native,"name":title}));
            }
            mapping.insert(id.to_owned(), native);
        }
        if modes.len() > 64 {
            return Err(EngineError::invalid("Collection already has 64 modes"));
        }
        if current.is_none() {
            new_collections += 1;
        }
        if modes.len() != before {
            commands.push(collection_patch(&id, &json!({"name":title,"modes":modes}))?);
        }
        let default = string(&modes[0], "id")?.to_owned();
        let mode_ids = modes
            .iter()
            .map(|mode| string(mode, "id").map(str::to_owned))
            .collect::<Result<Vec<_>>>()?;
        plans.insert(source.as_str(), (id, default, mapping, mode_ids));
    }
    let mut variables = BTreeMap::new();
    let mut identities = BTreeSet::new();
    for (source, row) in entries {
        let title = name(row)?;
        let kind = match row["resolvedType"].as_str() {
            Some("COLOR") => "color",
            Some("FLOAT") => "number",
            Some("STRING") => "string",
            Some("BOOLEAN") => "boolean",
            _ => {
                warnings.push(format!("Skipped {title}: unknown variable type"));
                continue;
            }
        };
        let collection = row["variableCollectionId"]
            .as_str()
            .and_then(|key| plans.get(key));
        let Some((collection, _, _, _)) = collection else {
            warnings.push(format!("Skipped {title}: missing collection"));
            continue;
        };
        if !identities.insert((collection.as_str(), title)) {
            warnings.push(format!("Skipped {title}: duplicate variable name"));
            continue;
        }
        let existing = tokens
            .values()
            .find(|token| token["collectionId"] == *collection && token["name"] == title);
        if existing.is_some_and(|token| token["type"] != kind) {
            warnings.push(format!(
                "Skipped {title}: existing variable has another type"
            ));
            continue;
        }
        let id = existing
            .and_then(|token| token["id"].as_str())
            .map_or_else(|| new_id("token"), str::to_owned);
        variables.insert(source.as_str(), (id, kind, existing));
    }
    let mut staged = tokens.clone();
    let mut changed = BTreeSet::new();
    let mut new_variables = 0;
    let mut updated = 0;
    for (source, (id, kind, existing)) in &variables {
        let row = &entries[*source];
        let (collection, default, remap, mode_ids) = &plans[string(row, "variableCollectionId")?];
        let mut modes = existing
            .and_then(|token| token["modes"].as_object())
            .cloned()
            .unwrap_or_default();
        if let Some(values) = row["valuesByMode"].as_object() {
            for (mode, raw) in values {
                let Some(mode) = remap.get(mode) else {
                    continue;
                };
                let value = if raw["type"] == "VARIABLE_ALIAS" {
                    raw["id"]
                        .as_str()
                        .and_then(|alias| variables.get(alias))
                        .filter(|(_, other, _)| other == kind)
                        .map(|(id, _, _)| json!({"$token":id}))
                } else if *kind == "color" {
                    read_color(raw)
                } else {
                    token_value(tokens, kind, raw, id).ok()
                };
                if let Some(value) = value {
                    modes.insert(mode.clone(), value);
                }
            }
        }
        let fallback = modes
            .get(default)
            .or_else(|| modes.values().next())
            .cloned();
        let Some(fallback) = fallback else {
            warnings.push(format!("Skipped {}: no readable values", row["name"]));
            continue;
        };
        for mode in mode_ids {
            modes
                .entry(mode.clone())
                .or_insert_with(|| fallback.clone());
        }
        let mut token = existing.map_or_else(|| json!({}), |token| token.clone());
        token["id"] = json!(id);
        token["name"] = row["name"].clone();
        token["type"] = json!(kind);
        token["collectionId"] = json!(collection);
        token["value"] = modes[default].clone();
        token["modes"] = json!(modes);
        variable_ops::append_update(existing.unwrap_or(&Value::Null), row, &mut token)?;
        if let Some(description) = row["description"].as_str() {
            token["description"] = json!(description);
        }
        if existing.is_none() {
            new_variables += 1;
        } else if *existing != Some(&token) {
            updated += 1;
        }
        changed.insert(id.clone());
        staged.insert(id.clone(), token);
    }
    if entries.is_empty() {
        warnings.push("The file contains no variables".to_owned());
    }
    for id in changed {
        let token = &staged[&id];
        for value in token["modes"].as_object().into_iter().flat_map(Map::values) {
            if let Some(reference) = value["$token"].as_str() {
                token_value(
                    &staged,
                    string(token, "type")?,
                    &json!({"alias":reference}),
                    &id,
                )?;
            }
        }
        commands.push(catalog("tokens", &id, token.clone())?);
    }
    Ok(
        json!({"collections":new_collections,"variables":new_variables,"updated":updated,"warnings":warnings}),
    )
}

fn read_color(value: &Value) -> Option<Value> {
    if let Some(text) = value.as_str() {
        return token_value(&Entries::new(), "color", &json!(text), "").ok();
    }
    let channel = |key| {
        value
            .get(key)
            .and_then(Value::as_f64)
            .filter(|v| (0. ..=1.).contains(v))
            .map(|v| (v * 255.).round() as u8)
    };
    let (r, g, b, a) = (
        channel("r")?,
        channel("g")?,
        channel("b")?,
        value.get("a").map_or(Some(255), |_| channel("a"))?,
    );
    Some(if a == 255 {
        json!(format!("#{r:02x}{g:02x}{b:02x}"))
    } else {
        json!(format!("#{r:02x}{g:02x}{b:02x}{a:02x}"))
    })
}

pub(super) fn channels(value: &str) -> Option<[u8; 4]> {
    let hex = value.strip_prefix('#')?;
    let mut result = [255; 4];
    match hex.len() {
        3 | 4 => {
            for (index, value) in hex.chars().enumerate() {
                result[index] = value.to_digit(16)? as u8 * 17;
            }
        }
        6 | 8 if hex.is_ascii() => {
            for index in 0..hex.len() / 2 {
                result[index] = u8::from_str_radix(&hex[index * 2..index * 2 + 2], 16).ok()?;
            }
        }
        _ => return None,
    }
    Some(result)
}

fn resolve(
    snapshot: &DocumentSnapshot,
    collection: &str,
    mode: &str,
    value: &Value,
) -> Result<Value> {
    let mut probe = Node::new(NodeKind::Frame);
    probe
        .properties
        .insert("figcraftVariableModes".into(), json!({collection:mode}));
    omc_style::ReferenceContext::new(snapshot)
        .resolve_value(value, Some(&probe))
        .map_err(EngineError::invalid)
}

pub(super) fn export(
    snapshot: &DocumentSnapshot,
    collections: &Entries,
    tokens: &Entries,
    params: &Value,
) -> Result<Value> {
    let collections: Vec<_> = match params.get("collections") {
        None | Some(Value::Null) => collections
            .values()
            .filter(|row| row["libraryId"].is_null())
            .collect(),
        Some(Value::Array(names)) => names
            .iter()
            .map(|name| {
                entry(
                    collections,
                    name.as_str()
                        .ok_or_else(|| EngineError::invalid("Expected collection IDs or names"))?,
                )
            })
            .collect::<Result<_>>()?,
        _ => return Err(EngineError::invalid("collections must be an array")),
    };
    let chosen: BTreeSet<_> = collections
        .iter()
        .filter_map(|row| row["id"].as_str())
        .collect();
    let members: Vec<_> = tokens
        .values()
        .filter(|token| {
            token["collectionId"]
                .as_str()
                .is_some_and(|id| chosen.contains(id))
        })
        .collect();
    let ids: BTreeSet<_> = members
        .iter()
        .filter_map(|token| token["id"].as_str())
        .collect();
    let format = params["format"].as_str().unwrap_or("json");
    let text = if format == "json" {
        let mut rows = Map::new();
        let mut vars = Map::new();
        for collection in &collections {
            let cid = string(collection, "id")?;
            let modes = collection["modes"]
                .as_array()
                .ok_or_else(|| EngineError::invalid("Collection has no modes"))?;
            let mut variable_ids = Vec::new();
            for token in members.iter().filter(|token| token["collectionId"] == cid) {
                let id = string(token, "id")?;
                variable_ids.push(id);
                let kind = string(token, "type")?;
                let mut values = Map::new();
                for mode in modes {
                    let mode = string(mode, "id")?;
                    let value = token["modes"].get(mode).unwrap_or(&token["value"]);
                    let raw = if let Some(alias) =
                        value["$token"].as_str().filter(|alias| ids.contains(alias))
                    {
                        json!({"type":"VARIABLE_ALIAS","id":alias})
                    } else {
                        let value = resolve(snapshot, cid, mode, value)?;
                        if kind == "color" {
                            let [r, g, b, a] = value
                                .as_str()
                                .and_then(channels)
                                .ok_or_else(|| {
                                    EngineError::invalid("A color variable is not a hex color")
                                })?
                                .map(|channel| f64::from(channel) / 255.);
                            json!({"r":r,"g":g,"b":b,"a":a})
                        } else {
                            value
                        }
                    };
                    values.insert(mode.to_owned(), raw);
                }
                let mut row = variable_ops::variable_patch_metadata(token);
                row.extend(json!({
                    "id":id,"name":token["name"],"key":id,"variableCollectionId":cid,
                    "resolvedType":match kind { "number" => "FLOAT".into(), other => other.to_uppercase() },
                    "valuesByMode":values,"remote":false,
                    "scopes":token.get("scopes").filter(|v| !v.is_null()).cloned().unwrap_or(json!(["ALL_SCOPES"])),
                }).as_object().unwrap().clone());
                vars.insert(id.to_owned(), Value::Object(row));
            }
            let wire_modes: Vec<_> = modes
                .iter()
                .map(|mode| json!({"modeId":mode["id"],"name":mode["name"]}))
                .collect();
            rows.insert(cid.to_owned(), json!({"id":cid,"name":collection["name"],"key":cid,"modes":wire_modes,"defaultModeId":modes[0]["id"],"remote":false,"hiddenFromPublishing":false,"variableIds":variable_ids}));
        }
        serde_json::to_string_pretty(&json!({"status":200,"error":false,"meta":{"variableCollections":rows,"variables":vars}}))
            .map_err(|error| EngineError::invalid(error.to_string()))?
    } else if matches!(format, "css" | "tailwind" | "dart") {
        format_code(snapshot, &collections, &members, format)?
    } else {
        return Err(EngineError::invalid(
            "format must be json, css, tailwind, or dart",
        ));
    };
    if let Some(path) = params["path"].as_str() {
        interchange::write_explicit(path, text.as_bytes(), false)?;
        Ok(json!({"path":path}))
    } else {
        Ok(json!({"text":text}))
    }
}

fn safe_name(text: &str) -> String {
    let cleaned = text
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|word| !word.is_empty())
        .collect::<Vec<_>>()
        .join("-")
        .to_ascii_lowercase();
    if cleaned.is_empty() {
        "variable".into()
    } else {
        cleaned
    }
}

fn unique(base: String, used: &mut BTreeSet<String>) -> String {
    let mut name = base.clone();
    let mut counter = 2;
    while !used.insert(name.clone()) {
        name = format!("{base}-{counter}");
        counter += 1;
    }
    name
}

fn dart_name(text: &str, pascal: bool) -> String {
    let mut result = String::new();
    for word in text.split('-') {
        let mut chars = word.chars();
        let Some(first) = chars.next() else {
            continue;
        };
        result.push(if pascal || !result.is_empty() {
            first.to_ascii_uppercase()
        } else {
            first
        });
        result.extend(chars);
    }
    if result.is_empty() || result.starts_with(|c: char| c.is_ascii_digit()) {
        result.insert_str(0, if pascal { "V" } else { "v" });
    }
    if [
        "assert", "await", "break", "case", "class", "const", "continue", "default", "do", "else",
        "enum", "extends", "false", "final", "finally", "for", "if", "in", "is", "new", "null",
        "return", "super", "switch", "this", "throw", "true", "try", "var", "void", "while",
        "with", "yield", "Color", "String",
    ]
    .contains(&result.as_str())
    {
        result.push('_');
    }
    result
}

fn format_code(
    snapshot: &DocumentSnapshot,
    collections: &[&Value],
    members: &[&Value],
    format: &str,
) -> Result<String> {
    use std::fmt::Write;
    let mut out = match format {
        "dart" => "import 'dart:ui' show Color;\n".to_owned(),
        "tailwind" => "@import \"tailwindcss\";\n\n".into(),
        _ => String::new(),
    };
    let mut used = BTreeSet::new();
    let mut class_names = BTreeSet::new();
    let mut names = BTreeMap::new();
    for token in members {
        let label = safe_name(name(token)?);
        let role = token["scopes"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .next();
        let prefix = if format == "tailwind" {
            match (string(token, "type")?, role) {
                ("color", _) => "color-",
                ("number", Some("CORNER_RADIUS")) => "radius-",
                ("number", Some("FONT_SIZE")) => "text-",
                ("number", _) => "spacing-",
                ("string", Some("FONT_FAMILY")) => "font-",
                _ => "",
            }
        } else {
            ""
        };
        names.insert(
            string(token, "id")?,
            unique(format!("{prefix}{label}"), &mut used),
        );
    }
    for collection in collections {
        let cid = string(collection, "id")?;
        let title = name(collection)?;
        for (index, mode) in collection["modes"]
            .as_array()
            .into_iter()
            .flatten()
            .enumerate()
        {
            let mode_title = name(mode)?;
            let mode = string(mode, "id")?;
            if format == "dart" {
                let class = dart_name(
                    &unique(
                        safe_name(&format!("{title}-{mode_title}")),
                        &mut class_names,
                    ),
                    true,
                );
                writeln!(out, "\nabstract final class {class} {{").unwrap();
            } else if index == 0 {
                writeln!(
                    out,
                    "{} {{",
                    if format == "tailwind" {
                        "@theme static"
                    } else {
                        ":root"
                    }
                )
                .unwrap();
            } else {
                writeln!(out, "[data-{}={}] {{", safe_name(title), json!(mode_title)).unwrap();
            }
            for token in members.iter().filter(|token| token["collectionId"] == cid) {
                let kind = string(token, "type")?;
                let var = &names[string(token, "id")?];
                let value = token["modes"].get(mode).unwrap_or(&token["value"]);
                if format != "dart"
                    && let Some(alias) = value["$token"].as_str().and_then(|id| names.get(id))
                {
                    writeln!(out, "  --{var}: var(--{alias});").unwrap();
                    continue;
                }
                let value = resolve(snapshot, cid, mode, value)?;
                if format == "dart" {
                    let (kind, value) = match kind {
                        "color" => {
                            let [r, g, b, a] = value
                                .as_str()
                                .and_then(channels)
                                .ok_or_else(|| EngineError::invalid("Invalid color"))?;
                            ("Color", format!("Color(0x{a:02X}{r:02X}{g:02X}{b:02X})"))
                        }
                        "number" => ("double", value.to_string()),
                        "string" => ("String", value.to_string().replace('$', "\\$")),
                        _ => ("bool", value.to_string()),
                    };
                    writeln!(
                        out,
                        "  static const {kind} {} = {value};",
                        dart_name(var, false)
                    )
                    .unwrap();
                } else {
                    let unitless = token["scopes"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .any(|scope| matches!(scope.as_str(), Some("OPACITY" | "FONT_WEIGHT")));
                    let value = if kind == "color" {
                        value.as_str().unwrap_or("transparent").to_owned()
                    } else if kind == "number" && !unitless {
                        format!("{value}px")
                    } else {
                        value.to_string()
                    };
                    writeln!(out, "  --{var}: {value};").unwrap();
                }
            }
            writeln!(out, "}}").unwrap();
        }
    }
    Ok(out)
}
