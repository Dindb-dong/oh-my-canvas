//! Native collaboration rooms expose only versioned replica exchange over pinned TLS.
mod assets;
use axum::{
    Json, Router,
    body::to_bytes,
    extract::{ConnectInfo, Request, State, connect_info::Connected},
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
    collections::{HashMap, HashSet},
    net::{IpAddr, SocketAddr},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};
use tokio::{
    net::{TcpListener, TcpStream},
    sync::{Mutex as AsyncMutex, Notify, Semaphore},
    task::JoinHandle,
};
use tokio_rustls::{TlsAcceptor, server::TlsStream};

const MAX_WIRE: usize = 8 * 1024 * 1024;
const MAX_PEERS: usize = 3;
use omc_model::LOCAL_INVITATION_PREFIX;
const ROOM_VERSION: u8 = 1;
type Chat = Option<(String, Instant)>;

#[derive(Default)]
struct ViewPresence {
    viewport: Value,
    follow: Option<String>,
    spotlighting: bool,
}

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
    id: String,
    address: IpAddr,
    name: String,
    replica: Option<String>,
    cursor: Value,
    chat: Chat,
    read_only: bool,
    viewport: Value,
    spotlighting: bool,
    last_seen: Instant,
}

struct Room {
    workspace: Arc<Workspace>,
    document: String,
    epoch: String,
    replica: String,
    secret: String,
    view_secret: String,
    name: Mutex<String>,
    cursor: Mutex<Value>,
    chat: Mutex<Chat>,
    view: Mutex<ViewPresence>,
    peers: Mutex<HashMap<String, Peer>>,
    excluded: Mutex<HashSet<IpAddr>>,
    reserved: Mutex<HashMap<String, Option<String>>>,
    active: AtomicBool,
    permits: Arc<Semaphore>,
}

struct Host {
    room: Arc<Room>,
    link: String,
    view_link: String,
    sharing: Option<bool>,
    address: SocketAddr,
    task: JoinHandle<()>,
}

struct Guest {
    rename: Arc<Mutex<Option<String>>>,
    status: Arc<Mutex<Value>>,
    cursor: Arc<Mutex<Value>>,
    chat: Arc<Mutex<Chat>>,
    view: Arc<Mutex<ViewPresence>>,
    reconnect: Arc<Notify>,
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

    pub async fn has_room(&self, document: &str) -> bool {
        self.hosts.lock().await.contains_key(document) || self.guests.lock().await.contains_key(document)
    }

    pub async fn rename_local_participant(&self) {
        let _lifecycle = self.lifecycle.lock().await;
        let name = self.workspace.preferences().user_name;
        if name.is_empty() || name == "You" {
            return;
        }
        for host in self.hosts.lock().await.values() {
            *host.room.name.lock().unwrap() = name.clone();
        }
        for guest in self.guests.lock().await.values() {
            *guest.rename.lock().unwrap() = Some(name.clone());
            guest.reconnect.notify_one();
        }
    }

