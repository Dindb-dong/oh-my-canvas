use super::*;

const DEFINITIONS: &str = "componentPropertyDefinitions";
const REFERENCES: &str = "componentPropertyRefs";
const VALUES: &str = "componentProperties";

pub(super) fn selection(draft: &mut Draft, node_id: &str, definition: &str) {
    draft.result.insert("rawSelection".into(), json!([node_id]));
    draft.result.insert("componentId".into(), json!(definition));
}

impl ToolRouter {
    pub(super) fn component_property_mutation(
        &self,
        session: &str,
        document: &str,
        args: &Value,
        draft: &mut Draft,
    ) -> Result<()> {
        let resolve = |id: &str| self.resolve(session, document, id);
        let raw = resolve(
            args["id"]
                .as_str()
                .or_else(|| args["ids"][0].as_str())
                .ok_or_else(|| EngineError::invalid("choose a component or instance"))?,
        )?;
        let node = draft.node(&raw)?.clone();
        let definition_id = match node.kind {
            NodeKind::Component => raw.clone(),
            NodeKind::Instance => node
                .string("componentId")
                .ok_or_else(unknown_component)?
                .to_owned(),
            _ => return Err(unknown_component()),
        };
        let definition = draft.node(&definition_id)?.clone();
        if definition.kind != NodeKind::Component {
            return Err(unknown_component());
        }
        check_unlocked(draft, &raw)?;
        let mut definitions = definition
            .properties
            .get(DEFINITIONS)
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let action = string(args, "action")?;
        let binding_target = if action == "bind" {
            let target = args["layer"]
                .as_str()
                .map(resolve)
                .transpose()?
                .unwrap_or(raw.clone());
            check_unlocked(draft, &target)?;
            let mut ancestor = draft.node(&target)?;
            while ancestor.id != definition_id {
                if matches!(ancestor.kind, NodeKind::Component | NodeKind::Instance)
                    && ancestor.id != target
                {
                    return Err(EngineError::invalid(
                        "cannot bind through a nested component",
                    ));
                }
                let parent = ancestor.parent_id.as_deref().ok_or_else(|| {
                    EngineError::invalid("property target must belong to the definition")
                })?;
                ancestor = draft.node(parent)?;
            }
            Some(draft.node(&target)?.clone())
        } else {
            None
        };
        let create = action == "property" || action == "bind" && args["property"].is_null();
        let index = if create {
            let kind = string(args, "propertyType")?;
            let (default_name, default) = match kind {
                "text" => (
                    "Text",
                    binding_target
                        .as_ref()
                        .and_then(|n| n.string("text"))
                        .unwrap_or(""),
                ),
                "boolean" => (
                    "Visible",
                    if binding_target.as_ref().is_some_and(|n| {
                        n.properties.get("visible") == Some(&Value::Bool(false))
                            || n.properties.get("hidden") == Some(&Value::Bool(true))
                    }) {
                        "false"
                    } else {
                        "true"
                    },
                ),
                "swap" => (
                    "Component",
                    binding_target
                        .as_ref()
                        .and_then(|n| n.string("componentId"))
                        .unwrap_or(""),
                ),
                _ => return Err(EngineError::invalid("unsupported property type")),
            };
            let name = args["name"]
                .as_str()
                .filter(|s| !s.is_empty())
                .unwrap_or(default_name);
            unique_name(&definitions, None, name)?;
            if definitions.len() >= 200 {
                return Err(EngineError::new(
                    "resource_limit",
                    "component property limit reached",
                ));
            }
            let value = component_value(
                draft,
                &definition_id,
                kind,
                args["value"].as_str().unwrap_or(default),
                resolve,
            )?;
            definitions.push(json!({"id":new_id("prop"),"name":name,"type":kind,"default":value}));
            definitions.len() - 1
        } else {
            let property_id = string(args, "property")?;
            definitions
                .iter()
                .position(|value| value["id"] == property_id)
                .ok_or_else(|| EngineError::invalid("unknown component property"))?
        };
        let mut definition_changed = create;
        let mut property = definitions[index].clone();
        let property_id = string(&property, "id")?.to_owned();
        let kind = string(&property, "type")?.to_owned();
        match action {
            "property" => {}
            "bind" => {
                let target = binding_target.unwrap();
                if args["propertyType"].as_str().is_some_and(|ty| ty != kind) {
                    return Err(EngineError::invalid("component property type mismatch"));
                }
                let field = match kind.as_str() {
                    "boolean" => "visible",
                    "text" if target.kind == NodeKind::Text => "characters",
                    "swap"
                        if target.kind == NodeKind::Instance
                            && target.string("componentId").is_some() =>
                    {
                        "mainComponent"
                    }
                    _ => {
                        return Err(EngineError::invalid(
                            "property type cannot bind to this layer",
                        ));
                    }
                };
                let mut refs = object_property(&target, REFERENCES);
                refs.insert(field.into(), json!(property_id));
                set(draft, &target.id, REFERENCES, Value::Object(refs))?;
            }
            "edit_property" | "set_property" => {
                if action == "edit_property"
                    && let Some(name) = args["name"].as_str().filter(|s| !s.is_empty())
                {
                    unique_name(&definitions, Some(index), name)?;
                    property["name"] = name.into();
                    definition_changed = true;
                }
                if let Some(value) = args["value"].as_str() {
                    let value = component_value(draft, &definition_id, &kind, value, resolve)?;
                    if action == "set_property" && node.kind == NodeKind::Instance {
                        let mut overrides = object_property(&node, VALUES);
                        if let Some(previous) = node
                            .properties
                            .get("propertyValues")
                            .and_then(Value::as_object)
                        {
                            for (id, value) in previous {
                                overrides.entry(id.clone()).or_insert_with(|| value.clone());
                            }
                        }
                        overrides.insert(property_id.clone(), value);
                        set(draft, &raw, VALUES, Value::Object(overrides))?;
                    } else {
                        property["default"] = value;
                        definition_changed = true;
                    }
                } else if action == "set_property" {
                    return Err(EngineError::invalid("set_property requires value"));
                }
                definitions[index] = property.clone();
            }
            "remove_property" => {
                definitions.remove(index);
                definition_changed = true;
                let targets: Vec<_> = subtree(&draft.snapshot, &definition_id)
                    .into_iter()
                    .filter(|node| {
                        node.properties
                            .get(REFERENCES)
                            .and_then(Value::as_object)
                            .is_some_and(|refs| refs.values().any(|value| value == &property_id))
                    })
                    .cloned()
                    .collect();
                for target in targets {
                    let mut refs = object_property(&target, REFERENCES);
                    refs.retain(|_, value| value != &property_id);
                    set(draft, &target.id, REFERENCES, Value::Object(refs))?;
                    match kind.as_str() {
                        "boolean" => {
                            set(draft, &target.id, "visible", property["default"].clone())?
                        }
                        "text" => {
                            let length =
                                target.string("text").unwrap_or("").encode_utf16().count() as u32;
                            let attributes = attributes_at(&target, 0)?;
                            if length != 0 {
                                draft.apply(Command::TextDelete {
                                    node_id: target.id.clone(),
                                    start: 0,
                                    end: length,
                                })?;
                            }
                            if let Some(text) = property["default"]
                                .as_str()
                                .filter(|value| !value.is_empty())
                            {
                                draft.apply(Command::TextInsert {
                                    node_id: target.id.clone(),
                                    offset: 0,
                                    text: text.into(),
                                    attributes,
                                })?;
                            }
                        }
                        "swap"
                            if property["default"]
                                .as_str()
                                .is_some_and(|value| !value.is_empty()) =>
                        {
                            set(
                                draft,
                                &target.id,
                                "componentId",
                                property["default"].clone(),
                            )?;
                        }
                        _ => {}
                    }
                }
                let instances: Vec<_> = draft
                    .snapshot
                    .nodes
                    .values()
                    .filter(|node| {
                        node.kind == NodeKind::Instance
                            && node.string("componentId") == Some(&definition_id)
                            && [VALUES, "propertyValues"].into_iter().any(|key| {
                                node.properties
                                    .get(key)
                                    .is_some_and(|values| values.get(&property_id).is_some())
                            })
                    })
                    .cloned()
                    .collect();
                for instance in instances {
                    for key in [VALUES, "propertyValues"] {
                        let mut overrides = object_property(&instance, key);
                        if overrides.remove(&property_id).is_some() {
                            set(draft, &instance.id, key, Value::Object(overrides))?;
                        }
                    }
                }
            }
            _ => return Err(EngineError::invalid("unknown typed property action")),
        }
        if let Some(preferred) = args.get("_figcraftPreferred") {
            if kind != "swap" || !matches!(action, "property" | "bind" | "edit_property") {
                return Err(EngineError::invalid(
                    "Preferred choices apply to instance swap properties",
                ));
            }
            definitions[index]["preferred"] = preferred.clone();
            definition_changed = true;
        }
        if definition_changed {
            set(draft, &definition_id, DEFINITIONS, json!(definitions))?;
        }
        if matches!(action, "property" | "bind" | "edit_property") {
            draft.result.insert("property".into(), property);
        }
        selection(draft, &raw, &definition_id);
        Ok(())
    }
}

