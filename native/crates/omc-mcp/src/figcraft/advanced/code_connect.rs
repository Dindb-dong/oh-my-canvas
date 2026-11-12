use super::*;
use std::collections::BTreeMap;

const KEY: &str = "codeLinks";
const MAX_FILE: usize = 4 * 1024 * 1024;
const LANGUAGES: &[&str] = &[
    "react", "leptos", "vue", "swiftui", "compose", "arkui", "flutter",
];

pub(super) fn command(context: &Context, action: &str) -> Result<Value> {
    match action {
        "import" => import(context),
        "export" => export(context),
        "set" | "remove" => {
            let id = context.one()?;
            let component = owner(context.snapshot, &id)?;
            let name = context.params.get("language").map(language).transpose()?;
            let mut links = links(component);
            let before = links.len();
            let result = if action == "remove" {
                links.retain(|link| name.is_some_and(|lang| link["language"] != lang));
                json!({"component":context.alias(&component.id),"removed":before-links.len()})
            } else {
                let language = name.unwrap_or("react");
                let existing = links.iter().find(|link| link["language"] == language);
                let mut value = existing
                    .cloned()
                    .unwrap_or_else(|| json!({"language":language}));
                for key in ["name", "importPath", "template"] {
                    if let Some(field) = context.params.get(key).filter(|field| !field.is_null()) {
                        value[key] = field.clone();
                    }
                }
                let properties = component::describe_layer(context, &id)?["properties"].clone();
                let props = properties.as_array().expect("component properties");
                let link = normalize(&value, component, language, props)?;
                let (code, unknown) = render(&link, props)?;
                update(&mut links, link);
                json!({"component":context.alias(&component.id),"language":language,"code":code,"unknown":unknown})
            };
            if links != self::links(component) {
                context.commit(vec![context.patch(&component.id, KEY, json!(links))])?;
            }
            Ok(result)
        }
        _ => Err(EngineError::invalid("Unknown code connection action")),
    }
}

fn language(value: &Value) -> Result<&str> {
    value
        .as_str()
        .and_then(inspect_code::language_id)
        .filter(|lang| LANGUAGES.contains(lang))
        .ok_or_else(|| EngineError::invalid("Unknown code connection language"))
}

pub(super) fn owner<'a>(snapshot: &'a DocumentSnapshot, id: &str) -> Result<&'a Node> {
    let node = &snapshot.nodes[id];
    if node.properties.get("isVariantSet") == Some(&Value::Bool(true)) {
        return Ok(node);
    }
    let component = if node.kind == NodeKind::Instance {
        node.string("componentId")
            .and_then(|id| snapshot.nodes.get(id))
    } else {
        Some(node)
    }
    .filter(|node| node.kind == NodeKind::Component && node.string("libraryId").is_none())
    .ok_or_else(|| EngineError::invalid("Choose an editable component, variant set or instance"))?;
    Ok(component
        .string("variantSetId")
        .and_then(|id| snapshot.nodes.get(id))
        .unwrap_or(component))
}

pub(super) fn links(node: &Node) -> Vec<Value> {
    array(node.properties.get(KEY))
}

fn update(links: &mut Vec<Value>, link: Value) {
    links.retain(|old| old["language"] != link["language"]);
    links.push(link);
    links.sort_by(|a, b| a["language"].as_str().cmp(&b["language"].as_str()));
}

fn bounded(value: &Value, key: &str, limit: usize) -> Result<Option<String>> {
    value
        .get(key)
        .map(|value| {
            value
                .as_str()
                .map(str::trim)
                .filter(|s| s.chars().count() <= limit)
                .map(str::to_owned)
                .ok_or_else(|| {
                    EngineError::invalid(format!("{key} must be a string up to {limit} characters"))
                })
        })
        .transpose()
}

fn words(name: &str) -> impl Iterator<Item = &str> {
    name.split(|ch: char| !ch.is_alphanumeric())
        .filter(|word| !word.is_empty())
}

