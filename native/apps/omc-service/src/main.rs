//! Authenticated loopback service. Document authority lives in isolated workers.
mod collaboration;
mod desktop_automation;
mod figcraft_online;
mod figcraft_server;
mod legacy_https;
mod invite_registration;
mod plugin_directory;
mod plugin_manager;
mod team_library;
use axum::{
    Json, Router,
    body::Bytes,
    extract::{DefaultBodyLimit, Request, State},
    http::{HeaderMap, HeaderValue, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use base64::Engine;
use clap::Parser;
use omc_mcp::ToolRouter;
use omc_protocol::{Command, CommandEnvelope, EngineError, Result};
use omc_workspace::Workspace;
use serde_json::{Value, json};
use std::{io::Write, path::PathBuf, sync::Arc};

#[derive(Parser)]
struct Options {
    #[arg(long)]
    profile: PathBuf,
    #[arg(long, default_value_t = 0)]
    port: u16,
    #[arg(long)]
    document_worker: bool,
    /// Also serve certificate-pinned legacy MCP HTTPS (47831 for existing clients).
    #[arg(long)]
    legacy_mcp_port: Option<u16>,
}
#[derive(Clone)]
struct App {
    workspace: Arc<Workspace>,
    online: Arc<figcraft_online::Online>,
    router: Arc<ToolRouter>,
    collaboration: Arc<collaboration::Collaboration>,
    desktop_automation: Arc<desktop_automation::DesktopAutomation>,
    token: String,
    admission: Arc<tokio::sync::Semaphore>,
}

#[tokio::main]
async fn main() {
    if let Err(error) = run().await {
        eprintln!("{}: {}", error.code, error.message);
        std::process::exit(1);
    }
}
async fn run() -> Result<()> {
    let options = Options::parse();
    if options.document_worker {
        return omc_workspace::worker::run_document_worker(&options.profile);
    }
    let workspace = Workspace::open(
        &options.profile,
        Some(std::env::current_exe().map_err(io_error)?),
    )?;
    #[cfg(windows)]
    invite_registration::startup(&workspace);
    let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, options.port))
        .await
        .map_err(io_error)?;
    let address = listener.local_addr().map_err(io_error)?;
    let token = omc_workspace::random_secret();
    let app = App {
        router: Arc::new(ToolRouter::new(workspace.clone())),
        collaboration: Arc::new(collaboration::Collaboration::new(workspace.clone())),
        workspace,
        online: Arc::default(),
        desktop_automation: Arc::default(),
        token: token.clone(),
        admission: Arc::new(tokio::sync::Semaphore::new(32)),
    };
    let checkpoints = app.workspace.clone();
    let checkpoint_task = tokio::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
            let workspace = checkpoints.clone();
            let _ = tokio::task::spawn_blocking(move || workspace.automatic_checkpoint()).await;
        }
    });
    let service = Router::new()
        .route("/mcp", post(mcp).delete(close_mcp).get(no_event_stream))
        .route(
            "/mcp/figcraft",
            post(figcraft_mcp).delete(close_mcp).get(no_event_stream),
        )
        .layer(DefaultBodyLimit::max(1024 * 1024))
        .merge(
            Router::new()
                .route("/rpc", post(rpc))
                .layer(DefaultBodyLimit::max(64 * 1024 * 1024)),
        )
        .route("/health", get(health))
        .layer(middleware::from_fn_with_state(app.clone(), authenticate))
        .with_state(app.clone());
    let legacy_port = match (
        options.legacy_mcp_port,
        std::env::var_os("OMC_LEGACY_MCP_PORT"),
    ) {
        (Some(port), _) => Some(port),
        (None, Some(value)) => Some(
            value
                .to_string_lossy()
                .parse()
                .map_err(|_| EngineError::invalid("OMC_LEGACY_MCP_PORT must be a TCP port"))?,
        ),
        (None, None) => None,
    };
    let legacy = match legacy_port {
        Some(port) => Some(legacy_https::start(app.clone(), &app.workspace.profile, port).await?),
        None => None,
    };
    let descriptor = app.workspace.profile.join("native-v1/service.json");
    publish_descriptor(
        &descriptor,
        &json!({"protocol":"omc.service/1","endpoint":format!("http://{address}"),"token":token,"pid":std::process::id()}),
    )?;
    eprintln!("Native workspace service listening on {address}");
    let result = axum::serve(listener, service)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await
        .map_err(io_error);
    checkpoint_task.abort();
    if let Some(legacy) = legacy {
        legacy.close().await;
    }
    let _ = std::fs::remove_file(descriptor);
    result
}
async fn authenticate(State(app): State<App>, request: Request, next: Next) -> Response {
    let headers = request.headers();
    let authenticated = headers
        .get("authorization")
        .and_then(|s| s.to_str().ok())
        .and_then(|s| s.strip_prefix("Bearer "))
        .is_some_and(|proof| {
            omc_workspace::constant_time_equal(proof.as_bytes(), app.token.as_bytes())
        });
    if !authenticated {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({"error":"authentication_required"})),
        )
            .into_response();
    }
    let host = headers
        .get("host")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if !host.starts_with("127.0.0.1:") && !host.starts_with("localhost:") {
        return (StatusCode::FORBIDDEN, Json(json!({"error":"invalid_host"}))).into_response();
    }
    if let Some(origin) = headers.get("origin") {
        let origin = origin.to_str().unwrap_or("");
        if origin != format!("http://{host}") {
            return (
                StatusCode::FORBIDDEN,
                Json(json!({"error":"invalid_origin"})),
            )
                .into_response();
        }
    }
    let charge = if request.uri().path() == "/rpc"
        && headers
            .get("content-length")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse::<u64>().ok())
            .is_none_or(|n| n > 1024 * 1024)
    {
        16
    } else {
        1
    };
    let Ok(_permit) = app.admission.clone().try_acquire_many_owned(charge) else {
        return (
            StatusCode::TOO_MANY_REQUESTS,
            Json(json!({"error":"queue_full"})),
        )
            .into_response();
    };
    next.run(request).await
}
async fn health() -> Json<Value> {
    Json(json!({"protocol":"omc.service/1","status":"ready","releaseStatus":"incomplete-preview"}))
}
async fn no_event_stream() -> StatusCode {
    StatusCode::METHOD_NOT_ALLOWED
}
fn header<'a>(headers: &'a HeaderMap, name: &str) -> Result<&'a str> {
    headers
        .get(name)
        .and_then(|s| s.to_str().ok())
        .ok_or_else(|| EngineError::new("authentication_failed", "session header required"))
}
async fn rpc(State(app): State<App>, headers: HeaderMap, body: Bytes) -> Response {
    let request = match omc_protocol::decode_json_with_limit(&body, 64 * 1024 * 1024) {
        Ok(v) => v,
        Err(error) => return Json(json!({"id":null,"error":error})).into_response(),
    };
    let id = request["id"].clone();
    let method = request["method"].as_str().unwrap_or("").to_owned();
    let max_mib = match method.as_str() {
        "document.import" => 64,
        // The desktop can return a 6 MiB PNG, expanded to 8 MiB by base64.
        "desktop.complete" => 9,
        _ => 1,
    };
    if body.len() > max_mib * 1024 * 1024 {
        return (
            StatusCode::PAYLOAD_TOO_LARGE,
            Json(json!({"id":id,"error":{
                "code":"resource_limit","message":format!("RPC body exceeds {max_mib} MiB")
            }})),
        )
            .into_response();
    }
    let session = header(&headers, "x-omc-session").ok().map(str::to_owned);
    let result = if matches!(method.as_str(), "desktop.poll" | "desktop.complete") {
        app.desktop_automation
            .rpc(
                &app.workspace,
                session.as_deref(),
                &method,
                request["params"].clone(),
            )
            .await
    } else if method == "collaboration" {
        match session {
            Some(session) => {
                figcraft_online::native_collaboration(&app, &session, request["params"].clone()).await
            }
            None => Err(EngineError::new(
                "authentication_failed",
                "session required",
            )),
        }
    } else {
        tokio::task::spawn_blocking(move || {
            dispatch_rpc(&app, session.as_deref(), &method, request["params"].clone())
        })
        .await
        .unwrap_or_else(|_| Err(EngineError::new("internal_error", "request worker stopped")))
    };
    Json(match result {
        Ok(result) => json!({"id":id,"result":result}),
        Err(error) => json!({"id":id,"error":error}),
    })
    .into_response()
}
fn dispatch_rpc(app: &App, session: Option<&str>, method: &str, args: Value) -> Result<Value> {
    if method == "session.open" {
        return app.workspace.session_open(args.get("identity"));
    }
    let session =
        session.ok_or_else(|| EngineError::new("authentication_failed", "session required"))?;
    app.workspace.session(session)?;
    match method {
        "session.close" => {
            app.router.end_session(session);
            let result = app.workspace.session_close(session);
            app.desktop_automation.detach(session);
            result
        }
        "workspace.list" => {
            let mut listing = app
                .workspace
                .list(args["includeArchived"].as_bool().unwrap_or(false))?;
            if args["thumbnails"] == true {
                if let Some(documents) = listing["documents"].as_array_mut() {
                    for document in documents
                        .iter_mut()
                        .filter(|doc| doc["archived"] != true)
                        .take(15)
                    {
                        if let Some(bytes) = document["id"]
                            .as_str()
                            .and_then(|id| app.workspace.snapshot(id).ok())
                            .and_then(|snapshot| app.router.thumbnail_png(&snapshot).ok().flatten())
                        {
                            document["thumbnail"] =
                                json!(base64::engine::general_purpose::STANDARD.encode(bytes));
                        }
                    }
                }
            }
            Ok(listing)
        }
        "desktop.openPath" => app.router.native_open_window_file(session, string(&args, "path")?),
        "desktop.plugins" => plugin_manager::desktop_action(app, session, &args),
        "workspace.create" => Ok(json!(app.workspace.create(
            session,
            args["title"].as_str().unwrap_or("Untitled"),
            None
        )?)),
        "workspace.open" => {
            let id = string(&args, "documentId")?;
            app.workspace.bind(session, id)?;
            Ok(json!(app.workspace.snapshot(id)?))
        }
        "workspace.close" => app.workspace.release(session, string(&args, "documentId")?),
        "document.snapshot" => Ok(json!(app.workspace.snapshot(string(&args, "documentId")?)?)),
        "document.shapeBuilder" => app.router.native_shape_builder(session, &args),
        "document.boardTool" => app.router.native_board_tool(session, &args),
        "document.command" => {
            let envelope: CommandEnvelope = serde_json::from_value(args["envelope"].clone())
                .map_err(|e| EngineError::invalid(e.to_string()))?;
            app.router.execute_observed(session, envelope)
        }
        "document.undo" | "document.redo" => app.workspace.command(
            session,
            string(&args, "documentId")?,
            string(&args, "targetEpoch")?,
            if method == "document.undo" {
                Command::Undo
            } else {
                Command::Redo
            },
        ),
        "document.save" => app.workspace.checkpoint(string(&args, "documentId")?),
        "document.publish_library" => {
            let id = string(&args, "documentId")?;
            let revision = serde_json::from_value(args["revision"].clone())
                .map_err(|error| EngineError::invalid(error.to_string()))?;
            let description = string(&args, "description")?;
            if description.chars().count() > 2000 {
                return Err(EngineError::invalid(
                    "Library description exceeds 2000 characters",
                ));
            }
            app.router
                .publish_library_from_desktop(session, id, &revision, description)
        }
        "document.text_selection" => app
            .workspace
            .text_selection(string(&args, "documentId")?, args.clone()),
        "document.import" => {
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(string(&args, "contentBase64")?)
                .map_err(|e| EngineError::invalid(e.to_string()))?;
            if bytes.len() > 32 * 1024 * 1024 {
                return Err(EngineError::new(
                    "resource_limit",
                    "native chooser import exceeds 32 MiB",
                ));
            }
            let (snapshot, _) = app.router.import_bytes_native(
                session,
                string(&args, "format")?,
                &bytes,
                args["title"].as_str(),
                args["strict"].as_bool().unwrap_or(true),
            )?;
            Ok(json!(snapshot))
        }
        "document.export" => {
            let artifact = app
                .router
                .export_bytes_native(string(&args, "documentId")?, &args)?;
            if artifact.bytes.len() > 64 * 1024 * 1024 {
                return Err(EngineError::new(
                    "resource_limit",
                    "native chooser export exceeds 64 MiB",
                ));
            }
            Ok(
                json!({"contentBase64":base64::engine::general_purpose::STANDARD.encode(artifact.bytes),"mediaType":artifact.media_type,"extension":artifact.extension,"diagnostics":artifact.diagnostics,"revision":{"epoch":artifact.epoch,"sequence":artifact.sequence.to_string()}}),
            )
        }
        "asset.read" => {
            let bytes = omc_assets::AssetStore::open(&app.workspace.profile)?
                .read(string(&args, "hash")?)?;
            Ok(json!({"contentBase64":base64::engine::general_purpose::STANDARD.encode(bytes)}))
        }
        "tool.call" => app.router.call(
            session,
            string(&args, "name")?,
            args["arguments"].clone(),
            args.get("_meta").cloned().unwrap_or(Value::Null),
        ),
        "workspace.metrics" => Ok(app.workspace.metrics()),
        "sync.fork" => Ok(json!(
            app.workspace.fork_replica(
                session,
                serde_json::from_value(args["package"].clone())
                    .map_err(|e| EngineError::invalid(e.to_string()))?
            )?
        )),
        "sync.package" | "sync.transactions" | "sync.receive" | "sync.fragment" => {
            let path = app.workspace.document_path(string(&args, "documentId")?)?;
            app.workspace.workers.call(
                &path,
                match method {
                    "sync.package" => "replica_package",
                    "sync.transactions" => "export_transactions",
                    "sync.fragment" => "receive_fragment",
                    _ => "receive_transaction",
                },
                args,
            )
        }
        _ => Err(EngineError::new(
            "unsupported_feature",
            format!("unknown native RPC {method}"),
        )),
    }
}
async fn mcp(State(app): State<App>, headers: HeaderMap, body: Bytes) -> Response {
    mcp_request(app, headers, body, false).await
}
async fn figcraft_mcp(State(app): State<App>, headers: HeaderMap, body: Bytes) -> Response {
    mcp_request(app, headers, body, true).await
}
async fn mcp_request(app: App, headers: HeaderMap, body: Bytes, figcraft: bool) -> Response {
    let request = match omc_protocol::decode_json(&body) {
        Ok(v) => v,
        Err(e) => {
            return Json(
                json!({"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":e.message}}),
            )
            .into_response();
        }
    };
    if request["jsonrpc"] != "2.0" || !request["method"].is_string() {
        return Json(json!({"jsonrpc":"2.0","id":request["id"],"error":{"code":-32600,"message":"Invalid Request"}})).into_response();
    }
    let id = request["id"].clone();
    let method = request["method"].as_str().unwrap().to_owned();
    if method == "initialize" {
        if let Some(required) =
            request["params"]["_meta"]["oh-my-canvas/required-extensions"].as_array()
        {
            let supported = omc_mcp::native_capabilities();
            if required
                .iter()
                .any(|v| !supported["extensions"].as_array().unwrap().contains(v))
            {
                return mcp_error(id, -32602, "unsupported required native extension");
            }
        }
        let version = request["params"]["protocolVersion"]
            .as_str()
            .filter(|v| matches!(*v, "2025-06-18" | "2025-03-26" | "2024-11-05"))
            .unwrap_or("2025-06-18")
            .to_owned();
        let identity = request["params"]["_meta"]
            .get("oh-my-canvas/identity")
            .cloned();
        let registered =
            tokio::task::spawn_blocking(move || app.workspace.session_open(identity.as_ref()))
                .await;
        return match registered {
            Ok(Ok(session)) => {
                let (name, instructions) = if figcraft {
                    (
                        "oh-my-canvas-figcraft-compatibility",
                        "Partial FigCraft compatibility. Use list_commands to discover implemented commands; run file.new to create a session document or name a native document explicitly.",
                    )
                } else {
                    (
                        "oh-my-canvas-native",
                        "Native incomplete preview. Inspect native_capabilities before depending on extensions or unqualified tool branches.",
                    )
                };
                let capabilities = if figcraft {
                    json!({"tools":{"listChanged":false},"resources":{},"prompts":{}})
                } else {
                    json!({"tools":{"listChanged":false}})
                };
                let mut response=Json(json!({"jsonrpc":"2.0","id":id,"result":{"protocolVersion":version,"capabilities":capabilities,"serverInfo":{"name":name,"version":"0.1.0"},"instructions":instructions,"_meta":{"oh-my-canvas/identity":session}}})).into_response();
                response.headers_mut().insert(
                    "mcp-session-id",
                    HeaderValue::from_str(session["sessionId"].as_str().unwrap()).unwrap(),
                );
                response
            }
            Ok(Err(error)) => mcp_error(id, -32000, &error.message),
            Err(_) => mcp_error(id, -32603, "initialization worker stopped"),
        };
    }
    let session = match header(&headers, "mcp-session-id") {
        Ok(s) => s.to_owned(),
        Err(error) => {
            return (StatusCode::BAD_REQUEST, Json(json!({"error":error}))).into_response();
        }
    };
    if app.workspace.session(&session).is_err() {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({"error":"session_not_found"})),
        )
            .into_response();
    }
    if !request.as_object().unwrap().contains_key("id") {
        return StatusCode::ACCEPTED.into_response();
    }
    let result = match method.as_str() {
        "ping" => Ok(json!({})),
        "tools/list" => Ok(
            json!({"tools":if figcraft { json!(omc_mcp::figcraft_tools()) } else { app.router.tools() }}),
        ),
        "tools/call" => {
            let params = request["params"].clone();
            let tool_name = params["name"].as_str().unwrap_or("");
            let clear_preview =
                figcraft && !omc_mcp::figcraft_preserves_preview(tool_name, &params["arguments"]);
            let cleared = if clear_preview {
                clear_fig_preview(&app, &session).await.map(|_| ())
            } else {
                Ok(())
            };
            let result = if let Err(error) = cleared {
                Err(error)
            } else if figcraft
                && tool_name == "run_command"
                && matches!(
                    params["arguments"]["command"].as_str(),
                    Some("text.preview" | "text.endPreview" | "widget.hover")
                )
                && app.desktop_automation.attached()
            {
                attached_fig_preview(&app, &session, params["arguments"].clone()).await
            } else if figcraft
                && tool_name == "run_command"
                && params["arguments"]["command"] == "pref.userName"
            {
                let router = app.router.clone();
                let arguments = params["arguments"].clone();
                let caller = session.clone();
                match tokio::task::spawn_blocking(move || {
                    router.call_figcraft(&caller, "run_command", arguments)
                })
                .await
                {
                    Ok(Ok(result)) => {
                        app.collaboration.rename_local_participant().await;
                        Ok(result)
                    }
                    Ok(Err(error)) => Err(error),
                    Err(_) => Err(EngineError::new(
                        "internal_error",
                        "preference worker stopped",
                    )),
                }
            } else if figcraft
                && tool_name == "run_command"
                && params["arguments"]["command"] == "collab.registerLinks"
            {
                invite_registration::command(&app, params["arguments"].clone()).await
            } else if figcraft && tool_name == "wait_for_changes" {
                app.router
                    .fig_wait_for_changes(
                        &session,
                        params
                            .get("arguments")
                            .cloned()
                            .unwrap_or_else(|| json!({})),
                        app.desktop_automation.attached(),
                    )
                    .await
            } else if figcraft
                && (matches!(tool_name, "pointer" | "key" | "inspect_ui")
                    || tool_name == "type_text" && params["arguments"].get("id").is_none()
                    || tool_name == "screenshot"
                        && app.desktop_automation.attached()
                        && params["arguments"]
                            .get("window")
                            .is_some_and(|window| window != false))
            {
                let mut arguments = params
                    .get("arguments")
                    .cloned()
                    .unwrap_or_else(|| json!({}));
                let input = matches!(tool_name, "pointer" | "key" | "type_text");
                match omc_mcp::validate_figcraft_tool(tool_name, &arguments) {
                    Ok(()) => {
                        let mut bind = false;
                        if input && arguments.get("document").is_none() {
                            if let Ok(caller) = app.workspace.session(&session) {
                                if let Some(document) = caller.binding {
                                    arguments["document"] = document.into();
                                } else {
                                    bind = true;
                                }
                            }
                        }
                        match app
                            .desktop_automation
                            .call(&session, tool_name, arguments)
                            .await
                        {
                            Ok(value) => tokio::task::spawn_blocking(move || {
                                app.router.fig_desktop_result(&session, value, input, bind)
                            })
                            .await
                            .unwrap_or_else(|_| {
                                Err(EngineError::new(
                                    "internal_error",
                                    "desktop result worker stopped",
                                ))
                            }),
                            Err(error) => Err(error),
                        }
                    }
                    Err(error) => Err(error),
                }
            } else if figcraft
                && tool_name == "run_command"
                && params["arguments"]["command"] == "collab.serverInfo"
            {
                figcraft_server::server_info(&params["arguments"]).await
            } else if figcraft
                && tool_name == "run_command"
                && let Some(command) = params["arguments"]["command"].as_str()
                && (matches!(command, "library.check" | "library.publishToServer" | "library.usage")
                    || command == "library.add"
                        && params["arguments"]["params"]["path"]
                            .as_str()
                            .is_some_and(team_library::is_link))
            {
                team_library::command(&app, &session, command, &params["arguments"]).await
            } else if figcraft
                && tool_name == "run_command"
                && let Some(
                    command @ ("plugin.directory.list"
                    | "plugin.directory.install"
                    | "plugin.directory.publish"
                    | "plugin.directory.unpublish"),
                ) = params["arguments"]["command"].as_str()
            {
                plugin_directory::command(&app, &session, command, &params["arguments"]).await
            } else if figcraft
                && tool_name == "run_command"
                && params["arguments"]["command"] == "plugins.manage"
            {
                plugin_manager::open(&app, &session, &params["arguments"]).await
            } else if figcraft && tool_name == "run_command"
                && let Some(command) = params["arguments"]["command"].as_str()
                && figcraft_online::routes(&app,&session,command,&params["arguments"])
            {
                figcraft_online::command(&app,&session,command,&params["arguments"]).await
            } else if figcraft
                && tool_name == "run_command"
                && let Some(
                    command @ ("collab.host"
                    | "collab.share"
                    | "collab.join"
                    | "collab.peers"
                    | "collab.cursorChat"
                    | "collab.follow"
                    | "collab.spotlight"
                    | "collab.cursor"
                    | "collab.leave"
                    | "collab.stop"
                    | "collab.reconnect"
                    | "collab.removePerson"),
                ) = params["arguments"]["command"].as_str()
            {
                collaboration::figcraft_command(
                    &app,
                    &session,
                    command,
                    params["arguments"].clone(),
                )
                .await
            } else if figcraft
                && tool_name == "run_command"
                && matches!(
                    params["arguments"]["command"].as_str(),
                    Some("version.preview" | "version.exitPreview")
                )
            {
                figcraft_version_preview(&app, &session, params["arguments"].clone()).await
            } else if figcraft
                && tool_name == "run_command"
                && app.desktop_automation.attached()
                && matches!(
                    params["arguments"]["command"].as_str(),
                    Some("comment.open" | "comment.next" | "comment.zoom")
                )
            {
                figcraft_show_comment(&app, &session, params["arguments"].clone()).await
            } else if figcraft
                && tool_name == "run_command"
                && params["arguments"]["command"] == "dev.compare"
                && params["arguments"]["params"]["show"] == true
            {
                figcraft_show_comparison(&app, &session, params["arguments"].clone()).await
            } else if figcraft
                && tool_name == "run_command"
                && params["arguments"]["command"] == "text.openLink"
                && app.desktop_automation.attached()
            {
                figcraft_open_link(&app, &session, params["arguments"].clone()).await
            } else if figcraft
                && tool_name == "run_command"
                && let Some(command) = params["arguments"]["command"].as_str()
                && omc_mcp::desktop_commands::is_figcraft_command(command)
                && (app.desktop_automation.attached()
                    || !omc_mcp::desktop_commands::is_text_editor_command(command)
                        && !omc_mcp::figcraft_headless_tool(command)
                        && command != "edit.setDefaultProperties")
            {
                figcraft_desktop_command(&app, &session, command, params["arguments"].clone()).await
            } else if !figcraft
                && tool_name == "workspace"
                && let Some(action) = params["arguments"]["action"].as_str()
                && omc_mcp::desktop_commands::is_legacy_workspace_action(action)
                && (omc_mcp::desktop_commands::is_legacy_window_only(action)
                    || app.desktop_automation.attached())
            {
                legacy_workspace_command(&app, &session, params["arguments"].clone()).await
            } else if !figcraft
                && matches!(tool_name, "open_document" | "create_document" | "duplicate_document" | "import_document")
                && params["arguments"]["focus"] == true
                && app.desktop_automation.attached()
            {
                legacy_focused_document(&app, &session, tool_name, &params).await
            } else if !figcraft && tool_name == "view" && app.desktop_automation.attached() {
                legacy_view_command(&app, &session, params["arguments"].clone()).await
            } else if !figcraft && params["name"] == "collaboration" {
                let args = params["arguments"].clone();
                match omc_mcp::schema::validate("collaboration", &args) {
                    Ok(()) => figcraft_online::native_collaboration(&app,&session,args).await,
                    Err(error) => Err(error),
                }
            } else {
                tokio::task::spawn_blocking(move || {
                    let name = string(&params, "name")?;
                    let arguments = params
                        .get("arguments")
                        .cloned()
                        .unwrap_or_else(|| json!({}));
                    if figcraft {
                        app.router.call_figcraft(&session, name, arguments)
                    } else {
                        app.router.call(
                            &session,
                            name,
                            arguments,
                            params.get("_meta").cloned().unwrap_or(Value::Null),
                        )
                    }
                })
                .await
                .unwrap_or_else(|_| Err(EngineError::new("internal_error", "tool worker stopped")))
            };
            Ok(match result {
                Ok(value) => {
                    let mut content =
                        vec![json!({"type":"text","text":serde_json::to_string(&value).unwrap()})];
                    if let Some(mime) = value["mimeType"].as_str()
                        && (mime == "image/png"
                            || figcraft && matches!(mime, "image/jpeg" | "image/webp"))
                        && let Some(data) = value["base64"].as_str()
                    {
                        content.push(json!({"type":"image","mimeType":mime,"data":data}));
                    }
                    let mut result = json!({"content":content,"isError":false});
                    if value.is_object() || !figcraft {
                        result["structuredContent"] = value;
                    }
                    result
                }
                Err(error) => {
                    json!({"content":[{"type":"text","text":serde_json::to_string(&error).unwrap()}],"isError":true})
                }
            })
        }
        "resources/list"
        | "resources/templates/list"
        | "resources/read"
        | "prompts/list"
        | "prompts/get"
            if figcraft =>
        {
            tokio::task::spawn_blocking(move || {
                app.router
                    .fig_protocol(&session, &method, &request["params"])
            })
            .await
            .unwrap_or_else(|_| {
                Err(EngineError::new(
                    "internal_error",
                    "protocol worker stopped",
                ))
            })
        }
        _ => Err(EngineError::new("method_not_found", "unknown MCP method")),
    };
    match result {
        Ok(value) => Json(json!({"jsonrpc":"2.0","id":id,"result":value})).into_response(),
        Err(error) => mcp_error(
            id,
            match error.code.as_str() {
                "method_not_found" => -32601,
                "invalid_argument" => -32602,
                "not_found" => -32002,
                _ => -32000,
            },
            &error.message,
        ),
    }
}
async fn clear_fig_preview(app: &App, session: &str) -> Result<bool> {
    let Some(document) = app.router.fig_preview_document(session) else {
        return Ok(false);
    };
    if app.desktop_automation.attached() {
        app.desktop_automation
            .call(session, "text.preview.clear", json!({"document":document}))
            .await?;
    }
    Ok(app.router.take_fig_preview(session).is_some())
}

