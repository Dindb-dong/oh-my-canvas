//! Team library operations against the official FigCraft v0.17 server.
use crate::{
    App,
    figcraft_online::wire::{Admin, AdminReply, Document},
    figcraft_server::{FigcraftServer, PROTOCOL},
};
use omc_protocol::{EngineError, Result};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeMap;

const MANAGE: u8 = 5;
const ADMIN_REQUEST: u8 = 6;
const ADMIN_REPLY: u8 = 8;
const OPEN_LIBRARY: u8 = 7;
const LIBRARY_REQUEST: u8 = 8;
const LIBRARY_REPLY: u8 = 9;
const FRAME_LIMIT: usize = 17 * 1024 * 1024;

#[derive(Serialize)]
struct Manage<'a> {
    protocol: u32,
    key: &'a str,
    client_version: &'a str,
}

#[derive(Serialize)]
struct OpenLibrary<'a> {
    protocol: u32,
    file: &'a str,
    token: &'a str,
    client_version: &'a str,
}

#[derive(Serialize)]
enum Request {
    Fetch {
        have: Option<u64>,
        usage: Option<Usage>,
    },
    Publish {
        archive: Vec<u8>,
    },
    Usage,
    #[allow(dead_code)]
    ReportDetached(Usage),
    Detached,
    #[allow(dead_code)]
    ReportInserted(Usage),
    Actions,
    ReportAssets(AssetUsage),
    Assets,
}

#[derive(Serialize, Deserialize)]
struct Usage {
    file: String,
    components: Vec<(u64, u32)>,
}

#[derive(Deserialize)]
struct FileUsage {
    usage: Usage,
    updated: u64,
}

#[derive(Deserialize)]
struct FileDetached {
    detached: Usage,
    #[allow(dead_code)]
    updated: u64,
}

#[derive(Deserialize)]
struct WeekActions {
    week: u64,
    component: u64,
    insertions: u32,
    detachments: u32,
}

#[derive(Serialize, Deserialize)]
struct AssetUsage {
    file: String,
    styles: Vec<(String, u32)>,
    variables: Vec<(String, u32)>,
}

#[derive(Deserialize, PartialEq)]
enum Access {
    Edit,
    View,
    Comment,
}

#[derive(Deserialize)]
enum Reply {
    Ready { access: Access },
    Library { version: u64, archive: Vec<u8> },
    Unchanged { version: u64 },
    Empty,
    Published { version: u64 },
    Usage(Vec<FileUsage>),
    Failed { reason: String },
    Noted,
    Detached(Vec<FileDetached>),
    Actions(Vec<WeekActions>),
    Assets(Vec<AssetUsage>),
}

#[derive(Clone)]
pub(crate) struct Link {
    pub(crate) address: String,
    pub(crate) file: String,
    pub(crate) token: String,
}

fn malformed() -> EngineError {
    EngineError::invalid("Expected a FigCraft edit or view share link")
}

fn secret(value: &str) -> bool {
    (1..=256).contains(&value.len())
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~'))
}

pub(crate) fn is_link(path: &str) -> bool {
    let path = path.trim_start().to_ascii_lowercase();
    ["figcraft://", "ws://", "wss://"]
        .iter()
        .any(|prefix| path.starts_with(prefix))
}

impl Link {
    pub(crate) fn parse(value: &str) -> Result<Self> {
        let value = value.trim();
        if value.len() > 2048 || value.chars().any(char::is_whitespace) {
            return Err(malformed());
        }
        let mut url = reqwest::Url::parse(value).map_err(|_| malformed())?;
        let (mut file, mut token, mut server, mut host) = (None, None, None, None);
        for (key, value) in url.query_pairs() {
            let target = match key.as_ref() {
                "file" => &mut file,
                "token" => &mut token,
                "server" => &mut server,
                "host" => &mut host,
                _ => return Err(malformed()),
            };
            if target.replace(value.into_owned()).is_some() {
                return Err(malformed());
            }
        }
        let file = file.filter(|file| secret(file)).ok_or_else(malformed)?;
        let token = token.filter(|token| secret(token)).ok_or_else(malformed)?;
        if url.fragment().is_some() || !url.username().is_empty() || url.password().is_some() {
            return Err(malformed());
        }
        let address = match url.scheme() {
            "figcraft" if url.host_str() == Some("join") && matches!(url.path(), "" | "/") => {
                match (server, host) {
                    (Some(server), None) => server,
                    (None, Some(host)) if !host.contains(['/', '\\', '?', '#', '@']) => {
                        format!("ws://{host}/")
                    }
                    _ => return Err(malformed()),
                }
            }
            "ws" | "wss" if server.is_none() && host.is_none() => {
                url.set_query(None);
                url.into()
            }
            _ => return Err(malformed()),
        };
        Ok(Self {
            address,
            file,
            token,
        })
    }

