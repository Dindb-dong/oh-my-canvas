use super::*;
use base64::Engine;
use omc_assets::AssetStore;
use omc_model::{NodeKind, new_id, rank_between};
use std::{io::Read, path::Path};

pub(crate) struct Resources(pub AssetStore);
impl omc_render::ResourceProvider for Resources {
    fn get(&self, hash: &str) -> std::result::Result<Vec<u8>, String> {
        self.0.read(hash).map_err(|e| e.message)
    }
}
pub(crate) fn catalogs(metadata: &Properties, namespace: &str) -> BTreeMap<String, Value> {
    let prefix = format!("{namespace}/");
    let mut out: BTreeMap<String, Value> = BTreeMap::new();
    for (key, value) in metadata {
        if let Some(suffix) = key.strip_prefix(&prefix) {
            if let Some((id, field)) = suffix.split_once('/') {
                let object = out.entry(id.into()).or_insert_with(|| json!({"id":id}));
                object[field] = value.clone();
            }
        }
    }
    out.retain(|_, v| v["deleted"] != true);
    out
}
pub(crate) fn read_explicit(path: &str, max: usize) -> Result<Vec<u8>> {
    let path = Path::new(path);
    if !path.is_absolute() {
        return Err(EngineError::invalid(
            "an explicit absolute filePath is required",
        ));
    }
    let file = std::fs::File::open(path).map_err(io_error)?;
    let metadata = file.metadata().map_err(io_error)?;
    if !metadata.is_file() || metadata.len() > max as u64 {
        return Err(EngineError::new(
            "resource_limit",
            "input must be a bounded regular file",
        ));
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take(max as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(io_error)?;
    if bytes.len() > max {
        return Err(EngineError::new(
            "resource_limit",
            "input grew beyond its reserved byte limit",
        ));
    }
    Ok(bytes)
}
pub(crate) fn decode_data_url(url: &str) -> Result<(String, Vec<u8>)> {
    let (header, payload) = url
        .strip_prefix("data:")
        .and_then(|s| s.split_once(','))
        .ok_or_else(|| EngineError::invalid("embedded data URL required"))?;
    let mime = header
        .strip_suffix(";base64")
        .ok_or_else(|| EngineError::invalid("data URL must use base64"))?;
    if payload.len() > 90 * 1024 * 1024 {
        return Err(EngineError::new("resource_limit", "asset too large"));
    }
    Ok((
        mime.to_owned(),
        base64::engine::general_purpose::STANDARD
            .decode(payload)
            .map_err(|e| EngineError::invalid(e.to_string()))?,
    ))
}
pub(crate) fn detect_mime(bytes: &[u8]) -> Result<&'static str> {
    Ok(if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        "image/png"
    } else if bytes.starts_with(b"\xff\xd8\xff") {
        "image/jpeg"
    } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        "image/webp"
    } else if bytes.starts_with(b"OTTO") {
        "font/otf"
    } else if bytes.starts_with(b"\0\x01\0\0") || bytes.starts_with(b"ttcf") {
        "font/ttf"
    } else if bytes.starts_with(b"wOFF") {
        "font/woff"
    } else if bytes.starts_with(b"wOF2") {
        "font/woff2"
    } else if std::str::from_utf8(bytes).is_ok_and(|s| s.contains("<svg")) {
        "image/svg+xml"
    } else {
        return Err(EngineError::invalid("unrecognized resource media type"));
    })
}
pub(crate) fn io_error(e: std::io::Error) -> EngineError {
    EngineError::new("storage_unavailable", e.to_string())
}

