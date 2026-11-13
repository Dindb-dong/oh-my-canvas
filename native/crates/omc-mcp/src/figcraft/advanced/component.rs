use super::*;
use std::collections::BTreeMap;

pub(super) fn command(context: &Context, action: &str) -> Result<Value> {
    match action {
        "combineVariants" => combine(context),
        "addVariant" => add(context),
        "hideWhenPublishing" => hide(context),
        "resetOverride" => reset(context),
        "properties" => describe(context),
        "exposeInstance" => expose(context),
        "addProperty" | "editProperty" | "deleteProperty" | "bindProperty" => {
            property(context, action)
        }
        _ => Err(EngineError::invalid("Unknown component action")),
    }
}

const EXPOSED: &str = "exposedInstance";

fn expose(context: &Context) -> Result<Value> {
    let id = context.one()?;
    let node = &context.snapshot.nodes[&id];
    if node.kind != NodeKind::Instance {
        return Err(EngineError::invalid(
            "Only nested instances of a main component can be exposed",
        ));
    }
    let mut ancestor = node.parent_id.as_deref();
    let mut main = None;
    while let Some(id) = ancestor {
        let parent = &context.snapshot.nodes[id];
        if parent.kind == NodeKind::Instance {
            break;
        }
        if parent.kind == NodeKind::Component && parent.string("libraryId").is_none() {
            main = Some(parent);
            break;
        }
        ancestor = parent.parent_id.as_deref();
    }
    if main.is_none() {
        return Err(EngineError::invalid(
            "Only nested instances of a main component can be exposed",
        ));
    }
    let exposed = context
        .params
        .get("exposed")
        .map_or(Some(true), Value::as_bool)
        .ok_or_else(|| EngineError::invalid("exposed must be boolean"))?;
    if (node.properties.get(EXPOSED) == Some(&Value::Bool(true))) != exposed {
        context.commit(vec![context.patch(&id, EXPOSED, json!(exposed))])?;
    }
    Ok(json!({"id":context.alias(&id),"exposed":exposed}))
}

pub(super) fn exposed(context: &Context) -> Result<Value> {
    let projection = omc_scene::resolve_components(context.snapshot, Some(&context.state.root));
    let id = context
        .params
        .get("id")
        .or_else(|| context.selection.first())
        .ok_or_else(|| EngineError::invalid("Choose an instance"))?;
    let id = context
        .router
        .fig_layer(context.session, &projection.snapshot, id)?;
    let node = &projection.snapshot.nodes[&id];
    if node.kind != NodeKind::Instance {
        return Ok(json!({"instances":[]}));
    }
    let mut instances = Vec::new();
    let mut pending = children(&projection.snapshot, &id);
    pending.reverse();
    while let Some(child) = pending.pop() {
        if child.kind == NodeKind::Instance {
            if child.string("instanceId") == Some(&id)
                && child
                    .string("sourceNodeId")
                    .and_then(|source| context.snapshot.nodes.get(source))
                    .and_then(|source| source.properties.get(EXPOSED))
                    == Some(&Value::Bool(true))
            {
                instances.push(json!({"id":context.alias(&child.id),"name":child.string("name").unwrap_or_default()}));
            }
        } else {
            pending.extend(children(&projection.snapshot, &child.id).into_iter().rev());
        }
    }
    Ok(json!({"instances":instances}))
}

fn legacy(context: &Context, args: Value) -> Result<Value> {
    context.router.mutate(
        context.session,
        &context.snapshot.id,
        "component",
        &args,
        &Value::Null,
    )
}

fn choose_result(context: &Context, result: Value) -> Result<Value> {
    let raw = result["rawIds"]
        .as_array()
        .and_then(|ids| ids.first())
        .and_then(Value::as_str)
        .ok_or_else(|| EngineError::invalid("The component operation did not create a layer"))?;
    let id = json!(context.alias(raw));
    context.router.fig_selection(
        &(context.session.into(), context.snapshot.id.clone()),
        &[id.clone()],
    );
    Ok(json!({"id":id}))
}

fn combine(context: &Context) -> Result<Value> {
    let ids = context.many()?;
    let result = legacy(
        context,
        json!({"action":"combine","ids":ids,"_figcraftNames":true}),
    )?;
    choose_result(context, result)
}

