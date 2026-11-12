//! The Electron-compatible discovery files and loopback TLS endpoint.
use crate::{App, close_mcp, io_error, mcp, no_event_stream, publish_descriptor, publish_private};
use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, Request, State},
    http::StatusCode,
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::post,
    serve::Listener,
};
use base64::Engine;
use omc_protocol::{EngineError, Result};
use rustls::pki_types::{CertificateDer, PrivateKeyDer, pem::PemObject};
use serde_json::json;
use std::{
    net::{Ipv4Addr, SocketAddr},
    path::Path,
    sync::Arc,
    time::Duration,
};
use tokio::{
    net::{TcpListener, TcpStream},
    task::JoinSet,
};
use tokio_rustls::{TlsAcceptor, server::TlsStream};

pub async fn start(app: App, profile: &Path, port: u16) -> Result<Running> {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, port))
        .await
        .map_err(io_error)?;
    let address = listener.local_addr().map_err(io_error)?;
    let identity_path = profile.join("mcp-identity.json");
    let cert_path = profile.join("mcp-cert.pem");
    let token_path = profile.join("mcp-token-v2");
    let descriptor = profile.join("mcp-runtime.json");
    let identity = match read(&identity_path)? {
        Some(bytes) => omc_protocol::decode_json(&bytes)?,
        None => {
            if cert_path.exists() {
                return Err(tls_error("MCP certificate has no private identity"));
            }
            let rcgen::CertifiedKey { cert, signing_key } =
                rcgen::generate_simple_self_signed(vec!["127.0.0.1".into(), "localhost".into()])
                    .map_err(tls_error)?;
            let identity = json!({"key":pem_encode("PRIVATE KEY", &signing_key.serialize_der()),"cert":pem_encode("CERTIFICATE", cert.der().as_ref())});
            publish_descriptor(&identity_path, &identity)?;
            identity
        }
    };
    let pem = |field| -> Result<&str> {
        identity[field]
            .as_str()
            .ok_or_else(|| tls_error("invalid private MCP identity"))
    };
    let certificate = pem("cert")?;
    let config = rustls::ServerConfig::builder_with_provider(Arc::new(
        rustls::crypto::aws_lc_rs::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .map_err(tls_error)?
    .with_no_client_auth()
    .with_single_cert(
        vec![CertificateDer::from_pem_slice(certificate.as_bytes()).map_err(tls_error)?],
        PrivateKeyDer::from_pem_slice(pem("key")?.as_bytes()).map_err(tls_error)?,
    )
    .map_err(tls_error)?;
    match read(&cert_path)? {
        Some(bytes) if bytes != certificate.as_bytes() => {
            return Err(tls_error(
                "MCP certificate does not match its private identity",
            ));
        }
        Some(_) => {}
        None => publish_private(&cert_path, certificate.as_bytes())?,
    }
    if let Some(bytes) = read(&descriptor)?
        && omc_protocol::decode_json(&bytes)?.get("token").is_some()
    {
        return Err(tls_error(
            "obsolete MCP discovery contains a credential; remove it and renew MCP client trust",
        ));
    }
    let token = match read(&token_path)? {
        Some(bytes) => String::from_utf8(bytes).map_err(tls_error)?,
        None => {
            let token = omc_workspace::random_secret()[..64].to_owned();
            publish_private(&token_path, token.as_bytes())?;
            token
        }
    };
    if token.len() != 64
        || !token
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(tls_error("invalid local MCP bearer credential"));
    }
    let auth = Auth {
        token,
        address,
        admission: Arc::new(tokio::sync::Semaphore::new(8)),
    };
    let router = Router::new()
        .route("/mcp", post(mcp).delete(close_mcp).get(no_event_stream))
        .layer(DefaultBodyLimit::max(1024 * 1024))
        .layer(middleware::from_fn_with_state(auth, authorize))
        .with_state(app);
    let listener = TlsListener {
        listener,
        acceptor: TlsAcceptor::from(Arc::new(config)),
        handshakes: JoinSet::new(),
    };
    publish_descriptor(
        &descriptor,
        &json!({"version":2,"port":address.port(),"pid":std::process::id(),"certFile":cert_path}),
    )?;
    let (stop, stopped) = tokio::sync::oneshot::channel();
    let task = tokio::spawn(async move {
        let _ = axum::serve(listener, router)
            .with_graceful_shutdown(async {
                let _ = stopped.await;
            })
            .await;
    });
    Ok(Running {
        descriptor,
        stop,
        task,
    })
}

