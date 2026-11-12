use super::*;
use crate::figcraft_server::open_hosting;
use omc_protocol::decode_json_with_limit;
use std::{io::Read, path::PathBuf};
use wire::{Document, NewLink};

const MAX_FILES: usize = 200;
const LEDGER_LIMIT: usize = 1024 * 1024;

pub(super) fn validate(command: &str, params: &Value) -> Result<()> {
    let string = |max| json!({"type":"string","minLength":1,"maxLength":max});
    let server = string(2048);
    let file = string(256);
    let text = string(256);
    let access = json!({"type":"string","enum":["edit","view","comment"]});
    let (properties, required) = match command {
        "collab.publish" => (
            json!({"server":server,"key":text,"name":text}),
            vec!["server"],
        ),
        "collab.share" => (
            json!({"server":server,"key":text,"name":text,"via":{"const":"online"},"access":access}),
            vec![],
        ),
        "collab.join" => (json!({"link":server,"code":server}), vec![]),
        "collab.files" => (json!({"refresh":{"type":"boolean"}}), vec![]),
        "collab.openFile" | "collab.forgetFile" => {
            (json!({"file":file,"server":server}), vec!["file"])
        }
        "collab.manageFile" => (
            json!({"file":file,"server":server,"owner":text,"action":{
            "type":"string","enum":["links","createLink","revoke","share","unshare","rename","remove"]},
            "access":access,"name":text,"label":text,"link":text}),
            vec!["file", "action"],
        ),
        "collab.recoverFile" => {
            let number = json!({"anyOf":[{"type":"integer","minimum":0},{"type":"string","pattern":"^[0-9]{1,20}$"}]});
            (
                json!({"file":file,"server":server,"path":string(32768),"session":number,
                "client":number,"seq":number,"secret":number}),
                vec!["path", "file", "session", "client", "seq"],
            )
        }
        "collab.cursor" => (
            json!({"x":{"type":"number","minimum":-10000000,"maximum":10000000},
            "y":{"type":"number","minimum":-10000000,"maximum":10000000}}),
            vec![],
        ),
        "collab.cursorChat" => (json!({"text":{"type":"string","maxLength":100}}), vec![]),
        "collab.follow" => (json!({"client":text}), vec![]),
        "collab.spotlight" => (json!({"on":{"type":"boolean"}}), vec![]),
        "collab.report" => (json!({"reason":string(500)}), vec!["reason"]),
        "collab.leave" => (json!({"session":text}), vec![]),
        "collab.removePerson" => (
            json!({"client":{"anyOf":[text,{"type":"integer","minimum":1,"maximum":4294967295_u64}]}}),
            vec!["client"],
        ),
        _ => (json!({}), vec![]),
    };
    omc_mcp::schema::check(
        &json!({"type":"object","properties":properties,"required":required,"additionalProperties":false}),
        params,
        "params",
    )
}

fn ledger(app: &App) -> PathBuf {
    app.workspace
        .profile
        .join("native-v1/figcraft-online-files.json")
}

