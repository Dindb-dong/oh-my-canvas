//! A compatibility surface for FigCraft calls on the native OMC document authority.
mod advanced;
mod starters;
pub(crate) use advanced::{dev_diff, dev_status, prototype_settings};
mod branches;
pub(super) mod clipboard;
mod core;
mod data;
pub(super) mod defaults;
mod design;
mod editing;
pub(super) mod font_download;
mod geometry;
mod images;
mod inspect;
pub(super) mod plugins;
pub(super) mod preview;
mod preferences;
pub(crate) mod publish_server;
mod selection_paint;
mod tabs;
pub(super) mod text;
mod versions;

use super::*;
use base64::Engine;
pub(crate) use design::export::normalize_fig_export_setting;
use omc_model::{NodeKind, rank_between};

const COMMANDS: &[(&str, &str, bool, &str)] = &[
    (
        "edit.setDefaultProperties",
        "Set default properties",
        false,
        "id?",
    ),
    ("edit.repeat", "Repeat last command", true, ""),
    (
        "data.fill",
        "Fill copies with data",
        true,
        "id, rows, gap?, formats?, dir?, format?, scale?",
    ),
    ("collab.host", "Start live session", false, "port?, bind?"),
    ("collab.registerLinks", "Open native invite links in Oh My Canvas", false, "on?"),
    ("collab.share", "Share with a join code", false, "via?, access?, bind?, port?, name?"),
    ("collab.join", "Join live session", false, "link | code"),
    ("collab.peers", "People in this file", false, ""),
    ("collab.publish", "Publish to server", false, "server, key?, name?"),
    ("collab.files", "Your online files", false, "refresh?"),
    ("collab.manageFile", "Manage published file", false, "file, server?, owner?, action, access?, label?, link?, name?"),
    ("collab.openFile", "Open online file", false, "file, server?"),
    ("collab.forgetFile", "Forget online file", false, "file, server?"),
    ("collab.report", "Report file to server operator", false, "reason"),
    ("collab.recoverFile", "Recover online file", false, "path, file, server?, session, client, seq, secret?"),
    ("collab.serverInfo", "Server info", false, "server"),
    ("pref.publishServer", "Server for online sharing", false, "url?"),
    ("collab.diff", "Show sync changes", false, "against?"),
    ("collab.reconnect", "Reconnect live session", false, ""),
    (
        "collab.removePerson",
        "Remove from session",
        false,
        "client",
    ),
    ("collab.cursor", "Show cursor", false, "x?, y?"),
    ("collab.cursorChat", "Cursor chat", false, "text?"),
    ("collab.follow", "Follow", false, "client?"),
    ("collab.spotlight", "Spotlight me", false, "on?"),
    ("collab.leave", "Leave live session", false, ""),
    ("collab.stop", "Stop live session", false, ""),
    (
        "command.batch",
        "Run several commands",
        true,
        "label?, onError?, commands",
    ),
    ("doc.list", "List documents", false, ""),
    ("template.list", "List templates", false, ""),
    (
        "file.newFromTemplate",
        "New from template",
        false,
        "template?, name?",
    ),
    ("file.newBoard", "New board", false, "name?"),
    ("file.new", "New document", false, "name?"),
    ("file.open", "Open document", false, "path"),
    ("file.save", "Save document", false, "path?, overwrite?"),
    ("file.saveAs", "Save as", false, "path | data"),
    (
        "node.create",
        "Create layer",
        true,
        "type, parent?, index?, x?, y?, width?, height?, text?, name?, props?, select?",
    ),
    ("node.set", "Set layer properties", true, "ids?, props"),
    ("select.set", "Select layers", false, "ids"),
    (
        "selection.setPaint",
        "Change selection color",
        true,
        "targets, paint",
    ),
    ("select.none", "Clear selection", false, ""),
    ("edit.undo", "Undo", false, ""),
    ("edit.redo", "Redo", false, ""),
    (
        "frame.create",
        "Create frame",
        true,
        "x?, y?, width?, height?, parent?, index?, name?, props?, select?",
    ),
    (
        "shape.rectangle",
        "Rectangle",
        true,
        "x, y, width, height, parent?, index?, name?, props?, select?",
    ),
    (
        "shape.ellipse",
        "Ellipse",
        true,
        "x, y, width, height, parent?, index?, name?, props?, select?",
    ),
    (
        "shape.polygon",
        "Polygon",
        true,
        "x, y, width, height, parent?, index?, name?, props? {pointCount}, select?",
    ),
    (
        "shape.star",
        "Star",
        true,
        "x, y, width, height, parent?, index?, name?, props? {pointCount, innerRadius}, select?",
    ),
    (
        "shape.line",
        "Line",
        true,
        "x, y, width, parent?, index?, name?, props?, select?",
    ),
    (
        "text.create",
        "Text",
        true,
        "text | characters, x, y, parent?, index?, name?, width?, props?, select?",
    ),
    ("node.get", "Get layer", false, "id, fields?"),
    ("select.add", "Add to selection", false, "ids"),
    ("select.remove", "Remove from selection", false, "ids"),
    ("select.all", "Select all", false, ""),
    ("select.inverse", "Invert selection", false, ""),
    ("select.children", "Select children", false, ""),
    ("select.parent", "Select parent", false, ""),
    ("select.next", "Select next sibling", false, ""),
    ("select.previous", "Select previous sibling", false, ""),
    (
        "select.byName",
        "Select layers by name",
        false,
        "query, page?",
    ),
    ("edit.delete", "Delete layers", true, "ids?"),
    ("page.add", "Add page", true, "name?"),
    ("page.select", "Go to page", false, "id | index"),
    ("page.rename", "Rename page", true, "id?, name"),
    ("page.delete", "Delete page", true, "id?"),
    ("page.duplicate", "Duplicate page", true, "id?"),
    ("page.move", "Move page", true, "id?, index"),
    ("page.list", "List pages", false, ""),
    (
        "file.export",
        "Export",
        false,
        "ids?, format?, path?, scale? | size?, quality?",
    ),
    (
        "file.exportSvg",
        "Export selection as SVG",
        false,
        "ids?, path?, scale? | size?",
    ),
];

fn commands() -> impl Iterator<Item = &'static (&'static str, &'static str, bool, &'static str)> {
    COMMANDS
        .iter()
        .chain(core::COMMANDS)
        .chain(editing::COMMANDS)
        .chain(advanced::COMMANDS)
        .chain(geometry::COMMANDS)
        .chain(tabs::COMMANDS)
        .chain(clipboard::COMMANDS)
        .chain(design::COMMANDS)
        .chain(crate::desktop_commands::FIGCRAFT_COMMANDS)
        .chain(text::COMMANDS)
        .chain(versions::COMMANDS)
        .chain(preferences::COMMANDS)
        .chain(branches::COMMANDS)
        .chain(images::COMMANDS)
        .chain(inspect::COMMANDS)
        .chain(plugins::COMMANDS)
        .chain(plugins::widgets::COMMANDS)
        .chain(super::figcraft_file::FILE_COMMANDS)
        .chain(super::figcraft_catalog::COMMANDS)
}

