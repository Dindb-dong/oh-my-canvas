use super::{
    wire::{Access, Change, Document},
    *,
};
use omc_model::DocumentSnapshot;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::time::{Duration, Instant};

#[derive(Default, Deserialize, Serialize)]
pub(super) struct Presence {
    pub cursor: Option<(u64, f64, f64)>,
    selection: Option<Vec<u64>>,
    pub viewport: Option<(u64, f64, f64, f64, f64)>,
    editing_text: Option<Box<EditingText>>,
}
impl Presence {
    pub(super) fn points(
        cursor: Option<(u64, f64, f64)>,
        viewport: Option<(u64, f64, f64, f64, f64)>,
    ) -> Self {
        Self {
            cursor,
            viewport,
            ..Self::default()
        }
    }
}
#[derive(Deserialize, Serialize)]
struct EditingText {
    node: u64,
    caret: usize,
    selection: Option<(usize, usize)>,
}
#[derive(Deserialize, Serialize)]
struct Signal {
    kind: String,
    text: String,
}
#[derive(Default)]
struct PeerPresence {
    view: Presence,
    chat: Option<(String, Instant)>,
    spotlight: bool,
}

#[derive(Deserialize, Serialize)]
struct Peer {
    client_id: u32,
    name: String,
    color: String,
}

#[allow(dead_code)] // Preserve all discriminants from the pinned wire.
#[derive(Deserialize)]
enum CatchUp {
    Snapshot(Vec<Change>),
    Delta(Vec<Accepted>),
    Packed(Vec<u8>),
}

#[derive(Deserialize)]
struct Processed {
    last_batch: u64,
    _refused: Vec<u64>,
}

#[derive(Deserialize)]
struct Welcome {
    session: u64,
    client_id: u32,
    seq: u64,
    catch_up: CatchUp,
    processed: Processed,
    peers: Vec<Peer>,
    access: Access,
    secret: u64,
}

#[derive(Deserialize)]
struct Accepted {
    seq: u64,
    author: u32,
    batch_id: u64,
    changes: Vec<Change>,
}

#[derive(Serialize)]
struct Changes {
    base_seq: u64,
    batch_id: u64,
    changes: Vec<Change>,
}

#[derive(Clone, Copy, Serialize, PartialEq, Eq)]
pub(super) struct Resume {
    pub session: u64,
    pub client_id: u32,
    pub seq: u64,
    pub secret: u64,
}

#[derive(Clone)]
pub(super) struct Checkpoint {
    pub resume: Resume,
    pub snapshot: DocumentSnapshot,
    pub page: String,
    pub nodes: BTreeMap<u64, String>,
    pub pages: BTreeMap<u64, String>,
    pub comments: omc_mcp::WireComments,
}

pub(super) enum Attach {
    Publish(DocumentSnapshot, String, BTreeMap<String, usize>),
    Reconnect(Checkpoint),
    Recover(Resume),
    Fresh,
}

#[derive(Serialize)]
struct Hello<'a> {
    protocol: u32,
    file: &'a str,
    token: &'a str,
    name: &'a str,
    color: &'a str,
    client_version: &'a str,
    resume: Option<Resume>,
}

