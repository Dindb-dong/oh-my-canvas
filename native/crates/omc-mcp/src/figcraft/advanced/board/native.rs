use super::*;

impl ToolRouter {
    pub(crate) fn board_mutation(
        &self,
        session: &str,
        snapshot: &DocumentSnapshot,
        args: &Value,
    ) -> Result<(Vec<Command>, Properties)> {
        let state = self.state(session, &snapshot.id)?;
        let root = on_page(snapshot, &state.root, &state.root, false)?;
        let resolve = |key| self.resolve(session, &snapshot.id, string(args, key)?);
        let output = |id: &str| Properties::from([("id".into(), json!(id))]);

        match string(args, "action")? {
            "create_sticky" => {
                let parent = if args.get("parentId").is_some() {
                    on_page(snapshot, &state.root, &resolve("parentId")?, true)?
                } else {
                    on_page(snapshot, &state.root, &root.id, true)?
                };
                if !is_container(parent) {
                    return Err(EngineError::invalid("Sticky parent must be a container"));
                }
                let color = args
                    .get("color")
                    .map(board_color)
                    .transpose()?
                    .unwrap_or_else(|| "#ffe78a".into());
                let author: String = args["author"]
                    .as_str()
                    .unwrap_or_default()
                    .trim()
                    .chars()
                    .filter(|ch| !ch.is_control())
                    .take(64)
                    .collect();
                let (note, text, commands) = build_note_layers(
                    Note {
                        shape: None,
                        text: &note_text(args["text"].as_str().unwrap_or_default())?,
                        color: &color,
                        author: &author,
                        x: number(args, "x", 0.)?,
                        y: number(args, "y", 0.)?,
                        width: STICKY_SIZE,
                        height: STICKY_SIZE,
                    },
                    parent,
                    append_rank(snapshot, &parent.id)?,
                )?;
                let mut result = output(&note.id);
                result.insert("textId".into(), json!(text.id));
                Ok((commands, result))
            }
            "update_sticky" => {
                let note = on_page(snapshot, &state.root, &resolve("id")?, true)?;
                if note.string(TYPE) != Some("sticky") {
                    return Err(EngineError::invalid("Expected a sticky note"));
                }
                let (commands, text_id) = update_sticky(snapshot, &state.root, note, args)?;
                let mut result = output(&note.id);
                if let Some(text_id) = text_id {
                    result.insert("textId".into(), json!(text_id));
                }
                Ok((commands, result))
            }
            "create_table" => {
                let parent_id = if args.get("parentId").is_some() {
                    resolve("parentId")?
                } else {
                    root.id.clone()
                };
                let parent = on_page(snapshot, &root.id, &parent_id, true)?;
                if !is_container(parent) {
                    return Err(EngineError::invalid("Table parent must be a container"));
                }
                let (id, cells, commands) = table::create(snapshot, parent, args)?;
                table_response(id, &cells, commands)
            }
            action @ ("inspect_table" | "edit_table" | "set_table_cell") => {
                let target = resolve("id")?;
                let table = on_page(snapshot, &root.id, &target, action != "inspect_table")?;
                let operation = match action {
                    "inspect_table" => "inspect",
                    "set_table_cell" => "set_cell",
                    _ => match string(args, "operation")? {
                        "add_row" => "addRow",
                        "remove_row" => "removeRow",
                        "add_column" => "addColumn",
                        "remove_column" => "removeColumn",
                        _ => return Err(EngineError::invalid("Unknown table operation")),
                    },
                };
                let (cells, commands) = table::edit(snapshot, table, args, operation)?;
                for command in &commands {
                    match command {
                        Command::NodeSet { node_id, .. } | Command::TextReplace { node_id, .. } => {
                            on_page(snapshot, &root.id, node_id, true)?;
                        }
                        Command::NodeCreate { node } => {
                            if let Some(parent) = node.parent_id.as_ref()
                                && snapshot.nodes.contains_key(parent)
                            {
                                on_page(snapshot, &root.id, parent, true)?;
                            }
                        }
                        Command::NodeDelete { node_ids } => {
                            let mut pending: Vec<_> = node_ids.iter().map(String::as_str).collect();
                            while let Some(id) = pending.pop() {
                                on_page(snapshot, &root.id, id, true)?;
                                pending.extend(
                                    children(snapshot, id).iter().map(|node| node.id.as_str()),
                                );
                            }
                        }
                        _ => unreachable!("table edits produce only layer commands"),
                    }
                }
                table_response(table.id.clone(), &cells, commands)
            }
            "connect" | "reattach" => {
                let scene = paths::scene(snapshot, &state.page_id)?;
                let endpoint = |id_field, side_field, at_field| {
                    let layer = resolve(id_field)?;
                    let node = on_page(snapshot, &state.root, &layer, false)?;
                    if node.parent_id.is_none() || node.string(TYPE) == Some("connector") {
                        return Err(EngineError::invalid("Expected a layer to attach to"));
                    }
                    connectors::bound_endpoint(&scene, &layer, &args[side_field], &args[at_field])
                };
                if args["action"] == "connect" {
                    on_page(snapshot, &state.root, &root.id, true)?;
                    let mut connector = json!({
                        "from":endpoint("fromId", "fromSide", "fromAt")?,
                        "to":endpoint("toId", "toSide", "toAt")?,
                        "style":"elbow","startCap":"none","endCap":"triangleArrow",
                    });
                    connectors::settings(&mut connector, args)?;
                    let (node, label, commands) = connectors::build(
                        root,
                        append_rank(snapshot, &root.id)?,
                        connector,
                        args["label"].as_str(),
                    )?;
                    let mut result = output(&node.id);
                    if let Some(label) = label {
                        result.insert("labelId".into(), json!(label.id));
                    }
                    Ok((commands, result))
                } else {
                    let node = on_page(snapshot, &state.root, &resolve("id")?, true)?;
                    let mut connector = node
                        .properties
                        .get(connectors::CONNECTOR)
                        .filter(|connector| connector.is_object())
                        .cloned()
                        .ok_or_else(|| EngineError::invalid("Expected a connector"))?;
                    let end = string(args, "end")?;
                    if !matches!(end, "from" | "to") {
                        return Err(EngineError::invalid("end must be from or to"));
                    }
                    connector[end] = endpoint("targetId", "side", "at")?;
                    connector["control"] = Value::Null;
                    connectors::validate_ends(&connector)?;
                    Ok((
                        vec![set_properties(
                            &node.id,
                            [(connectors::CONNECTOR, connector)],
                        )],
                        output(&node.id),
                    ))
                }
            }
            _ => Err(EngineError::invalid("Unknown native board action")),
        }
    }
}

