//! Compatibility adapters: every semantic write crosses the document authority.
mod extensions;
pub use extensions::capabilities as native_capabilities;
mod figcraft;
mod interchange;
pub use figcraft::tools as figcraft_tools;
mod libraries;
mod mutations;
mod resources;
pub mod schema;
use omc_model::{DocumentContent, DocumentSnapshot, Node, Properties};
use omc_protocol::{Command, CommandEnvelope, EngineError, Preconditions, Result};
use omc_workspace::Workspace;
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, HashMap},
    sync::{Arc, Mutex},
};

#[derive(Clone, Default)]
pub(crate) struct ViewState {
    pub epoch: String,
    pub page_id: String,
    pub root: String,
    pub aliases: HashMap<String, String>,
    pub next_alias: usize,
    pub view: Value,
    pub clipboard: Option<Value>,
}
pub struct ToolRouter {
    pub workspace: Arc<Workspace>,
    states: Mutex<HashMap<(String, String), ViewState>>,
    extensions: extensions::ExtensionState,
}
impl ToolRouter {
    pub fn new(workspace: Arc<Workspace>) -> Self {
        Self {
            workspace,
            states: Mutex::new(HashMap::new()),
            extensions: extensions::ExtensionState::default(),
        }
    }
    pub fn tools(&self) -> Value {
        let mut tools = schema::tools().clone();
        tools.extend(extensions::definitions());
        json!(tools)
    }
    pub fn end_session(&self, session: &str) {
        self.states.lock().unwrap().retain(|(s, _), _| s != session);
        self.extensions.release_session(session);
    }
    pub fn call(
        self: &Arc<Self>,
        session: &str,
        name: &str,
        args: Value,
        meta: Value,
    ) -> Result<Value> {
        self.workspace.session(session)?;
        let mut meta = if meta.is_object() { meta } else { json!({}) };
        meta["nativeAdapterDigest"] =
            omc_protocol::canonical_digest(&json!({"tool":name,"arguments":args}))?.into();
        if name.starts_with("native_") {
            return self.extension(session, name, args, meta);
        }
        schema::validate(name, &args)?;
        match name {
            "list_documents" => {
                let listing = self.workspace.list(false)?;
                let query = args["query"].as_str().unwrap_or("").to_lowercase();
                let mut docs: Vec<_> = listing["documents"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .filter(|d| {
                        d["title"]
                            .as_str()
                            .unwrap_or("")
                            .to_lowercase()
                            .contains(&query)
                            && (!args["starredOnly"].as_bool().unwrap_or(false)
                                || d["starred"] == true)
                    })
                    .cloned()
                    .collect();
                for d in &mut docs {
                    d["id"] = external_id(d["id"].as_str().unwrap()).into();
                }
                let total = docs.len();
                let offset = args["offset"].as_u64().unwrap_or(0) as usize;
                let limit = args["limit"].as_u64().unwrap_or(50) as usize;
                Ok(
                    json!({"ok":true,"documents":docs.into_iter().skip(offset).take(limit).collect::<Vec<_>>(),"total":total,"offset":offset}),
                )
            }
            "create_document" => {
                let snapshot = self.workspace.create(
                    session,
                    args["title"].as_str().unwrap_or("Untitled"),
                    None,
                )?;
                self.context_from(session, &snapshot)
            }
            "open_document" => {
                let id = native_id(string(&args, "id")?)?;
                self.workspace.bind(session, &id)?;
                self.context(session, &id)
            }
            "rename_document" => {
                let id = native_id(string(&args, "id")?)?;
                if !self
                    .states
                    .lock()
                    .unwrap()
                    .contains_key(&(session.into(), id.clone()))
                {
                    self.context(session, &id)?;
                }
                if let Some(replayed) = self.replay(session, &id, &meta)? {
                    return Ok(replayed);
                }
                let result = self.submit(
                    session,
                    &id,
                    Command::DocumentRename {
                        title: string(&args, "title")?.trim().into(),
                    },
                    &meta,
                    None,
                )?;
                Ok(
                    json!({"ok":true,"documentId":external_id(&id),"title":args["title"],"receipt":result}),
                )
            }
            "duplicate_document" => {
                let id = native_id(string(&args, "id")?)?;
                let original = self.workspace.snapshot(&id)?;
                let mut content = copy_content(&original);
                content.title = args["title"]
                    .as_str()
                    .map(str::to_owned)
                    .unwrap_or_else(|| format!("{} copy", original.title));
                let snapshot =
                    self.workspace
                        .create(session, &content.title.clone(), Some(content))?;
                self.context_from(session, &snapshot)
            }
            "save_document" => {
                let id = native_id(string(&args, "id")?)?;
                Ok(
                    json!({"ok":true,"documentId":external_id(&id),"saved":true,"receipt":self.workspace.checkpoint(&id)?}),
                )
            }
            "delete_document" => {
                let id = native_id(string(&args, "id")?)?;
                self.workspace
                    .delete_document(&id, string(&args, "expectedTitle")?)
            }
            "workspace" => self.workspace_tool(session, &args),
            "preferences" => self.preferences(&args),
            "import_document" => self.import_document(session, args),
            "export_document" => {
                let id = native_id(string(&args, "id")?)?;
                self.export_document(session, &id, args)
            }
            "import_resource" => self.import_resource(session, args, meta),
            "collaboration" => Err(EngineError::new(
                "unsupported_feature",
                "native network collaboration is not qualified in this preview; replica envelopes are available through the native protocol",
            )),
            _ => {
                let explicit = args["documentId"].as_str().map(native_id).transpose()?;
                let id = self.workspace.target(session, explicit.as_deref())?;
                if name == "get_context" {
                    return self.context(session, &id);
                }
                if !self
                    .states
                    .lock()
                    .unwrap()
                    .contains_key(&(session.into(), id.clone()))
                {
                    self.context(session, &id)?;
                }
                match name {
                    "select_page" => {
                        let snapshot = self.workspace.snapshot(&id)?;
                        let page = snapshot
                            .pages
                            .iter()
                            .find(|p| p.id == args["id"])
                            .ok_or_else(|| EngineError::invalid("page not found"))?;
                        {
                            let mut states = self.states.lock().unwrap();
                            let state = states.get_mut(&(session.into(), id.clone())).unwrap();
                            state.page_id = page.id.clone();
                            state.root = page.root_node_id.clone();
                            state.aliases.clear();
                        }
                        self.context_from(session, &snapshot)
                    }
                    "get_tree" | "find" | "get_styles" | "get_path" | "components" | "fonts"
                    | "assets" | "get_guide" => self.inspect(session, &id, name, &args),
                    "screenshot" | "get_html" | "export_selection" => {
                        self.export_tool(session, &id, name, args)
                    }
                    "document_assets" => self.assets_tool(session, &id, args, meta),
                    "view" => self.view_tool(session, &id, &args),
                    "page" if args["action"] == "list" => {
                        let s = self.workspace.snapshot(&id)?;
                        Ok(
                            json!({"ok":true,"revision":s.sequence,"pages":s.pages,"pageId":self.state(session,&id)?.page_id}),
                        )
                    }
                    "styles" | "libraries" => self.catalog_tool(session, &id, name, args, meta),
                    "clipboard" => self.clipboard_tool(session, &id, args, meta),
                    _ => self.mutate(session, &id, name, &args, &meta),
                }
            }
        }
    }
    pub(crate) fn state(&self, session: &str, id: &str) -> Result<ViewState> {
        self.states
            .lock()
            .unwrap()
            .get(&(session.into(), id.into()))
            .cloned()
            .ok_or_else(|| EngineError::invalid("get_context required"))
    }
    pub(crate) fn resolve(&self, session: &str, document: &str, id: &str) -> Result<String> {
        let state = self.state(session, document)?;
        if id == "root" {
            return Ok(state.root);
        }
        if omc_model::valid_id(id, "node") {
            return Ok(id.into());
        }
        state.aliases.get(id).cloned().ok_or_else(|| {
            EngineError::invalid("layer alias is not valid for this document and page")
        })
    }
    pub(crate) fn alias(&self, session: &str, document: &str, raw: &str) -> String {
        let mut states = self.states.lock().unwrap();
        let state = states.get_mut(&(session.into(), document.into())).unwrap();
        if raw == state.root {
            return "root".into();
        }
        if let Some((alias, _)) = state.aliases.iter().find(|(_, id)| *id == raw) {
            return alias.clone();
        }
        state.next_alias += 1;
        let alias = format!("n{}", state.next_alias);
        state.aliases.insert(alias.clone(), raw.into());
        alias
    }
    pub fn context(&self, session: &str, id: &str) -> Result<Value> {
        let context = self.workspace.context(id)?;
        let page = context
            .pages
            .iter()
            .find(|p| {
                self.states
                    .lock()
                    .unwrap()
                    .get(&(session.into(), id.into()))
                    .is_some_and(|s| s.page_id == p.id)
            })
            .or(context.pages.first())
            .ok_or_else(|| EngineError::new("corrupt_state", "no page"))?;
        let mut nodes = BTreeMap::new();
        for node in self.workspace.children(id, &page.root_node_id)? {
            nodes.insert(node.id.clone(), node);
        }
        self.context_from(
            session,
            &DocumentSnapshot {
                id: id.into(),
                title: context.title,
                epoch: context.revision.epoch,
                sequence: context.revision.sequence,
                pages: context.pages,
                nodes,
                metadata: context.metadata,
            },
        )
    }
    fn context_from(&self, session: &str, snapshot: &DocumentSnapshot) -> Result<Value> {
        let key = (session.into(), snapshot.id.clone());
        let (page_id, root) = {
            let mut states = self.states.lock().unwrap();
            let state = states.entry(key).or_default();
            let page = snapshot
                .pages
                .iter()
                .find(|p| p.id == state.page_id)
                .or(snapshot.pages.first())
                .ok_or_else(|| EngineError::new("corrupt_state", "no usable page"))?;
            if state.epoch != snapshot.epoch || state.page_id != page.id {
                state.aliases.clear();
                state.next_alias = 0;
            }
            state.epoch = snapshot.epoch.clone();
            state.page_id = page.id.clone();
            state.root = page.root_node_id.clone();
            (page.id.clone(), page.root_node_id.clone())
        };
        let children = children(snapshot, &root);
        let total = children.len();
        let mut boards = Vec::new();
        let mut bytes = 0;
        for node in children.into_iter().take(200) {
            let mut board = self.describe(session, &snapshot.id, node, true);
            let mut size = serde_json::to_vec(&board)
                .map_err(|e| EngineError::invalid(e.to_string()))?
                .len();
            if size > 256 * 1024 {
                board = self.describe(session, &snapshot.id, node, false);
                board["propertiesOmitted"] = true.into();
                size = serde_json::to_vec(&board)
                    .map_err(|e| EngineError::invalid(e.to_string()))?
                    .len();
            }
            if bytes + size > 512 * 1024 {
                break;
            }
            bytes += size;
            boards.push(board);
        }
        Ok(
            json!({"ok":true,"documentId":external_id(&snapshot.id),"document":{"id":external_id(&snapshot.id),"title":snapshot.title},"targetEpoch":snapshot.epoch,"revision":snapshot.sequence,"nativeRevision":{"epoch":snapshot.epoch,"sequence":snapshot.sequence.to_string()},"page":{"id":page_id,"name":snapshot.pages.iter().find(|p|p.id==page_id).unwrap().title},"pages":snapshot.pages.iter().map(|p|json!({"id":p.id,"name":p.title})).collect::<Vec<_>>(),"boards":boards.iter().map(|b|b["id"].clone()).collect::<Vec<_>>(),"boardsTruncated":boards.len()<total,"boardDetails":boards,"selection":[],"editing":null,"retryScope":self.workspace.session(session)?.retry_scope}),
        )
    }
    fn describe(&self, session: &str, doc: &str, node: &Node, detailed: bool) -> Value {
        let mut v = json!({"id":self.alias(session,doc,&node.id),"rawId":node.id,"kind":node.kind,"name":node.string("name").unwrap_or("Layer")});
        if detailed {
            v["properties"] = json!(node.properties);
            for key in ["x", "y", "width", "height", "text"] {
                if let Some(value) = node.properties.get(key) {
                    v[key] = value.clone();
                }
            }
            v["parent"] = node
                .parent_id
                .as_ref()
                .map(|p| Value::String(self.alias(session, doc, p)))
                .unwrap_or(Value::Null);
        }
        v
    }
    fn inspect(&self, session: &str, id: &str, name: &str, args: &Value) -> Result<Value> {
        if name == "assets" {
            return Ok(json!({"ok":true,"assets":[],"providers":[]}));
        }
        if name == "get_guide" {
            return Ok(
                json!({"ok":true,"text":"Native preview: explicit document targeting and durable receipts are required. Read context before editing. Native capabilities report implemented and unqualified areas. Edits use authored styles and UTF-16 ranges; imports and output carry diagnostics."}),
            );
        }
        if name == "fonts" {
            return Ok(
                json!({"ok":true,"fonts":[{"family":"sans-serif","source":"system","fallback":true}]}),
            );
        }
        let snapshot = self.workspace.snapshot(id)?;
        if name == "get_styles" {
            let projection = omc_scene::resolve_components(&snapshot, None);
            let styles = omc_style::compute_styles(&projection.snapshot, (1440., 900.));
            let mut output = Vec::new();
            for arg in args["ids"].as_array().unwrap() {
                let raw = self.resolve(session, id, arg.as_str().unwrap())?;
                let style = styles
                    .get(&raw)
                    .ok_or_else(|| EngineError::invalid("layer not found"))?;
                output.push(json!({"id":self.alias(session,id,&raw),"styles":style.values,"provenance":style.provenance,"diagnostics":style.diagnostics}));
            }
            return Ok(json!({"ok":true,"revision":snapshot.sequence,"styles":output}));
        }
        if name == "get_path" {
            let raw = self.resolve(session, id, string(args, "id")?)?;
            let node = snapshot
                .nodes
                .get(&raw)
                .ok_or_else(|| EngineError::invalid("path not found"))?;
            return Ok(
                json!({"ok":true,"id":args["id"],"revision":snapshot.sequence,"path":node.properties.get("path"),"properties":node.properties}),
            );
        }
        if name == "components" {
            let offset = args["offset"].as_u64().unwrap_or(0) as usize;
            let query = args["query"].as_str().unwrap_or("").to_lowercase();
            let all: Vec<_> = snapshot
                .nodes
                .values()
                .filter(|n| {
                    n.kind == omc_model::NodeKind::Component
                        && n.string("name")
                            .unwrap_or("")
                            .to_lowercase()
                            .contains(&query)
                })
                .collect();
            return Ok(
                json!({"ok":true,"total":all.len(),"components":all.into_iter().skip(offset).take(200).map(|n|self.describe(session,id,n,true)).collect::<Vec<_>>()}),
            );
        }
        let root = args[if name == "find" { "within" } else { "id" }]
            .as_str()
            .map(|s| self.resolve(session, id, s))
            .transpose()?
            .unwrap_or(self.state(session, id)?.root);
        let mut pending = vec![(root, 0usize)];
        let mut results = Vec::new();
        let depth = args["depth"].as_u64().unwrap_or(4) as usize;
        let mut truncated = false;
        while let Some((current, level)) = pending.pop() {
            let Some(node) = snapshot.nodes.get(&current) else {
                continue;
            };
            let matches = name != "find"
                || ["name", "text", "kind"].iter().all(|key| {
                    let Some(needle) = args[*key].as_str() else {
                        return true;
                    };
                    let hay = if *key == "kind" {
                        serde_json::to_value(node.kind)
                            .unwrap()
                            .as_str()
                            .unwrap_or("")
                            .to_owned()
                    } else {
                        node.string(key).unwrap_or("").into()
                    };
                    hay.to_lowercase().contains(&needle.to_lowercase())
                });
            if matches {
                let mut value = self.describe(
                    session,
                    id,
                    node,
                    args["detail"] == "detailed" || name == "find",
                );
                value["depth"] = json!(level);
                results.push(value);
            }
            if results.len() >= if name == "find" { 50 } else { 400 } {
                truncated = true;
                break;
            }
            if name == "find" || level < depth {
                for child in children(&snapshot, &current).into_iter().rev() {
                    pending.push((child.id.clone(), level + 1));
                }
            }
        }
        Ok(
            json!({"ok":true,"revision":snapshot.sequence,"nodes":results,"matches":if name=="find"{Some(&results)}else{None},"truncated":truncated}),
        )
    }
    pub(crate) fn replay(&self, session: &str, id: &str, meta: &Value) -> Result<Option<Value>> {
        let Some(key) = meta["oh-my-canvas/idempotency-key"].as_str() else {
            return Ok(None);
        };
        let Some(digest) = meta["nativeAdapterDigest"].as_str() else {
            return Ok(None);
        };
        let state = self.state(session, id)?;
        let Some((envelope, output)) =
            self.workspace
                .adapter_intent(session, id, &state.epoch, key, digest)?
        else {
            return Ok(None);
        };
        let receipt = self.workspace.execute(session, envelope)?;
        Ok(Some(self.receipt_output(session, id, receipt, output)))
    }
    fn receipt_output(&self, session: &str, id: &str, receipt: Value, output: Value) -> Value {
        let mut result = json!({"ok":true,"documentId":external_id(id),"revision":receipt["revision"]["sequence"].as_str().and_then(|s|s.parse::<u64>().ok()),"receipt":receipt});
        if let Some(object) = output.as_object() {
            for (key, value) in object {
                result[key] = value.clone();
            }
        }
        if let Some(raw) = result["rawIds"].as_array() {
            result["createdIds"] = json!(
                raw.iter()
                    .filter_map(Value::as_str)
                    .map(|raw| self.alias(session, id, raw))
                    .collect::<Vec<_>>()
            );
        }
        result
    }
    pub(crate) fn submit(
        &self,
        session: &str,
        id: &str,
        command: Command,
        meta: &Value,
        revision: Option<u64>,
    ) -> Result<Value> {
        let state = self.state(session, id)?;
        let mut envelope = CommandEnvelope::new(id, &state.epoch, command);
        if let Some(key) = meta["oh-my-canvas/idempotency-key"].as_str() {
            envelope.idempotency_key = key.into();
        }
        if let Some(rev) = revision {
            envelope.preconditions = Preconditions::Revision {
                revision: omc_model::Revision {
                    epoch: state.epoch,
                    sequence: rev,
                },
            };
        }
        fn created(command: &Command, out: &mut Vec<String>) {
            match command {
                Command::NodeCreate { node } => out.push(node.id.clone()),
                Command::PageCreate { root, .. } => out.push(root.id.clone()),
                Command::Batch { commands } => {
                    for command in commands {
                        created(command, out)
                    }
                }
                _ => {}
            }
        }
        let mut ids = Vec::new();
        created(&envelope.command, &mut ids);
        let mut output = json!({"rawIds":ids});
        fn catalog_id(command: &Command) -> Option<&str> {
            match command {
                Command::CatalogSet { entity_id, .. } => Some(entity_id),
                Command::Batch { commands } => commands.iter().rev().find_map(catalog_id),
                _ => None,
            }
        }
        if let Some(id) = catalog_id(&envelope.command) {
            output["id"] = id.into();
        }
        let (envelope, output) = if meta["oh-my-canvas/idempotency-key"].is_string() {
            self.workspace.prepare_adapter(
                session,
                &envelope,
                string(meta, "nativeAdapterDigest")?,
                &output,
            )?
        } else {
            (envelope, output)
        };
        let receipt = self.workspace.execute(session, envelope)?;
        Ok(self.receipt_output(session, id, receipt, output))
    }
    fn workspace_tool(&self, session: &str, args: &Value) -> Result<Value> {
        match args["action"].as_str().unwrap() {
            "state" | "show_library" => self.workspace.list(false),
            "focus" => {
                let id = native_id(string(args, "documentId")?)?;
                self.workspace.bind(session, &id)?;
                self.context(session, &id)
            }
            "close" => self
                .workspace
                .release(session, &native_id(string(args, "documentId")?)?),
            "capabilities" => Ok(extensions::capabilities()),
            "about" => Ok(
                json!({"name":"Oh My Canvas Native","version":"0.1.0","releaseStatus":"incomplete-preview","browserRuntime":false}),
            ),
            "connection" => {
                Ok(json!({"transport":"streamable-http","scope":"loopback","authenticated":true}))
            }
            "quit" => Err(EngineError::new(
                "unsupported_feature",
                "quit the native service through its owning process",
            )),
            _ => Err(EngineError::new(
                "unsupported_feature",
                "native window operation requires a desktop owner",
            )),
        }
    }
    fn preferences(&self, args: &Value) -> Result<Value> {
        let cat = self.workspace.catalog.lock().unwrap();
        let mut preferences = cat.preference()?;
        if args["action"] == "set" {
            for key in ["name", "view"] {
                if let Some(value) = args.get(key) {
                    preferences[key] = value.clone();
                }
            }
            cat.set_preference(&preferences)?;
            if let Some(starred) = args["starred"].as_bool() {
                let id = native_id(string(args, "documentId")?)?;
                cat.connection
                    .execute(
                        "UPDATE documents SET starred=?2 WHERE id=?1",
                        rusqlite_params(&id, starred),
                    )
                    .map_err(omc_workspace::catalog::sql_error)?;
            }
        }
        Ok(json!({"ok":true,"preferences":preferences}))
    }
    fn view_tool(&self, session: &str, id: &str, args: &Value) -> Result<Value> {
        let mut states = self.states.lock().unwrap();
        let state = states.get_mut(&(session.into(), id.into())).unwrap();
        if !state.view.is_object() {
            state.view = json!({"selection":[],"tool":"move","flags":{},"viewport":{}});
        }
        match args["action"].as_str().unwrap() {
            "get" => {}
            "set" => {
                for key in ["viewport", "flags"] {
                    if let Some(v) = args.get(key) {
                        state.view[key] = v.clone();
                    }
                }
            }
            "select" => state.view["selection"] = args["ids"].clone(),
            "tool" => state.view["tool"] = args["tool"].clone(),
            "fit" => {
                return Err(EngineError::new(
                    "unsupported_feature",
                    "fit requires the native desktop viewport",
                ));
            }
            _ => return Err(EngineError::invalid("unknown view action")),
        }
        Ok(json!({"ok":true,"view":state.view}))
    }
}
fn rusqlite_params(id: &str, starred: bool) -> (&str, bool) {
    (id, starred)
}
pub(crate) fn string<'a>(args: &'a Value, key: &str) -> Result<&'a str> {
    args[key]
        .as_str()
        .ok_or_else(|| EngineError::invalid(format!("{key} required")))
}
pub(crate) fn properties(value: &Value) -> Result<Properties> {
    serde_json::from_value(value.clone()).map_err(|e| EngineError::invalid(e.to_string()))
}
pub(crate) fn native_id(id: &str) -> Result<String> {
    if omc_model::valid_id(id, "doc") {
        return Ok(id.into());
    }
    uuid::Uuid::parse_str(id)
        .map(|u| format!("doc_{}", u.simple()))
        .map_err(|_| EngineError::invalid("invalid document ID"))
}
pub(crate) fn external_id(id: &str) -> String {
    id.strip_prefix("doc_")
        .and_then(|s| uuid::Uuid::parse_str(s).ok())
        .map(|u| u.to_string())
        .unwrap_or_else(|| id.into())
}
pub(crate) fn children<'a>(snapshot: &'a DocumentSnapshot, parent: &str) -> Vec<&'a Node> {
    let mut nodes: Vec<_> = snapshot
        .nodes
        .values()
        .filter(|n| n.parent_id.as_deref() == Some(parent))
        .collect();
    nodes.sort_by(|a, b| (&a.rank, &a.id).cmp(&(&b.rank, &b.id)));
    nodes
}
fn copy_content(snapshot: &DocumentSnapshot) -> DocumentContent {
    let ids: BTreeMap<_, _> = snapshot
        .nodes
        .keys()
        .map(|id| (id.clone(), omc_model::new_id("node")))
        .collect();
    let mut nodes = BTreeMap::new();
    for node in snapshot.nodes.values() {
        let mut copy = node.clone();
        copy.id = ids[&node.id].clone();
        copy.parent_id = node.parent_id.as_ref().and_then(|id| ids.get(id).cloned());
        copy.home_shard = omc_model::new_id("shard");
        remap_values(&mut copy.properties, &ids);
        nodes.insert(copy.id.clone(), copy);
    }
    let pages = snapshot
        .pages
        .iter()
        .map(|p| {
            let mut p = p.clone();
            p.id = omc_model::new_id("page");
            p.root_node_id = ids[&p.root_node_id].clone();
            p
        })
        .collect();
    DocumentContent {
        title: snapshot.title.clone(),
        pages,
        nodes,
        metadata: snapshot.metadata.clone(),
    }
}
fn remap_values(props: &mut Properties, ids: &BTreeMap<String, String>) {
    fn visit(v: &mut Value, ids: &BTreeMap<String, String>) {
        match v {
            Value::String(s) => {
                if let Some(new) = ids.get(s) {
                    *s = new.clone()
                }
            }
            Value::Array(a) => {
                for v in a {
                    visit(v, ids)
                }
            }
            Value::Object(o) => {
                for v in o.values_mut() {
                    visit(v, ids)
                }
            }
            _ => {}
        }
    }
    for value in props.values_mut() {
        visit(value, ids)
    }
}