pub(super) async fn join(
    app: &App,
    caller: &str,
    link: &Link,
    attach: Attach,
    publication: Option<Publication>,
) -> Result<(String, Arc<Room>)> {
    let mut hasher = Sha256::new();
    hasher.update(link.address.as_bytes());
    hasher.update([0]);
    hasher.update(link.file.as_bytes());
    let mirror = format!("figcraft-remote:{}", hex::encode(hasher.finalize()));
    let mut socket = FigcraftServer::connect(&link.address, LIMIT).await?;
    let configured = app.workspace.preferences().user_name;
    let name = if configured.is_empty() {
        "Oh My Canvas"
    } else {
        &configured
    };
    let resume = match &attach {
        Attach::Reconnect(checkpoint) => Some(checkpoint.resume),
        Attach::Recover(resume) => Some(*resume),
        _ => None,
    }
    .map(|resume| Resume {
        seq: u64::MAX,
        ..resume
    });
    socket
        .send(
            0,
            &Hello {
                protocol: PROTOCOL,
                file: &link.file,
                token: &link.token,
                name,
                color: "#008d63",
                client_version: "0.17.0 hosting signals comments",
                resume,
            },
        )
        .await
        .map_err(remote)?;
    let reply = socket.receive().await.map_err(remote)?;
    if reply.kind != 0 {
        return Err(unexpected());
    }
    let Welcome {
        session,
        client_id,
        seq,
        catch_up,
        peers,
        access,
        secret,
        processed,
        ..
    } = reply.decode()?;
    let resume = Resume {
        session,
        client_id,
        seq,
        secret,
    };
    let CatchUp::Snapshot(changes) = catch_up else {
        return Err(unexpected());
    };
    let server = Document::from_snapshot(changes)?;
    let archive = server.archive()?;
    let mut nodes = BTreeMap::new();
    let mut pages = BTreeMap::new();
    let mut comments = omc_mcp::WireComments::default();
    let reconnecting = matches!(attach, Attach::Reconnect(_));
    let (snapshot, page) = match attach {
        Attach::Publish(snapshot, page, ids) => {
            nodes.extend(ids.iter().map(|(id, number)| (*number as u64, id.clone())));
            for item in &snapshot.pages {
                pages.insert(ids[&item.root_node_id] as u64, item.id.clone());
            }
            omc_mcp::decode_wire_document_with_comments(
                &archive,
                &mut nodes,
                &mut pages,
                &mut comments,
                Some(&snapshot),
            )?;
            (snapshot, page)
        }
        Attach::Reconnect(checkpoint) if checkpoint.resume == resume => {
            nodes = checkpoint.nodes;
            pages = checkpoint.pages;
            comments = checkpoint.comments;
            omc_mcp::decode_wire_document_with_comments(
                &archive,
                &mut nodes,
                &mut pages,
                &mut comments,
                Some(&checkpoint.snapshot),
            )?;
            (checkpoint.snapshot, checkpoint.page)
        }
        _ => {
            let (mut content, index) = omc_mcp::decode_wire_document_with_comments(
                &archive,
                &mut nodes,
                &mut pages,
                &mut comments,
                None,
            )?;
            pin_comment_authorship(&mut content, None, &mirror);
            let title = content.title.clone();
            let page = content.pages[index].id.clone();
            (app.workspace.create(caller, &title, Some(content))?, page)
        }
    };
    let document = snapshot.id.clone();
    let projection = project(&snapshot, &page, client_id, &mut nodes, &mut comments)?;
    let _share_guard = app.online.share_operations.lock().await;
    let share = publication
        .as_ref()
        .map(|item| files::saved_share(app, item))
        .transpose()?
        .flatten();
    let internal = app.workspace.session_open(None)?["sessionId"]
        .as_str()
        .ok_or_else(unexpected)?
        .to_owned();
    if let Err(error) = app.workspace.bind(&internal, &document) {
        let _ = app.workspace.session_close(&internal);
        return Err(error);
    }
    let read_only = access != Access::Edit;
    let mut status = json!({"available":true,"canHost":true,"network":"online",
        "session":session.to_string(),"role":"guest","me":client_id.to_string(),"name":name,
        "fileName":snapshot.title,"pages":snapshot.pages.len(),"status":"live","access":access_name(access),
        "link":link.canonical(),"url":link.canonical(),"address":link.address,"readOnly":read_only,
        "published":publication.as_ref().map(files::published_status),"code":null,"share":null,"follow":null,"syncing":false,
        "peers":peer_values(&peers,&BTreeMap::new(),&pages)});
    files::set_share_status(&mut status, share.as_ref());
    status["document"] = json!(external_document(&snapshot.id));
    let (requests, pending_requests) = mpsc::channel(16);
    let (cancel, cancellation) = watch::channel(false);
    let room = Arc::new(Room {
        status: Mutex::new(status),
        cancel,
        link: link.clone(),
        requests,
        mirror: mirror.clone(),
        publication,
        checkpoint: Mutex::new(Checkpoint {
            resume,
            snapshot: snapshot.clone(),
            page: page.clone(),
            nodes: nodes.clone(),
            pages: pages.clone(),
            comments: comments.clone(),
        }),
    });
    app.workspace
        .set_room_access(&document, native_access(access));
    app.online
        .rooms
        .lock()
        .unwrap()
        .insert(document.clone(), room.clone());
    let state = Live {
        socket,
        mirror,
        session: internal,
        projection,
        server,
        nodes,
        pages,
        comments,
        snapshot,
        page,
        client_id,
        seq,
        batch: processed.last_batch,
        pending: None,
        dirty: reconnecting,
        peers,
        presence: BTreeMap::new(),
        requests: pending_requests,
        cancellation,
    };
    tokio::spawn(run(
        app.clone(),
        document.clone(),
        room.clone(),
        state,
        access,
    ));
    Ok((document, room))
}

