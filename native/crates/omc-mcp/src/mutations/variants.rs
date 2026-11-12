use super::*;
use omc_scene::{Affine, SceneItem};

type Axes = BTreeMap<String, String>;

impl ToolRouter {
    pub(super) fn variant_mutation(
        &self,
        session: &str,
        doc: &str,
        args: &Value,
        draft: &mut Draft,
    ) -> Result<()> {
        let action = string(args, "action")?;
        let resolve = |id| self.resolve(session, doc, id);
        let ids = if let Some(ids) = args["ids"].as_array() {
            ids.iter()
                .map(|id| resolve(id.as_str().unwrap()))
                .collect::<Result<Vec<_>>>()?
        } else if let Some(id) = args["id"].as_str() {
            vec![resolve(id)?]
        } else {
            return Err(EngineError::invalid("choose a component or instance"));
        };
        let raw = ids
            .first()
            .ok_or_else(|| EngineError::invalid("choose a component or instance"))?;
        let node = draft.node(raw)?.clone();
        let page = self.state(session, doc)?.page_id;
        let scene = paths::scene(&draft.snapshot, &page)?;
        if ids.iter().any(|id| !paths::editable(&scene, id)) {
            return Err(EngineError::invalid(
                "component layer is locked, hidden or outside the selected page",
            ));
        }
        match action {
            "combine" => {
                if ids.len() < 2 || ids.iter().collect::<BTreeSet<_>>().len() != ids.len() {
                    return Err(EngineError::invalid(
                        "choose two or more distinct component definitions",
                    ));
                }
                let mut variants = Vec::new();
                for id in &ids {
                    let node = definition(draft, id)?;
                    let label = node.string("name").unwrap_or(id);
                    let mut values = read_axes(node)?;
                    if values.is_empty() {
                        values = parse_axes(label)
                            .unwrap_or_else(|| BTreeMap::from([("Variant".into(), label.into())]));
                    }
                    variants.push((id.clone(), values));
                }
                validate_axes(variants.iter().map(|(_, axes)| axes))?;
                let set = make_set(
                    draft,
                    &scene,
                    &ids,
                    args["name"].as_str().unwrap_or("Variants"),
                )?;
                for (id, axes) in variants {
                    write_axes(draft, id, Some(&set), &axes)?;
                }
                Ok(())
            }
            "add_variant" => {
                let source = definition(draft, node.string("componentId").unwrap_or(raw))?.clone();
                let proposed = if args["variantProperties"].is_array() {
                    Some(axes_value(&args["variantProperties"])?)
                } else {
                    args["name"].as_str().and_then(parse_axes)
                };
                let mut old = read_axes(&source)?;
                if old.is_empty() {
                    old = source
                        .string("name")
                        .and_then(parse_axes)
                        .unwrap_or_default();
                }
                if old.is_empty() {
                    old = match &proposed {
                        Some(axes) if !axes.is_empty() => axes
                            .keys()
                            .map(|name| (name.clone(), "Default".into()))
                            .collect(),
                        _ => BTreeMap::from([("Variant".into(), "Default".into())]),
                    };
                }
                let next = proposed.unwrap_or_else(|| {
                    let mut next = old.clone();
                    let first = next.values_mut().next().unwrap();
                    *first = args["value"]
                        .as_str()
                        .map(str::to_owned)
                        .unwrap_or_else(|| format!("{first} copy"));
                    next
                });
                let mut existing = source
                    .string("variantSetId")
                    .map(|set| variants(draft, set))
                    .transpose()?
                    .unwrap_or_default();
                if existing.is_empty() {
                    existing.push((source.id.clone(), old.clone()));
                }
                validate_axes(
                    existing
                        .iter()
                        .map(|(_, axes)| axes)
                        .chain(std::iter::once(&next)),
                )?;
                let set = if let Some(set) = source.string("variantSetId") {
                    set.to_owned()
                } else {
                    let source_page = page_of(&draft.snapshot, &source.id)?;
                    let source_scene = paths::scene(&draft.snapshot, source_page)?;
                    let set = make_set(
                        draft,
                        &source_scene,
                        std::slice::from_ref(&source.id),
                        source.string("name").unwrap_or("Variants"),
                    )?;
                    write_axes(draft, source.id.clone(), Some(&set), &old)?;
                    set
                };
                let rank = draft.last_rank(&set)?;
                let mut copies = copy_subtree(draft, &source.id, Some(&set), Some(&rank))?;
                let base = draft.node(&source.id)?;
                let clone = &mut copies[0];
                let sibling_right = children(&draft.snapshot, &set)
                    .iter()
                    .map(|node| node.number("x", 0.) + node.number("width", 0.))
                    .fold(0., f64::max);
                clone
                    .properties
                    .insert("x".into(), json!(sibling_right + 24.));
                clone
                    .properties
                    .insert("y".into(), json!(base.number("y", 0.)));
                let default_name = format!("{} copy", source.string("name").unwrap_or("Component"));
                clone.properties.insert(
                    "name".into(),
                    json!(args["name"].as_str().unwrap_or(&default_name)),
                );
                clone.properties.insert("variantSetId".into(), json!(set));
                clone
                    .properties
                    .insert("variantProperties".into(), axes_json(&next));
                let width = sibling_right + 24. + clone.number("width", 0.);
                let height = clone.number("y", 0.) + clone.number("height", 0.);
                draft.apply(Command::NodeSet {
                    node_id: set.clone(),
                    properties: Properties::from([
                        (
                            "width".into(),
                            json!(draft.node(&set)?.number("width", 0.).max(width)),
                        ),
                        (
                            "height".into(),
                            json!(draft.node(&set)?.number("height", 0.).max(height)),
                        ),
                    ]),
                })?;
                for node in copies {
                    draft.apply(Command::NodeCreate { node })?;
                }
                Ok(())
            }
            "axes" => {
                definition(draft, raw)?;
                let axes = axes_value(&args["variantProperties"])?;
                let set = node.string("variantSetId");
                if let Some(set) = set {
                    let existing = variants(draft, set)?;
                    validate_axes(
                        existing
                            .iter()
                            .map(|(id, old)| if id == raw { &axes } else { old }),
                    )?;
                }
                write_axes(draft, raw.clone(), set, &axes)
            }
            "variant" => {
                if node.kind != NodeKind::Instance {
                    return Err(EngineError::invalid("choose an instance"));
                }
                let source = definition(draft, node.string("componentId").unwrap_or_default())?;
                let set = source.string("variantSetId").ok_or_else(|| {
                    EngineError::invalid("component is not part of a variant set")
                })?;
                let value = string(args, "value")?;
                let definitions = variants(draft, set)?;
                let base = read_axes(source)?;
                let target = if let Ok(raw) = resolve(value) {
                    definitions
                        .iter()
                        .find(|(id, _)| *id == raw)
                        .map(|(id, _)| id.clone())
                } else {
                    let requested = if let Some(axis) = args["name"].as_str() {
                        Some(BTreeMap::from([(axis.to_owned(), value.to_owned())]))
                    } else {
                        parse_axes(value)
                    };
                    let mut matches = definitions.iter().filter(|(id, candidate)| {
                        if let Some(requested) = &requested {
                            requested.keys().all(|key| base.contains_key(key))
                                && candidate.iter().all(|(key, current)| {
                                    requested.get(key).or_else(|| base.get(key)) == Some(current)
                                })
                        } else {
                            draft.snapshot.nodes[id].string("name") == Some(value) || {
                                let changes: Vec<_> = candidate
                                    .iter()
                                    .filter(|(key, current)| base.get(*key) != Some(*current))
                                    .collect();
                                changes.len() == 1 && changes[0].1 == value
                            }
                        }
                    });
                    matches
                        .next()
                        .filter(|_| matches.next().is_none())
                        .map(|(id, _)| id.clone())
                }
                .ok_or_else(|| {
                    EngineError::invalid("value must identify one variant within the same set")
                })?;
                let mut properties = Properties::from([("componentId".into(), json!(target))]);
                if let Some(overrides) = node.properties.get("overrides").and_then(Value::as_object)
                {
                    properties.insert(
                        "overrides".into(),
                        remap_overrides(draft, &source.id, &target, overrides),
                    );
                }
                draft.apply(Command::NodeSet {
                    node_id: raw.clone(),
                    properties,
                })
            }
            _ => unreachable!(),
        }
    }
}

