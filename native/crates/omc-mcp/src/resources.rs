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
        if matches!(action, "cut" | "paste" | "paste_properties")
            && let Some(replayed) = self.replay(session, id, &meta)?
        {
            if action == "cut"
                && let Some(payload) = replayed.get("payload")
            {
                self.legacy_clipboards
                    .lock()
                    .unwrap()
                    .insert(session.to_owned(), payload.clone());
            }
            return Ok(replayed);
        }
        if matches!(action, "copy" | "cut" | "copy_properties") {
            let ids: Vec<String> = args["ids"]
                .as_array()
                .ok_or_else(|| EngineError::invalid("ids required"))?
                .iter()
                .map(|v| self.resolve(session, id, v.as_str().unwrap_or("")))
                .collect::<Result<_>>()?;
            let page = self.state(session, id)?;
            let scene = paths::scene(&snapshot, &page.page_id)?;
            let ids = clipboard_roots(&snapshot, &ids);
            for raw in &ids {
                if raw == &page.root
                    || !scene.item(raw).is_some()
                    || action == "cut" && !paths::editable(&scene, raw)
                {
                    return Err(EngineError::invalid(
                        "clipboard selection is invalid, locked or outside the page",
                    ));
                }
            }
            let mut all = std::collections::BTreeSet::new();
            let mut pending = ids.clone();
            while let Some(raw) = pending.pop() {
                if !all.insert(raw.clone()) {
                    continue;
                }
                pending.extend(children(&snapshot, &raw).iter().map(|n| n.id.clone()));
            }
            let payload = if action == "copy_properties" {
                let source = snapshot
                    .nodes
                    .get(&ids[0])
                    .ok_or_else(|| EngineError::invalid("node not found"))?;
                let allowed = clipboard_property_fields();
                let properties: Properties = source
                    .properties
                    .iter()
                    .filter(|(key, _)| allowed.contains(key.as_str()))
                    .map(|(key, value)| (key.clone(), value.clone()))
                    .collect();
                let style_definitions = catalogs(&snapshot.metadata, "styles");
                let style_definitions: BTreeMap<_, _> = properties
                    .iter()
                    .filter(|(key, _)| key.ends_with("StyleId"))
                    .filter_map(|(_, value)| value.as_str())
                    .filter_map(|id| style_definitions.get(id).map(|value| (id, value)))
                    .collect();
                let text_formatting = source
                    .properties
                    .get("textRuns")
                    .and_then(Value::as_array)
                    .filter(|_| source.kind == NodeKind::Text)
                    .map(|runs| {
                        runs.iter()
                            .map(|run| run["attributes"].clone())
                            .collect::<Vec<_>>()
                    });
                json!({"format":"omc.clipboard-properties/1","properties":properties,"styleDefinitions":style_definitions,"textFormatting":text_formatting})
            } else {
                let geometry: BTreeMap<_, _> = ids
                    .iter()
                    .filter_map(|raw| {
                        scene
                            .item(raw)
                            .map(|item| (raw, json!({"matrix":item.world.0,"bounds":item.bounds})))
                    })
                    .collect();
                let mut payload = json!({"format":"omc.clipboard/1","roots":ids,"nodes":all.iter().filter_map(|raw|snapshot.nodes.get(raw)).collect::<Vec<_>>(),"rootGeometry":geometry});
                let native_bytes = serde_json::to_vec(&payload)
                    .map_err(|error| EngineError::invalid(error.to_string()))?
                    .len();
                let budget = omc_protocol::MAX_REQUEST_BYTES.saturating_sub(native_bytes + 4096);
                match self.export_legacy_clipboard(
                    &snapshot,
                    &scene,
                    &page.page_id,
                    &ids,
                    &all,
                    budget,
                ) {
                    Ok(legacy) => payload.as_object_mut().unwrap().extend(legacy),
                    Err(error) => payload["legacyCompatibility"] = json!({"error":error.message}),
                }
                payload
            };
            let result = if action == "cut" {
                self.submit_with_output(
                    session,
                    id,
                    Command::NodeDelete { node_ids: ids },
                    &meta,
                    Some(snapshot.sequence),
                    Properties::from([("payload".into(), payload.clone())]),
                )?
            } else {
                json!({"ok":true,"payload":payload})
            };
            self.legacy_clipboards
                .lock()
                .unwrap()
                .insert(session.to_owned(), payload);
            return Ok(result);
        }
        let payload = args
            .get("payload")
            .cloned()
            .or_else(|| self.legacy_clipboards.lock().unwrap().get(session).cloned())
            .ok_or_else(|| EngineError::invalid("clipboard is empty"))?;
        if action == "paste_properties" {
            if payload["format"] != "omc.clipboard-properties/1" {
                return Err(EngineError::invalid("property payload required"));
            }
            let mut patch = properties(&payload["properties"])?;
            let allowed = clipboard_property_fields();
            let definitions = catalogs(&snapshot.metadata, "styles");
            patch.retain(|key, value| {
                allowed.contains(key.as_str())
                    && (!key.ends_with("StyleId")
                        || value.as_str().is_some_and(|id| {
                            definitions
                                .get(id)
                                .is_some_and(|style| payload["styleDefinitions"][id] == *style)
                        }))
            });
            let formatting = payload["textFormatting"]
                .as_array()
                .filter(|runs| !runs.is_empty());
            let allowed_attributes = clipboard_text_style_fields();
            let attributes = formatting
                .into_iter()
                .flatten()
                .map(|run| {
                    let mut attributes = properties(run)?;
                    attributes.retain(|key, _| allowed_attributes.contains(key.as_str()));
                    Ok(attributes)
                })
                .collect::<Result<Vec<_>>>()?;
            let page = self.state(session, id)?;
            let scene = paths::scene(&snapshot, &page.page_id)?;
            let ids = args["ids"]
                .as_array()
                .ok_or_else(|| EngineError::invalid("ids required"))?;
            let mut commands = Vec::new();
            let mut selection = Vec::new();
            for value in ids {
                let raw = self.resolve(session, id, value.as_str().unwrap_or_default())?;
                if raw == page.root || !paths::editable(&scene, &raw) {
                    return Err(EngineError::invalid(
                        "clipboard destination is unavailable or locked",
                    ));
                }
                let node = &snapshot.nodes[&raw];
                if !patch.is_empty() {
                    commands.push(Command::NodeSet {
                        node_id: raw.clone(),
                        properties: patch.clone(),
                    });
                }
                if node.kind == NodeKind::Text && !attributes.is_empty() {
                    let lengths = node
                        .properties
                        .get("textRuns")
                        .and_then(Value::as_array)
                        .filter(|runs| !runs.is_empty())
                        .map(|runs| {
                            runs.iter()
                                .map(|run| {
                                    run["text"]
                                        .as_str()
                                        .unwrap_or_default()
                                        .encode_utf16()
                                        .count() as u32
                                })
                                .collect::<Vec<_>>()
                        })
                        .unwrap_or_else(|| {
                            vec![
                                node.string("text")
                                    .unwrap_or_default()
                                    .encode_utf16()
                                    .count() as u32,
                            ]
                        });
                    let mut start = 0;
                    for (index, length) in lengths.into_iter().enumerate() {
                        let marks = attributes[index.min(attributes.len() - 1)].clone();
                        if length > 0 && !marks.is_empty() {
                            commands.push(Command::TextMark {
                                node_id: raw.clone(),
                                start,
                                end: start + length,
                                attributes: marks,
                            });
                        }
                        start += length;
                    }
                }
                selection.push(raw);
            }
            if commands.is_empty() {
                return Ok(
                    json!({"ok":true,"changed":false,"rawSelection":selection,"selection":selection.iter().map(|raw| self.alias(session,id,raw)).collect::<Vec<_>>()}),
                );
            }
            if commands.len() > 100 {
                return Err(EngineError::new(
                    "resource_limit",
                    "clipboard properties exceed the transaction limit",
                ));
            }
            return self.submit_with_output(
                session,
                id,
                Command::Batch { commands },
                &meta,
                Some(snapshot.sequence),
                Properties::from([("rawSelection".into(), json!(selection))]),
            );
        }
        if action == "paste" && payload["kind"] == "text" {
            let text = string(&payload, "text")?;
            let state = self.state(session, id)?;
            let parent = args["parentId"]
                .as_str()
                .map(|id_value| self.resolve(session, id, id_value))
                .transpose()?
                .unwrap_or(state.root);
            let scene = paths::scene(&snapshot, &state.page_id)?;
            if !paths::editable(&scene, &parent) {
                return Err(EngineError::invalid(
                    "clipboard destination is unavailable or locked",
                ));
            }
            let mut node = Node::new(NodeKind::Text);
            node.rank = rank_between(
                children(&snapshot, &parent)
                    .last()
                    .map(|node| node.rank.as_str()),
                None,
            )
            .ok_or_else(|| EngineError::new("resource_limit", "rank rebalance required"))?;
            node.parent_id = Some(parent);
            node.properties = properties(&json!({
                "text":text,
                "x":args["x"].as_f64().unwrap_or_else(|| state.view["viewport"]["vbox"]["x"].as_f64().unwrap_or(0.) + 20.),
                "y":args["y"].as_f64().unwrap_or_else(|| state.view["viewport"]["vbox"]["y"].as_f64().unwrap_or(0.) + 20.)
            }))?;
            return self.submit_with_output(
                session,
                id,
                Command::NodeCreate { node: node.clone() },
                &meta,
                Some(snapshot.sequence),
                Properties::from([("rawSelection".into(), json!([node.id]))]),
            );
        }
        let legacy = payload["format"] != "omc.clipboard/1"
            && payload["kind"] == crate::clipboard_legacy::KIND;
        let payload = if action == "paste" && legacy {
            self.import_legacy_clipboard(&payload)?
        } else {
            payload
        };
        if action != "paste" || payload["format"] != "omc.clipboard/1" {
            return Err(EngineError::invalid("native layer payload required"));
        }
        let state = self.state(session, id)?;
        let replace = args["mode"] == "replace";
        let mut replaced = Vec::new();
        if replace {
            let targets = args["ids"]
                .as_array()
                .filter(|targets| !targets.is_empty())
                .ok_or_else(|| EngineError::invalid("paste replace requires explicit ids"))?;
            for value in targets {
                let raw = self.resolve(session, id, value.as_str().unwrap_or_default())?;
                if raw == state.root || !snapshot.nodes.contains_key(&raw) {
                    return Err(EngineError::invalid("choose replaceable layers"));
                }
                replaced.push(raw);
            }
            replaced = clipboard_roots(&snapshot, &replaced);
        }
        let nodes: Vec<Node> = serde_json::from_value(payload["nodes"].clone())
            .map_err(|e| EngineError::invalid(e.to_string()))?;
        if nodes.is_empty() {
            return Err(EngineError::invalid("clipboard payload is empty"));
        }
        if nodes.len() + usize::from(replace) > 100 {
            return Err(EngineError::new(
                "resource_limit",
                "clipboard batch exceeds 100 nodes",
            ));
        }
        let map: BTreeMap<_, _> = nodes
            .iter()
            .map(|n| (n.id.clone(), new_id("node")))
            .collect();
        if map.len() != nodes.len() {
            return Err(EngineError::invalid("duplicate clipboard layer IDs"));
        }
        let parent = args["parentId"]
            .as_str()
            .map(|p| self.resolve(session, id, p))
            .transpose()?
            .or_else(|| {
                replaced
                    .first()
                    .and_then(|raw| snapshot.nodes[raw].parent_id.clone())
            })
            .unwrap_or(state.root);
        let scene = paths::scene(&snapshot, &state.page_id)?;
        if !paths::editable(&scene, &parent) {
            return Err(EngineError::invalid(
                "clipboard destination is unavailable or locked",
            ));
        }
        let placement = if replace {
            if replaced.iter().any(|raw| !paths::editable(&scene, raw))
                || clipboard_roots(
                    &snapshot,
                    &replaced
                        .iter()
                        .cloned()
                        .chain([parent.clone()])
                        .collect::<Vec<_>>(),
                )
                .iter()
                .all(|raw| raw != &parent)
                || replaced.contains(&parent)
            {
                return Err(EngineError::invalid(
                    "clipboard replacement is locked, outside this page, or contains the destination",
                ));
            }
            let target_origin =
                clipboard_origin(replaced.iter().filter_map(|raw| scene.bounds(raw)))?;
            let parent_item = scene.item(&parent).unwrap();
            if matches!(
                parent_item.style.get("display"),
                Some("flex" | "inline-flex" | "grid" | "inline-grid")
            ) {
                return Err(EngineError::invalid(
                    "paste replace requires a positioned parent",
                ));
            }
            let inverse = parent_item
                .world
                .inverse()
                .ok_or_else(|| EngineError::invalid("destination transform is singular"))?;
            let source_origin = clipboard_origin(
                nodes
                    .iter()
                    .filter(|node| {
                        node.parent_id
                            .as_ref()
                            .is_none_or(|raw| !map.contains_key(raw))
                    })
                    .map(|node| clipboard_geometry(node, &payload).map(|(_, bounds)| bounds))
                    .collect::<Result<Vec<_>>>()?,
            )?;
            Some((
                inverse,
                target_origin.0 - source_origin.0,
                target_origin.1 - source_origin.1,
            ))
        } else if legacy {
            let inverse = scene
                .item(&parent)
                .unwrap()
                .world
                .inverse()
                .ok_or_else(|| EngineError::invalid("destination transform is singular"))?;
            let source = clipboard_origin(
                nodes
                    .iter()
                    .filter(|node| {
                        node.parent_id
                            .as_ref()
                            .is_none_or(|parent| !map.contains_key(parent))
                    })
                    .map(|node| clipboard_geometry(node, &payload).map(|(_, bounds)| bounds))
                    .collect::<Result<Vec<_>>>()?,
            )?;
            let default_offset = if args["mode"] == "in_place" { 0. } else { 10. };
            Some((
                inverse,
                args["x"].as_f64().map_or(default_offset, |x| x - source.0),
                args["y"].as_f64().map_or(default_offset, |y| y - source.1),
            ))
        } else {
            None
        };
        let mut rank = rank_between(
            children(&snapshot, &parent).last().map(|n| n.rank.as_str()),
            None,
        )
        .ok_or_else(|| EngineError::new("resource_limit", "rank rebalance required"))?;
        let mut pending = nodes;
        if let Some(roots) = payload["roots"].as_array() {
            let order: BTreeMap<_, _> = roots
                .iter()
                .filter_map(Value::as_str)
                .enumerate()
                .map(|(index, id)| (id, index))
                .collect();
            pending.sort_by_key(|node| order.get(node.id.as_str()).copied().unwrap_or(usize::MAX));
        }
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
            let transform = match placement {
                Some((inverse, dx, dy)) if top => Some(
                    inverse
                        .multiply(omc_scene::Affine::translation(dx, dy))
                        .multiply(clipboard_geometry(&node, &payload)?.0),
                ),
                _ => None,
            };
            node.id = map[&old].clone();
            node.parent_id = Some(
                node.parent_id
                    .as_ref()
                    .and_then(|p| map.get(p))
                    .cloned()
                    .unwrap_or(parent.clone()),
            );
            node.home_shard = new_id("shard");
            if !legacy {
                remap_values(&mut node.properties, &map);
            }
            if top {
                node.rank = rank.clone();
                rank = rank_between(Some(&rank), None)
                    .ok_or_else(|| EngineError::new("resource_limit", "rank exhausted"))?;
                if let Some(omc_scene::Affine([a, b, c, d, x, y])) = transform {
                    node.properties.insert("x".into(), json!(x));
                    node.properties.insert("y".into(), json!(y));
                    node.properties
                        .insert("transform".into(), json!([a, b, c, d, 0., 0.]));
                } else {
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
            }
            commands.push(Command::NodeCreate { node });
            done.insert(old);
        }
        if replace {
            commands.push(Command::NodeDelete { node_ids: replaced });
        }
        let mut result = self.submit_with_output(
            session,
            id,
            Command::Batch { commands },
            &meta,
            Some(snapshot.sequence),
            Properties::from([("rawSelection".into(), json!(created))]),
        )?;
        result["ids"] = result["selection"].clone();
        Ok(result)
    }
}