fn project(
    snapshot: &DocumentSnapshot,
    page: &str,
    client: u32,
    nodes: &mut BTreeMap<u64, String>,
    comments: &mut omc_mcp::WireComments,
) -> Result<Document> {
    let mut ids = nodes
        .iter()
        .map(|(id, native)| (native.clone(), *id as usize))
        .collect();
    let archive =
        omc_mcp::encode_wire_document_with_comments(snapshot, page, &mut ids, client, comments)?;
    nodes.extend(ids.into_iter().map(|(id, number)| (number as u64, id)));
    Document::from_archive(&archive)
}

fn peer_values(
    peers: &[Peer],
    presence: &BTreeMap<u32, PeerPresence>,
    pages: &BTreeMap<u64, String>,
) -> Vec<Value> {
    peers.iter().map(|peer| {
        let live = presence.get(&peer.client_id);
        let cursor = live.and_then(|p|p.view.cursor).and_then(|(id,x,y)|Some(json!({"page":pages.get(&id)?,"x":x,"y":y})));
        let viewport = live.and_then(|p|p.view.viewport).and_then(|(id,x,y,w,h)| {
            [x,y,w,h].iter().all(|n|n.is_finite() && n.abs()<=10_000_000.).then_some(())?;
            (w>0. && h>0.).then_some(())?;
            Some(json!([pages.get(&id)?,x,y,w,h]))
        });
        let chat = live.and_then(|p|p.chat.as_ref()).filter(|(_,at)|at.elapsed()<Duration::from_secs(5)).map(|(text,_)|text);
        json!({"id":peer.client_id.to_string(),"name":peer.name,"color":peer.color,"cursor":cursor,
            "spotlighting":live.is_some_and(|p|p.spotlight),"chat":chat,
            "presence":{"viewport":viewport,"cursor":cursor}})
    }).collect()
}

struct Live {
    socket: FigcraftServer,
    mirror: String,
    session: String,
    projection: Document,
    server: Document,
    nodes: BTreeMap<u64, String>,
    pages: BTreeMap<u64, String>,
    comments: omc_mcp::WireComments,
    snapshot: DocumentSnapshot,
    page: String,
    client_id: u32,
    seq: u64,
    batch: u64,
    pending: Option<Document>,
    dirty: bool,
    peers: Vec<Peer>,
    presence: BTreeMap<u32, PeerPresence>,
    requests: mpsc::Receiver<Request>,
    cancellation: watch::Receiver<bool>,
}

async fn run(app: App, document: String, room: Arc<Room>, mut state: Live, access: Access) {
    let result = state.run(&app, &room, access).await;
    let _ = app.workspace.session_close(&state.session);
    if let Err(error) = result {
        let mut status = room.status.lock().unwrap();
        status["status"] = json!("failed");
        status["reason"] = json!(error.message);
        status["syncing"] = json!(false);
    }
    let rooms = app.online.rooms.lock().unwrap();
    if rooms
        .get(&document)
        .is_some_and(|active| Arc::ptr_eq(active, &room))
    {
        app.workspace
            .set_room_access(&document, native_access(access));
    }
}