async fn attached_fig_preview(app: &App, session: &str, args: Value) -> Result<Value> {
    omc_mcp::validate_figcraft_tool("run_command", &args)?;
    if args["command"] == "text.endPreview" {
        return Ok(json!({"ended":clear_fig_preview(app, session).await?}));
    }
    let previous = app.router.fig_preview_document(session);
    let router = app.router.clone();
    let caller = session.to_owned();
    let (result, payload) = tokio::task::spawn_blocking(move || {
        let result = router.call_figcraft(&caller, "run_command", args)?;
        let payload = router.fig_preview_payload(&caller);
        Ok::<_, EngineError>((result, payload))
    })
    .await
    .map_err(|_| EngineError::new("internal_error", "preview worker stopped"))??;
    if let Some(document) = previous
        && payload.as_ref().and_then(|args| args["document"].as_str()) != Some(&document)
    {
        app.desktop_automation
            .call(session, "text.preview.clear", json!({"document":document}))
            .await?;
    }
    if let Some(payload) = payload
        && let Err(error) = app
            .desktop_automation
            .call(session, "text.preview.apply", payload)
            .await
    {
        let _ = clear_fig_preview(app, session).await;
        return Err(error);
    }
    Ok(result)
}

async fn figcraft_open_link(app: &App, session: &str, args: Value) -> Result<Value> {
    let router = app.router.clone();
    let caller = session.to_owned();
    let link =
        tokio::task::spawn_blocking(move || router.call_figcraft(&caller, "run_command", args))
            .await
            .map_err(|_| EngineError::new("internal_error", "link lookup worker stopped"))??;
    if let Some(url) = link["url"].as_str() {
        app.desktop_automation
            .call(session, "open.url", json!({"url":url}))
            .await?;
    }
    Ok(link)
}

