use omc_protocol::{EngineError, Result};
use omc_workspace::Workspace;
use serde_json::{Value, json};
use std::{
    sync::Mutex,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio::sync::{Notify, oneshot};

const POLL_TIMEOUT: Duration = Duration::from_secs(1);
const OWNER_TIMEOUT: Duration = Duration::from_secs(4);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(8);

#[derive(Default)]
pub struct DesktopAutomation {
    state: Mutex<State>,
    ready: Notify,
}

#[derive(Default)]
struct State {
    owner: Option<(String, Instant)>,
    pending: Option<Pending>,
    plugin_manager: Option<(String, String)>,
}

struct Pending {
    id: String,
    payload: Option<Value>,
    reply: oneshot::Sender<Result<Value>>,
}

impl DesktopAutomation {
    pub fn attached(&self) -> bool {
        self.state
            .lock()
            .unwrap()
            .owner
            .as_ref()
            .is_some_and(|(_, last_poll)| last_poll.elapsed() < OWNER_TIMEOUT)
    }

    pub fn detach(&self, session: &str) {
        let mut state = self.state.lock().unwrap();
        if state.plugin_manager.as_ref().is_some_and(|(_, manager)| manager == session) {
            state.plugin_manager = None;
        }
        if state
            .owner
            .as_ref()
            .is_some_and(|(owner, _)| owner == session)
        {
            state.owner = None;
            state.plugin_manager = None;
            if let Some(pending) = state.pending.take() {
                let _ = pending.reply.send(Err(EngineError::new(
                    "desktop_unavailable",
                    "The desktop disconnected",
                )));
            }
            self.ready.notify_one();
        }
    }

    pub fn set_plugin_manager(&self, lease: String, session: &str) {
        self.state.lock().unwrap().plugin_manager = Some((lease, session.into()));
    }

    pub fn plugin_manager_session(&self, desktop: &str, lease: Option<&str>) -> Result<String> {
        let state = self.state.lock().unwrap();
        if !state.owner.as_ref().is_some_and(|(owner, at)| {
            owner == desktop && at.elapsed() < OWNER_TIMEOUT
        }) {
            return Err(EngineError::new("authentication_failed", "Desktop broker session required"));
        }
        match lease {
            None => Ok(desktop.into()),
            Some(lease) => state.plugin_manager.as_ref()
                .filter(|(active, _)| active == lease)
                .map(|(_, session)| session.clone())
                .ok_or_else(|| EngineError::new("authentication_failed", "Plugin manager is no longer open")),
        }
    }

    pub async fn call(&self, session: &str, method: &str, args: Value) -> Result<Value> {
        let id = uuid::Uuid::new_v4().to_string();
        let (send, receive) = oneshot::channel();
        {
            let mut state = self.state.lock().unwrap();
            if state
                .pending
                .as_ref()
                .is_some_and(|work| work.reply.is_closed())
            {
                state.pending = None;
            }
            let live = state
                .owner
                .as_ref()
                .is_some_and(|(_, at)| at.elapsed() < OWNER_TIMEOUT);
            if state.pending.is_some() {
                return Err(EngineError::new(
                    "busy",
                    "Another desktop request is in progress",
                ));
            }
            if !live {
                return if method == "inspect_ui" {
                    Ok(json!({"attached":false,"mode":"headless","status":"headless","windows":[]}))
                } else {
                    Err(EngineError::new(
                        "desktop_unavailable",
                        "Open the native desktop in this workspace profile",
                    ))
                };
            }
            let expires = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                + REQUEST_TIMEOUT;
            state.pending = Some(Pending {
                id: id.clone(),
                payload: Some(
                    json!({"id":id,"session":session,"method":method,"arguments":args,"expires":expires.as_millis() as u64}),
                ),
                reply: send,
            });
        }
        self.ready.notify_one();
        match tokio::time::timeout(REQUEST_TIMEOUT, receive).await {
            Ok(Ok(result)) => result,
            _ => {
                let mut state = self.state.lock().unwrap();
                if state
                    .pending
                    .as_ref()
                    .is_some_and(|pending| pending.id == id)
                {
                    state.pending = None;
                }
                Err(EngineError::new(
                    "desktop_timeout",
                    "The desktop did not finish in time. Check its state before retrying an edit",
                ))
            }
        }
    }

    pub async fn rpc(
        &self,
        workspace: &Workspace,
        session: Option<&str>,
        method: &str,
        args: Value,
    ) -> Result<Value> {
        let session = session
            .ok_or_else(|| EngineError::new("authentication_failed", "Desktop session required"))?;
        workspace.session(session)?;
        if method == "desktop.poll" {
            {
                let mut state = self.state.lock().unwrap();
                workspace.session(session)?;
                if state.owner.as_ref().is_some_and(|(owner, at)| {
                    owner != session
                        && (at.elapsed() < OWNER_TIMEOUT
                            || state.pending.as_ref().is_some_and(|request| {
                                request.payload.is_none() && !request.reply.is_closed()
                            }))
                }) {
                    return Err(EngineError::new(
                        "busy",
                        "Another desktop is attached to this profile",
                    ));
                }
                if state
                    .owner
                    .as_ref()
                    .is_some_and(|(owner, _)| owner != session)
                {
                    state.plugin_manager = None;
                    if let Some(previous) = state.pending.take() {
                        let _ = previous.reply.send(Err(EngineError::new(
                            "desktop_unavailable",
                            "The attached desktop changed",
                        )));
                    }
                }
                state.owner = Some((session.into(), Instant::now()));
            }
            let wait = async {
                loop {
                    let notified = self.ready.notified();
                    {
                        let mut state = self.state.lock().unwrap();
                        if state
                            .owner
                            .as_ref()
                            .is_none_or(|(owner, _)| owner != session)
                        {
                            return Value::Null;
                        }
                        if let Some(pending) = state.pending.as_mut()
                            && !pending.reply.is_closed()
                            && let Some(payload) = pending.payload.take()
                        {
                            return payload;
                        }
                    }
                    notified.await;
                }
            };
            return Ok(tokio::time::timeout(POLL_TIMEOUT, wait)
                .await
                .unwrap_or(Value::Null));
        }
        let mut state = self.state.lock().unwrap();
        if state
            .owner
            .as_ref()
            .is_none_or(|(owner, _)| owner != session)
        {
            return Err(EngineError::new(
                "authentication_failed",
                "This desktop no longer owns the connection",
            ));
        }
        state.owner = Some((session.into(), Instant::now()));
        if state.pending.as_ref().is_some_and(|pending| {
            args["id"].as_str() == Some(&pending.id) && pending.payload.is_none()
        }) {
            let pending = state.pending.take().unwrap();
            let result = if let Some(error) = args["error"].as_str() {
                Err(EngineError::invalid(error))
            } else {
                Ok(args["result"].clone())
            };
            let _ = pending.reply.send(result);
        }
        Ok(json!({}))
    }
}
