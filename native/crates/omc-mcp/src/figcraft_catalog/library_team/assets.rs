use super::*;
use crate::figcraft_file::{encode_color, read_color};

const STYLE_SLOTS: &[(&str, &str)] = &[
    ("fill", "fillStyleId"),
    ("stroke", "strokeStyleId"),
    ("text", "textStyleId"),
    ("effect", "effectStyleId"),
];

pub(super) struct Assets {
    pub styles: Vec<Value>,
    pub collections: Vec<Value>,
    pub variables: Vec<Value>,
}

fn color(value: &Value) -> Result<Value> {
    encode_color(
        value
            .as_str()
            .ok_or_else(|| invalid("Expected a color literal"))?,
    )
}

fn solid(paint: &Value) -> Result<Value> {
    let color = if paint.is_string() {
        color(paint)?
    } else if paint["type"] == "solid" {
        color(&paint["color"])?
    } else {
        return Err(unsupported("Team archives support solid paint styles"));
    };
    Ok(
        json!({"type":"solid","color":color,"opacity":paint["opacity"].as_f64().unwrap_or(1.),
        "visible":paint["visible"]!=false,"blend":paint["blend"].as_str().unwrap_or("normal")}),
    )
}

fn solid_native(paint: &Value) -> Result<Value> {
    if paint["type"] != "solid" || paint.get("blend").is_some_and(|blend| blend != "normal") {
        return Err(unsupported(
            "Team archives support normal solid paint styles",
        ));
    }
    Ok(json!({"type":"solid","color":read_color(&paint["color"])?,
        "opacity":paint["opacity"].as_f64().unwrap_or(1.),"visible":paint["visible"]!=false}))
}

fn variable_to_archive(kind: &str, value: &Value) -> Result<Value> {
    if let Some(alias) = value["$token"].as_str() {
        return Ok(json!({"type":"alias","value":alias}));
    }
    if let Some(alpha) = value.get("$colorAlpha") {
        return Ok(
            json!({"type":"colorAlpha","value":{"variable":alpha["color"]["$token"],"opacity":alpha["opacity"]}}),
        );
    }
    if let Some(mix) = value.get("$colorMix") {
        let operand = |value: &Value| -> Result<Value> {
            if let Some(alias) = value["$token"].as_str() {
                Ok(json!({"variable":alias}))
            } else {
                Ok(json!({"literal":color(value)?}))
            }
        };
        return Ok(
            json!({"type":"colorMix","value":{"from":operand(&mix["from"])?,"to":operand(&mix["to"])?,"t":mix["t"]}}),
        );
    }
    let value = match kind {
        "color" => color(value)?,
        "number" if value.is_number() => value.clone(),
        "string" if value.is_string() => value.clone(),
        "boolean" if value.is_boolean() => value.clone(),
        _ => return Err(invalid("Invalid library variable value")),
    };
    Ok(json!({"type":kind,"value":value}))
}

fn variable_from_archive(kind: &str, value: &Value) -> Result<Value> {
    let data = &value["value"];
    match string(value, "type")? {
        "alias" => Ok(json!({"$token":string(value,"value")?})),
        "colorAlpha" if kind == "color" => Ok(
            json!({"$colorAlpha":{"color":{"$token":string(data,"variable")?},"opacity":data["opacity"]}}),
        ),
        "colorMix" if kind == "color" => {
            let operand = |value: &Value| -> Result<Value> {
                if let Some(alias) = value["variable"].as_str() {
                    Ok(json!({"$token":alias}))
                } else {
                    Ok(json!(read_color(&value["literal"])?))
                }
            };
            Ok(
                json!({"$colorMix":{"from":operand(&data["from"])?,"to":operand(&data["to"])?,"t":data["t"]}}),
            )
        }
        "color" if kind == "color" => Ok(json!(read_color(data)?)),
        "number" if kind == "number" && data.is_number() => Ok(data.clone()),
        "string" if kind == "string" && data.is_string() => Ok(data.clone()),
        "boolean" if kind == "boolean" && data.is_boolean() => Ok(data.clone()),
        _ => Err(invalid("Invalid archive variable value")),
    }
}

