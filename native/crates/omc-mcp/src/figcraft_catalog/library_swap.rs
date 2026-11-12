use super::*;
use serde_json::Map;

pub(super) fn instance_patch(
    snapshot: &DocumentSnapshot,
    node: &Node,
    destination: &str,
    text_only: bool,
) -> Result<Properties> {
    let original = node
        .string("componentId")
        .and_then(|id| snapshot.nodes.get(id))
        .ok_or_else(|| EngineError::invalid("Expected a linked instance"))?;
    let replacement = snapshot
        .nodes
        .get(destination)
        .filter(|node| node.kind == NodeKind::Component)
        .ok_or_else(|| EngineError::invalid("Linked component is missing"))?;
    let mut patch = Properties::from([("componentId".into(), json!(destination))]);
    if let Some(overrides) = node.properties.get("overrides").and_then(Value::as_object) {
        let mut mapping = BTreeMap::new();
        let mut parents = vec![(original.id.as_str(), replacement.id.as_str())];
        while let Some((source, target)) = parents.pop() {
            mapping.insert(source, target);
            let destination = children(snapshot, target);
            for child in children(snapshot, source) {
                let name = child.string("name");
                let mut matches = destination
                    .iter()
                    .filter(|item| item.kind == child.kind && item.string("name") == name);
                if let Some(next) = matches.next().filter(|_| matches.next().is_none()) {
                    parents.push((&child.id, &next.id));
                }
            }
        }
        let mut mapped = Map::new();
        for (id, value) in overrides {
            let target = mapping.get(id.as_str());
            if text_only {
                if snapshot
                    .nodes
                    .get(id)
                    .is_some_and(|node| node.kind == NodeKind::Text)
                    && let Some(target) = target
                    && let Some(value) = value.get("text")
                {
                    mapped.insert((*target).into(), json!({"text":value}));
                }
            } else {
                let target = target.ok_or_else(|| {
                    EngineError::new(
                        "conflict",
                        "A layer override has no matching layer in the new component",
                    )
                })?;
                mapped.insert((*target).into(), value.clone());
            }
        }
        patch.insert("overrides".into(), Value::Object(mapped));
    }
    let key = ["componentProperties", "propertyValues"]
        .into_iter()
        .find(|key| {
            node.properties
                .get(*key)
                .and_then(Value::as_object)
                .is_some()
        });
    if let Some(key) = key {
        if text_only {
            patch.insert(key.into(), json!({}));
            return Ok(patch);
        }
        let mut values = Map::new();
        let old = original
            .properties
            .get("componentPropertyDefinitions")
            .and_then(Value::as_array);
        let new = replacement
            .properties
            .get("componentPropertyDefinitions")
            .and_then(Value::as_array);
        for (id, value) in node.properties[key].as_object().unwrap() {
            let source = old
                .into_iter()
                .flatten()
                .find(|entry| entry["id"] == *id)
                .ok_or_else(|| {
                    EngineError::new("conflict", "An instance override property is unavailable")
                })?;
            let dest = new
                .into_iter()
                .flatten()
                .find(|entry| entry["name"] == source["name"] && entry["type"] == source["type"])
                .ok_or_else(|| {
                    EngineError::new(
                        "conflict",
                        "An instance override has no matching property in the new component",
                    )
                })?;
            values.insert(string(dest, "id")?.into(), value.clone());
        }
        patch.insert(key.into(), Value::Object(values));
    }
    Ok(patch)
}

#[derive(Default)]
struct Links {
    matches: BTreeMap<String, String>,
    names: BTreeMap<String, String>,
}

fn replacements(source: &Value, destination: &Value, section: &str, mapping: &str) -> Links {
    let mut links = Links::default();
    let entries = source["snapshot"][section]
        .as_object()
        .into_iter()
        .flat_map(Map::iter);
    for (key, row) in entries {
        let Some(name) = row["name"].as_str() else {
            continue;
        };
        let Some(from) = source[mapping][key].as_str() else {
            continue;
        };
        links.names.insert(from.to_owned(), name.into());
        let mut matches = destination["snapshot"][section]
            .as_object()
            .into_iter()
            .flat_map(Map::iter)
            .filter(|(_, candidate)| {
                candidate["name"] == name
                    && candidate["type"] == row["type"]
                    && candidate["published"] != false
            });
        let Some((key, _)) = matches.next().filter(|_| matches.next().is_none()) else {
            continue;
        };
        if let Some(to) = destination[mapping][key].as_str() {
            links.matches.insert(from.into(), to.into());
        }
    }
    links
}

