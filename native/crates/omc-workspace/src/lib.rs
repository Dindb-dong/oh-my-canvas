//! Profile ownership, authenticated sessions, document leases and isolated workers.
pub mod admission;
pub mod catalog;
pub mod jobs;
pub mod worker;
use admission::{Admission, WorkClass};
use catalog::{Catalog, sql_error};
use fs2::FileExt;
use omc_model::{DocumentContent, DocumentSnapshot, Node, Revision};
use omc_protocol::{Command, CommandEnvelope, EngineError, RequestContext, Result};
use rusqlite::{OptionalExtension, params};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeSet, HashMap},
    fs::{File, OpenOptions},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};
use worker::{WorkerPool, io_error, json_error};

#[derive(Clone)]
pub struct Session {
    pub id: String,
    pub author: String,
    pub retry_scope: String,
    pub binding: Option<String>,
    pub owners: BTreeSet<String>,
}
pub struct Workspace {
    pub profile: PathBuf,
    pub catalog: Arc<Mutex<Catalog>>,
    pub workers: WorkerPool,
    pub admission: Admission,
    pub jobs: jobs::JobPool,
    sessions: Mutex<HashMap<String, Session>>,
    lifecycle: Mutex<()>,
    _lock: Arc<File>,
}
impl Workspace {
    pub fn open(profile: &Path, worker_executable: Option<PathBuf>) -> Result<Arc<Self>> {
        std::fs::create_dir_all(profile).map_err(io_error)?;
        let profile = profile.canonicalize().map_err(io_error)?;
        let native = profile.join("native-v1");
        std::fs::create_dir_all(native.join("documents")).map_err(io_error)?;
        let lock = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(native.join("owner.lock"))
            .map_err(io_error)?;
        lock.try_lock_exclusive().map_err(|_| {
            EngineError::new("busy", "profile already has a running workspace service")
        })?;
        let lock = Arc::new(lock);
        let catalog = Arc::new(Mutex::new(Catalog::open(&native.join("workspace.sqlite"))?));
        let jobs = jobs::JobPool::with_catalog(catalog.clone(), Some(lock.clone()))?;
        let workspace = Arc::new(Self {
            workers: WorkerPool::new(profile.clone(), worker_executable),
            profile,
            catalog,
            sessions: Mutex::new(HashMap::new()),
            lifecycle: Mutex::new(()),
            admission: Admission::new(4),
            jobs,
            _lock: lock,
        });
        // A durable document may exist even if the process died before catalog registration.
        for entry in std::fs::read_dir(native.join("documents"))
            .map_err(io_error)?
            .flatten()
        {
            let id = entry.file_name().to_string_lossy().into_owned();
            if omc_model::valid_id(&id, "doc") && entry.path().join("document.sqlite").is_file() {
                let path = entry.path().join("document.sqlite");
                let metadata = workspace.workers.call(&path, "metadata", json!({}))?;
                workspace.catalog.lock().unwrap().record(&id, &metadata)?;
                workspace.workers.release(&path)?;
            }
        }
        Ok(workspace)
    }
    pub fn session_open(&self, identity: Option<&Value>) -> Result<Value> {
        let mut sessions = self.sessions.lock().unwrap();
        if sessions.len() >= 128 {
            return Err(EngineError::new(
                "resource_limit",
                "session capacity reached",
            ));
        }
        let mut registration = None;
        let (author, retry_scope) = if let Some(identity) = identity {
            let catalog = self.catalog.lock().unwrap();
            if identity["action"] == "register" {
                let id = format!("principal_{}", uuid::Uuid::new_v4().simple());
                let credential = random_secret();
                let digest = secret_hash(&credential);
                catalog.connection.execute("INSERT INTO principals(id,credential_hash,scope) VALUES(?1,?2,'local-edit')",params![id,digest]).map_err(sql_error)?;
                registration =
                    Some(json!({"registrationId":id,"credential":credential,"scope":"local-edit"}));
                (id, "durable_principal".to_owned())
            } else {
                let id = required_str(identity, "registrationId")?;
                let credential = required_str(identity, "credential")?;
                let row: Option<(String, bool, String)> = catalog
                    .connection
                    .query_row(
                        "SELECT credential_hash,revoked,scope FROM principals WHERE id=?1",
                        [id],
                        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                    )
                    .optional()
                    .map_err(sql_error)?;
                let Some((hash, revoked, scope)) = row else {
                    return Err(EngineError::new(
                        "authentication_failed",
                        "invalid principal resume proof",
                    ));
                };
                if revoked {
                    return Err(EngineError::new(
                        "principal_revoked",
                        "principal registration has been revoked",
                    ));
                }
                if scope != "local-edit"
                    || !constant_time_equal(hash.as_bytes(), secret_hash(credential).as_bytes())
                {
                    return Err(EngineError::new(
                        "authentication_failed",
                        "invalid principal resume proof",
                    ));
                }
                (id.to_owned(), "durable_principal".to_owned())
            }
        } else {
            (
                format!("agent_{}", uuid::Uuid::new_v4().simple()),
                "session".to_owned(),
            )
        };
        let id = uuid::Uuid::new_v4().to_string();
        self.jobs.register_owner(&id, &author)?;
        sessions.insert(
            id.clone(),
            Session {
                id: id.clone(),
                author: author.clone(),
                retry_scope: retry_scope.clone(),
                binding: None,
                owners: BTreeSet::new(),
            },
        );
        Ok(
            json!({"sessionId":id,"principalId":author,"retryScope":retry_scope,"registration":registration}),
        )
    }
    pub fn session(&self, id: &str) -> Result<Session> {
        self.sessions
            .lock()
            .unwrap()
            .get(id)
            .cloned()
            .ok_or_else(|| EngineError::new("authentication_failed", "valid session required"))
    }
    pub fn session_close(&self, id: &str) -> Result<Value> {
        let session = {
            let _lifecycle = self.lifecycle.lock().unwrap();
            self.sessions.lock().unwrap().remove(id).ok_or_else(|| {
                EngineError::new("authentication_failed", "valid session required")
            })?
        };
        self.jobs.cancel_owner(id);
        for document in session.owners {
            self.release_idle_document(&document)?;
        }
        Ok(json!({"closed":true}))
    }
    pub fn bind(&self, session_id: &str, document_id: &str) -> Result<()> {
        let _lifecycle = self.lifecycle.lock().unwrap();
        self.document_path(document_id)?;
        let mut sessions = self.sessions.lock().unwrap();
        let session = sessions
            .get_mut(session_id)
            .ok_or_else(|| EngineError::new("authentication_failed", "valid session required"))?;
        session.binding = Some(document_id.into());
        session.owners.insert(document_id.into());
        Ok(())
    }
    pub fn bind_if_unbound(&self, session_id: &str, document_id: &str) -> Result<()> {
        let _lifecycle = self.lifecycle.lock().unwrap();
        self.document_path(document_id)?;
        let mut sessions = self.sessions.lock().unwrap();
        let session = sessions
            .get_mut(session_id)
            .ok_or_else(|| EngineError::new("authentication_failed", "valid session required"))?;
        if session.binding.is_none() {
            session.binding = Some(document_id.into());
            session.owners.insert(document_id.into());
        }
        Ok(())
    }
    pub fn release(&self, session_id: &str, document_id: &str) -> Result<Value> {
        {
            let _lifecycle = self.lifecycle.lock().unwrap();
            let mut sessions = self.sessions.lock().unwrap();
            let session = sessions.get_mut(session_id).ok_or_else(|| {
                EngineError::new("authentication_failed", "valid session required")
            })?;
            session.owners.remove(document_id);
            if session.binding.as_deref() == Some(document_id) {
                session.binding = None;
            }
        }
        self.release_idle_document(document_id)?;
        Ok(json!({"released":true,"documentId":document_id}))
    }
    fn release_idle_document(&self, id: &str) -> Result<()> {
        if self
            .sessions
            .lock()
            .unwrap()
            .values()
            .any(|session| session.owners.contains(id))
            || self.jobs.has_document(id)
        {
            return Ok(());
        }
        let path = self.document_path(id)?;
        let _permit = self.admission.acquire(
            "release",
            id,
            WorkClass::Durable,
            4096,
            Duration::from_secs(30),
        )?;
        if !self
            .sessions
            .lock()
            .unwrap()
            .values()
            .any(|session| session.owners.contains(id))
            && !self.jobs.has_document(id)
        {
            self.workers.release(&path)?;
        }
        Ok(())
    }
    pub fn target(&self, session_id: &str, explicit: Option<&str>) -> Result<String> {
        let session = self.session(session_id)?;
        explicit
            .map(str::to_owned)
            .or(session.binding)
            .ok_or_else(|| {
                EngineError::new(
                    "invalid_argument",
                    "open or explicitly target a document first",
                )
            })
    }
    pub fn document_path(&self, id: &str) -> Result<PathBuf> {
        if !omc_model::valid_id(id, "doc") || !self.catalog.lock().unwrap().exists(id)? {
            return Err(EngineError::invalid("document not found"));
        }
        Ok(self
            .profile
            .join("native-v1/documents")
            .join(id)
            .join("document.sqlite"))
    }
    pub fn create(
        &self,
        session_id: &str,
        title: &str,
        content: Option<DocumentContent>,
    ) -> Result<DocumentSnapshot> {
        self.session(session_id)?;
        if title.trim().is_empty() || title.len() > 240 {
            return Err(EngineError::invalid("title must contain 1–240 bytes"));
        }
        let id = omc_model::new_id("doc");
        let mut args = json!({"documentId":id,"title":title});
        if let Some(content) = content {
            args["content"] = serde_json::to_value(content).map_err(json_error)?;
        }
        self.install_document(session_id, &id, "create", args)
    }
    pub fn snapshot(&self, id: &str) -> Result<DocumentSnapshot> {
        serde_json::from_value(self.read_call(id, "snapshot", json!({}), 4096)?).map_err(json_error)
    }
    pub fn metadata(&self, id: &str) -> Result<Value> {
        self.read_call(id, "metadata", json!({}), 4096)
    }
    pub fn context(&self, id: &str) -> Result<omc_engine::DocumentContext> {
        serde_json::from_value(self.read_call(id, "context", json!({}), 4096)?).map_err(json_error)
    }
    pub fn query_nodes_at(
        &self,
        id: &str,
        revision: &Revision,
        after: Option<&str>,
        limit: usize,
    ) -> Result<omc_engine::NodeQueryPage> {
        serde_json::from_value(self.read_call(
            id,
            "query_nodes_at",
            json!({"revision":revision,"after":after,"limit":limit}),
            4096,
        )?)
        .map_err(json_error)
    }
    pub fn children(&self, id: &str, parent: &str) -> Result<Vec<Node>> {
        serde_json::from_value(self.read_call(id, "children", json!({"parentId":parent}), 4096)?)
            .map_err(json_error)
    }
    pub fn operation_status(
        &self,
        session: &str,
        id: &str,
        epoch: &str,
        key: &str,
    ) -> Result<Value> {
        let principal = self.session(session)?.author;
        self.read_call(
            id,
            "operation_status",
            json!({"principal":principal,"epoch":epoch,"key":key}),
            4096,
        )
    }
    pub fn nodes(&self, id: &str, ids: &[String]) -> Result<Vec<Option<Node>>> {
        if ids.len() > 200 {
            return Err(EngineError::new(
                "resource_limit",
                "at most 200 nodes per query",
            ));
        }
        serde_json::from_value(self.read_call(
            id,
            "nodes",
            json!({"ids":ids}),
            4096 + ids.len() * 64,
        )?)
        .map_err(json_error)
    }
    pub fn execute(&self, session_id: &str, envelope: CommandEnvelope) -> Result<Value> {
        let session = self.session(session_id)?;
        let path = self.document_path(&envelope.document_id)?;
        envelope.validate()?;
        let bytes = serde_json::to_vec(&envelope).map_err(json_error)?.len();
        let _permit = self.admission.acquire(
            &session.author,
            &envelope.document_id,
            WorkClass::Interactive,
            bytes,
            Duration::from_millis(envelope.deadline_ms.unwrap_or(30_000)),
        )?;
        self.document_path(&envelope.document_id)?;
        let context = RequestContext {
            author_id: session.author,
            session_id: session.id,
        };
        let result = self.workers.call(
            &path,
            "execute",
            json!({"context":context,"envelope":envelope}),
        )?;
        // Catalog is a reconstructible index; authoritative commit/receipt is already durable.
        if changes_document_title(&envelope.command)
            && let Ok(meta) = self.workers.call(&path, "metadata", json!({}))
        {
            let _ = self
                .catalog
                .lock()
                .unwrap()
                .record(&envelope.document_id, &meta);
        }
        Ok(result)
    }
    pub fn command(&self, session: &str, id: &str, epoch: &str, command: Command) -> Result<Value> {
        self.execute(session, CommandEnvelope::new(id, epoch, command))
    }
    pub fn adapter_intent(
        &self,
        session: &str,
        document_id: &str,
        epoch: &str,
        key: &str,
        request_digest: &str,
    ) -> Result<Option<(CommandEnvelope, Value)>> {
        let principal = self.session(session)?.author;
        self.document_path(document_id)?;
        validate_digest(request_digest)?;
        let catalog = self.catalog.lock().unwrap();
        read_adapter_intent(
            &catalog,
            &principal,
            document_id,
            epoch,
            key,
            request_digest,
        )
    }
    pub fn prepare_adapter(
        &self,
        session: &str,
        envelope: &CommandEnvelope,
        request_digest: &str,
        output: &Value,
    ) -> Result<(CommandEnvelope, Value)> {
        let principal = self.session(session)?.author;
        self.document_path(&envelope.document_id)?;
        envelope.validate()?;
        validate_digest(request_digest)?;
        let output_bytes = serde_json::to_vec(output).map_err(json_error)?;
        if output_bytes.len() > omc_protocol::MAX_INLINE_BYTES {
            return Err(EngineError::new(
                "resource_limit",
                "adapter result descriptor exceeds 512 KiB",
            ));
        }
        let catalog = self.catalog.lock().unwrap();
        if let Some(intent) = read_adapter_intent(
            &catalog,
            &principal,
            &envelope.document_id,
            &envelope.target_epoch,
            &envelope.idempotency_key,
            request_digest,
        )? {
            return Ok(intent);
        }
        let integrity =
            omc_protocol::canonical_digest(&json!({"envelope":envelope,"output":output}))?;
        catalog.connection.execute("INSERT INTO adapter_intents(principal,document_id,epoch,operation_key,request_digest,envelope,output,integrity_digest) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",
            params![principal,envelope.document_id,envelope.target_epoch,envelope.idempotency_key,request_digest,serde_json::to_string(envelope).map_err(json_error)?,output.to_string(),integrity]).map_err(sql_error)?;
        Ok((envelope.clone(), output.clone()))
    }
    pub fn checkpoint(&self, id: &str) -> Result<Value> {
        self.read_call(id, "checkpoint", json!({}), 4096)
    }
    pub fn text_selection(&self, id: &str, args: Value) -> Result<Value> {
        self.read_call(id, "text_selection", args, 4096)
    }
    fn read_call(&self, id: &str, action: &str, args: Value, reserve: usize) -> Result<Value> {
        let path = self.document_path(id)?;
        let _permit = self.admission.acquire(
            &format!("query:{action}"),
            id,
            WorkClass::Interactive,
            reserve,
            Duration::from_secs(30),
        )?;
        self.document_path(id)?;
        self.workers.call(&path, action, args)
    }
    pub fn fork_replica(
        &self,
        session: &str,
        package: omc_engine::ReplicaPackage,
    ) -> Result<DocumentSnapshot> {
        self.session(session)?;
        let id = package.document_id.clone();
        if !omc_model::valid_id(&id, "doc") {
            return Err(EngineError::invalid("invalid replica document identity"));
        }
        self.install_document(session, &id, "fork_replica", json!({"package":package}))
    }
    pub fn receive_fragment(
        &self,
        id: &str,
        header: omc_sync::TransferHeader,
        index: usize,
        bytes: Vec<u8>,
    ) -> Result<Value> {
        let reserve = bytes.len() + 4096;
        let path = self.document_path(id)?;
        let _permit = self.admission.acquire(
            "peer-apply",
            id,
            WorkClass::Durable,
            reserve,
            Duration::from_secs(30),
        )?;
        self.document_path(id)?;
        self.workers.call(
            &path,
            "receive_fragment",
            json!({"header":header,"index":index,"bytes":bytes}),
        )
    }
    pub fn submit_job<F>(
        &self,
        session: &str,
        kind: &str,
        reserve: usize,
        documents: Vec<String>,
        task: F,
    ) -> Result<Value>
    where
        F: FnOnce(jobs::JobContext) -> Result<Value> + Send + 'static,
    {
        let _lifecycle = self.lifecycle.lock().unwrap();
        self.session(session)?;
        for id in &documents {
            self.document_path(id)?;
        }
        self.jobs
            .submit_scoped(session, kind, reserve, documents, task)
    }
    fn install_document(
        &self,
        session_id: &str,
        id: &str,
        action: &str,
        args: Value,
    ) -> Result<DocumentSnapshot> {
        let session = self.session(session_id)?;
        let documents = self.profile.join("native-v1/documents");
        let destination = documents.join(id);
        if destination.exists() {
            return Err(EngineError::new(
                "conflict",
                "a local document with this identity already exists",
            ));
        }
        let permit = self.admission.acquire(
            &session.author,
            id,
            WorkClass::Background,
            4 * 1024 * 1024,
            Duration::from_secs(60),
        )?;
        let staging = documents.join(format!(".staging_{}", uuid::Uuid::new_v4().simple()));
        let path = staging.join("document.sqlite");
        let installed = (|| {
            let metadata = self.workers.call(&path, action, args)?;
            self.workers.release(&path)?;
            OpenOptions::new()
                .read(true)
                .write(true)
                .open(&path)
                .and_then(|file| file.sync_all())
                .map_err(io_error)?;
            sync_directory(&staging)?;
            let _lifecycle = self.lifecycle.lock().unwrap();
            let mut sessions = self.sessions.lock().unwrap();
            let current = sessions.get_mut(session_id).ok_or_else(|| {
                EngineError::new(
                    "authentication_failed",
                    "session closed before document installation",
                )
            })?;
            if destination.exists() {
                return Err(EngineError::new(
                    "conflict",
                    "a local replica was installed concurrently",
                ));
            }
            std::fs::rename(&staging, &destination).map_err(io_error)?;
            sync_directory(&documents)?;
            self.catalog.lock().unwrap().record(id, &metadata)?;
            current.binding = Some(id.into());
            current.owners.insert(id.into());
            Ok(())
        })();
        if let Err(error) = installed {
            // An unknown worker outcome is deliberately left in private staging. It
            // must never become discoverable as a partially installed document.
            if path.exists() && self.workers.release(&path).is_ok() {
                let _ = std::fs::remove_dir_all(&staging);
            }
            return Err(error.detail(json!({"documentId":id,"installed":destination.exists()})));
        }
        drop(permit);
        self.snapshot(id)
    }
    pub fn list(&self, include_archived: bool) -> Result<Value> {
        let cat = self.catalog.lock().unwrap();
        Ok(
            json!({"documents":cat.list(include_archived)?,"folders":cat.folders()?,"workspaceEpoch":cat.epoch}),
        )
    }
    pub fn delete_document(&self, id: &str, expected_title: &str) -> Result<Value> {
        let _lifecycle = self.lifecycle.lock().unwrap();
        if self
            .sessions
            .lock()
            .unwrap()
            .values()
            .any(|s| s.owners.contains(id))
            || self.jobs.has_document(id)
        {
            return Err(EngineError::new(
                "busy",
                "release document owners and active jobs before deletion",
            ));
        }
        let _permit = self.admission.acquire(
            "document-delete",
            id,
            WorkClass::Durable,
            4096,
            Duration::from_secs(30),
        )?;
        let path = self.document_path(id)?;
        let meta = self.workers.call(&path, "metadata", json!({}))?;
        if meta["title"] != expected_title {
            return Err(EngineError::new("conflict", "document title changed"));
        }
        self.workers.call(&path, "checkpoint", json!({}))?;
        // Retain the database and bytes. Tombstoning discovery is recoverable and never
        // unlinks an open writer or deletes shared asset contents.
        self.catalog
            .lock()
            .unwrap()
            .connection
            .execute("UPDATE documents SET trashed=1 WHERE id=?1", [id])
            .map_err(sql_error)?;
        self.workers.release(&path)?;
        Ok(json!({"documentId":id,"deleted":true,"retainedForRecovery":true}))
    }
    pub fn metrics(&self) -> Value {
        json!({"admission":self.admission.metrics(),"jobs":self.jobs.metrics(),"workerPids":self.workers.process_ids(),"sessions":self.sessions.lock().unwrap().len()})
    }
}
fn changes_document_title(command: &Command) -> bool {
    match command {
        Command::DocumentRename { .. }
        | Command::Undo
        | Command::Redo
        | Command::HistoryUndo { .. }
        | Command::HistoryRedo { .. } => true,
        Command::Batch { commands } => commands.iter().any(changes_document_title),
        _ => false,
    }
}
fn sync_directory(path: &Path) -> Result<()> {
    #[cfg(unix)]
    {
        File::open(path)
            .and_then(|file| file.sync_all())
            .map_err(io_error)?;
    }
    #[cfg(not(unix))]
    {
        let _ = path;
    }
    Ok(())
}
pub fn random_secret() -> String {
    format!(
        "{}{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}
fn secret_hash(secret: &str) -> String {
    hex::encode(Sha256::digest(secret.as_bytes()))
}
pub fn constant_time_equal(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |diff, (a, b)| diff | (a ^ b)) == 0
}
fn required_str<'a>(value: &'a Value, key: &str) -> Result<&'a str> {
    value[key]
        .as_str()
        .filter(|v| !v.is_empty() && v.len() <= 256)
        .ok_or_else(|| EngineError::invalid(format!("{key} required")))
}
fn validate_digest(digest: &str) -> Result<()> {
    if digest.len() != 64
        || !digest
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        Err(EngineError::invalid(
            "adapter request requires a SHA-256 digest",
        ))
    } else {
        Ok(())
    }
}
fn read_adapter_intent(
    catalog: &Catalog,
    principal: &str,
    document: &str,
    epoch: &str,
    key: &str,
    digest: &str,
) -> Result<Option<(CommandEnvelope, Value)>> {
    let row:Option<(String,String,String,String)>=catalog.connection.query_row("SELECT request_digest,envelope,output,integrity_digest FROM adapter_intents WHERE principal=?1 AND document_id=?2 AND epoch=?3 AND operation_key=?4",params![principal,document,epoch,key],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?))).optional().map_err(sql_error)?;
    let Some((stored_digest, envelope, output, integrity)) = row else {
        return Ok(None);
    };
    if stored_digest != digest {
        return Err(EngineError::new(
            "idempotency_conflict",
            "tool retry key belongs to another validated request",
        ));
    }
    let envelope: CommandEnvelope = serde_json::from_str(&envelope)
        .map_err(|e| EngineError::new("corrupt_state", e.to_string()))?;
    let output: Value = serde_json::from_str(&output)
        .map_err(|e| EngineError::new("corrupt_state", e.to_string()))?;
    if omc_protocol::canonical_digest(&json!({"envelope":envelope,"output":output}))? != integrity {
        return Err(EngineError::new(
            "corrupt_state",
            "adapter intent integrity check failed",
        ));
    }
    Ok(Some((envelope, output)))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ownership_and_principal_resume_survive_restart() {
        let directory = tempfile::tempdir().unwrap();
        let workspace = Workspace::open(directory.path(), None).unwrap();
        assert!(Workspace::open(directory.path(), None).is_err());
        let registered = workspace
            .session_open(Some(&json!({"action":"register"})))
            .unwrap();
        let identity = registered["registration"].clone();
        let first = registered["principalId"].clone();
        drop(workspace);
        let workspace = Workspace::open(directory.path(), None).unwrap();
        let resumed = workspace.session_open(Some(&identity)).unwrap();
        assert_eq!(resumed["principalId"], first);
        let mut invalid = identity;
        invalid["credential"] = "wrong".into();
        assert_eq!(
            workspace.session_open(Some(&invalid)).unwrap_err().code,
            "authentication_failed"
        );
    }

    #[test]
    fn adapter_intent_preserves_generated_ids_across_restart() {
        let directory = tempfile::tempdir().unwrap();
        let workspace = Workspace::open(directory.path(), None).unwrap();
        let registered = workspace
            .session_open(Some(&json!({"action":"register"})))
            .unwrap();
        let session = registered["sessionId"].as_str().unwrap();
        let identity = registered["registration"].clone();
        let snapshot = workspace.create(session, "test", None).unwrap();
        let mut node = Node::new(omc_model::NodeKind::Rect);
        node.parent_id = Some(snapshot.pages[0].root_node_id.clone());
        let envelope = CommandEnvelope::new(
            &snapshot.id,
            &snapshot.epoch,
            Command::NodeCreate { node: node.clone() },
        );
        let digest =
            omc_protocol::canonical_digest(&json!({"tool":"create_shape","args":{"type":"rect"}}))
                .unwrap();
        let output = json!({"rawIds":[node.id]});
        let (prepared, _) = workspace
            .prepare_adapter(session, &envelope, &digest, &output)
            .unwrap();
        workspace.execute(session, prepared).unwrap();
        drop(workspace);
        let workspace = Workspace::open(directory.path(), None).unwrap();
        let resumed = workspace.session_open(Some(&identity)).unwrap();
        let session = resumed["sessionId"].as_str().unwrap();
        let mut newly_generated = envelope.clone();
        if let Command::NodeCreate { node } = &mut newly_generated.command {
            node.id = omc_model::new_id("node");
        }
        let (prepared, stored) = workspace
            .prepare_adapter(
                session,
                &newly_generated,
                &digest,
                &json!({"rawIds":["wrong-new-id"]}),
            )
            .unwrap();
        assert_eq!(prepared, envelope);
        assert_eq!(stored, output);
        let result = workspace.execute(session, prepared).unwrap();
        assert_eq!(result["replayed"], true);
        assert_eq!(workspace.snapshot(&snapshot.id).unwrap().nodes.len(), 2);
        let mismatch = omc_protocol::canonical_digest(
            &json!({"tool":"create_shape","args":{"type":"ellipse"}}),
        )
        .unwrap();
        assert_eq!(
            workspace
                .adapter_intent(
                    session,
                    &snapshot.id,
                    &snapshot.epoch,
                    &envelope.idempotency_key,
                    &mismatch
                )
                .unwrap_err()
                .code,
            "idempotency_conflict"
        );
    }

    #[test]
    fn bounded_queries_and_revision_checked_text_anchors() {
        let directory = tempfile::tempdir().unwrap();
        let workspace = Workspace::open(directory.path(), None).unwrap();
        let opened = workspace.session_open(None).unwrap();
        let session = opened["sessionId"].as_str().unwrap();
        let snapshot = workspace.create(session, "test", None).unwrap();
        let mut node = Node::new(omc_model::NodeKind::Text);
        node.parent_id = Some(snapshot.pages[0].root_node_id.clone());
        node.properties.insert("text".into(), "A😀".into());
        workspace
            .execute(
                session,
                CommandEnvelope::new(
                    &snapshot.id,
                    &snapshot.epoch,
                    Command::NodeCreate { node: node.clone() },
                ),
            )
            .unwrap();
        assert_eq!(
            workspace
                .text_selection(
                    &snapshot.id,
                    json!({"nodeId":node.id,"start":0,"end":1,"revision":snapshot.revision()})
                )
                .unwrap_err()
                .code,
            "stale_revision"
        );
        let current = workspace.context(&snapshot.id).unwrap();
        let selection = workspace
            .text_selection(
                &snapshot.id,
                json!({"nodeId":node.id,"start":0,"end":1,"revision":current.revision}),
            )
            .unwrap();
        assert_eq!(selection["observedItems"].as_array().unwrap().len(), 1);
        let page = workspace
            .query_nodes_at(&snapshot.id, &current.revision, None, 1)
            .unwrap();
        assert_eq!(page.nodes.len(), 1);
        assert!(page.next_after.is_some());
    }
}
