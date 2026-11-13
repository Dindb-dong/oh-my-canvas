//! Online file commands against the pinned FigCraft server.
mod files;
mod live;
pub(crate) mod wire;

use crate::{
    App,
    figcraft_server::{FigcraftServer, PROTOCOL},
    team_library::Link,
};
use omc_protocol::{EngineError, Result};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
};
use tokio::sync::{mpsc, oneshot, watch};
use wire::{Access, Admin, AdminReply};

const LIMIT: usize = 17 * 1024 * 1024;
enum Request {
    Report(String, oneshot::Sender<Result<Value>>),
    Presence(live::Presence),
    Signal(&'static str, String),
}

#[derive(Default)]
pub(crate) struct Online {
    rooms: Mutex<BTreeMap<String, Arc<Room>>>,
    files: Mutex<()>,
    team: Mutex<Value>,
    share_operations: tokio::sync::Mutex<()>,
    changes: tokio::sync::Mutex<()>,
}

struct Room {
    status: Mutex<Value>,
    cancel: watch::Sender<bool>,
    link: Link,
    publication: Option<Publication>,
    checkpoint: Mutex<live::Checkpoint>,
    requests: mpsc::Sender<Request>,
    mirror: String,
}

#[derive(Clone, Serialize, Deserialize)]
struct Publication {
    server: String,
    file: String,
    name: String,
    edit: String,
    view: String,
    owner: Option<String>,
    expires: Option<u64>,
    #[serde(default)]
    key: Option<String>,
    #[serde(default)]
    share: Option<files::Share>,
    created: u64,
}

pub(crate) const COMMANDS: &[&str] = &[
    "collab.publish",
    "collab.files",
    "collab.manageFile",
    "collab.openFile",
    "collab.forgetFile",
    "collab.report",
    "collab.recoverFile",
];

pub(crate) fn routes(app: &App, session: &str, command: &str, args: &Value) -> bool {
    if COMMANDS.contains(&command) {
        return true;
    }
    let params = &args["params"];
    if command == "collab.share" && params["via"] != "local" {
        return true;
    }
    if command == "collab.join" {
        let value = params["link"]
            .as_str()
            .or(params["code"].as_str())
            .unwrap_or_default()
            .trim();
        return crate::team_library::is_link(value) || parse_code(value).is_some();
    }
    if matches!(
        command,
        "collab.peers"
            | "collab.leave"
            | "collab.stop"
            | "collab.reconnect"
            | "collab.removePerson"
            | "collab.host"
            | "collab.share"
            | "collab.cursor"
            | "collab.cursorChat"
            | "collab.follow"
            | "collab.spotlight"
    ) {
        if let Some(id) = params["session"].as_str()
            && app
                .online
                .rooms
                .lock()
                .unwrap()
                .values()
                .any(|room| room.status.lock().unwrap()["session"] == id)
        {
            return true;
        }
        let explicit = args["document"].as_str().map(native_document);
        return app
            .workspace
            .target(session, explicit.as_deref())
            .ok()
            .is_some_and(|document| app.online.rooms.lock().unwrap().contains_key(&document));
    }
    false
}

pub(crate) async fn command(app: &App, session: &str, name: &str, args: &Value) -> Result<Value> {
    omc_mcp::validate_figcraft_tool("run_command", args)?;
    let empty = json!({});
    let params = args.get("params").unwrap_or(&empty);
    if name == "collab.host" || name == "collab.share" && params["via"] == "local" {
        return Err(conflict(
            "leave the online room before starting a local room",
        ));
    }
    files::validate(name, params)?;
    if name == "collab.join" {
        let value = match (params["link"].as_str(), params["code"].as_str()) {
            (Some(value), None) | (None, Some(value)) => value,
            _ => {
                return Err(EngineError::invalid(
                    "supply exactly one invite link or code",
                ));
            }
        };
        let mut link = if let Some(code) = parse_code(value) {
            resolve(&app.router.fig_resolve_publish_server(None)?, 14, &code).await?
        } else if let Some((server, kind, lookup)) = lookup_invite(value)? {
            resolve(&server, kind, &lookup).await?
        } else {
            Link::parse(value)?
        };
        link.address = omc_mcp::normalize_figcraft_endpoint(&link.address)?.into();
        let (id, room) = live::join(app, session, &link, live::Attach::Fresh, None).await?;
        bind(app, session, &id)?;
        return Ok(room.status.lock().unwrap().clone());
    }
    if matches!(
        name,
        "collab.files"
            | "collab.manageFile"
            | "collab.openFile"
            | "collab.forgetFile"
            | "collab.recoverFile"
    ) {
        return files::command(app, session, name, params).await;
    }

    let (document, page) = if let Some(id) = params["session"].as_str() {
        let rooms = app.online.rooms.lock().unwrap();
        let document = rooms
            .iter()
            .find(|(_, room)| room.status.lock().unwrap()["session"] == id)
            .map(|(document, _)| document.clone())
            .ok_or_else(unexpected)?;
        (document, String::new())
    } else {
        app.router.fig_online_document(session, args)?
    };
    let room = app.online.rooms.lock().unwrap().get(&document).cloned();
    match (name, room) {
        ("collab.publish" | "collab.share", None) => {
            let _guard = app.online.changes.lock().await;
            if app.online.rooms.lock().unwrap().contains_key(&document) {
                return Err(conflict("the document is already in an online session"));
            }
            if app.collaboration.has_room(&document).await {
                return Err(conflict(
                    "leave the local collaboration room before publishing",
                ));
            }
            let room = files::publish(app, session, &document, page, params).await?;
            if name == "collab.share" {
                files::share(app, &room, params).await?;
            }
            Ok(room.status.lock().unwrap().clone())
        }
        ("collab.publish", Some(_)) => {
            Err(conflict("the document is already in an online session"))
        }
        ("collab.share", Some(room)) => {
            files::share(app, &room, params).await?;
            Ok(room.status.lock().unwrap().clone())
        }
        ("collab.peers", Some(room)) => {
            let mut status = room.status.lock().unwrap().clone();
            status["sessions"] = json!(app.online.rooms.lock().unwrap().values().map(|r| {
                let state = r.status.lock().unwrap();
                json!({"session":state["session"],"document":state["document"],"status":state["status"],
                    "role":state["role"],"fileName":state["fileName"],"peers":state["peers"].as_array().map_or(0,Vec::len)})
            }).collect::<Vec<_>>());
            Ok(status)
        }
        ("collab.stop" | "collab.leave", Some(room)) => {
            if name == "collab.stop" && files::stop_share(app, &room).await? {
                return Ok(json!({"ended":false,"shared":false}));
            }
            app.online.rooms.lock().unwrap().remove(&document);
            let _ = room.cancel.send(true);
            app.workspace.set_room_read_only(&document, false);
            Ok(json!({"ended":true}))
        }
        ("collab.report", Some(room)) => {
            let (send, receive) = oneshot::channel();
            room.requests
                .send(Request::Report(
                    params["reason"].as_str().unwrap_or_default().into(),
                    send,
                ))
                .await
                .map_err(|_| unexpected())?;
            tokio::time::timeout(std::time::Duration::from_secs(8), receive)
                .await
                .map_err(|_| unexpected())?
                .map_err(|_| unexpected())?
        }
        ("collab.cursor", Some(room)) => {
            let point = match (params["x"].as_f64(), params["y"].as_f64()) {
                (None, None) => Value::Null,
                (Some(x), Some(y)) => json!({"page":page,"x":x,"y":y}),
                _ => return Err(EngineError::invalid("supply both cursor coordinates")),
            };
            let view = app
                .router
                .fig_headless_view(session, "view.get", &json!({"document":document}))
                .ok();
            let viewport = view
                .as_ref()
                .and_then(|view| {
                    let zoom = view["zoom"].as_f64()?;
                    let w = view["vw"].as_f64()? / zoom;
                    let h = view["vh"].as_f64()? / zoom;
                    Some(json!([
                        page,
                        view["cx"].as_f64()? - w / 2.,
                        view["cy"].as_f64()? - h / 2.,
                        w,
                        h
                    ]))
                })
                .unwrap_or(Value::Null);
            update_presence(&room, &point, &viewport).await?;
            Ok(json!({"cursor":point}))
        }
        ("collab.cursorChat", Some(room)) => {
            if let Some(text) = params["text"].as_str() {
                signal(&room, "chat", text.to_owned()).await?;
                Ok(json!({"chat":text}))
            } else {
                let state = native_status(&room);
                app.desktop_automation
                    .call(
                        session,
                        "collab.cursorChat.open",
                        json!({"document":external_document(&document),"state":state}),
                    )
                    .await
            }
        }
        ("collab.follow", Some(room)) => {
            let value = params["client"].as_str();
            follow(&room, value)?;
            if app.desktop_automation.attached() {
                let state = native_status(&room);
                let _ = app
                    .desktop_automation
                    .call(
                        session,
                        "collab.presence",
                        json!({"document":external_document(&document),"state":state}),
                    )
                    .await;
            }
            Ok(json!({"follow":value}))
        }
        ("collab.spotlight", Some(room)) => {
            let on = params["on"]
                .as_bool()
                .unwrap_or_else(|| room.status.lock().unwrap()["spotlighting"] != true);
            signal(
                &room,
                "spotlight",
                if on { "on".into() } else { String::new() },
            )
            .await?;
            let mut state = room.status.lock().unwrap();
            state["spotlighting"] = json!(on);
            if on {
                state["follow"] = Value::Null;
            }
            Ok(json!({"spotlighting":on}))
        }
        ("collab.removePerson", Some(room)) => files::remove_peer(app, &room, params).await,
        ("collab.reconnect", Some(room)) => {
            let _guard = app.online.changes.lock().await;
            if room.status.lock().unwrap()["status"] == "live" {
                return Err(conflict("the FigCraft session is already live"));
            }
            let checkpoint = room.checkpoint.lock().unwrap().clone();
            let (id, next) = live::join(
                app,
                session,
                &room.link,
                live::Attach::Reconnect(checkpoint),
                room.publication.clone(),
            )
            .await?;
            if id != document {
                app.online.rooms.lock().unwrap().remove(&document);
                app.workspace.set_room_read_only(&document, false);
            }
            let mut status = next.status.lock().unwrap();
            status["localCopy"] = if id != document {
                json!(external_document(&document))
            } else {
                Value::Null
            };
            bind(app, session, &id)?;
            Ok(status.clone())
        }
        _ => Err(conflict(
            "this document has no online collaboration session",
        )),
    }
}

fn bind(app: &App, session: &str, id: &str) -> Result<()> {
    app.router.fig_bind_collaboration_tab(session, id)
}

fn parse_code(value: &str) -> Option<String> {
    let code = value
        .chars()
        .filter(|c| !c.is_whitespace() && *c != '-')
        .map(|c| match c.to_ascii_uppercase() {
            'O' => '0',
            'I' | 'L' => '1',
            c => c,
        })
        .collect::<String>();
    (code.len() == 9
        && code
            .bytes()
            .all(|c| b"0123456789ABCDEFGHJKMNPQRSTVWXYZ".contains(&c)))
    .then_some(code)
}

fn lookup_invite(value: &str) -> Result<Option<(String, u8, String)>> {
    let Ok(url) = reqwest::Url::parse(value) else {
        return Ok(None);
    };
    if url.scheme() != "figcraft"
        || url.host_str() != Some("join")
        || !matches!(url.path(), "" | "/")
    {
        return Ok(None);
    }
    if !url
        .query_pairs()
        .any(|(key, _)| matches!(key.as_ref(), "code" | "team"))
    {
        return Ok(None);
    }
    let malformed = || EngineError::invalid("invalid FigCraft lookup link");
    if url.fragment().is_some() || !url.username().is_empty() || url.password().is_some() {
        return Err(malformed());
    }
    let mut fields = BTreeMap::new();
    for (key, value) in url.query_pairs() {
        if !matches!(key.as_ref(), "server" | "host" | "file" | "code" | "team")
            || fields
                .insert(key.into_owned(), value.into_owned())
                .is_some()
        {
            return Err(malformed());
        }
    }
    let endpoint = match (fields.remove("server"), fields.remove("host")) {
        (Some(server), None) => server,
        (None, Some(host)) if !host.contains(['/', char::from(92), '?', '#', '@']) => {
            format!("ws://{host}/")
        }
        _ => return Err(malformed()),
    };
    let endpoint = omc_mcp::normalize_figcraft_endpoint(&endpoint)?.into();
    let (kind, lookup) = match (
        fields.remove("code"),
        fields.remove("team"),
        fields.remove("file"),
    ) {
        (Some(code), None, None) => (14, parse_code(&code).ok_or_else(malformed)?),
        (None, Some(team), Some(file)) if team == "1" && team_file_id(&file) => (15, file),
        _ => return Err(malformed()),
    };
    Ok(Some((endpoint, kind, lookup)))
}

fn team_file_id(file: &str) -> bool {
    (1..=64).contains(&file.len())
        && file
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
}

async fn resolve(server: &str, kind: u8, value: &str) -> Result<Link> {
    let mut client = FigcraftServer::connect(server, LIMIT).await?;
    client
        .send(kind, &(PROTOCOL, "0.17.0", value))
        .await
        .map_err(remote)?;
    let reply = client.receive().await.map_err(remote)?;
    if reply.kind != 14 {
        return Err(unexpected());
    }
    let (file, token) = reply.decode()?;
    Ok(Link {
        address: server.into(),
        file,
        token,
    })
}

fn conflict(message: &str) -> EngineError {
    EngineError::new("collaboration_conflict", message)
}
fn unexpected() -> EngineError {
    EngineError::new(
        "collaboration_error",
        "Unexpected FigCraft collaboration response",
    )
}
fn remote(mut error: EngineError) -> EngineError {
    if error.code == "collaboration_error" {
        if error.message.to_ascii_lowercase().starts_with("too many") {
            return EngineError::new(
                "rate_limited",
                "FigCraft server temporarily limited requests from this address",
            );
        }
        error.message = "FigCraft server refused or interrupted the request".into();
    }
    error
}
fn access_name(access: Access) -> &'static str {
    match access {
        Access::Edit => "edit",
        Access::View => "view",
        Access::Comment => "comment",
    }
}
async fn admin(client: &mut FigcraftServer, request: Admin<'_>) -> Result<AdminReply> {
    client.send(6, &request).await.map_err(remote)?;
    read_admin(client).await
}
async fn read_admin(client: &mut FigcraftServer) -> Result<AdminReply> {
    let reply = client.receive().await.map_err(remote)?;
    if reply.kind != 8 {
        return Err(unexpected());
    }
    match reply.decode()? {
        AdminReply::Failed { .. } => Err(EngineError::new(
            "collaboration_error",
            "FigCraft server rejected the file operation",
        )),
        reply => Ok(reply),
    }
}