fn axes(node: &Node) -> BTreeMap<String, String> {
    if let Some(props) = node
        .properties
        .get("variantProperties")
        .and_then(Value::as_array)
    {
        return props
            .iter()
            .filter_map(|axis| {
                Some((
                    axis["name"].as_str()?.to_owned(),
                    axis["value"].as_str()?.to_owned(),
                ))
            })
            .collect();
    }
    let label = node.string("name").unwrap_or_default();
    let pairs = label
        .split(',')
        .map(|pair| {
            pair.split_once('=')
                .map(|(name, value)| (name.trim().to_owned(), value.trim().to_owned()))
        })
        .collect::<Option<BTreeMap<_, _>>>();
    pairs.unwrap_or_else(|| BTreeMap::from([("Property 1".into(), "Default".into())]))
}

fn add(context: &Context) -> Result<Value> {
    let selected = context.one()?;
    let node = &context.snapshot.nodes[&selected];
    let base = if node.properties.get("isVariantSet") == Some(&Value::Bool(true)) {
        children(context.snapshot, &selected)
            .into_iter()
            .rev()
            .find(|node| node.kind == NodeKind::Component)
            .ok_or_else(|| EngineError::invalid("The component set has no variants"))?
    } else {
        node
    };
    if base.kind != NodeKind::Component || base.string("libraryId").is_some() {
        return Err(EngineError::invalid(
            "Choose a local component or component set",
        ));
    }
    let mut wanted = axes(base);
    let set = base
        .string("variantSetId")
        .map(|id| children(context.snapshot, id))
        .unwrap_or_else(|| vec![base]);
    if let Some(property) = context.params.get("property") {
        let property = property.as_str().unwrap_or_default();
        let value = string(context.params, "value")?.trim();
        if !wanted.contains_key(property) || value.is_empty() || value.contains([',', '=']) {
            return Err(EngineError::invalid(
                "Choose an existing variant property and a valid value",
            ));
        }
        wanted.insert(property.into(), value.into());
    } else {
        let property = wanted
            .keys()
            .next()
            .ok_or_else(|| EngineError::invalid("Variant has no axes"))?
            .clone();
        for index in set.len() + 1..=10_000 {
            wanted.insert(property.clone(), format!("Variant{index}"));
            if !set.iter().any(|node| axes(node) == wanted) {
                break;
            }
        }
    }
    let name = wanted
        .iter()
        .map(|(name, value)| format!("{name}={value}"))
        .collect::<Vec<_>>()
        .join(", ");
    let properties: Vec<_> = wanted
        .iter()
        .map(|(name, value)| json!({"name":name,"value":value}))
        .collect();
    let result = legacy(
        context,
        json!({"action":"add_variant","id":base.id,"name":name,"variantProperties":properties,"_figcraftNames":true}),
    )?;
    let ids = result["rawIds"]
        .as_array()
        .ok_or_else(|| EngineError::invalid("No variant created"))?;
    let first_variant = usize::from(base.string("variantSetId").is_none());
    let raw = ids
        .get(first_variant)
        .and_then(Value::as_str)
        .ok_or_else(|| EngineError::invalid("No variant created"))?;
    let id = json!(context.alias(raw));
    context.router.fig_selection(
        &(context.session.into(), context.snapshot.id.clone()),
        &[id.clone()],
    );
    Ok(json!({"id":id}))
}

fn hide(context: &Context) -> Result<Value> {
    let ids = context.many()?;
    let names = ids
        .iter()
        .map(|id| {
            let node = &context.snapshot.nodes[id];
            let mut candidate = Some(node);
            while let Some(current) = candidate {
                if current.kind == NodeKind::Component
                    || current.properties.get("isVariantSet") == Some(&Value::Bool(true))
                {
                    if current.string("libraryId").is_none() {
                        return Ok(node.string("name").unwrap_or("Component"));
                    }
                    break;
                }
                candidate = current
                    .parent_id
                    .as_ref()
                    .and_then(|id| context.snapshot.nodes.get(id));
            }
            Err(EngineError::invalid(
                "Choose local components or layers within them",
            ))
        })
        .collect::<Result<Vec<_>>>()?;
    let hidden = if let Some(on) = context.params.get("on") {
        on.as_bool()
            .ok_or_else(|| EngineError::invalid("on must be boolean"))?
    } else {
        !names.iter().all(|name| name.starts_with(['.', '_']))
    };
    let mut commands = Vec::new();
    for (id, name) in ids.iter().zip(names) {
        let next = if hidden && !name.starts_with(['.', '_']) {
            format!(".{name}")
        } else if !hidden {
            name.trim_start_matches(['.', '_']).to_owned()
        } else {
            name.into()
        };
        if next.is_empty() {
            return Err(EngineError::invalid("A component name cannot be empty"));
        }
        commands.push(context.patch(id, "name", json!(next)));
    }
    context.commit(commands)?;
    Ok(json!({"ids":ids.iter().map(|id| context.alias(id)).collect::<Vec<_>>(),"hidden":hidden}))
}

