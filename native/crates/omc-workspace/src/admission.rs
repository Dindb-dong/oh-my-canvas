//! Bounded fair admission shared by every document and caller.
use omc_protocol::{EngineError, Result};
use std::{
    collections::{BTreeMap, VecDeque},
    sync::{Arc, Condvar, Mutex},
    time::{Duration, Instant},
};

#[derive(Clone, Copy, Debug, Eq, PartialEq, Ord, PartialOrd)]
pub enum WorkClass {
    Interactive,
    Durable,
    Background,
}
impl WorkClass {
    fn weight(self) -> u32 {
        match self {
            Self::Interactive => 8,
            Self::Durable => 4,
            Self::Background => 1,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Ord, PartialOrd)]
struct QueueKey {
    document: String,
    caller: String,
    class: WorkClass,
}
struct Entry {
    ticket: u64,
    bytes: usize,
    cost: u32,
}
struct Queue {
    entries: VecDeque<Entry>,
    deficit: u32,
}
#[derive(Default)]
struct State {
    next: u64,
    queues: BTreeMap<QueueKey, Queue>,
    rotation: VecDeque<QueueKey>,
    active: BTreeMap<String, usize>,
    granted: BTreeMap<u64, (QueueKey, usize)>,
    bytes: usize,
    count: usize,
    closed: bool,
}
struct Inner {
    state: Mutex<State>,
    changed: Condvar,
    active_limit: usize,
}
#[derive(Clone)]
pub struct Admission(Arc<Inner>);
pub struct Permit {
    admission: Admission,
    key: QueueKey,
    bytes: usize,
}

impl Admission {
    pub fn new(active_limit: usize) -> Self {
        Self(Arc::new(Inner {
            state: Mutex::new(State::default()),
            changed: Condvar::new(),
            active_limit: active_limit.max(1),
        }))
    }

    pub fn acquire(
        &self,
        caller: &str,
        document: &str,
        class: WorkClass,
        bytes: usize,
        deadline: Duration,
    ) -> Result<Permit> {
        let key = QueueKey {
            document: document.into(),
            caller: caller.into(),
            class,
        };
        let mut state = self.0.state.lock().unwrap();
        if state.closed {
            return Err(EngineError::new("busy", "workspace is shutting down"));
        }
        let queued_for = |document: Option<&str>, caller: Option<&str>| -> usize {
            state
                .queues
                .iter()
                .filter(|(k, _)| {
                    document.is_none_or(|d| d == k.document) && caller.is_none_or(|c| c == k.caller)
                })
                .map(|(_, q)| q.entries.len())
                .sum()
        };
        if state.count >= 256
            || queued_for(Some(document), None) >= 128
            || queued_for(None, Some(caller)) >= 32
            || queued_for(Some(document), Some(caller)) >= 16
        {
            return Err(EngineError::new(
                "queue_full",
                "bounded workspace admission queue is full",
            )
            .detail(serde_json::json!({"retryAfterMs":25})));
        }
        if bytes > 4 * 1024 * 1024 || state.bytes.saturating_add(bytes) > 64 * 1024 * 1024 {
            return Err(EngineError::new(
                "resource_limit",
                "transport reservation exceeds workspace budget",
            ));
        }
        state.next += 1;
        let ticket = state.next;
        if !state.queues.contains_key(&key) {
            state.rotation.push_back(key.clone());
            state.queues.insert(
                key.clone(),
                Queue {
                    entries: VecDeque::new(),
                    deficit: 0,
                },
            );
        }
        state
            .queues
            .get_mut(&key)
            .unwrap()
            .entries
            .push_back(Entry {
                ticket,
                bytes,
                cost: 1 + (bytes / 65536) as u32,
            });
        state.count += 1;
        state.bytes += bytes;
        let until = Instant::now() + deadline;
        loop {
            self.dispatch(&mut state);
            self.0.changed.notify_all();
            if let Some((key, bytes)) = state.granted.remove(&ticket) {
                return Ok(Permit {
                    admission: self.clone(),
                    key,
                    bytes,
                });
            }
            let now = Instant::now();
            if state.closed || now >= until {
                if let Some(queue) = state.queues.get_mut(&key) {
                    queue.entries.retain(|e| e.ticket != ticket);
                }
                state.count -= 1;
                state.bytes -= bytes;
                self.dispatch(&mut state);
                self.0.changed.notify_all();
                return Err(EngineError::new(
                    "deadline_exceeded",
                    "request expired before document admission",
                ));
            }
            state = self
                .0
                .changed
                .wait_timeout(state, (until - now).min(Duration::from_millis(50)))
                .unwrap()
                .0;
        }
    }