fn definition<'a>(draft: &'a Draft, id: &str) -> Result<&'a Node> {
    draft.node(id).and_then(|node| {
        if node.kind == NodeKind::Component {
            Ok(node)
        } else {
            Err(EngineError::invalid("choose a main component definition"))
        }
    })
}

fn page_of<'a>(snapshot: &'a DocumentSnapshot, mut id: &'a str) -> Result<&'a str> {
    for _ in 0..=256 {
        if let Some(page) = snapshot.pages.iter().find(|page| page.root_node_id == id) {
            return Ok(&page.id);
        }
        let Some(parent) = snapshot
            .nodes
            .get(id)
            .and_then(|node| node.parent_id.as_deref())
        else {
            break;
        };
        id = parent;
    }
    Err(EngineError::invalid(
        "component definition is outside the document pages",
    ))
}

fn variants(draft: &Draft, set: &str) -> Result<Vec<(String, Axes)>> {
    children(&draft.snapshot, set)
        .into_iter()
        .filter(|node| node.kind == NodeKind::Component && node.string("variantSetId") == Some(set))
        .map(|node| Ok((node.id.clone(), read_axes(node)?)))
        .collect()
}

fn read_axes(node: &Node) -> Result<Axes> {
    node.properties
        .get("variantProperties")
        .map(axes_value)
        .transpose()
        .map(Option::unwrap_or_default)
}

