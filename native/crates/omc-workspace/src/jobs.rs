//! Bounded background work with durable tickets and an explicit commit boundary.
use crate::catalog::{Catalog, sql_error};
use omc_protocol::{EngineError, Result};
use rusqlite::params;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, VecDeque},
    fs::File,
    sync::{
        Arc, Condvar, Mutex, Weak,
        atomic::{AtomicU8, Ordering},
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};

const MAX_RESULT_BYTES: usize = 512 * 1024;
const MAX_PROGRESS_BYTES: usize = 16 * 1024;
const RETENTION_MS: u64 = 24 * 60 * 60 * 1_000;
const CANCELLABLE: u8 = 0;
const CANCELLED: u8 = 1;
const COMMITTING: u8 = 2;
const COMMITTED: u8 = 3;

#[derive(Clone)]
pub struct JobContext {
    gate: Arc<AtomicU8>,
    progress: Arc<Mutex<Value>>,
    observer: Option<(Weak<Inner>, String)>,
}
impl JobContext {
    pub fn check_cancelled(&self) -> Result<()> {
        if self.gate.load(Ordering::Acquire) == CANCELLED {
            Err(EngineError::new("cancelled", "job cancelled before commit"))
        } else {
            Ok(())
        }
    }
    /// Atomically excludes cancellation before entering the durable/install operation.
    /// A worker must call this immediately before the first irreversible commit.
    pub fn begin_commit(&self) -> Result<()> {
        match self.gate.compare_exchange(
            CANCELLABLE,
            COMMITTING,
            Ordering::AcqRel,
            Ordering::Acquire,
        ) {
            Ok(_) => {
                if let Err(error) = self.persist_observation() {
                    let _ = self.gate.compare_exchange(
                        COMMITTING,
                        CANCELLABLE,
                        Ordering::AcqRel,
                        Ordering::Acquire,
                    );
                    return Err(error);
                }
                Ok(())
            }
            Err(CANCELLED) => self.check_cancelled(),
            Err(_) => Ok(()),
        }
    }
    pub fn mark_committed(&self) {
        self.gate.store(COMMITTED, Ordering::Release);
        let _ = self.persist_observation();
    }
    pub fn progress(&self, value: Value) {
        if serde_json::to_vec(&value).is_ok_and(|bytes| bytes.len() <= MAX_PROGRESS_BYTES) {
            *self.progress.lock().unwrap() = value;
            let _ = self.persist_observation();
        }
    }
    fn persist_observation(&self) -> Result<()> {
        if let Some((inner, id)) = &self.observer
            && let Some(inner) = inner.upgrade()
        {
            let mut state = inner.state.lock().unwrap();
            if let Some(job) = state.jobs.get_mut(id) {
                persist_job(&inner, id, job)?;
            }
        }
        Ok(())
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Record {
    owner: String,
    session: String,
    kind: String,
    state: String,
    created_ms: u64,
    updated_ms: u64,
    finished_ms: Option<u64>,
    reserve: usize,
    commit_state: u8,
    progress: Value,
    result: Option<Value>,
    error: Option<EngineError>,
    #[serde(default)]
    documents: Vec<String>,
}
struct Job {
    record: Record,
    context: JobContext,
}
struct State {
    jobs: HashMap<String, Job>,
    queue: VecDeque<String>,
    owners: HashMap<String, String>,
    last_owner: Option<String>,
    active: usize,
    bytes: usize,
    closed: bool,
}
struct Inner {
    state: Mutex<State>,
    ready: Condvar,
    active_limit: usize,
    catalog: Option<Arc<Mutex<Catalog>>>,
    // An unfinished job retains the OS profile lock even if its frontend disconnects.
    _profile_ownership: Option<Arc<File>>,
}
#[derive(Clone)]
pub struct JobPool(Arc<Inner>);
impl Default for JobPool {
    fn default() -> Self {
        Self::new()
    }
}
impl JobPool {
    pub fn new() -> Self {
        Self::build(None, None).expect("in-memory job pool")
    }
    pub fn with_catalog(
        catalog: Arc<Mutex<Catalog>>,
        profile_ownership: Option<Arc<File>>,
    ) -> Result<Self> {
        Self::build(Some(catalog), profile_ownership)
    }
    fn build(
        catalog: Option<Arc<Mutex<Catalog>>>,
        profile_ownership: Option<Arc<File>>,
    ) -> Result<Self> {
        let cpus = std::thread::available_parallelism().map_or(1, usize::from);
        let pool = Self(Arc::new(Inner {
            state: Mutex::new(State {
                jobs: HashMap::new(),
                queue: VecDeque::new(),
                owners: HashMap::new(),
                last_owner: None,
                active: 0,
                bytes: 0,
                closed: false,
            }),
            ready: Condvar::new(),
            active_limit: cpus.saturating_sub(2).clamp(1, 2),
            catalog,
            _profile_ownership: profile_ownership,
        }));
        if let Some(catalog) = &pool.0.catalog {
            let rows = {
                let catalog = catalog.lock().unwrap();
                let mut statement = catalog
                    .connection
                    .prepare("SELECT id,state,details FROM jobs ORDER BY id LIMIT 257")
                    .map_err(sql_error)?;
                statement
                    .query_map([], |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, String>(2)?,
                        ))
                    })
                    .map_err(sql_error)?
                    .collect::<std::result::Result<Vec<_>, _>>()
                    .map_err(sql_error)?
            };
            if rows.len() > 256 {
                return Err(EngineError::new(
                    "resource_limit",
                    "durable job history exceeds capacity",
                ));
            }
            let mut state = pool.0.state.lock().unwrap();
            for (id, stored_state, details) in rows {
                let stored: Value = serde_json::from_str(&details)
                    .map_err(|error| EngineError::new("corrupt_state", error.to_string()))?;
                let digest = omc_protocol::canonical_digest(&stored["record"])?;
                if stored["digest"].as_str() != Some(&digest) {
                    return Err(EngineError::new(
                        "corrupt_state",
                        "job receipt integrity check failed",
                    ));
                }
                let mut record: Record = serde_json::from_value(stored["record"].clone())
                    .map_err(|error| EngineError::new("corrupt_state", error.to_string()))?;
                if record
                    .finished_ms
                    .is_some_and(|finished| now_ms().saturating_sub(finished) >= RETENTION_MS)
                {
                    catalog
                        .lock()
                        .unwrap()
                        .connection
                        .execute("DELETE FROM jobs WHERE id=?1", [&id])
                        .map_err(sql_error)?;
                    continue;
                }
                if stored_state != record.state
                    && (stored_state != "interrupted" || terminal(&record.state))
                {
                    return Err(EngineError::new(
                        "corrupt_state",
                        "job state and durable receipt disagree",
                    ));
                }
                if !terminal(&record.state) {
                    record.state = "interrupted".into();
                    record.finished_ms = Some(now_ms());
                    record.error = Some(EngineError::new(
                        "outcome_unknown",
                        "service stopped before a terminal job receipt; inspect the document or operation key before resubmitting",
                    ));
                }
                let context = pool.context(&id, record.commit_state, record.progress.clone());
                let mut job = Job { record, context };
                persist_job(&pool.0, &id, &mut job)?;
                state.jobs.insert(id, job);
            }
        }
        Ok(pool)
    }
    fn context(&self, id: &str, gate: u8, progress: Value) -> JobContext {
        JobContext {
            gate: Arc::new(AtomicU8::new(gate)),
            progress: Arc::new(Mutex::new(progress)),
            observer: Some((Arc::downgrade(&self.0), id.into())),
        }
    }
    pub fn register_owner(&self, session: &str, principal: &str) -> Result<()> {
        let mut state = self.0.state.lock().unwrap();
        if state.owners.len() >= 128 && !state.owners.contains_key(session) {
            return Err(EngineError::new(
                "resource_limit",
                "job session capacity reached",
            ));
        }
        state.owners.insert(session.into(), principal.into());
        Ok(())
    }
    pub fn submit<F>(&self, owner: &str, kind: &str, reserve: usize, task: F) -> Result<Value>
    where
        F: FnOnce(JobContext) -> Result<Value> + Send + 'static,
    {
        self.submit_scoped(owner, kind, reserve, Vec::new(), task)
    }
    pub fn submit_scoped<F>(
        &self,
        owner: &str,
        kind: &str,
        reserve: usize,
        documents: Vec<String>,
        task: F,
    ) -> Result<Value>
    where
        F: FnOnce(JobContext) -> Result<Value> + Send + 'static,
    {
        if kind.is_empty()
            || kind.len() > 128
            || documents.len() > 16
            || documents.iter().any(|id| !omc_model::valid_id(id, "doc"))
        {
            return Err(EngineError::invalid("invalid job kind or document scope"));
        }
        let mut state = self.0.state.lock().unwrap();
        if state.closed {
            return Err(EngineError::new("busy", "background job pool is stopping"));
        }
        prune(&self.0, &mut state)?;
        let principal = state
            .owners
            .get(owner)
            .cloned()
            .unwrap_or_else(|| owner.into());
        if state.queue.len() >= 16
            || state.jobs.len() >= 256
            || state
                .queue
                .iter()
                .filter(|id| state.jobs[*id].record.owner == principal)
                .count()
                >= 4
        {
            return Err(EngineError::new(
                "queue_full",
                "bounded background job queue is full",
            ));
        }
        if reserve > 128 * 1024 * 1024 || state.bytes.saturating_add(reserve) > 256 * 1024 * 1024 {
            return Err(EngineError::new(
                "resource_limit",
                "background reservation exceeds compute budget",
            ));
        }
        let id = format!("job_{}", uuid::Uuid::new_v4().simple());
        let context = self.context(&id, CANCELLABLE, json!({"phase":"queued"}));
        let mut job = Job {
            record: Record {
                owner: principal,
                session: owner.into(),
                kind: kind.into(),
                state: "queued".into(),
                created_ms: now_ms(),
                updated_ms: now_ms(),
                finished_ms: None,
                reserve,
                commit_state: CANCELLABLE,
                progress: json!({"phase":"queued"}),
                result: None,
                error: None,
                documents,
            },
            context: context.clone(),
        };
        // A returned ticket always has a committed SQLite receipt.
        persist_job(&self.0, &id, &mut job)?;
        state.jobs.insert(id.clone(), job);
        state.queue.push_back(id.clone());
        state.bytes += reserve;
        drop(state);
        let pool = self.clone();
        let run_id = id.clone();
        if let Err(error) = std::thread::Builder::new()
            .name("omc-background-job".into())
            .spawn(move || pool.run(&run_id, context, task))
        {
            let mut state = self.0.state.lock().unwrap();
            state.queue.retain(|queued| queued != &id);
            state.bytes -= reserve;
            finish(
                &self.0,
                &mut state,
                &id,
                Err(EngineError::new("storage_unavailable", error.to_string())),
            );
            return Err(EngineError::new(
                "storage_unavailable",
                "background worker could not start",
            ));
        }
        Ok(json!({"jobId":id,"state":"queued","cancellationBoundary":"before durable commit"}))
    }
    fn run<F>(&self, id: &str, context: JobContext, task: F)
    where
        F: FnOnce(JobContext) -> Result<Value>,
    {
        let mut state = self.0.state.lock().unwrap();
        loop {
            if context.check_cancelled().is_err() || state.closed {
                state.queue.retain(|queued| queued != id);
                state.bytes -= state.jobs[id].record.reserve;
                finish(
                    &self.0,
                    &mut state,
                    id,
                    Err(EngineError::new(
                        "cancelled",
                        "job cancelled before admission",
                    )),
                );
                self.0.ready.notify_all();
                return;
            }
            let next = state
                .queue
                .iter()
                .find(|next| state.last_owner.as_ref() != Some(&state.jobs[*next].record.owner))
                .or_else(|| state.queue.front());
            if state.active < self.0.active_limit && next.is_some_and(|next| next == id) {
                break;
            }
            state = self
                .0
                .ready
                .wait_timeout(state, Duration::from_millis(50))
                .unwrap()
                .0;
        }
        state.queue.retain(|queued| queued != id);
        state.last_owner = Some(state.jobs[id].record.owner.clone());
        state.active += 1;
        let job = state.jobs.get_mut(id).unwrap();
        job.record.state = "running".into();
        if let Err(error) = persist_job(&self.0, id, job) {
            state.active -= 1;
            state.bytes -= state.jobs[id].record.reserve;
            finish(&self.0, &mut state, id, Err(error));
            self.0.ready.notify_all();
            return;
        }
        self.0.ready.notify_all();
        drop(state);
        let result =
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| task(context.clone())))
                .unwrap_or_else(|_| {
                    Err(EngineError::new(
                        "internal_error",
                        "background computation terminated",
                    ))
                })
                .and_then(|result| {
                    context.check_cancelled()?;
                    if serde_json::to_vec(&result)
                        .map_err(|error| EngineError::new("internal_error", error.to_string()))?
                        .len()
                        > MAX_RESULT_BYTES
                    {
                        return Err(EngineError::new(
                            "resource_limit",
                            "job result exceeds 512 KiB; return an artifact descriptor",
                        ));
                    }
                    Ok(result)
                });
        let mut state = self.0.state.lock().unwrap();
        state.active -= 1;
        state.bytes -= state.jobs[id].record.reserve;
        finish(&self.0, &mut state, id, result);
        self.0.ready.notify_all();
    }
    pub fn status(&self, owner: &str, id: &str) -> Result<Value> {
        let state = self.0.state.lock().unwrap();
        let principal = state.owners.get(owner).map_or(owner, String::as_str);
        let job = state
            .jobs
            .get(id)
            .filter(|job| job.record.owner == principal)
            .ok_or_else(|| EngineError::invalid("job not found"))?;
        Ok(
            json!({"jobId":id,"kind":job.record.kind,"state":job.record.state,"progress":*job.context.progress.lock().unwrap(),"result":job.record.result,"error":job.record.error,"createdAtMs":job.record.created_ms,"finishedAtMs":job.record.finished_ms,"cancellationBoundary":boundary(job.context.gate.load(Ordering::Acquire))}),
        )
    }
    pub fn cancel(&self, owner: &str, id: &str) -> Result<Value> {
        let mut state = self.0.state.lock().unwrap();
        let principal = state
            .owners
            .get(owner)
            .cloned()
            .unwrap_or_else(|| owner.into());
        let job = state
            .jobs
            .get_mut(id)
            .filter(|job| job.record.owner == principal)
            .ok_or_else(|| EngineError::invalid("job not found"))?;
        if terminal(&job.record.state) {
            return Ok(
                json!({"jobId":id,"state":job.record.state,"cancellation":"already_finished","result":job.record.result}),
            );
        }
        let gate = match job.context.gate.compare_exchange(
            CANCELLABLE,
            CANCELLED,
            Ordering::AcqRel,
            Ordering::Acquire,
        ) {
            Ok(_) => CANCELLED,
            Err(gate) => gate,
        };
        if gate == COMMITTING || gate == COMMITTED {
            return Ok(
                json!({"jobId":id,"state":job.record.state,"cancellation":boundary(gate),"result":job.record.result}),
            );
        }
        job.record.state = "cancelling".into();
        persist_job(&self.0, id, job)?;
        self.0.ready.notify_all();
        Ok(json!({"jobId":id,"state":job.record.state,"cancellation":"requested"}))
    }
    pub fn cancel_owner(&self, owner: &str) {
        let mut state = self.0.state.lock().unwrap();
        for (id, job) in state
            .jobs
            .iter_mut()
            .filter(|(_, job)| job.record.session == owner && !terminal(&job.record.state))
        {
            if job
                .context
                .gate
                .compare_exchange(CANCELLABLE, CANCELLED, Ordering::AcqRel, Ordering::Acquire)
                .is_ok()
            {
                job.record.state = "cancelling".into();
                let _ = persist_job(&self.0, id, job);
            }
        }
        state.owners.remove(owner);
        self.0.ready.notify_all();
    }
    pub fn has_document(&self, id: &str) -> bool {
        self.0.state.lock().unwrap().jobs.values().any(|job| {
            !terminal(&job.record.state)
                && job.record.documents.iter().any(|document| document == id)
        })
    }
    pub fn shutdown(&self) {
        let mut state = self.0.state.lock().unwrap();
        state.closed = true;
        for job in state.jobs.values() {
            let _ = job.context.gate.compare_exchange(
                CANCELLABLE,
                CANCELLED,
                Ordering::AcqRel,
                Ordering::Acquire,
            );
        }
        self.0.ready.notify_all();
    }
    pub fn metrics(&self) -> Value {
        let state = self.0.state.lock().unwrap();
        json!({"active":state.active,"queued":state.queue.len(),"reservedBytes":state.bytes,"activeLimit":self.0.active_limit,"retainedReceipts":state.jobs.len()})
    }
}
fn persist_job(inner: &Inner, id: &str, job: &mut Job) -> Result<()> {
    job.record.commit_state = job.context.gate.load(Ordering::Acquire);
    job.record.progress = job.context.progress.lock().unwrap().clone();
    job.record.updated_ms = now_ms();
    if let Some(catalog) = &inner.catalog {
        let record = serde_json::to_value(&job.record)
            .map_err(|error| EngineError::new("internal_error", error.to_string()))?;
        let details =
            json!({"digest":omc_protocol::canonical_digest(&record)?,"record":record}).to_string();
        catalog.lock().unwrap().connection.execute("INSERT INTO jobs(id,kind,state,details) VALUES(?1,?2,?3,?4) ON CONFLICT(id) DO UPDATE SET state=excluded.state,details=excluded.details", params![id,job.record.kind,job.record.state,details]).map_err(sql_error)?;
    }
    Ok(())
}
fn finish(inner: &Inner, state: &mut State, id: &str, result: Result<Value>) {
    let job = state.jobs.get_mut(id).unwrap();
    job.record.finished_ms = Some(now_ms());
    match result {
        Ok(result) => {
            job.record.state = "completed".into();
            job.record.result = Some(result);
        }
        Err(error) => {
            job.record.state = match error.code.as_str() {
                "cancelled" => "cancelled",
                "outcome_unknown" => "interrupted",
                _ => "failed",
            }
            .into();
            job.record.error = Some(error);
        }
    }
    if let Err(error) = persist_job(inner, id, job) {
        job.record.state = "interrupted".into();
        job.record.error = Some(error);
    }
}
fn prune(inner: &Inner, state: &mut State) -> Result<()> {
    let expired: Vec<_> = state
        .jobs
        .iter()
        .filter(|(_, job)| {
            job.record
                .finished_ms
                .is_some_and(|finished| now_ms().saturating_sub(finished) >= RETENTION_MS)
        })
        .map(|(id, _)| id.clone())
        .collect();
    for id in expired {
        if let Some(catalog) = &inner.catalog {
            catalog
                .lock()
                .unwrap()
                .connection
                .execute("DELETE FROM jobs WHERE id=?1", [&id])
                .map_err(sql_error)?;
        }
        state.jobs.remove(&id);
    }
    Ok(())
}
fn terminal(state: &str) -> bool {
    matches!(state, "completed" | "cancelled" | "failed" | "interrupted")
}
fn boundary(gate: u8) -> &'static str {
    match gate {
        COMMITTING => "already_committing",
        COMMITTED => "already_committed",
        _ => "before durable commit",
    }
}
fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::Instant;

    fn await_terminal(pool: &JobPool, owner: &str, id: &str) -> Value {
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            let status = pool.status(owner, id).unwrap();
            if terminal(status["state"].as_str().unwrap()) {
                return status;
            }
            assert!(Instant::now() < deadline, "job did not finish: {status}");
            std::thread::sleep(Duration::from_millis(2));
        }
    }

    #[test]
    fn terminal_receipt_survives_restart_and_principal_resumption() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("catalog.sqlite");
        let catalog = Arc::new(Mutex::new(Catalog::open(&path).unwrap()));
        let pool = JobPool::with_catalog(catalog, None).unwrap();
        pool.register_owner("session-a", "principal-a").unwrap();
        let ticket = pool
            .submit("session-a", "export", 4096, |context| {
                context.begin_commit()?;
                context.mark_committed();
                Ok(json!({"artifact":"artifact_1"}))
            })
            .unwrap();
        let id = ticket["jobId"].as_str().unwrap();
        assert_eq!(await_terminal(&pool, "session-a", id)["state"], "completed");
        drop(pool);
        let reopened =
            JobPool::with_catalog(Arc::new(Mutex::new(Catalog::open(&path).unwrap())), None)
                .unwrap();
        reopened.register_owner("session-b", "principal-a").unwrap();
        reopened.register_owner("session-c", "principal-b").unwrap();
        let status = reopened.status("session-b", id).unwrap();
        assert_eq!(status["state"], "completed");
        assert_eq!(status["result"]["artifact"], "artifact_1");
        assert_eq!(status["cancellationBoundary"], "already_committed");
        assert!(reopened.status("session-c", id).is_err());
        assert_eq!(reopened.metrics()["active"], 0);
    }

    #[test]
    fn incomplete_durable_ticket_becomes_interrupted_without_reexecution() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("catalog.sqlite");
        let catalog = Arc::new(Mutex::new(Catalog::open(&path).unwrap()));
        let pool = JobPool::with_catalog(catalog.clone(), None).unwrap();
        let id = "job_incomplete";
        let context = pool.context(id, COMMITTING, json!({"phase":"install"}));
        let mut job = Job {
            record: Record {
                owner: "principal-a".into(),
                session: "old-session".into(),
                kind: "import".into(),
                state: "running".into(),
                created_ms: now_ms(),
                updated_ms: now_ms(),
                finished_ms: None,
                reserve: 4096,
                commit_state: COMMITTING,
                progress: json!({}),
                result: None,
                error: None,
                documents: vec![],
            },
            context,
        };
        persist_job(&pool.0, id, &mut job).unwrap();
        drop(job);
        drop(pool);
        drop(catalog);
        let reopened =
            JobPool::with_catalog(Arc::new(Mutex::new(Catalog::open(&path).unwrap())), None)
                .unwrap();
        reopened
            .register_owner("new-session", "principal-a")
            .unwrap();
        let status = reopened.status("new-session", id).unwrap();
        assert_eq!(status["state"], "interrupted");
        assert_eq!(status["error"]["code"], "outcome_unknown");
        assert_eq!(reopened.metrics()["active"], 0);
        assert_eq!(reopened.metrics()["queued"], 0);
    }

    #[test]
    fn cancellation_and_commit_gate_have_one_winner() {
        for cancel_first in [true, false] {
            let pool = JobPool::new();
            let (ready_tx, ready_rx) = mpsc::sync_channel(1);
            let (resume_tx, resume_rx) = mpsc::sync_channel(1);
            let ticket = pool
                .submit("owner", "import", 4096, move |context| {
                    if !cancel_first {
                        context.begin_commit()?;
                    }
                    ready_tx.send(()).unwrap();
                    resume_rx.recv_timeout(Duration::from_secs(3)).unwrap();
                    if cancel_first {
                        context.begin_commit()?;
                    }
                    context.mark_committed();
                    Ok(json!({"installed":true}))
                })
                .unwrap();
            let id = ticket["jobId"].as_str().unwrap();
            ready_rx.recv_timeout(Duration::from_secs(3)).unwrap();
            let cancel = pool.cancel("owner", id).unwrap();
            resume_tx.send(()).unwrap();
            let status = await_terminal(&pool, "owner", id);
            if cancel_first {
                assert_eq!(cancel["cancellation"], "requested");
                assert_eq!(status["state"], "cancelled");
                assert!(status["result"].is_null());
            } else {
                assert_eq!(cancel["cancellation"], "already_committing");
                assert_eq!(status["state"], "completed");
                assert_eq!(status["result"]["installed"], true);
            }
            assert_eq!(pool.metrics()["reservedBytes"], 0);
        }
    }

    #[test]
    fn reservations_and_result_receipts_are_bounded() {
        let pool = JobPool::new();
        assert_eq!(
            pool.submit("owner", "import", 128 * 1024 * 1024 + 1, |_| Ok(
                Value::Null
            ))
            .unwrap_err()
            .code,
            "resource_limit"
        );
        let ticket = pool
            .submit("owner", "export", 4096, |_| {
                Ok(json!({"inline":"x".repeat(MAX_RESULT_BYTES)}))
            })
            .unwrap();
        let id = ticket["jobId"].as_str().unwrap();
        let status = await_terminal(&pool, "owner", id);
        assert_eq!(status["state"], "failed");
        assert_eq!(status["error"]["code"], "resource_limit");
        assert_eq!(pool.metrics()["reservedBytes"], 0);
    }
}
