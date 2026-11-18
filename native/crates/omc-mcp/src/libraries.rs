//! Embedded library definitions keep stable native identities across source updates.
use super::*;
use crate::figcraft_catalog::library_ops;
use omc_model::{NodeKind, new_id, rank_between};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;

pub(crate) fn stable_id(kind: &str, library: &str, source: &str) -> String {
    format!(
        "{kind}_{}",
        hex::encode(
            &Sha256::digest(format!("omc.library/1\0{library}\0{source}").as_bytes())[..16]
        )
    )
}
fn public_library(entry: &Value) -> Value {
    let mut public = entry.clone();
    if let Some(path) = entry["path"].as_str() {
        public["path"] = json!(crate::figcraft_catalog::library_team::display_path(path));
    }
    public
}

impl ToolRouter {
    pub(crate) fn library_tool(
        &self,
        session: &str,
        id: &str,
        mut args: Value,
        meta: Value,
    ) -> Result<Value> {
        let snapshot = self.workspace.snapshot(id)?;
        let entries = resources::catalogs(&snapshot.metadata, "libraries");
        let action = string(&args, "action")?.to_owned();
        let action = action.as_str();
        if action == "publish" {
            let (publication, command) = library_ops::publication(&snapshot, &args)?;
            return self.submit_with_output(
                session,
                id,
                command,
                &meta,
                Some(snapshot.sequence),
                Properties::from([("publication".into(), library_ops::summary(&publication))]),
            );
        }
        if action == "publication" {
            let publication = library_ops::published(&snapshot.metadata)
                .ok_or_else(|| EngineError::invalid("document has no published library"))?;
            return Ok(json!({"ok":true,"publication":library_ops::summary(publication)}));
        }
        if action == "list" {
            return Ok(
                json!({"ok":true,"libraries":entries.values().map(public_library).collect::<Vec<_>>()}),
            );
        }
        let library_id = args["id"]
            .as_str()
            .map(str::to_owned)
            .unwrap_or_else(|| new_id("library"));
        if matches!(action, "get" | "export") {
            let entry = entries
                .get(&library_id)
                .ok_or_else(|| EngineError::invalid("library not found"))?;
            return Ok(
                json!({"ok":true,"library":public_library(entry),"snapshot":entry["snapshot"]}),
            );
        }
        if action == "insert" {
            let library = entries
                .get(&library_id)
                .filter(|entry| entry["enabled"] != false)
                .ok_or_else(|| EngineError::invalid("library unavailable or disabled"))?;
            let component = string(&args, "componentId")?;
            if library["snapshot"]["components"][component]["published"] == false {
                return Err(EngineError::invalid("library component is not published"));
            }
            let root = library["componentMap"][component]
                .as_str()
                .ok_or_else(|| EngineError::invalid("library component not found"))?;
            let parent = args["parentId"]
                .as_str()
                .map(|raw| self.resolve(session, id, raw))
                .transpose()?
                .unwrap_or(self.state(session, id)?.root);
            let mut node = Node::new(NodeKind::Instance);
            node.parent_id = Some(parent.clone());
            node.home_shard = snapshot
                .nodes
                .get(&parent)
                .ok_or_else(|| EngineError::invalid("parent not found"))?
                .home_shard
                .clone();
            node.rank = rank_between(
                children(&snapshot, &parent).last().map(|n| n.rank.as_str()),
                None,
            )
            .ok_or_else(|| EngineError::new("resource_limit", "rank rebalance required"))?;
            node.properties = properties(
                &json!({"name":library["snapshot"]["components"][component]["name"].as_str().unwrap_or("Library instance"),"componentId":root,"libraryId":library_id,"x":args["x"].as_f64().unwrap_or(0.),"y":args["y"].as_f64().unwrap_or(0.)}),
            )?;
            let raw = node.id.clone();
            let mut result = self.submit(
                session,
                id,
                Command::NodeCreate { node },
                &meta,
                Some(snapshot.sequence),
            )?;
            result["id"] = self.alias(session, id, &raw).into();
            return Ok(result);
        }
        if matches!(action, "enable" | "remove") {
            if !entries.contains_key(&library_id) {
                return Err(EngineError::invalid("library not found"));
            }
            let patch = if action == "enable" {
                json!({"enabled":args["enabled"].as_bool().ok_or_else(||EngineError::invalid("enabled required"))?})
            } else {
                json!({"deleted":true,"enabled":false})
            };
            // Existing instances retain their embedded definitions when disabled/unlinked.
            return self.submit(
                session,
                id,
                Command::CatalogSet {
                    namespace: "libraries".into(),
                    entity_id: library_id,
                    properties: properties(&patch)?,
                },
                &meta,
                Some(snapshot.sequence),
            );
        }
        let existing = entries.get(&library_id);
        let mut source_document = None;
        if matches!(action, "link_source" | "check_updates" | "refresh") {
            let source_id = if action == "link_source" {
                let source_id = external_id(&native_id(string(&args, "sourceDocumentId")?)?);
                if entries
                    .values()
                    .any(|library| library["sourceDocumentId"] == source_id)
                    || existing.is_some()
                {
                    return Err(EngineError::new("conflict", "library is already linked"));
                }
                source_id
            } else {
                existing
                    .and_then(|library| library["sourceDocumentId"].as_str())
                    .ok_or_else(|| EngineError::invalid("document-linked library not found"))?
                    .to_owned()
            };
            let native_source = native_id(&source_id)?;
            if native_source == id {
                return Err(EngineError::invalid(
                    "cannot link a document to its own library",
                ));
            }
            let source_snapshot = self.workspace.snapshot(&native_source)?;
            let publication = library_ops::published(&source_snapshot.metadata)
                .ok_or_else(|| EngineError::invalid("source document has no published library"))?;
            let version = publication["version"]
                .as_u64()
                .ok_or_else(|| EngineError::invalid("source publication version missing"))?;
            let installed = existing.and_then(|library| library["version"].as_u64());
            if let Some(entry) = existing
                && (entry["snapshot"]["id"] != publication["id"]
                    || installed.is_some_and(|old| old > version))
            {
                return Err(EngineError::new(
                    "conflict",
                    "source publication changed identity or moved backwards",
                ));
            }
            if args["expectedVersion"]
                .as_u64()
                .is_some_and(|expected| expected != version)
            {
                return Err(EngineError::new(
                    "conflict",
                    "source publication version changed",
                ));
            }
            if action == "check_updates" || installed == Some(version) {
                return Ok(json!({
                    "ok":true, "id":library_id, "sourceDocumentId":source_id,
                    "installedVersion":installed, "availableVersion":version,
                    "updateAvailable":installed.is_none_or(|old| old < version)
                }));
            }
            source_document = Some(source_id);
            args["snapshot"] = publication.clone();
        } else if !matches!(action, "add" | "update") {
            return Err(EngineError::invalid("unknown library action"));
        } else if action == "update" && existing.is_none() {
            return Err(EngineError::invalid("library not found"));
        } else if existing.is_some_and(|library| library["sourceDocumentId"].is_string()) {
            return Err(EngineError::invalid(
                "use refresh for document-linked libraries",
            ));
        }
        let source = args["snapshot"]
            .as_object()
            .ok_or_else(|| EngineError::invalid("library snapshot required"))?;
        let objects = source
            .get("objects")
            .and_then(Value::as_object)
            .ok_or_else(|| EngineError::invalid("library objects required"))?;
        let components = source
            .get("components")
            .and_then(Value::as_object)
            .ok_or_else(|| EngineError::invalid("library components required"))?;
        if objects.len() > 40 {
            return Err(EngineError::new(
                "resource_limit",
                "ordinary library update allows 40 objects; larger libraries require staged installation",
            ));
        }
        let container_id = stable_id("node", &library_id, "container");
        let page_root = self.state(session, id)?.root;
        let mut commands = Vec::new();
        if !snapshot.nodes.contains_key(&container_id) {
            let mut container = Node::new(NodeKind::Group);
            container.id = container_id.clone();
            container.parent_id = Some(page_root.clone());
            container.rank = rank_between(
                children(&snapshot, &page_root)
                    .last()
                    .map(|n| n.rank.as_str()),
                None,
            )
            .ok_or_else(|| EngineError::new("resource_limit", "rank rebalance required"))?;
            container.properties = properties(
                &json!({"name":"Embedded library definitions","style":{"display":"none"},"libraryId":library_id}),
            )?;
            commands.push(Command::NodeCreate { node: container });
        }
        let mut mapping = BTreeMap::new();
        for key in objects.keys() {
            mapping.insert(key.clone(), stable_id("node", &library_id, key));
        }
        let mut component_map = BTreeMap::new();
        let mut definition_roots = BTreeMap::new();
        for (key, component) in components {
            let main = component["mainId"]
                .as_str()
                .or_else(|| component["rootNodeId"].as_str())
                .ok_or_else(|| EngineError::invalid("library component mainId required"))?;
            let native = mapping
                .get(main)
                .ok_or_else(|| EngineError::invalid("component definition object missing"))?;
            if definition_roots
                .insert(main.to_owned(), component)
                .is_some()
            {
                return Err(EngineError::invalid(
                    "library components share a main object",
                ));
            }
            component_map.insert(key.clone(), native.clone());
        }
        let variant_sets: BTreeMap<_, _> = objects
            .iter()
            .filter(|(_, object)| {
                object["type"] == "frame" && object["properties"]["isVariantSet"] == true
            })
            .map(|(key, _)| (key.clone(), mapping[key].clone()))
            .collect();
        let source_parent = |key: &str| {
            let parent = objects[key]["parentId"].as_str()?;
            if definition_roots.contains_key(key) && !variant_sets.contains_key(parent) {
                return None;
            }
            mapping.contains_key(parent).then_some(parent)
        };
        let mut token_map = BTreeMap::new();
        let mut collection_map = BTreeMap::new();
        if let Some(collections) = source.get("collections").and_then(Value::as_object) {
            for key in collections.keys() {
                collection_map.insert(key.clone(), stable_id("collection", &library_id, key));
            }
            for (key, collection) in collections {
                let mut patch = properties(collection)?;
                patch.remove("id");
                patch.insert("libraryId".into(), json!(library_id));
                patch.insert("sourceCollectionId".into(), json!(key));
                patch.insert("deleted".into(), json!(false));
                commands.push(Command::DocumentMetadata {
                    properties: patch
                        .into_iter()
                        .map(|(field, value)| {
                            (
                                format!("figcraftCollections/{}/{field}", collection_map[key]),
                                value,
                            )
                        })
                        .collect(),
                });
            }
        }
        if let Some(variables) = source.get("variables").and_then(Value::as_object) {
            for key in variables.keys() {
                token_map.insert(key.clone(), stable_id("token", &library_id, key));
            }
            for (key, variable) in variables {
                let mut variable = variable.clone();
                remap_token_refs(&mut variable, &token_map);
                let collection = variable["collectionId"]
                    .as_str()
                    .and_then(|id| collection_map.get(id))
                    .ok_or_else(|| EngineError::invalid("Library variable collection missing"))?;
                variable["collectionId"] = json!(collection);
                variable["libraryId"] = json!(library_id);
                variable["sourceVariableId"] = json!(key);
                variable["deleted"] = json!(false);
                let mut patch = properties(&variable)?;
                patch.remove("id");
                commands.push(Command::CatalogSet {
                    namespace: "tokens".into(),
                    entity_id: token_map[key].clone(),
                    properties: patch,
                });
            }
        }
        let mut style_map = BTreeMap::new();
        if let Some(styles) = source.get("styles").and_then(Value::as_object) {
            for key in styles.keys() {
                style_map.insert(key.clone(), stable_id("style", &library_id, key));
            }
            for (key, style) in styles {
                let mut value = style
                    .get("value")
                    .or_else(|| style.get("paints"))
                    .or_else(|| style.get("text"))
                    .or_else(|| style.get("effects"))
                    .cloned()
                    .ok_or_else(|| EngineError::invalid("library style value missing"))?;
                remap_token_refs(&mut value, &token_map);
                commands.push(Command::CatalogSet{namespace:"styles".into(),entity_id:style_map[key].clone(),properties:properties(&json!({"name":style["name"],"type":style["type"],"value":value,"libraryId":library_id,"deleted":false}))?});
            }
        }
        let mut remaining: BTreeSet<_> = objects.keys().cloned().collect();
        let mut installed = BTreeSet::new();
        let mut native_ids = BTreeSet::new();
        while !remaining.is_empty() {
            let key = remaining
                .iter()
                .find(|key| source_parent(key).is_none_or(|parent| installed.contains(parent)))
                .cloned()
                .ok_or_else(|| EngineError::invalid("cyclic library objects"))?;
            remaining.remove(&key);
            let object = &objects[&key];
            let kind = if definition_roots.contains_key(&key) {
                NodeKind::Component
            } else {
                match object["type"]
                    .as_str()
                    .or_else(|| object["kind"].as_str())
                    .unwrap_or("rect")
                {
                    "frame" => NodeKind::Frame,
                    "group" => NodeKind::Group,
                    "rect" => NodeKind::Rect,
                    "ellipse" => NodeKind::Ellipse,
                    "line" => NodeKind::Line,
                    "path" => NodeKind::Path,
                    "text" => NodeKind::Text,
                    "image" => NodeKind::Image,
                    "instance" => NodeKind::Instance,
                    other => {
                        return Err(EngineError::new(
                            "unsupported_feature",
                            format!("library node kind {other}"),
                        ));
                    }
                }
            };
            let mut node = Node::new(kind);
            node.id = mapping[&key].clone();
            node.parent_id = Some(
                source_parent(&key)
                    .map_or_else(|| container_id.clone(), |parent| mapping[parent].clone()),
            );
            node.rank = object["rank"]
                .as_str()
                .filter(|rank| omc_model::valid_rank(rank))
                .map(str::to_owned)
                .unwrap_or_else(|| {
                    format!(
                        "{:032x}",
                        (installed.len() as u128 + 1) * (u64::MAX as u128)
                    )
                });
            node.properties = object
                .as_object()
                .ok_or_else(|| EngineError::invalid("library object must be an object"))?
                .iter()
                .filter(|(k, _)| {
                    !matches!(
                        k.as_str(),
                        "id" | "type"
                            | "kind"
                            | "parentId"
                            | "rank"
                            | "childIds"
                            | "box"
                            | "inverseTransform"
                            | "enclosingFrameId"
                    )
                })
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect();
            if let Some(inner) = object.get("properties").and_then(Value::as_object) {
                node.properties
                    .extend(inner.iter().map(|(k, v)| (k.clone(), v.clone())));
                node.properties.remove("properties");
            }
            for value in node.properties.values_mut() {
                remap_token_refs(value, &token_map);
            }
            if let Some(modes) = node
                .properties
                .get_mut("figcraftVariableModes")
                .and_then(Value::as_object_mut)
            {
                *modes = std::mem::take(modes)
                    .into_iter()
                    .map(|(id, value)| (collection_map.get(&id).cloned().unwrap_or(id), value))
                    .collect();
            }
            if let Some(values) = node
                .properties
                .get_mut("componentProperties")
                .and_then(Value::as_object_mut)
            {
                for value in values.values_mut() {
                    if let Some(target) = value.as_str().and_then(|id| component_map.get(id)) {
                        *value = json!(target);
                    }
                }
            }
            if let Some(component) = definition_roots.get(&key)
                && let Some(properties) =
                    component.get("properties").filter(|value| !value.is_null())
            {
                node.properties.insert(
                    "componentPropertyDefinitions".into(),
                    library_component_properties(
                        properties,
                        &component_map,
                        &mapping,
                        &variant_sets,
                    )?,
                );
            }
            if let Some(mapped) = node
                .properties
                .get("variantSetId")
                .and_then(Value::as_str)
                .and_then(|id| variant_sets.get(id))
            {
                node.properties.insert("variantSetId".into(), json!(mapped));
            }
            for key in ["slotContentFor", "slotInstanceFor"] {
                if let Some(target) = node.properties.get(key).and_then(Value::as_str)
                    && let Some(mapped) = mapping.get(target)
                {
                    node.properties.insert(key.into(), json!(mapped));
                }
            }
            if let Some(replacements) = node
                .properties
                .get_mut("slotReplacements")
                .and_then(Value::as_object_mut)
            {
                *replacements = std::mem::take(replacements)
                    .into_iter()
                    .map(|(key, value)| {
                        let mapped = key
                            .split('/')
                            .map(|part| mapping.get(part).map_or(part, String::as_str))
                            .collect::<Vec<_>>()
                            .join("/");
                        (mapped, value)
                    })
                    .collect();
            }
            for reference in [
                "fillStyleId",
                "strokeStyleId",
                "textStyleId",
                "effectStyleId",
            ] {
                if let Some(style) = node
                    .properties
                    .get(reference)
                    .and_then(Value::as_str)
                    .and_then(|id| style_map.get(id))
                {
                    let style = style.clone();
                    node.properties.insert(reference.into(), style.into());
                    let clears: Vec<&str> = match reference {
                        "fillStyleId" => vec!["fill", "fills"],
                        "strokeStyleId" => vec!["stroke", "strokes"],
                        "textStyleId" => vec![
                            "fontSize",
                            "fontFamily",
                            "fontWeight",
                            "fontStyle",
                            "lineHeight",
                            "letterSpacing",
                        ],
                        _ => vec!["shadows", "effects"],
                    };
                    for key in clears {
                        node.properties.remove(key);
                    }
                }
            }
            if let Some(component) = node
                .properties
                .get("componentId")
                .and_then(Value::as_str)
                .and_then(|id| component_map.get(id))
            {
                let value = component.clone();
                node.properties.insert("componentId".into(), value.into());
            }
            if kind == NodeKind::Text && node.properties.get("text").is_none() {
                if let Some(content) = node.properties.get("content") {
                    let mut runs = Vec::new();
                    text_runs(content, &style_map, &mut runs);
                    let text = runs
                        .iter()
                        .filter_map(|r: &Value| r["text"].as_str())
                        .collect::<String>();
                    node.properties.insert("text".into(), text.into());
                    node.properties.insert("textRuns".into(), json!(runs));
                }
            }
            node.properties
                .insert("libraryId".into(), json!(library_id));
            node.properties.insert("sourceNodeId".into(), json!(key));
            native_ids.insert(node.id.clone());
            if let Some(old) = snapshot.nodes.get(&node.id) {
                if old.kind != node.kind {
                    return Err(EngineError::new(
                        "conflict",
                        "library update changes a definition node kind; import as a separate library",
                    ));
                }
                let removed = old
                    .properties
                    .keys()
                    .filter(|k| {
                        !matches!(k.as_str(), "text" | "textRuns")
                            && !node.properties.contains_key(*k)
                    })
                    .cloned()
                    .collect::<Vec<_>>();
                if !removed.is_empty() {
                    commands.push(Command::NodeUnset {
                        node_id: node.id.clone(),
                        properties: removed,
                    });
                }
                if node.kind == NodeKind::Text {
                    update_text(old, &node, &mut commands)?;
                }
                let properties = node
                    .properties
                    .iter()
                    .filter(|(key, _)| !matches!(key.as_str(), "text" | "textRuns"))
                    .map(|(key, value)| (key.clone(), value.clone()))
                    .collect();
                commands.push(Command::NodeSet {
                    node_id: node.id.clone(),
                    properties,
                });
                if old.parent_id != node.parent_id || old.rank != node.rank {
                    commands.push(Command::NodeMove {
                        node_id: node.id,
                        parent_id: node.parent_id,
                        rank: node.rank,
                    });
                }
            } else {
                commands.push(Command::NodeCreate { node });
            }
            installed.insert(key);
        }
        if let Some(old) = entries
            .get(&library_id)
            .and_then(|entry| entry["nodeIds"].as_array())
        {
            let obsolete: BTreeSet<_> = old
                .iter()
                .filter_map(Value::as_str)
                .filter(|id| !native_ids.contains(*id) && snapshot.nodes.contains_key(*id))
                .collect();
            let definitions: BTreeSet<_> = obsolete
                .iter()
                .copied()
                .filter(|id| {
                    let node = &snapshot.nodes[*id];
                    node.kind == NodeKind::Component || library_ops::is_library_variant_set(node)
                })
                .collect();
            for node in snapshot
                .nodes
                .values()
                .filter(|node| !definitions.is_empty() && !obsolete.contains(node.id.as_str()))
            {
                if [
                    "componentId",
                    "componentProperties",
                    "propertyValues",
                    "componentOverrides",
                    "overrides",
                    "componentPropertyDefinitions",
                ]
                .iter()
                .filter_map(|key| node.properties.get(*key))
                .any(|value| references_removed_definition(value, &definitions))
                {
                    return Err(EngineError::new(
                        "conflict",
                        format!(
                            "Library update would remove a component still referenced by layer {}",
                            node.id
                        ),
                    ));
                }
            }
            let roots: Vec<_> = obsolete
                .iter()
                .copied()
                .filter(|id| {
                    snapshot.nodes[*id]
                        .parent_id
                        .as_deref()
                        .is_none_or(|parent| !obsolete.contains(parent))
                })
                .map(str::to_owned)
                .collect();
            if !roots.is_empty() {
                commands.push(Command::NodeDelete { node_ids: roots });
            }
        }
        let enabled = entries
            .get(&library_id)
            .and_then(|library| library["enabled"].as_bool())
            .or_else(|| source.get("enabled").and_then(Value::as_bool))
            .unwrap_or(true);
        let path = args["_path"].as_str().map(str::to_owned).or_else(|| {
            entries
                .get(&library_id)
                .and_then(|entry| entry["path"].as_str())
                .map(str::to_owned)
        });
        commands.push(Command::CatalogSet {
            namespace: "libraries".into(),
            entity_id: library_id.clone(),
            properties: properties(&json!({
                "name":source.get("name"), "version":source.get("version"), "snapshot":source, "path":path,
                "enabled":enabled, "deleted":false, "sourceDocumentId":source_document, "componentMap":component_map, "nodeIds":native_ids,
                "containerId":container_id, "styleMap":style_map, "collectionMap":collection_map, "variableMap":token_map,
            }))?,
        });
        crate::figcraft_catalog::variable_ops::sync_extensions(&snapshot, &mut commands)?;
        if commands.len() > 100 {
            return Err(EngineError::new(
                "resource_limit",
                "library update exceeds ordinary transaction limit",
            ));
        }
        let mut output = Properties::from([("id".into(), library_id.into())]);
        if let Some(source_id) = source_document {
            output.insert("sourceDocumentId".into(), source_id.into());
            output.insert(
                "installedVersion".into(),
                source.get("version").cloned().unwrap_or_default(),
            );
            output.insert("updateAvailable".into(), false.into());
        }
        self.submit_with_output(
            session,
            id,
            Command::Batch { commands },
            &meta,
            Some(snapshot.sequence),
            output,
        )
    }
}