fn axes_value(value: &Value) -> Result<Axes> {
    let rows = value
        .as_array()
        .ok_or_else(|| EngineError::invalid("variantProperties must be an array"))?;
    let mut axes = Axes::new();
    for row in rows {
        let name = string(row, "name")?.trim();
        let value = string(row, "value")?.trim();
        if name.is_empty()
            || value.is_empty()
            || axes.insert(name.to_owned(), value.to_owned()).is_some()
        {
            return Err(EngineError::invalid(
                "variant axis names and values must be nonempty and unique",
            ));
        }
    }
    Ok(axes)
}

fn parse_axes(name: &str) -> Option<Axes> {
    let mut axes = Axes::new();
    for pair in name.split(',') {
        let (axis, value) = pair.trim().split_once('=')?;
        let (axis, value) = (axis.trim(), value.trim());
        if axis.is_empty()
            || value.is_empty()
            || value.contains('=')
            || axes.insert(axis.into(), value.into()).is_some()
        {
            return None;
        }
    }
    Some(axes)
}

fn validate_axes<'a>(variants: impl Iterator<Item = &'a Axes>) -> Result<()> {
    let mut axes = None;
    let mut seen = BTreeSet::new();
    for variant in variants {
        let names = variant.keys().collect::<Vec<_>>();
        if names.is_empty() || axes.as_ref().is_some_and(|axes| *axes != names) {
            return Err(EngineError::invalid(
                "variants must use identical nonempty axes",
            ));
        }
        axes = Some(names);
        if !seen.insert(variant) {
            return Err(EngineError::invalid("duplicate variant values"));
        }
    }
    Ok(())
}

fn axes_json(axes: &Axes) -> Value {
    json!(
        axes.iter()
            .map(|(name, value)| json!({"name":name,"value":value}))
            .collect::<Vec<_>>()
    )
}