pub(super) fn encode(publication: &Value) -> Result<(Assets, Assets)> {
    let style_rows = rows(publication, "styles")?;
    let collection_rows = rows(publication, "collections")?;
    let variable_rows = rows(publication, "variables")?;
    let styles = style_rows
        .iter()
        .map(|(id, row)| {
            if row["type"] != "paint" {
                return Err(unsupported("Team archive export for non-paint styles"));
            }
            let value = &row["value"];
            let paints = if let Some(paints) = value.as_array() {
                paints.iter().map(solid).collect::<Result<Vec<_>>>()?
            } else if let Some(paints) = value["fills"].as_array() {
                paints.iter().map(solid).collect::<Result<Vec<_>>>()?
            } else if value["fill"].is_string() {
                vec![solid(&value["fill"])?]
            } else {
                vec![solid(value)?]
            };
            Ok(
                json!({"id":id,"name":row["name"],"type":"paint","paints":paints,
            "description":row["description"].as_str().unwrap_or_default()}),
            )
        })
        .collect::<Result<Vec<_>>>()?;
    let collections = collection_rows
        .iter()
        .map(|(id, row)| {
            let mut result = json!({"id":id,"name":row["name"],"modes":row["modes"]});
            if let Some(extends) = row["extendsCollection"].as_str() {
                if !collection_rows.contains_key(extends) {
                    return Err(unsupported(
                        "Team archive with a collection extending an unpublished collection",
                    ));
                }
                result["extends"] = json!(extends);
            }
            Ok(result)
        })
        .collect::<Result<Vec<_>>>()?;
    let variables = variable_rows.iter().map(|(id,row)| {
        let kind = string(row,"type")?;
        let collection = string(row,"collectionId")?;
        let source = &collection_rows.get(collection).ok_or_else(|| invalid("Variable collection is missing"))?["modes"];
        let values = source.as_array().ok_or_else(|| invalid("Collection has no modes"))?
            .iter().map(|mode| {
                let mode = string(mode,"id")?;
                let value = row["modes"].get(mode).unwrap_or(&row["value"]);
                Ok((mode.to_owned(), variable_to_archive(kind,value)?))
            }).collect::<Result<Map<String,Value>>>()?;
        let mut result = json!({"id":id,"name":row["name"],"collection":collection,"resolvedType":kind,
            "values":values,"description":row["description"].as_str().unwrap_or_default()});
        for field in ["scopes","hiddenFromPublishing","codeSyntax"] {
            if let Some(value) = row.get(field).filter(|value| !value.is_null()) {
                result[field] = value.clone();
            }
        }
        if let Some(extends) = row["extendsVariable"].as_str() {
            if !variable_rows.contains_key(extends) {
                return Err(unsupported("Team archive with a variable extending an unpublished variable"));
            }
            result["extends"] = json!(extends);
            result["overrides"] = row["overrideModes"].as_array().map_or_else(|| json!([]), |modes| json!(modes));
        }
        Ok(result)
    }).collect::<Result<Vec<_>>>()?;
    let manifests = |rows: &Map<String, Value>, include_kind: bool, collection: bool| {
        rows.iter().map(|(id,row)| {
            let mut entry = json!({"id":id,"name":row["name"],"version":publication["version"],"published":row["published"]!=false});
            if include_kind {
                entry["type"] = row["type"].clone();
            }
            if collection {
                entry["collection"] = row["collectionId"].clone();
            }
            entry
        }).collect()
    };
    Ok((
        Assets {
            styles,
            collections,
            variables,
        },
        Assets {
            styles: manifests(style_rows, true, false),
            collections: manifests(collection_rows, false, false),
            variables: manifests(variable_rows, true, true),
        },
    ))
}

pub(super) struct NativeAssets {
    pub styles: Map<String, Value>,
    pub collections: Map<String, Value>,
    pub variables: Map<String, Value>,
}