    pub(crate) fn canonical(&self) -> String {
        format!("{}?file={}&token={}", self.address, self.file, self.token)
    }

    async fn connect(&self, edit: bool) -> Result<FigcraftServer> {
        let mut client = FigcraftServer::connect(&self.address, FRAME_LIMIT).await?;
        client
            .send(
                OPEN_LIBRARY,
                &OpenLibrary {
                    protocol: PROTOCOL,
                    file: &self.file,
                    token: &self.token,
                    client_version: env!("CARGO_PKG_VERSION"),
                },
            )
            .await?;
        match receive(&mut client).await? {
            Reply::Ready { access } if !edit || access == Access::Edit => Ok(client),
            Reply::Ready { .. } => Err(EngineError::new(
                "permission_denied",
                "Publishing requires a FigCraft edit link",
            )),
            _ => Err(unexpected()),
        }
    }
}

struct Publisher {
    address: String,
    key: String,
}

impl Publisher {
    fn parse(server: &str, key: Option<&str>) -> Result<Option<Self>> {
        let mut address = reqwest::Url::parse(server.trim()).map_err(|_| malformed())?;
        let pairs = address.query_pairs().collect::<Vec<_>>();
        let inline = pairs
            .iter()
            .find(|(name, _)| name == "key")
            .map(|(_, value)| value.as_ref());
        if key.is_none() && inline.is_none() {
            return Ok(None);
        }
        let key = key
            .or(inline)
            .filter(|value| secret(value))
            .ok_or_else(malformed)?
            .to_owned();
        if pairs.len() > usize::from(inline.is_some())
            || !matches!(address.scheme(), "ws" | "wss")
            || address.fragment().is_some()
            || !address.username().is_empty()
            || address.password().is_some()
        {
            return Err(malformed());
        }
        address.set_query(None);
        Ok(Some(Self {
            address: address.into(),
            key,
        }))
    }

    async fn upload(&self, archive: &omc_mcp::TeamLibraryPublication) -> Result<(Link, Link)> {
        let document = Document::from_archive(&archive.document)?;
        let mut client = FigcraftServer::connect(&self.address, FRAME_LIMIT).await?;
        client
            .send(
                MANAGE,
                &Manage {
                    protocol: PROTOCOL,
                    key: &self.key,
                    client_version: env!("CARGO_PKG_VERSION"),
                },
            )
            .await?;
        if !matches!(admin_reply(&mut client).await?, AdminReply::Ready) {
            return Err(unexpected());
        }
        let name = archive.document["name"].as_str().ok_or_else(unexpected)?;
        client
            .send(
                ADMIN_REQUEST,
                &Admin::Publish {
                    name,
                    snapshot: document.snapshot(),
                },
            )
            .await?;
        let AdminReply::Published { file, edit, view } = admin_reply(&mut client).await? else {
            return Err(unexpected());
        };
        if edit.link.file != file.id
            || view.link.file != file.id
            || !secret(&file.id)
            || !secret(&edit.token)
            || !secret(&view.token)
        {
            return Err(unexpected());
        }
        let link = |token| Link {
            address: self.address.clone(),
            file: file.id.clone(),
            token,
        };
        Ok((link(edit.token), link(view.token)))
    }
}

async fn admin_reply(client: &mut FigcraftServer) -> Result<AdminReply> {
    let reply = client.receive().await?;
    if reply.kind != ADMIN_REPLY {
        return Err(unexpected());
    }
    match reply.decode()? {
        AdminReply::Failed { reason } => Err(EngineError::new("collaboration_error", reason)),
        reply => Ok(reply),
    }
}