fn write_axes(draft: &mut Draft, id: String, set: Option<&str>, axes: &Axes) -> Result<()> {
    let mut properties = Properties::from([("variantProperties".into(), axes_json(axes))]);
    if let Some(set) = set {
        properties.insert("variantSetId".into(), json!(set));
    }
    draft.apply(Command::NodeSet {
        node_id: id,
        properties,
    })
}

fn make_set(
    draft: &mut Draft,
    scene: &omc_scene::Scene,
    ids: &[String],
    name: &str,
) -> Result<String> {
    let first = definition(draft, &ids[0])?;
    let parent = first
        .parent_id
        .clone()
        .ok_or_else(|| EngineError::invalid("cannot wrap a page root"))?;
    let parent_inverse = scene
        .item(&parent)
        .and_then(|item| item.world.inverse())
        .ok_or_else(|| EngineError::invalid("component parent transform is not invertible"))?;
    let mut items: Vec<(&SceneItem, Affine)> = Vec::new();
    let [mut left, mut top, mut right, mut bottom] = [
        f64::INFINITY,
        f64::INFINITY,
        f64::NEG_INFINITY,
        f64::NEG_INFINITY,
    ];
    for id in ids {
        let node = definition(draft, id)?;
        if node.parent_id.as_deref() != Some(&parent) {
            return Err(EngineError::invalid(
                "component definitions must share a parent",
            ));
        }
        let item = scene
            .item(id)
            .ok_or_else(|| EngineError::invalid("component definition has no scene geometry"))?;
        let transform = parent_inverse.multiply(item.world);
        let [x, y, width, height] = transform.bounds(item.width, item.height);
        left = left.min(x);
        top = top.min(y);
        right = right.max(x + width);
        bottom = bottom.max(y + height);
        items.push((item, transform));
    }
    let mut set = Node::new(NodeKind::Frame);
    set.rank = ids
        .iter()
        .map(|id| &draft.snapshot.nodes[id].rank)
        .min()
        .unwrap()
        .clone();
    set.parent_id = Some(parent);
    set.home_shard.clone_from(&first.home_shard);
    let id = set.id.clone();
    set.properties.extend([
        ("name".into(), json!(name)),
        ("x".into(), json!(left)),
        ("y".into(), json!(top)),
        ("width".into(), json!(right - left)),
        ("height".into(), json!(bottom - top)),
        ("style".into(), json!({"position":"absolute"})),
        ("isVariantSet".into(), json!(true)),
        ("variantSetId".into(), json!(id)),
    ]);
    draft.apply(Command::NodeCreate { node: set })?;
    for (item, transform) in items {
        let transform = Affine::translation(-left, -top).multiply(transform);
        let rank = draft.node(&item.id)?.rank.clone();
        draft.apply(Command::NodeSet {
            node_id: item.id.clone(),
            properties: vector::absolute_placement(item, transform),
        })?;
        draft.apply(Command::NodeMove {
            node_id: item.id.clone(),
            parent_id: Some(id.clone()),
            rank,
        })?;
    }
    Ok(id)
}