    fn dispatch(&self, state: &mut State) {
        if state.closed {
            return;
        }
        // A complete round considers every caller/document queue. Large requests accrue
        // credits across rounds; request byte size is charged before serialization work.
        for _ in 0..65 {
            if state.active.len() >= self.0.active_limit {
                break;
            }
            let mut granted = false;
            let rounds = state.rotation.len();
            for _ in 0..rounds {
                let Some(key) = state.rotation.pop_front() else {
                    break;
                };
                let empty = state.queues.get(&key).is_none_or(|q| q.entries.is_empty());
                if empty {
                    state.queues.remove(&key);
                    continue;
                }
                state.rotation.push_back(key.clone());
                if state.active.contains_key(&key.document) {
                    continue;
                }
                let queue = state.queues.get_mut(&key).unwrap();
                queue.deficit = queue.deficit.saturating_add(key.class.weight()).min(1024);
                if queue.entries.front().unwrap().cost > queue.deficit {
                    continue;
                }
                let entry = queue.entries.pop_front().unwrap();
                queue.deficit -= entry.cost;
                state.active.insert(key.document.clone(), 1);
                state.granted.insert(entry.ticket, (key, entry.bytes));
                granted = true;
                if state.active.len() >= self.0.active_limit {
                    return;
                }
            }
            if granted || state.rotation.is_empty() {
                break;
            }
        }
    }

    pub fn close(&self) {
        self.0.state.lock().unwrap().closed = true;
        self.0.changed.notify_all();
    }
    pub fn metrics(&self) -> serde_json::Value {
        let s = self.0.state.lock().unwrap();
        serde_json::json!({"pendingAndActive":s.count,"activeDocuments":s.active.len(),"reservedTransportBytes":s.bytes})
    }
}
impl Drop for Permit {
    fn drop(&mut self) {
        let mut state = self.admission.0.state.lock().unwrap();
        state.active.remove(&self.key.document);
        state.count -= 1;
        state.bytes -= self.bytes;
        self.admission.dispatch(&mut state);
        self.admission.0.changed.notify_all();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn another_document_progresses_while_a_document_is_held() {
        let admission = Admission::new(2);
        let first = admission
            .acquire(
                "a",
                "doc_a",
                WorkClass::Interactive,
                10,
                Duration::from_secs(1),
            )
            .unwrap();
        let other = admission
            .acquire(
                "b",
                "doc_b",
                WorkClass::Background,
                10,
                Duration::from_secs(1),
            )
            .unwrap();
        assert_eq!(admission.metrics()["activeDocuments"], 2);
        drop(other);
        drop(first);
        assert_eq!(admission.metrics()["reservedTransportBytes"], 0);
    }
    #[test]
    fn timeout_does_not_leak_reservations() {
        let admission = Admission::new(1);
        let first = admission
            .acquire(
                "a",
                "doc_a",
                WorkClass::Interactive,
                5,
                Duration::from_secs(1),
            )
            .unwrap();
        let error = admission
            .acquire(
                "b",
                "doc_a",
                WorkClass::Background,
                17,
                Duration::from_millis(1),
            )
            .err()
            .unwrap();
        assert_eq!(error.code, "deadline_exceeded");
        assert_eq!(admission.metrics()["reservedTransportBytes"], 5);
        drop(first);
        assert_eq!(admission.metrics()["pendingAndActive"], 0);
    }
}