async fn publish_archive(
    client: &mut FigcraftServer,
    archive: omc_mcp::TeamLibraryPublication,
) -> Result<Value> {
    client
        .send(
            LIBRARY_REQUEST,
            &Request::Publish {
                archive: archive.archive,
            },
        )
        .await?;
    match receive(client).await? {
        Reply::Published { version } if archive.manifest["version"] == version => {
            Ok(archive.manifest)
        }
        _ => Err(unexpected()),
    }
}

fn unexpected() -> EngineError {
    EngineError::new(
        "collaboration_error",
        "Unexpected reply from FigCraft team library",
    )
}

async fn receive(client: &mut FigcraftServer) -> Result<Reply> {
    let reply = client.receive().await?;
    if reply.kind != LIBRARY_REPLY {
        return Err(unexpected());
    }
    match reply.decode()? {
        Reply::Failed { reason } => Err(EngineError::new("collaboration_error", reason)),
        reply => Ok(reply),
    }
}

async fn fetch(
    client: &mut FigcraftServer,
    usage: Option<Usage>,
) -> Result<Option<(u64, Vec<u8>)>> {
    client
        .send(LIBRARY_REQUEST, &Request::Fetch { have: None, usage })
        .await?;
    match receive(client).await? {
        Reply::Library { version, archive } => Ok(Some((version, archive))),
        Reply::Empty => Ok(None),
        Reply::Unchanged { version } => Err(EngineError::new(
            "collaboration_error",
            format!("Server unexpectedly omitted archive version {version}"),
        )),
        _ => Err(unexpected()),
    }
}

fn validate(command: &str, args: &Value) -> Result<()> {
    omc_mcp::validate_figcraft_tool("run_command", args)?;
    let params = args.get("params").cloned().unwrap_or_else(|| json!({}));
    let str_field = |max| json!({"type":"string","maxLength":max});
    let include = json!({"type":"array","maxItems":200,"items":{"anyOf":[{"type":"string"},{"type":"integer","minimum":1}]}});
    let props = match command {
        "library.add" => json!({"path":str_field(2048)}),
        "library.check" => json!({"library":str_field(2048)}),
        "library.usage" => json!({"library":str_field(2048),"days":{"type":"number"}}),
        "library.publishToServer" => {
            json!({"server":str_field(2048),"key":str_field(256),"description":str_field(2000),
            "include":include,"exclude":include})
        }
        _ => return Err(EngineError::invalid("Unknown team library command")),
    };
    omc_mcp::schema::check(
        &json!({"type":"object","properties":props,"additionalProperties":false}),
        &params,
        "params",
    )
}

async fn fetch_link(link: &Link, usage: Option<Usage>) -> Result<(u64, Vec<u8>)> {
    let mut client = link.connect(false).await?;
    fetch(&mut client, usage)
        .await?
        .ok_or_else(|| EngineError::invalid("This FigCraft file has no published library"))
}

async fn ask(client: &mut FigcraftServer, request: Request) -> Result<Reply> {
    client.send(LIBRARY_REQUEST, &request).await?;
    receive(client).await
}

#[derive(Default)]
struct ComponentUse {
    instances: u64,
    files: u64,
    detached: u64,
    insertions: u64,
    detachments: u64,
}