    fn profile_name(&self, args: &Value, fallback: &str) -> Result<String> {
        if args.get("name").is_some() {
            return name(args);
        }
        let name = self.workspace.preferences().user_name;
        Ok(if name.is_empty() || name == "You" {fallback.into()} else {name})
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
            "reconnect" => {
                let guests = self.guests.lock().await;
                let guest = guests
                    .get(&document)
                    .filter(|guest| guest.status.lock().unwrap()["mode"] == "reconnecting")
                    .ok_or_else(|| {
                        EngineError::invalid("the document has no disconnected guest session")
                    })?;
                guest.reconnect.notify_one();
            }
            "removePerson" => {
                let client = super::string(&args, "client")?;
                let hosts = self.hosts.lock().await;
                let host = hosts.get(&document).ok_or_else(|| {
                    EngineError::invalid("only the room host can remove a participant")
                })?;
                let mut excluded = host.room.excluded.lock().unwrap();
                let mut peers = host.room.peers.lock().unwrap();
                let target = peers
                    .values()
                    .find(|peer| peer.id == client)
                    .map(|peer| (peer.address, peer.name.clone()));
                let Some((address, name)) = target else {
                    return Ok(json!({"removed":false,"name":null}));
                };
                if excluded.len() >= 4096 && !excluded.contains(&address) {
                    return Err(EngineError::new(
                        "resource_limit",
                        "room exclusion list is full",
                    ));
                }
                excluded.insert(address);
                peers.retain(|_, peer| peer.id != client);
                return Ok(json!({"removed":true,"name":name}));
            }
            "host" => self.host(&document, &args).await?,
            "share" => {
                self.host(&document, &args).await?;
                let mut hosts = self.hosts.lock().await;
                let host = hosts
                    .get_mut(&document)
                    .ok_or_else(|| EngineError::invalid("room did not start"))?;
                host.sharing = Some(args["viewOnly"] == true);
            }
            "join" => {
                let invitation = invitation.unwrap();
                if invitation.document_id != document {
                    return Err(EngineError::invalid(
                        "invitation is for a different document",
                    ));
                }
                self.join(session, invitation, self.profile_name(&args, "")?).await?;
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
                    self.workspace.set_room_read_only(&document, false);
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
                let viewport = args.get("viewport").map(checked_viewport).transpose()?;
                if let Some(host) = self.hosts.lock().await.get(&document) {
                    *host.room.cursor.lock().unwrap() = cursor;
                    if let Some(viewport) = viewport {
                        host.room.view.lock().unwrap().viewport = viewport;
                    }
                } else if let Some(guest) = self.guests.lock().await.get(&document) {
                    *guest.cursor.lock().unwrap() = cursor;
                    if let Some(viewport) = viewport {
                        guest.view.lock().unwrap().viewport = viewport;
                    }
                }
            }
            "follow" | "spotlight" => {
                if let Some(host) = self.hosts.lock().await.get(&document) {
                    let people = participants(&host.room, None);
                    return update_presence(
                        &mut host.room.view.lock().unwrap(),
                        &people,
                        action,
                        &args,
                    );
                }
                if let Some(guest) = self.guests.lock().await.get(&document) {
                    let people = guest.status.lock().unwrap()["participants"].clone();
                    let result =
                        update_presence(&mut guest.view.lock().unwrap(), &people, action, &args);
                    guest.reconnect.notify_one();
                    return result;
                }
                return Err(EngineError::invalid("this document has no live room"));
            }
            "chat" => {
                let text = checked_chat(&args["text"])?;
                let chat = text.as_ref().map(|text| (text.clone(), Instant::now()));
                if let Some(host) = self.hosts.lock().await.get(&document) {
                    *host.room.chat.lock().unwrap() = chat;
                } else if let Some(guest) = self.guests.lock().await.get(&document) {
                    *guest.chat.lock().unwrap() = chat;
                    guest.reconnect.notify_one();
                } else {
                    return Err(EngineError::invalid("cursor chat requires a live room"));
                }
                return Ok(json!({"chat":text}));
            }
            _ => return Err(EngineError::invalid("unknown collaboration action")),
        }
        if let Some(host) = self.hosts.lock().await.get(&document) {
            let mut result = json!({"ok":true,"mode":"hosting","documentId":external(&document),"participants":participants(&host.room, None),"capacity":4,"address":host.address,"port":host.address.port()});
            decorate_presence(&mut result, &host.room.view.lock().unwrap());
            if let Some(read_only) = host.sharing {
                let link = if read_only {
                    &host.view_link
                } else {
                    &host.link
                };
                result["link"] = json!(link);
                result["url"] = json!(link);
                result["code"] = json!(link);
                result["share"] = json!({"via":"local","shared":true,"access":if read_only {"view"} else {"edit"},
                    "editCode":host.link,"editLink":host.link,"viewCode":host.view_link,"viewLink":host.view_link,
                    "commentCode":null,"commentLink":null});
            }
            return Ok(result);
        }
        if let Some(guest) = self.guests.lock().await.get(&document) {
            let mut result = guest.status.lock().unwrap().clone();
            decorate_presence(&mut result, &guest.view.lock().unwrap());
            return Ok(result);
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
        let display_name = self.profile_name(args, "Guest 1")?;
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
        let view_secret = random_secret();
        let invitation = |secret: &str| -> Result<String> {
            Ok(format!(
                "{LOCAL_INVITATION_PREFIX}{}",
                URL_SAFE_NO_PAD.encode(
                    serde_json::to_vec(&Invitation {
                        version: ROOM_VERSION,
                        address,
                        document_id: document.into(),
                        certificate: URL_SAFE_NO_PAD.encode(cert.der()),
                        secret: secret.to_owned(),
                    })
                    .map_err(network)?
                )
            ))
        };
        let link = invitation(&secret)?;
        let view_link = invitation(&view_secret)?;
        let room = Arc::new(Room {
            workspace: self.workspace.clone(),
            document: document.into(),
            epoch: super::string(&local, "epoch")?.into(),
            replica: super::string(&local, "replicaId")?.into(),
            secret,
            view_secret,
            name: Mutex::new(display_name),
            cursor: Mutex::new(Value::Null),
            chat: Mutex::new(None),
            view: Mutex::new(ViewPresence::default()),
            peers: Mutex::new(HashMap::new()),
            excluded: Mutex::new(HashSet::new()),
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
                endpoint.into_make_service_with_connect_info::<RoomAddress>(),
            )
            .await;
        });
        self.hosts.lock().await.insert(
            document.into(),
            Host {
                room,
                link,
                view_link,
                sharing: None,
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
        let read_only = reply["readOnly"] == true;
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
        self.workspace.set_room_read_only(&id, read_only);
        let initial = json!({"ok":true,"mode":"connected","documentId":external(&id),"participants":reply["participants"],"capacity":4,"readOnly":read_only});
        let status = Arc::new(Mutex::new(initial));
        let cursor = Arc::new(Mutex::new(Value::Null));
        let chat = Arc::new(Mutex::new(None));
        let view = Arc::new(Mutex::new(ViewPresence::default()));
        let reconnect = Arc::new(Notify::new());
        let rename = Arc::new(Mutex::new(None));
        let task = tokio::spawn(exchange(Exchange {
            rename: rename.clone(),
            client: client.clone(),
            url: url.clone(),
            token: token.clone(),
            workspace: self.workspace.clone(),
            document: id.clone(),
            replica,
            status: status.clone(),
            cursor: cursor.clone(),
            chat: chat.clone(),
            view: view.clone(),
            reconnect: reconnect.clone(),
            since,
            read_only,
        }));
        self.departed.lock().await.remove(&id);
        self.guests.lock().await.insert(
            id,
            Guest {
                rename,
                status,
                cursor,
                chat,
                view,
                reconnect,
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

#[derive(Clone, Copy)]
struct RoomAddress(IpAddr);
impl Connected<axum::serve::IncomingStream<'_, TlsListener>> for RoomAddress {
    fn connect_info(stream: axum::serve::IncomingStream<'_, TlsListener>) -> Self {
        Self(stream.remote_addr().ip())
    }
}

async fn handle_peer(
    State(room): State<Arc<Room>>,
    ConnectInfo(RoomAddress(address)): ConnectInfo<RoomAddress>,
    request: Request,
) -> Response {
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
    let edit_invite = constant_time_equal(token.as_bytes(), room.secret.as_bytes());
    let view_invite = constant_time_equal(token.as_bytes(), room.view_secret.as_bytes());
    let admitted = edit_invite
        || view_invite
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
        if action == "join" && (edit_invite || view_invite) {
            let peer_name = if args["name"] == "" { None } else { Some(name(&args)?) };
            let (package, assets) = package(room.workspace.clone(), room.document.clone()).await?;
            let mut token = random_secret();
            {
                let excluded = room.excluded.lock().unwrap();
                if excluded.contains(&address) { return Err(denied()); }
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
                let peer_name = peer_name.unwrap_or_else(|| (2..=MAX_PEERS + 1)
                    .map(|n| format!("Guest {n}"))
                    .find(|name| !peers.values().any(|peer| peer.name == *name))
                    .unwrap_or_else(|| "Guest".into()));
                peers.insert(token.clone(),Peer {id:uuid::Uuid::new_v4().to_string(),address,name:peer_name,replica,cursor:Value::Null,chat:None,read_only:view_invite,viewport:Value::Null,spotlighting:false,last_seen:Instant::now()});
            }
            return Ok(json!({"token":token,"package":package,"assets":assets,"participants":participants(&room, Some(&token)),"readOnly":view_invite}));
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
        let chat = checked_chat(&args["chat"])?;
        let viewport = checked_viewport(&args["viewport"])?;
        let rename = if args["name"].is_null() { None } else { Some(name(&args)?) };
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
            if peer.read_only && !outgoing.is_empty() { return Err(denied()); }
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
            peer.address = address;
            if let Some(name) = rename { peer.name = name; }
            peer.cursor = checked_cursor(&args["cursor"])?;
            peer.chat = chat.map(|text|(text,Instant::now()));
            peer.viewport = viewport;
            peer.spotlighting = args["spotlighting"] == true;
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
            let received = !outgoing.is_empty();
            for transaction in outgoing {
                ws.workers.call(&path,"receive_transaction",json!({"transaction":transaction}))?;
            }
            if received { ws.schedule_automatic_checkpoint(&document); }
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
    rename: Arc<Mutex<Option<String>>>,
    client: reqwest::Client,
    url: String,
    token: String,
    workspace: Arc<Workspace>,
    document: String,
    replica: String,
    status: Arc<Mutex<Value>>,
    cursor: Arc<Mutex<Value>>,
    chat: Arc<Mutex<Chat>>,
    view: Arc<Mutex<ViewPresence>>,
    reconnect: Arc<Notify>,
    since: u64,
    read_only: bool,
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
            if let Some(participants) = status["participants"].as_array_mut() {
                for participant in participants.iter_mut().filter_map(Value::as_object_mut) {
                    participant.remove("chat");
                }
            }
        }
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_millis(delay)) => {},
            _ = exchange.reconnect.notified() => {},
        }
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
            .filter(|tx| !exchange.read_only && tx["replicaId"] == exchange.replica)
            .collect::<Vec<_>>()
    );
    let workspace = exchange.workspace.clone();
    let (outgoing, attached) = blocking(move || {
        let attached = assets::collect(&workspace.profile, &outgoing)?;
        Ok((outgoing, attached))
    })
    .await?;
    let cursor = exchange.cursor.lock().unwrap().clone();
    let chat = active_chat(&exchange.chat.lock().unwrap()).map(str::to_owned);
    let (viewport, spotlighting) = {
        let view = exchange.view.lock().unwrap();
        (view.viewport.clone(), view.spotlighting)
    };
    let name = exchange.rename.lock().unwrap().clone();
    let reply = peer_request(
        &exchange.client, &exchange.url, &exchange.token,
        json!({"action":"sync","since":exchange.since,"replica":exchange.replica,"transactions":outgoing,"assets":attached,"cursor":cursor,"chat":chat,"viewport":viewport,"spotlighting":spotlighting,"name":name}),
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
        if count_in > 0 {
            workspace.schedule_automatic_checkpoint(&document);
        }
        Ok(())
    })
    .await?;
    *local_since += count as u64;
    exchange.since += count_in;
    *exchange.status.lock().unwrap() = json!({"ok":true,"mode":"connected","documentId":external(&exchange.document),"participants":participants,"capacity":4,"readOnly":exchange.read_only});
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
    let payload = omc_model::local_invitation_payload(link)
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
    let view = room.view.lock().unwrap();
    let mut result = vec![
        json!({"id":room.replica,"name":*room.name.lock().unwrap(),"host":true,"isSelf":local.is_none(),"cursor":*room.cursor.lock().unwrap(),"chat":active_chat(&room.chat.lock().unwrap()),"spotlighting":view.spotlighting,"presence":{"viewport":view.viewport}}),
    ];
    result.extend(peers.iter().map(|(key,p)| {
        json!({"id":p.id,"name":p.name,"host":false,"isSelf":local.is_some_and(|local|local==key),"cursor":p.cursor,"chat":active_chat(&p.chat),"spotlighting":p.spotlighting,"presence":{"viewport":p.viewport}})
    }));
    json!(result)
}

