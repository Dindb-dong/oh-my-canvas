//! FigCraft v0.17.0 plugin directory sessions over the native WebSocket transport.
use crate::{
    App,
    figcraft_server::{FigcraftServer, PROTOCOL},
};
use omc_mcp::compare_directory_versions;
use omc_protocol::{EngineError, Result};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{cmp::Ordering, time::Duration};

const OPEN_PLUGINS: u8 = 10;
const PLUGINS: u8 = 11;
const MAX_FRAME: usize = 33 * 1024 * 1024;

#[derive(Serialize)]
struct OpenPlugins<'a> {
    protocol: u32,
    key: &'a str,
    client_version: &'a str,
}

// Order is the upstream postcard discriminant.
#[derive(Serialize)]
enum Request<'a> {
    List {
        query: &'a str,
    },
    Fetch {
        id: &'a str,
        version: Option<&'a str>,
    },
    Publish {
        bundle: Vec<u8>,
    },
    Unpublish {
        id: &'a str,
        version: Option<&'a str>,
    },
}

#[derive(Deserialize)]
enum Reply {
    Ready { publisher: bool },
    List(Vec<Entry>),
    Bundle { entry: Entry, bundle: Vec<u8> },
    Published(Entry),
    Removed(Vec<String>),
    Failed { reason: String },
}

#[derive(Serialize, Deserialize)]
struct Entry {
    id: String,
    name: String,
    version: String,
    description: String,
    author: String,
    api: u32,
    access: String,
    commands: Vec<String>,
    widget: bool,
    bytes: u64,
    sha256: String,
    published: u64,
    versions: Vec<String>,
}

fn endpoint(server: &str, publisher: bool) -> Result<(String, String)> {
    let (address, query) = server.trim().split_once('?').unwrap_or((server.trim(), ""));
    let invalid = || EngineError::invalid("Publishing requires a FigCraft server URL with a key");
    if !publisher {
        if !query.is_empty() {
            return Err(EngineError::invalid(
                "Use the directory address without credentials",
            ));
        }
        return Ok((address.into(), String::new()));
    }
    if query.len() > 256 || query.contains(['&', '#']) {
        return Err(invalid());
    }
    let key = query.strip_prefix("key=").ok_or_else(invalid)?;
    if key.is_empty()
        || !key
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~'))
    {
        return Err(invalid());
    }
    Ok((address.into(), key.into()))
}

async fn response(client: &mut FigcraftServer) -> Result<Reply> {
    let reply = client.receive().await?;
    if reply.kind != PLUGINS {
        return Err(wrong_reply());
    }
    match reply.decode()? {
        Reply::Failed { reason } => Err(EngineError::new("collaboration_error", reason)),
        reply => Ok(reply),
    }
}

async fn exchange(address: &str, key: &str, request: Request<'_>) -> Result<Reply> {
    tokio::time::timeout(Duration::from_secs(15), async {
        let mut client = FigcraftServer::connect(address, MAX_FRAME).await?;
        client
            .send(
                OPEN_PLUGINS,
                &OpenPlugins {
                    protocol: PROTOCOL,
                    key,
                    client_version: env!("CARGO_PKG_VERSION"),
                },
            )
            .await?;
        match response(&mut client).await? {
            Reply::Ready { publisher } if !key.is_empty() && !publisher => {
                return Err(EngineError::new(
                    "authentication_failed",
                    "The server did not accept the plugin publisher key",
                ));
            }
            Reply::Ready { .. } => (),
            _ => return Err(wrong_reply()),
        }
        client.send(PLUGINS, &request).await?;
        response(&mut client).await
    })
    .await
    .map_err(|_| {
        EngineError::new(
            "dependency_unavailable",
            "FigCraft plugin directory request timed out",
        )
    })?
    .map_err(|mut error| {
        if !key.is_empty() && error.message.contains(key) {
            error.message = "FigCraft plugin directory rejected the request".into();
        }
        error
    })
}

fn wrong_reply() -> EngineError {
    EngineError::new(
        "collaboration_error",
        "Unexpected reply from FigCraft plugin directory",
    )
}

fn id(params: &Value) -> Result<&str> {
    params["id"]
        .as_str()
        .ok_or_else(|| EngineError::invalid("Plugin ID is required"))
}

