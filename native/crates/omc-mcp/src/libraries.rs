//! Embedded library definitions keep stable native identities across source updates.
use super::*;
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
impl ToolRouter {
    pub(crate) fn library_tool(
        &self,
        session: &str,
        id: &str,
        args: Value,
        meta: Value,
    ) -> Result<Value> {
        let snapshot = self.workspace.snapshot(id)?;
        let entries = resources::catalogs(&snapshot.metadata, "libraries");
        let action = string(&args, "action")?;
        if action == "list" {
            return Ok(json!({"ok":true,"libraries":entries.values().collect::<Vec<_>>()}));
        }
        let library_id = args["id"]
            .as_str()
            .map(str::to_owned)
            .unwrap_or_else(|| new_id("library"));
        if matches!(action, "get" | "export") {
            let entry = entries
                .get(&library_id)
                .ok_or_else(|| EngineError::invalid("library not found"))?;
            return Ok(json!({"ok":true,"library":entry,"snapshot":entry["snapshot"]}));
        }
        if action == "insert" {
            let library = entries
                .get(&library_id)
                .filter(|entry| entry["enabled"] != false)
                .ok_or_else(|| EngineError::invalid("library unavailable or disabled"))?;
            let component = string(&args, "componentId")?;
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
        if !matches!(action, "add" | "update") {
            return Err(EngineError::invalid("unknown library action"));
        }
        if action == "update" && !entries.contains_key(&library_id) {
            return Err(EngineError::invalid("library not found"));
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
        let mut definition_roots = BTreeSet::new();
        for (key, component) in components {
            let main = component["mainId"]
                .as_str()
                .or_else(|| component["rootNodeId"].as_str())
                .ok_or_else(|| EngineError::invalid("library component mainId required"))?;
            let native = mapping
                .get(main)
                .ok_or_else(|| EngineError::invalid("component definition object missing"))?;
            definition_roots.insert(main.to_owned());
            component_map.insert(key.clone(), native.clone());
        }
        let mut style_map = BTreeMap::new();
        if let Some(styles) = source.get("styles").and_then(Value::as_object) {
            for key in styles.keys() {
                style_map.insert(key.clone(), stable_id("style", &library_id, key));
            }
            for (key, style) in styles {
                let value = style
                    .get("value")
                    .or_else(|| style.get("paints"))
                    .or_else(|| style.get("text"))
                    .or_else(|| style.get("effects"))
                    .cloned()
                    .ok_or_else(|| EngineError::invalid("library style value missing"))?;
                commands.push(Command::CatalogSet{namespace:"styles".into(),entity_id:style_map[key].clone(),properties:properties(&json!({"name":style["name"],"type":style["type"],"value":value,"libraryId":library_id,"deleted":false}))?});
            }
        }
        let mut remaining: BTreeSet<_> = objects.keys().cloned().collect();
        let mut installed = BTreeSet::new();
        let mut native_ids = BTreeSet::new();
        while !remaining.is_empty() {
            let key = remaining
                .iter()
                .find(|key| {
                    let parent = objects[*key]["parentId"].as_str();
                    definition_roots.contains(*key)
                        || parent.is_none_or(|p| !mapping.contains_key(p) || installed.contains(p))
                })
                .cloned()
                .ok_or_else(|| EngineError::invalid("cyclic library objects"))?;
            remaining.remove(&key);
            let object = &objects[&key];
            let kind = if definition_roots.contains(&key) {
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
            node.parent_id = Some(if definition_roots.contains(&key) {
                container_id.clone()
            } else {
                object["parentId"]
                    .as_str()
                    .and_then(|p| mapping.get(p))
                    .cloned()
                    .unwrap_or(container_id.clone())
            });
            node.rank = format!(
                "{:032x}",
                (installed.len() as u128 + 1) * (u64::MAX as u128)
            );
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
            let obsolete = old
                .iter()
                .filter_map(Value::as_str)
                .filter(|id| !native_ids.contains(*id) && snapshot.nodes.contains_key(*id))
                .map(str::to_owned)
                .collect::<Vec<_>>();
            if !obsolete.is_empty() {
                commands.push(Command::NodeDelete { node_ids: obsolete });
            }
        }
        commands.push(Command::CatalogSet{namespace:"libraries".into(),entity_id:library_id.clone(),properties:properties(&json!({"name":source.get("name"),"version":source.get("version"),"snapshot":source,"enabled":true,"componentMap":component_map,"nodeIds":native_ids,"containerId":container_id}))?});
        if commands.len() > 100 {
            return Err(EngineError::new(
                "resource_limit",
                "library update exceeds ordinary transaction limit",
            ));
        }
        let mut result = self.submit(
            session,
            id,
            Command::Batch { commands },
            &meta,
            Some(snapshot.sequence),
        )?;
        result["id"] = library_id.into();
        Ok(result)
    }
}

// Library text uses the same character operations as local editing. Keeping the
// characters when only marks change preserves relative comment/selection anchors.
fn update_text(old: &Node, node: &Node, commands: &mut Vec<Command>) -> Result<()> {
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
