use super::*;
use sha2::{Digest, Sha256};

pub(super) const COMMANDS: &[(&str, &str, bool, &str)] = &[
    (
        "file.saveVersion",
        "Save to version history",
        false,
        "name?, description?",
    ),
    ("file.versionHistory", "Show version history", false, ""),
    ("version.restore", "Restore version", true, "id | index"),
    ("version.preview", "View version", false, "id | index"),
    ("version.exitPreview", "Back to current version", false, ""),
    ("version.list", "List versions", false, ""),
    ("version.autosave", "Autosave version", false, ""),
    (
        "version.rename",
        "Rename version",
        false,
        "id | index, name, description?",
    ),
    ("version.delete", "Delete version", false, "id | index"),
    (
        "version.duplicate",
        "Duplicate version",
        false,
        "id | index",
    ),
];

impl ToolRouter {
    pub fn fig_version_preview_job(
        &self,
        session: &str,
        arguments: &Value,
        apply: bool,
    ) -> Result<Value> {
        validate_figcraft_tool("run_command", arguments)?;
        let empty = json!({});
        let params = arguments.get("params").unwrap_or(&empty);
        let fields = if apply {
            json!({"id":{"type":"string","maxLength":64},"index":{"type":"integer","minimum":0}})
        } else {
            json!({})
        };
        schema::check(
            &json!({"type":"object","properties":fields,"additionalProperties":false}),
            params,
            "params",
        )?;
        let explicit = arguments["document"].as_str().map(native_id).transpose()?;
        let document = self.workspace.target(session, explicit.as_deref())?;
        let mut job = json!({"document":external_id(&document),"kind":"version"});
        if apply {
            let catalog = self.workspace.catalog.lock().unwrap();
            let versions = catalog.versions(&document)?;
            let version = match (params["id"].as_str(), params["index"].as_u64()) {
                (Some(id), None) => versions.iter().find(|version| version["id"] == id),
                (None, Some(index)) => usize::try_from(index)
                    .ok()
                    .and_then(|index| versions.get(index)),
                _ => return Err(EngineError::invalid("supply either a version ID or index")),
            }
            .ok_or_else(|| EngineError::new("not_found", "version was not found"))?;
            let bytes = catalog.version_bytes(&document, string(version, "id")?)?;
            drop(catalog);
            let live = self.workspace.context(&document)?;
            let content: DocumentContent = serde_json::from_slice(&bytes)
                .map_err(|error| EngineError::new("corrupt_state", error.to_string()))?;
            let preview = DocumentSnapshot {
                id: document,
                title: live.title,
                epoch: live.revision.epoch,
                sequence: live.revision.sequence,
                pages: content.pages,
                nodes: content.nodes,
                metadata: content.metadata,
            };
            job["preview"] = json!(preview);
        }
        Ok(job)
    }
    pub(super) fn fig_versions_command(
        &self,
        session: &str,
        snapshot: &DocumentSnapshot,
        state: &ViewState,
        name: &str,
        params: &Value,
    ) -> Result<Value> {
        let id = &snapshot.id;
        let id_fields =
            json!({"id":{"type":"string","maxLength":64},"index":{"type":"integer","minimum":0}});
        let (fields, required) = match name {
            "file.saveVersion" => (
                json!({"name":{"type":"string","minLength":1,"maxLength":240},"description":{"type":"string","maxLength":4096}}),
                json!([]),
            ),
            "version.rename" => (
                json!({"id":id_fields["id"],"index":id_fields["index"],"name":{"type":"string","minLength":1,"maxLength":240},"description":{"type":"string","maxLength":4096}}),
                json!(["name"]),
            ),
            "version.delete" | "version.duplicate" | "version.restore" | "version.preview" => {
                (id_fields, json!([]))
            }
            _ => (json!({}), json!([])),
        };
        schema::check(
            &json!({"type":"object","properties":fields,"required":required,"additionalProperties":false}),
            params,
            "params",
        )?;
        let mut catalog = self.workspace.catalog.lock().unwrap();
        match name {
            "version.list" | "file.versionHistory" => Ok(json!(catalog.versions(id)?)),
            "file.saveVersion" | "version.autosave" => {
                let automatic = name == "version.autosave";
                if automatic
                    && (snapshot.sequence == 0
                        || state.fig_saved_revision == Some(snapshot.sequence))
                {
                    return Ok(json!({"saved":false}));
                }
                let content = DocumentContent {
                    title: snapshot.title.clone(),
                    pages: snapshot.pages.clone(),
                    nodes: snapshot.nodes.clone(),
                    metadata: snapshot
                        .metadata
                        .iter()
                        .filter(|(key, _)| !key.starts_with("comments/"))
                        .map(|(key, value)| (key.clone(), value.clone()))
                        .collect(),
                };
                let bytes = serde_json::to_vec(&content)
                    .map_err(|e| EngineError::new("storage_unavailable", e.to_string()))?;
                let digest = hex::encode(Sha256::digest(&bytes));
                let version = catalog.save_version(
                    id,
                    params["name"].as_str().unwrap_or(if automatic {
                        "Autosave"
                    } else {
                        "Version"
                    }),
                    params["description"].as_str().unwrap_or(""),
                    &bytes,
                    &digest,
                    automatic,
                )?;
                if automatic {
                    Ok(match version {
                        Some(version) => json!({"saved":true,"version":version}),
                        None => json!({"saved":false}),
                    })
                } else {
                    Ok(version.unwrap())
                }
            }
            _ => {
                let versions = catalog.versions(id)?;
                let version = match (params["id"].as_str(), params["index"].as_u64()) {
                    (Some(id), None) => versions.iter().find(|v| v["id"] == id),
                    (None, Some(index)) => usize::try_from(index)
                        .ok()
                        .and_then(|index| versions.get(index)),
                    _ => return Err(EngineError::invalid("supply either a version ID or index")),
                }
                .ok_or_else(|| EngineError::new("not_found", "version was not found"))?;
                let version_id = string(version, "id")?;
                match name {
                    "version.rename" => {
                        catalog.rename_version(
                            id,
                            version_id,
                            string(params, "name")?,
                            params["description"].as_str(),
                        )?;
                        Ok(json!({"ok":true}))
                    }
                    "version.delete" => {
                        catalog.delete_version(id, version_id)?;
                        Ok(json!({"ok":true}))
                    }
                    "version.restore" => {
                        let bytes = catalog.version_bytes(id, version_id)?;
                        let historical: DocumentContent =
                            serde_json::from_slice(&bytes).map_err(|error| {
                                EngineError::new("corrupt_state", error.to_string())
                            })?;
                        let before = version_content(snapshot);
                        let mut target = restore_content(&before, historical)?;
                        let comments = snapshot
                            .metadata
                            .iter()
                            .filter(|(key, _)| key.starts_with("comments/"));
                        target
                            .metadata
                            .extend(comments.map(|(key, value)| (key.clone(), value.clone())));
                        let mut live = before.clone();
                        live.metadata.extend(
                            snapshot
                                .metadata
                                .iter()
                                .filter(|(key, _)| key.starts_with("comments/"))
                                .map(|(key, value)| (key.clone(), value.clone())),
                        );
                        let commands = super::branches::edit::commands(&live, &target)?;
                        if commands.is_empty() {
                            return Ok(json!({"restored":true,"revision":snapshot.sequence}));
                        }
                        if commands.len() > 100 {
                            return Err(EngineError::new(
                                "resource_limit",
                                "restoring the version exceeds 100 atomic operations",
                            ));
                        }
                        let fallback = serde_json::to_vec(&before).map_err(|error| {
                            EngineError::new("storage_unavailable", error.to_string())
                        })?;
                        let digest = hex::encode(Sha256::digest(&fallback));
                        // Keep the current design recoverable before changing the document.
                        catalog.save_version(
                            id,
                            "Before restoring",
                            "",
                            &fallback,
                            &digest,
                            false,
                        )?;
                        drop(catalog);
                        let receipt = self.submit(
                            session,
                            id,
                            Command::Batch { commands },
                            &Value::Null,
                            Some(snapshot.sequence),
                        )?;
                        self.context(session, id)?;
                        self.fig_selection(&(session.into(), id.clone()), &[]);
                        Ok(json!({"restored":true,"revision":receipt["revision"]}))
                    }
                    "version.duplicate" => {
                        let bytes = catalog.version_bytes(id, version_id)?;
                        drop(catalog);
                        let mut content: DocumentContent = serde_json::from_slice(&bytes)
                            .map_err(|e| EngineError::new("corrupt_state", e.to_string()))?;
                        let title = format!(
                            "{} (Version)",
                            content
                                .title
                                .char_indices()
                                .take_while(|(offset, ch)| offset + ch.len_utf8() <= 220)
                                .map(|(_, ch)| ch)
                                .collect::<String>()
                        );
                        content.title = title.clone();
                        let copy = self.workspace.create(session, &title, Some(content))?;
                        self.context_from(session, &copy)?;
                        let result = self.fig_record_tab(
                            session,
                            json!({"id":external_id(&copy.id),"name":copy.title}),
                        )?;
                        let mut result = result;
                        result["index"] = json!(
                            self.fig_tabs
                                .lock()
                                .unwrap()
                                .get(session)
                                .and_then(|tabs| tabs.iter().position(|id| id == &copy.id))
                        );
                        Ok(result)
                    }
                    _ => Err(EngineError::invalid("unknown version command")),
                }
            }
        }
    }
}