pub(crate) async fn command(
    app: &App,
    session: &str,
    command: &str,
    args: &Value,
) -> Result<Value> {
    omc_mcp::validate_figcraft_tool("run_command", args)?;
    let params = args.get("params").cloned().unwrap_or_else(|| json!({}));
    let text = json!({"type":"string","minLength":1,"maxLength":256});
    let server = json!({"type":"string","minLength":1,"maxLength":2048});
    let fields = match command {
        "plugin.directory.list" => {
            json!({"server":server,"query":{"type":"string","maxLength":512}})
        }
        "plugin.directory.install" => {
            json!({"server":server,"id":text,"version":text,"confirm":{"type":"boolean"},"sha256":{"type":"string","minLength":64,"maxLength":64}})
        }
        "plugin.directory.publish" => {
            json!({"server":server,"path":{"type":"string","minLength":1,"maxLength":4096},"plugin":text})
        }
        "plugin.directory.unpublish" => json!({"server":server,"id":text,"version":text}),
        _ => return Err(EngineError::invalid("Unknown plugin directory command")),
    };
    omc_mcp::schema::check(
        &json!({"type":"object","properties":fields,"additionalProperties":false}),
        &params,
        "params",
    )?;
    let version = params["version"].as_str();
    if version.is_some_and(|version| compare_directory_versions(version, version).is_none()) {
        return Err(EngineError::invalid(
            "Plugin directory versions use up to four dotted numbers",
        ));
    }
    let publisher = matches!(
        command,
        "plugin.directory.publish" | "plugin.directory.unpublish"
    );
    let (last, _) = app.router.fig_plugin_directory_state(session, None);
    let server = if publisher {
        params["server"]
            .as_str()
            .ok_or_else(|| EngineError::invalid("A FigCraft plugin directory server is required"))?
            .to_owned()
    } else {
        app.router
            .fig_resolve_publish_server(params["server"].as_str().or(last.as_deref()))?
    };
    let (address, key) = endpoint(&server, publisher)?;
    match command {
        "plugin.directory.list" => {
            let query = params["query"].as_str().unwrap_or_default();
            let Reply::List(entries) = exchange(&address, &key, Request::List { query }).await?
            else {
                return Err(wrong_reply());
            };
            let (_, installed) = app
                .router
                .fig_plugin_directory_state(session, Some(&address));
            let rows = entries
                .into_iter()
                .map(|entry| {
                    let have = installed.get(&entry.id);
                    let update = have.is_some_and(|have| {
                        compare_directory_versions(&entry.version, have) == Some(Ordering::Greater)
                    });
                    let mut row = json!(entry);
                    row["installed"] = json!(have);
                    row["update"] = json!(update);
                    row
                })
                .collect::<Vec<_>>();
            Ok(json!({"server":address,"plugins":rows}))
        }
        "plugin.directory.install" => {
            let id = id(&params)?;
            if params["confirm"] != true {
                return Err(EngineError::invalid(
                    "Review plugin permissions and pass confirm: true to install",
                ));
            }
            let Reply::Bundle { entry, bundle } =
                exchange(&address, &key, Request::Fetch { id, version }).await?
            else {
                return Err(wrong_reply());
            };
            if entry.id != id
                || version.is_some_and(|version| {
                    compare_directory_versions(&entry.version, version) != Some(Ordering::Equal)
                })
            {
                return Err(EngineError::invalid(
                    "Directory returned another plugin or version",
                ));
            }
            let router = app.router.clone();
            let session = session.to_owned();
            tokio::task::spawn_blocking(move || {
                router.fig_install_plugin_bundle(
                    &session,
                    &bundle,
                    &json!(entry),
                    &address,
                    params["sha256"].as_str(),
                )
            })
            .await
            .map_err(|_| EngineError::new("internal_error", "Plugin install worker stopped"))?
        }
        "plugin.directory.publish" => {
            let router = app.router.clone();
            let session = session.to_owned();
            let bundle = tokio::task::spawn_blocking(move || {
                router.fig_export_plugin_bundle(&session, &params)
            })
            .await
            .map_err(|_| EngineError::new("internal_error", "Plugin bundle worker stopped"))??;
            let Reply::Published(entry) =
                exchange(&address, &key, Request::Publish { bundle }).await?
            else {
                return Err(wrong_reply());
            };
            Ok(json!({"published":entry,"server":address}))
        }
        "plugin.directory.unpublish" => {
            let id = id(&params)?;
            let Reply::Removed(versions) =
                exchange(&address, &key, Request::Unpublish { id, version }).await?
            else {
                return Err(wrong_reply());
            };
            Ok(json!({"id":id,"removed":versions}))
        }
        _ => Err(EngineError::invalid("Unknown plugin directory command")),
    }
}
