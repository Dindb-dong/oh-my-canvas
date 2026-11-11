use super::*;
use base64::Engine;
use std::time::{Duration, Instant};

struct Cursor {
    session: String,
    document: String,
    revision: omc_model::Revision,
    after: Option<String>,
    touched: Instant,
}
struct StoredResult {
    session: String,
    bytes: Vec<u8>,
    media: String,
    touched: Instant,
}
#[derive(Default)]
pub(crate) struct ExtensionState {
    cursors: Mutex<HashMap<String, Cursor>>,
    results: Mutex<HashMap<String, StoredResult>>,
}
impl ExtensionState {
    pub fn release_session(&self, session: &str) {
        self.cursors
            .lock()
            .unwrap()
            .retain(|_, c| c.session != session);
        self.results
            .lock()
            .unwrap()
            .retain(|_, r| r.session != session);
    }
    pub fn put_result(&self, session: &str, bytes: Vec<u8>, media: String) -> Result<String> {
        let mut results = self.results.lock().unwrap();
        results.retain(|_, r| r.touched.elapsed() < Duration::from_secs(300));
        if bytes.len() > 64 * 1024 * 1024
            || results.values().map(|r| r.bytes.len()).sum::<usize>() + bytes.len()
                > 128 * 1024 * 1024
        {
            return Err(EngineError::new(
                "resource_limit",
                "result store byte budget reached; export to an explicit path",
            ));
        }
        let id = uuid::Uuid::new_v4().to_string();
        results.insert(
            id.clone(),
            StoredResult {
                session: session.into(),
                bytes,
                media,
                touched: Instant::now(),
            },
        );
        Ok(id)
    }
}
pub fn capabilities() -> Value {
    json!({"protocol":"omc.native/1","releaseStatus":"incomplete-preview","browserRuntime":false,"legacyToolCount":50,"legacyParity":"incomplete","extensions":["identity.resume/1","workspace.organization/1","comments/1","tokens/1","code.static/1","query.snapshot/1","jobs/1"],"limits":{"mcpRequestBytes":1048576,"batchOperations":100,"queryPageNodes":200,"queryPageBytes":524288,"snapshotsPerSession":4,"snapshotIdleSeconds":60,"resultBytes":67108864},"qualification":{"databaseCommitKillTests":200,"installedOsInteraction":"NOT_RUN","fourHardwarePeers":"NOT_RUN","fullPerformanceWorkloads":"NOT_RUN"},"unsupported":["native network peer transport","complete FIG/Sketch fidelity","full desktop capability matrix","complete 30 shader registry","large staged library updates","portable native history backup"]})
}
pub fn definitions() -> Vec<Value> {
    let defs = [
        (
            "native_capabilities",
            "Read native extension versions and incomplete qualification gates.",
        ),
        (
            "native_query",
            "Read bounded fixed-revision pages; cursors are scoped to the authenticated session.",
        ),
        (
            "native_operation_status",
            "Look up the original durable receipt using the resumed principal and original epoch/key.",
        ),
        (
            "native_workspace",
            "Manage workspace folders and archive outside design Undo.",
        ),
        (
            "native_comments",
            "Manage anchored comments with independent per-author comment Undo.",
        ),
        ("native_tokens", "Manage typed design tokens and modes."),
        (
            "native_job",
            "Submit, inspect or cancel bounded background imports/exports.",
        ),
        (
            "native_result",
            "Read or release a bounded binary result in chunks.",
        ),
        (
            "native_code",
            "Export deterministic static React/CSS or Tailwind output.",
        ),
    ];
    defs.into_iter().map(|(name,description)|json!({"name":name,"description":description,"inputSchema":{"type":"object","properties":{"version":{"type":"string","enum":["1"]},"action":{"type":"string"},"documentId":{"type":"string"},"id":{"type":"string"},"cursor":{"type":"string"},"limit":{"type":"integer","minimum":1,"maximum":200},"targetEpoch":{"type":"string"},"idempotencyKey":{"type":"string"},"title":{"type":"string"},"parentId":{"type":["string","null"]},"folderId":{"type":["string","null"]},"body":{"type":"string"},"threadId":{"type":"string"},"nodeId":{"type":"string"},"start":{"type":"integer"},"end":{"type":"integer"},"resolved":{"type":"boolean"},"patch":{"type":"object"},"value":{},"name":{"type":"string"},"type":{"type":"string"},"modes":{"type":"object"},"activeMode":{"type":"string"},"property":{"type":"string"},"jobId":{"type":"string"},"kind":{"type":"string"},"arguments":{"type":"object"},"resultId":{"type":"string"},"offset":{"type":"integer"},"length":{"type":"integer"},"format":{"type":"string"}},"required":["version"],"additionalProperties":false}})).collect()
}
impl ToolRouter {
    pub(crate) fn extension(
        self: &Arc<Self>,
        session: &str,
        name: &str,
        args: Value,
        meta: Value,
    ) -> Result<Value> {
        let definition = definitions()
            .into_iter()
            .find(|d| d["name"] == name)
            .ok_or_else(|| EngineError::new("unsupported_feature", "unknown native extension"))?;
        schema::check(&definition["inputSchema"], &args, "args")?;
        if args["version"] != "1" {
            return Err(EngineError::new(
                "unsupported_version",
                "native extension requires version 1",
            ));
        }
        if name == "native_capabilities" {
            return Ok(capabilities());
        }
        if name == "native_result" {
            let result_id = string(&args, "resultId")?;
            let mut all = self.extensions.results.lock().unwrap();
            all.retain(|_, r| r.touched.elapsed() < Duration::from_secs(300));
            let result = all
                .get_mut(result_id)
                .filter(|r| r.session == session)
                .ok_or_else(|| {
                    EngineError::new(
                        "snapshot_expired",
                        "result expired or belongs to another session",
                    )
                })?;
            if args["action"] == "release" {
                all.remove(result_id);
                return Ok(json!({"released":true}));
            }
            let start = args["offset"].as_u64().unwrap_or(0) as usize;
            let length = args["length"]
                .as_u64()
                .unwrap_or(256 * 1024)
                .min(256 * 1024) as usize;
            if start > result.bytes.len() {
                return Err(EngineError::invalid("result offset exceeds length"));
            }
            let end = start.saturating_add(length).min(result.bytes.len());
            result.touched = Instant::now();
            return Ok(
                json!({"resultId":result_id,"offset":start,"byteLength":result.bytes.len(),"nextOffset":if end<result.bytes.len(){Some(end)}else{None},"mimeType":result.media,"base64":base64::engine::general_purpose::STANDARD.encode(&result.bytes[start..end])}),
            );
        }
        if name == "native_job" {
            return match args["action"].as_str() {
                Some("status") => self.workspace.jobs.status(session, string(&args, "jobId")?),
                Some("cancel") => self.workspace.jobs.cancel(session, string(&args, "jobId")?),
                Some("submit") => {
                    let router = Arc::clone(self);
                    let owner = session.to_owned();
                    let captured = owner.clone();
                    let job_args = args["arguments"].clone();
                    let kind = string(&args, "kind")?.to_owned();
                    if !matches!(kind.as_str(), "import" | "export") {
                        return Err(EngineError::invalid("job kind must be import or export"));
                    }
                    self.workspace.submit_job(
                        &owner,
                        &kind.clone(),
                        128 * 1024 * 1024,
                        if kind == "export" {
                            vec![native_id(string(&job_args, "id")?)?]
                        } else {
                            Vec::new()
                        },
                        move |job| {
                            job.check_cancelled()?;
                            job.progress(json!({"phase":kind}));
                            let result = if kind == "import" {
                                let bytes = if let Some(path) = job_args["filePath"].as_str() {
                                    resources::read_explicit(path, 64 * 1024 * 1024)?
                                } else {
                                    string(&job_args, "payload")?.as_bytes().to_vec()
                                };
                                job.check_cancelled()?;
                                let (snapshot, diagnostics) = router.import_bytes_job(
                                    &captured,
                                    string(&job_args, "format")?,
                                    &bytes,
                                    job_args["title"].as_str(),
                                    true,
                                    Some(&job),
                                )?;
                                job.mark_committed();
                                let mut value = router.context_from(&captured, &snapshot)?;
                                value["diagnostics"] = diagnostics;
                                value
                            } else {
                                let id = native_id(string(&job_args, "id")?)?;
                                let value = router.export_document_job(
                                    &captured,
                                    &id,
                                    job_args,
                                    Some(&job),
                                )?;
                                job.mark_committed();
                                value
                            };
                            Ok(result)
                        },
                    )
                }
                _ => Err(EngineError::invalid("job action required")),
            };
        }
        if name == "native_workspace" {
            if args["action"] == "list" {
                return self.workspace.list(true);
            }
            let mut args = args;
            if let Some(id) = args["documentId"].as_str() {
                args["documentId"] = native_id(id)?.into();
            }
            return self.workspace.catalog.lock().unwrap().organization(&args);
        }
        let id = native_id(string(&args, "documentId")?)?;
        self.workspace.document_path(&id)?;
        if name == "native_operation_status" {
            let principal = self.workspace.session(session)?.author;
            return self.workspace.workers.call(&self.workspace.document_path(&id)?,"operation_status",json!({"principal":principal,"epoch":string(&args,"targetEpoch")?,"key":string(&args,"idempotencyKey")?}));
        }
        if name == "native_query" {
            return self.query_extension(session, &id, args);
        }
        if !self
            .states
            .lock()
            .unwrap()
            .contains_key(&(session.into(), id.clone()))
        {
            self.context(session, &id)?;
        }
        if matches!(name, "native_comments" | "native_tokens") && args["action"] != "list" {
            if let Some(result) = self.replay(session, &id, &meta)? {
                return Ok(result);
            }
        }
        if name == "native_code" {
            let format = string(&args, "format")?;
            if !matches!(format, "react" | "tailwind" | "html") {
                return Err(EngineError::invalid("code format required"));
            }
            return self.export_document(session, &id, json!({"format":format}));
        }
        let snapshot = self.workspace.snapshot(&id)?;
        let namespace = match name {
            "native_tokens" => "tokens",
            "native_comments" => "comments",
            _ => return Err(EngineError::new("unsupported_feature", "unknown extension")),
        };
        let entries = resources::catalogs(&snapshot.metadata, namespace);
        let action = string(&args, "action")?;
        if namespace == "tokens" && action == "bind" {
            let token = string(&args, "id")?;
            if !entries.contains_key(token) {
                return Err(EngineError::invalid("token not found"));
            }
            let property = string(&args, "property")?;
            if !matches!(
                property,
                "fill"
                    | "stroke"
                    | "color"
                    | "fontSize"
                    | "width"
                    | "height"
                    | "opacity"
                    | "cornerRadius"
            ) {
                return Err(EngineError::invalid("unsupported token binding property"));
            }
            let node = self.resolve(session, &id, string(&args, "nodeId")?)?;
            return self.submit(
                session,
                &id,
                Command::NodeSet {
                    node_id: node,
                    properties: Properties::from([(property.into(), json!({"$token":token}))]),
                },
                &meta,
                Some(snapshot.sequence),
            );
        }

        if action == "list" {
            let mut values = entries.values().cloned().collect::<Vec<_>>();
            if namespace == "comments" {
                for value in &mut values {
                    if let Some(node) = value["nodeId"].as_str() {
                        value["orphaned"] = json!(!snapshot.nodes.contains_key(node));
                    }
                }
            }
            return Ok(json!({"revision":snapshot.revision(),"items":values}));
        }
        if namespace == "comments" && matches!(action, "undo" | "redo") {
            return self.submit(
                session,
                &id,
                if action == "undo" {
                    Command::HistoryUndo {
                        channel: omc_protocol::HistoryChannel::Comments,
                    }
                } else {
                    Command::HistoryRedo {
                        channel: omc_protocol::HistoryChannel::Comments,
                    }
                },
                &meta,
                None,
            );
        }
        let entity = if matches!(action, "create" | "reply") {
            omc_model::new_id(if namespace == "comments" {
                "comment"
            } else {
                "token"
            })
        } else {
            string(&args, "id")?.into()
        };
        let mut patch = match action {
            "create" | "reply" => {
                let mut p = json!({});
                for field in if namespace == "comments" {
                    vec!["body", "threadId", "nodeId"]
                } else {
                    vec!["name", "type", "value", "modes", "activeMode"]
                } {
                    if let Some(value) = args.get(field) {
                        p[field] = value.clone();
                    }
                }
                if namespace == "comments" {
                    let body = string(&args, "body")?;
                    if body.trim().is_empty() || body.len() > 16384 {
                        return Err(EngineError::invalid("comment body requires 1–16384 bytes"));
                    }
                    p["resolved"] = false.into();
                    if action == "reply" && !entries.contains_key(string(&args, "threadId")?) {
                        return Err(EngineError::invalid("parent comment not found"));
                    }
                } else {
                    string(&args, "name")?;
                    if args.get("value").is_none() && args.get("modes").is_none() {
                        return Err(EngineError::invalid("token value or modes required"));
                    }
                }
                p
            }
            "update" => {
                if !entries.contains_key(&entity) {
                    return Err(EngineError::invalid("entity not found"));
                }
                args["patch"].clone()
            }
            "delete" => json!({"deleted":true}),
            "resolve" if namespace == "comments" => {
                json!({"resolved":args["resolved"].as_bool().unwrap_or(true)})
            }
            "mode" if namespace == "tokens" => json!({"activeMode":string(&args,"activeMode")?}),
            _ => return Err(EngineError::invalid("unknown catalog action")),
        };
        if namespace == "comments" && action == "create" {
            if let Some(raw) = args["nodeId"].as_str() {
                let raw = self.resolve(session, &id, raw)?;
                patch["nodeId"] = raw.clone().into();
                if args.get("start").is_some() {
                    patch["anchor"]=self.workspace.text_selection(&id,json!({"nodeId":raw,"start":args["start"],"end":args["end"],"revision":snapshot.revision()}))?;
                }
            }
        }
        let mut result = self.submit(
            session,
            &id,
            Command::CatalogSet {
                namespace: namespace.into(),
                entity_id: entity.clone(),
                properties: properties(&patch)?,
            },
            &meta,
            Some(snapshot.sequence),
        )?;
        result["id"] = entity.into();
        Ok(result)
    }
    fn query_extension(&self, session: &str, id: &str, args: Value) -> Result<Value> {
        let mut cursors = self.extensions.cursors.lock().unwrap();
        cursors.retain(|_, c| c.touched.elapsed() < Duration::from_secs(60));
        if args["action"] == "release" {
            let cursor = string(&args, "cursor")?;
            if cursors
                .get(cursor)
                .is_none_or(|c| c.session != session || c.document != id)
            {
                return Err(EngineError::new("snapshot_expired", "snapshot unavailable"));
            }
            cursors.remove(cursor);
            return Ok(json!({"released":true}));
        }
        let (revision, after, old) = if let Some(token) = args["cursor"].as_str() {
            let cursor = cursors
                .get(token)
                .filter(|c| c.session == session && c.document == id)
                .ok_or_else(|| {
                    EngineError::new(
                        "snapshot_expired",
                        "snapshot expired or cursor is not owned by session",
                    )
                })?;
            (
                cursor.revision.clone(),
                cursor.after.clone(),
                Some(token.to_owned()),
            )
        } else {
            if cursors.values().filter(|c| c.session == session).count() >= 4 {
                return Err(EngineError::new(
                    "resource_limit",
                    "at most four query snapshots per session",
                ));
            }
            let metadata = self.workspace.metadata(id)?;
            let sequence = metadata["sequence"]
                .as_str()
                .and_then(|s| s.parse().ok())
                .or_else(|| metadata["sequence"].as_u64())
                .ok_or_else(|| EngineError::new("corrupt_state", "invalid sequence"))?;
            (
                omc_model::Revision {
                    epoch: string(&metadata, "epoch")?.into(),
                    sequence,
                },
                None,
                None,
            )
        };
        let limit = args["limit"].as_u64().unwrap_or(100).clamp(1, 200);
        let result = self.workspace.workers.call(
            &self.workspace.document_path(id)?,
            "query_nodes_at",
            json!({"revision":revision,"after":after,"limit":limit}),
        )?;
        let mut nodes = result["nodes"]
            .as_array()
            .cloned()
            .ok_or_else(|| EngineError::new("corrupt_state", "invalid query page"))?;
        let mut bytes = 0;
        let mut count = 0;
        for node in &nodes {
            let size = serde_json::to_vec(node).unwrap().len();
            if bytes + size > 500 * 1024 {
                break;
            }
            bytes += size;
            count += 1;
        }
        if count == 0 && !nodes.is_empty() {
            return Err(EngineError::new(
                "resource_limit",
                "single node exceeds query inline cap",
            ));
        }
        let truncated = count < nodes.len();
        nodes.truncate(count);
        let next = if truncated {
            nodes
                .last()
                .and_then(|n| n["id"].as_str())
                .map(str::to_owned)
        } else {
            result["nextAfter"].as_str().map(str::to_owned)
        };
        if let Some(old) = old {
            cursors.remove(&old);
        }
        let token = if next.is_some() {
            let token = omc_workspace::random_secret();
            cursors.insert(
                token.clone(),
                Cursor {
                    session: session.into(),
                    document: id.into(),
                    revision: revision.clone(),
                    after: next,
                    touched: Instant::now(),
                },
            );
            Some(token)
        } else {
            None
        };
        Ok(json!({"revision":revision,"nodes":nodes,"cursor":token,"complete":token.is_none()}))
    }
}