fn checked_viewport(value: &Value) -> Result<Value> {
    if value.is_null() {
        return Ok(Value::Null);
    }
    let values = value
        .as_array()
        .filter(|values| values.len() == 5)
        .ok_or_else(|| {
            EngineError::invalid("viewport must contain page, x, y, width and height")
        })?;
    if !values[0]
        .as_str()
        .is_some_and(|id| omc_model::valid_id(id, "page"))
        || values[1..].iter().any(|value| {
            !value
                .as_f64()
                .is_some_and(|value| value.is_finite() && value.abs() <= 1e9)
        })
        || values[3].as_f64().unwrap_or(0.) <= 0.
        || values[4].as_f64().unwrap_or(0.) <= 0.
    {
        return Err(EngineError::invalid("invalid collaboration viewport"));
    }
    Ok(value.clone())
}

fn update_presence(
    view: &mut ViewPresence,
    peers: &Value,
    action: &str,
    args: &Value,
) -> Result<Value> {
    if action == "spotlight" {
        view.spotlighting = args["on"].as_bool().unwrap_or(!view.spotlighting);
        if view.spotlighting {
            view.follow = None;
        }
        return Ok(json!({"spotlighting":view.spotlighting}));
    }
    let next = args["client"].as_str();
    if let Some(id) = next
        && !peers
            .as_array()
            .into_iter()
            .flatten()
            .any(|peer| peer["id"] == id && peer["isSelf"] != true)
    {
        return Err(EngineError::invalid("the peer is not in this room"));
    }
    view.follow = next.map(str::to_owned);
    if view.follow.is_some() {
        view.spotlighting = false;
    }
    Ok(json!({"follow":view.follow}))
}