async fn legacy_focused_document(
    app: &App,
    session: &str,
    tool: &str,
    request: &Value,
) -> Result<Value> {
    let router = app.router.clone();
    let caller = session.to_owned();
    let tool = tool.to_owned();
    let args = request["arguments"].clone();
    let meta = request.get("_meta").cloned().unwrap_or(Value::Null);
    let mut result = tokio::task::spawn_blocking(move || router.call(&caller, &tool, args, meta))
        .await
        .map_err(|_| EngineError::new("internal_error", "workspace command worker stopped"))??;
    if let Some(document) = result["documentId"].as_str() {
        match focus_legacy_tab(app, session, document).await {
            Ok(()) => result["focused"] = true.into(),
            Err(error) => {
                result["focused"] = false.into();
                result["focusError"] = json!(error);
            }
        }
    } else if let Some(job) = result["jobId"].as_str() {
        let app = app.clone();
        let session = session.to_owned();
        let job = job.to_owned();
        tokio::spawn(async move {
            while app.workspace.session(&session).is_ok() {
                let Ok(status) = app.workspace.jobs.status(&session, &job) else {
                    break;
                };
                match status["state"].as_str() {
                    Some("completed") => {
                        if let Some(document) = status["result"]["documentId"].as_str() {
                            let _ = focus_legacy_tab(&app, &session, document).await;
                        }
                        break;
                    }
                    Some("failed" | "cancelled" | "interrupted") | None => break,
                    _ => tokio::time::sleep(std::time::Duration::from_millis(100)).await,
                }
            }
        });
        result["focusPending"] = true.into();
    }
    Ok(result)
}