fn reset(context: &Context) -> Result<Value> {
    let id = context.one()?;
    let node = &context.snapshot.nodes[&id];
    if node.kind != NodeKind::Instance || node.string("componentId").is_none() {
        return Err(EngineError::invalid("Choose a linked instance"));
    }
    let all = context.params.get("group").is_none();
    let group = context.params["group"].as_str().unwrap_or_default();
    let fields: &[&str] = match group {
        "" if all => &[],
        "fills" => &["fill", "fills", "fillStyleId"],
        "strokes" => &["stroke", "strokes", "strokeWidth", "strokeStyleId"],
        "effects" => &["effects", "effectStyleId", "shadows", "blur"],
        "opacity" => &["opacity"],
        "visible" => &["visible"],
        "name" => &["name"],
        "corners" => &[
            "radius",
            "radii",
            "radiusTopLeft",
            "radiusTopRight",
            "radiusBottomRight",
            "radiusBottomLeft",
        ],
        "characters" => &["text", "textRuns"],
        "textStyle" => &[
            "fontFamily",
            "fontSize",
            "fontWeight",
            "fontStyle",
            "lineHeight",
            "letterSpacing",
            "textAlign",
            "textStyleId",
        ],
        "exports" => &["exports"],
        "interactions" => &[
            omc_style::prototype::CLICK,
            omc_style::prototype::INTERACTIONS,
        ],
        "size" => &["width", "height"],
        "position" => &["x", "y", "rotation", "transform"],
        "modes" => &["variableModes", "figcraftVariableModes"],
        "slot" => &[],
        "props" => &["componentProperties"],
        _ => {
            return Err(EngineError::new(
                "unsupported_feature",
                "This override group is not represented by the native instance model",
            ));
        }
    };
    let mut commands = Vec::new();
    if all || group == "props" {
        let mut unset = vec!["componentProperties".into()];
        if all {
            unset.push("overrides".into());
        }
        commands.push(Command::NodeUnset {
            node_id: id.clone(),
            properties: unset,
        });
    }
    if all || group == "slot" {
        if node.properties.contains_key("slotReplacements") {
            commands.push(Command::NodeUnset {
                node_id: id.clone(),
                properties: vec!["slotReplacements".into()],
            });
        }
        let node_ids = children(context.snapshot, &id)
            .into_iter()
            .filter(|child| child.properties.contains_key("slotContentFor"))
            .map(|child| child.id.clone())
            .collect::<Vec<_>>();
        if !node_ids.is_empty() {
            commands.push(Command::NodeDelete { node_ids });
        }
    }
    if !all && !fields.is_empty() {
        if let Some(overrides) = node.properties.get("overrides").and_then(Value::as_object) {
            let mut next = overrides.clone();
            for patch in next.values_mut().filter_map(Value::as_object_mut) {
                patch.retain(|key, _| !fields.contains(&key.as_str()));
            }
            next.retain(|_, patch| patch.as_object().is_some_and(|obj| !obj.is_empty()));
            commands.push(context.patch(&id, "overrides", json!(next)));
        }
    }
    context.commit(commands)?;
    Ok(json!({"ok":true}))
}

fn describe(context: &Context) -> Result<Value> {
    if let Ok(id) = context.one() {
        return describe_layer(context, &id);
    }
    let projection = omc_scene::resolve_components(context.snapshot, Some(&context.state.root));
    let resolved = Context {
        snapshot: &projection.snapshot,
        ..*context
    };
    describe_layer(&resolved, &resolved.one()?)
}

