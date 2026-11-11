use super::*;
use omc_model::{NodeKind, Page, new_id, rank_between};
use std::collections::BTreeSet;

struct Draft {
    snapshot: DocumentSnapshot,
    commands: Vec<Command>,
    created: Vec<String>,
    affected: BTreeSet<String>,
}
impl Draft {
    fn apply(&mut self, command: Command) -> Result<()> {
        match &command {
            Command::NodeCreate { node } => {
                self.snapshot.nodes.insert(node.id.clone(), node.clone());
                self.created.push(node.id.clone());
                self.affected.insert(node.id.clone());
            }
            Command::NodeSet {
                node_id,
                properties,
            } => {
                let node = self
                    .snapshot
                    .nodes
                    .get_mut(node_id)
                    .ok_or_else(|| EngineError::invalid("layer not found"))?;
                node.properties.extend(properties.clone());
                self.affected.insert(node_id.clone());
            }
            Command::NodeUnset {
                node_id,
                properties,
            } => {
                let node = self
                    .snapshot
                    .nodes
                    .get_mut(node_id)
                    .ok_or_else(|| EngineError::invalid("layer not found"))?;
                for key in properties {
                    node.properties.remove(key);
                }
            }
            Command::NodeMove {
                node_id,
                parent_id,
                rank,
            } => {
                let node = self
                    .snapshot
                    .nodes
                    .get_mut(node_id)
                    .ok_or_else(|| EngineError::invalid("layer not found"))?;
                node.parent_id = parent_id.clone();
                node.rank = rank.clone();
                self.affected.insert(node_id.clone());
            }
            Command::NodeDelete { node_ids } => {
                let mut all: BTreeSet<_> = node_ids.iter().cloned().collect();
                loop {
                    let next: Vec<_> = self
                        .snapshot
                        .nodes
                        .values()
                        .filter(|n| {
                            n.parent_id.as_ref().is_some_and(|p| all.contains(p))
                                && !all.contains(&n.id)
                        })
                        .map(|n| n.id.clone())
                        .collect();
                    if next.is_empty() {
                        break;
                    }
                    all.extend(next);
                }
                for id in all {
                    self.snapshot.nodes.remove(&id);
                    self.affected.insert(id);
                }
            }
            Command::PageCreate { page, root } => {
                self.snapshot.pages.push(page.clone());
                self.snapshot.nodes.insert(root.id.clone(), root.clone());
                self.created.push(root.id.clone());
            }
            Command::PageRename { page_id, title } => {
                let page = self
                    .snapshot
                    .pages
                    .iter_mut()
                    .find(|p| p.id == *page_id)
                    .ok_or_else(|| EngineError::invalid("page not found"))?;
                page.title = title.clone();
            }
            Command::TextInsert {
                node_id,
                offset,
                text,
                attributes,
            } => {
                let node = self
                    .snapshot
                    .nodes
                    .get_mut(node_id)
                    .ok_or_else(|| EngineError::invalid("text layer not found"))?;
                splice_runs(node, *offset, *offset, text, attributes)?;
                self.affected.insert(node_id.clone());
            }
            Command::TextDelete {
                node_id,
                start,
                end,
            } => {
                let node = self
                    .snapshot
                    .nodes
                    .get_mut(node_id)
                    .ok_or_else(|| EngineError::invalid("text layer not found"))?;
                splice_runs(node, *start, *end, "", &Properties::new())?;
                self.affected.insert(node_id.clone());
            }
            Command::TextReplace { node_id, text } => {
                let node = self
                    .snapshot
                    .nodes
                    .get_mut(node_id)
                    .ok_or_else(|| EngineError::invalid("text layer not found"))?;
                let end = node.string("text").unwrap_or("").encode_utf16().count() as u32;
                splice_runs(node, 0, end, text, &Properties::new())?;
                self.affected.insert(node_id.clone());
            }
            Command::TextMark {
                node_id,
                start,
                end,
                attributes,
            } => {
                let node = self
                    .snapshot
                    .nodes
                    .get_mut(node_id)
                    .ok_or_else(|| EngineError::invalid("text layer not found"))?;
                mark_runs(node, *start, *end, attributes)?;
                self.affected.insert(node_id.clone());
            }
            Command::DocumentMetadata { properties } => {
                self.snapshot.metadata.extend(properties.clone())
            }
            _ => {}
        }
        self.commands.push(command);
        Ok(())
    }
    fn node(&self, id: &str) -> Result<&Node> {
        self.snapshot
            .nodes
            .get(id)
            .ok_or_else(|| EngineError::invalid("layer not found"))
    }
    fn last_rank(&self, parent: &str) -> Result<String> {
        let last = children(&self.snapshot, parent)
            .last()
            .map(|n| n.rank.clone());
        rank_between(last.as_deref(), None).ok_or_else(|| {
            EngineError::new("resource_limit", "sibling ordering requires rank rebalance")
        })
    }
}
impl ToolRouter {
    pub(crate) fn mutate(
        &self,
        session: &str,
        id: &str,
        name: &str,
        args: &Value,
        meta: &Value,
    ) -> Result<Value> {
        if let Some(result) = self.replay(session, id, meta)? {
            return Ok(result);
        }
        if name == "undo" || name == "redo" {
            return self.submit(
                session,
                id,
                if name == "undo" {
                    Command::Undo
                } else {
                    Command::Redo
                },
                meta,
                None,
            );
        }
        let snapshot = if matches!(name, "update" | "edit_text")
            || name == "edit_shapes"
                && matches!(
                    args["action"].as_str(),
                    Some("patch" | "translate" | "resize" | "rotate" | "flip")
                ) {
            let context = self.workspace.context(id)?;
            let ids = if let Some(ids) = args["ids"].as_array() {
                ids.iter()
                    .map(|raw| self.resolve(session, id, raw.as_str().unwrap_or("")))
                    .collect::<Result<Vec<_>>>()?
            } else {
                vec![self.resolve(session, id, string(args, "id")?)?]
            };
            let mut nodes = BTreeMap::new();
            for node in self.workspace.nodes(id, &ids)?.into_iter().flatten() {
                nodes.insert(node.id.clone(), node);
            }
            DocumentSnapshot {
                id: id.into(),
                title: context.title,
                epoch: context.revision.epoch,
                sequence: context.revision.sequence,
                pages: context.pages,
                nodes,
                metadata: context.metadata,
            }
        } else {
            self.workspace.snapshot(id)?
        };
        let sequence = snapshot.sequence;
        if let Some(expected) = args["revision"].as_u64() {
            if expected != sequence {
                return Err(EngineError::new(
                    "stale_revision",
                    "text request revision changed",
                ));
            }
        }
        let mut draft = Draft {
            snapshot,
            commands: Vec::new(),
            created: Vec::new(),
            affected: BTreeSet::new(),
        };
        self.build_mutation(session, id, name, args, &mut draft)?;
        if draft.commands.is_empty() {
            return Ok(json!({"ok":true,"revision":sequence,"changed":false}));
        }
        if draft.commands.len() > 100 {
            return Err(EngineError::new(
                "resource_limit",
                "operation needs a staged job; ordinary batch has at most 100 commands",
            ));
        }
        let revision = Some(sequence); // Captured adapter reads are rechecked atomically in the authority.
        let command = if draft.commands.len() == 1 {
            draft.commands.remove(0)
        } else {
            Command::Batch {
                commands: draft.commands,
            }
        };
        let mut result = self.submit(session, id, command, meta, revision)?;

        result["changedIds"] = json!(draft.affected);
        if name == "page" && args["action"] == "create" {
            if let Some(page) = draft.snapshot.pages.last() {
                let mut states = self.states.lock().unwrap();
                let state = states.get_mut(&(session.into(), id.into())).unwrap();
                state.page_id = page.id.clone();
                state.root = page.root_node_id.clone();
                state.aliases.clear();
            }
        }
        Ok(result)
    }
    fn build_mutation(
        &self,
        session: &str,
        id: &str,
        name: &str,
        args: &Value,
        draft: &mut Draft,
    ) -> Result<()> {
        let resolve = |key: &str| self.resolve(session, id, string(args, key)?);
        let selected = || -> Result<Vec<String>> {
            args["ids"]
                .as_array()
                .ok_or_else(|| EngineError::invalid("ids required"))?
                .iter()
                .map(|idv| {
                    self.resolve(
                        session,
                        id,
                        idv.as_str()
                            .ok_or_else(|| EngineError::invalid("invalid layer id"))?,
                    )
                })
                .collect()
        };
        match name {
            "batch" => {
                for op in args["ops"].as_array().unwrap() {
                    let name = string(op, "tool")?;
                    let mut checked = op["args"].clone();
                    checked["documentId"] = external_id(id).into();
                    schema::validate(name, &checked)?;
                    if matches!(
                        name,
                        "batch" | "undo" | "redo" | "document_assets" | "export_selection"
                    ) {
                        return Err(EngineError::invalid(
                            "operation cannot be nested in an atomic batch",
                        ));
                    }
                    self.build_mutation(session, id, name, &checked, draft)?;
                }
                Ok(())
            }
            "create_shape" | "create_board" => {
                let kind = if name == "create_board" {
                    NodeKind::Frame
                } else {
                    match string(args, "type")? {
                        "frame" => NodeKind::Frame,
                        "group" => NodeKind::Group,
                        "rect" => NodeKind::Rect,
                        "ellipse" => NodeKind::Ellipse,
                        "line" | "arrow" => NodeKind::Line,
                        "text" => NodeKind::Text,
                        "image" => NodeKind::Image,
                        "path" | "pen" | "pencil" | "polygon" | "star" => NodeKind::Path,
                        "svg" => {
                            return Err(EngineError::invalid(
                                "use write_svg to supply editable SVG data",
                            ));
                        }
                        _ => return Err(EngineError::invalid("unsupported shape kind")),
                    }
                };
                let parent = args["parentId"]
                    .as_str()
                    .map(|p| self.resolve(session, id, p))
                    .transpose()?
                    .unwrap_or(self.state(session, id)?.root);
                let parent_node = draft.node(&parent)?;
                let mut node = Node::new(kind);
                node.parent_id = Some(parent.clone());
                node.home_shard = parent_node.home_shard.clone();
                node.rank = draft.last_rank(&parent)?;
                node.properties = if args["properties"].is_object() {
                    properties(&args["properties"])?
                } else {
                    Properties::new()
                };
                for (key, default) in [("x", 0.), ("y", 0.), ("width", 100.), ("height", 100.)] {
                    node.properties.insert(
                        key.into(),
                        args.get(key)
                            .or_else(|| node.properties.get(key))
                            .cloned()
                            .unwrap_or(json!(default)),
                    );
                }
                if let Some(name) = args.get("name") {
                    node.properties.insert("name".into(), name.clone());
                }
                if name == "create_board" {
                    let right = children(&draft.snapshot, &parent)
                        .iter()
                        .map(|n| n.number("x", 0.) + n.number("width", 0.))
                        .fold(-48., f64::max)
                        + 48.;
                    node.properties.insert("x".into(), json!(right));
                    node.properties.insert(
                        "style".into(),
                        json!({"display":"flex","flex-direction":"column"}),
                    );
                    node.properties
                        .entry("fill".into())
                        .or_insert(json!("#ffffff"));
                }
                if node.kind == NodeKind::Path
                    && matches!(args["type"].as_str(), Some("polygon" | "star"))
                {
                    node.properties.insert(
                        "path".into(),
                        json!(polygon_path(
                            node.number("width", 100.),
                            node.number("height", 100.),
                            if args["type"] == "star" { 5 } else { 3 },
                            args["type"] == "star"
                        )),
                    );
                }
                normalize_paints(&mut node.properties);
                draft.apply(Command::NodeCreate { node })
            }
            "update" => {
                let raw = resolve("id")?;
                let current = draft.node(&raw)?.clone();
                let mut patch = Properties::new();
                if let Some(style) = args["style"].as_object() {
                    let mut old = current
                        .properties
                        .get("style")
                        .and_then(Value::as_object)
                        .cloned()
                        .unwrap_or_default();
                    for (k, v) in style {
                        if v == "" {
                            old.remove(k);
                        } else {
                            old.insert(k.clone(), v.clone());
                        }
                    }
                    patch.insert("style".into(), Value::Object(old));
                }
                if let Some(attrs) = args["attrs"].as_object() {
                    for (k, v) in attrs {
                        if matches!(k.as_str(), "id" | "parentId" | "homeShard") {
                            return Err(EngineError::invalid(
                                "structural fields require native commands",
                            ));
                        }
                        patch.insert(k.clone(), v.clone());
                    }
                }
                if !patch.is_empty() {
                    draft.apply(Command::NodeSet {
                        node_id: raw.clone(),
                        properties: patch,
                    })?;
                }
                if let Some(text) = args["text"].as_str() {
                    draft.apply(Command::TextReplace {
                        node_id: raw,
                        text: text.into(),
                    })?;
                }
                Ok(())
            }
            "delete" => {
                let ids = selected()?;
                draft.apply(Command::NodeDelete { node_ids: ids })
            }
            "move" => {
                let raw = resolve("id")?;
                let target = resolve("target")?;
                let (parent, rank) = placement(draft, &target, string(args, "position")?)?;
                draft.apply(Command::NodeMove {
                    node_id: raw,
                    parent_id: Some(parent),
                    rank,
                })
            }
            "duplicate" => {
                let raw = resolve("id")?;
                let target = args["target"]
                    .as_str()
                    .map(|t| self.resolve(session, id, t))
                    .transpose()?
                    .unwrap_or(raw.clone());
                let (parent, rank) =
                    placement(draft, &target, args["position"].as_str().unwrap_or("after"))?;
                duplicate_subtree(draft, &raw, &parent, &rank)
            }
            "page" => match args["action"].as_str().unwrap() {
                "create" => {
                    let root = Node::new(NodeKind::Frame);
                    let mut page = Page::new(args["name"].as_str().unwrap_or("New page"), &root.id);
                    let last = draft.snapshot.pages.last().map(|p| p.rank.as_str());
                    page.rank = rank_between(last, None)
                        .ok_or_else(|| EngineError::new("resource_limit", "page rank exhausted"))?;
                    draft.apply(Command::PageCreate { page, root })
                }
                "rename" => draft.apply(Command::PageRename {
                    page_id: string(args, "pageId")?.into(),
                    title: string(args, "name")?.into(),
                }),
                "delete" => draft.apply(Command::PageDelete {
                    page_id: string(args, "pageId")?.into(),
                }),
                _ => Err(EngineError::new(
                    "unsupported_feature",
                    "native page action is not yet qualified",
                )),
            },
            "edit_text" => {
                let raw = resolve("id")?;
                let node = draft.node(&raw)?.clone();
                if node.kind != NodeKind::Text {
                    return Err(EngineError::invalid("target is not text"));
                }
                match args["action"].as_str().unwrap() {
                    "replace" => {
                        let text = string(args, "text")?;
                        if let Some(range) = args.get("range") {
                            let start = range["start"].as_u64().unwrap_or(0) as u32;
                            let end = range["end"].as_u64().unwrap_or(0) as u32;
                            draft.apply(Command::TextDelete {
                                node_id: raw.clone(),
                                start,
                                end,
                            })?;
                            draft.apply(Command::TextInsert {
                                node_id: raw,
                                offset: start,
                                text: text.into(),
                                attributes: Properties::new(),
                            })
                        } else {
                            draft.apply(Command::TextReplace {
                                node_id: raw,
                                text: text.into(),
                            })
                        }
                    }
                    "range_style" => draft.apply(Command::TextMark {
                        node_id: raw,
                        start: args["range"]["start"].as_u64().unwrap_or(0) as u32,
                        end: args["range"]["end"].as_u64().unwrap_or(0) as u32,
                        attributes: properties(&args["style"])?,
                    }),
                    "paragraph_style" => draft.apply(Command::NodeSet {
                        node_id: raw,
                        properties: properties(&args["style"])?,
                    }),
                    "find_replace" => {
                        let text = node.string("text").unwrap_or("");
                        let find = string(args, "find")?;
                        if find.is_empty() {
                            return Err(EngineError::invalid("find cannot be empty"));
                        }
                        let replacement = string(args, "replace")?;
                        let pattern = if args["wholeWord"] == true {
                            format!("\\b{}\\b", regex::escape(find))
                        } else {
                            regex::escape(find)
                        };
                        let regex = regex::RegexBuilder::new(&pattern)
                            .case_insensitive(args["caseSensitive"] == false)
                            .build()
                            .map_err(|e| EngineError::invalid(e.to_string()))?;
                        let limit = if args["all"].as_bool().unwrap_or(true) {
                            51
                        } else {
                            1
                        };
                        let matches: Vec<_> = regex.find_iter(text).take(limit).collect();
                        if matches.len() > 50 {
                            return Err(EngineError::new(
                                "resource_limit",
                                "find/replace exceeds ordinary transaction limit",
                            ));
                        }
                        for found in matches.into_iter().rev() {
                            let start = text[..found.start()].encode_utf16().count() as u32;
                            let end = text[..found.end()].encode_utf16().count() as u32;
                            let attributes = attributes_at(&node, start)?;
                            draft.apply(Command::TextDelete {
                                node_id: raw.clone(),
                                start,
                                end,
                            })?;
                            draft.apply(Command::TextInsert {
                                node_id: raw.clone(),
                                offset: start,
                                text: replacement.into(),
                                attributes,
                            })?;
                        }
                        Ok(())
                    }
                    _ => Err(EngineError::invalid("unknown text action")),
                }
            }
            "edit_shapes" => self.edit_shapes(session, id, args, draft),
            "component" => self.component_mutation(session, id, args, draft),
            "write_html" | "write_svg" => self.insert_markup(session, id, name, args, draft),
            "edit_path" | "boolean" | "outline" | "image" => Err(EngineError::new(
                "unsupported_feature",
                "this native geometry/image operation has not passed its capability gate",
            )),
            _ => Err(EngineError::new(
                "unsupported_feature",
                format!("native adapter for {name} is not implemented"),
            )),
        }
    }
    fn edit_shapes(&self, session: &str, id: &str, args: &Value, draft: &mut Draft) -> Result<()> {
        let ids: Vec<_> = args["ids"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| self.resolve(session, id, v.as_str().unwrap()))
            .collect::<Result<_>>()?;
        let nodes: Vec<_> = ids
            .iter()
            .map(|id| draft.node(id).cloned())
            .collect::<Result<_>>()?;
        let action = string(args, "action")?;
        if matches!(action, "group" | "frame") {
            let parent = nodes
                .first()
                .and_then(|n| n.parent_id.clone())
                .ok_or_else(|| EngineError::invalid("cannot group page roots"))?;
            if nodes
                .iter()
                .any(|n| n.parent_id.as_deref() != Some(&parent))
            {
                return Err(EngineError::invalid("grouped layers must share a parent"));
            }
            let mut group = Node::new(if action == "frame" {
                NodeKind::Frame
            } else {
                NodeKind::Group
            });
            group.parent_id = Some(parent);
            group.home_shard = nodes[0].home_shard.clone();
            group.rank = nodes[0].rank.clone();
            group.properties.insert(
                "name".into(),
                json!(args["name"].as_str().unwrap_or("Group")),
            );
            let group_id = group.id.clone();
            draft.apply(Command::NodeCreate { node: group })?;
            for node in nodes {
                draft.apply(Command::NodeMove {
                    node_id: node.id,
                    parent_id: Some(group_id.clone()),
                    rank: node.rank,
                })?;
            }
            return Ok(());
        }
        if action == "ungroup" {
            for group in nodes {
                let parent = group
                    .parent_id
                    .clone()
                    .ok_or_else(|| EngineError::invalid("cannot ungroup page root"))?;
                let children = children(&draft.snapshot, &group.id)
                    .into_iter()
                    .cloned()
                    .collect::<Vec<_>>();
                for child in children {
                    draft.apply(Command::NodeMove {
                        node_id: child.id,
                        parent_id: Some(parent.clone()),
                        rank: child.rank,
                    })?;
                }
                draft.apply(Command::NodeDelete {
                    node_ids: vec![group.id],
                })?;
            }
            return Ok(());
        }
        let left = nodes
            .iter()
            .map(|n| n.number("x", 0.))
            .fold(f64::INFINITY, f64::min);
        let top = nodes
            .iter()
            .map(|n| n.number("y", 0.))
            .fold(f64::INFINITY, f64::min);
        let right = nodes
            .iter()
            .map(|n| n.number("x", 0.) + n.number("width", 0.))
            .fold(f64::NEG_INFINITY, f64::max);
        let bottom = nodes
            .iter()
            .map(|n| n.number("y", 0.) + n.number("height", 0.))
            .fold(f64::NEG_INFINITY, f64::max);
        for node in nodes {
            let mut patch = Properties::new();
            match action {
                "patch" => {
                    patch = properties(&args["properties"])?;
                    normalize_paints(&mut patch);
                    if let Some(text) = patch.remove("text") {
                        draft.apply(Command::TextReplace {
                            node_id: node.id.clone(),
                            text: text.as_str().unwrap_or("").into(),
                        })?;
                    }
                    let unset = patch
                        .iter()
                        .filter(|(_, value)| value.is_null())
                        .map(|(key, _)| key.clone())
                        .collect::<Vec<_>>();
                    if !unset.is_empty() {
                        draft.apply(Command::NodeUnset {
                            node_id: node.id.clone(),
                            properties: unset,
                        })?;
                    }
                    patch.retain(|_, value| !value.is_null());
                }
                "translate" => {
                    patch.insert(
                        "x".into(),
                        json!(node.number("x", 0.) + args["dx"].as_f64().unwrap()),
                    );
                    patch.insert(
                        "y".into(),
                        json!(node.number("y", 0.) + args["dy"].as_f64().unwrap()),
                    );
                }
                "resize" => {
                    patch.insert("width".into(), args["width"].clone());
                    patch.insert("height".into(), args["height"].clone());
                }
                "rotate" => {
                    patch.insert(
                        "rotation".into(),
                        json!(node.number("rotation", 0.) + args["angle"].as_f64().unwrap()),
                    );
                }
                "flip" => {
                    let key = if args["axis"] == "h" {
                        "flipX"
                    } else {
                        "flipY"
                    };
                    patch.insert(
                        key.into(),
                        json!(
                            !node
                                .properties
                                .get(key)
                                .and_then(Value::as_bool)
                                .unwrap_or(false)
                        ),
                    );
                }
                "align" => {
                    let (key, value) = match string(args, "alignment")? {
                        "left" => ("x", left),
                        "right" => ("x", right - node.number("width", 0.)),
                        "top" => ("y", top),
                        "bottom" => ("y", bottom - node.number("height", 0.)),
                        "h-center" => ("x", (left + right - node.number("width", 0.)) / 2.),
                        "v-center" => ("y", (top + bottom - node.number("height", 0.)) / 2.),
                        _ => return Err(EngineError::invalid("alignment")),
                    };
                    patch.insert(key.into(), json!(value));
                }
                "layout" => {
                    patch.insert("layout".into(), args["layout"].clone());
                }
                "order" => {
                    let parent = node
                        .parent_id
                        .as_deref()
                        .ok_or_else(|| EngineError::invalid("cannot reorder root"))?;
                    let siblings = children(&draft.snapshot, parent);
                    let rank = match args["mode"].as_str() {
                        Some("front") => {
                            rank_between(siblings.last().map(|n| n.rank.as_str()), None)
                        }
                        Some("back") => {
                            rank_between(None, siblings.first().map(|n| n.rank.as_str()))
                        }
                        _ => {
                            return Err(EngineError::new(
                                "unsupported_feature",
                                "single-step ordering not implemented",
                            ));
                        }
                    }
                    .ok_or_else(|| EngineError::new("resource_limit", "rank rebalance required"))?;
                    draft.apply(Command::NodeMove {
                        node_id: node.id,
                        parent_id: Some(parent.into()),
                        rank,
                    })?;
                    continue;
                }
                _ => {
                    return Err(EngineError::new(
                        "unsupported_feature",
                        format!("native arrangement {action} is not implemented"),
                    ));
                }
            }
            draft.apply(Command::NodeSet {
                node_id: node.id,
                properties: patch,
            })?;
        }
        Ok(())
    }
    fn component_mutation(
        &self,
        session: &str,
        id: &str,
        args: &Value,
        draft: &mut Draft,
    ) -> Result<()> {
        match args["action"].as_str().unwrap() {
            "create" => {
                let raw = self.resolve(
                    session,
                    id,
                    args["id"]
                        .as_str()
                        .or_else(|| args["ids"].get(0).and_then(Value::as_str))
                        .ok_or_else(|| EngineError::invalid("component source required"))?,
                )?;
                let mut source = draft.node(&raw)?.clone();
                let parent = source
                    .parent_id
                    .clone()
                    .ok_or_else(|| EngineError::invalid("cannot make page root component"))?;
                let rank = draft.last_rank(&parent)?;
                duplicate_subtree(draft, &raw, &parent, &rank)?;
                let root = draft
                    .created
                    .iter()
                    .rev()
                    .find(|candidate| {
                        draft.snapshot.nodes[*candidate].parent_id.as_deref() == Some(&parent)
                    })
                    .cloned()
                    .unwrap();
                source = draft.snapshot.nodes[&root].clone();
                source.kind = NodeKind::Component;
                draft.snapshot.nodes.get_mut(&root).unwrap().kind = NodeKind::Component;
                for command in &mut draft.commands {
                    if let Command::NodeCreate { node } = command {
                        if node.id == root {
                            node.kind = NodeKind::Component;
                        }
                    }
                }
                source
                    .properties
                    .insert("componentDefinition".into(), json!(true));
                source.properties.insert(
                    "name".into(),
                    args.get("name").cloned().unwrap_or(json!("Component")),
                );
                draft.apply(Command::NodeSet {
                    node_id: root,
                    properties: source.properties,
                })
            }
            "instance" => {
                let source = self.resolve(session, id, string(args, "source")?)?;
                let parent = args["parent"]
                    .as_str()
                    .map(|p| self.resolve(session, id, p))
                    .transpose()?
                    .unwrap_or(self.state(session, id)?.root);
                let mut node = Node::new(NodeKind::Instance);
                node.home_shard = draft.node(&parent)?.home_shard.clone();
                node.parent_id = Some(parent.clone());
                node.rank = draft.last_rank(&parent)?;
                node.properties.insert("componentId".into(), json!(source));
                for key in ["x", "y"] {
                    node.properties
                        .insert(key.into(), args.get(key).cloned().unwrap_or(json!(0)));
                }
                draft.apply(Command::NodeCreate { node })
            }
            "reset" => {
                let raw = self.resolve(session, id, string(args, "id")?)?;
                draft.apply(Command::NodeUnset {
                    node_id: raw,
                    properties: vec!["overrides".into()],
                })
            }
            "detach" => {
                let raw = self.resolve(session, id, string(args, "id")?)?;
                let projection = omc_scene::resolve_components(&draft.snapshot, Some(&raw));
                if projection.diagnostics.iter().any(|d| d.fidelity_lost) {
                    return Err(EngineError::new(
                        "dependency_unavailable",
                        "component cannot be resolved",
                    ));
                }
                let resolved = projection.snapshot.into_owned();
                let node = resolved
                    .nodes
                    .get(&raw)
                    .ok_or_else(|| EngineError::invalid("instance not found"))?;
                let mut patch = node.properties.clone();
                for key in ["componentId", "overrides", "sourceComponentId", "libraryId"] {
                    patch.remove(key);
                }
                draft.apply(Command::NodeSet {
                    node_id: raw.clone(),
                    properties: patch,
                })?;
                draft.apply(Command::NodeUnset {
                    node_id: raw.clone(),
                    properties: vec![
                        "componentId".into(),
                        "overrides".into(),
                        "sourceComponentId".into(),
                        "libraryId".into(),
                    ],
                })?;
                let mut pending = children(&resolved, &raw)
                    .iter()
                    .map(|n| n.id.clone())
                    .collect::<Vec<_>>();
                while let Some(id) = pending.pop() {
                    let mut child = resolved.nodes[&id].clone();
                    pending.extend(children(&resolved, &id).iter().map(|n| n.id.clone()));
                    if !draft.snapshot.nodes.contains_key(&id) {
                        for key in ["sourceNodeId", "instanceId", "libraryId"] {
                            child.properties.remove(key);
                        }
                        draft.apply(Command::NodeCreate { node: child })?;
                    }
                }
                Ok(())
            }
            _ => Err(EngineError::new(
                "unsupported_feature",
                "native component variants/typed properties are not yet qualified",
            )),
        }
    }
    fn insert_markup(
        &self,
        session: &str,
        id: &str,
        name: &str,
        args: &Value,
        draft: &mut Draft,
    ) -> Result<()> {
        let target = self.resolve(session, id, string(args, "target")?)?;
        let position = string(args, "position")?;
        let imported = if name == "write_html" {
            omc_import::import_html(string(args, "html")?, &omc_import::ImportOptions::default())
        } else {
            omc_import::import_svg(string(args, "svg")?, &omc_import::ImportOptions::default())
        }
        .map_err(|e| EngineError::invalid(e.to_string()))?;
        let (parent, mut rank) = placement(
            draft,
            &target,
            if position == "replace" {
                "before"
            } else {
                position
            },
        )?;
        for asset in &imported.resources {
            self.resources()?
                .0
                .ingest(&asset.bytes, &asset.media_type)?;
        }
        let root = imported.content.pages[0].root_node_id.clone();
        let mut nodes = imported.content.nodes;
        let top: Vec<_> = nodes
            .values()
            .filter(|n| n.parent_id.as_deref() == Some(&root))
            .map(|n| n.id.clone())
            .collect();
        for root in top {
            let mut pending = vec![(root, Some(parent.clone()), Some(rank.clone()))];
            while let Some((raw, parent_override, rank_override)) = pending.pop() {
                let mut node = nodes.remove(&raw).unwrap();
                let children: Vec<_> = nodes
                    .values()
                    .filter(|n| n.parent_id.as_deref() == Some(&raw))
                    .map(|n| n.id.clone())
                    .collect();
                if let Some(parent) = parent_override {
                    node.parent_id = Some(parent);
                }
                if let Some(rank) = rank_override {
                    node.rank = rank;
                }
                draft.apply(Command::NodeCreate { node })?;
                for child in children.into_iter().rev() {
                    pending.push((child, None, None));
                }
            }
            rank = rank_between(Some(&rank), None)
                .ok_or_else(|| EngineError::new("resource_limit", "rank rebalance needed"))?;
        }
        if position == "replace" {
            draft.apply(Command::NodeDelete {
                node_ids: vec![target],
            })?;
        }
        Ok(())
    }
}
fn placement(draft: &Draft, target: &str, position: &str) -> Result<(String, String)> {
    let node = draft.node(target)?;
    let (parent, left, right) = match position {
        "first" => (
            target.to_owned(),
            None,
            children(&draft.snapshot, target)
                .first()
                .map(|n| n.rank.clone()),
        ),
        "last" => (
            target.to_owned(),
            children(&draft.snapshot, target)
                .last()
                .map(|n| n.rank.clone()),
            None,
        ),
        "before" | "after" => {
            let parent = node
                .parent_id
                .clone()
                .ok_or_else(|| EngineError::invalid("cannot place beside page root"))?;
            let siblings = children(&draft.snapshot, &parent);
            let i = siblings.iter().position(|n| n.id == target).unwrap();
            let (l, r) = if position == "before" {
                (
                    i.checked_sub(1).map(|i| siblings[i].rank.clone()),
                    Some(node.rank.clone()),
                )
            } else {
                (
                    Some(node.rank.clone()),
                    siblings.get(i + 1).map(|n| n.rank.clone()),
                )
            };
            (parent, l, r)
        }
        _ => return Err(EngineError::invalid("invalid insertion position")),
    };
    Ok((
        parent,
        rank_between(left.as_deref(), right.as_deref())
            .ok_or_else(|| EngineError::new("resource_limit", "rank rebalance required"))?,
    ))
}
fn duplicate_subtree(draft: &mut Draft, source: &str, parent: &str, rank: &str) -> Result<()> {
    let mut pending = vec![source.to_owned()];
    let mut order = Vec::new();
    while let Some(id) = pending.pop() {
        for n in children(&draft.snapshot, &id).into_iter().rev() {
            pending.push(n.id.clone());
        }
        order.push(id);
    }
    let ids: BTreeMap<_, _> = order
        .iter()
        .map(|id| (id.clone(), new_id("node")))
        .collect();
    for raw in order {
        let mut node = draft.node(&raw)?.clone();
        node.id = ids[&raw].clone();
        node.home_shard = new_id("shard");
        node.parent_id = if raw == source {
            Some(parent.into())
        } else {
            node.parent_id.as_ref().and_then(|p| ids.get(p)).cloned()
        };
        if raw == source {
            node.rank = rank.into();
        }
        remap_values(&mut node.properties, &ids);
        draft.apply(Command::NodeCreate { node })?;
    }
    Ok(())
}
fn normalize_paints(props: &mut Properties) {
    if let Some(color) = props
        .get("fills")
        .and_then(Value::as_array)
        .and_then(|v| v.first())
        .and_then(|v| v.get("color"))
        .cloned()
    {
        props.insert("fill".into(), color);
    }
    if let Some(color) = props
        .get("strokes")
        .and_then(Value::as_array)
        .and_then(|v| v.first())
        .and_then(|v| v.get("color"))
        .cloned()
    {
        props.insert("stroke".into(), color);
    }
}
fn polygon_path(width: f64, height: f64, count: usize, star: bool) -> String {
    let total = if star { count * 2 } else { count };
    let points: Vec<_> = (0..total)
        .map(|i| {
            let a = -std::f64::consts::FRAC_PI_2 + i as f64 * std::f64::consts::TAU / total as f64;
            let ratio = if star && i % 2 == 1 { 0.45 } else { 1. };
            format!(
                "{} {}",
                width / 2. + a.cos() * width / 2. * ratio,
                height / 2. + a.sin() * height / 2. * ratio
            )
        })
        .collect();
    format!("M {} Z", points.join(" L "))
}