async fn focus_legacy_tab(app: &App, session: &str, document: &str) -> Result<()> {
    for attempt in 0..=10 {
        match app.desktop_automation.call(
            session, "workspace", json!({"action":"focus","documentId":document}),
        ).await {
            Ok(_) => return Ok(()),
            Err(error) if error.code == "busy" && attempt < 10 => {
                tokio::time::sleep(std::time::Duration::from_millis(75)).await;
            }
            Err(error) => return Err(error),
        }
    }
    unreachable!()
}

async fn legacy_view_command(app: &App, session: &str, args: Value) -> Result<Value> {
    let router = app.router.clone();
    let caller = session.to_owned();
    let original = args.clone();
    let prepared = tokio::task::spawn_blocking(move || router.legacy_view_arguments(&caller, &original))
        .await
        .map_err(|_| EngineError::new("internal_error", "view command worker stopped"))??;
    let response = app.desktop_automation.call(session, "legacy.view", prepared.clone()).await;
    let router = app.router.clone();
    let caller = session.to_owned();
    tokio::task::spawn_blocking(move || match response {
        Ok(response) if response["attached"] == true => {
            router.legacy_view_response(&caller, &prepared, response)
        }
        Ok(_) => router.call(&caller, "view", args, Value::Null),
        Err(error) if error.code == "desktop_unavailable" => {
            router.call(&caller, "view", args, Value::Null)
        }
        Err(error) => Err(error),
    })
    .await
    .map_err(|_| EngineError::new("internal_error", "view command worker stopped"))?
}

