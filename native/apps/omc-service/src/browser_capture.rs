use axum::{
    Json, Router,
    body::Bytes,
    extract::{DefaultBodyLimit, Path, Request, State},
    http::StatusCode,
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::post,
};
use omc_mcp::ToolRouter;
use omc_protocol::{EngineError, Result};
use serde_json::{Value, json};
use std::{
    net::SocketAddr,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::oneshot;
use uuid::Uuid;

const CAPTURE_LIMIT: usize = 12 * 1024 * 1024;
const SELECTION_WAIT: Duration = Duration::from_secs(10);

pub(crate) struct BrowserCapture {
    pub key: String,
    host: String,
    pending: Mutex<Option<Pending>>,
}

struct Pending {
    id: Uuid,
    claimed: bool,
    reply: Option<oneshot::Sender<Bytes>>,
}

struct Reservation<'a> {
    capture: &'a BrowserCapture,
    id: Uuid,
}

impl Drop for Reservation<'_> {
    fn drop(&mut self) {
        let mut pending = self.capture.pending.lock().unwrap();
        if pending
            .as_ref()
            .is_some_and(|request| request.id == self.id)
        {
            pending.take();
        }
    }
}

pub(crate) fn tool() -> Value {
    json!({
        "name": "capture_web",
        "description": "Capture the current rendered state of the element explicitly selected in the paired OMC Chromium extension. Create and open a new editable canvas and return conversion diagnostics.",
        "inputSchema": {
            "type": "object",
            "properties": {"title": {"type": "string", "minLength": 1, "maxLength": 256}},
            "additionalProperties": false
        }
    })
}

impl BrowserCapture {
    pub fn new(address: SocketAddr) -> Self {
        Self {
            host: address.to_string(),
            key: omc_workspace::random_secret(),
            pending: Mutex::new(None),
        }
    }

    pub fn routes(self: &Arc<Self>) -> Router {
        Router::new()
            .route("/browser-capture/claim", post(claim))
            .route("/browser-capture/result/{id}", post(complete))
            .layer(DefaultBodyLimit::max(CAPTURE_LIMIT))
            .layer(middleware::from_fn_with_state(self.clone(), authenticate))
            .with_state(self.clone())
    }

    pub async fn import(
        &self,
        router: Arc<ToolRouter>,
        session: String,
        args: Value,
    ) -> Result<Value> {
        omc_mcp::schema::check(&tool()["inputSchema"], &args, "args")?;
        let bytes = self.receive().await?;
        if bytes.as_ref() == b"null" {
            return Err(EngineError::invalid(
                "The selected element could not be captured. Pick a visible, supported element.",
            ));
        }
        tokio::task::spawn_blocking(move || {
            router.import_browser_capture(&session, args["title"].as_str(), &bytes)
        })
        .await
        .map_err(|_| EngineError::new("internal_error", "browser capture worker stopped"))?
    }

    async fn receive(&self) -> Result<Bytes> {
        let id = Uuid::new_v4();
        let (reply, result) = oneshot::channel();
        let _reservation = {
            let mut pending = self.pending.lock().unwrap();
            if pending.is_some() {
                return Err(EngineError::new(
                    "busy",
                    "Another browser capture is waiting for a selection",
                ));
            }
            *pending = Some(Pending {
                id,
                claimed: false,
                reply: Some(reply),
            });
            Reservation { capture: self, id }
        };
        tokio::time::timeout(SELECTION_WAIT, result)
            .await
            .map_err(|_| {
                EngineError::new(
                    "browser_selection_unavailable",
                    "Select an element using the paired OMC browser extension and retry",
                )
            })?
            .map_err(|_| {
                EngineError::new(
                    "internal_error",
                    "browser capture closed before a result arrived",
                )
            })
    }
}

async fn authenticate(
    State(capture): State<Arc<BrowserCapture>>,
    request: Request,
    next: Next,
) -> Response {
    let headers = request.headers();
    if headers.get("host").and_then(|value| value.to_str().ok()) != Some(capture.host.as_str()) {
        return StatusCode::FORBIDDEN.into_response();
    }
    if let Some(origin) = headers.get("origin") {
        let extension = origin
            .to_str()
            .ok()
            .and_then(|value| value.strip_prefix("chrome-extension://"));
        if !extension.is_some_and(|id| {
            id.len() == 32 && id.bytes().all(|byte| (b'a'..=b'p').contains(&byte))
        }) {
            return StatusCode::FORBIDDEN.into_response();
        }
    }
    let proof = headers
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "));
    if !proof.is_some_and(|proof| {
        omc_workspace::constant_time_equal(proof.as_bytes(), capture.key.as_bytes())
    }) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    next.run(request).await
}

async fn claim(State(capture): State<Arc<BrowserCapture>>) -> Response {
    let mut pending = capture.pending.lock().unwrap();
    let Some(request) = pending.as_mut().filter(|request| !request.claimed) else {
        return StatusCode::NO_CONTENT.into_response();
    };
    request.claimed = true;
    Json(json!({"id": request.id})).into_response()
}

async fn complete(
    State(capture): State<Arc<BrowserCapture>>,
    Path(id): Path<Uuid>,
    bytes: Bytes,
) -> StatusCode {
    let reply = capture
        .pending
        .lock()
        .unwrap()
        .as_mut()
        .filter(|request| request.id == id && request.claimed)
        .and_then(|request| request.reply.take());
    if reply.is_some_and(|reply| reply.send(bytes).is_ok()) {
        StatusCode::NO_CONTENT
    } else {
        StatusCode::NOT_FOUND
    }
}
