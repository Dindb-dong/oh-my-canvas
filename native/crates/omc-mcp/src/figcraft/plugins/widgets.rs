use super::*;
use omc_plugin::widget::{MenuItem, MenuKind, WidgetAlign, WidgetKind, WidgetLayout, WidgetNode};

const PLUGIN: &str = "figWidgetPlugin";
const STATE: &str = "figWidgetState";
const TARGET: &str = "figWidgetTarget";
const FIELD: &str = "figWidgetField";
const MENU: &str = "figWidgetMenu";
const HOVER: &str = "figWidgetHover";

pub(in crate::figcraft) const COMMANDS: &[(&str, &str, bool, &str)] = &[
    ("widget.list", "List widgets", false, ""),
    (
        "widget.insert",
        "Insert widget",
        false,
        "plugin, x?, y?, fuel?",
    ),
    ("widget.click", "Click widget", false, "id, target, fuel?"),
    (
        "widget.setText",
        "Edit widget field",
        false,
        "id, field, value, fuel?",
    ),
    (
        "widget.menu",
        "Widget menu",
        false,
        "id, item, value?, fuel?",
    ),
    ("widget.hover", "Hover widget", false, "ids?"),
];

fn parent_widget<'a>(snapshot: &'a DocumentSnapshot, id: &str) -> Option<&'a Node> {
    let mut node = snapshot.nodes.get(id)?;
    while node.string(PLUGIN).is_none() {
        node = snapshot.nodes.get(node.parent_id.as_ref()?)?;
    }
    Some(node)
}

fn descendants<'a>(snapshot: &'a DocumentSnapshot, root: &'a Node) -> Vec<&'a Node> {
    let mut nodes = Vec::new();
    let mut pending = vec![root];
    while let Some(node) = pending.pop() {
        nodes.push(node);
        pending.extend(children(snapshot, &node.id).into_iter().rev());
    }
    nodes
}

fn fields(nodes: &[&Node], key: &str) -> Vec<String> {
    nodes
        .iter()
        .filter_map(|node| node.string(key))
        .map(str::to_owned)
        .collect()
}

fn state(node: Option<&Node>) -> Map<String, Value> {
    node.and_then(|node| node.properties.get(STATE))
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default()
}

fn menu(node: &Node) -> Vec<MenuItem> {
    node.properties
        .get(MENU)
        .and_then(|menu| serde_json::from_value(menu.clone()).ok())
        .unwrap_or_default()
}

fn summary(router: &ToolRouter, session: &str, snapshot: &DocumentSnapshot, root: &Node) -> Value {
    let nodes = descendants(snapshot, root);
    let page = snapshot.pages.iter().find(|page| {
        let mut parent = Some(root);
        while let Some(node) = parent {
            if node.id == page.root_node_id {
                return true;
            }
            parent = node
                .parent_id
                .as_ref()
                .and_then(|id| snapshot.nodes.get(id));
        }
        false
    });
    json!({"id":router.fig_alias(session,&snapshot.id,&root.id),"plugin":root.string(PLUGIN),
        "name":root.string("name"),"page":page.map(|page|router.fig_alias(session,&snapshot.id,&page.root_node_id)),
        "state":state(Some(root)),"targets":fields(&nodes,TARGET),"fields":fields(&nodes,FIELD),"menu":menu(root)})
}