async fn legacy_workspace_command(app: &App, session: &str, args: Value) -> Result<Value> {
    omc_mcp::schema::validate("workspace", &args)?;
    let action = string(&args, "action")?;
    let window = app
        .desktop_automation
        .call(session, "workspace", args.clone())
        .await?;
    if omc_mcp::desktop_commands::is_legacy_window_only(action) {
        return Ok(window);
    }
    let router = app.router.clone();
    let session = session.to_owned();
    tokio::task::spawn_blocking(move || {
        let mut output = router.call(&session, "workspace", args, Value::Null)?;
        output["window"] = window;
        Ok(output)
    })
    .await
    .map_err(|_| EngineError::new("internal_error", "workspace command worker stopped"))?
}

async fn figcraft_show_comment(app: &App, session: &str, args: Value) -> Result<Value> {
    let router = app.router.clone();
    let caller = session.to_owned();
    let (job, mut result) = tokio::task::spawn_blocking(move || {
        omc_mcp::validate_figcraft_tool("run_command", &args)?;
        let command = string(&args, "command")?;
        let target = router.fig_desktop_arguments(&caller, command, &args)?;
        let document = target["document"]
            .as_str()
            .ok_or_else(|| EngineError::invalid("Choose a document with comments"))?;
        let result = router.call_figcraft(&caller, "run_command", args.clone())?;
        let job = router.fig_comment_desktop_job(&caller, document, command, &args, &result)?;
        Ok::<_, EngineError>((job, result))
    })
    .await
    .map_err(|_| EngineError::new("internal_error", "comment view worker stopped"))??;
    let view = app
        .desktop_automation
        .call(session, "comment.reveal", job)
        .await?;
    if result.get("zoom").is_some() {
        result["zoom"] = view["zoom"].clone();
    }
    Ok(result)
}

