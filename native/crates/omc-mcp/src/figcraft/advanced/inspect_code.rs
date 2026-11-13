use super::*;
use std::collections::BTreeMap;

const WEB: &[&str] = &["css", "html", "react", "vue", "tailwind"];
const COMPONENT: &[&str] = &[
    "react", "leptos", "vue", "swiftui", "compose", "arkui", "flutter",
];

pub(super) fn language_id(value: &str) -> Option<&'static str> {
    let value = value.trim().to_ascii_lowercase();
    match value.as_str() {
        "jsx" | "tsx" => Some("react"),
        "sfc" | "vue3" => Some("vue"),
        "arkts" => Some("arkui"),
        "dart" => Some("flutter"),
        "html + css" => Some("html"),
        "react + tailwind" => Some("tailwind"),
        value => WEB
            .iter()
            .chain(COMPONENT)
            .copied()
            .find(|language| *language == value),
    }
}

pub(super) fn command(context: &Context, component_code: bool) -> Result<Value> {
    let id = context.one()?;
    let node = &context.snapshot.nodes[&id];
    let default_language = if component_code { "react" } else { "css" };
    let language = context
        .params
        .get("language")
        .map_or(Ok(default_language), |value| {
            value
                .as_str()
                .and_then(language_id)
                .filter(|lang| COMPONENT.contains(lang) || (!component_code && WEB.contains(lang)))
                .ok_or_else(|| EngineError::invalid("Unknown code language"))
        })?;
    let owner = code_connect::owner(context.snapshot, &id);
    let mut properties = component::describe_layer(context, &id)?["properties"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let mut params = BTreeMap::new();
    let mut used = BTreeSet::new();
    for property in &mut properties {
        let name = property["name"].as_str().unwrap_or("property");
        let base = code_connect::param(name);
        let mut param = base.clone();
        let mut suffix = 2;
        while !used.insert(param.clone()) {
            param = format!("{base}{suffix}");
            suffix += 1;
        }
        if let Some(id) = property["id"].as_str() {
            params.insert(id.to_owned(), param.clone());
        }
        property["param"] = json!(param);
    }
    let connected = owner
        .as_ref()
        .ok()
        .map(|owner| code_connect::links(owner))
        .into_iter()
        .flatten()
        .find(|link| link["language"] == language)
        .map(|link| {
            let (full, _) = code_connect::render(&link, &properties)?;
            let (import, usage) = if link["importPath"]
                .as_str()
                .is_some_and(|path| !path.is_empty())
            {
                full.split_once("\n\n").unwrap_or(("", &full))
            } else {
                ("", full.as_str())
            };
            Ok::<_, EngineError>(json!({"importPath":link["importPath"],"name":link["name"],
                "template":link["template"],"import":import,"usage":usage,"code":full}))
        })
        .transpose()?;
    if !component_code {
        if let Some(link) = connected {
            return Ok(json!({"code":link["code"],"language":language,"connected":true}));
        }
    }
    let unit = context
        .params
        .get("unit")
        .map(|value| {
            value
                .as_str()
                .map(str::to_ascii_lowercase)
                .ok_or_else(|| EngineError::invalid("unit must be px or rem"))
        })
        .transpose()?;
    let root_font_size = match unit.as_deref() {
        None | Some("px") => None,
        Some("rem") => Some(
            context
                .params
                .get("rootFontSize")
                .map_or(Some(16.0), Value::as_f64)
                .filter(|size| size.is_finite() && *size > 0.0 && *size <= 1000.0)
                .ok_or_else(|| EngineError::invalid("rootFontSize must be between 0 and 1000"))?,
        ),
        _ => return Err(EngineError::invalid("unit must be px or rem")),
    };
    let instance = node.kind == NodeKind::Instance;
    let set = owner
        .as_ref()
        .ok()
        .is_some_and(|owner| owner.properties.get("isVariantSet") == Some(&Value::Bool(true)));
    let definition = if component_code || COMPONENT.contains(&language) {
        owner.as_ref().ok().and_then(|owner| {
            if instance {
                node.string("componentId")
                    .and_then(|id| context.snapshot.nodes.get(id))
            } else if set && owner.id == id {
                children(context.snapshot, &owner.id)
                    .into_iter()
                    .find(|node| node.kind == NodeKind::Component)
            } else {
                Some(node)
            }
        })
    } else {
        None
    };
    let name = owner
        .as_ref()
        .ok()
        .and_then(|owner| owner.string("name"))
        .or_else(|| node.string("name"))
        .unwrap_or("CanvasDesign");
    let symbol = symbol(name);
    if !component_code {
        let root = if instance && matches!(language, "html" | "css" | "tailwind" | "vue") {
            &id
        } else {
            definition.map_or(id.as_str(), |layer| layer.id.as_str())
        };
        let code = generate(
            context,
            root,
            language,
            root_font_size,
            definition
                .filter(|_| root != id || !instance)
                .map(|_| (symbol.as_str(), &params)),
        )?;
        let code = if instance && root != id && language == "react" {
            format!(
                "{}\n\n{code}",
                instance_usage(&symbol, &properties, language)
            )
        } else {
            code
        };
        return Ok(json!({"code":code,"language":language,"connected":false}));
    }
    let owner = owner?;
    let definition_id = definition.map_or(owner.id.as_str(), |node| node.id.as_str());
    let code = generate(
        context,
        definition_id,
        language,
        root_font_size,
        Some((&symbol, &params)),
    )?;
    let mut result = json!({"component":context.alias(definition_id),"name":symbol,
        "set":set.then(|| context.alias(&owner.id)),
        "properties":properties,"definition":code,"language":language,"connected":connected});
    if let Some(link) = result["connected"].as_object_mut() {
        let usage = link.remove("usage").unwrap_or_default();
        if instance {
            result["usage"] = usage;
        }
    } else if instance {
        result["usage"] = json!(instance_usage(&symbol, &properties, language));
    }
    Ok(result)
}

fn instance_usage(symbol: &str, properties: &[Value], language: &str) -> String {
    let values = properties.iter().filter_map(|property| {
        let value = property.get("value").filter(|value| !value.is_null())?;
        let param = property["param"].as_str()?;
        Some((param, value, property["type"].as_str().unwrap_or_default()))
    });
    if language == "react" {
        let attrs = values
            .filter(|(param, _, kind)| {
                *kind != "slot" && param.chars().next().is_some_and(char::is_alphabetic)
            })
            .map(|(param, value, _)| format!(" {param}={{{value}}}"))
            .collect::<String>();
        return format!("<{symbol}{attrs} />");
    }
    let values = values.filter(|(_, _, kind)| matches!(*kind, "text" | "boolean"));
    if language == "vue" {
        let attrs = values
            .map(|(param, value, _)| {
                format!(
                    " :{param}=\"{}\"",
                    value
                        .to_string()
                        .replace('&', "&amp;")
                        .replace('<', "&lt;")
                        .replace('"', "&quot;")
                )
            })
            .collect::<String>();
        return format!("<{symbol}{attrs} />");
    }
    if language == "leptos" {
        let attrs = values
            .map(|(param, value, _)| {
                let key = param
                    .chars()
                    .map(|c| {
                        if c.is_ascii_alphanumeric() {
                            c.to_ascii_lowercase()
                        } else {
                            '_'
                        }
                    })
                    .collect::<String>();
                let value = value
                    .as_str()
                    .map_or_else(|| value.to_string(), |text| format!("{text:?}.to_owned()"));
                format!(" prop_{key}={{{value}}}")
            })
            .collect::<String>();
        return format!("<{symbol}{attrs} />");
    }
    let args = values
        .map(|(param, value, _)| {
            let key = omc_export::platform_property(param);
            let value = value.to_string();
            let value = if matches!(language, "compose" | "flutter") {
                value.replace('$', "\\$")
            } else {
                value
            };
            let assignment = if language == "compose" { "=" } else { ":" };
            format!("{key}{assignment} {value}")
        })
        .collect::<Vec<_>>()
        .join(", ");
    if language == "arkui" {
        format!("{symbol}({{{args}}})")
    } else {
        format!("{symbol}({args})")
    }
}

pub(super) fn generate(
    context: &Context,
    id: &str,
    language: &str,
    root_font_size: Option<f64>,
    component: Option<(&str, &BTreeMap<String, String>)>,
) -> Result<String> {
    if matches!(language, "swiftui" | "compose" | "arkui" | "flutter") {
        let name = context.snapshot.nodes[id]
            .string("name")
            .map(symbol)
            .unwrap_or_else(|| "CanvasDesign".into());
        let empty = BTreeMap::new();
        let (name, parameters) = component.unwrap_or((&name, &empty));
        return omc_export::inspect_platform(context.snapshot, id, language, name, parameters)
            .map_err(|error| EngineError::invalid(error.to_string()));
    }
    let mobile = context
        .params
        .get("mobile")
        .filter(|value| !value.is_null())
        .map(|value| context.resolve(value))
        .transpose()?;
    if let Some(mobile) = &mobile {
        if context.snapshot.nodes[mobile].kind != NodeKind::Frame {
            return Err(EngineError::invalid("mobile must be the ID of a frame"));
        }
    }
    omc_export::inspect_web(
        context.snapshot,
        id,
        language,
        root_font_size.filter(|_| language != "tailwind"),
        component,
        if language == "tailwind" {
            mobile.as_deref()
        } else {
            None
        },
    )
    .map_err(|error| EngineError::invalid(error.to_string()))
}

pub(super) fn symbol(name: &str) -> String {
    let symbol = name
        .split(|c: char| !c.is_alphanumeric())
        .filter(|word| !word.is_empty())
        .map(|word| {
            let mut chars = word.chars();
            chars
                .next()
                .unwrap()
                .to_uppercase()
                .chain(chars)
                .collect::<String>()
        })
        .collect::<String>();
    if symbol.chars().next().is_some_and(char::is_alphabetic) {
        symbol
    } else {
        format!("CanvasDesign{symbol}")
    }
}