fn load(app: &App) -> Result<Vec<Publication>> {
    let file = match std::fs::File::open(ledger(app)) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(crate::io_error(error)),
    };
    let mut bytes = Vec::new();
    file.take((LEDGER_LIMIT + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(crate::io_error)?;
    serde_json::from_value(decode_json_with_limit(&bytes, LEDGER_LIMIT)?).map_err(|_| unexpected())
}

fn change_ledger<T>(
    app: &App,
    change: impl FnOnce(&mut Vec<Publication>) -> Result<T>,
) -> Result<T> {
    let _guard = app.online.files.lock().unwrap();
    let mut items = load(app)?;
    let result = change(&mut items)?;
    let bytes = serde_json::to_vec(&items).map_err(|_| unexpected())?;
    if bytes.len() > LEDGER_LIMIT {
        return Err(EngineError::new(
            "resource_limit",
            "online file ledger is too large",
        ));
    }
    crate::publish_private(&ledger(app), &bytes)?;
    Ok(result)
}

fn key_and_server(app: &App, params: &Value) -> Result<(String, Option<String>)> {
    let mut key = params["key"].as_str().map(str::to_owned);
    let explicit = params["server"]
        .as_str()
        .map(|server| {
            let mut url = reqwest::Url::parse(server)
                .map_err(|_| EngineError::invalid("invalid FigCraft server address"))?;
            for (name, value) in url.query_pairs() {
                if name != "key" || key.is_some() || value.is_empty() || value.len() > 256 {
                    return Err(EngineError::invalid(
                        "invalid FigCraft server key parameter",
                    ));
                }
                key = Some(value.into_owned());
            }
            url.set_query(None);
            Ok::<String, EngineError>(url.into())
        })
        .transpose()?;
    let address = app.router.fig_resolve_publish_server(explicit.as_deref())?;
    Ok((address, key))
}

pub(super) async fn publish(
    app: &App,
    caller: &str,
    document: &str,
    page: String,
    params: &Value,
) -> Result<Arc<Room>> {
    let (server, key) = key_and_server(app, params)?;
    if load(app)?.len() >= MAX_FILES {
        return Err(EngineError::new(
            "resource_limit",
            "too many online files in this profile",
        ));
    }
    let snapshot = app.workspace.snapshot(document)?;
    let mut ids = BTreeMap::new();
    let archive = omc_mcp::encode_wire_document(&snapshot, &page, &mut ids, 0)?;
    let doc = Document::from_archive(&archive)?;
    let name = params["name"].as_str().unwrap_or(&snapshot.title);
    let mut client = match key.as_deref() {
        Some(key) => keyed(&server, key).await?,
        None => {
            let (client, info) = open_hosting(&server, "", "", LIMIT).await.map_err(remote)?;
            if !info.open {
                return Err(conflict("FigCraft server requires a publishing key"));
            }
            client
        }
    };
    let (file, edit, view, owner, expires) = match admin(
        &mut client,
        Admin::Publish {
            name,
            snapshot: doc.snapshot(),
        },
    )
    .await?
    {
        AdminReply::Published { file, edit, view } => (file, edit, view, None, None),
        AdminReply::Hosted {
            file,
            edit,
            view,
            owner,
            expires,
        } => (file, edit, view, Some(owner), expires),
        _ => return Err(unexpected()),
    };
    let publication = Publication {
        edit: invite(&server, &edit),
        view: invite(&server, &view),
        server,
        file: file.id,
        name: file.name,
        owner,
        expires,
        key,
        created: file.created,
        share: None,
    };
    if let Err(error) = change_ledger(app, |items| {
        items.insert(0, publication.clone());
        Ok(())
    }) {
        if let Ok(mut owner) = manage(&publication).await {
            let _ = done(
                &mut owner,
                Admin::Remove {
                    file: &publication.file,
                },
            )
            .await;
        }
        return Err(error);
    }
    let link = Link::parse(&publication.edit)?;
    let (_, room) = live::join(
        app,
        caller,
        &link,
        live::Attach::Publish(snapshot, page, ids),
        Some(publication),
    )
    .await?;
    Ok(room)
}

fn invite(server: &str, link: &NewLink) -> String {
    Link {
        address: server.into(),
        file: link.link.file.clone(),
        token: link.token.clone(),
    }
    .canonical()
}

async fn keyed(server: &str, key: &str) -> Result<FigcraftServer> {
    let mut client = FigcraftServer::connect(server, LIMIT).await?;
    client
        .send(5, &(PROTOCOL, key, "0.17.0 comments"))
        .await
        .map_err(remote)?;
    if !matches!(read_admin(&mut client).await?, AdminReply::Ready) {
        return Err(unexpected());
    }
    Ok(client)
}
async fn manage(item: &Publication) -> Result<FigcraftServer> {
    match (&item.owner, &item.key) {
        (Some(owner), _) => Ok(open_hosting(&item.server, &item.file, owner, LIMIT)
            .await
            .map_err(remote)?
            .0),
        (_, Some(key)) => keyed(&item.server, key).await,
        _ => Err(conflict(
            "an owner token or server publishing key is required",
        )),
    }
}

fn access(value: &Value, fallback: Access) -> Access {
    match value.as_str() {
        Some("edit") => Access::Edit,
        Some("view") => Access::View,
        Some("comment") => Access::Comment,
        _ => fallback,
    }
}
async fn create_link(
    client: &mut FigcraftServer,
    file: &str,
    access: Access,
    label: &str,
) -> Result<NewLink> {
    match admin(
        client,
        Admin::CreateLink {
            file,
            access,
            label,
        },
    )
    .await?
    {
        AdminReply::Link(link) => Ok(link),
        _ => Err(unexpected()),
    }
}
async fn done(client: &mut FigcraftServer, action: Admin<'_>) -> Result<()> {
    if matches!(admin(client, action).await?, AdminReply::Done) {
        Ok(())
    } else {
        Err(unexpected())
    }
}
async fn code(client: &mut FigcraftServer, file: &str, token: &str) -> Result<String> {
    match admin(client, Admin::Code { file, token }).await? {
        AdminReply::Code { code } => Ok(code),
        _ => Err(unexpected()),
    }
}

#[derive(Clone, Serialize, Deserialize)]
pub(super) struct Share {
    access: Access,
    grants: Vec<ShareGrant>,
}

#[derive(Clone, Serialize, Deserialize)]
struct ShareGrant {
    id: String,
    access: Access,
    link: String,
    code: Option<String>,
}

fn same_file(left: &Publication, right: &Publication) -> bool {
    left.file == right.file && left.server == right.server
}

pub(super) fn published_status(item: &Publication) -> Value {
    json!({"server":item.server,"file":item.file,"name":item.name,"edit":item.edit,
        "view":item.view,"owner":item.owner,"expires":item.expires,"created":item.created})
}

pub(super) fn saved_share(app: &App, item: &Publication) -> Result<Option<Share>> {
    let items = load(app)?;
    Ok(items
        .into_iter()
        .find(|found| same_file(found, item))
        .and_then(|found| found.share))
}

pub(super) fn set_share_status(status: &mut Value, share: Option<&Share>) {
    status["code"] = Value::Null;
    status["share"] = share.map_or(Value::Null, |share| {
        let mut data = json!({"via":"online","shared":!share.grants.is_empty(),
            "access":access_name(share.access)});
        for grant in &share.grants {
            let prefix = access_name(grant.access);
            data[format!("{prefix}Link")] = json!(grant.link);
            data[format!("{prefix}Code")] = json!(grant.code);
            if grant.access == share.access {
                status["code"] = json!(grant.code);
            }
        }
        data
    });
}

fn save_share(app: &App, item: &Publication, share: &Share) -> Result<()> {
    change_ledger(app, |items| {
        let found = items
            .iter_mut()
            .find(|found| same_file(found, item))
            .ok_or_else(|| conflict("the online file is no longer recorded"))?;
        found.share = Some(share.clone());
        Ok(())
    })?;
    if let Some((_, room)) = find_room(app, item) {
        set_share_status(&mut room.status.lock().unwrap(), Some(share));
    }
    Ok(())
}

pub(super) async fn share(app: &App, room: &Room, params: &Value) -> Result<()> {
    let _guard = app.online.share_operations.lock().await;
    let item = room
        .publication
        .as_ref()
        .ok_or_else(|| conflict("only the file owner can share it"))?;
    let level = access(&params["access"], Access::Edit);
    let mut share = saved_share(app, item)?.unwrap_or(Share {
        access: level,
        grants: Vec::new(),
    });
    share.access = level;
    if share.grants.len() != 3 || share.grants.iter().any(|grant| grant.code.is_none()) {
        let mut client = manage(item).await?;
        for level in [Access::Edit, Access::View, Access::Comment] {
            let index = match share.grants.iter().position(|grant| grant.access == level) {
                Some(index) => index,
                None => {
                    let link =
                        create_link(&mut client, &item.file, level, "Oh My Canvas share").await?;
                    share.grants.push(ShareGrant {
                        id: link.link.id.clone(),
                        access: level,
                        link: invite(&item.server, &link),
                        code: None,
                    });
                    if let Err(error) = save_share(app, item, &share) {
                        let _ = done(
                            &mut client,
                            Admin::Revoke {
                                file: &item.file,
                                link: &link.link.id,
                            },
                        )
                        .await;
                        return Err(error);
                    }
                    share.grants.len() - 1
                }
            };
            if share.grants[index].code.is_none() {
                let link = Link::parse(&share.grants[index].link)?;
                share.grants[index].code = Some(code(&mut client, &item.file, &link.token).await?);
                save_share(app, item, &share)?;
            }
        }
    }
    save_share(app, item, &share)
}

pub(super) async fn stop_share(app: &App, room: &Room) -> Result<bool> {
    let _guard = app.online.share_operations.lock().await;
    let Some(item) = room.publication.as_ref() else {
        return Ok(false);
    };
    let Some(mut share) = saved_share(app, item)? else {
        return Ok(false);
    };
    if !share.grants.is_empty() {
        let mut client = manage(item).await?;
        let links = match admin(&mut client, Admin::Links { file: &item.file }).await? {
            AdminReply::Links(links) => links,
            _ => return Err(unexpected()),
        };
        while let Some(grant) = share.grants.last() {
            if links.iter().any(|link| link.id == grant.id) {
                done(
                    &mut client,
                    Admin::Revoke {
                        file: &item.file,
                        link: &grant.id,
                    },
                )
                .await?;
            }
            share.grants.pop();
            save_share(app, item, &share)?;
        }
    }
    Ok(true)
}

pub(super) async fn remove_peer(_app: &App, room: &Room, params: &Value) -> Result<Value> {
    let item = room
        .publication
        .as_ref()
        .ok_or_else(|| conflict("only the owner can remove a peer"))?;
    let client = params["client"]
        .as_u64()
        .or_else(|| params["client"].as_str()?.parse().ok())
        .and_then(|number| u32::try_from(number).ok())
        .ok_or_else(|| EngineError::invalid("invalid FigCraft peer id"))?;
    let name = room.status.lock().unwrap()["peers"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|peer| peer["id"] == client.to_string())
        .map(|peer| peer["name"].clone())
        .ok_or_else(|| EngineError::invalid("FigCraft peer not found"))?;
    let mut connection = manage(item).await?;
    done(
        &mut connection,
        Admin::RemovePeer {
            file: &item.file,
            client,
        },
    )
    .await?;
    Ok(json!({"removed":true,"name":name}))
}

fn select(app: &App, params: &Value) -> Result<Publication> {
    let file = params["file"].as_str().unwrap_or_default();
    let server = params["server"]
        .as_str()
        .map(omc_mcp::normalize_figcraft_endpoint)
        .transpose()?;
    let mut found = load(app)?.into_iter().filter(|item| {
        item.file == file
            && server
                .as_ref()
                .is_none_or(|server| server.as_str() == item.server)
    });
    let result = found.next().ok_or_else(|| {
        EngineError::new("not_found", "online file is not recorded in this profile")
    })?;
    if found.next().is_some() {
        return Err(EngineError::invalid(
            "specify the server for this online file",
        ));
    }
    Ok(result)
}
fn find_room(app: &App, item: &Publication) -> Option<(String, Arc<Room>)> {
    app.online
        .rooms
        .lock()
        .unwrap()
        .iter()
        .find(|(_, room)| {
            room.publication
                .as_ref()
                .is_some_and(|p| p.file == item.file && p.server == item.server)
        })
        .map(|(id, room)| (id.clone(), room.clone()))
}
pub(super) async fn command(app: &App, session: &str, name: &str, params: &Value) -> Result<Value> {
    if name == "collab.files" {
        return list(app, params["refresh"] == true).await;
    }
    let mut item = match select(app, params) {
        Ok(item) => item,
        Err(error) if name == "collab.manageFile" && error.code == "not_found" => {
            let server = params["server"].as_str().ok_or(error)?;
            Publication {
                server: omc_mcp::normalize_figcraft_endpoint(server)?.into(),
                file: params["file"].as_str().unwrap_or_default().into(),
                owner: params["owner"].as_str().map(str::to_owned),
                key: None,
                name: String::new(),
                edit: String::new(),
                view: String::new(),
                expires: None,
                created: 0,
                share: None,
            }
        }
        Err(error) => return Err(error),
    };
    if let Some(owner) = params["owner"].as_str() {
        item.owner = Some(owner.into());
    }
    let active = find_room(app, &item);
    if name == "collab.recoverFile" {
        return recover(app, session, &item, params).await;
    }
    if name == "collab.openFile" {
        let _guard = app.online.changes.lock().await;
        let (id, room, already) = match find_room(app, &item) {
            Some((id, room)) if room.status.lock().unwrap()["status"] == "live" => (id, room, true),
            _ => {
                let link = Link::parse(&item.edit)?;
                let (id, room) =
                    live::join(app, session, &link, live::Attach::Fresh, Some(item.clone()))
                        .await?;
                (id, room, false)
            }
        };
        bind(app, session, &id)?;
        let status = room.status.lock().unwrap();
        return Ok(
            json!({"document":status["document"],"session":status["session"],"status":status["status"],
            "alreadyOpen":already,"file":item.file,"server":item.server,"name":item.name}),
        );
    }
    if name == "collab.forgetFile" {
        let _guard = app.online.share_operations.lock().await;
        if find_room(app, &item).is_some() {
            return Err(conflict("leave the online file before forgetting it"));
        }
        forget(app, &item)?;
        return Ok(json!({"forgotten":true,"file":item.file,"server":item.server,"onServer":true}));
    }
    let action = params["action"].as_str().unwrap_or_default();
    if matches!(action, "share" | "unshare") {
        let (_, room) =
            active.ok_or_else(|| conflict("open the online file before changing sharing"))?;
        if action == "unshare" {
            stop_share(app, &room).await?;
            return Ok(json!({"shared":false}));
        }
        share(app, &room, params).await?;
        let state = room.status.lock().unwrap();
        let mut data = state["share"].clone();
        data["code"] = state["code"].clone();
        return Ok(data);
    }
    let _share_guard = app.online.share_operations.lock().await;
    let mut client = manage(&item).await?;
    let file = &item.file;
    match action {
        "links" => match admin(&mut client, Admin::Links { file }).await? {
            AdminReply::Links(links) => Ok(json!({"links":links.iter().map(|link|json!({
                "id":link.id,"access":access_name(link.access),"label":link.label,"created":link.created
            })).collect::<Vec<_>>()})),
            _ => Err(unexpected()),
        },
        "createLink" => {
            let level = access(&params["access"], Access::View);
            let link = create_link(
                &mut client,
                file,
                level,
                params["label"].as_str().unwrap_or(""),
            )
            .await?;
            Ok(
                json!({"id":link.link.id,"access":access_name(level),"link":invite(&item.server,&link)}),
            )
        }
        "revoke" => {
            let link = crate::string(params, "link")?;
            done(&mut client, Admin::Revoke { file, link }).await?;
            if let Some(mut share) = saved_share(app, &item)?
                && share.grants.iter().any(|grant| grant.id == link)
            {
                share.grants.retain(|grant| grant.id != link);
                save_share(app, &item, &share)?;
            }
            Ok(json!({"done":true}))
        }
        "rename" => {
            let name = crate::string(params, "name")?;
            done(&mut client, Admin::Rename { file, name }).await?;
            change_ledger(app, |items| {
                if let Some(found) = items
                    .iter_mut()
                    .find(|p| p.file == item.file && p.server == item.server)
                {
                    found.name = name.into();
                }
                Ok(())
            })?;
            Ok(json!({"done":true}))
        }
        "remove" => {
            done(&mut client, Admin::Remove { file }).await?;
            if let Some((id, room)) = active {
                app.online.rooms.lock().unwrap().remove(&id);
                let _ = room.cancel.send(true);
                app.workspace.set_room_read_only(&id, false);
            }
            forget(app, &item)?;
            Ok(json!({"done":true}))
        }
        _ => Err(EngineError::invalid("unknown online file action")),
    }
}
fn forget(app: &App, item: &Publication) -> Result<()> {
    change_ledger(app, |items| {
        items.retain(|p| p.file != item.file || p.server != item.server);
        Ok(())
    })
}

async fn list(app: &App, refresh: bool) -> Result<Value> {
    let items = load(app)?;
    let mut by_server = BTreeMap::<String, Vec<&Publication>>::new();
    let mut states = BTreeMap::new();
    let mut problems = Vec::new();
    let configured = app
        .router
        .fig_resolve_publish_server(None)
        .ok()
        .filter(|server| server != omc_workspace::ProfilePreferences::DEFAULT_PUBLISH_SERVER);
    let mut team = app.online.team.lock().unwrap().clone();
    if team["server"].as_str() != configured.as_deref() {
        team = Value::Null;
    }
    if refresh {
        for item in &items {
            if item.owner.is_some() {
                by_server.entry(item.server.clone()).or_default().push(item);
            }
        }
        for item in items
            .iter()
            .filter(|item| item.owner.is_none() && item.key.is_some())
        {
            let response = async {
                let mut client = manage(item).await?;
                match admin(&mut client, Admin::Files).await? {
                    AdminReply::Files(files) => Ok(files
                        .into_iter()
                        .find(|file| file.id == item.file)
                        .map(|file| (file.name, None))),
                    _ => Err(unexpected()),
                }
            }
            .await;
            match response {
                Ok(value) => {
                    states.insert((item.server.clone(), item.file.clone()), value);
                }
                Err(error) => problems
                    .push(json!({"server":item.server,"state":"offline","reason":error.message})),
            }
        }
        for (server, group) in by_server {
            let response = async {
                let (mut client, _) = open_hosting(&server, "", "", LIMIT).await.map_err(remote)?;
                let files = group
                    .iter()
                    .map(|item| {
                        (
                            item.file.as_str(),
                            item.owner.as_deref().unwrap_or_default(),
                        )
                    })
                    .collect();
                match admin(&mut client, Admin::Owned { files }).await? {
                    AdminReply::Owned(values) if values.len() == group.len() => Ok(values),
                    _ => Err(unexpected()),
                }
            }
            .await;
            match response {
                Ok(values) => {
                    for (item, value) in group.into_iter().zip(values) {
                        states.insert(
                            (item.server.clone(), item.file.clone()),
                            value.map(|file| (file.name, file.expires)),
                        );
                    }
                }
                Err(error) => {
                    problems.push(json!({"server":server,"state":"offline","reason":error.message}))
                }
            }
        }
        if let Some(server) = configured {
            let response = async {
                let (mut client,_) = open_hosting(&server,"","",LIMIT).await.map_err(remote)?;
                match admin(&mut client,Admin::Team).await? {
                    AdminReply::Team {web,files}=>{
                        let web = reqwest::Url::parse(&web).ok().filter(|url| matches!(url.scheme(),"https"|"http")
                            && url.fragment().is_none() && url.username().is_empty() && url.password().is_none());
                        let files = files.into_iter().filter(|item|team_file_id(&item.file.id)).take(500).map(|item| {
                            let mut link = reqwest::Url::parse("figcraft://join").expect("constant URL");
                            link.query_pairs_mut().append_pair("server",&server).append_pair("file",&item.file.id).append_pair("team","1");
                            let web_link = web.as_ref().map(|base| {
                                let mut url=base.clone();
                                let fragment = reqwest::Url::parse("https://localhost/?").expect("constant URL")
                                    .query_pairs_mut().append_pair("join",link.as_str()).finish().query().unwrap_or_default().to_owned();
                                url.set_fragment(Some(&fragment));
                                url.to_string()
                            });
                            json!({"file":item.file.id,"name":item.file.name,"updated":item.file.updated,
                                "people":item.file.people,"access":access_name(item.access),"link":link.as_str(),"webLink":web_link})
                        }).collect::<Vec<_>>();
                        Ok(json!({"server":server,"state":if files.is_empty() {"none"} else {"listed"},
                            "web":web.map(|url|url.to_string()),"files":files}))
                    }
                    _=>Err(unexpected()),
                }
            }.await;
            team = response.unwrap_or_else(
                |error| json!({"server":server,"state":"offline","reason":error.message}),
            );
            *app.online.team.lock().unwrap() = team.clone();
        }
    }
    let data = items.iter().map(|item| {
        let key = (item.server.clone(),item.file.clone());
        let mut state = "unknown";
        let mut name = &item.name;
        let mut expires = item.expires;
        if let Some(update) = states.get(&key) {
            if let Some((remote_name, remote_expires)) = update {
                state = "online";
                name = remote_name;
                expires = *remote_expires;
            } else {state = "gone";}
        }
        let status = find_room(app,item).map(|(_,room)|room.status.lock().unwrap().clone()).unwrap_or(Value::Null);
        json!({"server":item.server,"host":reqwest::Url::parse(&item.server).ok().and_then(|url|url.host_str().map(str::to_owned)),
            "file":item.file,"name":name,"created":item.created,"expires":expires,"state":state,
            "shared":item.share.as_ref().is_some_and(|share| !share.grants.is_empty()),
            "session":status["session"],"document":status["document"],"hasOwnerToken":item.owner.is_some()})
    }).collect::<Vec<_>>();
    Ok(json!({"files":data,"problems":problems,"max":MAX_FILES,"team":team}))
}

async fn recover(app: &App, caller: &str, item: &Publication, params: &Value) -> Result<Value> {
    let _guard = app.online.changes.lock().await;
    if find_room(app, item).is_some_and(|(_, room)| room.status.lock().unwrap()["status"] == "live")
    {
        return Err(conflict("leave the live file before recovering a copy"));
    }
    let number = |key: &str| {
        params[key]
            .as_u64()
            .or_else(|| params[key].as_str()?.parse().ok())
            .ok_or_else(|| EngineError::invalid(format!("{key} must be an unsigned integer")))
    };
    let at = live::Resume {
        session: number("session")?,
        client_id: u32::try_from(number("client")?)
            .map_err(|_| EngineError::invalid("invalid client id"))?,
        seq: number("seq")?,
        secret: if params.get("secret").is_some() {
            number("secret")?
        } else {
            0
        },
    };
    let path = crate::string(params, "path")?.to_owned();
    let archive = tokio::task::spawn_blocking(move || omc_mcp::read_recovery_archive(&path))
        .await
        .map_err(|_| unexpected())??;
    let recovery = Document::from_archive(&archive)?;
    let (mut copy, _) =
        omc_mcp::decode_wire_document(&archive, &mut BTreeMap::new(), &mut BTreeMap::new())?;
    let link = Link::parse(&item.edit)?;
    let joined = live::join(
        app,
        caller,
        &link,
        live::Attach::Recover(at),
        Some(item.clone()),
    )
    .await;
    let (id, room) = match joined {
        Ok(joined) => joined,
        Err(error) => {
            let saved = app
                .workspace
                .create(caller, &copy.title.clone(), Some(copy))?;
            bind(app, caller, &saved.id)?;
            return Ok(
                json!({"status":"recoveredCopy","document":external_document(&saved.id),"reason":error.message}),
            );
        }
    };
    bind(app, caller, &id)?;
    let checkpoint = room.checkpoint.lock().unwrap().clone();
    let mut ids = checkpoint
        .nodes
        .iter()
        .map(|(id, native)| (native.clone(), *id as usize))
        .collect();
    let online = Document::from_archive(&omc_mcp::encode_wire_document(
        &checkpoint.snapshot,
        &checkpoint.page,
        &mut ids,
        checkpoint.resume.client_id,
    )?)?;
    let ahead = online.changes_to(&recovery)?;
    let outcome = if ahead.is_empty() {
        "alreadySynced"
    } else if checkpoint.resume == at && room.status.lock().unwrap()["access"] == "edit"
        && ahead.iter().all(|change| !matches!(change,wire::Change::Create { id,.. } if *id >> 32 != u64::from(at.client_id)))
    {
        let mut nodes = checkpoint.nodes.clone();
        let mut pages = checkpoint.pages.clone();
        let (mut recovered,_) = omc_mcp::decode_wire_document(&archive,&mut nodes,&mut pages)?;
        for (id,node) in &mut recovered.nodes {
            if let Some(existing) = checkpoint.snapshot.nodes.get(id) {node.home_shard.clone_from(&existing.home_shard);}
        }
        live::pin_comment_authorship(&mut recovered,Some(&checkpoint.snapshot),&room.mirror);
        app.router.fig_online_apply(caller,&room.mirror,&checkpoint.snapshot,&recovered)?;
        "replayed"
    } else {
        let mut title = copy.title.chars().take(55).collect::<String>();
        title.push_str(" (recovered copy)");
        copy.title=title.clone();
        let saved = app.workspace.create(caller,&title,Some(copy))?;
        bind(app,caller,&saved.id)?;
        bind(app,caller,&id)?;
        return Ok(json!({"status":"live","document":external_document(&id),
            "session":room.status.lock().unwrap()["session"],"recovery":"separateCopy","copy":external_document(&saved.id)}));
    };
    Ok(
        json!({"status":"live","document":external_document(&id),"session":room.status.lock().unwrap()["session"],"recovery":outcome}),
    )
}
