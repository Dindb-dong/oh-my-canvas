use super::*;

const MAP: &str = "mindMap";
const TOPIC: &str = "mindMapTopic";
const PARENT: &str = "boardMindParent";
const LABEL: &str = "boardMindLabel";
const EDGE: &str = "boardMindEdge";
const MAX_TOPICS: usize = 50;
const WIDTH: f64 = 180.;
const X_STEP: f64 = 250.;
const GAP: f64 = 24.;
const MARGIN: f64 = 16.;

struct Topic {
    node: Node,
    label: Node,
}

pub(super) fn command(
    snapshot: &DocumentSnapshot,
    page_root: &Node,
    target: &str,
    args: &Value,
    action: &str,
) -> Result<(Vec<Command>, Properties)> {
    let page = &page_root.id;
    if action == "create_mind_map" {
        let parent = native::on_page(snapshot, page, target, true)?;
        if !is_container(parent) {
            return Err(EngineError::invalid("Mind map parent must be a container"));
        }
        return create(snapshot, parent, args);
    }

    let map = native::on_page(snapshot, page, target, action != "inspect_mind_map")?;
    if map.string(TYPE) != Some(MAP) {
        return Err(EngineError::invalid("Choose a mind map"));
    }
    let mut edges = BTreeMap::new();
    let mut topics = Vec::new();
    for layer in children(snapshot, &map.id) {
        if layer.string(TYPE) == Some(TOPIC) {
            let label = children(snapshot, &layer.id)
                .into_iter()
                .find(|node| {
                    node.kind == NodeKind::Text && node.properties.get(LABEL) == Some(&json!(true))
                })
                .ok_or_else(|| EngineError::invalid("Mind map topic has no text layer"))?;
            topics.push(Topic {
                node: layer.clone(),
                label: label.clone(),
            });
        } else if layer.properties.get(EDGE) == Some(&json!(true))
            && let Some(to) = layer.properties[connectors::CONNECTOR]["to"]["layer"].as_str()
        {
            edges.insert(to.to_owned(), layer);
        }
    }
    if topics.is_empty() || topics.len() > MAX_TOPICS {
        return Err(EngineError::invalid("Mind map requires 1–50 topics"));
    }
    if action == "inspect_mind_map" {
        return response(
            map,
            &topics,
            edges
                .iter()
                .map(|(id, node)| (id.as_str(), node.id.as_str())),
            Vec::new(),
        );
    }

    let mut edits = Vec::new();
    match action {
        "add_mind_topic" => {
            if topics.len() >= MAX_TOPICS {
                return Err(EngineError::invalid("Mind map requires at most 50 topics"));
            }
            let parent = topic_for(&topics, string(args, "parentId")?)?
                .node
                .id
                .clone();
            let value = topic(
                map,
                append_rank(snapshot, &map.id)?,
                topic_text(&args["text"])?,
                Some(&parent),
            )?;
            topics.push(value);
        }
        "rename_mind_topic" => {
            let id = string(args, "targetId")?;
            let topic = topics
                .iter_mut()
                .find(|topic| topic.node.id == id)
                .ok_or_else(|| EngineError::invalid("Choose a topic in this mind map"))?;
            let text = topic_text(&args["text"])?;
            if topic.label.string("text") != Some(text) {
                topic.label.properties.insert("text".into(), json!(text));
                edits.push(Command::TextReplace {
                    node_id: topic.label.id.clone(),
                    text: text.into(),
                });
            }
        }
        "remove_mind_topic" => {
            let topic = topic_for(&topics, string(args, "targetId")?)?;
            if !topic.node.properties.contains_key(PARENT) {
                return Err(EngineError::invalid(
                    "The root topic belongs to the mind map",
                ));
            }
            let mut removed = BTreeSet::from([topic.node.id.as_str()]);
            loop {
                let prior = removed.len();
                for topic in &topics {
                    if topic
                        .node
                        .string(PARENT)
                        .is_some_and(|parent| removed.contains(parent))
                    {
                        removed.insert(&topic.node.id);
                    }
                }
                if prior == removed.len() {
                    break;
                }
            }
            let node_ids = removed
                .iter()
                .flat_map(|id| {
                    std::iter::once((*id).to_owned())
                        .chain(edges.remove(*id).map(|edge| edge.id.clone()))
                })
                .collect::<Vec<_>>();
            let mut pending = node_ids.iter().map(String::as_str).collect::<Vec<_>>();
            while let Some(id) = pending.pop() {
                native::on_page(snapshot, page, id, true)?;
                pending.extend(children(snapshot, id).iter().map(|node| node.id.as_str()));
            }
            topics.retain(|topic| !node_ids.contains(&topic.node.id));
            edits.push(Command::NodeDelete { node_ids });
        }
        "layout_mind_map" => {}
        _ => return Err(EngineError::invalid("Unknown mind map action")),
    }

    let (width, height) = layout(&mut topics)?;
    let mut edge_ids = edges
        .into_iter()
        .map(|(id, edge)| (id, edge.id.clone()))
        .collect::<BTreeMap<_, _>>();
    let mut nodes = Vec::new();
    for topic in &topics {
        if let Some(existing) = snapshot.nodes.get(&topic.node.id) {
            patch_geometry(
                snapshot,
                page,
                existing,
                &topic.node,
                ["x", "y", "width", "height"],
                &mut edits,
            )?;
            let label = &snapshot.nodes[&topic.label.id];
            patch_geometry(
                snapshot,
                page,
                label,
                &topic.label,
                ["width", "height"],
                &mut edits,
            )?;
        } else {
            nodes.extend([topic.node.clone(), topic.label.clone()]);
            let edge_rank = rank_between(Some(&topic.node.rank), None).ok_or_else(|| {
                EngineError::new("resource_limit", "Mind map ranks need rebalancing")
            })?;
            let edge = edge_for(map, &topics, topic, edge_rank)?;
            edge_ids.insert(topic.node.id.clone(), edge.id.clone());
            nodes.push(edge);
        }
    }
    let dimensions = Properties::from([
        ("width".into(), json!(width)),
        ("height".into(), json!(height)),
    ]);
    if dimensions
        .iter()
        .any(|(key, value)| map.properties.get(key) != Some(value))
    {
        edits.push(Command::NodeSet {
            node_id: map.id.clone(),
            properties: dimensions,
        });
    }
    if !nodes.is_empty() {
        edits.insert(0, Command::NodeCreateMany { nodes });
    }
    // A short label can change without changing geometry.
    for edit in &edits {
        if let Command::TextReplace { node_id, .. } = edit {
            native::on_page(snapshot, page, node_id, true)?;
        }
    }
    response(
        map,
        &topics,
        edge_ids
            .iter()
            .map(|(id, edge)| (id.as_str(), edge.as_str())),
        edits,
    )
}

