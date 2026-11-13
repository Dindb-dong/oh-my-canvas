use super::*;
use serde_json::Map;

pub(super) fn append_update(token: &Value, params: &Value, patch: &mut Value) -> Result<()> {
    if let Some(scopes) = params.get("scopes") {
        let known = [
            "ALL_SCOPES",
            "TEXT_CONTENT",
            "WIDTH_HEIGHT",
            "GAP",
            "ALL_FILLS",
            "FRAME_FILL",
            "SHAPE_FILL",
            "TEXT_FILL",
            "STROKE_COLOR",
            "STROKE_FLOAT",
            "EFFECT_COLOR",
            "EFFECT_FLOAT",
            "OPACITY",
            "CORNER_RADIUS",
            "FONT_FAMILY",
            "FONT_STYLE",
            "FONT_WEIGHT",
            "FONT_SIZE",
            "LINE_HEIGHT",
            "LETTER_SPACING",
            "PARAGRAPH_SPACING",
            "PARAGRAPH_INDENT",
        ];
        if scopes.is_null() {
            patch["scopes"] = Value::Null;
        } else {
            let scopes = scopes
                .as_array()
                .filter(|scopes| scopes.len() <= known.len())
                .ok_or_else(|| EngineError::invalid("scopes must be an array or null"))?;
            let mut selected = BTreeSet::new();
            for scope in scopes {
                let scope = scope
                    .as_str()
                    .filter(|scope| known.contains(scope))
                    .ok_or_else(|| EngineError::invalid("Unknown variable scope"))?;
                selected.insert(scope);
            }
            patch["scopes"] = if selected.contains("ALL_SCOPES") {
                Value::Null
            } else {
                json!(selected)
            };
        }
    }
    if let Some(hidden) = params.get("hiddenFromPublishing") {
        patch["hiddenFromPublishing"] = json!(
            hidden
                .as_bool()
                .ok_or_else(|| EngineError::invalid("hiddenFromPublishing must be boolean"))?
        );
    }
    if let Some(code) = params.get("codeSyntax") {
        let code = code
            .as_object()
            .ok_or_else(|| EngineError::invalid("codeSyntax must be an object"))?;
        let mut next = token["codeSyntax"].as_object().cloned().unwrap_or_default();
        for (platform, syntax) in code {
            if !matches!(platform.as_str(), "WEB" | "iOS" | "ANDROID") {
                return Err(EngineError::invalid("Unknown code syntax platform"));
            }
            let syntax = syntax
                .as_str()
                .ok_or_else(|| EngineError::invalid("Code syntax must be a string"))?
                .trim();
            if syntax.is_empty() {
                next.remove(platform);
            } else {
                next.insert(
                    platform.clone(),
                    json!(syntax.chars().take(500).collect::<String>()),
                );
            }
        }
        patch["codeSyntax"] = json!(next);
    }
    Ok(())
}

pub(super) fn references<'a>(value: &'a Value, output: &mut Vec<&'a str>) {
    if let Some(id) = value.get("$token").and_then(Value::as_str) {
        output.push(id);
    }
    match value {
        Value::Object(items) => items.values().for_each(|value| references(value, output)),
        Value::Array(items) => items.iter().for_each(|value| references(value, output)),
        _ => {}
    }
}

fn contains_token(value: &Value, gone: &BTreeSet<&str>) -> bool {
    value
        .get("$token")
        .and_then(Value::as_str)
        .is_some_and(|id| gone.contains(id))
        || match value {
            Value::Object(items) => items.values().any(|value| contains_token(value, gone)),
            Value::Array(items) => items.iter().any(|value| contains_token(value, gone)),
            _ => false,
        }
}

fn value_for(
    context: &omc_style::ReferenceContext<'_>,
    node: &Node,
    value: &Value,
    gone: &BTreeSet<&str>,
) -> Result<Value> {
    if value
        .get("$token")
        .and_then(Value::as_str)
        .is_some_and(|id| gone.contains(id))
        || (value.get("$colorAlpha").is_some() || value.get("$colorMix").is_some())
            && contains_token(value, gone)
    {
        return context
            .resolve_value(value, Some(node))
            .map_err(EngineError::invalid);
    }
    Ok(match value {
        Value::Array(values) => Value::Array(
            values
                .iter()
                .map(|value| value_for(context, node, value, gone))
                .collect::<Result<_>>()?,
        ),
        Value::Object(values) => Value::Object(
            values
                .iter()
                .map(|(key, value)| Ok((key.clone(), value_for(context, node, value, gone)?)))
                .collect::<Result<_>>()?,
        ),
        _ => value.clone(),
    })
}