impl Live {
    async fn run(&mut self, app: &App, room: &Room, access: Access) -> Result<()> {
        let mut check = tokio::time::interval(Duration::from_millis(250));
        let mut ping = tokio::time::interval(Duration::from_secs(4));
        let mut report: Option<tokio::sync::oneshot::Sender<Result<Value>>> = None;
        loop {
            tokio::select! {
                biased;
                _ = self.cancellation.changed() => return Ok(()),
                reply = self.socket.receive() => {
                    let reply = reply.map_err(remote)?;
                    match reply.kind {
                        1 => self.accept(app,room,reply.decode()?).await?,
                        2 => return Err(conflict("FigCraft server refused an edit; the local version is still saved")),
                        3 => {
                            let (id,view): (u32,Presence) = reply.decode()?;
                            if self.peers.iter().any(|peer|peer.client_id==id) {
                                self.presence.entry(id).or_default().view=view;
                            }
                        }
                        4 => {
                            let peer: Peer = reply.decode()?;
                            self.peers.retain(|p| p.client_id != peer.client_id);
                            if peer.client_id!=self.client_id && self.peers.len()<4096 {
                                self.peers.push(peer);
                            }
                        }
                        5 => {
                            let client: u32 = reply.decode()?;
                            self.peers.retain(|p| p.client_id != client);
                            self.presence.remove(&client);
                        }
                        10 => {
                            let (id,signal): (u32,Signal) = reply.decode()?;
                            if self.peers.iter().any(|peer|peer.client_id==id) {
                                let entry = self.presence.entry(id).or_default();
                                match signal.kind.as_str() {
                                    "chat" => entry.chat = (!signal.text.is_empty()).then_some((signal.text,Instant::now())),
                                    "spotlight" => entry.spotlight = signal.text == "on",
                                    _ => (),
                                }
                            }
                        }
                        13 => if let Some(result) = report.take() {
                            let reason: Option<String> = reply.decode()?;
                            let response = if reason.is_some() {Err(unexpected())} else {Ok(json!({"sent":true}))};
                            let _ = result.send(response);
                        },
                        _ => (),
                    }
                    self.update_peers(room);
                }
                Some(request) = self.requests.recv() => match request {
                    Request::Report(reason,result) => {
                        if report.is_some() {
                            let _ = result.send(Err(conflict("a file report is already being sent")));
                        } else {
                            self.socket.send(13,&reason).await.map_err(remote)?;
                            report = Some(result);
                        }
                    }
                    Request::Presence(presence) => self.socket.send(2,&presence).await.map_err(remote)?,
                    Request::Signal(kind,text) => self.socket.send(9,&Signal {kind:kind.into(),text}).await.map_err(remote)?,
                },
                _ = ping.tick() => {
                    self.update_peers(room);
                    self.socket.send(4,&()).await.map_err(remote)?;
                }
                _ = check.tick(), if access != Access::View && self.pending.is_none() => {
                    let workspace = app.workspace.clone();
                    let id = self.snapshot.id.clone();
                    let revision = tokio::task::spawn_blocking(move ||workspace.context(&id).map(|context|context.revision))
                        .await.map_err(|_|unexpected())??;
                    if !self.dirty && revision == self.snapshot.revision() {continue;}
                    let current = read_snapshot(app,&self.snapshot.id).await?;
                    let next = project(&current,&self.page,self.client_id,&mut self.nodes,&mut self.comments)?;
                    let changes = self.projection.changes_to(&next)?;
                    if changes.is_empty() {
                        self.snapshot = current;
                        self.projection = next;
                        self.dirty=false;
                        continue;
                    }
                    self.batch += 1;
                    self.socket.send(1,&Changes {base_seq:self.seq,batch_id:self.batch,changes}).await.map_err(remote)?;
                    self.pending = Some(next);
                    room.status.lock().unwrap()["syncing"] = json!(true);
                }
            }
        }
    }

    fn update_peers(&self, room: &Room) {
        room.status.lock().unwrap()["peers"] =
            json!(peer_values(&self.peers, &self.presence, &self.pages));
    }