fn remap_overrides(
    draft: &Draft,
    from: &str,
    to: &str,
    overrides: &serde_json::Map<String, Value>,
) -> Value {
    let mut output = serde_json::Map::new();
    let mut pending = vec![(from.to_owned(), to.to_owned())];
    while let Some((from, to)) = pending.pop() {
        if let Some(patch) = overrides.get(&from) {
            output.insert(to.clone(), patch.clone());
        }
        let old = children(&draft.snapshot, &from);
        let new = children(&draft.snapshot, &to);
        let mut matched = BTreeSet::new();
        for node in old {
            let candidate = new.iter().find(|candidate| {
                !matched.contains(&candidate.id)
                    && node.kind == candidate.kind
                    && node.string("name") == candidate.string("name")
            });
            if let Some(candidate) = candidate {
                matched.insert(candidate.id.clone());
                pending.push((node.id.clone(), candidate.id.clone()));
            }
        }
    }
    Value::Object(output)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn variant_commands_switch_the_rendered_definition() {
        let profile = tempfile::tempdir().unwrap();
        let workspace = Workspace::open(profile.path(), None).unwrap();
        let session = workspace.session_open(None).unwrap()["sessionId"]
            .as_str()
            .unwrap()
            .to_owned();
        let router = Arc::new(ToolRouter::new(workspace.clone()));
        let call = |name: &str, args: Value| {
            router
                .call(&session, name, args, Value::Null)
                .unwrap_or_else(|error| panic!("{name}: {error:?}"))
        };
        let document = call("create_document", json!({"title":"Component variants"}));
        let id = document["documentId"].as_str().unwrap();
        let raw_id = native_id(id).unwrap();
        let created = |result: Value| result["rawIds"][0].as_str().unwrap().to_owned();
        let make_main = |name, x, color| {
            let raw = created(call(
                "create_shape",
                json!({
                    "documentId":id,"type":"rect","x":x,"y":20,"width":30,"height":30,
                    "properties":{"fills":[{"type":"solid","color":color}]}
                }),
            ));
            created(call(
                "component",
                json!({"documentId":id,"action":"create","id":raw,"name":name}),
            ))
        };
        let default = make_main("State=Default", 20, "#FF0000");
        let pressed = make_main("State=Pressed", 100, "#0000FF");
        let set = created(call(
            "component",
            json!({"documentId":id,"action":"combine","ids":[default,pressed],"name":"Button"}),
        ));
        let instance = created(call(
            "component",
            json!({"documentId":id,"action":"instance","source":default,"x":200,"y":100}),
        ));
        let png = || {
            call(
                "export_document",
                json!({"id":id,"format":"png","bounds":{"x":0,"y":0,"width":280,"height":180}}),
            )["base64"]
                .clone()
        };
        let first = png();
        call(
            "component",
            json!({"documentId":id,"action":"variant","id":instance,"name":"State","value":"Pressed"}),
        );
        let snapshot = workspace.snapshot(&raw_id).unwrap();
        assert_eq!(snapshot.nodes[&instance].properties["componentId"], pressed);
        let scene = paths::scene(&snapshot, document["page"]["id"].as_str().unwrap()).unwrap();
        let rendered = scene.item(&instance).unwrap();
        assert_eq!(rendered.properties["fills"][0]["color"], "#0000FF");
        assert_eq!(rendered.bounds, [200., 100., 30., 30.]);
        assert_ne!(first, png());
        assert_eq!(
            snapshot.nodes[&pressed].parent_id.as_deref(),
            Some(set.as_str())
        );

        call(
            "component",
            json!({"documentId":id,"action":"axes","id":pressed,"variantProperties":[{"name":"State","value":"Active"}]}),
        );
        let loading = created(call(
            "component",
            json!({"documentId":id,"action":"add_variant","id":instance,"name":"State=Loading"}),
        ));
        assert_eq!(
            workspace.snapshot(&raw_id).unwrap().nodes[&loading]
                .parent_id
                .as_deref(),
            Some(set.as_str())
        );
        call(
            "component",
            json!({"documentId":id,"action":"variant","id":instance,"value":"State=Loading"}),
        );
        let snapshot = workspace.snapshot(&raw_id).unwrap();
        assert_eq!(snapshot.nodes[&instance].properties["componentId"], loading);
        assert_eq!(
            snapshot.nodes[&pressed].properties["variantProperties"][0]["value"],
            "Active"
        );
        let invalid = router.call(&session, "component", json!({"documentId":id,"action":"axes","id":loading,"variantProperties":[{"name":"State","value":"Active"}]}), Value::Null);
        assert_eq!(invalid.unwrap_err().code, "invalid_argument");
        assert_eq!(
            workspace.snapshot(&raw_id).unwrap().sequence,
            snapshot.sequence
        );
    }
}