fn remap_token_refs(value: &mut Value, tokens: &BTreeMap<String, String>) {
    match value {
        Value::Object(fields) => {
            if let Some(id) = fields
                .get("$token")
                .and_then(Value::as_str)
                .and_then(|id| tokens.get(id))
            {
                fields.insert("$token".into(), json!(id));
            }
            for value in fields.values_mut() {
                remap_token_refs(value, tokens);
            }
        }
        Value::Array(items) => {
            for value in items {
                remap_token_refs(value, tokens);
            }
        }
        _ => {}
    }
}

fn references_removed_definition(value: &Value, definitions: &BTreeSet<&str>) -> bool {
    match value {
        Value::String(id) => definitions.contains(id.as_str()),
        Value::Array(items) => items
            .iter()
            .any(|item| references_removed_definition(item, definitions)),
        Value::Object(items) => items
            .values()
            .any(|item| references_removed_definition(item, definitions)),
        _ => false,
    }
}

fn library_component_properties(
    properties: &Value,
    component_map: &BTreeMap<String, String>,
    node_map: &BTreeMap<String, String>,
    variant_sets: &BTreeMap<String, String>,
) -> Result<Value> {
    let properties = properties
        .as_array()
        .ok_or_else(|| EngineError::invalid("library component properties must be an array"))?;
    if properties.len() > 200 {
        return Err(EngineError::new(
            "resource_limit",
            "component property limit reached",
        ));
    }
    let mut ids = BTreeSet::new();
    let mut names = BTreeSet::new();
    let mut definitions = Vec::with_capacity(properties.len());
    for property in properties {
        let id = string(property, "id")?;
        let name = string(property, "name")?;
        if !ids.insert(id) || !names.insert(name) {
            return Err(EngineError::invalid("duplicate library component property"));
        }
        let kind = string(property, "type")?;
        if kind == "slot" {
            let layer = node_map
                .get(string(property, "layer")?)
                .ok_or_else(|| EngineError::invalid("library slot layer missing"))?;
            let preferred = property["preferred"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|asset| {
                    asset
                        .as_str()
                        .and_then(|id| component_map.get(id).or_else(|| variant_sets.get(id)))
                        .cloned()
                        .ok_or_else(|| {
                            EngineError::invalid("library slot preferred component missing")
                        })
                })
                .collect::<Result<Vec<_>>>()?;
            definitions
                .push(json!({"id":id,"name":name,"type":kind,"layer":layer,"preferred":preferred}));
            continue;
        }
        let default =
            match (kind, &property["default"]) {
                ("text", Value::String(text)) => json!(text),
                ("boolean", Value::Bool(value)) => json!(value),
                ("swap", Value::String(source)) if source.is_empty() => json!(""),
                ("swap", Value::String(source)) => json!(component_map.get(source).ok_or_else(
                    || EngineError::invalid("library component swap target missing")
                )?),
                _ => {
                    return Err(EngineError::invalid(
                        "invalid library component property default",
                    ));
                }
            };
        definitions.push(json!({"id":id,"name":name,"type":kind,"default":default}));
    }
    Ok(Value::Array(definitions))
}