fn upper_initial(word: &str) -> String {
    let mut chars = word.chars();
    chars
        .next()
        .into_iter()
        .flat_map(char::to_uppercase)
        .chain(chars)
        .collect()
}

pub(super) fn param(name: &str) -> String {
    let mut words = words(name);
    let first = words.next().unwrap_or("property");
    first
        .chars()
        .take(1)
        .flat_map(char::to_lowercase)
        .chain(first.chars().skip(1))
        .collect::<String>()
        + &words.map(upper_initial).collect::<String>()
}

fn normalize(value: &Value, node: &Node, lang: &str, props: &[Value]) -> Result<Value> {
    let name = bounded(value, "name", 100)?
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| {
            let name = words(node.string("name").unwrap_or("Component"))
                .map(upper_initial)
                .collect::<String>();
            if name.is_empty() {
                "Component".into()
            } else {
                name
            }
        });
    if !name.split('.').all(|part| {
        let mut chars = part.chars();
        chars.next().is_some_and(|c| c.is_alphabetic() || c == '_')
            && chars.all(|c| c.is_alphanumeric() || c == '_')
    }) {
        return Err(EngineError::invalid(
            "Code component name must use valid identifiers",
        ));
    }
    let path = bounded(value, "importPath", 300)?.unwrap_or_default();
    let path_ok = |chars: &str| {
        path.chars()
            .all(|c| c.is_ascii_alphanumeric() || chars.contains(c))
    };
    let valid = match lang {
        "react" | "arkui" => !path
            .chars()
            .any(|c| c.is_control() || matches!(c, '"' | '\\')),
        "leptos" => path_ok("_:"),
        "vue" => path_ok("_./@-"),
        "flutter" => path_ok("_./:-"),
        _ => path_ok("_."),
    };
    if !valid {
        return Err(EngineError::invalid("Invalid code component import path"));
    }
    let template = bounded(value, "template", 4000)?
        .filter(|template| !template.is_empty())
        .unwrap_or_else(|| default_template(&name, lang, props));
    if template.chars().count() > 4000
        || template
            .chars()
            .any(|c| c.is_control() && !"\t\r\n".contains(c))
    {
        return Err(EngineError::invalid("Invalid code template"));
    }
    Ok(json!({"language":lang,"importPath":path,"name":name,"template":template}))
}

fn default_template(name: &str, lang: &str, props: &[Value]) -> String {
    let names = props
        .iter()
        .filter_map(|property| property["name"].as_str())
        .map(param);
    match lang {
        "react" | "leptos" => format!(
            "<{name}{} />",
            names
                .map(|prop| format!(" {prop}={{{prop}}}"))
                .collect::<String>()
        ),
        "vue" => format!(
            "<{name}{} />",
            names
                .map(|prop| format!(" :{prop}={{{prop}}}"))
                .collect::<String>()
        ),
        "arkui" => format!(
            "{name}({{ {} }})",
            names
                .map(|prop| format!("{prop}: {{{prop}}}"))
                .collect::<Vec<_>>()
                .join(", ")
        ),
        _ => {
            let separator = if lang == "compose" { " = " } else { ": " };
            format!(
                "{name}({})",
                names
                    .map(|prop| format!("{prop}{separator}{{{prop}}}"))
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        }
    }
}

fn quoted(value: &str, lang: &str) -> String {
    let text = serde_json::to_string(value).expect("string");
    if matches!(lang, "compose" | "flutter") {
        text.replace('$', "\\$")
    } else {
        text
    }
}

fn choice<'a>(condition: &Value, choices: &'a str) -> Result<&'a str> {
    fn next(input: &str) -> Option<(&str, &str)> {
        input.trim().strip_prefix('"')?.split_once('"')
    }
    let malformed = || EngineError::invalid("Use {property ? \"yes\" : \"no\"}");
    let (yes, rest) = next(choices).ok_or_else(malformed)?;
    let (no, rest) =
        next(rest.trim().strip_prefix(':').ok_or_else(malformed)?).ok_or_else(malformed)?;
    if !rest.trim().is_empty() {
        return Err(malformed());
    }
    let truthy = match condition {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::Number(value) => value.as_f64() != Some(0.),
        Value::String(value) => {
            !value.is_empty()
                && !["false", "off", "no", "0", "none"]
                    .iter()
                    .any(|off| value.eq_ignore_ascii_case(off))
        }
        _ => true,
    };
    Ok(if truthy { yes } else { no })
}

