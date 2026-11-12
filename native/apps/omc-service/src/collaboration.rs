//! Native collaboration rooms expose only versioned replica exchange over pinned TLS.
mod assets;
use axum::{
    Json, Router,
    body::to_bytes,
    extract::{Request, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::post,
};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use omc_protocol::{EngineError, Result};
use omc_sync::{Action, RemoteTransaction, ReplicaPackage};
use omc_workspace::{Workspace, constant_time_equal, random_secret};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    net::{IpAddr, SocketAddr},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};
use tokio::{
    net::{TcpListener, TcpStream},
    sync::{Mutex as AsyncMutex, Semaphore},
    task::JoinHandle,
};
use tokio_rustls::{TlsAcceptor, server::TlsStream};

const MAX_WIRE: usize = 8 * 1024 * 1024;
const MAX_PEERS: usize = 3;
const INVITE_PREFIX: &str = "omc-native://join/";
const ROOM_VERSION: u8 = 1;

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Invitation {
    version: u8,
    address: SocketAddr,
    document_id: String,
    certificate: String,
    secret: String,
}

struct Peer {
    name: String,
    replica: Option<String>,
    cursor: Value,
    last_seen: Instant,
}

struct Room {
    workspace: Arc<Workspace>,
    document: String,
    epoch: String,
    replica: String,
    secret: String,
    name: String,
    cursor: Mutex<Value>,
    peers: Mutex<HashMap<String, Peer>>,
    reserved: Mutex<HashMap<String, Option<String>>>,
    active: AtomicBool,
    permits: Arc<Semaphore>,
}

struct Host {
    room: Arc<Room>,
    link: String,
    address: SocketAddr,
    task: JoinHandle<()>,
}

struct Guest {
    status: Arc<Mutex<Value>>,
    cursor: Arc<Mutex<Value>>,
    task: JoinHandle<()>,
    client: reqwest::Client,
    url: String,
    token: String,
}

pub struct Collaboration {
    workspace: Arc<Workspace>,
    hosts: AsyncMutex<HashMap<String, Host>>,
    guests: AsyncMutex<HashMap<String, Guest>>,
    departed: AsyncMutex<HashMap<String, (String, String)>>,
    lifecycle: AsyncMutex<()>,
}
impl Collaboration {
    pub fn new(workspace: Arc<Workspace>) -> Self {
        Self {
            workspace,
            hosts: AsyncMutex::default(),
            guests: AsyncMutex::default(),
            departed: AsyncMutex::default(),
            lifecycle: AsyncMutex::default(),
        }
    }