pub(super) fn describe_layer(context: &Context, raw: &str) -> Result<Value> {
    let node = &context.snapshot.nodes[raw];
    let instance = node.kind == NodeKind::Instance;
    let owner = if instance {
        node.string("componentId")
            .or_else(|| node.string("sourceComponentId"))
            .and_then(|id| context.snapshot.nodes.get(id))
    } else if node.properties.get("isVariantSet") == Some(&Value::Bool(true)) {
        children(context.snapshot, raw)
            .into_iter()
            .find(|node| node.kind == NodeKind::Component)
    } else {
        let mut candidate = Some(node);
        let mut owner = None;
        while let Some(current) = candidate {
            if current.kind == NodeKind::Component {
                owner = Some(current);
                break;
            }
            candidate = current
                .parent_id
                .as_ref()
                .and_then(|id| context.snapshot.nodes.get(id));
        }
        owner
    };
    let Some(owner) = owner else {
        return Ok(json!({"properties":[]}));
    };
    let mut props = Vec::new();
    if let Some(set) = owner.string("variantSetId") {
        let variants = children(context.snapshot, set);
        let defaults = variants.first().map(|node| axes(node)).unwrap_or_default();
        for (name, value) in variant_property::ordered_axes(owner) {
            let mut options = Vec::<String>::new();
            for item in &variants {
                if let Some(choice) = axes(item)
                    .get(&name)
                    .filter(|choice| !options.contains(*choice))
                {
                    options.push(choice.clone());
                }
            }
            let mut prop = json!({"name":name,"type":"variant","options":options,"default":defaults.get(&name)});
            if instance {
                prop["value"] = json!(value);
            }
            props.push(prop);
        }
    }
    for mut entry in array(owner.properties.get("componentPropertyDefinitions")) {
        let swap = entry["type"] == "swap";
        if swap {
            entry["type"] = json!("instanceSwap");
        }
        if swap || entry["type"] == "slot" {
            entry["preferred"] = json!(
                entry["preferred"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                    .filter(|id| context.snapshot.nodes.contains_key(*id))
                    .map(|id| context.alias(id))
                    .collect::<Vec<_>>()
            );
        }
        if entry["type"] == "slot" {
            let layer = entry["layer"]
                .as_str()
                .filter(|id| context.snapshot.nodes.contains_key(*id));
            let alias = layer.map(|id| context.alias(id));
            if instance {
                let used = layer.is_some_and(|layer| {
                    node.properties
                        .get("slotReplacements")
                        .is_some_and(|slots| slots[layer] == true)
                        || children(context.snapshot, &node.id)
                            .into_iter()
                            .any(|child| {
                                child.string("slotContentFor") == Some(layer)
                                    && child.string("slotInstanceFor").is_none()
                            })
                });
                entry["value"] = json!(used);
            }
            entry["default"] = json!(false);
            if let Some(layer) = alias {
                entry["layer"] = json!(layer);
            }
        } else if instance {
            entry["value"] = entry["id"]
                .as_str()
                .and_then(|id| {
                    node.properties
                        .get("componentProperties")
                        .and_then(|values| values.get(id))
                })
                .unwrap_or(&entry["default"])
                .clone();
        }
        if swap {
            for key in ["default", "value"] {
                if let Some(id) = entry[key]
                    .as_str()
                    .filter(|id| context.snapshot.nodes.contains_key(*id))
                {
                    let alias = context.alias(id);
                    entry[key] = json!(alias);
                }
            }
        }
        props.push(entry);
    }
    Ok(json!({"properties":props}))
}

fn owning_component<'a>(snapshot: &'a DocumentSnapshot, raw: &str) -> Result<&'a Node> {
    let mut node = snapshot.nodes.get(raw);
    while let Some(current) = node {
        if current.kind == NodeKind::Component {
            if current.string("libraryId").is_some() {
                return Err(EngineError::invalid("Library components are read-only"));
            }
            return Ok(current);
        }
        node = current
            .parent_id
            .as_ref()
            .and_then(|id| snapshot.nodes.get(id));
    }
    Err(EngineError::invalid(
        "Choose a component or a layer inside a component",
    ))
}

fn property_id(owner: &Node, name: &str) -> Result<(String, String)> {
    let entry = owner
        .properties
        .get("componentPropertyDefinitions")
        .and_then(Value::as_array)
        .and_then(|entries| {
            entries
                .iter()
                .find(|entry| entry["name"] == name || entry["id"] == name)
        })
        .ok_or_else(|| EngineError::invalid("Component property not found"))?;
    Ok((string(entry, "id")?.into(), string(entry, "type")?.into()))
}

fn property_value(context: &Context, kind: &str, value: &Value) -> Result<String> {
    match kind {
        "text" => value
            .as_str()
            .map(str::to_owned)
            .ok_or_else(|| EngineError::invalid("Expected text property value")),
        "boolean" => value
            .as_bool()
            .map(|value| value.to_string())
            .ok_or_else(|| EngineError::invalid("Expected boolean property value")),
        "swap" => {
            let raw = context.resolve(value)?;
            let node = &context.snapshot.nodes[&raw];
            if node.properties.get("isVariantSet") == Some(&Value::Bool(true)) {
                return children(context.snapshot, &raw)
                    .into_iter()
                    .find(|node| node.kind == NodeKind::Component)
                    .map(|node| node.id.clone())
                    .ok_or_else(|| EngineError::invalid("Component set has no variants"));
            }
            Ok(raw)
        }
        _ => Err(EngineError::new(
            "unsupported_feature",
            "Unsupported native component property type",
        )),
    }
}