fn version_content(snapshot: &DocumentSnapshot) -> DocumentContent {
    DocumentContent {
        title: snapshot.title.clone(),
        pages: snapshot.pages.clone(),
        nodes: snapshot.nodes.clone(),
        metadata: snapshot
            .metadata
            .iter()
            .filter(|(key, _)| !key.starts_with("comments/"))
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect(),
    }
}

fn restore_content(
    before: &DocumentContent,
    mut target: DocumentContent,
) -> Result<DocumentContent> {
    target.title = before.title.clone();
    // A deleted native identity is a permanent tombstone. Give restored layers a fresh identity.
    let ids = target
        .nodes
        .keys()
        .filter(|id| !before.nodes.contains_key(*id))
        .map(|id| (id.clone(), omc_model::new_id("node")))
        .collect::<BTreeMap<_, _>>();
    let pages = target
        .pages
        .iter()
        .filter(|page| !before.pages.iter().any(|before| before.id == page.id))
        .map(|page| (page.id.clone(), omc_model::new_id("page")))
        .collect::<BTreeMap<_, _>>();
    let mut references = ids.clone();
    references.extend(pages.clone());
    target.nodes = target
        .nodes
        .into_values()
        .map(|mut node| {
            if let Some(id) = ids.get(&node.id) {
                node.id = id.clone();
                node.home_shard = omc_model::new_id("shard");
            }
            if let Some(parent) = node.parent_id.as_ref().and_then(|parent| ids.get(parent)) {
                node.parent_id = Some(parent.clone());
            }
            remap_values(&mut node.properties, &references);
            (node.id.clone(), node)
        })
        .collect();
    for page in &mut target.pages {
        if let Some(id) = pages.get(&page.id) {
            page.id = id.clone();
        }
        if let Some(root) = ids.get(&page.root_node_id) {
            page.root_node_id = root.clone();
        }
    }
    remap_values(&mut target.metadata, &references);
    for key in before.metadata.keys() {
        if !target.metadata.contains_key(key) {
            return Err(EngineError::new(
                "unsupported_feature",
                "restoring deleted document-level settings requires a metadata removal operation",
            ));
        }
    }
    target.validate().map_err(EngineError::invalid)?;
    Ok(target)
}
