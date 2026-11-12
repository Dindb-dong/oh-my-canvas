//! A compatibility surface for FigCraft calls on the native OMC document authority.
use super::*;
use omc_model::{NodeKind, rank_between};

const COMMANDS: &[(&str, &str, bool, &str)] = &[
    ("doc.list", "List documents", false, ""),
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
    ("file.export", "Export", false, "ids?, format?, scale?"),
];

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
            "Run an atomic batch of node.create and node.set steps. Earlier results can be referenced by name or index.",
            json!({"commands":{"type":"array","minItems":1,"maxItems":100,"items":{"type":"object"}},"label":{"type":"string"},"onError":{"type":"string","enum":["abort"]}}),
            &["commands"],
        ),
        tool(
            "create_node",
            "Create an editable layer and select it in this MCP session.",
            json!({
                "type":{"type":"string","enum":["frame","rectangle","ellipse","line","text","component"]},
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
            json!({"ids":ids,"scale":{"type":"number","minimum":0.1,"maximum":8}}),
            &[],
        ),
        tool(
            "type_text",
            "Replace the text in an explicit text layer.",
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
    pub fn call_figcraft(&self, session: &str, tool: &str, args: Value) -> Result<Value> {
        self.workspace.session(session)?;
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
        if tool == "list_commands" {
            let filter = args["filter"].as_str().unwrap_or("").to_lowercase();
            return Ok(json!(COMMANDS.iter()
                .filter(|(id,label,_,params)| [id,label,params].iter().any(|s| s.to_lowercase().contains(&filter)))
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
        match name {
            "open_file" | "file.open" => return self.fig_open_file(session, params),
            "doc.list" => {
                let listing = self.workspace.list(false)?;
                return Ok(json!(listing["documents"].as_array().unwrap().iter().enumerate().map(|(index, doc)| {
                    json!({"id":external_id(doc["id"].as_str().unwrap()),"name":doc["title"],"index":index})
                }).collect::<Vec<_>>()));
            }
            "file.new" => {
                let doc = self.workspace.create(
                    session,
                    params["name"].as_str().unwrap_or("Untitled"),
                    None,
                )?;
                self.context_from(session, &doc)?;
                return Ok(json!({"id":external_id(&doc.id),"name":doc.title}));
            }
            _ => {}
        }
        let create_type = match name {
            "frame.create" => Some("frame"),
            "shape.rectangle" => Some("rectangle"),
            "shape.ellipse" => Some("ellipse"),
            "shape.line" => Some("line"),
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
        let state_key = (session.into(), id.clone());
        let current = self.states.lock().unwrap().get(&state_key).cloned();
        if current.as_ref().is_none_or(|state| {
            state.epoch != snapshot.epoch
                || !snapshot.pages.iter().any(|page| page.id == state.page_id)
        }) {
            self.context_from(session, &snapshot)?;
        }
        let state = self.state(session, &id)?;
        if name.starts_with("page.") && COMMANDS.iter().any(|command| command.0 == name) {
            return self.fig_page_command(session, &snapshot, &state, name, params);
        }
        let _ = self.fig_alias(session, &id, &state.root);
        let mut selection = state.view["selection"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        selection.retain(|alias| self.fig_layer(session, &snapshot, alias).is_ok());
        let depth = params["depth"]
            .as_u64()
            .unwrap_or(if name == "get_node" { 1 } else { 4 }) as usize;
        match name {
            "save_file" | "file.save" | "file.saveAs" => {
                self.fig_save_file(session, &snapshot, &state, params, name == "file.saveAs")
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
                    "selection":selection,"layers":tree,"revision":snapshot.sequence,"truncated":budget==0}),
                )
            }
            "get_node" | "node.get" => {
                let layer = self.fig_layer(session, &snapshot, &params["id"])?;
                let mut node =
                    self.fig_node(session, &snapshot, &snapshot.nodes[&layer], depth, &mut 300);
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
            "create_node" | "node.create" | "set_properties" | "node.set" | "batch" => {
                let sequence = snapshot.sequence;
                let mut commands = Vec::new();
                let node_command = |name: &str| match name {
                    "create_node" | "node.create" => "node.create",
                    _ => "node.set",
                };
                let result = if name == "batch" {
                    let mut results = Vec::new();
                    let mut named = BTreeMap::new();
                    for (index, step) in params["commands"].as_array().unwrap().iter().enumerate() {
                        let command = string(step, "command")?;
                        if step.as_object().is_none_or(|step| {
                            step.keys()
                                .any(|key| !matches!(key.as_str(), "command" | "params" | "as"))
                        }) {
                            return Err(EngineError::invalid("unknown batch step property"));
                        }
                        let mut step_params =
                            step.get("params").cloned().unwrap_or_else(|| json!({}));
                        references(&mut step_params, &results, &named, 0)?;
                        let result = self
                            .fig_edit(
                                session,
                                &state.root,
                                &mut snapshot,
                                &mut selection,
                                &mut commands,
                                command,
                                &step_params,
                            )
                            .map_err(|e| {
                                EngineError::new(
                                    e.code,
                                    format!("Step {index} ({command}): {}", e.message),
                                )
                            })?;
                        if let Some(label) = step.get("as") {
                            let label = label.as_str().ok_or_else(|| {
                                EngineError::invalid("batch step name must be a string")
                            })?;
                            if label.is_empty() || named.insert(label.to_string(), index).is_some()
                            {
                                return Err(EngineError::invalid(
                                    "batch step names must be non-empty and unique",
                                ));
                            }
                        }
                        results.push(result);
                    }
                    json!(results)
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
                self.submit(session, &id, command, &Value::Null, Some(sequence))?;
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
            "export" | "file.export" | "screenshot" => {
                let raw = self.fig_layers(session, &snapshot, fig_ids(params, &selection)?)?;
                let ids = if raw.is_empty() {
                    vec![state.root]
                } else {
                    raw
                };
                let args = json!({"documentId":external_id(&id),"ids":ids,"format":params["format"].as_str().unwrap_or("png"),"scale":params["scale"].as_f64().unwrap_or(1.)});
                schema::validate("export_selection", &args)?;
                self.export_tool(session, &id, "export_selection", args)
            }
            _ => Err(EngineError::new(
                "unsupported_feature",
                format!("FigCraft command {name} is not implemented"),
            )),
        }
    }

    fn fig_layer(&self, session: &str, snapshot: &DocumentSnapshot, id: &Value) -> Result<String> {
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

    fn fig_alias(&self, session: &str, document: &str, node: &str) -> u64 {
        let mut states = self.states.lock().unwrap();
        let aliases = &mut states
            .get_mut(&(session.into(), document.into()))
            .unwrap()
            .fig_aliases;
        let next = aliases.len() as u64 + 1;
        *aliases.entry(node.into()).or_insert(next)
    }

    fn fig_layers(
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
        let kind = match node.kind {
            NodeKind::Rect => "RECTANGLE",
            NodeKind::Path => "VECTOR",
            NodeKind::Frame => "FRAME",
            NodeKind::Group => "GROUP",
            NodeKind::Ellipse => "ELLIPSE",
            NodeKind::Line => "LINE",
            NodeKind::Text => "TEXT",
            NodeKind::Image => "IMAGE",
            NodeKind::Component => "COMPONENT",
            NodeKind::Instance => "INSTANCE",
        };
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
            "fontFamily",
            "fontSize",
            "cornerRadius",
            "textAlign",
        ] {
            if let Some(value) = node.properties.get(property) {
                out[property] = value.clone();
            }
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

    fn fig_selection(&self, key: &(String, String), selection: &[Value]) {
        if let Some(state) = self.states.lock().unwrap().get_mut(key) {
            if !state.view.is_object() {
                state.view = json!({});
            }
            state.view["selection"] = json!(selection);
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
                let kind = match string(params, "type")? {
                    "frame" => NodeKind::Frame,
                    "rectangle" => NodeKind::Rect,
                    "ellipse" => NodeKind::Ellipse,
                    "line" => NodeKind::Line,
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
                for field in ["name", "text", "x", "y", "width", "height"] {
                    if let Some(value) = params.get(field) {
                        node.properties.insert(field.into(), value.clone());
                    }
                }
                for (field, default) in [("x", 0.), ("y", 0.), ("width", 100.), ("height", 100.)] {
                    if kind != NodeKind::Text || matches!(field, "x" | "y") {
                        node.properties
                            .entry(field.into())
                            .or_insert(json!(default));
                    }
                }
                let id = self.fig_alias(session, &snapshot.id, &node.id);
                if params["select"] != false {
                    *selection = vec![json!(id)];
                }
                commands.push(Command::NodeCreate { node: node.clone() });
                snapshot.nodes.insert(node.id.clone(), node.clone());
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
                for alias in ids {
                    let id = self.fig_layer(session, snapshot, alias)?;
                    let node = snapshot.nodes.get_mut(&id).unwrap();
                    node.properties.extend(values.clone());
                    let node = node.clone();
                    commands.push(Command::NodeSet {
                        node_id: id,
                        properties: values.clone(),
                    });
                    nodes.push(self.fig_node(session, snapshot, &node, 0, &mut 1));
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

fn fig_ids<'a>(params: &'a Value, selected: &'a [Value]) -> Result<&'a [Value]> {
    params.get("ids").map_or(Ok(selected), |ids| {
        ids.as_array()
            .filter(|ids| ids.len() <= 200)
            .map(Vec::as_slice)
            .ok_or_else(|| EngineError::invalid("ids must be an array of at most 200 layer IDs"))
    })
}

fn fig_properties(value: &Value) -> Result<Properties> {
    let mut out = Properties::new();
    for (property, value) in value
        .as_object()
        .ok_or_else(|| EngineError::invalid("props must be an object"))?
    {
        let key = match property.as_str() {
            "characters" => "text",
            key @ ("name" | "text" | "x" | "y" | "width" | "height" | "rotation" | "fill"
            | "opacity" | "visible" | "locked" | "fontFamily" | "fontSize"
            | "cornerRadius" | "textAlign" | "lineHeight" | "letterSpacing") => key,
            _ => {
                return Err(EngineError::new(
                    "unsupported_feature",
                    format!("FigCraft property {property} is not implemented"),
                ));
            }
        };
        out.insert(key.into(), value.clone());
    }
    Ok(out)
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