async fn figcraft_show_comparison(app: &App, session: &str, mut args: Value) -> Result<Value> {
    if !app.desktop_automation.attached() {
        return Err(EngineError::new(
            "desktop_unavailable",
            "Open the native app to show a comparison",
        ));
    }
    let router = app.router.clone();
    let caller = session.to_owned();
    let (job, mut comparison) = tokio::task::spawn_blocking(move || {
        omc_mcp::validate_figcraft_tool("run_command", &args)?;
        let target = router.fig_desktop_arguments(&caller, "dev.compare", &args)?;
        let document = target["document"]
            .as_str()
            .ok_or_else(|| EngineError::invalid("Choose a document to compare"))?;
        args["params"].as_object_mut().unwrap().remove("show");
        let comparison = router.call_figcraft(&caller, "run_command", args)?;
        let images = router.fig_comparison_images(&caller, document, &comparison)?;
        Ok::<_, EngineError>((
            json!({"document":document,"comparison":comparison,"images":images}),
            comparison,
        ))
    })
    .await
    .map_err(|_| EngineError::new("internal_error", "comparison worker stopped"))??;
    app.desktop_automation
        .call(session, "dev.compare.show", job)
        .await?;
    comparison["shown"] = json!(true);
    Ok(comparison)
}

async fn figcraft_version_preview(app: &App, session: &str, args: Value) -> Result<Value> {
    if !app.desktop_automation.attached() {
        return Err(EngineError::new(
            "desktop_unavailable",
            "Open the native app to preview a version",
        ));
    }
    let apply = args["command"] == "version.preview";
    let router = app.router.clone();
    let owner = session.to_owned();
    let job =
        tokio::task::spawn_blocking(move || router.fig_version_preview_job(&owner, &args, apply))
            .await
            .map_err(|_| EngineError::new("internal_error", "version preview worker stopped"))??;
    let method = if apply {
        "text.preview.apply"
    } else {
        "text.preview.clear"
    };
    app.desktop_automation.call(session, method, job).await
}