fn create(
    snapshot: &DocumentSnapshot,
    parent: &Node,
    args: &Value,
) -> Result<(Vec<Command>, Properties)> {
    let input = args["topics"]
        .as_array()
        .filter(|list| (1..=MAX_TOPICS).contains(&list.len()))
        .ok_or_else(|| EngineError::invalid("Mind map requires 1–50 topics"))?;
    let mut map = new_layer(
        NodeKind::Frame,
        parent,
        append_rank(snapshot, &parent.id)?,
        json!({
            "name":args["name"].as_str().unwrap_or("Mind map"),
            "x":number(args,"x",0.)?,"y":number(args,"y",0.)?,
            "fill":"transparent","boardItemType":MAP,"clipContent":false,
            "style":{"position":"absolute"}
        }),
    )?;
    let mut keys = BTreeMap::<&str, String>::new();
    let mut topics = Vec::with_capacity(input.len());
    for (i, item) in input.iter().enumerate() {
        let key = string(item, "key")?;
        if keys.contains_key(key) {
            return Err(EngineError::invalid("Mind map topic keys must be unique"));
        }
        let parent = match item.get("parent") {
            None if i == 0 => None,
            Some(parent) if i > 0 => Some(
                parent
                    .as_str()
                    .and_then(|key| keys.get(key))
                    .ok_or_else(|| EngineError::invalid("A topic's parent key must precede it"))?
                    .as_str(),
            ),
            _ => return Err(EngineError::invalid("Only the first topic can be the root")),
        };
        let node = topic(&map, rank(i * 2 + 1), topic_text(&item["text"])?, parent)?;
        keys.insert(key, node.node.id.clone());
        topics.push(node);
    }
    let (width, height) = layout(&mut topics)?;
    map.properties.extend([
        ("width".into(), json!(width)),
        ("height".into(), json!(height)),
    ]);
    let mut nodes = vec![map.clone()];
    let mut edges = BTreeMap::new();
    for (i, topic) in topics.iter().enumerate() {
        nodes.extend([topic.node.clone(), topic.label.clone()]);
        if i != 0 {
            let edge = edge_for(&map, &topics, topic, rank(i * 2))?;
            edges.insert(topic.node.id.as_str(), edge.id.clone());
            nodes.push(edge);
        }
    }
    response(
        &map,
        &topics,
        edges.iter().map(|(id, edge)| (*id, edge.as_str())),
        vec![Command::NodeCreateMany { nodes }],
    )
}