fn object_property(node: &Node, key: &str) -> serde_json::Map<String, Value> {
    node.properties
        .get(key)
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default()
}

fn unique_name(definitions: &[Value], except: Option<usize>, name: &str) -> Result<()> {
    if definitions
        .iter()
        .enumerate()
        .any(|(index, entry)| Some(index) != except && entry["name"] == name)
    {
        Err(EngineError::invalid("duplicate component property name"))
    } else {
        Ok(())
    }
}

fn unknown_component() -> EngineError {
    EngineError::invalid("choose a component definition or instance")
}

fn check_unlocked(draft: &Draft, id: &str) -> Result<()> {
    let mut current = Some(id);
    let mut seen = BTreeSet::new();
    while let Some(id) = current {
        let node = draft.node(id)?;
        if !seen.insert(id) || node.properties.get("locked") == Some(&Value::Bool(true)) {
            return Err(EngineError::invalid(
                "layer or ancestor is locked or invalid",
            ));
        }
        current = node.parent_id.as_deref();
    }
    Ok(())
}

fn set(draft: &mut Draft, id: &str, key: &str, value: Value) -> Result<()> {
    draft.apply(Command::NodeSet {
        node_id: id.to_owned(),
        properties: Properties::from([(key.to_owned(), value)]),
    })
}

