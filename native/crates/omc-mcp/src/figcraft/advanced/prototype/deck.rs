use super::*;
use omc_model::{electron::is_component_definition, rank_between};

const DECK: &str = "presentationDeck";
const LAYOUT: &str = "presentationLayout";

pub(super) fn inspect(snapshot: &DocumentSnapshot, root: &Node) -> Properties {
    let stored = root.properties.get(DECK).unwrap_or(&Value::Null);
    let mut frames = Vec::new();
    let mut invalid = Vec::new();
    let mut layouts = BTreeMap::new();
    for frame in array(stored.get("frameIds"))
        .iter()
        .filter_map(Value::as_str)
    {
        if super::native::visible_frame(snapshot, &root.id, frame) {
            frames.push(frame.to_owned());
            if let Some(instance) = layout_instances(snapshot, frame).next() {
                layouts.insert(frame.to_owned(), instance.id.clone());
            }
        } else {
            invalid.push(frame.to_owned());
        }
    }
    Properties::from([
        ("frameIds".into(), json!(frames)),
        ("invalidFrameIds".into(), json!(invalid)),
        (
            "layoutComponentId".into(),
            stored["layoutComponentId"].clone(),
        ),
        ("layoutInstanceIds".into(), json!(layouts)),
    ])
}

pub(super) fn set(
    snapshot: &DocumentSnapshot,
    root: &Node,
    args: &Value,
    resolve: impl Fn(&Value) -> Result<String>,
) -> Result<(Vec<Command>, Properties)> {
    let frames = args["frameIds"]
        .as_array()
        .filter(|ids| ids.len() <= 100)
        .ok_or_else(|| EngineError::invalid("frameIds requires up to 100 slide frames"))?
        .iter()
        .map(&resolve)
        .collect::<Result<Vec<_>>>()?;
    let new_set = frames.iter().map(String::as_str).collect::<BTreeSet<_>>();
    if new_set.len() != frames.len()
        || frames
            .iter()
            .any(|id| !super::native::visible_frame(snapshot, &root.id, id))
    {
        return Err(EngineError::invalid(
            "Slides must be distinct visible top-level frames on the selected page",
        ));
    }
    let current = root.properties.get(DECK).unwrap_or(&Value::Null);
    let layout_id = match args.get("layoutComponentId") {
        None => current["layoutComponentId"].as_str().map(str::to_owned),
        Some(Value::Null) => None,
        Some(id) => Some(resolve(id)?),
    };
    if let Some(id) = layout_id.as_deref()
        && !snapshot.nodes.get(id).is_some_and(|node| {
            is_component_definition(node)
                && node.properties.get("isVariantSet") != Some(&Value::Bool(true))
        })
    {
        return Err(EngineError::invalid(
            "Slide layout must be a component definition in the same document",
        ));
    }
    if layout_id.as_deref().is_some_and(|component| {
        frames
            .iter()
            .any(|slide| crate::legacy_read::is_descendant(snapshot, component, slide))
    }) {
        return Err(EngineError::invalid(
            "Keep the layout definition outside its slide frames",
        ));
    }

    let old = array(current.get("frameIds"));
    let affected = old
        .iter()
        .filter_map(Value::as_str)
        .filter(|id| snapshot.nodes.contains_key(*id))
        .chain(new_set.iter().copied())
        .collect::<BTreeSet<_>>();
    let mut edits = Vec::new();
    let mut new_nodes = Vec::new();
    let mut deleted_ids = Vec::new();
    let mut layouts = BTreeMap::new();
    for id in affected {
        let slide = &snapshot.nodes[id];
        let desired = layout_id.as_deref().filter(|_| new_set.contains(id));
        let mut instances = layout_instances(snapshot, id);
        let matched = desired.and_then(|component| {
            instances
                .clone()
                .find(|node| node.string("componentId") == Some(component))
        });
        let extras = instances
            .by_ref()
            .filter(|node| Some(node.id.as_str()) != matched.map(|node| node.id.as_str()))
            .collect::<Vec<_>>();
        let create = desired.is_some() && matched.is_none();
        if (create || !extras.is_empty())
            && (locked(slide) || extras.iter().any(|node| locked(node)))
        {
            return Err(EngineError::invalid("Slide frame or layout is locked"));
        }
        deleted_ids.extend(extras.iter().map(|node| node.id.clone()));
        if let Some(component) = desired {
            let instance = if let Some(node) = matched {
                node.id.clone()
            } else {
                let layer = instance(snapshot, slide, component)?;
                let id = layer.id.clone();
                new_nodes.push(layer);
                id
            };
            layouts.insert(id.to_owned(), instance);
        }
    }
    if !deleted_ids.is_empty() {
        edits.push(Command::NodeDelete {
            node_ids: deleted_ids,
        });
    }
    if !new_nodes.is_empty() {
        edits.push(Command::NodeCreateMany { nodes: new_nodes });
    }
    let deck = json!({"frameIds":frames,"layoutComponentId":layout_id});
    if &deck != current {
        edits.push(Command::NodeSet {
            node_id: root.id.clone(),
            properties: Properties::from([(DECK.into(), deck)]),
        });
    }
    Ok((
        edits,
        Properties::from([
            ("frameIds".into(), json!(frames)),
            ("invalidFrameIds".into(), json!([])),
            ("layoutComponentId".into(), json!(layout_id)),
            ("layoutInstanceIds".into(), json!(layouts)),
        ]),
    ))
}

fn layout_instances<'a>(
    snapshot: &'a DocumentSnapshot,
    frame: &str,
) -> impl Iterator<Item = &'a Node> + Clone {
    children(snapshot, frame).into_iter().filter(|layer| {
        layer.kind == NodeKind::Instance && layer.properties.get(LAYOUT) == Some(&Value::Bool(true))
    })
}

fn locked(node: &Node) -> bool {
    node.properties.get("locked") == Some(&Value::Bool(true))
}

fn instance(snapshot: &DocumentSnapshot, slide: &Node, component: &str) -> Result<Node> {
    let mut node = Node::new(NodeKind::Instance);
    node.parent_id = Some(slide.id.clone());
    node.home_shard = slide.home_shard.clone();
    node.rank = rank_between(
        None,
        children(snapshot, &slide.id)
            .first()
            .map(|layer| layer.rank.as_str()),
    )
    .ok_or_else(|| EngineError::invalid("Cannot place the shared layout behind slide content"))?;
    node.properties = Properties::from([
        ("name".into(), json!("Slide layout")),
        ("componentId".into(), json!(component)),
        ("layoutPositioning".into(), json!("absolute")),
        ("x".into(), json!(0)),
        ("y".into(), json!(0)),
        (LAYOUT.into(), json!(true)),
    ]);
    Ok(node)
}