pub(super) fn delete(
    snapshot: &DocumentSnapshot,
    tokens: &Entries,
    gone: &BTreeSet<&str>,
    collection: Option<&str>,
    commands: &mut Vec<Command>,
) -> Result<()> {
    let context = omc_style::ReferenceContext::new(snapshot);
    for node in snapshot.nodes.values() {
        let mut patch = Properties::new();
        let mut text = None;
        let mut runs = None;
        for (key, value) in &node.properties {
            if key == "figcraftVariableBindings" {
                if let Some(mut bindings) = value.as_object().cloned() {
                    let (effective, _) = context.properties(node);
                    let fields: Vec<_> = bindings
                        .iter()
                        .filter(|(_, value)| contains_token(value, gone))
                        .map(|(field, _)| field.clone())
                        .collect();
                    for field in &fields {
                        if let Some(value) = effective.get(field) {
                            if field == "text" && node.kind == NodeKind::Text {
                                text = Some(value.clone());
                            } else {
                                patch.insert(field.clone(), value.clone());
                            }
                        }
                        bindings.remove(field);
                    }
                    if !fields.is_empty() {
                        patch.insert(key.clone(), json!(bindings));
                    }
                }
            } else if key == "figcraftVariableModes" {
                if let Some(collection) = collection
                    && let Some(mut modes) = value.as_object().cloned()
                    && modes.remove(collection).is_some()
                {
                    patch.insert(key.clone(), json!(modes));
                }
            } else if contains_token(value, gone) {
                let literal = value_for(&context, node, value, gone)?;
                if key == "text" && node.kind == NodeKind::Text {
                    text = Some(literal);
                } else if key == "textRuns" && node.kind == NodeKind::Text {
                    runs = Some(literal);
                } else {
                    patch.insert(key.clone(), literal);
                }
            }
        }
        if let Some(text) = text {
            commands.push(Command::TextReplace {
                node_id: node.id.clone(),
                text: text
                    .as_str()
                    .ok_or_else(|| EngineError::invalid("Text variable did not resolve to text"))?
                    .into(),
            });
        } else if let Some(runs) = runs {
            let mut updated = node.clone();
            updated.properties.insert("textRuns".into(), runs);
            crate::libraries::update_text(node, &updated, commands)?;
        }
        if !patch.is_empty() {
            commands.push(Command::NodeSet {
                node_id: node.id.clone(),
                properties: patch,
            });
        }
    }
    for (id, style) in resources::catalogs(&snapshot.metadata, "styles") {
        if contains_token(&style["value"], gone) {
            let literal = value_for(&context, &Node::new(NodeKind::Frame), &style["value"], gone)?;
            commands.push(catalog("styles", &id, json!({"value":literal}))?);
        }
    }
    for (id, token) in tokens {
        if gone.contains(id.as_str()) {
            commands.push(catalog("tokens", id, json!({"deleted":true}))?);
            continue;
        }
        let mut patch = json!({});
        let mut probe = Node::new(NodeKind::Frame);
        if contains_token(&token["value"], gone) {
            patch["value"] = value_for(&context, &probe, &token["value"], gone)?;
        }
        if let Some(mut modes) = token["modes"].as_object().cloned() {
            let mut changed = false;
            for (mode, value) in &mut modes {
                if contains_token(value, gone) {
                    if let Some(collection) = token["collectionId"].as_str() {
                        probe
                            .properties
                            .insert("figcraftVariableModes".into(), json!({collection:mode}));
                    }
                    *value = value_for(&context, &probe, value, gone)?;
                    changed = true;
                }
            }
            if changed {
                patch["modes"] = json!(modes);
            }
        }
        if patch != json!({}) {
            commands.push(catalog("tokens", id, patch)?);
        }
    }
    if let Some(collection) = collection {
        commands.push(collection_patch(collection, &json!({"deleted":true}))?);
    }
    Ok(())
}

pub(super) fn variable_patch_metadata(token: &Value) -> Map<String, Value> {
    [
        "description",
        "hiddenFromPublishing",
        "scopes",
        "codeSyntax",
    ]
    .into_iter()
    .filter_map(|key| token.get(key).map(|value| (key.into(), value.clone())))
    .collect()
}