fn clipboard_roots(snapshot: &DocumentSnapshot, ids: &[String]) -> Vec<String> {
    let selected: std::collections::BTreeSet<_> = ids.iter().map(String::as_str).collect();
    let mut seen = std::collections::BTreeSet::new();
    ids.iter()
        .filter(|raw| {
            if !seen.insert(raw.as_str()) {
                return false;
            }
            let mut current = snapshot
                .nodes
                .get(raw.as_str())
                .and_then(|node| node.parent_id.as_deref());
            while let Some(parent) = current {
                if selected.contains(parent) {
                    return false;
                }
                current = snapshot
                    .nodes
                    .get(parent)
                    .and_then(|node| node.parent_id.as_deref());
            }
            true
        })
        .cloned()
        .collect()
}

fn clipboard_origin(bounds: impl IntoIterator<Item = [f64; 4]>) -> Result<(f64, f64)> {
    bounds
        .into_iter()
        .map(|[x, y, _, _]| (x, y))
        .reduce(|(x, y), (nx, ny)| (x.min(nx), y.min(ny)))
        .ok_or_else(|| EngineError::invalid("clipboard has no positioned roots"))
}

fn clipboard_geometry(node: &Node, payload: &Value) -> Result<(omc_scene::Affine, [f64; 4])> {
    let explicit = payload["rootGeometry"].get(&node.id);
    let matrix = if let Some(geometry) = explicit {
        serde_json::from_value::<[f64; 6]>(geometry["matrix"].clone())
            .map(omc_scene::Affine)
            .map_err(|_| EngineError::invalid("invalid clipboard transform"))?
    } else {
        let x = node.number("x", 0.);
        let y = node.number("y", 0.);
        let authored = node
            .properties
            .get("transform")
            .filter(|value| value.is_array())
            .map(|value| serde_json::from_value::<[f64; 6]>(value.clone()))
            .transpose()
            .map_err(|_| EngineError::invalid("invalid clipboard transform"))?;
        if let Some(authored) = authored {
            omc_scene::Affine::translation(x, y).multiply(omc_scene::Affine(authored))
        } else {
            let (sin, cos) = node.number("rotation", 0.).to_radians().sin_cos();
            let fx = if node.properties.get("flipX") == Some(&Value::Bool(true)) {
                -1.
            } else {
                1.
            };
            let fy = if node.properties.get("flipY") == Some(&Value::Bool(true)) {
                -1.
            } else {
                1.
            };
            let (cx, cy) = (
                node.number("width", 0.) / 2.,
                node.number("height", 0.) / 2.,
            );
            omc_scene::Affine::translation(x + cx, y + cy)
                .multiply(omc_scene::Affine([
                    cos * fx,
                    sin * fx,
                    -sin * fy,
                    cos * fy,
                    0.,
                    0.,
                ]))
                .multiply(omc_scene::Affine::translation(-cx, -cy))
        }
    };
    let bounds = if let Some(geometry) = explicit {
        serde_json::from_value::<[f64; 4]>(geometry["bounds"].clone())
            .map_err(|_| EngineError::invalid("invalid clipboard bounds"))?
    } else {
        matrix.bounds(node.number("width", 0.), node.number("height", 0.))
    };
    if !matrix
        .0
        .iter()
        .chain(bounds.iter())
        .all(|value| value.is_finite())
    {
        return Err(EngineError::invalid("nonfinite clipboard geometry"));
    }
    Ok((matrix, bounds))
}