fn native_document(id: &str) -> String {
    uuid::Uuid::parse_str(id)
        .map(|uuid| format!("doc_{}", uuid.simple()))
        .unwrap_or_else(|_| id.into())
}
fn external_document(id: &str) -> String {
    id.strip_prefix("doc_")
        .and_then(|id| uuid::Uuid::parse_str(id).ok())
        .map_or_else(|| id.to_owned(), |id| id.to_string())
}

pub(crate) fn library_edit_link(app: &App, document: &str) -> Option<String> {
    let room = app
        .online
        .rooms
        .lock()
        .unwrap()
        .get(&native_document(document))
        .cloned()?;
    let status = room.status.lock().unwrap();
    (status["status"] == "live" && status["access"] == "edit").then(|| room.link.canonical())
}

async fn signal(room: &Room, kind: &'static str, text: String) -> Result<()> {
    room.requests
        .send(Request::Signal(kind, text))
        .await
        .map_err(|_| unexpected())
}
fn follow(room: &Room, client: Option<&str>) -> Result<()> {
    let mut status = room.status.lock().unwrap();
    if let Some(client) = client
        && !status["peers"]
            .as_array()
            .into_iter()
            .flatten()
            .any(|peer| peer["id"] == client)
    {
        return Err(EngineError::invalid("the peer is not in this room"));
    }
    status["follow"] = json!(client);
    if client.is_some() {
        status["spotlighting"] = json!(false);
    }
    Ok(())
}
fn native_status(room: &Room) -> Value {
    let state = room.status.lock().unwrap();
    let mode = if state["status"] == "live" {
        "connected"
    } else {
        "disconnected"
    };
    let mut participants = state["peers"].as_array().cloned().unwrap_or_default();
    participants.insert(
        0,
        json!({"id":state["me"],"name":state["name"],"isSelf":true,
        "spotlighting":state["spotlighting"]==true}),
    );
    json!({"ok":true,"mode":mode,"documentId":state["document"],"participants":participants,
        "readOnly":state["readOnly"],"invite":state["link"],"follow":state["follow"],"spotlighting":state["spotlighting"]==true})
}
async fn update_presence(room: &Room, cursor: &Value, viewport: &Value) -> Result<()> {
    let presence = {
        let checkpoint = room.checkpoint.lock().unwrap();
        let page_id = |page: &Value| {
            let id = page.as_str()?;
            checkpoint
                .pages
                .iter()
                .find_map(|(wire, native)| (native == id).then_some(*wire))
        };
        let number = |value: &Value| {
            value
                .as_f64()
                .filter(|value| value.is_finite() && value.abs() <= 10_000_000.)
        };
        let cursor = (|| {
            Some((
                page_id(&cursor["page"])?,
                number(&cursor["x"])?,
                number(&cursor["y"])?,
            ))
        })();
        let viewport = (|| {
            let [page, x, y, w, h] = viewport.as_array()?.as_slice() else {
                return None;
            };
            Some((
                page_id(page)?,
                number(x)?,
                number(y)?,
                number(w)?.max(1.),
                number(h)?.max(1.),
            ))
        })();
        live::Presence::points(cursor, viewport)
    };
    room.requests
        .send(Request::Presence(presence))
        .await
        .map_err(|_| unexpected())
}
pub(crate) async fn native_collaboration(app: &App, session: &str, args: Value) -> Result<Value> {
    app.workspace.session(session)?;
    let action = crate::string(&args, "action")?;
    if action == "join"
        && let Some(invite) = args["invite"].as_str()
        && (crate::team_library::is_link(invite) || parse_code(invite).is_some())
    {
        let status = command(
            app,
            session,
            "collab.join",
            &json!({"command":"collab.join","params":{"link":invite}}),
        )
        .await?;
        let document = native_document(status["document"].as_str().unwrap_or_default());
        let room = app
            .online
            .rooms
            .lock()
            .unwrap()
            .get(&document)
            .cloned()
            .ok_or_else(unexpected)?;
        return Ok(native_status(&room));
    }
    let room = args["documentId"].as_str().and_then(|id| {
        app.online
            .rooms
            .lock()
            .unwrap()
            .get(&native_document(id))
            .cloned()
    });
    let Some(room) = room else {
        return app.collaboration.call(session, args).await;
    };
    match action {
        "status" | "invite" => Ok(native_status(&room)),
        "cursor" => {
            update_presence(&room, &args["cursor"], &args["viewport"]).await?;
            Ok(native_status(&room))
        }
        "chat" => {
            let text = args["text"]
                .as_str()
                .filter(|text| text.chars().count() <= 100)
                .ok_or_else(|| EngineError::invalid("cursor chat is limited to 100 characters"))?;
            signal(&room, "chat", text.into()).await?;
            Ok(json!({"chat":text}))
        }
        "follow" => {
            follow(&room, args["client"].as_str()).map(|()| json!({"follow":args["client"]}))
        }
        "leave" | "reconnect" | "removePerson" => {
            let name = format!("collab.{action}");
            let args = json!({"command":name,"document":args["documentId"],
                "params":if action=="removePerson" {json!({"client":args["client"]})} else {json!({})}});
            let result = command(app, session, &name, &args).await?;
            if action == "reconnect" {
                Ok(native_status(&room))
            } else {
                Ok(result)
            }
        }
        _ => Err(conflict(
            "leave the online room before starting a local room",
        )),
    }
}