async fn remote_usage(client: &mut FigcraftServer, library: &Value, days: u64) -> Result<Value> {
    let Reply::Usage(files) = ask(client, Request::Usage).await? else {
        return Err(unexpected());
    };
    let detached = match ask(client, Request::Detached).await {
        Ok(Reply::Detached(rows)) => Some(rows),
        _ => None,
    };
    let actions = match ask(client, Request::Actions).await {
        Ok(Reply::Actions(rows)) => Some(rows),
        _ => None,
    };
    let assets = match ask(client, Request::Assets).await {
        Ok(Reply::Assets(rows)) => Some(rows),
        _ => None,
    };
    let mut by_component = BTreeMap::<u64, ComponentUse>::new();
    let mut detached_by_file = BTreeMap::<&str, u64>::new();
    for report in detached.iter().flatten() {
        let count = detached_by_file.entry(&report.detached.file).or_default();
        for (id, amount) in &report.detached.components {
            *count += u64::from(*amount);
            by_component.entry(*id).or_default().detached += u64::from(*amount);
        }
    }
    let files = files
        .into_iter()
        .map(|file| {
            let mut count = 0;
            for (id, amount) in file.usage.components {
                let amount = u64::from(amount);
                count += amount;
                let summary = by_component.entry(id).or_default();
                summary.instances += amount;
                summary.files += 1;
            }
            json!({"name":file.usage.file,"updated":file.updated,"instances":count,
            "detached":detached_by_file.get(file.usage.file.as_str()).copied().unwrap_or(0)})
        })
        .collect::<Vec<_>>();
    let since = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
        .saturating_sub(days * 86_400);
    let mut weeks = BTreeMap::<u64, (u64, u64)>::new();
    for report in actions
        .iter()
        .flatten()
        .filter(|report| report.week.saturating_add(7 * 86_400) > since)
    {
        let entry = by_component.entry(report.component).or_default();
        let week = weeks.entry(report.week).or_default();
        let (insertions, detachments) =
            (u64::from(report.insertions), u64::from(report.detachments));
        entry.insertions += insertions;
        entry.detachments += detachments;
        week.0 += insertions;
        week.1 += detachments;
    }
    let mut components = by_component.into_iter().collect::<Vec<_>>();
    components.sort_by(|(a, aa), (b, bb)| {
        bb.instances
            .cmp(&aa.instances)
            .then(bb.detached.cmp(&aa.detached))
            .then(a.cmp(b))
    });
    let (instances, detached_count, insertions, detachments) =
        components
            .iter()
            .fold((0, 0, 0, 0), |(i, d, ins, det), (_, entry)| {
                (
                    i + entry.instances,
                    d + entry.detached,
                    ins + entry.insertions,
                    det + entry.detachments,
                )
            });
    let components = components
        .into_iter()
        .map(|(id, entry)| {
            json!({
                "id":id,"name":library["components"][format!("figcraft-{id}")]["name"],
                "instances":entry.instances,"files":entry.files,"detached":entry.detached,
                "insertions":entry.insertions,"detachments":entry.detachments,
            })
        })
        .collect::<Vec<_>>();
    let asset_counts = |section: &str, values: fn(&AssetUsage) -> &Vec<(String, u32)>| {
        let mut counts = BTreeMap::<&str, (u64, u64)>::new();
        for report in assets.iter().flatten() {
            for (id, count) in values(report) {
                let total = counts.entry(id).or_default();
                total.0 += u64::from(*count);
                total.1 += 1;
            }
        }
        let mut counts = counts.into_iter().collect::<Vec<_>>();
        counts.sort_by(|(a, aa), (b, bb)| bb.0.cmp(&aa.0).then(a.cmp(b)));
        counts
            .into_iter()
            .map(|(id, (layers, files))| {
                json!({"id":id,"layers":layers,"files":files,
            "name":library[section][id]["name"],"type":library[section][id]["type"]})
            })
            .collect::<Vec<_>>()
    };
    let weeks = weeks.into_iter().map(|(week,(insertions,detachments))| json!({"week":week,"insertions":insertions,"detachments":detachments})).collect::<Vec<_>>();
    Ok(
        json!({"id":library["id"],"name":library["name"],"scope":"team","instances":instances,
            "detached":detached_count,"detachesKnown":detached.is_some(),"days":days,
            "insertions":insertions,"detachments":detachments,"actionsKnown":actions.is_some(),
            "weeks":weeks,"files":files,"components":components,"assetsKnown":assets.is_some(),
            "styles":asset_counts("styles",|row| &row.styles),"variables":asset_counts("variables",|row| &row.variables),
        }),
    )
}