fn subtree<'a>(snapshot: &'a DocumentSnapshot, root: &str) -> Vec<&'a Node> {
    let mut tree: HashMap<&str, Vec<&Node>> = HashMap::new();
    for node in snapshot.nodes.values() {
        if let Some(parent) = node.parent_id.as_deref() {
            tree.entry(parent).or_default().push(node);
        }
    }
    let mut pending: Vec<_> = snapshot.nodes.get(root).into_iter().collect();
    let mut nodes = Vec::new();
    while let Some(node) = pending.pop() {
        nodes.push(node);
        if node.id == root || !matches!(node.kind, NodeKind::Component | NodeKind::Instance) {
            pending.extend(tree.get(node.id.as_str()).into_iter().flatten().copied());
        }
    }
    nodes
}

fn component_value(
    draft: &Draft,
    owner: &str,
    kind: &str,
    value: &str,
    resolve: impl Fn(&str) -> Result<String>,
) -> Result<Value> {
    match kind {
        "text" => Ok(json!(value)),
        "boolean" => match value {
            "true" => Ok(Value::Bool(true)),
            "false" => Ok(Value::Bool(false)),
            _ => Err(EngineError::invalid(
                "boolean property requires true or false",
            )),
        },
        "swap" if value.is_empty() => Ok(json!("")),
        "swap" => {
            let target = resolve(value)?;
            if draft.node(&target)?.kind != NodeKind::Component {
                return Err(EngineError::invalid(
                    "swap target must be a component definition",
                ));
            }
            let mut pending = vec![target.as_str()];
            let mut seen = BTreeSet::new();
            while let Some(id) = pending.pop() {
                if id == owner {
                    return Err(EngineError::invalid("component swap would create a cycle"));
                }
                if !seen.insert(id) {
                    continue;
                }
                for node in subtree(&draft.snapshot, id) {
                    if let Some(source) = node
                        .string("componentId")
                        .filter(|_| node.kind == NodeKind::Instance)
                    {
                        pending.push(source);
                    }
                    if let Some(defs) = node.properties.get(DEFINITIONS).and_then(Value::as_array) {
                        pending.extend(
                            defs.iter()
                                .filter(|entry| entry["type"] == "swap")
                                .filter_map(|entry| entry["default"].as_str())
                                .filter(|value| !value.is_empty()),
                        );
                    }
                    let Some(source) = node
                        .string("componentId")
                        .filter(|_| node.kind == NodeKind::Instance)
                        .and_then(|id| draft.snapshot.nodes.get(id))
                    else {
                        continue;
                    };
                    let Some(definitions) =
                        source.properties.get(DEFINITIONS).and_then(Value::as_array)
                    else {
                        continue;
                    };
                    for property in definitions.iter().filter(|entry| entry["type"] == "swap") {
                        if let Some(id) = property["id"].as_str() {
                            let value = node
                                .properties
                                .get(VALUES)
                                .and_then(|value| value.get(id))
                                .or_else(|| {
                                    node.properties
                                        .get("propertyValues")
                                        .and_then(|value| value.get(id))
                                });
                            pending.extend(
                                value
                                    .and_then(Value::as_str)
                                    .filter(|value| !value.is_empty()),
                            );
                        }
                    }
                }
            }
            Ok(json!(target))
        }
        _ => Err(EngineError::invalid("unsupported property type")),
    }
}