    pub async fn call(&self, session: &str, args: Value) -> Result<Value> {
        self.workspace.session(session)?;
        let action = super::string(&args, "action")?;
        let invitation = if action == "join" {
            Some(parse_invitation(super::string(&args, "invite")?)?)
        } else {
            None
        };
        let id = args["documentId"]
            .as_str()
            .or_else(|| {
                invitation
                    .as_ref()
                    .map(|invite| invite.document_id.as_str())
            })
            .ok_or_else(|| EngineError::invalid("documentId required"))?;
        let document = if omc_model::valid_id(id, "doc") {
            id.to_owned()
        } else {
            let id = uuid::Uuid::parse_str(id)
                .map_err(|_| EngineError::invalid("invalid document ID"))?;
            format!("doc_{}", id.simple())
        };
        let _lifecycle = self.lifecycle.lock().await;
        match action {
            "status" => {}
            "host" => self.host(&document, &args).await?,
            "join" => {
                let invitation = invitation.unwrap();
                if invitation.document_id != document {
                    return Err(EngineError::invalid(
                        "invitation is for a different document",
                    ));
                }
                self.join(session, invitation, name(&args)?).await?;
            }
            "invite" => {
                let hosts = self.hosts.lock().await;
                let host = hosts
                    .get(&document)
                    .ok_or_else(|| EngineError::invalid("host this document first"))?;
                if let Some(address) = args["address"].as_str()
                    && address != host.address.to_string()
                    && address != host.address.ip().to_string()
                {
                    return Err(EngineError::invalid(
                        "invitation address must match the hosted TLS interface",
                    ));
                }
                return Ok(
                    json!({"ok":true,"mode":"hosting","invite":host.link,"documentId":external(&document)}),
                );
            }
            "leave" => {
                if let Some(host) = self.hosts.lock().await.remove(&document) {
                    host.room.active.store(false, Ordering::Release);
                    host.task.abort();
                }
                if let Some(guest) = self.guests.lock().await.remove(&document) {
                    guest.task.abort();
                    let mut departed = self.departed.lock().await;
                    if departed.len() >= 16 {
                        departed.clear();
                    }
                    departed.insert(document.clone(), (guest.url.clone(), guest.token.clone()));
                    drop(departed);
                    let _ = peer_request(
                        &guest.client,
                        &guest.url,
                        &guest.token,
                        json!({"action":"leave"}),
                    )
                    .await;
                }
            }
            "cursor" => {
                let cursor = checked_cursor(&args["cursor"])?;
                if let Some(host) = self.hosts.lock().await.get(&document) {
                    *host.room.cursor.lock().unwrap() = cursor;
                } else if let Some(guest) = self.guests.lock().await.get(&document) {
                    *guest.cursor.lock().unwrap() = cursor;
                }
            }
            _ => return Err(EngineError::invalid("unknown collaboration action")),
        }
        if let Some(host) = self.hosts.lock().await.get(&document) {
            return Ok(
                json!({"ok":true,"mode":"hosting","documentId":external(&document),"participants":participants(&host.room, None),"capacity":4,"address":host.address,"port":host.address.port()}),
            );
        }
        if let Some(guest) = self.guests.lock().await.get(&document) {
            return Ok(guest.status.lock().unwrap().clone());
        }
        Ok(
            json!({"ok":true,"mode":"offline","documentId":external(&document),"participants":[],"capacity":4}),
        )
    }

    async fn host(&self, document: &str, args: &Value) -> Result<()> {
        if self.hosts.lock().await.contains_key(document) {
            return Ok(());
        }
        if self.guests.lock().await.contains_key(document) {
            return Err(EngineError::invalid(
                "leave this document's current room before hosting",
            ));
        }
        if self.hosts.lock().await.len() >= 4 {
            return Err(EngineError::new(
                "resource_limit",
                "at most four rooms may be hosted",
            ));
        }
        let ip: IpAddr = args["address"]
            .as_str()
            .unwrap_or("127.0.0.1")
            .parse()
            .map_err(|_| EngineError::invalid("enter a local IPv4 or IPv6 address"))?;
        if ip.is_unspecified() || ip.is_multicast() {
            return Err(EngineError::invalid(
                "choose a specific local interface address",
            ));
        }
        let port = args["port"]
            .as_u64()
            .unwrap_or(0)
            .try_into()
            .map_err(|_| EngineError::invalid("invalid collaboration port"))?;
        let local = metadata(self.workspace.clone(), document.into()).await?;
        let baseline = package(self.workspace.clone(), document.into()).await?;
        let reserved = baseline.0["transactions"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|tx| tx["replicaId"].as_str().map(|id| (id.to_owned(), None)))
            .collect();
        let display_name = name(args)?;
        let listener = TcpListener::bind(SocketAddr::new(ip, port))
            .await
            .map_err(network)?;
        let address = listener.local_addr().map_err(network)?;
        let rcgen::CertifiedKey { cert, signing_key } =
            rcgen::generate_simple_self_signed(vec![ip.to_string()]).map_err(network)?;
        let provider = rustls::crypto::aws_lc_rs::default_provider();
        let tls = rustls::ServerConfig::builder_with_provider(Arc::new(provider))
            .with_safe_default_protocol_versions()
            .map_err(network)?
            .with_no_client_auth()
            .with_single_cert(
                vec![cert.der().clone()],
                rustls::pki_types::PrivatePkcs8KeyDer::from(signing_key.serialize_der()).into(),
            )
            .map_err(network)?;
        let secret = random_secret();
        let link = format!(
            "{INVITE_PREFIX}{}",
            URL_SAFE_NO_PAD.encode(
                serde_json::to_vec(&Invitation {
                    version: ROOM_VERSION,
                    address,
                    document_id: document.into(),
                    certificate: URL_SAFE_NO_PAD.encode(cert.der()),
                    secret: secret.clone(),
                })
                .map_err(network)?
            )
        );
        let room = Arc::new(Room {
            workspace: self.workspace.clone(),
            document: document.into(),
            epoch: super::string(&local, "epoch")?.into(),
            replica: super::string(&local, "replicaId")?.into(),
            secret,
            name: display_name,
            cursor: Mutex::new(Value::Null),
            peers: Mutex::new(HashMap::new()),
            reserved: Mutex::new(reserved),
            active: AtomicBool::new(true),
            permits: Arc::new(Semaphore::new(4)),
        });
        let endpoint = Router::new()
            .route("/room", post(handle_peer))
            .with_state(room.clone());
        let task = tokio::spawn(async move {
            let _ = axum::serve(
                TlsListener {
                    listener,
                    acceptor: TlsAcceptor::from(Arc::new(tls)),
                },
                endpoint,
            )
            .await;
        });
        self.hosts.lock().await.insert(
            document.into(),
            Host {
                room,
                link,
                address,
                task,
            },
        );
        Ok(())
    }

