use super::*;
use std::{cell::RefCell, sync::Arc};

const NESTED: &[&str] = &[
    "style.apply",
    "library.applyStyle",
    "text.setVariations",
    "text.style",
    "node.set",
    "fill.set",
    "stroke.set",
    "selection.setPaint",
    "style.update",
];

thread_local! {
    static CAPTURE: RefCell<Option<Vec<CommandEnvelope>>> = const { RefCell::new(None) };
}

struct Scope;

impl Drop for Scope {
    fn drop(&mut self) {
        CAPTURE.with(|capture| capture.take());
    }
}

pub(crate) fn active() -> bool {
    CAPTURE.with(|capture| capture.borrow().is_some())
}

/// Reuse FigCraft's real argument and paint/style preparation. The captured command is
/// only projected by the document authority. It never reaches execute or emits notices.
pub(crate) fn capture(envelope: &CommandEnvelope) -> Option<Value> {
    CAPTURE.with(|capture| {
        let mut capture = capture.borrow_mut();
        let commands = capture.as_mut()?;
        commands.push(envelope.clone());
        let sequence = match &envelope.preconditions {
            omc_protocol::Preconditions::Revision { revision } => revision.sequence,
            _ => 0,
        };
        Some(json!({"status":"preview","revision":{
            "epoch":envelope.target_epoch,"sequence":sequence.to_string()
        }}))
    })
}

pub fn preserves_preview(tool: &str, args: &Value) -> bool {
    tool == "screenshot"
        || tool == "run_command"
            && matches!(
                args["command"].as_str(),
                Some("text.preview" | "text.endPreview" | "widget.hover" | "screenshot")
            )
}

impl ToolRouter {
    pub fn take_fig_preview(&self, session: &str) -> Option<String> {
        self.fig_previews
            .lock()
            .unwrap()
            .remove(session)
            .map(|snapshot| external_id(&snapshot.id))
    }

    pub fn fig_preview_document(&self, session: &str) -> Option<String> {
        self.fig_previews
            .lock()
            .unwrap()
            .get(session)
            .map(|preview| external_id(&preview.id))
    }

    pub fn fig_preview_payload(&self, session: &str) -> Option<Value> {
        self.fig_previews
            .lock()
            .unwrap()
            .get(session)
            .map(|preview| json!({"document":external_id(&preview.id),"preview":preview.as_ref()}))
    }

    pub(super) fn fig_preview_for(
        &self,
        session: &str,
        snapshot: &DocumentSnapshot,
    ) -> Option<Arc<DocumentSnapshot>> {
        let mut previews = self.fig_previews.lock().unwrap();
        let preview = previews.get(session)?;
        if preview.id == snapshot.id && preview.epoch == snapshot.epoch {
            if preview.sequence == snapshot.sequence {
                return Some(preview.clone());
            }
            previews.remove(session);
        }
        None
    }

    pub(super) fn fig_preview(
        &self,
        session: &str,
        document: &DocumentSnapshot,
        args: &Value,
    ) -> Result<Value> {
        let nested = string(args, "command")?;
        if !NESTED.contains(&nested) {
            return Err(EngineError::invalid(
                "command cannot be used in a text preview",
            ));
        }
        let nested_params = args.get("params").cloned().unwrap_or_else(|| json!({}));
        if !nested_params.is_object() {
            return Err(EngineError::invalid("preview params must be an object"));
        }
        CAPTURE.with(|capture| capture.replace(Some(Vec::new())));
        let _scope = Scope;
        self.call_figcraft(
            session,
            "run_command",
            json!({"document":external_id(&document.id),"command":nested,"params":nested_params}),
        )?;
        let commands = CAPTURE.with(|capture| capture.take()).unwrap();
        let preview = match commands.as_slice() {
            [] => {
                self.take_fig_preview(session);
                return Ok(json!({"previewing":false}));
            }
            [command] => self.workspace.preview(session, command.clone())?,
            _ => return Err(EngineError::invalid("preview must contain one atomic edit")),
        };
        self.set_fig_preview(session, preview)?;
        Ok(json!({"previewing":true}))
    }

    pub(super) fn set_fig_preview(&self, session: &str, preview: DocumentSnapshot) -> Result<()> {
        let mut previews = self.fig_previews.lock().unwrap();
        if previews.len() >= 8 && !previews.contains_key(session) {
            return Err(EngineError::new(
                "busy",
                "eight preview sessions are already active",
            ));
        }
        previews.insert(session.to_owned(), Arc::new(preview));
        Ok(())
    }
}
