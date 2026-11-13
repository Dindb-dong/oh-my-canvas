//! Four bounded worker processes, with an independent actor per document.
use omc_engine::DocumentEngine;
use omc_protocol::{CommandEnvelope, EngineError, RequestContext, Result};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    io::{BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
        mpsc,
    },
    thread,
    time::Duration,
};

const MAX_FRAME: usize = 128 * 1024 * 1024;
type Reply = Result<Value>;
type Pending = Arc<Mutex<HashMap<u64, mpsc::SyncSender<Reply>>>>;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkerRequest {
    pub id: u64,
    pub path: PathBuf,
    pub action: String,
    pub arguments: Value,
}
#[derive(Serialize, Deserialize)]
struct WorkerReply {
    id: u64,
    result: Option<Value>,
    error: Option<EngineError>,
}

struct Process {
    child: Mutex<Child>,
    input: Mutex<ChildStdin>,
    pending: Pending,
    next: AtomicU64,
}
impl Process {
    fn spawn(executable: &Path, profile: &Path) -> Result<Arc<Self>> {
        let mut child = Command::new(executable)
            .arg("--document-worker")
            .arg("--profile")
            .arg(profile)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .map_err(io_error)?;
        let input = child
            .stdin
            .take()
            .ok_or_else(|| EngineError::new("storage_unavailable", "worker stdin unavailable"))?;
        let output = child
            .stdout
            .take()
            .ok_or_else(|| EngineError::new("storage_unavailable", "worker stdout unavailable"))?;
        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
        let reading = pending.clone();
        thread::Builder::new()
            .name("omc-worker-replies".into())
            .spawn(move || {
                let mut reader = BufReader::new(output);
                loop {
                    let mut frame = Vec::new();
                    match reader
                        .by_ref()
                        .take(MAX_FRAME as u64 + 1)
                        .read_until(b'\n', &mut frame)
                    {
                        Ok(0) | Err(_) => break,
                        Ok(_) if frame.len() > MAX_FRAME => break,
                        _ => {}
                    }
                    let Ok(reply) = serde_json::from_slice::<WorkerReply>(&frame) else {
                        break;
                    };
                    if let Some(tx) = reading.lock().unwrap().remove(&reply.id) {
                        let result = reply
                            .error
                            .map_or_else(|| Ok(reply.result.unwrap_or(Value::Null)), Err);
                        let _ = tx.send(result);
                    }
                }
                for (_, tx) in reading.lock().unwrap().drain() {
                    let _ = tx.send(Err(EngineError::new(
                        "storage_unavailable",
                        "document worker exited; retry operation lookup after recovery",
                    )));
                }
            })
            .map_err(io_error)?;
        Ok(Arc::new(Self {
            child: Mutex::new(child),
            input: Mutex::new(input),
            pending,
            next: AtomicU64::new(1),
        }))
    }
    fn alive(&self) -> bool {
        self.child
            .lock()
            .unwrap()
            .try_wait()
            .ok()
            .flatten()
            .is_none()
    }
    fn call(&self, path: &Path, action: &str, arguments: Value) -> Reply {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let request = WorkerRequest {
            id,
            path: path.to_owned(),
            action: action.into(),
            arguments,
        };
        let mut bytes = serde_json::to_vec(&request).map_err(json_error)?;
        if bytes.len() > MAX_FRAME {
            return Err(EngineError::new(
                "resource_limit",
                "worker request exceeds bounded frame",
            ));
        }
        bytes.push(b'\n');
        let (tx, rx) = mpsc::sync_channel(1);
        {
            let mut pending = self.pending.lock().unwrap();
            if pending.len() >= 256 {
                return Err(EngineError::new(
                    "queue_full",
                    "worker response queue is full",
                ));
            }
            pending.insert(id, tx);
        }
        let sent = {
            let mut input = self.input.lock().unwrap();
            input.write_all(&bytes).and_then(|()| input.flush())
        };
        if let Err(error) = sent {
            self.pending.lock().unwrap().remove(&id);
            return Err(io_error(error));
        }
        match rx.recv_timeout(Duration::from_secs(60)) {
            Ok(reply) => reply,
            Err(_) => {
                self.pending.lock().unwrap().remove(&id);
                Err(EngineError::new(
                    "outcome_unknown",
                    "worker response deadline; query original idempotency key before retrying",
                ))
            }
        }
    }
}
impl Drop for Process {
    fn drop(&mut self) {
        if let Ok(child) = self.child.get_mut() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

pub struct WorkerPool {
    executable: Option<PathBuf>,
    profile: PathBuf,
    processes: Mutex<Vec<Option<Arc<Process>>>>,
    local: Mutex<HashMap<PathBuf, Arc<Mutex<DocumentEngine>>>>,
}
impl WorkerPool {
    pub fn new(profile: PathBuf, executable: Option<PathBuf>) -> Self {
        Self {
            executable,
            profile,
            processes: Mutex::new(vec![None, None, None, None]),
            local: Mutex::new(HashMap::new()),
        }
    }
    pub fn call(&self, path: &Path, action: &str, args: Value) -> Reply {
        if let Some(executable) = &self.executable {
            // Stable routing is independent of randomized HashMap seeds or process IDs.
            let slot = path
                .as_os_str()
                .to_string_lossy()
                .bytes()
                .fold(0usize, |a, b| a.wrapping_mul(31).wrapping_add(b as usize))
                % 4;
            let process = {
                let mut all = self.processes.lock().unwrap();
                if all[slot].as_ref().is_none_or(|p| !p.alive()) {
                    all[slot] = Some(Process::spawn(executable, &self.profile)?);
                }
                all[slot].as_ref().unwrap().clone()
            };
            process.call(path, action, args)
        } else {
            let engine = {
                let mut actors = self.local.lock().unwrap();
                if !actors.contains_key(path) {
                    if actors.len() >= 128 {
                        return Err(EngineError::new(
                            "resource_limit",
                            "local document authority capacity reached",
                        ));
                    }
                    actors.insert(
                        path.to_owned(),
                        Arc::new(Mutex::new(open_engine(path, action, &args)?)),
                    );
                }
                actors.get(path).unwrap().clone()
            };
            dispatch(&mut engine.lock().unwrap(), action, args)
        }
    }
    pub fn process_ids(&self) -> Vec<u32> {
        self.processes
            .lock()
            .unwrap()
            .iter()
            .flatten()
            .map(|p| p.child.lock().unwrap().id())
            .collect()
    }
    pub fn release(&self, path: &Path) -> Reply {
        let result = self.call(path, "close", json!({}))?;
        if self.executable.is_none() {
            self.local.lock().unwrap().remove(path);
        }
        Ok(result)
    }
}

fn open_engine(path: &Path, action: &str, args: &Value) -> Result<DocumentEngine> {
    if path.exists() {
        return DocumentEngine::open(path);
    }
    if action != "create" && action != "fork_replica" {
        return Err(EngineError::new(
            "invalid_argument",
            "document database does not exist",
        ));
    }
    let parent = path
        .parent()
        .ok_or_else(|| EngineError::invalid("invalid database path"))?;
    std::fs::create_dir_all(parent).map_err(io_error)?;
    if action == "fork_replica" {
        return DocumentEngine::fork_replica(
            path,
            serde_json::from_value(args["package"].clone()).map_err(json_error)?,
        );
    }
    let id = args["documentId"]
        .as_str()
        .ok_or_else(|| EngineError::invalid("documentId required"))?
        .to_owned();
    if let Some(content) = args.get("content") {
        DocumentEngine::create_from_content_with_id(
            path,
            id,
            serde_json::from_value(content.clone()).map_err(json_error)?,
        )
    } else {
        DocumentEngine::create_with_id(path, id, args["title"].as_str().unwrap_or("Untitled"))
    }
}

fn value<T: Serialize>(result: Result<T>) -> Reply {
    serde_json::to_value(result?).map_err(json_error)
}
fn dispatch(engine: &mut DocumentEngine, action: &str, args: Value) -> Reply {
    match action {
        "create" | "metadata" | "fork_replica" => value(engine.metadata()),
        "context" => value(engine.context()),
        "query_nodes_at" => {
            let revision = serde_json::from_value(args["revision"].clone()).map_err(json_error)?;
            let limit = args["limit"].as_u64().unwrap_or(200);
            if limit == 0 || limit > 512 {
                return Err(EngineError::new(
                    "resource_limit",
                    "node query limit is 1–512",
                ));
            }
            value(engine.query_nodes_at(&revision, args["after"].as_str(), limit as usize))
        }
        "children" => value(engine.children(required(&args, "parentId")?)),
        "operation_status" => value(engine.operation_status(
            required(&args, "principal")?,
            required(&args, "epoch")?,
            required(&args, "key")?,
        )),
        "snapshot" => value(engine.snapshot()),
        "node" => value(
            engine.node(
                args["id"]
                    .as_str()
                    .ok_or_else(|| EngineError::invalid("node id required"))?,
            ),
        ),
        "nodes" => {
            let ids = args["ids"]
                .as_array()
                .ok_or_else(|| EngineError::invalid("ids required"))?;
            if ids.len() > 200 {
                return Err(EngineError::new(
                    "resource_limit",
                    "at most 200 nodes per query",
                ));
            }
            let mut out = Vec::new();
            for id in ids {
                out.push(
                    engine.node(
                        id.as_str()
                            .ok_or_else(|| EngineError::invalid("invalid node id"))?,
                    )?,
                );
            }
            Ok(json!(out))
        }
        "preview" => {
            let context: RequestContext =
                serde_json::from_value(args["context"].clone()).map_err(json_error)?;
            let envelope: CommandEnvelope =
                serde_json::from_value(args["envelope"].clone()).map_err(json_error)?;
            value(engine.preview(&context, &envelope))
        }
        "execute" | "execute_branch_rebase" => {
            let context: RequestContext =
                serde_json::from_value(args["context"].clone()).map_err(json_error)?;
            let envelope: CommandEnvelope =
                serde_json::from_value(args["envelope"].clone()).map_err(json_error)?;
            let result = engine.execute(&context, &envelope)?;
            if action == "execute_branch_rebase" {
                engine.reset_local_history(&result.revision)?;
            }
            value(Ok(result))
        }
        "reset_branch_history" => {
            let revision = serde_json::from_value(args["revision"].clone()).map_err(json_error)?;
            engine.reset_local_history(&revision)?;
            Ok(json!({"ok":true}))
        }
        "checkpoint" => {
            engine.checkpoint()?;
            Ok(json!({"status":"durable","revision":engine.revision()}))
        }
        "text_selection" => {
            let revision: omc_model::Revision =
                serde_json::from_value(args["revision"].clone()).map_err(json_error)?;
            if revision != engine.revision() {
                return Err(EngineError::new(
                    "stale_revision",
                    "text changed before numeric offsets were anchored",
                )
                .detail(json!({"currentRevision":engine.revision()})));
            }
            let offset = |key: &str| -> Result<u32> {
                args[key]
                    .as_u64()
                    .and_then(|v| u32::try_from(v).ok())
                    .ok_or_else(|| {
                        EngineError::invalid(format!(
                            "{key} must be a UTF-16 unsigned 32-bit offset"
                        ))
                    })
            };
            value(engine.text_selection(
                required(&args, "nodeId")?,
                offset("start")?,
                offset("end")?,
            ))
        }
        "replica_package" => value(engine.replica_package()),
        "portable_replica_package" => value(engine.portable_replica_package()),
        "merge_replica" => {
            value(engine.merge_replica(serde_json::from_value(args).map_err(json_error)?))
        }
        "collaboration_changes" => engine.collaboration_changes(
            required(&args, "author")?,
            required(&args, "session")?,
            args["saved"].as_u64(),
        ),
        "export_transactions" => {
            value(engine.export_transactions(args["afterSequence"].as_u64().unwrap_or(0)))
        }
        "receive_transaction" => value(engine.receive_transaction(
            serde_json::from_value(args["transaction"].clone()).map_err(json_error)?,
        )),
        "receive_fragment" => value(
            engine.receive_fragment(
                serde_json::from_value(args["header"].clone()).map_err(json_error)?,
                args["index"]
                    .as_u64()
                    .and_then(|v| usize::try_from(v).ok())
                    .ok_or_else(|| EngineError::invalid("fragment index required"))?,
                serde_json::from_value(args["bytes"].clone()).map_err(json_error)?,
            ),
        ),
        "close" => {
            engine.checkpoint()?;
            Ok(json!({"closed":true}))
        }
        _ => Err(EngineError::new(
            "unsupported_feature",
            "unknown worker operation",
        )),
    }
}

/// Internal mode of the service executable. Stdout contains only framed protocol data.
pub fn run_document_worker(profile: &Path) -> Result<()> {
    let root = profile.join("native-v1/documents");
    std::fs::create_dir_all(&root).map_err(io_error)?;
    let root = root.canonicalize().map_err(io_error)?;
    let output = Arc::new(Mutex::new(std::io::stdout()));
    let mut actors: HashMap<PathBuf, mpsc::SyncSender<WorkerRequest>> = HashMap::new();
    let input = std::io::stdin();
    let mut reader = input.lock();
    loop {
        let mut frame = Vec::new();
        let size = reader
            .by_ref()
            .take(MAX_FRAME as u64 + 1)
            .read_until(b'\n', &mut frame)
            .map_err(io_error)?;
        if size == 0 {
            break;
        }
        if size > MAX_FRAME {
            return Err(EngineError::new("resource_limit", "worker frame too large"));
        }
        let request: WorkerRequest = serde_json::from_slice(&frame).map_err(json_error)?;
        let parent = request
            .path
            .parent()
            .ok_or_else(|| EngineError::invalid("invalid worker path"))?;
        std::fs::create_dir_all(parent).map_err(io_error)?;
        if !parent.canonicalize().map_err(io_error)?.starts_with(&root) {
            return Err(EngineError::invalid("worker path outside document store"));
        }
        if !actors.contains_key(&request.path) {
            if actors.len() >= 128 {
                return Err(EngineError::new(
                    "resource_limit",
                    "worker document actor capacity",
                ));
            }
            let (tx, rx) = mpsc::sync_channel::<WorkerRequest>(128);
            actors.insert(request.path.clone(), tx);
            let output = output.clone();
            thread::Builder::new()
                .name("omc-document-actor".into())
                .spawn(move || {
                    let mut engine: Option<DocumentEngine> = None;
                    while let Ok(request) = rx.recv() {
                        let close = request.action == "close";
                        let result = (|| {
                            if engine.is_none() {
                                engine = Some(open_engine(
                                    &request.path,
                                    &request.action,
                                    &request.arguments,
                                )?);
                            }
                            dispatch(engine.as_mut().unwrap(), &request.action, request.arguments)
                        })();
                        if close && result.is_ok() {
                            engine = None;
                        }
                        let reply = match result {
                            Ok(result) => WorkerReply {
                                id: request.id,
                                result: Some(result),
                                error: None,
                            },
                            Err(error) => WorkerReply {
                                id: request.id,
                                result: None,
                                error: Some(error),
                            },
                        };
                        if let Ok(mut bytes) = serde_json::to_vec(&reply) {
                            bytes.push(b'\n');
                            let mut out = output.lock().unwrap();
                            let _ = out.write_all(&bytes);
                            let _ = out.flush();
                        }
                    }
                })
                .map_err(io_error)?;
        }
        let closing = if request.action == "close" {
            Some(request.path.clone())
        } else {
            None
        };
        if let Err(error) = actors.get(&request.path).unwrap().try_send(request) {
            let (request, code) = match error {
                mpsc::TrySendError::Full(request) => (request, "queue_full"),
                mpsc::TrySendError::Disconnected(request) => (request, "storage_unavailable"),
            };
            if code == "storage_unavailable" {
                actors.remove(&request.path);
            }
            let reply = WorkerReply {
                id: request.id,
                result: None,
                error: Some(EngineError::new(
                    code,
                    "document actor cannot accept another request",
                )),
            };
            let mut bytes = serde_json::to_vec(&reply).map_err(json_error)?;
            bytes.push(b'\n');
            let mut out = output.lock().unwrap();
            out.write_all(&bytes).map_err(io_error)?;
            out.flush().map_err(io_error)?;
        } else if let Some(path) = closing {
            actors.remove(&path);
        }
    }
    Ok(())
}

pub(crate) fn io_error(e: std::io::Error) -> EngineError {
    EngineError::new("storage_unavailable", e.to_string())
}
pub(crate) fn json_error(e: serde_json::Error) -> EngineError {
    EngineError::invalid(e.to_string())
}
fn required<'a>(args: &'a Value, key: &str) -> Result<&'a str> {
    args[key]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| EngineError::invalid(format!("{key} required")))
}
