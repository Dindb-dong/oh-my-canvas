use super::*;

pub(crate) fn plan(
    snapshot: &DocumentSnapshot,
    collections: &Entries,
    tokens: &Entries,
    action: &str,
    params: &Value,
    commands: &mut Vec<Command>,
) -> Result<Value> {
    let result = match action {
        "createCollection" => {
            let collection = new_id("collection");
            let supplied = params
                .get("modes")
                .cloned()
                .unwrap_or_else(|| json!(["Mode 1"]));
            let values = supplied
                .as_array()
                .filter(|modes| !modes.is_empty() && modes.len() <= 64)
                .ok_or_else(|| EngineError::invalid("Expected 1–64 mode names"))?;
            let mut seen = BTreeSet::new();
            let mut modes = Vec::new();
            for value in values {
                let mode = value
                    .as_str()
                    .map(str::trim)
                    .filter(|mode| !mode.is_empty() && seen.insert(*mode))
                    .ok_or_else(|| EngineError::invalid("Expected distinct nonempty mode names"))?;
                modes.push(json!({"id":new_id("mode"),"name":mode}));
            }
            commands.push(collection_patch(
                &collection,
                &json!({"name":name(params)?,"modes":modes}),
            )?);
            json!({"id":collection})
        }
        "renameCollection" | "addMode" | "renameMode" => {
            let current = entry(&collections, string(params, "collection")?)?;
            let collection = string(current, "id")?;
            let next_name = name(params)?;
            if current["libraryId"].is_string()
                || action != "renameCollection" && current["extendsCollection"].is_string()
            {
                return Err(EngineError::invalid(
                    "Inherited or linked modes are read-only",
                ));
            }
            if action == "renameCollection" {
                commands.push(collection_patch(collection, &json!({"name":next_name}))?);
                json!({"ok":true})
            } else {
                let mut modes = current["modes"]
                    .as_array()
                    .ok_or_else(|| EngineError::invalid("Collection has no modes"))?
                    .clone();
                if modes.iter().any(|mode| mode["name"] == next_name) {
                    return Err(EngineError::invalid("Mode name is already in use"));
                }
                let id = if action == "addMode" {
                    if modes.len() >= 64 {
                        return Err(EngineError::invalid("Collection already has 64 modes"));
                    }
                    let from = params["from"]
                        .as_str()
                        .map(|name| mode_id(&modes, name))
                        .transpose()?
                        .unwrap_or(string(&modes[0], "id")?);
                    let id = new_id("mode");
                    for (token_id, token) in tokens
                        .iter()
                        .filter(|(_, token)| token["collectionId"] == collection)
                    {
                        let mut values = token["modes"].clone();
                        values[&id] = values.get(from).unwrap_or(&token["value"]).clone();
                        commands.push(catalog("tokens", token_id, json!({"modes":values}))?);
                    }
                    modes.push(json!({"id":id,"name":next_name}));
                    id
                } else {
                    let id = mode_id(&modes, string(params, "mode")?)?.to_owned();
                    modes.iter_mut().find(|mode| mode["id"] == id).unwrap()["name"] =
                        json!(next_name);
                    id
                };
                commands.push(collection_patch(collection, &json!({"modes":modes}))?);
                if action == "addMode" {
                    json!({"id":id})
                } else {
                    json!({"ok":true})
                }
            }
        }
        "moveMode" | "removeMode" => {
            let current = entry(&collections, string(params, "collection")?)?;
            if current["libraryId"].is_string() || current["extendsCollection"].is_string() {
                return Err(EngineError::invalid(
                    "Inherited or linked modes are read-only",
                ));
            }
            let id = string(current, "id")?;
            let mut modes = current["modes"]
                .as_array()
                .ok_or_else(|| EngineError::invalid("Collection has no modes"))?
                .clone();
            let mode = mode_id(&modes, string(params, "mode")?)?.to_owned();
            let from = modes.iter().position(|item| item["id"] == mode).unwrap();
            if action == "removeMode" && modes.len() == 1 {
                return Err(EngineError::invalid(
                    "A collection must keep at least one mode",
                ));
            }
            let moved = modes.remove(from);
            if action == "moveMode" {
                let to = params["to"]
                    .as_u64()
                    .filter(|to| *to <= modes.len() as u64)
                    .ok_or_else(|| EngineError::invalid("Mode index is out of range"))?;
                modes.insert(to as usize, moved);
            }
            let default = string(&modes[0], "id")?;
            for (token_id, token) in tokens
                .iter()
                .filter(|(_, token)| token["collectionId"] == id)
            {
                let mut values = token["modes"].clone();
                if action == "removeMode" {
                    values.as_object_mut().unwrap().remove(&mode);
                }
                let value = values.get(default).unwrap_or(&token["value"]).clone();
                values[default] = value.clone();
                let mut patch = json!({"value":value,"modes":values});
                if action == "removeMode" && token["activeMode"] == mode {
                    patch["activeMode"] = Value::Null;
                }
                commands.push(catalog("tokens", token_id, patch)?);
            }
            commands.push(collection_patch(id, &json!({"modes":modes}))?);
            json!({"ok":true})
        }
        "create" => {
            let current = entry(&collections, string(params, "collection")?)?;
            if current["libraryId"].is_string() {
                return Err(EngineError::invalid("Linked collections are read-only"));
            }

            let modes = current["modes"]
                .as_array()
                .ok_or_else(|| EngineError::invalid("Collection has no modes"))?;
            let default = string(&modes[0], "id")?;
            let kind = string(params, "type")?;
            let id = new_id("token");
            let mut values = json!({});
            if let Some(value) = params.get("value") {
                values[default] = token_value(&tokens, kind, value, &id)?;
            }
            if let Some(raw) = params.get("values") {
                for (mode, value) in raw
                    .as_object()
                    .ok_or_else(|| EngineError::invalid("values must map mode names to values"))?
                {
                    values[mode_id(modes, mode)?] = token_value(&tokens, kind, value, &id)?;
                }
            }
            if values.get(default).is_none() {
                return Err(EngineError::invalid("Default mode value required"));
            }
            commands.push(catalog("tokens", &id, json!({"collectionId":current["id"],"name":name(params)?,"type":kind,"description":params["description"],"value":values[default],"modes":values}))?);
            json!({"id":id})
        }
        "extendCollection" => {
            let source = entry(&collections, string(params, "collection")?)?;
            if source["libraryId"].is_string() {
                return Err(EngineError::invalid(
                    "Use library.extendCollection for a linked collection",
                ));
            }
            variable_ops::extension(&collections, source, params, commands)?
        }
        "resetOverride" => {
            let token = entry(&tokens, string(params, "variable")?)?;
            if !token["extendsVariable"].is_string() {
                return Err(EngineError::invalid(
                    "Only inherited variables have overrides",
                ));
            }
            let mut overrides: BTreeSet<_> = token["overrideModes"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .collect();
            if let Some(mode) = params["mode"].as_str() {
                let collection = entry(&collections, string(token, "collectionId")?)?;
                let modes = collection["modes"]
                    .as_array()
                    .ok_or_else(|| EngineError::invalid("Collection has no modes"))?;
                overrides.remove(mode_id(modes, mode)?);
            } else {
                overrides.clear();
            }
            commands.push(catalog(
                "tokens",
                string(token, "id")?,
                json!({"overrideModes":overrides}),
            )?);
            json!({"ok":true})
        }
        "set" | "update" | "duplicate" => {
            let token = entry(&tokens, string(params, "variable")?)?;
            let id = string(token, "id")?;
            if token["libraryId"].is_string() {
                return Err(EngineError::invalid("Library variables are read-only"));
            }
            if action == "duplicate" {
                let mut patch = token.clone();
                patch["name"] = json!(format!("{} copy", name(token)?));
                patch["extendsVariable"] = Value::Null;
                patch["overrideModes"] = json!([]);

                let id = new_id("token");
                commands.push(catalog("tokens", &id, patch)?);
                json!({"id":id})
            } else {
                let mut patch = json!({});
                if action == "update" {
                    if params.get("name").is_some() {
                        if token["extendsVariable"].is_string() {
                            return Err(EngineError::invalid(
                                "Inherited variable names are read-only",
                            ));
                        }
                        patch["name"] = json!(name(params)?);
                    }
                    if let Some(description) = params.get("description") {
                        patch["description"] = description.clone();
                    }
                    variable_ops::append_update(token, params, &mut patch)?;
                } else {
                    let value = params
                        .get("value")
                        .ok_or_else(|| EngineError::invalid("Variable value required"))?;
                    let value = token_value(&tokens, string(token, "type")?, value, id)?;
                    if let Some(collection) = token["collectionId"]
                        .as_str()
                        .and_then(|id| collections.get(id))
                    {
                        let modes = collection["modes"]
                            .as_array()
                            .ok_or_else(|| EngineError::invalid("Collection has no modes"))?;
                        let default = string(&modes[0], "id")?;
                        let mode = params["mode"]
                            .as_str()
                            .map(|mode| mode_id(modes, mode))
                            .transpose()?
                            .unwrap_or(default);
                        let mut values = token["modes"].clone();
                        values[mode] = value.clone();
                        patch["modes"] = values;
                        if token["extendsVariable"].is_string() {
                            let mut overrides: BTreeSet<_> = token["overrideModes"]
                                .as_array()
                                .into_iter()
                                .flatten()
                                .filter_map(Value::as_str)
                                .collect();
                            overrides.insert(mode);
                            patch["overrideModes"] = json!(overrides);
                        }
                        if mode == default {
                            patch["value"] = value;
                        }
                    } else if params["mode"].is_null() {
                        patch["value"] = value;
                    } else {
                        return Err(EngineError::invalid(
                            "This variable has no FigCraft collection modes",
                        ));
                    }
                }
                if patch.as_object().is_some_and(|p| !p.is_empty()) {
                    commands.push(catalog("tokens", id, patch)?);
                }
                json!({"ok":true})
            }
        }
        "delete" | "deleteCollection" => {
            let collection;
            let mut gone = BTreeSet::new();
            if action == "delete" {
                let token = entry(&tokens, string(params, "variable")?)?;
                if token["libraryId"].is_string() {
                    return Err(EngineError::invalid("Library variables are read-only"));
                }
                collection = None;
                gone.insert(string(token, "id")?);
            } else {
                let token_collection = entry(&collections, string(params, "collection")?)?;
                if token_collection["libraryId"].is_string() {
                    return Err(EngineError::invalid(
                        "Library variable collections are read-only",
                    ));
                }
                let id = string(token_collection, "id")?;
                collection = Some(id);
                gone.extend(
                    tokens
                        .iter()
                        .filter(|(_, token)| token["collectionId"] == id)
                        .map(|(id, _)| id.as_str()),
                );
            }
            variable_ops::delete(snapshot, &tokens, &gone, collection, commands)?;
            if collection.is_some() {
                json!({"deletedVariables":gone.len()})
            } else {
                json!({"ok":true})
            }
        }
        _ => return Err(EngineError::invalid("Unknown variable definition action")),
    };
    Ok(result)
}

pub(crate) fn bind(
    snapshot: &DocumentSnapshot,
    tokens: &Entries,
    requested: &str,
    variable: Option<&Value>,
    targets: Vec<String>,
    commands: &mut Vec<Command>,
) -> Result<()> {
    let (field, kind) = match requested {
        field @ ("fill" | "stroke" | "color") => (field, "color"),
        field @ ("fontFamily" | "fontStyle") => (field, "string"),
        "characters" => ("text", "string"),
        "visible" => ("visible", "boolean"),
        field @ ("width" | "height" | "fontSize" | "strokeWidth" | "opacity" | "cornerRadius"
        | "fontWeight" | "lineHeight" | "letterSpacing" | "wordSpacing") => (field, "number"),
        field if variable_ops::path_type(field).is_some() => {
            (field, variable_ops::path_type(field).unwrap())
        }
        _ => {
            return Err(unsupported(
                "The native node model does not yet support binding this field",
            ));
        }
    };
    let value = match variable {
        Some(Value::Null) => None,
        Some(Value::String(variable)) => {
            let token = entry(&tokens, variable)?;
            if token["type"] != kind {
                return Err(EngineError::invalid(
                    "Variable and property types do not match",
                ));
            }
            Some(json!({"$token":token["id"]}))
        }
        _ => {
            return Err(EngineError::invalid(
                "variable must be an ID, a name, or null",
            ));
        }
    };
    let references = omc_style::ReferenceContext::new(snapshot);
    for node_id in targets {
        let node = &snapshot.nodes[&node_id];
        if let Some(properties) =
            variable_ops::nested_binding(&references, node, requested, value.as_ref())?
        {
            commands.push(Command::NodeSet {
                node_id,
                properties,
            });
            continue;
        }
        if field == "text" && node.kind != NodeKind::Text {
            return Err(EngineError::invalid(
                "Only a text layer can bind characters",
            ));
        }
        if kind == "number" || field == "text" {
            let mut bindings = node
                .properties
                .get("figcraftVariableBindings")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            let mut properties = Properties::new();
            if let Some(value) = &value {
                bindings.insert(field.into(), value.clone());
            } else if bindings.remove(field).is_some() {
                let (effective, diagnostics) = references.properties(node);
                if field == "text" {
                    if diagnostics
                        .iter()
                        .any(|diagnostic| diagnostic.property.as_deref() == Some("text"))
                    {
                        return Err(EngineError::invalid(
                            "Cannot unbind an unresolved text variable",
                        ));
                    }
                    if let Some(text) = effective.get(field).and_then(Value::as_str)
                        && node.string("text") != Some(text)
                    {
                        commands.push(Command::TextReplace {
                            node_id: node_id.clone(),
                            text: text.into(),
                        });
                    }
                } else if let Some(value) = effective.get(field) {
                    properties.insert(field.into(), value.clone());
                }
            }
            properties.insert("figcraftVariableBindings".into(), json!(bindings));
            commands.push(Command::NodeSet {
                node_id,
                properties,
            });
            continue;
        }
        let new_value = if let Some(value) = &value {
            Some(value.clone())
        } else if node
            .properties
            .get(field)
            .is_some_and(|value| value.get("$token").is_some())
        {
            let (effective, diagnostics) = references.properties(node);
            if !diagnostics.is_empty() {
                return Err(EngineError::invalid("Cannot unbind an unresolved variable"));
            }
            effective.get(field).cloned()
        } else {
            None
        };
        if let Some(value) = new_value {
            commands.push(Command::NodeSet {
                node_id,
                properties: Properties::from([(field.into(), value)]),
            });
        }
    }
    Ok(())
}