fn topic_text(value: &Value) -> Result<&str> {
    value
        .as_str()
        .filter(|text| text.chars().count() <= 512)
        .ok_or_else(|| EngineError::invalid("Topic text must be at most 512 characters"))
}

fn topic_for<'a>(topics: &'a [Topic], id: &str) -> Result<&'a Topic> {
    topics
        .iter()
        .find(|topic| topic.node.id == id)
        .ok_or_else(|| EngineError::invalid("Choose a topic in this mind map"))
}

fn topic(map: &Node, rank: String, text: &str, parent: Option<&str>) -> Result<Topic> {
    let mut node = new_layer(
        NodeKind::Frame,
        map,
        rank,
        json!({
            "name":"Topic","fill":if parent.is_none() {"#dce9ff"} else {"#f1f5fa"},
            "radius":8.,"boardItemType":TOPIC,"style":{"position":"absolute"}
        }),
    )?;
    if let Some(parent) = parent {
        node.properties.insert(PARENT.into(), json!(parent));
    }
    let label = new_layer(
        NodeKind::Text,
        &node,
        rank_between(None, None).unwrap(),
        json!({
            "name":"Topic text","x":16.,"y":12.,"fill":"#263246","fontSize":16.,
            "text":text,"boardMindLabel":true,"style":{"position":"absolute"}
        }),
    )?;
    Ok(Topic { node, label })
}

fn rank(index: usize) -> String {
    format!("{:032x}", (index as u128 + 1) << 112)
}

fn edge_for(map: &Node, topics: &[Topic], to: &Topic, rank: String) -> Result<Node> {
    let from = topic_for(topics, to.node.string(PARENT).unwrap())?;
    let endpoint = |topic: &Topic, side| {
        json!({
            "layer":topic.node.id,"side":side,
            "fallback":[map.number("x",0.) + topic.node.number("x",0.) + WIDTH/2.,
                        map.number("y",0.) + topic.node.number("y",0.) + topic.node.number("height",0.)/2.]
        })
    };
    let (mut edge, _, _) = connectors::build(
        map,
        rank,
        json!({"from":endpoint(from,"right"),"to":endpoint(to,"left"),
               "style":"curved","startCap":"none","endCap":"none"}),
        None,
    )?;
    edge.properties.insert(EDGE.into(), json!(true));
    Ok(edge)
}