fn table_response(
    id: String,
    cells: &[Vec<Option<String>>],
    commands: Vec<Command>,
) -> Result<(Vec<Command>, Properties)> {
    let mut nodes = Vec::new();
    let mut edits = Vec::new();
    for command in commands {
        match command {
            Command::NodeCreate { node } => nodes.push(node),
            other => edits.push(other),
        }
    }
    if !nodes.is_empty() {
        edits.insert(0, Command::NodeCreateMany { nodes });
    }
    Ok((
        edits,
        properties(&table::response(id, cells, str::to_owned))?,
    ))
}

fn on_page<'a>(
    snapshot: &'a DocumentSnapshot,
    root: &str,
    id: &str,
    writable: bool,
) -> Result<&'a Node> {
    let missing = || EngineError::invalid("Layer must belong to the current document and page");
    let node = snapshot.nodes.get(id).ok_or_else(missing)?;
    let mut current = node;
    let mut seen = BTreeSet::new();
    loop {
        if !seen.insert(&current.id) {
            return Err(EngineError::invalid("Containment cycle"));
        }
        if writable
            && (current.properties.get("locked") == Some(&Value::Bool(true))
                || current.properties.get("hidden") == Some(&Value::Bool(true))
                || current.properties.get("visible") == Some(&Value::Bool(false)))
        {
            return Err(EngineError::invalid(
                "Layer or ancestor is locked or hidden",
            ));
        }
        if current.id == root {
            return Ok(node);
        }
        current = current
            .parent_id
            .as_ref()
            .and_then(|parent| snapshot.nodes.get(parent))
            .ok_or_else(missing)?;
    }
}

fn update_sticky(
    snapshot: &DocumentSnapshot,
    root: &str,
    note: &Node,
    args: &Value,
) -> Result<(Vec<Command>, Option<String>)> {
    let mut commands = Vec::new();
    if let Some(color) = args.get("color") {
        let color = board_color(color)?;
        if note.string("fill") != Some(&color) {
            commands.push(set_properties(&note.id, [("fill", json!(color))]));
        }
    }
    let Some(text) = args["text"].as_str() else {
        if args.get("color").is_none() {
            return Err(EngineError::invalid("update_sticky requires text or color"));
        }
        return Ok((commands, None));
    };
    let text = note_text(text)?;
    let children = children(snapshot, &note.id);
    let label = children
        .iter()
        .find(|node| {
            node.kind == NodeKind::Text
                && node.properties.get(STICKY_TEXT) == Some(&Value::Bool(true))
        })
        .or_else(|| children.iter().find(|node| node.kind == NodeKind::Text))
        .ok_or_else(|| EngineError::invalid("Sticky note has no editable text layer"))?;
    let label = on_page(snapshot, root, &label.id, true)?;
    if label.string("text") != Some(&text) {
        let width = note.number("width", STICKY_SIZE);
        let (size, text_height) = note_metrics(&text, width, true);
        let author = children
            .iter()
            .find(|node| {
                node.id != label.id
                    && node.kind == NodeKind::Text
                    && (node.properties.get(STICKY_AUTHOR) == Some(&Value::Bool(true))
                        || node.string("name") == Some("Author"))
            })
            .copied();
        let old_height = note.number("height", STICKY_SIZE);
        let height = old_height.max(sticky_content_height(text_height, author.is_some()));
        commands.push(set_properties(
            &label.id,
            [
                ("name", json!(note_label_name(&text))),
                ("fontSize", json!(size)),
                ("height", json!(text_height)),
                ("width", json!((width - 32.).max(1.))),
            ],
        ));
        commands.push(Command::TextReplace {
            node_id: label.id.clone(),
            text,
        });
        if old_height < height {
            commands.push(set_properties(&note.id, [("height", json!(height))]));
            if let Some(author) = author {
                on_page(snapshot, root, &author.id, true)?;
                commands.push(set_properties(&author.id, [("y", json!(height - 26.))]));
            }
        }
    }
    Ok((commands, Some(label.id.clone())))
}

fn set_properties<const N: usize>(id: &str, entries: [(&str, Value); N]) -> Command {
    Command::NodeSet {
        node_id: id.into(),
        properties: entries
            .into_iter()
            .map(|(key, value)| (key.into(), value))
            .collect(),
    }
}