fn swap_reference(
    key: &str,
    value: &mut Value,
    styles: &Links,
    tokens: &Links,
    used: &mut BTreeSet<String>,
    unmatched: &mut BTreeSet<String>,
) {
    let links = match key {
        "$token" => Some(tokens),
        "fillStyleId" | "strokeStyleId" | "textStyleId" | "effectStyleId" => Some(styles),
        _ => None,
    };
    if let Some(links) = links
        && let Some(id) = value.as_str()
        && let Some(name) = links.names.get(id)
    {
        if let Some(target) = links.matches.get(id) {
            used.insert(id.into());
            *value = json!(target);
        } else {
            unmatched.insert(name.clone());
        }
    }
    match value {
        Value::Array(items) => items
            .iter_mut()
            .for_each(|item| swap_reference(key, item, styles, tokens, used, unmatched)),
        Value::Object(items) => items
            .iter_mut()
            .for_each(|(key, item)| swap_reference(key, item, styles, tokens, used, unmatched)),
        _ => {}
    }
}

fn matching_mode<'a>(source: &Value, destination: &'a Value, mode: &Value) -> Option<&'a Value> {
    let name = source["modes"]
        .as_array()?
        .iter()
        .find(|row| row["id"] == *mode)?["name"]
        .as_str()?;
    destination["modes"]
        .as_array()?
        .iter()
        .find(|row| row["name"] == name)
        .and_then(|row| row.get("id"))
}