    async fn accept(&mut self, app: &App, room: &Room, accepted: Accepted) -> Result<()> {
        if accepted.seq != self.seq + 1 {
            return Err(conflict(
                "FigCraft sequence changed; the local version is still saved",
            ));
        }
        let own = accepted.author == self.client_id && accepted.batch_id == self.batch;
        let pending = if own {
            room.status.lock().unwrap()["syncing"] = json!(false);
            Some(self.pending.take().ok_or_else(unexpected)?)
        } else {
            None
        };
        let base = pending.as_ref().unwrap_or(&self.projection);
        self.server.apply(accepted.changes.clone())?;
        let archive = self.server.archive()?;
        let mut applied = None;
        for _ in 0..4 {
            let current = read_snapshot(app, &self.snapshot.id).await?;
            let projected = project(
                &current,
                &self.page,
                self.client_id,
                &mut self.nodes,
                &mut self.comments,
            )?;
            let local = base.changes_to(&projected)?;
            if !own
                && local.iter().any(|ours| {
                    accepted
                        .changes
                        .iter()
                        .any(|theirs| wire::conflicting(ours, theirs))
                })
            {
                return Err(conflict(
                    "Concurrent edits touched the same field; the local version is still saved",
                ));
            }
            let (mut remote, page) = omc_mcp::decode_wire_document_with_comments(
                &archive,
                &mut self.nodes,
                &mut self.pages,
                &mut self.comments,
                Some(&current),
            )?;
            retain_home_shards(&mut remote, &current);
            pin_comment_authorship(&mut remote, Some(&current), &self.mirror);
            let page = remote.pages[page].id.clone();
            let merged = if local.is_empty() {
                remote.clone()
            } else {
                let mut wire = self.server.clone();
                wire.apply(local)?;
                let (mut merged, _) = omc_mcp::decode_wire_document_with_comments(
                    &wire.archive()?,
                    &mut self.nodes,
                    &mut self.pages,
                    &mut self.comments,
                    Some(&current),
                )?;
                retain_home_shards(&mut merged, &current);
                pin_comment_authorship(&mut merged, Some(&current), &self.mirror);
                merged
            };
            let dirty = merged != remote;
            let router = app.router.clone();
            let worker = self.session.clone();
            let mirror = self.mirror.clone();
            let result = tokio::task::spawn_blocking(move || {
                router.fig_online_apply(&worker, &mirror, &current, &merged)
            })
            .await
            .map_err(|_| unexpected())?;
            match result {
                Ok(revision) => {
                    applied = Some((remote, page, revision, dirty));
                    break;
                }
                Err(error) if error.code == "stale_revision" => (),
                Err(error) => return Err(error),
            }
        }
        let (content, page, revision, dirty) = applied
            .ok_or_else(|| conflict("Native document was busy; local edits remain saved"))?;
        self.page = page;
        self.snapshot = DocumentSnapshot {
            id: self.snapshot.id.clone(),
            epoch: revision.epoch,
            sequence: revision.sequence,
            title: content.title,
            pages: content.pages,
            nodes: content.nodes,
            metadata: content.metadata,
        };
        self.dirty = dirty;
        self.projection = project(
            &self.snapshot,
            &self.page,
            self.client_id,
            &mut self.nodes,
            &mut self.comments,
        )?;
        self.seq = accepted.seq;
        {
            let mut checkpoint = room.checkpoint.lock().unwrap();
            checkpoint.resume.seq = self.seq;
            checkpoint.snapshot = self.snapshot.clone();
            checkpoint.page.clone_from(&self.page);
            checkpoint.nodes.clone_from(&self.nodes);
            checkpoint.pages.clone_from(&self.pages);
            checkpoint.comments.clone_from(&self.comments);
        }
        self.socket.send(3, &self.seq).await.map_err(super::remote)
    }
}

async fn read_snapshot(app: &App, document: &str) -> Result<DocumentSnapshot> {
    let workspace = app.workspace.clone();
    let id = document.to_owned();
    tokio::task::spawn_blocking(move || workspace.snapshot(&id))
        .await
        .map_err(|_| unexpected())?
}

fn native_access(access: Access) -> omc_workspace::RoomAccess {
    match access {
        Access::Edit => omc_workspace::RoomAccess::Edit,
        Access::View => omc_workspace::RoomAccess::View,
        Access::Comment => omc_workspace::RoomAccess::Comment,
    }
}

fn retain_home_shards(content: &mut omc_model::DocumentContent, current: &DocumentSnapshot) {
    for (id, node) in &mut content.nodes {
        if let Some(existing) = current.nodes.get(id) {
            node.home_shard.clone_from(&existing.home_shard);
        }
    }
}

// Imported display names identify peers to users, not authenticated native principals.
pub(super) fn pin_comment_authorship(
    content: &mut omc_model::DocumentContent,
    current: Option<&DocumentSnapshot>,
    mirror: &str,
) {
    if let Some(current) = current {
        // A locally authored message without a tombstone is already live.
        content.metadata.retain(|key, value| {
            !key.starts_with("comments/")
                || !key.ends_with("/deleted")
                || *value != false
                || current.metadata.contains_key(key)
        });
    }
    for (key, author) in &mut content.metadata {
        if key.starts_with("comments/") && key.ends_with("/authorId") {
            *author = current
                .and_then(|snapshot| snapshot.metadata.get(key))
                .cloned()
                .unwrap_or_else(|| json!(mirror));
        }
    }
}