impl ToolRouter {
    pub(crate) fn resources(&self) -> Result<Resources> {
        Ok(Resources(AssetStore::open(&self.workspace.profile)?))
    }
    pub(crate) fn assets_tool(
        &self,
        session: &str,
        id: &str,
        args: Value,
        meta: Value,
    ) -> Result<Value> {
        if args["action"] != "list" {
            if let Some(replay) = self.replay(session, id, &meta)? {
                return Ok(replay);
            }
        }
        let snapshot = self.workspace.snapshot(id)?;
        let assets = catalogs(&snapshot.metadata, "assets");
        match string(&args, "action")? {
            "list" => {
                let query = args["query"].as_str().unwrap_or("").to_lowercase();
                Ok(
                    json!({"ok":true,"assets":assets.values().filter(|a|a["name"].as_str().unwrap_or("").to_lowercase().contains(&query)).cloned().collect::<Vec<_>>()}),
                )
            }
            "add" => {
                let mut value = json!({"name":args["name"].as_str().unwrap_or("Asset"),"kind":args["kind"].as_str().unwrap_or("image")});
                let store = self.resources()?.0;
                if let Some(faces) = args["faces"].as_array() {
                    let mut out = Vec::new();
                    for face in faces {
                        let (mime, bytes) = decode_data_url(
                            face["dataUrl"]
                                .as_str()
                                .or_else(|| face["url"].as_str())
                                .ok_or_else(|| {
                                    EngineError::invalid("embedded font face required")
                                })?,
                        )?;
                        if !mime.starts_with("font/") {
                            return Err(EngineError::invalid("font media type required"));
                        }
                        let asset = store.ingest(&bytes, &mime)?;
                        let mut entry = face.clone();
                        entry.as_object_mut().unwrap().remove("dataUrl");
                        entry.as_object_mut().unwrap().remove("url");
                        entry["hash"] = asset.hash.into();
                        entry["mimeType"] = mime.into();
                        out.push(entry);
                    }
                    value["faces"] = json!(out);
                } else {
                    let (mime, bytes) = decode_data_url(string(&args, "dataUrl")?)?;
                    let asset = store.ingest(&bytes, &mime)?;
                    value["hash"] = asset.hash.into();
                    value["mimeType"] = mime.into();
                    value["byteLength"] = json!(asset.byte_length);
                }
                for key in ["family", "weight", "fontStyle", "unicodeRange"] {
                    if let Some(v) = args.get(key) {
                        value[key] = v.clone();
                    }
                }
                let asset_id = new_id("asset");
                let mut result = self.submit(
                    session,
                    id,
                    Command::CatalogSet {
                        namespace: "assets".into(),
                        entity_id: asset_id.clone(),
                        properties: properties(&value)?,
                    },
                    &meta,
                    Some(snapshot.sequence),
                )?;
                result["id"] = asset_id.into();
                result["asset"] = value;
                Ok(result)
            }
            "remove" => {
                let asset_id = string(&args, "id")?;
                let asset = assets
                    .get(asset_id)
                    .ok_or_else(|| EngineError::invalid("asset not found"))?;
                if snapshot.nodes.values().any(|n| {
                    n.properties.get("assetId") == Some(&json!(asset_id))
                        || asset["hash"].is_string()
                            && n.properties.get("assetHash") == Some(&asset["hash"])
                }) {
                    return Err(EngineError::new("conflict", "asset still has placed users"));
                }
                self.submit(
                    session,
                    id,
                    Command::CatalogSet {
                        namespace: "assets".into(),
                        entity_id: asset_id.into(),
                        properties: properties(&json!({"deleted":true}))?,
                    },
                    &meta,
                    Some(snapshot.sequence),
                )
            }
            "place" => {
                let asset_id = string(&args, "id")?;
                let asset = assets
                    .get(asset_id)
                    .ok_or_else(|| EngineError::invalid("asset not found"))?;
                if asset["kind"] == "font" {
                    return Err(EngineError::invalid(
                        "fonts are selected through text style",
                    ));
                }
                let parent = args["parentId"]
                    .as_str()
                    .map(|p| self.resolve(session, id, p))
                    .transpose()?
                    .unwrap_or(self.state(session, id)?.root);
                let mut node = Node::new(NodeKind::Image);
                node.parent_id = Some(parent.clone());
                node.rank = rank_between(
                    children(&snapshot, &parent).last().map(|n| n.rank.as_str()),
                    None,
                )
                .ok_or_else(|| EngineError::new("resource_limit", "rank rebalance required"))?;
                node.properties = properties(
                    &json!({"assetId":asset_id,"assetHash":asset["hash"],"name":asset["name"]}),
                )?;
                for (k, d) in [("x", 0.), ("y", 0.), ("width", 100.), ("height", 100.)] {
                    node.properties
                        .insert(k.into(), args.get(k).cloned().unwrap_or(json!(d)));
                }
                let raw = node.id.clone();
                let mut result = self.submit(
                    session,
                    id,
                    Command::NodeCreate { node },
                    &meta,
                    Some(snapshot.sequence),
                )?;
                result["id"] = self.alias(session, id, &raw).into();
                Ok(result)
            }
            _ => Err(EngineError::invalid("unknown asset action")),
        }
    }
    pub(crate) fn import_resource(&self, session: &str, args: Value, meta: Value) -> Result<Value> {
        let id = native_id(string(&args, "documentId")?)?;
        self.context(session, &id)?;
        let bytes = read_explicit(string(&args, "filePath")?, 64 * 1024 * 1024)?;
        if args["kind"] == "library" {
            let snapshot: Value =
                serde_json::from_slice(&bytes).map_err(|e| EngineError::invalid(e.to_string()))?;
            return self.catalog_tool(
                session,
                &id,
                "libraries",
                json!({"action":"add","snapshot":snapshot}),
                meta,
            );
        }
        let mime = detect_mime(&bytes)?;
        let mut add = args.clone();
        add["action"] = "add".into();
        add["dataUrl"] = format!(
            "data:{mime};base64,{}",
            base64::engine::general_purpose::STANDARD.encode(bytes)
        )
        .into();
        self.assets_tool(session, &id, add, meta)
    }
    pub(crate) fn catalog_tool(
        &self,
        session: &str,
        id: &str,
        name: &str,
        args: Value,
        meta: Value,
    ) -> Result<Value> {
        if !matches!(
            args["action"].as_str(),
            Some("list" | "get" | "users" | "export")
        ) {
            if let Some(replay) = self.replay(session, id, &meta)? {
                return Ok(replay);
            }
        }
        if name == "libraries" {
            return self.library_tool(session, id, args, meta);
        }
        let snapshot = self.workspace.snapshot(id)?;
        let entries = catalogs(&snapshot.metadata, "styles");
        let action = string(&args, "action")?;
        if action == "list" {
            let query = args["query"].as_str().unwrap_or("").to_lowercase();
            return Ok(
                json!({"ok":true,"styles":entries.values().filter(|v|v["name"].as_str().unwrap_or("").to_lowercase().contains(&query)&&args.get("type").is_none_or(|t|v["type"]==*t)).collect::<Vec<_>>()}),
            );
        }
        let style_id = if action == "detach" {
            String::new()
        } else if matches!(action, "create" | "duplicate") {
            new_id("style")
        } else {
            string(&args, "id")?.into()
        };
        let existing = if action == "create" || action == "detach" {
            json!({})
        } else {
            entries
                .get(string(&args, "id")?)
                .cloned()
                .ok_or_else(|| EngineError::invalid("style not found"))?
        };
        if action == "get" {
            return Ok(json!({"ok":true,"style":existing}));
        }
        if action == "users" {
            let ids: Vec<_> = snapshot
                .nodes
                .values()
                .filter(|n| {
                    [
                        "fillStyleId",
                        "strokeStyleId",
                        "textStyleId",
                        "effectStyleId",
                    ]
                    .iter()
                    .any(|k| n.properties.get(*k) == Some(&json!(style_id)))
                })
                .map(|n| self.alias(session, id, &n.id))
                .collect();
            return Ok(json!({"ok":true,"ids":ids}));
        }
        let commands = if matches!(action, "apply" | "detach") {
            let kind = args["kind"]
                .as_str()
                .unwrap_or(match existing["type"].as_str() {
                    Some("text") => "text",
                    Some("effect") => "effect",
                    _ => "fill",
                });
            let key = format!("{kind}StyleId");
            let clear = match kind {
                "fill" => vec!["fill", "fills"],
                "stroke" => vec!["stroke", "strokes"],
                "text" => vec![
                    "fontFamily",
                    "fontSize",
                    "fontWeight",
                    "fontStyle",
                    "color",
                    "lineHeight",
                    "letterSpacing",
                    "textAlign",
                ],
                _ => vec!["effects", "shadows", "blur"],
            };
            let references = omc_style::ReferenceContext::new(&snapshot);
            let mut commands = Vec::new();
            for v in args["ids"]
                .as_array()
                .ok_or_else(|| EngineError::invalid("ids required"))?
            {
                let raw = self.resolve(
                    session,
                    id,
                    v.as_str()
                        .ok_or_else(|| EngineError::invalid("invalid node ID"))?,
                )?;
                if action == "apply" {
                    commands.push(Command::NodeUnset {
                        node_id: raw.clone(),
                        properties: clear.iter().map(|s| s.to_string()).collect(),
                    });
                    commands.push(Command::NodeSet {
                        node_id: raw,
                        properties: Properties::from([(key.clone(), json!(style_id))]),
                    });
                } else {
                    let node = snapshot
                        .nodes
                        .get(&raw)
                        .ok_or_else(|| EngineError::invalid("layer not found"))?;
                    let (effective, _) = references.properties(node);
                    let mut patch = Properties::new();
                    for prop in &clear {
                        if let Some(value) = effective.get(*prop) {
                            patch.insert((*prop).into(), value.clone());
                        }
                    }
                    if !patch.is_empty() {
                        commands.push(Command::NodeSet {
                            node_id: raw.clone(),
                            properties: patch,
                        });
                    }
                    commands.push(Command::NodeUnset {
                        node_id: raw,
                        properties: vec![key.clone()],
                    });
                }
            }
            commands
        } else {
            let mut value = match action {
                "create" => {
                    json!({"name":string(&args,"name")?,"type":string(&args,"type")?,"value":args.get("value").ok_or_else(||EngineError::invalid("value required"))?,"description":args["description"]})
                }
                "duplicate" => existing,
                "update" => args["patch"].clone(),
                "delete" => json!({"deleted":true}),
                _ => return Err(EngineError::invalid("unknown style action")),
            };
            if let Some(obj) = value.as_object_mut() {
                obj.remove("id");
            }
            vec![Command::CatalogSet {
                namespace: "styles".into(),
                entity_id: style_id.clone(),
                properties: properties(&value)?,
            }]
        };
        let mut result = self.submit(
            session,
            id,
            Command::Batch { commands },
            &meta,
            Some(snapshot.sequence),
        )?;
        result["id"] = style_id.into();
        Ok(result)
    }
    pub(crate) fn clipboard_tool(
        &self,
        session: &str,
        id: &str,
        args: Value,
        meta: Value,
    ) -> Result<Value> {
        let snapshot = self.workspace.snapshot(id)?;
        let action = string(&args, "action")?;
        if matches!(action, "copy" | "cut" | "copy_properties") {
            let ids: Vec<String> = args["ids"]
                .as_array()
                .ok_or_else(|| EngineError::invalid("ids required"))?
                .iter()
                .map(|v| self.resolve(session, id, v.as_str().unwrap_or("")))
                .collect::<Result<_>>()?;
            let mut all = std::collections::BTreeSet::new();
            let mut pending = ids.clone();
            while let Some(raw) = pending.pop() {
                if !all.insert(raw.clone()) {
                    continue;
                }
                pending.extend(children(&snapshot, &raw).iter().map(|n| n.id.clone()));
            }
            let payload = if action == "copy_properties" {
                json!({"format":"omc.clipboard-properties/1","properties":snapshot.nodes.get(&ids[0]).ok_or_else(||EngineError::invalid("node not found"))?.properties})
            } else {
                json!({"format":"omc.clipboard/1","roots":ids,"nodes":all.iter().filter_map(|raw|snapshot.nodes.get(raw)).collect::<Vec<_>>()})
            };
            if action == "cut" {
                self.submit(
                    session,
                    id,
                    Command::NodeDelete { node_ids: ids },
                    &meta,
                    Some(snapshot.sequence),
                )?;
            }
            self.states
                .lock()
                .unwrap()
                .get_mut(&(session.into(), id.into()))
                .unwrap()
                .clipboard = Some(payload.clone());
            return Ok(json!({"ok":true,"payload":payload}));
        }
        let payload = args
            .get("payload")
            .cloned()
            .or(self.state(session, id)?.clipboard)
            .ok_or_else(|| EngineError::invalid("clipboard is empty"))?;
        if action == "paste_properties" {
            if payload["format"] != "omc.clipboard-properties/1" {
                return Err(EngineError::invalid("property payload required"));
            }
            let patch = properties(&payload["properties"])?;
            let commands = args["ids"]
                .as_array()
                .ok_or_else(|| EngineError::invalid("ids required"))?
                .iter()
                .map(|v| {
                    Ok(Command::NodeSet {
                        node_id: self.resolve(session, id, v.as_str().unwrap_or(""))?,
                        properties: patch.clone(),
                    })
                })
                .collect::<Result<Vec<_>>>()?;
            return self.submit(
                session,
                id,
                Command::Batch { commands },
                &meta,
                Some(snapshot.sequence),
            );
        }
        if action != "paste" || payload["format"] != "omc.clipboard/1" {
            return Err(EngineError::invalid("native layer payload required"));
        }
        if args["mode"] == "replace" {
            return Err(EngineError::new(
                "unsupported_feature",
                "replace clipboard mode requires transform-aware selection conversion",
            ));
        }
        let nodes: Vec<Node> = serde_json::from_value(payload["nodes"].clone())
            .map_err(|e| EngineError::invalid(e.to_string()))?;
        if nodes.len() > 100 {
            return Err(EngineError::new(
                "resource_limit",
                "clipboard batch exceeds 100 nodes",
            ));
        }
        let map: BTreeMap<_, _> = nodes
            .iter()
            .map(|n| (n.id.clone(), new_id("node")))
            .collect();
        let parent = args["parentId"]
            .as_str()
            .map(|p| self.resolve(session, id, p))
            .transpose()?
            .unwrap_or(self.state(session, id)?.root);
        let mut rank = rank_between(
            children(&snapshot, &parent).last().map(|n| n.rank.as_str()),
            None,
        )
        .ok_or_else(|| EngineError::new("resource_limit", "rank rebalance required"))?;
        let mut pending = nodes;
        let mut done = std::collections::BTreeSet::new();
        let mut commands = Vec::new();
        let mut created = Vec::new();
        while !pending.is_empty() {
            let index = pending
                .iter()
                .position(|n| {
                    n.parent_id
                        .as_ref()
                        .is_none_or(|p| !map.contains_key(p) || done.contains(p))
                })
                .ok_or_else(|| EngineError::invalid("cyclic clipboard payload"))?;
            let mut node = pending.remove(index);
            let old = node.id.clone();
            let top = node.parent_id.as_ref().is_none_or(|p| !map.contains_key(p));
            node.id = map[&old].clone();
            node.parent_id = Some(
                node.parent_id
                    .as_ref()
                    .and_then(|p| map.get(p))
                    .cloned()
                    .unwrap_or(parent.clone()),
            );
            node.home_shard = new_id("shard");
            remap_values(&mut node.properties, &map);
            if top {
                node.rank = rank.clone();
                rank = rank_between(Some(&rank), None)
                    .ok_or_else(|| EngineError::new("resource_limit", "rank exhausted"))?;
                for key in ["x", "y"] {
                    if let Some(v) = args.get(key) {
                        node.properties.insert(key.into(), v.clone());
                    } else if args["mode"] != "in_place" {
                        node.properties
                            .insert(key.into(), json!(node.number(key, 0.) + 16.));
                    }
                }
            }
            created.push(node.id.clone());
            commands.push(Command::NodeCreate { node });
            done.insert(old);
        }
        let mut result = self.submit(
            session,
            id,
            Command::Batch { commands },
            &meta,
            Some(snapshot.sequence),
        )?;
        result["ids"] = json!(
            created
                .iter()
                .map(|raw| self.alias(session, id, raw))
                .collect::<Vec<_>>()
        );
        Ok(result)
    }
}