pub(super) fn swap(
    snapshot: &DocumentSnapshot,
    source: &Value,
    destination: &Value,
    commands: &mut Vec<Command>,
) -> Result<Value> {
    let source_id = string(source, "id")?;
    if source_id == string(destination, "id")? {
        return Err(EngineError::invalid("Select two different libraries"));
    }
    let components = replacements(source, destination, "components", "componentMap");
    let styles = replacements(source, destination, "styles", "styleMap");
    let tokens = replacements(source, destination, "variables", "variableMap");
    let collections = replacements(source, destination, "collections", "collectionMap");
    let collection_rows = resources::catalogs(&snapshot.metadata, "figcraftCollections");
    let mut changed_components = BTreeSet::new();
    let mut changed_refs = BTreeSet::new();
    let mut unmatched = BTreeSet::new();
    for node in snapshot.nodes.values().filter(|node| {
        node.string("libraryId") != Some(source_id) || node.kind == NodeKind::Instance
    }) {
        let mut patch = Properties::new();
        if node.kind == NodeKind::Instance
            && let Some(component) = node.string("componentId")
            && let Some(name) = components.names.get(component)
        {
            if let Some(target) = components.matches.get(component) {
                patch.extend(instance_patch(snapshot, node, target, false)?);
                patch.insert("libraryId".into(), destination["id"].clone());
                changed_components.insert(component.to_owned());
            } else {
                unmatched.insert(name.clone());
            }
        }
        let mut text_after = None;
        for (key, value) in &node.properties {
            let mut next = patch.get(key).unwrap_or(value).clone();
            swap_reference(
                key,
                &mut next,
                &styles,
                &tokens,
                &mut changed_refs,
                &mut unmatched,
            );
            if key == "figcraftVariableModes"
                && let Some(modes) = next.as_object_mut()
            {
                for (id, mode) in modes.clone() {
                    let Some(old) = collection_rows.get(&id) else {
                        continue;
                    };
                    let source = old["extendsCollection"].as_str().unwrap_or(&id);
                    let Some(name) = collections.names.get(source) else {
                        continue;
                    };
                    let Some(new_parent) = collections.matches.get(source) else {
                        unmatched.insert(name.clone());
                        continue;
                    };
                    let mode = collection_rows
                        .get(new_parent)
                        .and_then(|new| matching_mode(old, new, &mode));
                    if let Some(mode) = mode {
                        let new_id = if source == id { new_parent } else { &id };
                        modes.remove(&id);
                        modes.insert(new_id.clone(), mode.clone());
                    } else {
                        unmatched.insert(name.clone());
                    }
                }
            }
            if next != *value {
                if key == "textRuns" && node.kind == NodeKind::Text {
                    text_after = Some(next);
                } else {
                    patch.insert(key.clone(), next);
                }
            }
        }
        if let Some(runs) = text_after {
            let mut next = node.clone();
            next.properties.insert("textRuns".into(), runs);
            crate::libraries::update_text(node, &next, commands)?;
        }
        if !patch.is_empty() {
            commands.push(Command::NodeSet {
                node_id: node.id.clone(),
                properties: patch,
            });
        }
    }
    let variable_rows = resources::catalogs(&snapshot.metadata, "tokens");
    for (id, collection) in &collection_rows {
        let Some(parent) = collection["extendsCollection"].as_str() else {
            continue;
        };
        let Some(name) = collections.names.get(parent) else {
            continue;
        };
        let Some(destination) = collections.matches.get(parent) else {
            unmatched.insert(name.clone());
            continue;
        };
        let Some((parent_row, destination_row)) = collection_rows
            .get(parent)
            .zip(collection_rows.get(destination))
        else {
            unmatched.insert(name.clone());
            continue;
        };
        commands.push(collection_patch(
            id,
            &json!({"extendsCollection":destination}),
        )?);
        for (id, token) in variable_rows
            .iter()
            .filter(|(_, token)| token["collectionId"] == *id)
        {
            let Some(source_token) = token["extendsVariable"].as_str() else {
                continue;
            };
            let target = tokens.matches.get(source_token);
            let mut patch = json!({"extendsVariable":target});
            let mut overrides = Vec::new();
            let mut values = Map::new();
            if target.is_some() {
                for mode in token["overrideModes"].as_array().into_iter().flatten() {
                    if let Some(mode_id) =
                        matching_mode(parent_row, destination_row, mode).and_then(Value::as_str)
                    {
                        let old = mode.as_str().unwrap_or("");
                        if let Some(value) = token["modes"].get(old) {
                            overrides.push(mode_id);
                            values.insert(mode_id.into(), value.clone());
                        }
                    }
                }
                patch["modes"] = json!(values);
            }
            patch["overrideModes"] = json!(overrides);
            commands.push(catalog("tokens", id, patch)?);
        }
    }
    for (namespace, fields) in [
        ("styles", &["value"][..]),
        ("tokens", &["value", "modes"][..]),
    ] {
        for (id, row) in resources::catalogs(&snapshot.metadata, namespace) {
            if row["libraryId"] == source_id {
                continue;
            }
            let mut patch = json!({});
            for key in fields {
                let mut next = row[*key].clone();
                swap_reference(
                    key,
                    &mut next,
                    &styles,
                    &tokens,
                    &mut changed_refs,
                    &mut unmatched,
                );
                if next != row[*key] {
                    patch[*key] = next;
                }
            }
            if patch != json!({}) {
                commands.push(catalog(namespace, &id, patch)?);
            }
        }
    }
    let removed = unmatched.is_empty();
    if removed {
        commands.push(catalog(
            "libraries",
            source_id,
            json!({"deleted":true,"enabled":false}),
        )?);
    }
    Ok(json!({
        "components":changed_components.len(),
        "styles":changed_refs.iter().filter(|id| styles.names.contains_key(*id)).count(),
        "variables":changed_refs.iter().filter(|id| tokens.names.contains_key(*id)).count(),
        "unmatched":unmatched,"removed":removed,
    }))
}

fn page_scene(snapshot: &DocumentSnapshot, state: &ViewState) -> Result<omc_scene::Scene> {
    omc_scene::build_scene(
        snapshot,
        &omc_scene::SceneOptions {
            page_id: Some(state.page_id.clone()),
            ..Default::default()
        },
    )
    .map_err(|error| EngineError::invalid(error.to_string()))
}

fn visible_at(scene: &omc_scene::Scene, item: &omc_scene::SceneItem, x: f64, y: f64) -> bool {
    if item.hidden || item.locked || !item.contains(x, y) {
        return false;
    }
    let mut parent = item.parent;
    while let Some(index) = parent {
        let ancestor = &scene.items[index];
        if ancestor.hidden
            || ancestor.locked
            || ancestor.boolean_operation().is_some()
            || ancestor.clip && !ancestor.contains(x, y)
        {
            return false;
        }
        parent = ancestor.parent;
    }
    true
}