fn property(context: &Context, action: &str) -> Result<Value> {
    let params = context.params;
    let raw = if let Some(layer) = params.get("layer").filter(|_| action == "bindProperty") {
        context.resolve(layer)?
    } else {
        context.one()?
    };
    let selected = &context.snapshot.nodes[&raw];
    let set_selected = selected.properties.get("isVariantSet") == Some(&Value::Bool(true));
    let primary = if set_selected {
        selected
    } else {
        owning_component(context.snapshot, &raw)?
    };
    if let Some(result) = variant_property::change(context, primary, action)? {
        return Ok(result);
    }
    let set = variant_property::owner(context.snapshot, primary);
    let scope = set.unwrap_or(primary);
    let targets = if action == "bindProperty" {
        vec![primary]
    } else if let Some(set) = set {
        children(context.snapshot, &set.id)
            .into_iter()
            .filter(|node| node.kind == NodeKind::Component)
            .collect()
    } else {
        vec![primary]
    };
    let preferred = params
        .get("preferred")
        .map(|value| preferred(context, value))
        .transpose()?;
    let name = if action == "bindProperty" {
        ""
    } else {
        property_name(&params["name"])?
    };
    let mut requests = Vec::new();
    if action == "addProperty" {
        let layer = params
            .get("layer")
            .map(|id| context.resolve(id))
            .transpose()?
            .or_else(|| (raw != primary.id).then(|| raw.clone()));
        let layer_node = layer.as_ref().map(|id| &context.snapshot.nodes[id]);
        let bound_owner = layer
            .as_ref()
            .map(|id| owning_component(context.snapshot, id))
            .transpose()?;
        if bound_owner.is_some_and(|owner| !targets.iter().any(|target| target.id == owner.id)) {
            return Err(EngineError::invalid(
                "Binding layer is outside the selected component",
            ));
        }
        if targets.iter().any(|node| {
            property_id(node, name).is_ok()
                || variant_property::ordered_axes(node)
                    .iter()
                    .any(|(axis, _)| axis == name)
        }) {
            return Err(EngineError::invalid(
                "Component property name is already in use",
            ));
        }
        let kind = match string(params, "type")?.to_ascii_lowercase().as_str() {
            "text" => "text",
            "boolean" | "bool" => "boolean",
            "instanceswap" | "instance_swap" | "instance" => "swap",
            "slot" => {
                let layer = layer.as_deref().ok_or_else(|| {
                    EngineError::invalid("Pass a frame inside the component as layer")
                })?;
                let alias = context.alias(layer);
                let mut request = json!({"id":alias,"name":name});
                if let Some(value) = params.get("preferred") {
                    request["preferred"] = value.clone();
                }
                slot_command(context, "component.makeSlot", &request)?;
                return Ok(json!({"id":context.alias(&scope.id),"name":name}));
            }
            _ => return Err(EngineError::invalid("Unknown component property type")),
        };
        if preferred.is_some() && kind != "swap" {
            return Err(EngineError::invalid(
                "preferred applies to instance swap and slot properties",
            ));
        }
        let value = if let Some(value) = params.get("default") {
            property_value(context, kind, value)?
        } else {
            match kind {
                "text" => layer_node
                    .and_then(|node| node.string("text"))
                    .unwrap_or(name)
                    .to_owned(),
                "boolean" => (!layer_node.is_some_and(|node| {
                    node.properties.get("visible") == Some(&Value::Bool(false))
                        || node.properties.get("hidden") == Some(&Value::Bool(true))
                }))
                .to_string(),
                _ => layer_node
                    .and_then(|node| node.string("componentId"))
                    .ok_or_else(|| {
                        EngineError::invalid("Instance swap requires a default component")
                    })?
                    .to_owned(),
            }
        };
        for owner in targets {
            let binds = bound_owner.is_some_and(|bound| bound.id == owner.id);
            let mut request = json!({"id":owner.id,"action":if binds {"bind"} else {"property"},
                "propertyType":kind,"name":name,"value":value});
            if binds {
                request["layer"] = json!(layer);
            }
            if let Some(preferred) = &preferred {
                request["_figcraftPreferred"] = json!(preferred);
            }
            requests.push(request);
        }
    } else if action == "bindProperty" {
        let reference = params
            .get("property")
            .ok_or_else(|| EngineError::invalid("property is required"))?;
        let layer = &context.snapshot.nodes[&raw];
        if reference.is_null() || reference == "" {
            let mut refs = layer
                .properties
                .get("componentPropertyRefs")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            if let Some(field) = params.get("field").and_then(Value::as_str) {
                if !matches!(field, "characters" | "visible" | "mainComponent" | "slot") {
                    return Err(EngineError::invalid("Unsupported binding field"));
                }
                refs.remove(field);
            } else {
                refs.clear();
            }
            let mut commands = vec![context.patch(&raw, "componentPropertyRefs", json!(refs))];
            if params.get("field").is_none_or(|field| field == "slot") {
                commands.extend(rebind_slot(primary, layer, None, context)?);
            }
            context.commit(commands)?;
            return Ok(json!({"ok":true}));
        }
        let (id, kind) = property_id(primary, string(params, "property")?)?;
        let expected = match kind.as_str() {
            "text" => "characters",
            "boolean" => "visible",
            "swap" => "mainComponent",
            "slot" => "slot",
            _ => "",
        };
        if params.get("field").is_some_and(|field| field != expected) {
            return Err(EngineError::invalid(
                "Binding field does not match the property type",
            ));
        }
        if kind == "slot" {
            context.commit(rebind_slot(primary, layer, Some(&id), context)?)?;
            return Ok(json!({"ok":true}));
        }
        requests.push(json!({"id":primary.id,"action":"bind","layer":raw,"property":id}));
    } else {
        let new_name = params.get("newName").map(property_name).transpose()?;
        if new_name.is_some_and(|name| {
            name != params["name"]
                && targets.iter().any(|node| {
                    property_id(node, name).is_ok()
                        || variant_property::ordered_axes(node)
                            .iter()
                            .any(|(axis, _)| axis == name)
                })
        }) {
            return Err(EngineError::invalid(
                "Component property name is already in use",
            ));
        }
        let mut direct = Vec::new();
        for owner in targets {
            let Ok((id, kind)) = property_id(owner, name) else {
                continue;
            };
            if kind == "slot" {
                let mut defs = array(owner.properties.get("componentPropertyDefinitions"));
                let index = defs.iter().position(|def| def["id"] == id).unwrap();
                let slot = defs[index]["layer"].as_str().map(str::to_owned);
                if action == "deleteProperty" {
                    if let Some(slot) = slot {
                        let slot = context.alias(&slot);
                        return slot_command(context, "component.removeSlot", &json!({"id":slot}))
                            .map(|_| json!({"ok":true}));
                    }
                    defs.remove(index);
                } else {
                    if let Some(new_name) = new_name {
                        defs[index]["name"] = json!(new_name);
                        if let Some(slot) = slot {
                            direct.push(context.patch(&slot, "slotName", json!(new_name)));
                        }
                    }
                    if let Some(preferred) = &preferred {
                        defs[index]["preferred"] = json!(preferred);
                    }
                }
                direct.push(context.patch(&owner.id, "componentPropertyDefinitions", json!(defs)));
                continue;
            }
            if preferred.is_some() && kind != "swap" {
                return Err(EngineError::invalid(
                    "preferred applies to instance swap and slot properties",
                ));
            }
            let action = if action == "editProperty" {
                "edit_property"
            } else {
                "remove_property"
            };
            let mut request = json!({"id":owner.id,"action":action,"property":id});
            if let Some(name) = new_name {
                request["name"] = json!(name);
            }
            if let Some(value) = params.get("default") {
                request["value"] = json!(property_value(context, &kind, value)?);
            }
            if let Some(preferred) = &preferred {
                request["_figcraftPreferred"] = json!(preferred);
            }
            requests.push(request);
        }
        if !direct.is_empty() {
            let edits = context.router.component_definition_commands(
                context.session,
                context.snapshot,
                &requests,
            )?;
            direct.extend(edits);
            context.commit(direct)?;
            return Ok(json!({"ok":true}));
        }
        if requests.is_empty() {
            return Err(EngineError::invalid("Component property not found"));
        }
    }
    let commands = context.router.component_definition_commands(
        context.session,
        context.snapshot,
        &requests,
    )?;
    context.commit(commands)?;
    Ok(if action == "addProperty" {
        json!({"id":context.alias(&scope.id),"name":name})
    } else {
        json!({"ok":true})
    })
}