fn layout(topics: &mut [Topic]) -> Result<(f64, f64)> {
    let mut children = vec![Vec::new(); topics.len()];
    let mut roots = Vec::new();
    for (i, topic) in topics.iter().enumerate() {
        match topic.node.string(PARENT) {
            None => roots.push(i),
            Some(parent) => {
                let parent = topics
                    .iter()
                    .position(|topic| topic.node.id == parent)
                    .ok_or_else(|| EngineError::invalid("Mind map topic has a missing parent"))?;
                children[parent].push(i);
            }
        }
    }
    let [root] = roots.as_slice() else {
        return Err(EngineError::invalid("Mind map must have one root topic"));
    };
    let text_heights = topics
        .iter()
        .map(|topic| note_metrics(topic.label.string("text").unwrap_or_default(), WIDTH, false).1)
        .collect::<Vec<_>>();
    let heights = text_heights
        .iter()
        .map(|height| (height + 24.).max(48.))
        .collect::<Vec<_>>();
    let mut spans = vec![0.; topics.len()];
    let height = span(*root, &children, &heights, &mut spans);
    if spans.contains(&0.) {
        return Err(EngineError::invalid(
            "Mind map has a disconnected or cyclic branch",
        ));
    }
    let mut positions = vec![(0., 0.); topics.len()];
    position(
        *root,
        MARGIN,
        MARGIN,
        &children,
        &heights,
        &spans,
        &mut positions,
    );
    let mut width: f64 = 0.;
    for (i, topic) in topics.iter_mut().enumerate() {
        let (x, y) = positions[i];
        width = width.max(x + WIDTH);
        topic.node.properties.extend([
            ("x".into(), json!(x)),
            ("y".into(), json!(y)),
            ("width".into(), json!(WIDTH)),
            ("height".into(), json!(heights[i])),
        ]);
        topic.label.properties.extend([
            ("width".into(), json!(WIDTH - 32.)),
            ("height".into(), json!(text_heights[i])),
        ]);
    }
    Ok((width + MARGIN, height + 2. * MARGIN))
}

fn span(i: usize, children: &[Vec<usize>], heights: &[f64], spans: &mut [f64]) -> f64 {
    let branches = children[i]
        .iter()
        .map(|&child| span(child, children, heights, spans))
        .sum::<f64>();
    let value = heights[i].max(branches + GAP * children[i].len().saturating_sub(1) as f64);
    spans[i] = value;
    value
}

fn position(
    i: usize,
    x: f64,
    y: f64,
    children: &[Vec<usize>],
    heights: &[f64],
    spans: &[f64],
    positions: &mut [(f64, f64)],
) {
    positions[i] = (x, y + (spans[i] - heights[i]) / 2.);
    let total = children[i].iter().map(|&child| spans[child]).sum::<f64>()
        + GAP * children[i].len().saturating_sub(1) as f64;
    let mut offset = y + (spans[i] - total) / 2.;
    for &child in &children[i] {
        position(
            child,
            x + X_STEP,
            offset,
            children,
            heights,
            spans,
            positions,
        );
        offset += spans[child] + GAP;
    }
}

fn patch_geometry<const N: usize>(
    snapshot: &DocumentSnapshot,
    page: &str,
    old: &Node,
    node: &Node,
    fields: [&str; N],
    edits: &mut Vec<Command>,
) -> Result<()> {
    let properties: Properties = fields
        .into_iter()
        .filter_map(|key| {
            let value = node.properties.get(key)?;
            (old.properties.get(key) != Some(value)).then(|| (key.into(), value.clone()))
        })
        .collect();
    if !properties.is_empty() {
        native::on_page(snapshot, page, &node.id, true)?;
        edits.push(Command::NodeSet {
            node_id: node.id.clone(),
            properties,
        });
    }
    Ok(())
}

fn response<'a>(
    map: &Node,
    topics: &[Topic],
    edges: impl Iterator<Item = (&'a str, &'a str)>,
    edits: Vec<Command>,
) -> Result<(Vec<Command>, Properties)> {
    let edges = edges.collect::<BTreeMap<_, _>>();
    let items = topics.iter().map(|topic| json!({
        "id":topic.node.id,"textId":topic.label.id,"text":topic.label.string("text").unwrap_or_default(),
        "parentId":topic.node.string(PARENT),"connectorId":edges.get(topic.node.id.as_str()),
    })).collect::<Vec<_>>();
    Ok((edits, properties(&json!({"id":map.id,"topics":items}))?))
}