fn decorate_presence(status: &mut Value, view: &ViewPresence) {
    status["follow"] = json!(view.follow);
    status["spotlighting"] = json!(view.spotlighting);
}

fn active_chat(chat: &Chat) -> Option<&str> {
    chat.as_ref()
        .filter(|(_, start)| start.elapsed() < Duration::from_secs(5))
        .map(|(text, _)| text.as_str())
}

fn checked_chat(value: &Value) -> Result<Option<String>> {
    if value.is_null() {
        return Ok(None);
    }
    let text = value
        .as_str()
        .filter(|text| text.chars().count() <= 100 && !text.chars().any(char::is_control))
        .ok_or_else(|| EngineError::invalid("chat must be at most 100 characters on one line"))?;
    Ok((!text.is_empty()).then(|| text.to_owned()))
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
    let name = args.get("name")
        .map_or(Some("Designer"), Value::as_str)
        .ok_or_else(|| EngineError::invalid("name must be text"))?
        .trim();
    if name.is_empty() || name.chars().count() > omc_workspace::PROFILE_NAME_LIMIT || name.chars().any(char::is_control) {
        return Err(EngineError::invalid(
            format!("name must be between 1 and {} characters", omc_workspace::PROFILE_NAME_LIMIT),
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

fn figcraft_bind(value: &str) -> Result<String> {
    match value {
        "local" => Ok("127.0.0.1".into()),
        "lan" => {
            // Connecting a UDP socket resolves the local route without sending a packet.
            let route = std::net::UdpSocket::bind("0.0.0.0:0").map_err(network)?;
            route.connect("192.0.2.1:9").map_err(network)?;
            let ip = route.local_addr().map_err(network)?.ip();
            if ip.is_loopback() || ip.is_unspecified() {
                return Err(EngineError::invalid("no usable LAN address"));
            }
            Ok(ip.to_string())
        }
        address => Ok(address.to_owned()),
    }
}

pub async fn figcraft_command(
    app: &super::App,
    session: &str,
    command: &str,
    args: Value,
) -> Result<Value> {
    omc_mcp::validate_figcraft_tool("run_command", &args)?;
    let empty = json!({});
    let params = args.get("params").unwrap_or(&empty);
    let properties = match command {
        "collab.host" => {
            json!({"port":{"type":"integer","minimum":1,"maximum":65535},"bind":{"type":"string"}})
        }
        "collab.share" => json!({"via":{"type":"string","enum":["local","online"]},
            "access":{"type":"string","enum":["edit","view","comment"]},"port":{"type":"integer","minimum":1,"maximum":65535},
            "bind":{"type":"string"},"server":{"type":"string"},"key":{"type":"string"},"name":{"type":"string"}}),
        "collab.join" => {
            json!({"link":{"type":"string","maxLength":32768},"code":{"type":"string","maxLength":32768}})
        }
        "collab.cursor" => json!({"x":{"type":"number"},"y":{"type":"number"}}),
        "collab.cursorChat" => json!({"text":{"type":"string","maxLength":100}}),
        "collab.follow" => json!({"client":{"type":"string","maxLength":100}}),
        "collab.spotlight" => json!({"on":{"type":"boolean"}}),
        "collab.removePerson" => json!({"client":{"type":"string","minLength":1,"maxLength":100}}),
        _ => json!({}),
    };
    omc_mcp::schema::check(
        &json!({"type":"object","properties":properties,"additionalProperties":false}),
        params,
        "params",
    )?;
    if command == "collab.join" {
        let invite = match (params["link"].as_str(), params["code"].as_str()) {
            (Some(link), None) | (None, Some(link)) => link,
            _ => return Err(EngineError::invalid("supply one invitation link")),
        };
        let joined = app
            .collaboration
            .call(session, json!({"action":"join","invite":invite}))
            .await?;
        let document = super::string(&joined, "documentId")?.to_owned();
        let router = app.router.clone();
        let owner = session.to_owned();
        tokio::task::spawn_blocking(move || router.fig_bind_collaboration_tab(&owner, &document))
            .await
            .map_err(network)??;
        return Ok(fig_status(joined));
    }
    let explicit = args["document"]
        .as_str()
        .map(|id| {
            if omc_model::valid_id(id, "doc") {
                Ok(id.to_owned())
            } else {
                uuid::Uuid::parse_str(id)
                    .map(|id| format!("doc_{}", id.simple()))
                    .map_err(|_| EngineError::invalid("invalid document ID"))
            }
        })
        .transpose()?;
    let document = app.workspace.target(session, explicit.as_deref())?;
    let action = |name| json!({"action":name,"documentId":document});
    match command {
        "collab.share" => {
            if params["via"] != "local" {
                return Err(EngineError::new(
                    "unsupported_feature",
                    "online FigCraft publishing is not available for a native room",
                ));
            }
            if params["access"] == "comment"
                || params.get("server").is_some()
                || params.get("key").is_some()
            {
                return Err(EngineError::invalid(
                    "local sharing supports edit and view invitations",
                ));
            }
            let address = figcraft_bind(params["bind"].as_str().unwrap_or("lan"))?;
            let mut request = action("share");
            request["address"] = json!(address);
            request["viewOnly"] = json!(params["access"] == "view");
            if let Some(port) = params["port"].as_u64() {
                request["port"] = json!(port);
            }
            if let Some(name) = params["name"].as_str() {
                request["name"] = json!(name);
            }
            Ok(fig_status(app.collaboration.call(session, request).await?))
        }
        "collab.host" => {
            let address = figcraft_bind(params["bind"].as_str().unwrap_or("local"))?;
            let mut request = action("host");
            request["address"] = json!(address);
            if let Some(port) = params["port"].as_u64() {
                request["port"] = json!(port);
            }
            let mut status = fig_status(app.collaboration.call(session, request).await?);
            let invite = app.collaboration.call(session, action("invite")).await?;
            status["link"] = invite["invite"].clone();
            status["url"] = invite["invite"].clone();
            Ok(status)
        }
        "collab.peers" => Ok(fig_status(
            app.collaboration.call(session, action("status")).await?,
        )),
        "collab.reconnect" => Ok(fig_status(
            app.collaboration.call(session, action("reconnect")).await?,
        )),
        "collab.removePerson" => {
            let mut request = action("removePerson");
            request["client"] = params["client"].clone();
            app.collaboration.call(session, request).await
        }
        "collab.cursorChat" => {
            let Some(text) = params.get("text") else {
                let state = app.collaboration.call(session, action("status")).await?;
                if state["mode"] == "offline" {
                    return Err(EngineError::invalid("cursor chat requires a live room"));
                }
                return app
                    .desktop_automation
                    .call(
                        session,
                        "collab.cursorChat.open",
                        json!({"document":external(&document),"state":state}),
                    )
                    .await;
            };
            let mut request = action("chat");
            request["text"] = text.clone();
            app.collaboration.call(session, request).await
        }
        "collab.follow" | "collab.spotlight" => {
            let mut request = action(command.strip_prefix("collab.").unwrap());
            request["client"] = params["client"].clone();
            request["on"] = params["on"].clone();
            let result = app.collaboration.call(session, request).await?;
            if app.desktop_automation.attached() {
                let state = app.collaboration.call(session, action("status")).await?;
                let _ = app
                    .desktop_automation
                    .call(
                        session,
                        "collab.presence",
                        json!({"document":external(&document),"state":state}),
                    )
                    .await;
            }
            Ok(result)
        }
        "collab.cursor" => {
            let cursor = match (params["x"].as_f64(), params["y"].as_f64()) {
                (None, None) => Value::Null,
                (Some(x), Some(y)) => {
                    let router = app.router.clone();
                    let owner = session.to_owned();
                    let id = document.clone();
                    let page = tokio::task::spawn_blocking(move || {
                        router.fig_collaboration_page(&owner, &id)
                    })
                    .await
                    .map_err(network)??;
                    json!({"x":x,"y":y,"page":page})
                }
                _ => return Err(EngineError::invalid("supply both cursor coordinates")),
            };
            let mut request = action("cursor");
            request["cursor"] = cursor.clone();
            let result = app.collaboration.call(session, request).await?;
            Ok(json!({"cursor":if result["mode"]=="offline" { Value::Null } else { cursor }}))
        }
        "collab.leave" | "collab.stop" => {
            let before = app.collaboration.call(session, action("status")).await?;
            app.collaboration.call(session, action("leave")).await?;
            Ok(json!({"ended":before["mode"]!="offline"}))
        }
        _ => Err(EngineError::invalid("unknown collaboration command")),
    }
}

fn fig_status(mut status: Value) -> Value {
    let (state, role) = match status["mode"].as_str() {
        Some("hosting") => ("live", "host"),
        Some("connected") => ("live", "guest"),
        Some("connecting") => ("connecting", "guest"),
        Some("reconnecting") => ("reconnecting", "guest"),
        _ => ("off", "none"),
    };
    status["status"] = json!(state);
    status["role"] = json!(role);
    status["session"] = if state == "off" {
        Value::Null
    } else {
        status["documentId"].clone()
    };
    status["peers"] = status["participants"].clone();
    status["canHost"] = json!(true);
    status["available"] = json!(true);
    status
}