pub(super) fn extension(
    collections: &Entries,
    source: &Value,
    params: &Value,
    commands: &mut Vec<Command>,
) -> Result<Value> {
    let base = params["name"]
        .as_str()
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| {
            format!(
                "{} (extended)",
                source["name"].as_str().unwrap_or("Collection")
            )
        });
    let mut name = base.clone();
    let mut suffix = 2;
    while collections
        .values()
        .any(|collection| collection["name"] == name)
    {
        name = format!("{base} {suffix}");
        suffix += 1;
    }
    let id = new_id("collection");
    commands.push(collection_patch(
        &id,
        &json!({
            "name":name,"extendsCollection":source["id"],"modes":source["modes"],
        }),
    )?);
    Ok(json!({"id":id}))
}

pub(crate) fn sync_extensions(
    snapshot: &DocumentSnapshot,
    commands: &mut Vec<Command>,
) -> Result<()> {
    let original = resources::catalogs(&snapshot.metadata, "figcraftCollections");
    let touches_collection = commands.iter().any(|command| match command {
        Command::DocumentMetadata { properties } => properties
            .keys()
            .any(|key| key.starts_with("figcraftCollections/")),
        Command::CatalogSet { namespace, .. } => namespace == "tokens",
        _ => false,
    });
    if !touches_collection {
        return Ok(());
    }
    let mut collections = original;
    let mut tokens = resources::catalogs(&snapshot.metadata, "tokens");
    for command in commands.iter() {
        match command {
            Command::DocumentMetadata { properties } => {
                for (key, value) in properties {
                    let Some((id, field)) = key
                        .strip_prefix("figcraftCollections/")
                        .and_then(|rest| rest.split_once('/'))
                    else {
                        continue;
                    };
                    let collection = collections
                        .entry(id.into())
                        .or_insert_with(|| json!({"id":id}));
                    collection[field] = value.clone();
                }
            }
            Command::CatalogSet {
                namespace,
                entity_id,
                properties,
            } if namespace == "tokens" => {
                let token = tokens
                    .entry(entity_id.clone())
                    .or_insert_with(|| json!({"id":entity_id}));
                token.as_object_mut().unwrap().extend(properties.clone());
            }
            _ => {}
        }
    }
    collections.retain(|_, row| row["deleted"] != true);
    tokens.retain(|_, row| row["deleted"] != true);
    let mut extensions: BTreeMap<_, _> = collections
        .iter()
        .filter_map(|(id, row)| {
            row["extendsCollection"]
                .as_str()
                .map(|parent| (id.clone(), parent.to_owned()))
        })
        .collect();
    while !extensions.is_empty() {
        let (id, parent) = extensions
            .iter()
            .find(|(_, parent)| !extensions.contains_key(*parent))
            .map(|(id, parent)| (id.clone(), parent.clone()))
            .ok_or_else(|| EngineError::invalid("Variable collection extension cycle"))?;
        extensions.remove(&id);
        let parent_modes = collections.get(&parent).map(|row| row["modes"].clone());
        let parent_present = parent_modes.is_some();
        if let Some(modes) = parent_modes {
            if collections[&id]["modes"] != modes {
                commands.push(collection_patch(&id, &json!({"modes":modes}))?);
                collections.get_mut(&id).unwrap()["modes"] = modes;
            }
        } else {
            commands.push(collection_patch(&id, &json!({"extendsCollection":null}))?);
            collections.get_mut(&id).unwrap()["extendsCollection"] = Value::Null;
        }
        let modes: Vec<_> = collections[&id]["modes"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|mode| mode["id"].as_str())
            .map(str::to_owned)
            .collect();
        let default = modes
            .first()
            .ok_or_else(|| EngineError::invalid("Collection has no modes"))?;
        let parent_tokens: Vec<_> = if parent_present {
            tokens
                .values()
                .filter(|token| token["collectionId"] == parent)
                .cloned()
                .collect()
        } else {
            Vec::new()
        };
        let parents: BTreeSet<_> = parent_tokens
            .iter()
            .filter_map(|token| token["id"].as_str())
            .collect();
        let mut local: Vec<_> = tokens
            .iter()
            .filter(|(_, token)| token["collectionId"] == id)
            .map(|(id, token)| (id.clone(), token.clone()))
            .collect();
        for source in parent_tokens.iter() {
            let parent = string(source, "id")?;
            let inherited = local
                .iter()
                .find(|(_, token)| token["extendsVariable"] == parent);
            let key = inherited.map_or_else(
                || crate::libraries::stable_id("token", &id, parent),
                |(id, _)| id.clone(),
            );
            if inherited.is_none()
                && local
                    .iter()
                    .any(|(_, token)| token["name"] == source["name"])
            {
                continue;
            }
            let current = inherited.map(|(_, token)| token);
            let overrides: BTreeSet<_> = current
                .and_then(|token| token["overrideModes"].as_array())
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .filter(|mode| modes.iter().any(|id| id == *mode))
                .collect();
            let mut values = Map::new();
            for mode in &modes {
                let existing = current.and_then(|token| token["modes"].get(mode));
                let value = if overrides.contains(mode.as_str()) && existing.is_some() {
                    existing.unwrap()
                } else {
                    source["modes"].get(mode).unwrap_or(&source["value"])
                };
                values.insert(mode.clone(), value.clone());
            }
            let mut token = current.cloned().unwrap_or_else(|| source.clone());
            token["id"] = json!(key);
            token["libraryId"] = Value::Null;
            token["sourceVariableId"] = Value::Null;
            token["name"] = source["name"].clone();
            token["type"] = source["type"].clone();
            token["collectionId"] = json!(id);
            token["extendsVariable"] = json!(parent);
            token["overrideModes"] = json!(overrides);
            token["value"] = values[default].clone();
            token["modes"] = json!(values);
            if current != Some(&token) {
                commands.push(catalog("tokens", &key, token.clone())?);
                tokens.insert(key.clone(), token.clone());
            }
            if current.is_none() {
                local.push((key, token));
            }
        }
        for (key, mut token) in local {
            let inherited = token["extendsVariable"].as_str();
            if inherited.is_some_and(|id| parents.contains(id)) {
                continue;
            }
            let mut patch = json!({});
            if inherited.is_some() {
                patch["extendsVariable"] = Value::Null;
                patch["overrideModes"] = json!([]);
            }
            let values: Map<_, _> = modes
                .iter()
                .map(|mode| {
                    let value = token["modes"].get(mode).unwrap_or(&token["value"]);
                    (mode.clone(), value.clone())
                })
                .collect();
            if token["modes"] != json!(values) {
                patch["value"] = values[default].clone();
                patch["modes"] = json!(values);
            }
            if patch != json!({}) {
                token
                    .as_object_mut()
                    .unwrap()
                    .extend(patch.as_object().unwrap().clone());
                tokens.insert(key.clone(), token);
                commands.push(catalog("tokens", &key, patch)?);
            }
        }
    }
    Ok(())
}