pub(super) fn render(link: &Value, props: &[Value]) -> Result<(String, Vec<String>)> {
    let lang = language(&link["language"])?;
    let mut output = String::new();
    let mut unknown = Vec::new();
    let mut rest = link["template"].as_str().unwrap_or_default();
    while let Some((before, after)) = rest.split_once('{') {
        output.push_str(before);
        let next = after
            .split_once('}')
            .filter(|(inside, _)| !inside.contains('{'));
        let Some((inside, tail)) = next else {
            output.push('{');
            rest = after;
            continue;
        };
        let (name, pick) = inside
            .split_once('?')
            .map_or((inside.trim(), None), |(name, pick)| {
                (name.trim(), Some(pick))
            });
        if name.is_empty()
            || name.chars().count() > 100
            || !name
                .chars()
                .all(|c| c.is_alphanumeric() || " _-./".contains(c))
            || pick.is_some_and(|pick| !pick.contains('"'))
        {
            output.push('{');
            rest = after;
            continue;
        }
        let property = props.iter().find(|property| {
            property["name"]
                .as_str()
                .is_some_and(|prop| prop == name || param(prop) == name)
        });
        if let Some(property) = property {
            let value = property.get("value").unwrap_or(&property["default"]);
            let picked = pick.map(|pick| choice(value, pick)).transpose()?;
            let text = picked.or_else(|| value.as_str());
            let jsx_attr =
                lang == "react" && output.ends_with('=') && output.rfind('<') > output.rfind('>');
            let expression = if let Some(text) = text {
                if jsx_attr {
                    format!(
                        "\"{}\"",
                        text.replace('&', "&amp;")
                            .replace('"', "&quot;")
                            .replace('<', "&lt;")
                            .replace('>', "&gt;")
                    )
                } else {
                    quoted(text, lang)
                }
            } else {
                value.to_string()
            };
            if lang == "react" && !(jsx_attr && text.is_some()) {
                output.push('{');
                output.push_str(&expression);
                output.push('}');
            } else if lang == "vue" {
                let escaped = expression
                    .replace('&', "&amp;")
                    .replace('"', "&quot;")
                    .replace('<', "&lt;")
                    .replace('>', "&gt;");
                if output.ends_with('=') {
                    output.push('"');
                    output.push_str(&escaped);
                    output.push('"');
                } else {
                    output.push_str(&escaped);
                }
            } else {
                output.push_str(&expression);
            }
        } else {
            if let Some(pick) = pick {
                choice(&Value::Null, pick)?;
            }
            if !unknown.iter().any(|unknown| unknown == name) {
                unknown.push(name.to_owned());
            }
            output.push('{');
            output.push_str(inside);
            output.push('}');
        }
        rest = tail;
    }
    output.push_str(rest);
    let path = link["importPath"].as_str().unwrap_or_default();
    if !path.is_empty() {
        let name = link["name"]
            .as_str()
            .unwrap_or_default()
            .split('.')
            .next()
            .unwrap_or_default();
        let import = match lang {
            "react" | "arkui" => format!("import {{ {name} }} from {};", quoted(path, lang)),
            "vue" => format!("import {name} from {};", quoted(path, lang)),
            "leptos" => format!("use {path}::{name};"),
            "flutter" => format!("import {};", quoted(path, lang)),
            _ => format!("import {path}"),
        };
        output = format!("{import}\n\n{output}");
    }
    Ok((output, unknown))
}