// Library text uses the same character operations as local editing. Keeping the
// characters when only marks change preserves relative comment/selection anchors.
pub(crate) fn update_text(old: &Node, node: &Node, commands: &mut Vec<Command>) -> Result<()> {
    node.validate().map_err(EngineError::invalid)?;
    let text = node.string("text").unwrap_or("");
    let changed = old.string("text").unwrap_or("") != text;
    if changed {
        commands.push(Command::TextReplace {
            node_id: node.id.clone(),
            text: text.into(),
        });
    }
    if !changed && old.properties.get("textRuns") == node.properties.get("textRuns") {
        return Ok(());
    }
    if !changed {
        let mut clear = Properties::new();
        for run in old
            .properties
            .get("textRuns")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            if let Some(attributes) = run["attributes"].as_object() {
                for key in attributes.keys() {
                    clear.insert(key.clone(), Value::Null);
                }
            }
        }
        if !clear.is_empty() && !text.is_empty() {
            commands.push(Command::TextMark {
                node_id: node.id.clone(),
                start: 0,
                end: text.encode_utf16().count() as u32,
                attributes: clear,
            });
        }
    }
    let mut start = 0;
    for run in node
        .properties
        .get("textRuns")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let end = start + run["text"].as_str().unwrap().encode_utf16().count() as u32;
        let attributes = properties(&run["attributes"])?;
        if !attributes.is_empty() && start < end {
            commands.push(Command::TextMark {
                node_id: node.id.clone(),
                start,
                end,
                attributes,
            });
        }
        start = end;
    }
    Ok(())
}
fn text_runs(value: &Value, styles: &BTreeMap<String, String>, runs: &mut Vec<Value>) {
    if let Some(text) = value["text"].as_str() {
        let mut attributes = value.as_object().cloned().unwrap_or_default();
        attributes.remove("text");
        for key in ["fillStyleId", "textStyleId"] {
            if let Some(id) = attributes
                .get(key)
                .and_then(Value::as_str)
                .and_then(|id| styles.get(id))
            {
                let id = id.clone();
                attributes.insert(key.into(), id.into());
            }
        }
        runs.push(json!({"text":text,"attributes":attributes}));
    } else if let Some(values) = value.as_array() {
        for value in values {
            text_runs(value, styles, runs);
        }
    } else if let Some(children) = value.get("children") {
        text_runs(children, styles, runs);
    }
}