pub(super) fn at_point<'a>(
    snapshot: &'a DocumentSnapshot,
    state: &ViewState,
    component: &str,
    x: f64,
    y: f64,
) -> Result<&'a Node> {
    let scene = page_scene(snapshot, state)?;
    let set = snapshot
        .nodes
        .get(component)
        .filter(|node| node.kind == NodeKind::Component)
        .ok_or_else(|| EngineError::invalid("Linked component is missing"))?
        .string("variantSetId");
    let mut candidates = scene.items.iter().rev().filter_map(|item| {
        let node = snapshot.nodes.get(&item.id)?;
        (node.kind == NodeKind::Instance && visible_at(&scene, item, x, y)).then_some(node)
    });
    let first = candidates
        .next()
        .ok_or_else(|| EngineError::invalid("No unlocked instance at that point"))?;
    if let Some(set) = set {
        let same_set = |node: &Node| {
            node.string("componentId")
                .and_then(|id| snapshot.nodes.get(id))
                .and_then(|definition| definition.string("variantSetId"))
                == Some(set)
        };
        if !same_set(first)
            && let Some(matching) = candidates.find(|node| same_set(node))
        {
            return Ok(matching);
        }
    }
    Ok(first)
}

pub(super) fn place(
    snapshot: &DocumentSnapshot,
    state: &ViewState,
    component: &str,
    x: f64,
    y: f64,
    library: Option<&str>,
) -> Result<Node> {
    let scene = page_scene(snapshot, state)?;
    let parent = scene
        .items
        .iter()
        .rev()
        .find(|item| {
            snapshot.nodes.get(&item.id).is_some_and(|node| {
                node.kind == NodeKind::Frame
                    && node.parent_id.is_some()
                    && node.string("libraryId").is_none()
                    && node.properties.get("isVariantSet") != Some(&Value::Bool(true))
            }) && visible_at(&scene, item, x, y)
        })
        .unwrap_or(&scene.items[scene.root]);
    let inverse = parent
        .world
        .inverse()
        .ok_or_else(|| EngineError::invalid("Placement parent transform is singular"))?;
    let (x, y) = inverse.point(x, y);
    let definition = snapshot
        .nodes
        .get(component)
        .filter(|node| node.kind == NodeKind::Component)
        .ok_or_else(|| EngineError::invalid("Linked component is missing"))?;
    let (width, height) = scene
        .item(component)
        .filter(|item| item.width > 0. && item.height > 0.)
        .map_or_else(
            || {
                (
                    definition.number("width", 0.),
                    definition.number("height", 0.),
                )
            },
            |item| (item.width, item.height),
        );
    let siblings = children(snapshot, &parent.id);
    let horizontal = !matches!(
        parent.style.get("flex-direction"),
        Some("column" | "column-reverse")
    );
    let at = if matches!(parent.style.get("display"), Some("flex" | "grid")) {
        siblings
            .iter()
            .position(|node| {
                scene.item(&node.id).is_some_and(|item| {
                    let (center_x, center_y) = item.local.point(item.width / 2., item.height / 2.);
                    if horizontal {
                        x < center_x
                    } else {
                        y < center_y
                    }
                })
            })
            .unwrap_or(siblings.len())
    } else {
        siblings.len()
    };
    let mut instance = Node::new(NodeKind::Instance);
    instance.parent_id = Some(parent.id.clone());
    instance.home_shard = snapshot.nodes[&parent.id].home_shard.clone();
    instance.rank = rank_between(
        at.checked_sub(1)
            .and_then(|index| siblings.get(index))
            .map(|node| node.rank.as_str()),
        siblings.get(at).map(|node| node.rank.as_str()),
    )
    .ok_or_else(|| EngineError::new("resource_limit", "Layer ordering requires rebalance"))?;
    instance.properties = properties(&json!({
        "name":definition.string("name").unwrap_or("Component"),"componentId":component,
        "x":x-width/2.,"y":y-height/2.,
    }))?;
    if let Some(library) = library.or_else(|| definition.string("libraryId")) {
        instance
            .properties
            .insert("libraryId".into(), json!(library));
    }
    Ok(instance)
}