pub(crate) async fn command(
    app: &App,
    session: &str,
    command: &str,
    args: &Value,
) -> Result<Value> {
    validate(command, args)?;
    let params = args.get("params").cloned().unwrap_or_else(|| json!({}));
    let snapshot = app.router.fig_team_library_document(session, args)?;
    let reference = params["library"].as_str();
    let canonical = reference
        .filter(|value| is_link(value))
        .map(Link::parse)
        .transpose()?
        .map(|link| link.canonical());
    let reference = canonical.as_deref().or(reference);
    match command {
        "library.add" => {
            let link = Link::parse(params["path"].as_str().ok_or_else(malformed)?)?;
            let (version, bytes) = fetch_link(&link, None).await?;
            let path = link.canonical();
            let publication = app
                .router
                .fig_team_library_cache(&path, None, version, &bytes)?;
            app.router
                .fig_team_library_attach(session, &snapshot, &path, publication)
        }
        "library.check" => {
            let links = app.router.fig_team_library_links(&snapshot, reference)?;
            let total = links.len();
            let snapshot = &snapshot;
            let results =
                futures_util::stream::iter(links.into_iter().map(|(id, path)| async move {
                    let outcome = async {
                        let link = Link::parse(&path)?;
                        let mut client = link.connect(false).await?;
                        let usage = Usage {
                            file: snapshot.title.clone(),
                            components: app.router.fig_team_library_instance_counts(snapshot, &id),
                        };
                        let (version, bytes) =
                            fetch(&mut client, Some(usage)).await?.ok_or_else(|| {
                                EngineError::invalid("This FigCraft file has no published library")
                            })?;
                        app.router
                            .fig_team_library_cache(&path, Some(&id), version, &bytes)?;
                        if let Some((styles, variables)) =
                            app.router.fig_team_library_asset_counts(snapshot, &id)
                        {
                            // Older FigCraft servers refuse the additive asset telemetry request.
                            let _ = ask(
                                &mut client,
                                Request::ReportAssets(AssetUsage {
                                    file: snapshot.title.clone(),
                                    styles,
                                    variables,
                                }),
                            )
                            .await;
                        }
                        Ok::<_, EngineError>(version)
                    }
                    .await;
                    (id, outcome)
                }));
            use futures_util::StreamExt;
            let outcomes = results.buffered(4).collect::<Vec<_>>().await;
            let mut checked = Vec::new();
            let mut errors = Vec::new();
            for (id, result) in outcomes {
                match result {
                    Ok(version) => checked.push(json!({"id":id,"version":version})),
                    Err(error) if params["library"].is_string() => return Err(error),
                    Err(error) => errors.push(json!({"id":id,"error":error.message})),
                }
            }
            Ok(json!({"checking":total,"checked":checked,"errors":errors}))
        }
        "library.usage" => {
            let Some((id, path)) = app
                .router
                .fig_team_library_usage_link(session, &snapshot, reference)?
            else {
                return app
                    .router
                    .call_figcraft(session, "run_command", args.clone());
            };
            let link = Link::parse(&path)?;
            let mut client = link.connect(false).await?;
            let (version, bytes) = fetch(&mut client, None).await?.ok_or_else(|| {
                EngineError::invalid("This FigCraft file has no published library")
            })?;
            let library =
                app.router
                    .fig_team_library_cache(&path, id.as_deref(), version, &bytes)?;
            let days = params["days"]
                .as_f64()
                .map_or(30, |days| days.round().clamp(1., 365.) as u64);
            remote_usage(&mut client, &library, days).await
        }
        "library.publishToServer" => {
            let saved = app
                .router
                .fig_team_publish_link(session, &snapshot.id, None)
                .or_else(|| crate::figcraft_online::library_edit_link(app, &snapshot.id));
            let server = params["server"]
                .as_str()
                .or(saved.as_deref())
                .ok_or_else(malformed)?;
            if let Some(publisher) = Publisher::parse(server, params["key"].as_str())? {
                let archive = app
                    .router
                    .fig_team_library_publish(session, &snapshot, &params, None)?;
                let (edit, view) = publisher.upload(&archive).await?;
                let mut client = edit.connect(true).await?;
                let mut result = publish_archive(&mut client, archive).await?;
                let edit_url = edit.canonical();
                app.router
                    .fig_team_publish_link(session, &snapshot.id, Some(&edit_url));
                result["file"] = json!(edit.file);
                result["edit"] = json!(edit_url);
                result["view"] = json!(view.canonical());
                return Ok(result);
            }
            let link = Link::parse(server)?;
            let mut client = link.connect(true).await?;
            let previous = fetch(&mut client, None).await?;
            let archive = app.router.fig_team_library_publish(
                session,
                &snapshot,
                &params,
                previous.as_ref().map(|(_, bytes)| bytes.as_slice()),
            )?;
            let result = publish_archive(&mut client, archive).await?;
            app.router
                .fig_team_publish_link(session, &snapshot.id, Some(&link.canonical()));
            Ok(result)
        }
        _ => Err(EngineError::invalid("Unknown team library command")),
    }
}