fn property_name(value: &Value) -> Result<&str> {
    value
        .as_str()
        .map(str::trim)
        .filter(|name| {
            !name.is_empty() && name.chars().count() <= 256 && !name.contains([',', '='])
        })
        .ok_or_else(|| {
            EngineError::invalid(
                "Component property name must be nonempty and omit commas and equals signs",
            )
        })
}

fn preferred(context: &Context, value: &Value) -> Result<Vec<String>> {
    if value.is_null() {
        return Ok(Vec::new());
    }
    let ids = value
        .as_array()
        .filter(|ids| ids.len() <= 500)
        .ok_or_else(|| EngineError::invalid("preferred must contain component or set IDs"))?;
    let mut preferred = Vec::new();
    for id in ids {
        let id = context.resolve(id)?;
        let node = &context.snapshot.nodes[&id];
        if node.kind != NodeKind::Component
            && node.properties.get("isVariantSet") != Some(&Value::Bool(true))
        {
            return Err(EngineError::invalid(
                "preferred must contain component or set IDs",
            ));
        }
        if !preferred.contains(&id) {
            preferred.push(id);
        }
    }
    Ok(preferred)
}

fn slot_command(context: &Context, name: &str, params: &Value) -> Result<Value> {
    context.router.fig_geometry_command(
        context.session,
        context.snapshot,
        context.state,
        context.selection,
        name,
        params,
    )
}