pub(super) fn path_type(field: &str) -> Option<&'static str> {
    match field.split('/').collect::<Vec<_>>().as_slice() {
        ["fills" | "strokes", _, "color"]
        | ["fills" | "strokes", _, "stops", _, "color"]
        | ["effects", _, "color"] => Some("color"),
        ["effects", _, "offsetX" | "offsetY" | "radius" | "spread"]
        | ["layoutGrids", _, "size" | "count" | "gutter" | "offset"]
        | [
            "gap" | "paddingHorizontal" | "paddingVertical" | "paddingTop" | "paddingRight"
            | "paddingBottom" | "paddingLeft",
        ] => Some("number"),
        _ => None,
    }
}

pub(super) fn nested_binding(
    references: &omc_style::ReferenceContext<'_>,
    node: &Node,
    field: &str,
    reference: Option<&Value>,
) -> Result<Option<Properties>> {
    let fields = field.split('/').collect::<Vec<_>>();
    let stack = match fields.as_slice() {
        ["fill"] => "fills",
        ["stroke"] => "strokes",
        [key @ ("fills" | "strokes" | "layoutGrids" | "effects"), ..] => key,
        [
            "gap" | "paddingHorizontal" | "paddingVertical" | "paddingTop" | "paddingRight"
            | "paddingBottom" | "paddingLeft",
        ] => "layout",
        _ => return Ok(None),
    };
    let mut source = node.properties.get(stack).cloned();
    if source.is_none() {
        if matches!(field, "fill" | "stroke") {
            return Ok(None);
        }
        if stack == "effects" {
            source = node.properties.get("shadows").cloned();
        }
        if source.is_none() && matches!(stack, "fills" | "strokes") {
            let (effective, _) = references.properties(node);
            source = effective.get(stack).cloned().or_else(|| {
                let scalar = if stack == "fills" { "fill" } else { "stroke" };
                effective
                    .get(scalar)
                    .map(|color| json!([{"type":"solid","color":color}]))
            });
        }
    }
    let mut value =
        source.ok_or_else(|| EngineError::invalid(format!("Layer has no {stack} to bind")))?;
    let apply = |value: &mut Value| -> Result<()> {
        if let Some(reference) = reference {
            *value = reference.clone();
        } else if value.get("$token").is_some() {
            *value = references
                .resolve_value(value, Some(node))
                .map_err(EngineError::invalid)?;
        }
        Ok(())
    };
    match fields.as_slice() {
        ["fill" | "stroke"] => {
            let paint = value
                .get_mut(0)
                .filter(|paint| paint["type"] == "solid" || paint["type"].is_null())
                .ok_or_else(|| EngineError::invalid("First paint must be a solid color"))?;
            apply(&mut paint["color"])?;
        }
        ["fills" | "strokes", paint, "color"] => {
            let index = paint
                .parse::<usize>()
                .map_err(|_| EngineError::invalid("Invalid paint index"))?;
            let paint = value
                .get_mut(index)
                .filter(|paint| paint["type"] == "solid" || paint["type"].is_null())
                .ok_or_else(|| EngineError::invalid("Expected a solid paint at this index"))?;
            apply(&mut paint["color"])?;
        }
        ["fills" | "strokes", paint, "stops", stop, "color"] => {
            let index = |value: &str| {
                value
                    .parse::<usize>()
                    .map_err(|_| EngineError::invalid("Invalid paint or stop index"))
            };
            let paint = value
                .get_mut(index(paint)?)
                .ok_or_else(|| EngineError::invalid("Paint index out of bounds"))?;
            let stops = if paint.get("gradient").is_some_and(Value::is_object) {
                &mut paint["gradient"]["stops"]
            } else {
                &mut paint["stops"]
            };
            let stop = stops
                .get_mut(index(stop)?)
                .ok_or_else(|| EngineError::invalid("Gradient stop index out of bounds"))?;
            apply(&mut stop["color"])?;
        }
        ["layoutGrids" | "effects", index, field] => {
            let index = index
                .parse::<usize>()
                .map_err(|_| EngineError::invalid("Invalid layer property index"))?;
            let row = value
                .get_mut(index)
                .filter(|row| row.is_object())
                .ok_or_else(|| EngineError::invalid("Layer property index out of bounds"))?;
            if stack == "effects" && row.get("type").is_none() {
                row["type"] = json!(if row["style"] == "inner" {
                    "innerShadow"
                } else {
                    "dropShadow"
                });
            }
            if stack == "effects"
                && !matches!(
                    row["type"].as_str(),
                    Some("dropShadow" | "innerShadow" | "layerBlur" | "backgroundBlur")
                )
            {
                return Err(unsupported(
                    "This effect is not projected by the native renderer",
                ));
            }
            apply(&mut row[*field])?;
        }
        ["gap"] => {
            if !value.is_object() {
                return Err(EngineError::invalid("Layer has no editable auto layout"));
            }
            apply(&mut value["gap"])?;
        }
        [side] => {
            if !value.is_object() {
                return Err(EngineError::invalid("Layer has no editable auto layout"));
            }
            let sides: &[&str] = match *side {
                "paddingHorizontal" => &["left", "right"],
                "paddingVertical" => &["top", "bottom"],
                "paddingTop" => &["top"],
                "paddingRight" => &["right"],
                "paddingBottom" => &["bottom"],
                _ => &["left"],
            };
            if !value["padding"].is_object() {
                let old = value["padding"].clone();
                value["padding"] = json!({"top":old,"right":old,"bottom":old,"left":old});
            }
            for side in sides {
                apply(&mut value["padding"][*side])?;
            }
        }
        _ => return Ok(None),
    }
    let mut patch = Properties::from([(stack.into(), value)]);
    if stack == "effects" {
        patch.insert("figcraftBoundEffects".into(), json!(true));
    }
    Ok(Some(patch))
}
