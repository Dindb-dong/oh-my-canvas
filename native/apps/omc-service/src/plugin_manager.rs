//! Bind the native plugin manager's operations to the session whose list it displays.
use crate::App;
use omc_protocol::{EngineError, Result};
use serde_json::{Value, json};

fn list(app: &App, session: &str) -> Result<Value> {
    app.router
        .call_figcraft(session, "run_command", json!({"command":"plugin.list"}))
}

pub(super) async fn open(app: &App, session: &str, arguments: &Value) -> Result<Value> {
    omc_mcp::validate_figcraft_tool("run_command", arguments)?;
    let router = app.router.clone();
    let owner = session.to_owned();
    let args = arguments.clone();
    let listing =
        tokio::task::spawn_blocking(move || router.call_figcraft(&owner, "run_command", args))
            .await
            .map_err(|_| EngineError::new("internal_error", "Plugin manager worker stopped"))??;
    if app.desktop_automation.attached() {
        let lease = uuid::Uuid::new_v4().simple().to_string();
        app.desktop_automation
            .call(
                session,
                "plugins.manage",
                json!({"lease":lease,"listing":listing}),
            )
            .await?;
        app.desktop_automation.set_plugin_manager(lease, session);
    }
    Ok(listing)
}

pub(super) fn desktop_action(app: &App, desktop: &str, args: &Value) -> Result<Value> {
    let operation = args["operation"].as_str().unwrap_or_default();
    if operation == "open" {
        let session = app
            .desktop_automation
            .plugin_manager_session(desktop, None)?;
        let listing = list(app, &session)?;
        let lease = uuid::Uuid::new_v4().simple().to_string();
        app.desktop_automation
            .set_plugin_manager(lease.clone(), &session);
        return Ok(json!({"lease":lease,"listing":listing}));
    }
    let lease = args["lease"]
        .as_str()
        .ok_or_else(|| EngineError::invalid("Plugin manager lease required"))?;
    let session = app
        .desktop_automation
        .plugin_manager_session(desktop, Some(lease))?;
    let mutation = match operation {
        "refresh" => None,
        "import" => Some(("plugin.import", json!({"path":args["path"]}))),
        "remove" => Some(("plugin.remove", json!({"id":args["plugin"]}))),
        "run" => Some(("plugin.run", json!({"id":args["plugin"]}))),
        _ => return Err(EngineError::invalid("Unknown plugin manager operation")),
    };
    if let Some((command, params)) = mutation {
        let mut command_args = json!({"command":command,"params":params});
        if command == "plugin.run" {
            let document = args["document"]
                .as_str()
                .ok_or_else(|| EngineError::invalid("Open a document before running a plugin"))?;
            app.router.fig_desktop_result(
                &session,
                json!({"documentId":document,"pageId":args["page"],"selection":args["selection"]}),
                true,
                false,
            )?;
            command_args["document"] = json!(document);
        }
        app.router
            .call_figcraft(&session, "run_command", command_args)?;
    }
    Ok(json!({"lease":lease,"listing":list(app, &session)?}))
}