impl ToolRouter {
    pub(in crate::figcraft) fn fig_widget_command(
        &self,
        session: &str,
        name: &str,
        args: &Value,
        params: &Value,
    ) -> Result<Value> {
        let id = json!({"type":"integer","minimum":1});
        let text = json!({"type":"string","minLength":1,"maxLength":128});
        let fuel = json!({"type":"integer","minimum":1});
        let fields = match name {
            "widget.insert" => {
                json!({"plugin":text,"x":{"type":"number"},"y":{"type":"number"},"fuel":fuel})
            }
            "widget.click" => json!({"id":id,"target":text,"fuel":fuel}),
            "widget.setText" => {
                json!({"id":id,"field":text,"value":{"type":"string","maxLength":1000},"fuel":fuel})
            }
            "widget.menu" => json!({"id":id,"item":text,"value":{},"fuel":fuel}),
            "widget.hover" => json!({"ids":{"type":"array","maxItems":200,"items":id}}),
            _ => json!({}),
        };
        schema::check(
            &json!({"type":"object","properties":fields,"additionalProperties":false}),
            params,
            "params",
        )?;
        let document = self.workspace.target(
            session,
            args["document"]
                .as_str()
                .map(native_id)
                .transpose()?
                .as_deref(),
        )?;
        let snapshot = self.workspace.snapshot(&document)?;
        let view = self.state(session, &document)?;
        if name == "widget.list" {
            return Ok(
                json!({"widgets":snapshot.nodes.values().filter(|node|node.string(PLUGIN).is_some())
                .map(|node|summary(self,session,&snapshot,node)).collect::<Vec<_>>() }),
            );
        }
        if name == "widget.hover" {
            self.take_fig_preview(session);
            let mut preview = snapshot;
            let ids = params["ids"].as_array().map(Vec::as_slice).unwrap_or(&[]);
            let mut hovering = Vec::new();
            for id in ids {
                let id = self.fig_layer(session, &preview, id)?;
                if parent_widget(&preview, &id).is_none() {
                    continue;
                }
                let node = preview
                    .nodes
                    .get_mut(&id)
                    .ok_or_else(|| EngineError::invalid("layer not found"))?;
                let Some(hover) = node
                    .properties
                    .get(HOVER)
                    .and_then(Value::as_object)
                    .cloned()
                else {
                    continue;
                };
                for (key, value) in hover {
                    node.properties
                        .insert(if key == "color" { "fill".into() } else { key }, value);
                }
                hovering.push(self.fig_alias(session, &document, &id));
            }
            if !hovering.is_empty() {
                self.set_fig_preview(session, preview)?;
            }
            return Ok(json!({"hovering":hovering}));
        }
        let existing = if name == "widget.insert" {
            None
        } else {
            let id = self.fig_layer(session, &snapshot, &params["id"])?;
            Some(
                parent_widget(&snapshot, &id)
                    .ok_or_else(|| EngineError::invalid("layer is outside a widget"))?,
            )
        };
        let mut current = state(existing);
        let event = if let Some(widget) = existing {
            let nodes = descendants(&snapshot, widget);
            match name {
                "widget.click" => {
                    let target = string(params, "target")?;
                    if !nodes.iter().any(|node| node.string(TARGET) == Some(target)) {
                        return Err(EngineError::invalid("unknown widget click target"));
                    }
                    json!({"target":target})
                }
                "widget.setText" => {
                    let field = string(params, "field")?;
                    if !nodes.iter().any(|node| node.string(FIELD) == Some(field)) {
                        return Err(EngineError::invalid("unknown widget text field"));
                    }
                    let value = omc_plugin::widget::clean_field(string(params, "value")?)
                        .map_err(plugin_error)?;
                    current.insert(field.into(), json!(value));
                    omc_plugin::widget::check_state(&current).map_err(plugin_error)?;
                    json!({"field":field,"value":value})
                }
                "widget.menu" => {
                    let item = string(params, "item")?;
                    let option = menu(widget)
                        .into_iter()
                        .find(|option| option.item == item)
                        .ok_or_else(|| EngineError::invalid("unknown widget menu item"))?;
                    let value = match option.kind {
                        MenuKind::Action => Value::Null,
                        MenuKind::Toggle => {
                            json!(params["value"].as_bool().unwrap_or(!option.checked))
                        }
                        MenuKind::Color => {
                            let color = string(params, "value")?.to_ascii_uppercase();
                            if !option.options.contains(&color) {
                                return Err(EngineError::invalid("unknown widget menu color"));
                            }
                            json!(color)
                        }
                    };
                    json!({"menu":item,"value":value})
                }
                _ => return Err(EngineError::invalid("unknown widget event")),
            }
        } else {
            Value::Null
        };
        let plugin_id = match existing {
            Some(widget) => widget.string(PLUGIN).unwrap(),
            None => string(params, "plugin")?,
        };
        let owner = self
            .fig_plugins
            .lock()
            .unwrap()
            .entry(session.to_owned())
            .or_default()
            .clone();
        let mut owner = owner.lock().unwrap();
        let plugin = owner
            .installed
            .get(plugin_id)
            .filter(|plugin| plugin.manifest.widget)
            .ok_or_else(|| {
                EngineError::invalid("widget plugin is not installed in this MCP session")
            })?;
        let manifest = plugin.manifest.clone();
        let selection = view.view["selection"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        let root_id = existing
            .map(|node| node.id.clone())
            .unwrap_or_else(|| omc_model::new_id("node"));
        let root_alias = self.fig_alias(session, &document, &root_id);
        let input = json!({"api":manifest.api,"command":"widget","params":{},"selection":selection,
            "widget":{"id":root_alias,"state":current,"event":event}});
        let mut field_edits = Vec::new();
        if name == "widget.setText"
            && let Some(root) = existing
        {
            let field = event["field"].as_str().unwrap_or_default();
            let value = event["value"].as_str().unwrap_or_default();
            for node in descendants(&snapshot, root) {
                if node.kind != NodeKind::Text || node.string(FIELD) != Some(field) {
                    continue;
                }
                let end = node.string("text").unwrap_or("").encode_utf16().count();
                let selection = self
                    .workspace
                    .text_selection(&document, json!({"nodeId":node.id,"start":0,"end":end,"revision":snapshot.revision()}))?;
                field_edits.push(Command::TextSplice {
                    selection: serde_json::from_value(selection).map_err(plugin_error)?,
                    text: value.to_owned(),
                    attributes: Properties::new(),
                });
            }
        }
        let mut instance =
            Instance::new(&plugin.wasm, &limits(params["fuel"].as_u64())).map_err(plugin_error)?;
        let mut host = PluginHost {
            router: self,
            session,
            root: &view.root,
            manifest: &manifest,
            snapshot: snapshot.clone(),
            selection,
            commands: vec![],
            settings: owner.settings.get(plugin_id).cloned().unwrap_or_default(),
            changed_selection: false,
        };
        for edit in &field_edits {
            if let Command::TextSplice {
                selection, text, ..
            } = edit
                && let Some(node) = host.snapshot.nodes.get_mut(&selection.node_id)
            {
                node.properties.insert("text".into(), json!(text));
            }
        }
        let mut out = instance
            .call(&input.to_string(), &mut host)
            .map_err(plugin_error)?;
        let mut commands = std::mem::take(&mut host.commands);
        if let Some(drawing) = out.widget.take() {
            if (manifest.api < 4 && drawing.uses_api_4())
                || (manifest.api < 6 && drawing.uses_api_6())
            {
                return Err(EngineError::invalid(
                    "widget drawing requires a newer plugin API",
                ));
            }
            let next = drawing.state.unwrap_or(current);
            let mut subtree = Vec::new();
            let mut root = self.widget_layer(&drawing.root, None, "", &mut subtree)?;
            root.properties.extend([
                (PLUGIN.into(), json!(plugin_id)),
                (STATE.into(), json!(next)),
                (MENU.into(), json!(drawing.menu)),
            ]);
            if drawing.root.name.is_empty() {
                root.properties.insert("name".into(), json!(manifest.name));
            }
            for child in &mut subtree {
                if child.parent_id.as_deref() == Some(root.id.as_str()) {
                    child.parent_id = Some(root_id.clone());
                }
            }
            if let Some(existing) = existing {
                for key in ["x", "y", "rotation", "transform", "visible", "locked"] {
                    root.properties.remove(key);
                }
                if drawing.root.name.is_empty() {
                    root.properties.remove("name");
                }
                let removed = [
                    "width",
                    "height",
                    "layout",
                    "fill",
                    "stroke",
                    "strokeWidth",
                    "radius",
                    "opacity",
                    TARGET,
                    FIELD,
                    HOVER,
                ]
                .into_iter()
                .filter(|key| {
                    existing.properties.contains_key(*key) && !root.properties.contains_key(*key)
                })
                .map(str::to_owned)
                .collect::<Vec<_>>();
                if !removed.is_empty() {
                    commands.push(Command::NodeUnset {
                        node_id: root_id.clone(),
                        properties: removed,
                    });
                }
                commands.push(Command::NodeSet {
                    node_id: root_id.clone(),
                    properties: root.properties,
                });
                let old = children(&snapshot, &root_id)
                    .into_iter()
                    .map(|node| node.id.clone())
                    .collect::<Vec<_>>();
                if !old.is_empty() {
                    commands.push(Command::NodeDelete { node_ids: old });
                }
            } else {
                root.id = root_id.clone();
                root.parent_id = Some(view.root.clone());
                root.rank = rank_between(
                    children(&snapshot, &view.root)
                        .last()
                        .map(|node| node.rank.as_str()),
                    None,
                )
                .ok_or_else(|| EngineError::new("resource_limit", "widget rank exhausted"))?;
                let center = (
                    (view.view["center"]["x"].as_f64().unwrap_or(0.)
                        - root.number("width", 0.) / 2.),
                    (view.view["center"]["y"].as_f64().unwrap_or(0.)
                        - root.number("height", 0.) / 2.),
                );
                root.properties
                    .insert("x".into(), json!(params["x"].as_f64().unwrap_or(center.0)));
                root.properties
                    .insert("y".into(), json!(params["y"].as_f64().unwrap_or(center.1)));
                subtree.insert(0, root);
            }
            if !subtree.is_empty() {
                commands.push(Command::NodeCreateMany { nodes: subtree });
            }
        } else if existing.is_none() {
            return Err(EngineError::invalid("the plugin drew no widget"));
        } else if name == "widget.setText" {
            field_edits.append(&mut commands);
            commands = field_edits;
            commands.push(Command::NodeSet {
                node_id: root_id.clone(),
                properties: Properties::from([(STATE.into(), json!(current))]),
            });
        }
        if !commands.is_empty() {
            self.submit(
                session,
                &document,
                Command::Batch { commands },
                &Value::Null,
                Some(snapshot.sequence),
            )?;
        }
        if existing.is_none() {
            self.fig_selection(
                &(session.to_owned(), document.clone()),
                &[json!(root_alias)],
            );
        }
        owner.settings.insert(plugin_id.to_owned(), host.settings);
        let updated = self.workspace.snapshot(&document)?;
        let root = updated
            .nodes
            .get(&root_id)
            .ok_or_else(|| EngineError::invalid("widget was removed"))?;
        let mut result = summary(self, session, &updated, root);
        result["output"] =
            serde_json::from_str::<Value>(&out.output).unwrap_or(Value::String(out.output));
        result["logs"] = json!(out.logs);
        result["calls"] = json!(out.calls);
        result["fuel"] = json!(out.fuel);
        Ok(result)
    }

    fn widget_layer(
        &self,
        spec: &WidgetNode,
        parent: Option<String>,
        rank: &str,
        all: &mut Vec<Node>,
    ) -> Result<Node> {
        let mut layer = match spec.kind {
            WidgetKind::Frame => Node::new(NodeKind::Frame),
            WidgetKind::Text => Node::new(NodeKind::Text),
            WidgetKind::Rectangle => Node::new(NodeKind::Rect),
            WidgetKind::Ellipse => Node::new(NodeKind::Ellipse),
            WidgetKind::Line => Node::new(NodeKind::Line),
            WidgetKind::Image => self.fig_image_node(
                &STANDARD.decode(&spec.data).map_err(plugin_error)?,
                &spec.name,
                &Value::Null,
            )?,
            WidgetKind::Svg => Node::new(NodeKind::Group),
        };
        layer.parent_id = parent.clone();
        if !rank.is_empty() {
            layer.rank = rank.to_owned();
        }
        let children_locked = parent.is_some();
        let mut style = json!({"name":spec.name,"locked":children_locked});
        for (key, value) in [
            ("x", spec.x),
            ("y", spec.y),
            ("width", spec.width),
            ("height", spec.height),
            ("strokeWidth", spec.stroke_weight),
            ("radius", spec.radius),
            ("opacity", spec.opacity),
        ] {
            if let Some(value) = value {
                style[key] = json!(value);
            }
        }
        if let Some(rotation) = spec.rotation {
            style["rotation"] = json!(-rotation);
        }
        let paint = if spec.kind == WidgetKind::Text {
            spec.color.as_ref()
        } else {
            spec.fill.as_ref()
        };
        if let Some(fill) = paint {
            style["fill"] = json!(fill);
        }
        if let Some(stroke) = &spec.stroke {
            style["stroke"] = json!(stroke);
        }
        if spec.kind == WidgetKind::Text {
            style["text"] = json!(spec.text);
            style["fontSize"] = json!(spec.size.unwrap_or(14.));
            style["fontWeight"] = json!(if spec.bold { 700 } else { 400 });
        }
        if let Some(layout) = spec.layout {
            let align = |value| match value {
                Some(WidgetAlign::Center) => "center",
                Some(WidgetAlign::Max) => "end",
                _ => "start",
            };
            let padding = spec.padding.unwrap_or(0.);
            style["layout"] = json!({"type":if layout == WidgetLayout::Horizontal {"horizontal"} else {"vertical"},
                "padding":[padding,padding,padding,padding],"gap":spec.gap.unwrap_or(0.),
                "align":align(spec.align),"justify":align(spec.justify)});
            if spec.width.is_none() {
                style["width"] = json!("auto");
            }
            if spec.height.is_none() {
                style["height"] = json!("auto");
            }
        }
        if !spec.target.is_empty() {
            style[TARGET] = json!(spec.target);
        }
        if !spec.field.is_empty() {
            style[FIELD] = json!(spec.field);
        }
        if let Some(hover) = &spec.hover {
            style[HOVER] = json!(hover);
        }
        layer.properties.extend(properties(&style)?);
        if spec.kind == WidgetKind::Svg {
            let imported = omc_import::import_bytes(
                "svg",
                spec.src.as_bytes(),
                &omc_import::ImportOptions {
                    strict: true,
                    max_nodes: 200,
                    ..Default::default()
                },
            )
            .map_err(plugin_error)?;
            let root_id = &imported.content.pages[0].root_node_id;
            let svg = &imported.content.nodes[root_id];
            for key in ["width", "height", "viewBox", "clipContent"] {
                if let Some(value) = svg.properties.get(key) {
                    layer.properties.entry(key.into()).or_insert(value.clone());
                }
            }
            let ids = imported
                .content
                .nodes
                .keys()
                .map(|id| (id.clone(), omc_model::new_id("node")))
                .collect::<BTreeMap<_, _>>();
            let mut queue = vec![root_id.clone()];
            while let Some(id) = queue.pop() {
                let mut nodes = imported
                    .content
                    .nodes
                    .values()
                    .filter(|node| node.parent_id.as_deref() == Some(&id))
                    .cloned()
                    .collect::<Vec<_>>();
                nodes.sort_by(|a, b| a.rank.cmp(&b.rank));
                for mut child in nodes {
                    queue.push(child.id.clone());
                    child.id = ids[&child.id].clone();
                    child.home_shard = omc_model::new_id("shard");
                    child.parent_id = Some(if &id == root_id {
                        layer.id.clone()
                    } else {
                        ids[&id].clone()
                    });
                    child.properties.insert("locked".into(), json!(true));
                    remap_values(&mut child.properties, &ids);
                    all.push(child);
                }
            }
        }
        let mut rank = None::<String>;
        for child in &spec.children {
            rank = Some(rank_between(rank.as_deref(), None).ok_or_else(|| {
                EngineError::new("resource_limit", "widget child rank exhausted")
            })?);
            let at = all.len();
            let node =
                self.widget_layer(child, Some(layer.id.clone()), rank.as_deref().unwrap(), all)?;
            all.insert(at, node);
        }
        Ok(layer)
    }
}