    async fn join(&self, session: &str, invitation: Invitation, name: String) -> Result<()> {
        let id = invitation.document_id;
        if self.hosts.lock().await.contains_key(&id) || self.guests.lock().await.contains_key(&id) {
            return Err(EngineError::invalid(
                "this profile is already in a room for this document",
            ));
        }
        if self.guests.lock().await.len() >= 4 {
            return Err(EngineError::new(
                "resource_limit",
                "at most four rooms may be joined",
            ));
        }
        let certificate = URL_SAFE_NO_PAD
            .decode(&invitation.certificate)
            .map_err(|_| EngineError::invalid("invalid invitation certificate"))?;
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(8))
            .tls_certs_only([reqwest::Certificate::from_der(&certificate).map_err(network)?])
            .build()
            .map_err(network)?;
        let url = format!("https://{}/room", invitation.address);
        let resume = self
            .departed
            .lock()
            .await
            .get(&id)
            .filter(|(endpoint, _)| endpoint == &url)
            .map(|(_, token)| token.clone());
        let reply = peer_request(
            &client,
            &url,
            &invitation.secret,
            json!({"action":"join","name":name,"resume":resume}),
        )
        .await?;
        let token = super::string(&reply, "token")?.to_owned();
        let setup: Result<(String, u64)> = async {
            let encoded = reply["package"].clone();
            let transfers = serde_json::from_value(reply["assets"].clone()).map_err(network)?;
            let package: ReplicaPackage =
                serde_json::from_value(encoded.clone()).map_err(network)?;
            if package.document_id != id {
                return Err(EngineError::invalid(
                    "invitation and replica identity differ",
                ));
            }
            let since = 0; // Replay also catches up an existing local replica.
            let workspace = self.workspace.clone();
            let session = session.to_owned();
            let document = id.clone();
            let replica = blocking(move || {
                if let Ok(existing) = workspace.metadata(&document) {
                    if existing["epoch"] != package.epoch {
                        return Err(EngineError::new(
                            "epoch_mismatch",
                            "a different local copy already uses this document ID",
                        ));
                    }
                    assets::install(&workspace.profile, &encoded, transfers)?;
                    workspace.bind(&session, &document)?;
                } else {
                    assets::install(&workspace.profile, &encoded, transfers)?;
                    workspace.fork_replica(&session, package)?;
                }
                let value = workspace.metadata(&document)?;
                Ok(super::string(&value, "replicaId")?.to_owned())
            })
            .await?;
            Ok((replica, since))
        }
        .await;
        let (replica, since) = match setup {
            Ok(setup) => setup,
            Err(error) => {
                let _ = peer_request(&client, &url, &token, json!({"action":"leave"})).await;
                return Err(error);
            }
        };
        let initial = json!({"ok":true,"mode":"connected","documentId":external(&id),"participants":reply["participants"],"capacity":4});
        let status = Arc::new(Mutex::new(initial));
        let cursor = Arc::new(Mutex::new(Value::Null));
        let task = tokio::spawn(exchange(Exchange {
            client: client.clone(),
            url: url.clone(),
            token: token.clone(),
            workspace: self.workspace.clone(),
            document: id.clone(),
            replica,
            status: status.clone(),
            cursor: cursor.clone(),
            since,
        }));
        self.departed.lock().await.remove(&id);
        self.guests.lock().await.insert(
            id,
            Guest {
                status,
                cursor,
                task,
                client,
                url,
                token,
            },
        );
        Ok(())
    }
}