async fn figcraft_desktop_command(
    app: &App,
    session: &str,
    command: &str,
    args: Value,
) -> Result<Value> {
    omc_mcp::validate_figcraft_tool("run_command", &args)?;
    let attached = app.desktop_automation.attached();
    let prepare = app.router.clone();
    let prepare_session = session.to_owned();
    let prepare_command = command.to_owned();
    let params = tokio::task::spawn_blocking(move || {
        if attached {
            prepare.fig_desktop_arguments(&prepare_session, &prepare_command, &args)
        } else {
            prepare.fig_headless_view(&prepare_session, &prepare_command, &args)
        }
    })
    .await
    .map_err(|_| EngineError::new("internal_error", "desktop command worker stopped"))??;
    if !attached {
        return Ok(params);
    }
    let value = app
        .desktop_automation
        .call(session, command, params)
        .await?;
    let router = app.router.clone();
    let session = session.to_owned();
    if command == "window.new" {
        return tokio::task::spawn_blocking(move || router.fig_window_result(&session, value))
            .await
            .map_err(|_| EngineError::new("internal_error", "desktop result worker stopped"))?;
    }
    let update = matches!(
        command,
        "view.nextPage"
            | "view.prevPage"
            | "tool.place"
            | "text.edit.begin"
            | "dev.focus"
            | "dev.unfocus"
    );
    tokio::task::spawn_blocking(move || router.fig_desktop_result(&session, value, update, false))
        .await
        .map_err(|_| EngineError::new("internal_error", "desktop result worker stopped"))?
}