pub fn tools() -> Vec<Value> {
    let tool = |name: &str, description: &str, mut props: Value, required: &[&str]| {
        props["document"] = json!({"type":"string","description":"Native document ID; defaults to this MCP session's document."});
        json!({"name":name,"description":description,"inputSchema":{"type":"object","properties":props,"required":required,"additionalProperties":false}})
    };
    let ids = json!({"type":"array","items":{"type":"integer","minimum":1},"maxItems":200});
    let inspect = json!({"depth":{"type":"integer","minimum":0,"maximum":12}});
    vec![
        tool(
            "list_commands",
            "List implemented FigCraft-compatible commands.",
            json!({"filter":{"type":"string"}}),
            &[],
        ),
        tool(
            "run_command",
            "Run one FigCraft-compatible command.",
            json!({"command":{"type":"string"},"params":{"type":"object"}}),
            &["command"],
        ),
        tool(
            "batch",
            "Run editable steps as one undo operation. Earlier results can be referenced by name or index.",
            json!({"commands":{"type":"array","minItems":1,"maxItems":100,"items":{"type":"object"}},"label":{"type":"string"},"onError":{"type":"string","enum":["abort","continue"]}}),
            &["commands"],
        ),
        tool(
            "create_node",
            "Create an editable layer and select it in this MCP session.",
            json!({
                "type":{"type":"string","enum":["frame","rectangle","ellipse","line","text","component","polygon","star"]},
                "parent":{"type":"integer","minimum":1},"index":{"type":"integer","minimum":0},
                "x":{"type":"number"},"y":{"type":"number"},"width":{"type":"number"},"height":{"type":"number"},
                "name":{"type":"string"},"text":{"type":"string"},"props":{"type":"object"},"select":{"type":"boolean"}
            }),
            &["type"],
        ),
        tool(
            "set_properties",
            "Set supported layer properties in one undo step.",
            json!({"ids":ids,"props":{"type":"object"}}),
            &["props"],
        ),
        tool(
            "inspect_document",
            "Inspect the current document and its editable layer tree.",
            inspect.clone(),
            &[],
        ),
        tool(
            "get_node",
            "Read one layer and its subtree.",
            json!({"id":{"type":"integer","minimum":1},"depth":inspect["depth"]}),
            &["id"],
        ),
        tool(
            "select",
            "Set the MCP session's layer selection.",
            json!({"ids":ids}),
            &["ids"],
        ),
        tool(
            "export",
            "Export selected layers as PNG, JPG, WebP, SVG or PDF.",
            json!({"ids":ids,"format":{"type":"string","enum":["png","jpg","webp","svg","pdf"]},"scale":{"type":"number","minimum":0.1,"maximum":8}}),
            &[],
        ),
        tool(
            "screenshot",
            "Render the selected layers or the current page as PNG.",
            json!({"ids":ids,"scale":{"type":"number","minimum":0.1,"maximum":8},"maxSize":{"type":"integer","minimum":0},
                "window":{"anyOf":[{"type":"boolean"},{"type":"integer","minimum":1}]}}),
            &[],
        ),
        tool(
            "type_text",
            "Replace a layer’s text by ID, or type at the caret in the attached desktop’s active text edit.",
            json!({"id":{"type":"integer","minimum":1},"text":{"type":"string"}}),
            &["text"],
        ),
        tool(
            "open_file",
            "Open a file into an editable native document.",
            json!({"path":{"type":"string"},"reload":{"type":"boolean"}}),
            &["path"],
        ),
        tool(
            "save_file",
            "Save the current document as an editable archive.",
            json!({"path":{"type":"string"}}),
            &[],
        ),
        tool(
            "pointer",
            "Send a pointer gesture to the attached desktop canvas.",
            json!({"kind":{"type":"string","enum":["click","double","drag","down","move","up","hover"]},
                "x":{"type":"number"},"y":{"type":"number"},
                "to":{"type":"array","items":{"type":"number"},"minItems":2,"maxItems":2},
                "steps":{"type":"integer","minimum":0},"tool":{"type":"string"},
                "pressure":{"type":"number"},"pressureTo":{"type":"number"},
                "alt":{"type":"boolean"},"cmd":{"type":"boolean"},"ctrl":{"type":"boolean"},"shift":{"type":"boolean"}}),
            &["x", "y"],
        ),
        tool(
            "key",
            "Send a key to the attached desktop canvas.",
            json!({
                "key":{"type":"string"},"alt":{"type":"boolean"},"cmd":{"type":"boolean"},"ctrl":{"type":"boolean"},"shift":{"type":"boolean"}
            }),
            &["key"],
        ),
        tool(
            "inspect_ui",
            "Inspect the attached desktop window.",
            json!({}),
            &[],
        ),
        tool(
            "undo",
            "Undo the last eligible edit by this MCP author.",
            json!({}),
            &[],
        ),
        tool(
            "redo",
            "Redo the last eligible edit by this MCP author.",
            json!({}),
            &[],
        ),
    ]
}

impl ToolRouter {
    pub fn fig_bind_collaboration_tab(&self, session: &str, document: &str) -> Result<()> {
        let id = native_id(document)?;
        self.workspace.bind(session, &id)?;
        self.context(session, &id)?;
        self.fig_record_tab(session, json!({"document":document}))?;
        Ok(())
    }
    pub fn native_shape_builder(&self, session: &str, args: &Value) -> Result<Value> {
        let document = self.workspace.target(session, Some(string(args, "documentId")?))?;
        let snapshot = self.workspace.snapshot(&document)?;
        let sequence = string(args, "sequence")?.parse::<u64>()
            .map_err(|_| EngineError::invalid("sequence must be a native revision number"))?;
        if string(args, "epoch")? != snapshot.epoch || sequence != snapshot.sequence {
            return Err(EngineError::new("stale_revision", "The selected shapes changed during the gesture"));
        }
        let page = snapshot.pages.iter().find(|page| page.id == args["page"])
            .ok_or_else(|| EngineError::invalid("shape builder page is unavailable"))?;
        self.context_from(session, &snapshot)?;
        let mut state = self.state(session, &document)?;
        state.page_id = page.id.clone();
        state.root = page.root_node_id.clone();
        let layers = args["layers"].as_array().filter(|items| (1..=24).contains(&items.len()))
            .ok_or_else(|| EngineError::invalid("select 1–24 layers"))?;
        let aliases = layers.iter().map(|layer| {
            let raw = layer.as_str().filter(|id| snapshot.nodes.contains_key(*id))
                .ok_or_else(|| EngineError::invalid("selected shape no longer exists"))?;
            Ok(json!(self.fig_alias(session, &document, raw)))
        }).collect::<Result<Vec<_>>>()?;
        let command = if args["remove"] == true { "shapeBuilder.remove" } else { "shapeBuilder.merge" };
        let mut result = self.fig_geometry_command(session, &snapshot, &state, &aliases, command,
            &json!({"points":args["points"]}))?;
        let current = self.workspace.snapshot(&document)?;
        let selected = result.get("id").map(|id| vec![id.clone()])
            .or_else(|| result["changed"].as_array().cloned()).unwrap_or_default();
        result["nativeSelection"] = json!(self.fig_layers(session, &current, &selected)?);
        Ok(result)
    }

    pub fn fig_collaboration_page(&self, session: &str, document: &str) -> Result<String> {
        if self.state(session, document).is_err() {
            self.context(session, document)?;
        }
        Ok(self.state(session, document)?.page_id)
    }
    pub fn call_figcraft(&self, session: &str, tool: &str, args: Value) -> Result<Value> {
        let command = if tool == "run_command" {
            args["command"].as_str().unwrap_or("")
        } else {
            tool
        };
        let repeatable = !preview::active()
            && !matches!(command, "edit.repeat" | "edit.undo" | "edit.redo")
            && (matches!(tool, "create_node" | "set_properties" | "batch")
                || commands()
                    .find(|definition| definition.0 == command)
                    .is_some_and(|definition| definition.2));
        let last = repeatable.then(|| (tool.to_owned(), args.clone()));
        let result = self.fig_execute(session, tool, args)?;
        if let Some(last) = last {
            self.fig_repeat
                .lock()
                .unwrap()
                .insert(session.to_owned(), last);
        }
        Ok(result)
    }

