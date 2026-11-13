use omc_protocol::{EngineError, Result};
use serde_json::Value;
use std::sync::OnceLock;
pub fn tools() -> &'static Vec<Value> {
    static TOOLS: OnceLock<Vec<Value>> = OnceLock::new();
    TOOLS.get_or_init(|| {
        serde_json::from_str(include_str!("../schemas/tools-v1.json")).expect("checked schema")
    })
}
pub fn validate(name: &str, args: &Value) -> Result<()> {
    let tool = tools()
        .iter()
        .find(|t| t["name"] == name)
        .ok_or_else(|| EngineError::new("unsupported_feature", "unknown tool"))?;
    check(&tool["inputSchema"], args, "args")?;
    let action = args["action"].as_str().unwrap_or("");
    let required: &[&str] = match (name, action) {
        ("page", "rename") => &["pageId", "name"],
        ("page", "duplicate" | "delete" | "reorder") => &["pageId"],
        ("page", "update") => &["pageId", "properties"],
        ("edit_shapes", "patch") => &["properties"],
        ("edit_shapes", "align") => &["alignment"],
        ("edit_shapes", "distribute" | "flip") => &["axis"],
        ("edit_shapes", "order") => &["mode"],
        ("edit_shapes", "translate") => &["dx", "dy"],
        ("edit_shapes", "resize") => &["width", "height"],
        ("edit_shapes", "rotate") => &["angle"],
        ("edit_shapes", "layout") => &["layout"],
        ("edit_text", "replace") => &["text"],
        ("edit_text", "range_style") => &["range", "style"],
        ("edit_text", "paragraph_style") => &["style"],
        ("edit_text", "find_replace") => &["find", "replace"],
        ("styles", "get" | "duplicate" | "delete" | "users") => &["id"],
        ("styles", "create") => &["type", "name", "value"],
        ("styles", "update") => &["id", "patch"],
        ("styles", "apply") => &["id", "ids"],
        ("styles", "detach") => &["ids"],
        ("libraries", "get" | "remove" | "export") => &["id"],
        ("libraries", "add") => &["snapshot"],
        ("libraries", "update") => &["id", "snapshot"],
        ("libraries", "enable") => &["id", "enabled"],
        ("libraries", "insert") => &["id", "componentId"],
        ("document_assets", "add") => &["kind", "name"],
        ("document_assets", "remove" | "place") => &["id"],
        ("clipboard", "copy" | "cut" | "copy_properties" | "paste_properties") => &["ids"],
        ("view", "select") => &["ids"],
        ("view", "tool") => &["tool"],
        ("workspace", "focus" | "close") => &["documentId"],
        ("workspace", "sample_color") => &["x", "y"],
        ("component", "property" | "bind") => &["propertyType"],
        ("component", "edit_property" | "remove_property") => &["property"],
        ("component", "set_property") => &["property", "value"],
        ("collaboration", "invite") => &["address"],
        ("collaboration", "join") => &["invite"],
        ("edit_path", "move_nodes") => &["indices", "dx", "dy"],
        ("edit_path", "insert_node") => &["index"],
        ("edit_path", "delete_nodes") => &["indices"],
        ("edit_path", "set_handle") => &["index", "handle", "point"],
        ("edit_path", "convert_node") => &["index", "nodeKind"],
        ("edit_path", "primitive") => &["primitive"],
        _ => &[],
    };
    for key in required {
        if args.get(*key).is_none() {
            return Err(EngineError::invalid(format!("{action} requires {key}")));
        }
    }
    if name == "import_document"
        && (args.get("payload").is_some() == args.get("filePath").is_some())
    {
        return Err(EngineError::invalid(
            "supply exactly one payload or filePath",
        ));
    }
    if name == "import_document"
        && matches!(args["format"].as_str(), Some("fig" | "sketch"))
        && args.get("filePath").is_none()
    {
        return Err(EngineError::invalid("design file import requires filePath"));
    }
    if name == "component" && args.get("x").is_some() != args.get("y").is_some() {
        return Err(EngineError::invalid("x and y must be supplied together"));
    }
    if name == "boolean" {
        let ids = args["ids"].as_array().unwrap();
        let unique: std::collections::BTreeSet<_> = ids.iter().filter_map(Value::as_str).collect();
        if unique.len() != ids.len() || (args["operation"] != "flatten" && ids.len() < 2) {
            return Err(EngineError::invalid(
                "boolean operands must be unique and include at least two layers",
            ));
        }
    }
    Ok(())
}
pub fn check(schema: &Value, value: &Value, path: &str) -> Result<()> {
    let fail = |message: &str| EngineError::invalid(format!("{path} {message}"));
    if let Some(any) = schema["anyOf"].as_array() {
        if !any.iter().any(|s| check(s, value, path).is_ok()) {
            return Err(fail("does not match an allowed value"));
        }
    }
    if let Some(required) = schema["required"].as_array() {
        for key in required.iter().filter_map(Value::as_str) {
            if value.get(key).is_none() {
                return Err(fail(&format!("requires {key}")));
            }
        }
    }
    match schema["type"].as_str() {
        Some("object") => {
            let object = value.as_object().ok_or_else(|| fail("must be an object"))?;
            for (key, v) in object {
                if let Some(s) = schema["properties"].get(key) {
                    check(s, v, &format!("{path}.{key}"))?;
                } else if schema["additionalProperties"] == false {
                    return Err(fail(&format!("contains unsupported field {key}")));
                } else if schema["additionalProperties"].is_object() {
                    check(&schema["additionalProperties"], v, &format!("{path}.{key}"))?;
                }
            }
        }
        Some("array") => {
            let a = value.as_array().ok_or_else(|| fail("must be an array"))?;
            if schema["minItems"]
                .as_u64()
                .is_some_and(|m| a.len() < m as usize)
                || schema["maxItems"]
                    .as_u64()
                    .is_some_and(|m| a.len() > m as usize)
            {
                return Err(fail("has an invalid item count"));
            }
            for (i, v) in a.iter().enumerate() {
                check(&schema["items"], v, &format!("{path}[{i}]"))?;
            }
        }
        Some("string") => {
            let s = value.as_str().ok_or_else(|| fail("must be a string"))?;
            let length = s.encode_utf16().count();
            if schema["minLength"]
                .as_u64()
                .is_some_and(|m| length < m as usize)
                || schema["maxLength"]
                    .as_u64()
                    .is_some_and(|m| length > m as usize)
            {
                return Err(fail("has invalid string length"));
            }
            if let Some(pattern) = schema["pattern"].as_str() {
                if !regex::Regex::new(pattern)
                    .map_err(|_| fail("uses an invalid schema pattern"))?
                    .is_match(s)
                {
                    return Err(fail("has invalid format"));
                }
            }
        }
        Some("number" | "integer") => {
            let n = value
                .as_f64()
                .filter(|n| n.is_finite())
                .ok_or_else(|| fail("must be finite numeric input"))?;
            if schema["type"] == "integer" && n.fract() != 0.0 {
                return Err(fail("must be integer"));
            }
            if schema["minimum"].as_f64().is_some_and(|m| n < m)
                || schema["maximum"].as_f64().is_some_and(|m| n > m)
                || schema["exclusiveMinimum"].as_f64().is_some_and(|m| n <= m)
            {
                return Err(fail("is outside allowed bounds"));
            }
        }
        Some("boolean") if !value.is_boolean() => return Err(fail("must be boolean")),
        Some("null") if !value.is_null() => return Err(fail("must be null")),
        _ => {}
    }
    if let Some(values) = schema["enum"].as_array() {
        if !values.contains(value) {
            return Err(fail("has an unsupported value"));
        }
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn catalog_has_pinned_50_tools() {
        assert_eq!(tools().len(), 50);
        assert!(validate("create_shape", &serde_json::json!({"type":"rect"})).is_err());
        assert!(validate("get_context", &serde_json::json!({"authorId":"fake"})).is_err());
    }
}