fn clipboard_property_fields() -> std::collections::BTreeSet<&'static str> {
    [
        "fill",
        "fills",
        "stroke",
        "strokes",
        "strokeWidth",
        "strokeAlignment",
        "strokeCap",
        "strokeJoin",
        "strokeDashArray",
        "strokeSides",
        "opacity",
        "blendMode",
        "effects",
        "shadows",
        "blur",
        "backgroundBlur",
        "radii",
        "radius",
        "radiusTopLeft",
        "radiusTopRight",
        "radiusBottomLeft",
        "radiusBottomRight",
        "cornerSmoothing",
        "smoothing",
        "textStyleId",
        "fillStyleId",
        "strokeStyleId",
        "effectStyleId",
        "textBackground",
    ]
    .into_iter()
    .chain(clipboard_text_style_fields())
    .collect()
}

fn clipboard_text_style_fields() -> std::collections::BTreeSet<&'static str> {
    [
        "fills",
        "fontFamily",
        "fontSize",
        "fontStyle",
        "fontWeight",
        "highlight",
        "letterSpacing",
        "lineHeight",
        "listLevel",
        "listType",
        "paragraphIndent",
        "paragraphSpacing",
        "textAlign",
        "textDecoration",
        "textDecorationStyle",
        "textDecorationThickness",
        "textTransform",
        "verticalAlign",
    ]
    .into_iter()
    .collect()
}