async fn close_mcp(State(app): State<App>, headers: HeaderMap) -> Response {
    let session = match header(&headers, "mcp-session-id") {
        Ok(s) => s.to_owned(),
        Err(_) => return StatusCode::BAD_REQUEST.into_response(),
    };
    if app.workspace.session(&session).is_ok() {
        let _ = clear_fig_preview(&app, &session).await;
    }
    app.router.end_session(&session);
    match app.workspace.session_close(&session) {
        Ok(_) => StatusCode::NO_CONTENT.into_response(),
        Err(_) => StatusCode::NOT_FOUND.into_response(),
    }
}
fn mcp_error(id: Value, code: i32, message: &str) -> Response {
    Json(json!({"jsonrpc":"2.0","id":id,"error":{"code":code,"message":message}})).into_response()
}
fn string<'a>(args: &'a Value, key: &str) -> Result<&'a str> {
    args[key]
        .as_str()
        .ok_or_else(|| EngineError::invalid(format!("{key} required")))
}
fn io_error(error: std::io::Error) -> EngineError {
    EngineError::new("storage_unavailable", error.to_string())
}
fn publish_descriptor(path: &std::path::Path, value: &Value) -> Result<()> {
    publish_private(path, value.to_string().as_bytes())
}
fn publish_private(path: &std::path::Path, bytes: &[u8]) -> Result<()> {
    let parent = path.parent().unwrap();
    let temporary = parent.join(format!(".service-{}", uuid::Uuid::new_v4().simple()));
    let mut options = std::fs::OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&temporary).map_err(io_error)?;
    let result = (|| {
        file.write_all(bytes).map_err(io_error)?;
        file.sync_all().map_err(io_error)?;
        drop(file);
        std::fs::rename(&temporary, path).map_err(io_error)?;
        omc_assets::sync_directory(parent)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(temporary);
    }
    result
}