fn rebind_slot(
    owner: &Node,
    layer: &Node,
    property: Option<&str>,
    context: &Context,
) -> Result<Vec<Command>> {
    let current = layer.string("slotPropertyId");
    if current == property {
        return Ok(Vec::new());
    }
    if layer.kind != NodeKind::Frame || layer.id == owner.id {
        return Err(EngineError::invalid(
            "A slot must bind to a frame inside the component",
        ));
    }
    let mut definitions = array(owner.properties.get("componentPropertyDefinitions"));
    let mut commands = Vec::new();
    if let Some(current) = current {
        if let Some(definition) = definitions.iter_mut().find(|def| def["id"] == current) {
            definition["layer"] = Value::Null;
        }
    }
    if let Some(id) = property {
        let definition = definitions
            .iter_mut()
            .find(|def| def["id"] == id && def["type"] == "slot")
            .ok_or_else(|| EngineError::invalid("Unknown slot property"))?;
        if let Some(previous) = definition["layer"].as_str() {
            commands.push(Command::NodeUnset {
                node_id: previous.into(),
                properties: vec!["slotPropertyId".into(), "slotName".into()],
            });
        }
        definition["layer"] = json!(layer.id);
        commands.push(context.patch(&layer.id, "slotPropertyId", json!(id)));
        commands.push(context.patch(&layer.id, "slotName", definition["name"].clone()));
    } else {
        commands.push(Command::NodeUnset {
            node_id: layer.id.clone(),
            properties: vec!["slotPropertyId".into(), "slotName".into()],
        });
    }
    commands.push(context.patch(
        &owner.id,
        "componentPropertyDefinitions",
        json!(definitions),
    ));
    Ok(commands)
}

pub(super) fn set_properties(context: &Context) -> Result<Value> {
    let ids = match context.many() {
        Ok(ids) => ids,
        Err(_) => return set_exposed_properties(context),
    };
    let values = context.params["properties"]
        .as_object()
        .ok_or_else(|| EngineError::invalid("properties must be an object"))?;
    let operations = property_operations(context, &ids, values)?;
    if !operations.is_empty() {
        context.router.mutate(
            context.session,
            &context.snapshot.id,
            "batch",
            &json!({"ops":operations,"revision":context.snapshot.sequence}),
            &Value::Null,
        )?;
    }
    Ok(json!({"ok":true}))
}