pub struct Running {
    descriptor: std::path::PathBuf,
    stop: tokio::sync::oneshot::Sender<()>,
    task: tokio::task::JoinHandle<()>,
}

impl Running {
    pub async fn close(mut self) {
        let _ = self.stop.send(());
        if tokio::time::timeout(Duration::from_secs(2), &mut self.task)
            .await
            .is_err()
        {
            self.task.abort();
        }
        let _ = std::fs::remove_file(self.descriptor);
    }
}

#[derive(Clone)]
struct Auth {
    token: String,
    address: SocketAddr,
    admission: Arc<tokio::sync::Semaphore>,
}

async fn authorize(State(auth): State<Auth>, request: Request, next: Next) -> Response {
    let headers = request.headers();
    let host = headers.get("host").and_then(|value| value.to_str().ok());
    let token = headers
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "));
    if headers.contains_key("origin")
        || (host != Some(auth.address.to_string().as_str())
            && host != Some(format!("localhost:{}", auth.address.port()).as_str()))
        || !token.is_some_and(|token| {
            omc_workspace::constant_time_equal(token.as_bytes(), auth.token.as_bytes())
        })
    {
        return (StatusCode::FORBIDDEN, Json(json!({"error":"Forbidden"}))).into_response();
    }
    let Ok(_permit) = auth.admission.try_acquire_owned() else {
        return StatusCode::TOO_MANY_REQUESTS.into_response();
    };
    tokio::time::timeout(Duration::from_secs(63), next.run(request))
        .await
        .unwrap_or_else(|_| {
            (
                StatusCode::GATEWAY_TIMEOUT,
                Json(
                    json!({"error":"MCP request timed out; inspect the document before retrying"}),
                ),
            )
                .into_response()
        })
}

type Connection = (TlsStream<TcpStream>, SocketAddr);

struct TlsListener {
    listener: TcpListener,
    acceptor: TlsAcceptor,
    handshakes: JoinSet<Option<Connection>>,
}

impl Listener for TlsListener {
    type Io = TlsStream<TcpStream>;
    type Addr = SocketAddr;

    async fn accept(&mut self) -> Connection {
        loop {
            tokio::select! {
                result = self.handshakes.join_next(), if !self.handshakes.is_empty() => {
                    if let Some(Ok(Some(connection))) = result { return connection; }
                }
                (stream, addr) = Listener::accept(&mut self.listener), if self.handshakes.len() < 16 => {
                    let acceptor = self.acceptor.clone();
                    self.handshakes.spawn(async move {
                        let stream = tokio::time::timeout(Duration::from_secs(10), acceptor.accept(stream)).await.ok()?.ok()?;
                        Some((stream, addr))
                    });
                }
            }
        }
    }

    fn local_addr(&self) -> std::io::Result<Self::Addr> {
        self.listener.local_addr()
    }
}

fn read(path: &Path) -> Result<Option<Vec<u8>>> {
    match std::fs::read(path) {
        Ok(bytes) => {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
                    .map_err(io_error)?;
            }
            Ok(Some(bytes))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(io_error(error)),
    }
}

fn pem_encode(label: &str, bytes: &[u8]) -> String {
    let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
    let lines = encoded
        .as_bytes()
        .chunks(64)
        .map(|line| std::str::from_utf8(line).unwrap())
        .collect::<Vec<_>>()
        .join("\n");
    format!("-----BEGIN {label}-----\n{lines}\n-----END {label}-----\n")
}

fn tls_error(error: impl std::fmt::Display) -> EngineError {
    EngineError::new("mcp_https_unavailable", error.to_string())
}