    fn fig_execute(&self, session: &str, tool: &str, args: Value) -> Result<Value> {
        self.workspace.session(session)?;
        let _session_fonts = self.fig_font_scope(session);
        let definition = tools()
            .into_iter()
            .find(|definition| definition["name"] == tool)
            .ok_or_else(|| {
                EngineError::new(
                    "unsupported_feature",
                    format!("FigCraft tool {tool} is not implemented"),
                )
            })?;
        schema::check(&definition["inputSchema"], &args, "args")?;
        if !preview::active() && !preview::preserves_preview(tool, &args) {
            self.take_fig_preview(session);
        }
        if tool == "list_commands" {
            let filter = args["filter"].as_str().unwrap_or("").to_lowercase();
            let mut seen = std::collections::BTreeSet::new();
            return Ok(json!(commands()
                .filter(|(id,label,_,params)| seen.insert(*id) && [id,label,params].iter().any(|s| s.to_lowercase().contains(&filter)))
                .map(|(id,label,undoable,params)| json!({"id":id,"label":label,"undoable":undoable,"params":params}))
                .collect::<Vec<_>>()));
        }
        let empty = json!({});
        let (name, params) = if tool == "run_command" {
            (
                string(&args, "command")?,
                args.get("params").unwrap_or(&empty),
            )
        } else {
            (tool, &args)
        };
        if plugins::COMMANDS.iter().any(|command| command.0 == name) {
            return self.fig_plugins_command(session, name, &args, params);
        }
        if plugins::widgets::COMMANDS
            .iter()
            .any(|command| command.0 == name)
        {
            return self.fig_widget_command(session, name, &args, params);
        }
        match name {
            "pref.autoSave" | "pref.language" | "pref.userName" => {
                return self.fig_profile_preference(name, params);
            }
            "pref.renameDuplicates" => return self.fig_rename_duplicates(params),
            "pref.publishServer" => return self.fig_set_publish_server(params),
            "edit.repeat" => {
                schema::check(
                    &json!({"type":"object","additionalProperties":false}),
                    params,
                    "params",
                )?;
                let (previous, mut arguments) = self
                    .fig_repeat
                    .lock()
                    .unwrap()
                    .get(session)
                    .cloned()
                    .ok_or_else(|| EngineError::invalid("nothing to repeat"))?;
                if let Some(document) = args.get("document") {
                    arguments["document"] = document.clone();
                } else if let Some(arguments) = arguments.as_object_mut() {
                    arguments.remove("document");
                }
                return self.fig_execute(session, &previous, arguments);
            }
            "open_file" | "file.open" => {
                return self.fig_record_tab(session, self.fig_open_file(session, params)?);
            }
            "file.openRecent" => {
                return self.fig_record_tab(session, self.fig_open_recent(session, params)?);
            }
            "file.recover" => {
                return self.fig_record_tab(session, self.fig_recover_file(session, params)?);
            }
            "doc.list" | "doc.switch" | "doc.nextTab" | "doc.previousTab" | "file.moveTab"
            | "file.close" => {
                return self.fig_tabs_command(session, name, params);
            }
            "template.list" | "file.newFromTemplate" => {
                return self.fig_starter_command(session, name, params);
            }
            "file.new" | "file.newBoard" => {
                let board = name == "file.newBoard";
                let title = params["name"].as_str().unwrap_or(if board {
                    "Untitled board"
                } else {
                    "Untitled"
                });
                let content = if board {
                    let mut content = DocumentContent::empty(title);
                    content.metadata.insert("boardDocument".into(), json!(true));
                    content
                        .nodes
                        .get_mut(&content.pages[0].root_node_id)
                        .unwrap()
                        .properties
                        .insert("fill".into(), json!("#fbfaf8"));
                    Some(content)
                } else {
                    None
                };
                let doc = self.workspace.create(session, title, content)?;
                self.context_from(session, &doc)?;
                return self
                    .fig_record_tab(session, json!({"id":external_id(&doc.id),"name":doc.title}));
            }
            _ => {}
        }
        if name == "text.endPreview" {
            return Ok(json!({"ended":self.take_fig_preview(session).is_some()}));
        }
        if name == "text.fonts" {
            return self.fig_font_inventory(session, params);
        }
        if name == "font.downloads" {
            return Ok(self.fig_font_downloads.list(&self.workspace.profile));
        }
        if matches!(name, "text.loadFont" | "text.rescanFonts" | "font.download")
            && args.get("document").is_none()
            && self.workspace.session(session)?.binding.is_none()
        {
            return self.fig_font_command(session, None, name, params);
        }
        let create_type = match name {
            "frame.create" => Some("frame"),
            "shape.rectangle" => Some("rectangle"),
            "shape.ellipse" => Some("ellipse"),
            "shape.line" => Some("line"),
            "shape.polygon" => Some("polygon"),
            "shape.star" => Some("star"),
            "text.create" => Some("text"),
            _ => None,
        };
        let normalized = if let Some(kind) = create_type {
            let mut normalized = params.clone();
            if !normalized.is_object() {
                return Err(EngineError::invalid("params must be an object"));
            }
            if let Some(characters) = normalized.as_object_mut().unwrap().remove("characters") {
                normalized["text"] = characters;
            }
            if name == "frame.create" {
                design::apply_frame_preset(&mut normalized)?;
            }
            normalized["type"] = kind.into();
            Some(normalized)
        } else {
            None
        };
        let (name, params) = normalized
            .as_ref()
            .map_or((name, params), |params| ("node.create", params));
        let target = args["document"].as_str().map(native_id).transpose()?;
        let id = self.workspace.target(session, target.as_deref())?;
        let mut snapshot = self.workspace.snapshot(&id)?;
        if name == "text.preview" {
            return self.fig_preview(session, &snapshot, params);
        }
        let preview = (name == "screenshot")
            .then(|| self.fig_preview_for(session, &snapshot))
            .flatten();
        let state_key = (session.into(), id.clone());
        let current = self.states.lock().unwrap().get(&state_key).cloned();
        if current.as_ref().is_none_or(|state| {
            state.epoch != snapshot.epoch
                || !snapshot.pages.iter().any(|page| page.id == state.page_id)
        }) {
            self.context_from(session, &snapshot)?;
        }
        let state = self.state(session, &id)?;
        if name == "data.fill" {
            return self.fig_data_fill(session, &snapshot, &state, params);
        }
        if name == "selection.setPaint" {
            return self.fig_selection_set_paint(session, &snapshot, params);
        }
        if let Some(result) = self.fig_file_command(session, &snapshot, &state, name, params) {
            if name == "file.duplicate" {
                return self.fig_record_tab(session, result?);
            }
            return result;
        }
        if name.starts_with("page.") && COMMANDS.iter().any(|command| command.0 == name) {
            return self.fig_page_command(session, &snapshot, &state, name, params);
        }
        let _ = self.fig_alias(session, &id, &state.root);
        let mut selection = state.view["selection"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        selection.retain(|alias| self.fig_layer(session, &snapshot, alias).is_ok());
        if name == "edit.setDefaultProperties" {
            return self.fig_creation_defaults(session, &snapshot, &state, &selection, params);
        }
        if defaults::headless_tool_command(name) {
            return self.fig_headless_tool(session, &snapshot, &state, name, params);
        }
        if core::COMMANDS.iter().any(|command| command.0 == name) {
            return self.fig_core_command(session, &snapshot, &state, &selection, name, params);
        }
        if editing::COMMANDS.iter().any(|command| command.0 == name) {
            return self.fig_editing_command(session, &snapshot, &state, &selection, name, params);
        }
        if advanced::COMMANDS.iter().any(|command| command.0 == name) {
            return self.fig_advanced_command(session, &snapshot, &state, &selection, name, params);
        }
        if geometry::COMMANDS.iter().any(|command| command.0 == name) {
            return self.fig_geometry_command(session, &snapshot, &state, &selection, name, params);
        }
        if text::COMMANDS.iter().any(|command| command.0 == name) {
            return self.fig_text_command(session, &snapshot, &state, &selection, name, params);
        }
        if clipboard::COMMANDS.iter().any(|command| command.0 == name) {
            return self
                .fig_clipboard_command(session, &snapshot, &state, &selection, name, params);
        }
        if design::COMMANDS.iter().any(|command| command.0 == name) {
            return self.fig_design_command(session, &snapshot, &state, &selection, name, params);
        }
        if branches::COMMANDS.iter().any(|command| command.0 == name) {
            return self.fig_branch_command(session, &snapshot, name, params);
        }
        if versions::COMMANDS.iter().any(|command| command.0 == name) {
            return self.fig_versions_command(session, &snapshot, &state, name, params);
        }
        if images::COMMANDS.iter().any(|command| command.0 == name) {
            return self.fig_images_command(session, &snapshot, &state, &selection, name, params);
        }
        if inspect::COMMANDS.iter().any(|command| command.0 == name) {
            return self.fig_inspect_command(session, &snapshot, &state, &selection, name, params);
        }
        if super::figcraft_catalog::COMMANDS
            .iter()
            .any(|command| command.0 == name)
        {
            return self.fig_catalog_command(session, &snapshot, &state, &selection, name, params);
        }
        let depth = params["depth"]
            .as_u64()
            .unwrap_or(if name == "get_node" { 1 } else { 4 }) as usize;
        match name {
            "save_file" | "file.save" | "file.saveAs" => {
                self.fig_save_file(session, &snapshot, &state, params, name == "file.saveAs")
            }
            "collab.diff" => {
                schema::check(
                    &json!({"type":"object","additionalProperties":false,"properties":{"against":{"type":"string","enum":["undo","saved"]}}}),
                    params,
                    "params",
                )?;
                let saved =
                    (params["against"] == "saved").then(|| state.fig_saved_revision.unwrap_or(0));
                let caller = self.workspace.session(session)?;
                let path = self.workspace.document_path(&snapshot.id)?;
                self.workspace.workers.call(
                    &path,
                    "collaboration_changes",
                    json!({"author":caller.author,"session":session,"saved":saved}),
                )
            }
            "inspect_document" => {
                let mut budget = 300;
                let tree = children(&snapshot, &state.root)
                    .into_iter()
                    .take(300)
                    .map(|node| self.fig_node(session, &snapshot, node, depth, &mut budget))
                    .collect::<Vec<_>>();
                Ok(
                    json!({"id":external_id(&id),"name":snapshot.title,"currentPage":self.fig_alias(session,&id,&state.root),
                    "pages":snapshot.pages.iter().map(|p|json!({"id":self.fig_alias(session,&id,&p.root_node_id),"name":p.title})).collect::<Vec<_>>(),
                    "colorProfile":omc_style::ColorProfile::from_metadata(&snapshot.metadata).name(),
                    "selection":selection,"layers":tree,"revision":snapshot.sequence,"truncated":budget==0,
                    "path":state.fig_file.as_ref().map(|file| &file.path),
                    "dirty":state.fig_saved_revision != Some(snapshot.sequence)}),
                )
            }
            "get_node" | "node.get" => {
                let layer = self.fig_layer(session, &snapshot, &params["id"]);
                let project = layer
                    .as_ref()
                    .ok()
                    .is_none_or(|id| snapshot.nodes[id].kind == NodeKind::Instance);
                let projection =
                    project.then(|| omc_scene::resolve_components(&snapshot, Some(&state.page_id)));
                let snapshot = projection
                    .as_ref()
                    .map_or(&snapshot, |projected| projected.snapshot.as_ref());
                let layer = self.fig_layer(session, snapshot, &params["id"])?;
                let mut node =
                    self.fig_node(session, snapshot, &snapshot.nodes[&layer], depth, &mut 300);
                if let Some(fields) = params.get("fields") {
                    let fields = fields
                        .as_array()
                        .ok_or_else(|| EngineError::invalid("fields must be an array"))?;
                    node.as_object_mut()
                        .unwrap()
                        .retain(|key, _| fields.iter().any(|field| field == key));
                }
                Ok(node)
            }
            "select" | "select.set" | "select.none" | "select.add" | "select.remove"
            | "select.all" | "select.inverse" | "select.children" | "select.parent"
            | "select.next" | "select.previous" | "select.byName" => {
                let ids = self.fig_select(session, &snapshot, &state, &selection, name, params)?;
                self.fig_selection(&state_key, &ids);
                Ok(json!({"selection":ids}))
            }
            "edit.delete" => {
                let raw = self.fig_layers(session, &snapshot, fig_ids(params, &selection)?)?;
                if !raw.is_empty() {
                    self.mutate(session, &id, "delete", &json!({"ids":raw}), &Value::Null)?;
                }
                self.fig_selection(&state_key, &[]);
                Ok(json!({"deleted":raw.len()}))
            }
            "type_text" => {
                let layer = self.fig_layer(session, &snapshot, &params["id"])?;
                self.mutate(
                    session,
                    &id,
                    "edit_text",
                    &json!({"action":"replace","id":layer,"text":params["text"]}),
                    &Value::Null,
                )?;
                Ok(json!({"ok":true}))
            }
            "create_node" | "node.create" | "set_properties" | "node.set" | "batch"
            | "command.batch" => {
                let sequence = snapshot.sequence;
                let mut commands = Vec::new();
                let node_command = |name: &str| match name {
                    "create_node" | "node.create" => "node.create",
                    _ => "node.set",
                };
                let result = if matches!(name, "batch" | "command.batch") {
                    let definition = tools()
                        .into_iter()
                        .find(|tool| tool["name"] == "batch")
                        .unwrap();
                    schema::check(&definition["inputSchema"], params, "batch")?;
                    let steps = params["commands"].as_array().unwrap();
                    let continue_on_error = params["onError"] == "continue";
                    if continue_on_error
                        && snapshot.nodes.len().saturating_mul(steps.len()) > 500_000
                    {
                        return Err(EngineError::new(
                            "resource_limit",
                            "continuing batch exceeds the document step budget",
                        ));
                    }
                    let mut results = Vec::new();
                    let mut outcomes = Vec::new();
                    let mut named = BTreeMap::new();
                    for (index, step) in steps.iter().enumerate() {
                        let command = string(step, "command")?;
                        if step.as_object().is_none_or(|step| {
                            step.keys()
                                .any(|key| !matches!(key.as_str(), "command" | "params" | "as"))
                        }) {
                            return Err(EngineError::invalid("unknown batch step property"));
                        }
                        if let Some(label) = step.get("as") {
                            let label = label.as_str().ok_or_else(|| {
                                EngineError::invalid("batch step name must be a string")
                            })?;
                            if label.is_empty() || named.insert(label.to_owned(), index).is_some() {
                                return Err(EngineError::invalid(
                                    "batch step names must be non-empty and unique",
                                ));
                            }
                        }
                        let mut step_params =
                            step.get("params").cloned().unwrap_or_else(|| json!({}));
                        let checkpoint = continue_on_error
                            .then(|| (snapshot.clone(), selection.clone(), commands.len()));
                        let applied =
                            references(&mut step_params, &results, &named, 0).and_then(|_| {
                                self.fig_edit(
                                    session,
                                    &state.root,
                                    &mut snapshot,
                                    &mut selection,
                                    &mut commands,
                                    command,
                                    &step_params,
                                )
                            });
                        match applied {
                            Ok(value) => {
                                if continue_on_error {
                                    outcomes.push(json!({"step":index,"command":command,"ok":true,"result":value}));
                                }
                                results.push(value);
                            }
                            Err(error) => {
                                let Some((saved_snapshot, saved_selection, command_count)) =
                                    checkpoint
                                else {
                                    return Err(EngineError::new(
                                        error.code,
                                        format!("Step {index} ({command}): {}", error.message),
                                    ));
                                };
                                snapshot = saved_snapshot;
                                selection = saved_selection;
                                commands.truncate(command_count);
                                outcomes.push(json!({"step":index,"command":command,"ok":false,"error":error.message}));
                                results.push(Value::Null);
                            }
                        }
                    }
                    if continue_on_error {
                        json!(outcomes)
                    } else {
                        json!(results)
                    }
                } else {
                    self.fig_edit(
                        session,
                        &state.root,
                        &mut snapshot,
                        &mut selection,
                        &mut commands,
                        node_command(name),
                        params,
                    )?
                };
                let mut command = Command::Batch { commands };
                if let Command::Batch { commands } = &mut command
                    && commands.len() == 1
                {
                    command = commands.pop().unwrap();
                }
                if command.operation_count() > 0 {
                    self.submit(session, &id, command, &Value::Null, Some(sequence))?;
                }
                self.fig_selection(&state_key, &selection);
                Ok(result)
            }
            "undo" | "redo" | "edit.undo" | "edit.redo" => self.mutate(
                session,
                &id,
                if name.ends_with("undo") {
                    "undo"
                } else {
                    "redo"
                },
                &json!({}),
                &Value::Null,
            ),
            "export" | "file.export" | "file.exportSvg" | "screenshot" => {
                let defaults = if name == "screenshot" {
                    &[][..]
                } else {
                    &selection
                };
                let raw = self.fig_layers(session, &snapshot, fig_ids(params, defaults)?)?;
                let ids = if raw.is_empty() && matches!(name, "file.export" | "file.exportSvg") {
                    let mut children = children(&snapshot, &state.root)
                        .into_iter()
                        .map(|node| node.id.clone())
                        .collect::<Vec<_>>();
                    if children.is_empty() {
                        children.push(state.root.clone());
                    }
                    children
                } else if raw.is_empty() {
                    vec![state.root.clone()]
                } else {
                    raw
                };
                let path_format = params["path"]
                    .as_str()
                    .and_then(|path| std::path::Path::new(path).extension())
                    .and_then(|extension| extension.to_str())
                    .filter(|extension| {
                        matches!(
                            *extension,
                            "png" | "jpg" | "jpeg" | "pdf" | "svg" | "webp" | "xml"
                        )
                    });
                let format = if name == "file.exportSvg" {
                    "svg"
                } else {
                    params["format"].as_str().or(path_format).unwrap_or("png")
                };
                let format = format.to_ascii_lowercase();
                let format = if format == "jpeg" {
                    "jpg"
                } else {
                    format.as_str()
                };
                let scale = params["scale"].as_f64().unwrap_or(1.);
                let mut args = json!({
                    "documentId":external_id(&id), "ids":ids,
                    "format":if format == "xml" { "svg" } else { format },
                    "scale":scale,
                });
                schema::validate("export_selection", &args)?;
                args["format"] = json!(format);
                let mut options = params.clone();
                if let Some(options) = options.as_object_mut() {
                    options.remove("format");
                    options
                        .entry("svgOutlineText")
                        .or_insert(Value::Bool(false));
                }
                let setting = normalize_fig_export_setting(&options)?;
                design::export::apply_export_options(
                    &snapshot,
                    &state.page_id,
                    &ids,
                    format,
                    &setting,
                    &mut args,
                )?;
                if let Some(path) = params.get("path") {
                    args["filePath"] = json!(
                        path.as_str()
                            .ok_or_else(|| EngineError::invalid("path must be a string"))?
                    );
                }
                if params.get("size").is_some_and(|size| !size.is_null()) {
                    if params.get("scale").is_some() {
                        return Err(EngineError::invalid("choose either size or scale"));
                    }
                    args["constraint"] = fig_export_size(&setting["size"])?;
                }
                if name == "screenshot" {
                    args["maxSize"] = json!(params["maxSize"].as_u64().unwrap_or(1600));
                }
                if let Some(quality) = params.get("quality") {
                    args["quality"] = json!(
                        quality
                            .as_f64()
                            .filter(|n| (1. ..=100.).contains(n))
                            .ok_or_else(|| EngineError::invalid("quality must be from 1 to 100"))?
                            / 100.
                    );
                }
                let mut result = if let Some(preview) = preview {
                    args["pageId"] = json!(state.page_id);
                    let artifact = self.export_snapshot_native((*preview).clone(), &args)?;
                    self.deliver_export(session, &args, artifact)?
                } else {
                    self.export_tool(session, &id, "export_selection", args)?
                };
                if let Some(path) = result.get("filePath") {
                    result["path"] = path.clone();
                } else if name != "screenshot" {
                    if let Some(data) = result["base64"].as_str() {
                        result["data"] = json!(data);
                    } else if let Some(content) = result["content"].as_str() {
                        result["data"] =
                            json!(base64::engine::general_purpose::STANDARD.encode(content));
                    }
                }
                if result.get("byteLength").is_some() {
                    result["bytes"] = result["byteLength"].clone();
                }
                if format == "xml" {
                    let warnings = result["diagnostics"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter(|diagnostic| {
                            diagnostic["code"] == "vector_drawable_compatibility"
                                || (setting["vdCompat"] != "ignore"
                                    && diagnostic["fidelityLost"] == true)
                        })
                        .filter_map(|diagnostic| diagnostic["original"].as_str())
                        .map(str::to_owned)
                        .collect::<Vec<_>>();
                    result["warnings"] = json!(warnings);
                }
                Ok(result)
            }
            _ => Err(EngineError::new(
                "unsupported_feature",
                format!("FigCraft command {name} is not implemented"),
            )),
        }
    }

    pub fn fig_desktop_result(
        &self,
        session: &str,
        mut result: Value,
        input: bool,
        bind: bool,
    ) -> Result<Value> {
        if let Some(windows) = result.get_mut("windows").and_then(Value::as_array_mut) {
            for window in windows {
                if let Some(id) = window["active"].as_str() {
                    window["active"] = json!(external_id(id));
                }
                if let Some(files) = window["files"].as_array_mut() {
                    for file in files {
                        if let Some(id) = file["id"].as_str() {
                            file["id"] = json!(external_id(id));
                        }
                    }
                }
            }
        }
        let Some(document) = result["documentId"].as_str().map(native_id).transpose()? else {
            return Ok(result);
        };
        let snapshot = self.workspace.snapshot(&document)?;
        let key = (session.into(), document.clone());
        let current = self.states.lock().unwrap().get(&key).cloned();
        if current.is_none_or(|state| state.epoch != snapshot.epoch) {
            self.context_from(session, &snapshot)?;
        }
        if bind {
            self.workspace.bind_if_unbound(session, &document)?;
        }
        if input
            && let Some(page) = snapshot
                .pages
                .iter()
                .find(|page| result["pageId"] == page.id)
        {
            let mut states = self.states.lock().unwrap();
            let state = states
                .get_mut(&key)
                .ok_or_else(|| EngineError::invalid("desktop session closed"))?;
            if state.page_id != page.id {
                state.page_id = page.id.clone();
                state.root = page.root_node_id.clone();
                state.aliases.clear();
                state.next_alias = 0;
            }
        }
        let selection = result["selection"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .filter(|id| snapshot.nodes.contains_key(*id))
            .map(|id| json!(self.fig_alias(session, &document, id)))
            .collect::<Vec<_>>();
        if result.get("selection").is_some() {
            self.fig_selection(&key, &selection);
            result["selection"] = json!(selection);
        }
        result["documentId"] = json!(external_id(&document));
        if let Some(start) = result
            .as_object_mut()
            .and_then(|result| result.remove("prototypeStart"))
            .and_then(|start| start.as_str().map(str::to_owned))
            .filter(|start| snapshot.nodes.contains_key(start))
        {
            result["start"] = json!(self.fig_alias(session, &document, &start));
        }
        if let Some(fields) = result.as_object_mut() {
            let layer = fields.remove("devFocusLayer");
            let page = fields.remove("devFocusPageRoot");
            let exited = fields.remove("devFocusExit");
            if layer.is_some() || exited.is_some() {
                fields.remove("documentId");
                fields.remove("pageId");
                fields.remove("selection");
                if let Some(id) = layer.as_ref().and_then(Value::as_str) {
                    fields.insert("id".into(), json!(self.fig_alias(session, &document, id)));
                }
                if let Some(id) = page.as_ref().and_then(Value::as_str) {
                    fields.insert("page".into(), json!(self.fig_alias(session, &document, id)));
                }
            }
        }
        Ok(result)
    }

    pub(super) fn fig_layer(
        &self,
        session: &str,
        snapshot: &DocumentSnapshot,
        id: &Value,
    ) -> Result<String> {
        let id = id
            .as_u64()
            .filter(|n| *n > 0)
            .ok_or_else(|| EngineError::invalid("numeric layer ID required"))?;
        let state = self.states.lock().unwrap();
        let raw = state
            .get(&(session.into(), snapshot.id.clone()))
            .and_then(|state| {
                state
                    .fig_aliases
                    .iter()
                    .find_map(|(node, alias)| (*alias == id).then(|| node.clone()))
            })
            .ok_or_else(|| EngineError::invalid("unknown FigCraft layer ID"))?;
        if !snapshot.nodes.contains_key(&raw) {
            return Err(EngineError::invalid(
                "layer not found in the target document",
            ));
        }
        Ok(raw)
    }

    pub(super) fn fig_alias(&self, session: &str, document: &str, node: &str) -> u64 {
        let mut states = self.states.lock().unwrap();
        let aliases = &mut states
            .get_mut(&(session.into(), document.into()))
            .unwrap()
            .fig_aliases;
        *aliases.entry(node.into()).or_insert_with(|| {
            self.next_fig_alias
                .fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        })
    }

    pub(super) fn fig_layers(
        &self,
        session: &str,
        snapshot: &DocumentSnapshot,
        ids: &[Value],
    ) -> Result<Vec<String>> {
        ids.iter()
            .map(|alias| self.fig_layer(session, snapshot, alias))
            .collect()
    }

    fn fig_page_command(
        &self,
        session: &str,
        snapshot: &DocumentSnapshot,
        state: &ViewState,
        name: &str,
        params: &Value,
    ) -> Result<Value> {
        let document = &snapshot.id;
        let describe = |page: &omc_model::Page, current: &str| {
            json!({
                "id":self.fig_alias(session, document, &page.root_node_id),
                "name":page.title, "children":children(snapshot, &page.root_node_id).len(), "current":page.id == current, "divider":false
            })
        };
        if name == "page.list" {
            return Ok(json!(
                snapshot
                    .pages
                    .iter()
                    .map(|page| describe(page, &state.page_id))
                    .collect::<Vec<_>>()
            ));
        }
        let selected = if let Some(alias) = params.get("id") {
            let root = self.fig_layer(session, snapshot, alias)?;
            snapshot.pages.iter().find(|page| page.root_node_id == root)
        } else if name == "page.select" {
            params["index"]
                .as_u64()
                .and_then(|index| snapshot.pages.get(index as usize))
        } else {
            snapshot.pages.iter().find(|page| page.id == state.page_id)
        }
        .ok_or_else(|| EngineError::invalid("page not found"))?;
        if name == "page.select" {
            let key = (session.into(), document.clone());
            let mut states = self.states.lock().unwrap();
            let state = states.get_mut(&key).unwrap();
            state.page_id = selected.id.clone();
            state.root = selected.root_node_id.clone();
            drop(states);
            self.fig_selection(&key, &[]);
            return Ok(describe(selected, &selected.id));
        }
        let action = match name {
            "page.add" => "create",
            "page.move" => "reorder",
            "page.rename" => "rename",
            "page.delete" => "delete",
            "page.duplicate" => "duplicate",
            _ => return Err(EngineError::invalid("unknown page command")),
        };
        let mut args =
            json!({"documentId":external_id(document),"action":action, "pageId":selected.id});
        if let Some(name) = params.get("name") {
            args["name"] = name.clone();
        }
        if action == "reorder" {
            args["index"] = json!(
                params["index"]
                    .as_u64()
                    .ok_or_else(|| EngineError::invalid("page index required"))?
            );
        }
        schema::validate("page", &args)?;
        self.mutate(session, document, "page", &args, &Value::Null)?;
        let updated = self.workspace.snapshot(document)?;
        let current = self.state(session, document)?.page_id;
        let result = if matches!(action, "create" | "duplicate" | "delete") {
            self.fig_selection(&(session.into(), document.clone()), &[]);
            updated.pages.iter().find(|page| page.id == current)
        } else {
            updated.pages.iter().find(|page| page.id == selected.id)
        }
        .ok_or_else(|| EngineError::invalid("page not found after command"))?;
        Ok(
            json!({"id":self.fig_alias(session, document, &result.root_node_id), "name":result.title}),
        )
    }

    fn fig_select(
        &self,
        session: &str,
        snapshot: &DocumentSnapshot,
        state: &ViewState,
        selection: &[Value],
        command: &str,
        params: &Value,
    ) -> Result<Vec<Value>> {
        let current = self.fig_layers(session, snapshot, selection)?;
        let roots = || children(snapshot, &state.root);
        let selected = match command {
            "select.none" => vec![],
            "select" | "select.set" | "select.add" | "select.remove" => {
                let ids = self.fig_layers(session, snapshot, fig_ids(params, &[])?)?;
                match command {
                    "select.add" => current.into_iter().chain(ids).collect(),
                    "select.remove" => current.into_iter().filter(|id| !ids.contains(id)).collect(),
                    _ => ids,
                }
            }
            "select.all" | "select.inverse" => roots()
                .into_iter()
                .filter(|node| command == "select.all" || !current.contains(&node.id))
                .map(|node| node.id.clone())
                .collect(),
            "select.children" => current
                .iter()
                .flat_map(|parent| children(snapshot, parent))
                .map(|node| node.id.clone())
                .collect(),
            "select.parent" => current
                .iter()
                .filter_map(|id| snapshot.nodes[id].parent_id.clone())
                .filter(|id| *id != state.root)
                .collect(),
            "select.next" | "select.previous" => {
                let anchor = current.first();
                let siblings = anchor
                    .and_then(|id| snapshot.nodes[id].parent_id.as_deref())
                    .map(|parent| children(snapshot, parent))
                    .unwrap_or_else(roots);
                let step = if command == "select.next" {
                    1
                } else {
                    siblings.len().saturating_sub(1)
                };
                let index = anchor
                    .and_then(|id| siblings.iter().position(|node| node.id == *id))
                    .map(|index| (index + step) % siblings.len())
                    .unwrap_or(0);
                siblings
                    .get(index)
                    .map(|node| node.id.clone())
                    .into_iter()
                    .collect()
            }
            "select.byName" => {
                let query = string(params, "query")?.to_lowercase();
                let roots = if params["page"] == "all" {
                    snapshot
                        .pages
                        .iter()
                        .map(|page| page.root_node_id.clone())
                        .collect()
                } else if let Some(alias) = params.get("page") {
                    vec![self.fig_layer(session, snapshot, alias)?]
                } else {
                    vec![state.root.clone()]
                };
                let mut matches = Vec::new();
                let mut pending = roots;
                while let Some(parent) = pending.pop() {
                    for node in children(snapshot, &parent) {
                        pending.push(node.id.clone());
                        if node
                            .string("name")
                            .unwrap_or("")
                            .to_lowercase()
                            .contains(&query)
                        {
                            matches.push(node.id.clone());
                        }
                    }
                }
                matches
            }
            _ => return Err(EngineError::invalid("unknown selection command")),
        };
        let mut seen = std::collections::HashSet::new();
        Ok(selected
            .into_iter()
            .filter(|id| seen.insert(id.clone()))
            .map(|id| json!(self.fig_alias(session, &snapshot.id, &id)))
            .collect())
    }

    fn fig_node(
        &self,
        session: &str,
        snapshot: &DocumentSnapshot,
        node: &Node,
        depth: usize,
        budget: &mut usize,
    ) -> Value {
        *budget = budget.saturating_sub(1);
        let kind = layer_type(node);
        let mut out = json!({"id":self.fig_alias(session, &snapshot.id, &node.id),"type":kind});
        for property in [
            "name",
            "x",
            "y",
            "width",
            "height",
            "rotation",
            "fill",
            "opacity",
            "visible",
            "locked",
            "devStatus",
            "fontFamily",
            "fontSize",
            "cornerRadius",
            "textAlign",
            "textDecoration",
            "textCase",
            "textWrapStyle",
            "textPath",
            "textDirection",
            "textMaxLines",
            "fontFeatures",
            "fontVariations",
            "textDecorationStyle",
            "textDecorationColor",
            "textDecorationThickness",
            "textRuns",
            "fontWeight",
            "fontStyle",
            "lineHeight",
            "letterSpacing",
            "stroke",
            "fills",
            "strokes",
            "pointCount",
            "innerRadius",
            "isMask",
            "isMaskGroup",
            "path",
            "fillRule",
            "transform",
            "booleanOperation",
            "arrowHead",
            "strokeBrush",
            "widthProfile",
            "slotName",
            "slotPropertyId",
            "imageFit",
            "imageCrop",
            "imageFilters",
            "assetHash",
            "layout",
            "layoutGrids",
            "guides",
            "exports",
            "effects",
            "shadows",
            "booleanOperandOperation",
            "sectionContentsHidden",
        ] {
            if let Some(value) = node.properties.get(property) {
                out[property] = value.clone();
            }
        }
        let interactions = advanced::prototype_actions::stored(node);
        if !interactions.is_empty() {
            let mut data = json!(interactions);
            advanced::prototype_actions::wire_ids(&mut data, &|id| {
                if snapshot.nodes.contains_key(id) {
                    json!(self.fig_alias(session, &snapshot.id, id))
                } else {
                    Value::Null
                }
            });
            out["interactions"] = data;
        }
        for (property, key) in [("strokeWeight", "strokeWidth"), ("clip", "clipContent")] {
            if let Some(value) = node.properties.get(key) {
                out[property] = value.clone();
            }
        }
        if let Some(value) = node.properties.get("lineHeight").and_then(Value::as_str) {
            if let Some(px) = value
                .strip_suffix("px")
                .and_then(|px| px.parse::<f64>().ok())
            {
                out["lineHeight"] = json!(px);
            } else if value == "normal" {
                out["lineHeight"] = json!("auto");
            }
        }
        if out["textAlign"] == "justify" {
            out["textAlign"] = json!("justified");
        }
        if let Some(text) = node.properties.get("text") {
            out["characters"] = text.clone();
        }
        if depth > 0 {
            let mut output = vec![];
            for child in children(snapshot, &node.id) {
                if *budget == 0 {
                    break;
                }
                output.push(self.fig_node(session, snapshot, child, depth - 1, budget));
            }
            out["children"] = json!(output);
        }
        out
    }

    pub(super) fn fig_selection(&self, key: &(String, String), selection: &[Value]) {
        if let Some(state) = self.states.lock().unwrap().get_mut(key) {
            if !state.view.is_object() {
                state.view = json!({});
            }
            state.view["selection"] = json!(selection);
            state.view["guide"] = Value::Null;
        }
    }

    fn fig_edit(
        &self,
        session: &str,
        root: &str,
        snapshot: &mut DocumentSnapshot,
        selection: &mut Vec<Value>,
        commands: &mut Vec<Command>,
        command: &str,
        params: &Value,
    ) -> Result<Value> {
        match command {
            "node.create" => {
                let schema = tools()
                    .into_iter()
                    .find(|tool| tool["name"] == "create_node")
                    .unwrap();
                schema::check(&schema["inputSchema"], params, "params")?;
                let layer = string(params, "type")?;
                let kind = match layer {
                    "frame" => NodeKind::Frame,
                    "rectangle" => NodeKind::Rect,
                    "ellipse" => NodeKind::Ellipse,
                    "line" => NodeKind::Line,
                    "polygon" | "star" => NodeKind::Path,
                    "text" => NodeKind::Text,
                    "component" => NodeKind::Component,
                    _ => return Err(EngineError::invalid("unsupported FigCraft layer type")),
                };
                let parent = params
                    .get("parent")
                    .map(|alias| self.fig_layer(session, snapshot, alias))
                    .transpose()?
                    .unwrap_or_else(|| root.into());
                let siblings = children(snapshot, &parent);
                let index = params["index"].as_u64().unwrap_or(siblings.len() as u64) as usize;
                if index > siblings.len() {
                    return Err(EngineError::invalid("layer index exceeds child count"));
                }
                let left = index.checked_sub(1).and_then(|i| siblings.get(i));
                let right = siblings.get(index);
                let mut node = Node::new(kind);
                node.home_shard = snapshot
                    .nodes
                    .get(&parent)
                    .ok_or_else(|| EngineError::invalid("parent not found"))?
                    .home_shard
                    .clone();
                node.rank = rank_between(
                    left.map(|n| n.rank.as_str()),
                    right.map(|n| n.rank.as_str()),
                )
                .ok_or_else(|| {
                    EngineError::new("resource_limit", "sibling ordering requires rank rebalance")
                })?;
                node.parent_id = Some(parent);
                node.properties = fig_properties(params.get("props").unwrap_or(&json!({})))?;
                node.properties.retain(|_, value| !value.is_null());
                for field in ["name", "text", "x", "y", "width", "height"] {
                    if let Some(value) = params.get(field) {
                        node.properties.insert(field.into(), value.clone());
                    }
                }
                for (field, default) in [
                    ("x", 0.),
                    ("y", 0.),
                    ("width", 100.),
                    ("height", if kind == NodeKind::Line { 0. } else { 100. }),
                ] {
                    if kind != NodeKind::Text || matches!(field, "x" | "y") {
                        node.properties
                            .entry(field.into())
                            .or_insert(json!(default));
                    }
                }
                if kind == NodeKind::Line {
                    node.properties
                        .entry("stroke".into())
                        .or_insert(json!("#000000"));
                    node.properties
                        .entry("strokeWidth".into())
                        .or_insert(json!(1.));
                }
                if kind == NodeKind::Path {
                    node.properties.insert("primitive".into(), json!(layer));
                    fig_primitive(&mut node)?;
                }
                let id = self.fig_alias(session, &snapshot.id, &node.id);
                if params["select"] != false {
                    *selection = vec![json!(id)];
                }
                snapshot.nodes.insert(node.id.clone(), node.clone());
                if node.properties.contains_key(advanced::dev_status::STATUS) {
                    if !advanced::dev_status::can_mark(snapshot, &node.id) {
                        return Err(EngineError::invalid(
                            "Choose a top-level frame, component or section for devStatus",
                        ));
                    }
                    if node.string(advanced::dev_status::STATUS) == Some("readyForDev") {
                        let tree = advanced::dev_status::Tree::new(&snapshot.nodes);
                        node.properties.insert(
                            advanced::dev_status::BASELINE.into(),
                            json!(tree.hash(&node.id)),
                        );
                        node.properties.insert(
                            advanced::dev_diff::SNAPSHOT.into(),
                            advanced::dev_diff::Baseline::build(&tree, &node.id).value(),
                        );

                        snapshot.nodes.insert(node.id.clone(), node.clone());
                    }
                }
                commands.push(Command::NodeCreate { node: node.clone() });
                Ok(json!({"id":id,"node":self.fig_node(session,snapshot,&node,0,&mut 1)}))
            }
            "node.set" => {
                let values = fig_properties(
                    params
                        .get("props")
                        .ok_or_else(|| EngineError::invalid("props required"))?,
                )?;
                if values.is_empty() {
                    return Err(EngineError::invalid("props must not be empty"));
                }
                let ids = fig_ids(params, selection)?;
                if ids.is_empty() {
                    return Err(EngineError::invalid("no layers selected"));
                }
                let mut nodes = Vec::new();
                let mut marked = Vec::new();
                for alias in ids {
                    let id = match self.fig_layer(session, snapshot, alias) {
                        Ok(id) => id,
                        Err(_) => {
                            nodes.push(self.fig_set_component_override(
                                session, root, snapshot, alias, &values, commands,
                            )?);
                            continue;
                        }
                    };
                    let node = &snapshot.nodes[&id];
                    if node.string("libraryId").is_some() && node.string("sourceNodeId").is_some() {
                        return Err(EngineError::invalid(
                            "Linked library definitions are read-only",
                        ));
                    }
                    let mut patch = values.clone();
                    if let Some(status) = patch.get(advanced::dev_status::STATUS) {
                        if !advanced::dev_status::can_mark(snapshot, &id) {
                            return Err(EngineError::invalid(
                                "Choose a top-level frame, component or section for devStatus",
                            ));
                        }
                        if status == "readyForDev" {
                            marked.push(id.clone());
                        } else {
                            patch.insert(advanced::dev_status::BASELINE.into(), Value::Null);
                            patch.insert(advanced::dev_diff::SNAPSHOT.into(), Value::Null);
                        }
                    }
                    let node = snapshot.nodes.get_mut(&id).unwrap();
                    if let Some(text) = patch.remove("text") {
                        let text = text
                            .as_str()
                            .ok_or_else(|| EngineError::invalid("characters must be a string"))?;
                        if node.kind != NodeKind::Text {
                            return Err(EngineError::invalid("target is not text"));
                        }
                        commands.push(Command::TextReplace {
                            node_id: id.clone(),
                            text: text.into(),
                        });
                        node.properties.insert("text".into(), json!(text));
                        node.properties.remove("textRuns");
                    }
                    let unset = patch
                        .iter()
                        .filter(|(key, value)| {
                            value.is_null() && node.properties.contains_key(*key)
                        })
                        .map(|(key, _)| key.clone())
                        .collect::<Vec<_>>();
                    if !unset.is_empty() {
                        for key in &unset {
                            node.properties.remove(key);
                        }
                        commands.push(Command::NodeUnset {
                            node_id: id.clone(),
                            properties: unset,
                        });
                    }
                    patch.retain(|_, value| !value.is_null());
                    node.properties.extend(patch.clone());
                    if node.kind == NodeKind::Path
                        && matches!(node.string("primitive"), Some("polygon" | "star"))
                        && ["pointCount", "innerRadius", "width", "height"]
                            .iter()
                            .any(|key| patch.contains_key(*key))
                    {
                        fig_primitive(node)?;
                        patch.insert("path".into(), node.properties["path"].clone());
                    }
                    let node = node.clone();
                    if !patch.is_empty() {
                        commands.push(Command::NodeSet {
                            node_id: id,
                            properties: patch,
                        });
                    }
                    nodes.push(self.fig_node(session, snapshot, &node, 0, &mut 1));
                }
                if !marked.is_empty() {
                    let tree = advanced::dev_status::Tree::new(&snapshot.nodes);
                    let hashes = marked
                        .into_iter()
                        .map(|id| {
                            let hash = tree.hash(&id);
                            let baseline = advanced::dev_diff::Baseline::build(&tree, &id).value();
                            (id, hash, baseline)
                        })
                        .collect::<Vec<_>>();
                    for (id, hash, baseline) in hashes {
                        let properties = Properties::from([
                            (advanced::dev_status::BASELINE.into(), json!(hash)),
                            (advanced::dev_diff::SNAPSHOT.into(), baseline),
                        ]);
                        snapshot
                            .nodes
                            .get_mut(&id)
                            .unwrap()
                            .properties
                            .extend(properties.clone());
                        commands.push(Command::NodeSet {
                            node_id: id,
                            properties,
                        });
                    }
                }
                Ok(json!({"ok":true,"nodes":nodes}))
            }
            _ => Err(EngineError::new(
                "unsupported_feature",
                format!("batch command {command} is not implemented"),
            )),
        }
    }
}

fn layer_type(node: &Node) -> &'static str {
    match node.effective_kind() {
        NodeKind::Rect if node.string("primitive") == Some("slice") => "SLICE",
        NodeKind::Rect => "RECTANGLE",
        NodeKind::Path => match node.string("primitive") {
            Some("polygon") => "POLYGON",
            Some("star") => "STAR",
            _ => "VECTOR",
        },
        NodeKind::Frame if node.properties.get("isVariantSet") == Some(&json!(true)) => {
            "COMPONENT_SET"
        }
        NodeKind::Frame if node.properties.get("isSection") == Some(&Value::Bool(true)) => {
            "SECTION"
        }
        NodeKind::Frame => "FRAME",
        NodeKind::Group => "GROUP",
        NodeKind::Ellipse => "ELLIPSE",
        NodeKind::Line => "LINE",
        NodeKind::Text => "TEXT",
        NodeKind::Image => "IMAGE",
        NodeKind::Component => "COMPONENT",
        NodeKind::Instance => "INSTANCE",
    }
}

fn fig_ids<'a>(params: &'a Value, selected: &'a [Value]) -> Result<&'a [Value]> {
    params.get("ids").map_or(Ok(selected), |ids| {
        ids.as_array()
            .filter(|ids| ids.len() <= 200)
            .map(Vec::as_slice)
            .ok_or_else(|| EngineError::invalid("ids must be an array of at most 200 layer IDs"))
    })
}

fn fig_export_size(size: &Value) -> Result<Value> {
    let (by, value) = if let Some(size) = size.as_str() {
        let (value, by) = match size.chars().last() {
            Some('x') => (size.strip_suffix('x').unwrap(), "scale"),
            Some('w') => (size.strip_suffix('w').unwrap(), "width"),
            Some('h') => (size.strip_suffix('h').unwrap(), "height"),
            _ => return Err(EngineError::invalid("size must end with x, w or h")),
        };
        (by, value.parse::<f64>().ok())
    } else {
        (
            size["by"].as_str().unwrap_or_default(),
            size["value"].as_f64(),
        )
    };
    let value = value
        .filter(|value| value.is_finite() && *value > 0.)
        .ok_or_else(|| EngineError::invalid("size value must be positive"))?;
    if !matches!(by, "scale" | "width" | "height") {
        return Err(EngineError::invalid(
            "size.by must be scale, width or height",
        ));
    }
    Ok(json!({"type":by,"value":value}))
}

fn fig_primitive(node: &mut Node) -> Result<()> {
    let star = node.string("primitive") == Some("star");
    let points =
        node.properties
            .get("pointCount")
            .map_or(Ok(if star { 5 } else { 3 }), |count| {
                count
                    .as_u64()
                    .filter(|n| (3..=60).contains(n))
                    .ok_or_else(|| {
                        EngineError::invalid("pointCount must be an integer from 3 to 60")
                    })
            })?;
    let radius = node
        .properties
        .get("innerRadius")
        .map_or(Ok(0.45), |radius| {
            radius
                .as_f64()
                .filter(|n| (0. ..=1.).contains(n))
                .ok_or_else(|| EngineError::invalid("innerRadius must be between 0 and 1"))
        })?;
    let sides = if star { points * 2 } else { points };
    let path = super::mutations::regular_polygon_path(
        [
            0.,
            0.,
            node.number("width", 100.),
            node.number("height", 100.),
        ],
        sides as usize,
        if star { radius } else { 1. },
    );
    node.properties.insert("pointCount".into(), json!(points));
    if star {
        node.properties.insert("innerRadius".into(), json!(radius));
    }
    node.properties.insert("path".into(), json!(path));
    Ok(())
}

fn fig_properties(value: &Value) -> Result<Properties> {
    let mut out = Properties::new();
    let object = value
        .as_object()
        .ok_or_else(|| EngineError::invalid("props must be an object"))?;
    for (property, value) in object {
        let (key, value) = match property.as_str() {
            "characters" => ("text", value.clone()),
            "devStatus" => (
                advanced::dev_status::STATUS,
                advanced::dev_status::parse(value)?,
            ),
            "strokeWeight" => ("strokeWidth", value.clone()),
            "clip" if value.is_boolean() => ("clipContent", value.clone()),
            "opacity" if value.is_string() => {
                let value = value
                    .as_str()
                    .and_then(|s| s.strip_suffix('%'))
                    .and_then(|s| s.parse::<f64>().ok())
                    .filter(|n| (0. ..=100.).contains(n))
                    .ok_or_else(|| {
                        EngineError::invalid("opacity must be 0–1 or a percentage from 0% to 100%")
                    })?;
                ("opacity", json!(value / 100.))
            }
            "fill" | "stroke" if value.is_null() || value == "none" => {
                let stack = if property == "fill" {
                    "fills"
                } else {
                    "strokes"
                };
                out.insert(stack.into(), Value::Null);
                (property.as_str(), json!("transparent"))
            }
            "fill" | "stroke"
                if value
                    .as_str()
                    .is_some_and(|s| omc_style::parse_color(s).is_some()) =>
            {
                let stack = if property == "fill" {
                    "fills"
                } else {
                    "strokes"
                };
                out.insert(stack.into(), Value::Null);
                (property.as_str(), value.clone())
            }
            "lineHeight" if value == "auto" => ("lineHeight", json!("normal")),
            "lineHeight" if value.is_number() => ("lineHeight", json!(format!("{}px", value))),
            "lineHeight" | "letterSpacing" if value.as_str().is_some_and(|s| s.ends_with('%')) => {
                let percent = value
                    .as_str()
                    .unwrap()
                    .trim_end_matches('%')
                    .parse::<f64>()
                    .ok()
                    .filter(|n| n.is_finite())
                    .ok_or_else(|| EngineError::invalid("expected a percentage"))?;
                (property.as_str(), json!(format!("{}em", percent / 100.)))
            }
            "textAlign" if value == "justified" => ("textAlign", json!("justify")),
            "textDecoration" if value == "strikethrough" => {
                ("textDecoration", json!("line-through"))
            }
            "fontStyle" => {
                let (weight, slant) = fig_font_style(value)?;
                out.insert("fontWeight".into(), json!(weight));
                ("fontStyle", json!(slant))
            }
            "name" | "text" | "fontFamily" if !value.is_string() => {
                return Err(EngineError::invalid(format!("{property} must be a string")));
            }
            "visible" | "locked" if !value.is_boolean() => {
                return Err(EngineError::invalid(format!(
                    "{property} must be a boolean"
                )));
            }
            key @ ("name" | "text" | "x" | "y" | "width" | "height" | "rotation" | "opacity"
            | "visible" | "locked" | "fontFamily" | "fontSize" | "fontWeight"
            | "cornerRadius" | "textAlign" | "textDecoration" | "letterSpacing"
            | "pointCount" | "innerRadius") => (key, value.clone()),
            _ => {
                return Err(EngineError::new(
                    "unsupported_feature",
                    format!("FigCraft property {property} is not implemented for this value"),
                ));
            }
        };
        out.insert(key.into(), value);
    }
    Ok(out)
}

fn fig_font_style(value: &Value) -> Result<(u16, &'static str)> {
    let value = value
        .as_str()
        .ok_or_else(|| EngineError::invalid("fontStyle must be a name"))?
        .to_ascii_lowercase();
    let (weight, slant) = value
        .strip_suffix("italic")
        .map_or((value.as_str(), "normal"), |weight| {
            (weight.trim(), "italic")
        });
    let weight = match weight {
        "thin" => 100,
        "extra light" | "extralight" => 200,
        "light" => 300,
        "" | "normal" | "regular" => 400,
        "medium" => 500,
        "semi bold" | "semibold" => 600,
        "bold" => 700,
        "extra bold" | "extrabold" => 800,
        "black" => 900,
        _ => return Err(EngineError::invalid("unsupported fontStyle name")),
    };
    Ok((weight, slant))
}

fn references(
    value: &mut Value,
    results: &[Value],
    names: &BTreeMap<String, usize>,
    depth: usize,
) -> Result<()> {
    if depth > 48 {
        return Err(EngineError::invalid(
            "batch reference nesting exceeds limit",
        ));
    }
    match value {
        Value::Object(object) if object.contains_key("$ref") || object.contains_key("$step") => {
            let index = match (object.get("$ref"), object.get("$step")) {
                (Some(name), None) => name.as_str().and_then(|name| names.get(name).copied()),
                (None, Some(index)) => index.as_u64().and_then(|index| usize::try_from(index).ok()),
                _ => None,
            }
            .ok_or_else(|| EngineError::invalid("invalid batch step reference"))?;
            let mut target = results.get(index).ok_or_else(|| {
                EngineError::invalid("batch step must refer to an earlier result")
            })?;
            let field = object
                .get("field")
                .map(|field| {
                    field
                        .as_str()
                        .ok_or_else(|| EngineError::invalid("reference field must be a string"))
                })
                .transpose()?
                .unwrap_or("id");
            for segment in field.split('/') {
                target = if target.is_array() {
                    segment
                        .parse::<usize>()
                        .ok()
                        .and_then(|index| target.get(index))
                } else {
                    target.get(segment)
                }
                .ok_or_else(|| EngineError::invalid("batch reference field not found"))?;
            }
            *value = target.clone();
        }
        Value::Object(object) => {
            for child in object.values_mut() {
                references(child, results, names, depth + 1)?;
            }
        }
        Value::Array(array) => {
            for child in array {
                references(child, results, names, depth + 1)?;
            }
        }
        _ => {}
    }
    Ok(())
}

impl ToolRouter {
    pub fn fig_online_document(&self, session: &str, args: &Value) -> Result<(String, String)> {
        let explicit = args["document"].as_str().map(native_id).transpose()?;
        let document = self.workspace.target(session, explicit.as_deref())?;
        self.context(session, &document)?;
        let page = self.states.lock().unwrap()[&(session.into(), document.clone())].page_id.clone();
        Ok((document, page))
    }

    pub fn fig_online_apply(
        &self,
        session: &str,
        mirror: &str,
        current: &DocumentSnapshot,
        content: &omc_model::DocumentContent,
    ) -> Result<omc_model::Revision> {
        let commands = branches::edit::commands(&current.content(), content)?;
        if commands.is_empty() {
            return Ok(current.revision());
        }
        let mut envelope = CommandEnvelope::new(
            &current.id, &current.epoch, Command::Batch { commands },
        );
        envelope.preconditions = omc_protocol::Preconditions::Revision {
            revision: current.revision(),
        };
        let result = self.workspace.execute_online(session, envelope, mirror)?;
        serde_json::from_value(result["revision"].clone())
            .map_err(|error| EngineError::new("corrupt_state",error.to_string()))
    }
}
