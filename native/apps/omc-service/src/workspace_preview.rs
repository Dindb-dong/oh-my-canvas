use crate::{App, string};
use base64::{Engine, engine::general_purpose::STANDARD};
use omc_model::Revision;
use omc_protocol::{EngineError, Result};
use serde_json::{Value, json};
use std::sync::Mutex;

// Preview jobs run on RPC blocking workers. Keep raster work serial across windows.
static RENDER_PREVIEW: Mutex<()> = Mutex::new(());

pub(super) fn preview(app: &App, args: &Value) -> Result<Value> {
    let id = string(args, "documentId")?;
    let revision: Revision = serde_json::from_value(json!({
        "epoch":args["epoch"],"sequence":args["sequence"]
    }))
    .map_err(|error| EngineError::invalid(error.to_string()))?;
    let check_visible = || {
        if app.workspace.catalog.lock().unwrap().is_home_canvas(id)? {
            Ok(())
        } else {
            Err(EngineError::invalid("canvas is not available for preview"))
        }
    };
    let _render = RENDER_PREVIEW
        .lock()
        .map_err(|_| EngineError::new("internal_error", "thumbnail worker stopped"))?;
    check_visible()?;
    let snapshot = app.workspace.snapshot(id)?;
    let actual = snapshot.revision();
    if revision.epoch != actual.epoch {
        return Err(EngineError::new(
            "epoch_mismatch",
            "canvas generation changed",
        ));
    }
    if revision.sequence != actual.sequence {
        return Err(
            EngineError::new("stale_revision", "canvas revision changed")
                .detail(json!({"currentRevision":actual})),
        );
    }
    let thumbnail = app
        .router
        .home_thumbnail_png(&snapshot)?
        .map(|bytes| STANDARD.encode(bytes));
    check_visible()?;
    Ok(json!({
        "documentId":id,"epoch":actual.epoch,"sequence":actual.sequence.to_string(),
        "thumbnail":thumbnail
    }))
}
