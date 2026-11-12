//! A compatibility surface for FigCraft calls on the native OMC document authority.
use super::*;
use omc_model::{NodeKind, rank_between};

const COMMANDS: &[(&str, &str, bool, &str)] = &[
    ("doc.list", "List documents", false, ""),
    ("file.new", "New document", false, "name?"),
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
        let target = args["document"].as_str().map(native_id).transpose()?;
        let id = self.workspace.target(session, target.as_deref())?;
        let mut snapshot = self.workspace.snapshot(&id)?;
        let state_key = (session.into(), id.clone());
        if !self.states.lock().unwrap().contains_key(&state_key) {
            self.context_from(session, &snapshot)?;
        }
        let state = self.state(session, &id)?;
        let mut selection = state.view["selection"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        selection.retain(|alias| self.fig_layer(session, &snapshot, alias).is_ok());
        let depth = params["depth"]
            .as_u64()
            .unwrap_or(if name == "get_node" { 1 } else { 4 }) as usize;
        match name {
            "inspect_document" => {
                let mut budget = 300;
                let tree = children(&snapshot, &state.root)
                    .into_iter()
                    .take(300)
                    .map(|node| self.fig_node(session, &snapshot, node, depth, &mut budget))
                    .collect::<Vec<_>>();
                Ok(
                    json!({"id":external_id(&id),"name":snapshot.title,"currentPage":state.page_id,
                    "pages":snapshot.pages.iter().map(|p|json!({"id":p.id,"name":p.title})).collect::<Vec<_>>(),
                    "selection":selection,"layers":tree,"revision":snapshot.sequence,"truncated":budget==0}),
                )
            }
            "get_node" => {
                let layer = self.fig_layer(session, &snapshot, &params["id"])?;
                Ok(self.fig_node(session, &snapshot, &snapshot.nodes[&layer], depth, &mut 300))
            }
            "select" | "select.set" | "select.none" => {
                let ids = if name == "select.none" {
                    vec![]
                } else {
                    fig_ids(params, &selection)?.to_vec()
                };
                for alias in &ids {
                    self.fig_layer(session, &snapshot, alias)?;
                }
                self.fig_selection(&state_key, &ids);
                Ok(json!({"selection":ids}))
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
            "export" | "screenshot" => {
                let raw: Vec<_> = fig_ids(params, &selection)?
                    .iter()
                    .map(|alias| self.fig_layer(session, &snapshot, alias))
                    .collect::<Result<_>>()?;
                if raw.is_empty() {
                    return self.export_tool(session, &id, "screenshot", json!({}));
                }
                self.export_tool(session, &id, "export_selection", json!({
                    "ids":raw,"format":params["format"].as_str().unwrap_or("png"),"scale":params["scale"].as_f64().unwrap_or(1.),
                }))
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
        let raw = self.resolve(session, &snapshot.id, &format!("n{id}"))?;
        if !snapshot.nodes.contains_key(&raw) {
            return Err(EngineError::invalid(
                "layer not found in the target document",
            ));
        }
        Ok(raw)
    }

    fn fig_alias(&self, session: &str, document: &str, node: &str) -> u64 {
        self.alias(session, document, node)
            .strip_prefix('n')
            .and_then(|id| id.parse().ok())
            .unwrap_or(0)
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