fn export(context: &Context) -> Result<Value> {
    let mut list = Vec::new();
    for node in context.snapshot.nodes.values() {
        for mut link in links(node) {
            if link.is_object() {
                link["component"] = json!(node.string("name").unwrap_or_default());
                list.push(link);
            }
        }
    }
    list.sort_by(|a, b| {
        a["component"]
            .as_str()
            .cmp(&b["component"].as_str())
            .then_with(|| a["language"].as_str().cmp(&b["language"].as_str()))
    });
    let count = list.len();
    let text = serde_json::to_string_pretty(&json!({"version":1,"links":list}))
        .map_err(|error| EngineError::invalid(error.to_string()))?;
    if let Some(path) = context.params.get("path") {
        let path = path
            .as_str()
            .ok_or_else(|| EngineError::invalid("path must be a string"))?;
        crate::interchange::write_explicit(
            path,
            text.as_bytes(),
            context.params["overwrite"] == true,
        )?;
        Ok(json!({"path":path,"links":count}))
    } else {
        Ok(json!({"text":text,"links":count}))
    }
}

fn import(context: &Context) -> Result<Value> {
    let input = match (context.params.get("json"), context.params.get("path")) {
        (Some(value), None) if value.is_object() => value.clone(),
        (Some(Value::String(text)), None) if text.len() <= MAX_FILE => {
            serde_json::from_str(text).map_err(|error| EngineError::invalid(error.to_string()))?
        }
        (None, Some(Value::String(path))) => {
            serde_json::from_slice(&crate::resources::read_explicit(path, MAX_FILE)?)
                .map_err(|error| EngineError::invalid(error.to_string()))?
        }
        _ => {
            return Err(EngineError::invalid(
                "Pass one code connection JSON object, text or file path",
            ));
        }
    };
    if input["version"] != 1 {
        return Err(EngineError::invalid(
            "Code connection format version must be 1",
        ));
    }
    let records = input["links"]
        .as_array()
        .filter(|list| list.len() <= 5000)
        .ok_or_else(|| EngineError::invalid("links must be an array with at most 5000 entries"))?;
    let mut components = BTreeMap::<&str, Vec<&Node>>::new();
    for node in context.snapshot.nodes.values() {
        if (node.kind == NodeKind::Component
            && node.string("variantSetId").is_none()
            && node.string("libraryId").is_none()
            || node.properties.get("isVariantSet") == Some(&Value::Bool(true)))
            && let Some(name) = node.string("name")
        {
            components.entry(name).or_default().push(node);
        }
    }
    let mut changes = BTreeMap::<&str, Vec<Value>>::new();
    let mut warnings = Vec::new();
    let mut linked = 0;
    for (index, item) in records.iter().enumerate() {
        let result = (|| {
            let name = item["component"]
                .as_str()
                .ok_or_else(|| EngineError::invalid("component name required"))?;
            let language = language(&item["language"])?;
            let targets = components
                .get(name)
                .ok_or_else(|| EngineError::invalid(format!("Unknown component {name}")))?;
            let mut entries = Vec::new();
            for target in targets {
                let props = component::describe_layer(context, &target.id)?["properties"].clone();
                let props = props.as_array().expect("component properties");
                let link = normalize(item, target, language, props)?;
                render(&link, props)?;
                entries.push((*target, link));
            }
            Ok::<_, EngineError>(entries)
        })();
        match result {
            Ok(entries) => {
                for (target, link) in entries {
                    update(
                        changes.entry(&target.id).or_insert_with(|| links(target)),
                        link,
                    );
                    linked += 1;
                }
            }
            Err(error) if warnings.len() < 50 => {
                warnings.push(format!("Link {}: {error}", index + 1))
            }
            Err(_) => {}
        }
    }
    let edits = changes
        .into_iter()
        .map(|(id, value)| context.patch(id, KEY, json!(value)))
        .collect();
    context.commit(edits)?;
    Ok(json!({"linked":linked,"warnings":warnings}))
}