pub(super) fn decode(doc: &Value, manifest: &Value) -> Result<NativeAssets> {
    let decode_table = |section: &str, table: &Value, convert: &dyn Fn(&Value) -> Result<Value>| {
        let manifest = manifest[section]
            .as_array()
            .ok_or_else(|| invalid("Invalid team asset manifest"))?;
        let rows = table
            .as_array()
            .ok_or_else(|| invalid("Invalid team asset table"))?;
        if manifest.len() > 500 || rows.len() > 500 {
            return Err(invalid("Team library asset table exceeds 500 entries"));
        }
        manifest
            .iter()
            .map(|entry| {
                let id = string(entry, "id")?;
                let row = rows
                    .iter()
                    .find(|row| row["id"] == id)
                    .ok_or_else(|| invalid("Team asset is missing from its snapshot"))?;
                let mut converted = convert(row)?;
                converted["id"] = json!(id);
                converted["name"] = row["name"].clone();
                converted["published"] = json!(entry["published"] != false);
                converted["sourceVersion"] = entry["version"].clone();
                Ok((id.to_owned(), converted))
            })
            .collect::<Result<Map<String, Value>>>()
    };
    let styles = decode_table("styles", &doc["styles"], &|row| {
        if row["type"] != "paint"
            || row["bound"]
                .as_object()
                .is_some_and(|bindings| !bindings.is_empty())
        {
            return Err(unsupported(
                "Team archive import for non-paint styles or style bindings",
            ));
        }
        let paints = row["paints"]
            .as_array()
            .ok_or_else(|| invalid("Invalid paint style"))?
            .iter()
            .map(solid_native)
            .collect::<Result<Vec<_>>>()?;
        Ok(
            json!({"type":"paint","value":paints,"description":row["description"].as_str().unwrap_or_default()}),
        )
    })?;
    let collections = decode_table("collections", &doc["variables"]["collections"], &|row| {
        let mut result = json!({"modes":row["modes"]});
        if let Some(extends) = row["extends"].as_str() {
            result["extendsCollection"] = json!(extends);
        }
        Ok(result)
    })?;
    let variables = decode_table("variables", &doc["variables"]["variables"], &|row| {
        let kind = string(row, "resolvedType")?;
        let collection = string(row, "collection")?;
        let collection_data = collections
            .get(collection)
            .ok_or_else(|| invalid("Variable collection is missing"))?;
        let values = rows(row, "values")?
            .iter()
            .map(|(mode, value)| Ok((mode.clone(), variable_from_archive(kind, value)?)))
            .collect::<Result<Map<String, Value>>>()?;
        let default = collection_data["modes"]
            .as_array()
            .and_then(|modes| modes.first())
            .and_then(|mode| mode["id"].as_str())
            .ok_or_else(|| invalid("Invalid default mode"))?;
        let value = values
            .get(default)
            .or_else(|| values.values().next())
            .ok_or_else(|| invalid("Missing variable value"))?;
        let mut result = json!({"type":kind,"collectionId":collection,"value":value,"modes":values,
            "description":row["description"].as_str().unwrap_or_default()});
        for field in ["scopes", "hiddenFromPublishing", "codeSyntax"] {
            if let Some(value) = row.get(field) {
                result[field] = value.clone();
            }
        }
        if let Some(extends) = row["extends"].as_str() {
            result["extendsVariable"] = json!(extends);
            result["overrideModes"] = row["overrides"]
                .as_array()
                .map_or_else(|| json!([]), |modes| json!(modes));
        }
        Ok(result)
    })?;
    Ok(NativeAssets {
        styles,
        collections,
        variables,
    })
}

pub(super) fn take_style_links(properties: &mut Properties) -> Map<String, Value> {
    STYLE_SLOTS
        .iter()
        .filter_map(|(slot, key)| Some(((*slot).to_owned(), properties.remove(*key)?)))
        .collect()
}

pub(super) fn insert_style_links(value: &Value, properties: &mut Properties) {
    for (slot, key) in STYLE_SLOTS {
        if let Some(style) = value[*slot].as_str() {
            properties.insert((*key).to_owned(), json!(style));
        }
    }
}