fn set_exposed_properties(context: &Context) -> Result<Value> {
    let projection = omc_scene::resolve_components(context.snapshot, Some(&context.state.root));
    let resolved = Context {
        snapshot: &projection.snapshot,
        ..*context
    };
    let ids = resolved.many()?;
    let values = context.params["properties"]
        .as_object()
        .ok_or_else(|| EngineError::invalid("properties must be an object"))?;
    let mut preview = context.snapshot.clone();
    let mut nested = BTreeMap::new();
    for id in &ids {
        if preview.nodes.contains_key(id) {
            continue;
        }
        let layer = &projection.snapshot.nodes[id];
        let mut source = layer.clone();
        let definition = layer
            .string("sourceComponentId")
            .filter(|_| layer.kind == NodeKind::Instance)
            .ok_or_else(|| EngineError::invalid("Choose an exposed nested instance"))?;
        let authored = layer
            .string("sourceNodeId")
            .and_then(|id| context.snapshot.nodes.get(id));
        if authored.and_then(|source| source.properties.get(EXPOSED)) != Some(&Value::Bool(true)) {
            return Err(EngineError::invalid("Choose an exposed nested instance"));
        }
        let mut path = Vec::new();
        let mut owner = layer;
        while !context.snapshot.nodes.contains_key(&owner.id) {
            let ancestor = owner
                .string("instanceId")
                .and_then(|id| projection.snapshot.nodes.get(id))
                .filter(|ancestor| ancestor.kind == NodeKind::Instance)
                .ok_or_else(|| EngineError::invalid("Nested instance lost its owning instance"))?;
            let source = owner
                .string("sourceNodeId")
                .ok_or_else(|| EngineError::invalid("Nested instance lost its main layer"))?;
            path.push(source.to_owned());
            owner = ancestor;
        }
        path.reverse();
        source
            .properties
            .insert("componentId".into(), json!(definition));
        source.parent_id = Some(context.state.root.clone());
        preview.nodes.insert(id.clone(), source);
        nested.insert(id.clone(), (owner.id.clone(), path));
    }
    if nested.values().any(|(owner, _)| ids.contains(owner)) {
        return Err(EngineError::invalid(
            "Edit the outer instance and its exposed instance separately",
        ));
    }
    let draft = Context {
        snapshot: &preview,
        ..*context
    };
    let operations = property_operations(&draft, &ids, values)?;
    let updated = context.router.preview_component_operations(
        context.session,
        preview.clone(),
        operations,
    )?;
    let mut commands = Vec::new();
    let mut overrides = BTreeMap::new();
    for id in ids {
        let before = &preview.nodes[&id];
        let after = &updated.nodes[&id];
        let changes = ["componentId", "componentProperties", "overrides"]
            .into_iter()
            .filter_map(|key| {
                let old = before.properties.get(key);
                let new = after.properties.get(key);
                (old != new).then_some((key.to_owned(), new.cloned().unwrap_or(Value::Null)))
            })
            .collect::<Properties>();
        if changes.is_empty() {
            continue;
        }
        if let Some((owner, path)) = nested.get(&id) {
            let properties = overrides.entry(owner).or_insert_with(|| {
                context.snapshot.nodes[owner]
                    .properties
                    .get("overrides")
                    .and_then(Value::as_object)
                    .cloned()
                    .unwrap_or_default()
            });
            insert_nested(properties, path, changes);
        } else {
            commands.push(Command::NodeSet {
                node_id: id,
                properties: changes,
            });
        }
    }
    for (owner, values) in overrides {
        commands.push(context.patch(owner, "overrides", Value::Object(values)));
    }
    context.commit(commands)?;
    Ok(json!({"ok":true}))
}

fn insert_nested(
    overrides: &mut serde_json::Map<String, Value>,
    path: &[String],
    changes: Properties,
) {
    let Some((first, rest)) = path.split_first() else {
        return;
    };
    let mut fields = overrides
        .remove(first)
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default();
    if rest.is_empty() {
        fields.extend(changes);
    } else {
        let mut nested = fields
            .remove("overrides")
            .and_then(|value| value.as_object().cloned())
            .unwrap_or_default();
        insert_nested(&mut nested, rest, changes);
        fields.insert("overrides".into(), Value::Object(nested));
    }
    overrides.insert(first.clone(), Value::Object(fields));
}

pub(super) fn property_operations(
    context: &Context,
    ids: &[String],
    values: &serde_json::Map<String, Value>,
) -> Result<Vec<Value>> {
    let mut operations = Vec::new();
    for id in ids {
        let instance = &context.snapshot.nodes[id];
        let source = instance
            .string("componentId")
            .and_then(|id| context.snapshot.nodes.get(id))
            .filter(|_| instance.kind == NodeKind::Instance)
            .ok_or_else(|| EngineError::invalid("Choose a linked instance"))?;
        let mut remaining = values.clone();
        let mut target = source;
        if let Some(set) = source.string("variantSetId") {
            let mut wanted = axes(source);
            let mut changed = false;
            for (name, current) in &mut wanted {
                if let Some(value) = remaining.remove(name) {
                    let value = value
                        .as_str()
                        .map(str::to_owned)
                        .unwrap_or_else(|| value.to_string());
                    changed |= *current != value;
                    *current = value;
                }
            }
            if changed {
                target = children(context.snapshot, set)
                    .into_iter()
                    .find(|node| axes(node) == wanted)
                    .ok_or_else(|| {
                        EngineError::invalid("No variant has the requested property values")
                    })?;
                operations.push(json!({"tool":"component","args":{"action":"variant","id":id,"value":target.id}}));
            }
        }
        for (name, value) in remaining {
            let (property, kind) = property_id(target, &name)?;
            let value = property_value(context, &kind, &value)?;
            operations.push(json!({"tool":"component","args":{"action":"set_property","id":id,"property":property,"value":value}}));
        }
    }
    if operations.len() > 100 {
        return Err(EngineError::new(
            "resource_limit",
            "Instance property operation exceeds 100 edits",
        ));
    }
    Ok(operations)
}