struct TlsListener {
    listener: TcpListener,
    acceptor: TlsAcceptor,
}
impl axum::serve::Listener for TlsListener {
    type Io = TlsStream<TcpStream>;
    type Addr = SocketAddr;
    async fn accept(&mut self) -> (Self::Io, Self::Addr) {
        loop {
            let (stream, address) = axum::serve::Listener::accept(&mut self.listener).await;
            if let Ok(Ok(stream)) =
                tokio::time::timeout(Duration::from_secs(2), self.acceptor.accept(stream)).await
            {
                return (stream, address);
            }
        }
    }
    fn local_addr(&self) -> std::io::Result<Self::Addr> {
        self.listener.local_addr()
    }
}

async fn handle_peer(State(room): State<Arc<Room>>, request: Request) -> Response {
    if !room.active.load(Ordering::Acquire) {
        return StatusCode::GONE.into_response();
    }
    let headers = request.headers();
    let Some(token) = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .filter(|v| v.len() == room.secret.len())
        .map(str::to_owned)
    else {
        return StatusCode::UNAUTHORIZED.into_response();
    };
    let admitted = constant_time_equal(token.as_bytes(), room.secret.as_bytes())
        || room
            .peers
            .lock()
            .unwrap()
            .keys()
            .any(|known| constant_time_equal(known.as_bytes(), token.as_bytes()));
    if !admitted {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let Ok(_permit) = room.permits.clone().try_acquire_owned() else {
        return StatusCode::TOO_MANY_REQUESTS.into_response();
    };
    let result = async {
        let body = tokio::time::timeout(Duration::from_secs(5),to_bytes(request.into_body(), MAX_WIRE))
            .await.map_err(network)?.map_err(network)?;
        let args = omc_protocol::decode_json_with_limit(&body, MAX_WIRE)?;
        let action = super::string(&args,"action")?;
        if action == "join" && constant_time_equal(token.as_bytes(), room.secret.as_bytes()) {
            let peer_name = name(&args)?;
            let (package, assets) = package(room.workspace.clone(), room.document.clone()).await?;
            let mut token = random_secret();
            {
                let mut peers = room.peers.lock().unwrap();
                let mut replica = None;
                if let Some(resume) = args["resume"].as_str() {
                    replica = room.reserved.lock().unwrap().iter().find_map(|(id,key)| {
                        key.as_ref().filter(|key| constant_time_equal(key.as_bytes(),resume.as_bytes())).map(|_|id.clone())
                    });
                    if replica.is_some() {
                        token = resume.into();
                        peers.remove(&token);
                    }
                }
                peers.retain(|_,p| p.last_seen.elapsed()<Duration::from_secs(120));
                if peers.len() >= MAX_PEERS {
                    return Err(EngineError::new("room_full","the room already has four people"));
                }
                peers.insert(token.clone(),Peer {name:peer_name,replica,cursor:Value::Null,last_seen:Instant::now()});
            }
            return Ok(json!({"token":token,"package":package,"assets":assets,"participants":participants(&room, Some(&token))}));
        }
        if action == "leave" {
            if room.peers.lock().unwrap().remove(&token).is_none() { return Err(denied()); }
            return Ok(json!({"ok":true}));
        }
        if action != "sync" { return Err(denied()); }
        let replica = super::string(&args,"replica")?.to_owned();
        if uuid::Uuid::parse_str(&replica).is_err() || replica == room.replica {
            return Err(denied());
        }
        let since = args["since"].as_u64().ok_or_else(|| EngineError::invalid("invalid sync cursor"))?;
        let outgoing: Vec<RemoteTransaction> = serde_json::from_value(args["transactions"].clone())
            .map_err(|_| EngineError::invalid("invalid replica transactions"))?;
        if outgoing.len()>100 || outgoing.iter().any(|tx| tx.replica_id!=replica || tx.document_id!=room.document || tx.epoch!=room.epoch ||
            tx.operations.iter().any(|operation| matches!(&operation.action,
                Action::Retract {operation_id,..} if operation_id.split_once(':').is_none_or(|(origin,_)|origin!=replica)
            )))
        {
            return Err(denied());
        }
        {
            let mut peers = room.peers.lock().unwrap();
            if peers.iter().any(|(key,p)| key!=&token && p.replica.as_deref()==Some(&replica)) {
                return Err(denied());
            }
            let peer = peers.get_mut(&token).ok_or_else(denied)?;
            if peer.replica.as_ref().is_some_and(|known| known!=&replica) {
                return Err(denied());
            }
            if peer.replica.is_none() {
                let mut reserved = room.reserved.lock().unwrap();
                if reserved.contains_key(&replica) {
                    return Err(denied());
                }
                if reserved.len() >= 4096 {
                    return Err(EngineError::new("resource_limit", "room replica history is full"));
                }
                reserved.insert(replica.clone(),Some(token.clone()));
            }
            peer.replica = Some(replica);
            peer.cursor = checked_cursor(&args["cursor"])?;
            peer.last_seen = Instant::now();
        }
        for transaction in &outgoing {
            transaction.validate()?;
        }
        let transferred = serde_json::from_value(args["assets"].clone()).map_err(network)?;
        let ws = room.workspace.clone();
        let document = room.document.clone();
        let (incoming, returned_assets) = blocking(move || {
            let path = ws.document_path(&document)?;
            assets::install(&ws.profile,&args["transactions"],transferred)?;
            for transaction in outgoing {
                ws.workers.call(&path,"receive_transaction",json!({"transaction":transaction}))?;
            }
            let value = ws.workers.call(&path,"export_transactions",json!({"afterSequence":since}))?;
            let returned_assets = assets::collect(&ws.profile,&value)?;
            Ok((value,returned_assets))
        }).await?;
        Ok(json!({"transactions":incoming,"assets":returned_assets,"participants":participants(&room, Some(&token))}))
    }.await;
    let value = match result {
        Ok(value) => value,
        Err(error) => json!({"error":error}),
    };
    match serde_json::to_vec(&value) {
        Ok(bytes) if bytes.len() <= MAX_WIRE => ([(axum::http::header::CONTENT_TYPE,"application/json")],bytes).into_response(),
        _ => Json(json!({"error":{"code":"resource_limit","message":"room transfer exceeds the 8 MiB preview limit"}})).into_response(),
    }
}

struct Exchange {
    client: reqwest::Client,
    url: String,
    token: String,
    workspace: Arc<Workspace>,
    document: String,
    replica: String,
    status: Arc<Mutex<Value>>,
    cursor: Arc<Mutex<Value>>,
    since: u64,
}
async fn exchange(mut exchange: Exchange) {
    let mut local_since = 0u64;
    loop {
        let result = exchange_once(&mut exchange, &mut local_since).await;
        let delay = if result.is_ok() { 250 } else { 1000 };
        if let Err(error) = result {
            let mut status = exchange.status.lock().unwrap();
            status["mode"] = "reconnecting".into();
            status["message"] = error.message.into();
        }
        tokio::time::sleep(Duration::from_millis(delay)).await;
    }
}
async fn exchange_once(exchange: &mut Exchange, local_since: &mut u64) -> Result<()> {
    let workspace = exchange.workspace.clone();
    let document = exchange.document.clone();
    let after = *local_since;
    let transactions = blocking(move || {
        let path = workspace.document_path(&document)?;
        workspace
            .workers
            .call(&path, "export_transactions", json!({"afterSequence":after}))
    })
    .await?;
    let list = transactions
        .as_array()
        .ok_or_else(|| EngineError::invalid("invalid local transaction stream"))?;
    let count = list.len().min(100);
    let outgoing = json!(
        list.iter()
            .take(count)
            .filter(|tx| tx["replicaId"] == exchange.replica)
            .collect::<Vec<_>>()
    );
    let workspace = exchange.workspace.clone();
    let (outgoing, attached) = blocking(move || {
        let attached = assets::collect(&workspace.profile, &outgoing)?;
        Ok((outgoing, attached))
    })
    .await?;
    let cursor = exchange.cursor.lock().unwrap().clone();
    let reply = peer_request(
        &exchange.client, &exchange.url, &exchange.token,
        json!({"action":"sync","since":exchange.since,"replica":exchange.replica,"transactions":outgoing,"assets":attached,"cursor":cursor}),
    ).await?;
    let incoming = reply["transactions"]
        .as_array()
        .ok_or_else(|| EngineError::invalid("invalid peer transaction stream"))?;
    let count_in = incoming.len() as u64;
    let participants = reply["participants"].clone();
    let transfers = serde_json::from_value(reply["assets"].clone()).map_err(network)?;
    let workspace = exchange.workspace.clone();
    let document = exchange.document.clone();
    blocking(move || {
        let path = workspace.document_path(&document)?;
        assets::install(&workspace.profile, &reply["transactions"], transfers)?;
        for transaction in reply["transactions"].as_array().unwrap() {
            workspace.workers.call(
                &path,
                "receive_transaction",
                json!({"transaction":transaction}),
            )?;
        }
        Ok(())
    })
    .await?;
    *local_since += count as u64;
    exchange.since += count_in;
    *exchange.status.lock().unwrap() = json!({"ok":true,"mode":"connected","documentId":external(&exchange.document),"participants":participants,"capacity":4});
    Ok(())
}

async fn peer_request(
    client: &reqwest::Client,
    url: &str,
    token: &str,
    args: Value,
) -> Result<Value> {
    let bytes = serde_json::to_vec(&args).map_err(network)?;
    if bytes.len() > MAX_WIRE {
        return Err(EngineError::new(
            "resource_limit",
            "room request is too large",
        ));
    }
    let mut response = client
        .post(url)
        .bearer_auth(token)
        .header("content-type", "application/json")
        .body(bytes)
        .send()
        .await
        .map_err(network)?
        .error_for_status()
        .map_err(network)?;
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(network)? {
        if bytes.len() + chunk.len() > MAX_WIRE {
            return Err(EngineError::new(
                "resource_limit",
                "room response is too large",
            ));
        }
        bytes.extend_from_slice(&chunk);
    }
    let reply = omc_protocol::decode_json_with_limit(&bytes, MAX_WIRE)?;
    if let Some(error) = reply.get("error") {
        return Err(serde_json::from_value(error.clone())
            .unwrap_or_else(|_| EngineError::invalid("invalid peer error")));
    }
    Ok(reply)
}

fn parse_invitation(link: &str) -> Result<Invitation> {
    let payload = link
        .strip_prefix(INVITE_PREFIX)
        .filter(|payload| payload.len() <= 12000)
        .ok_or_else(|| EngineError::invalid("a native OMC invitation is required"))?;
    let bytes = URL_SAFE_NO_PAD
        .decode(payload)
        .map_err(|_| EngineError::invalid("invalid native invitation"))?;
    let invite: Invitation = serde_json::from_slice(&bytes)
        .map_err(|_| EngineError::invalid("invalid native invitation"))?;
    if invite.version != ROOM_VERSION
        || !omc_model::valid_id(&invite.document_id, "doc")
        || invite.address.port() == 0
        || invite.address.ip().is_unspecified()
        || invite.address.ip().is_multicast()
        || invite.secret.len() != random_secret().len()
    {
        return Err(EngineError::invalid("unsupported native invitation"));
    }
    Ok(invite)
}

fn participants(room: &Room, local: Option<&str>) -> Value {
    let mut peers = room.peers.lock().unwrap();
    peers.retain(|_, p| p.last_seen.elapsed() < Duration::from_secs(120));
    let mut result = vec![
        json!({"name":room.name,"host":true,"isSelf":local.is_none(),"cursor":*room.cursor.lock().unwrap()}),
    ];
    result.extend(peers.iter().map(|(key,p)| {
        json!({"name":p.name,"host":false,"isSelf":local.is_some_and(|local|local==key),"cursor":p.cursor})
    }));
    json!(result)
}

fn checked_cursor(value: &Value) -> Result<Value> {
    if value.is_null() {
        return Ok(Value::Null);
    }
    if !value["x"].is_number()
        || !value["y"].is_number()
        || !value["page"].as_str().is_some_and(|s| s.len() <= 200)
        || serde_json::to_vec(value).map_err(network)?.len() > 8192
    {
        return Err(EngineError::invalid("invalid cursor payload"));
    }
    Ok(value.clone())
}

fn name(args: &Value) -> Result<String> {
    let name = args["name"].as_str().unwrap_or("Designer").trim();
    if name.is_empty() || name.chars().count() > 40 || name.chars().any(char::is_control) {
        return Err(EngineError::invalid(
            "name must be between 1 and 40 characters",
        ));
    }
    Ok(name.into())
}
fn external(id: &str) -> String {
    id.strip_prefix("doc_")
        .and_then(|id| uuid::Uuid::parse_str(id).ok())
        .map_or_else(|| id.into(), |id| id.to_string())
}
fn denied() -> EngineError {
    EngineError::new(
        "authentication_failed",
        "invalid room or replica credential",
    )
}
fn network(error: impl std::fmt::Display) -> EngineError {
    EngineError::new("collaboration_error", error.to_string())
}
async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T> + Send + 'static,
) -> Result<T> {
    tokio::task::spawn_blocking(work).await.map_err(network)?
}
async fn metadata(workspace: Arc<Workspace>, id: String) -> Result<Value> {
    blocking(move || workspace.metadata(&id)).await
}
async fn package(workspace: Arc<Workspace>, id: String) -> Result<(Value, Vec<assets::Packet>)> {
    blocking(move || {
        let path = workspace.document_path(&id)?;
        let package = workspace
            .workers
            .call(&path, "replica_package", json!({}))?;
        let assets = assets::collect(&workspace.profile, &package)?;
        if serde_json::to_vec(&(&package, &assets))
            .map_err(network)?
            .len()
            > MAX_WIRE - 32 * 1024
        {
            return Err(EngineError::new(
                "resource_limit",
                "document history and assets exceed the 8 MiB collaboration preview limit",
            ));
        }
        Ok((package, assets))
    })
    .await
}