fn runs(node: &Node) -> Result<Vec<(String, Properties)>> {
    if node.kind != NodeKind::Text {
        return Err(EngineError::invalid("target is not text"));
    }
    node.validate().map_err(EngineError::invalid)?;
    if let Some(runs) = node.properties.get("textRuns").and_then(Value::as_array) {
        runs.iter()
            .map(|run| {
                Ok((
                    run["text"].as_str().unwrap().into(),
                    properties(&run["attributes"])?,
                ))
            })
            .collect()
    } else {
        Ok(vec![(
            node.string("text").unwrap_or("").into(),
            Properties::new(),
        )])
    }
}
fn push_run(out: &mut Vec<(String, Properties)>, text: &str, attributes: &Properties) {
    if text.is_empty() {
        return;
    }
    if let Some((last, marks)) = out.last_mut() {
        if marks == attributes {
            last.push_str(text);
            return;
        }
    }
    out.push((text.into(), attributes.clone()));
}
fn write_runs(node: &mut Node, runs: Vec<(String, Properties)>) {
    let text: String = runs.iter().map(|(text, _)| text.as_str()).collect();
    node.properties.insert("text".into(), text.into());
    node.properties.insert(
        "textRuns".into(),
        json!(
            runs.into_iter()
                .map(|(text, attributes)| json!({"text":text,"attributes":attributes}))
                .collect::<Vec<_>>()
        ),
    );
}
fn attributes_at(node: &Node, index: u32) -> Result<Properties> {
    let byte = utf16_byte(node.string("text").unwrap_or(""), index)?;
    let mut offset = 0;
    for (text, attributes) in runs(node)? {
        offset += text.len();
        if byte < offset {
            return Ok(attributes);
        }
    }
    Ok(Properties::new())
}
fn splice_runs(
    node: &mut Node,
    start: u32,
    end: u32,
    replacement: &str,
    attributes: &Properties,
) -> Result<()> {
    let text = node.string("text").unwrap_or("");
    let start = utf16_byte(text, start)?;
    let end = utf16_byte(text, end)?;
    if start > end {
        return Err(EngineError::invalid("invalid range"));
    }
    let mut before = Vec::new();
    let mut after = Vec::new();
    let mut offset = 0;
    for (part, marks) in runs(node)? {
        if offset < start {
            push_run(
                &mut before,
                &part[..(start - offset).min(part.len())],
                &marks,
            );
        }
        if offset + part.len() > end {
            push_run(
                &mut after,
                &part[end.saturating_sub(offset).min(part.len())..],
                &marks,
            );
        }
        offset += part.len();
    }
    push_run(&mut before, replacement, attributes);
    for (part, marks) in after {
        push_run(&mut before, &part, &marks);
    }
    write_runs(node, before);
    Ok(())
}
fn mark_runs(node: &mut Node, start: u32, end: u32, attributes: &Properties) -> Result<()> {
    let text = node.string("text").unwrap_or("");
    let start = utf16_byte(text, start)?;
    let end = utf16_byte(text, end)?;
    if start > end {
        return Err(EngineError::invalid("invalid range"));
    }
    let mut out = Vec::new();
    let mut offset = 0;
    for (part, marks) in runs(node)? {
        let from = start.saturating_sub(offset).min(part.len());
        let to = end.saturating_sub(offset).min(part.len());
        push_run(&mut out, &part[..from], &marks);
        if from < to {
            let mut updated = marks.clone();
            for (key, value) in attributes {
                if value.is_null() {
                    updated.remove(key);
                } else {
                    updated.insert(key.clone(), value.clone());
                }
            }
            push_run(&mut out, &part[from..to], &updated);
        }
        push_run(&mut out, &part[to..], &marks);
        offset += part.len();
    }
    write_runs(node, out);
    Ok(())
}
fn utf16_byte(text: &str, index: u32) -> Result<usize> {
    let mut count = 0;
    for (byte, c) in text.char_indices() {
        if count == index {
            return Ok(byte);
        }
        count += c.len_utf16() as u32;
        if count > index {
            break;
        }
    }
    if count == index {
        Ok(text.len())
    } else {
        Err(EngineError::invalid("invalid UTF-16 boundary"))
    }
}
