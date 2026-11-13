use super::*;

const ANNOTATIONS: &str = "annotations";
const CATEGORIES: &str = "annotationCategories";
const RESOURCES: &str = "devResources";
const COLORS: [&str; 8] = [
    "#2F6FEB", "#8A4FE0", "#1E9E6A", "#D97A06", "#D63A3A", "#D13F9B", "#1192A8", "#6B7280",
];
const PINS: &[(&str, &str, &str)] = &[
    ("width", "Width", "width"),
    ("height", "Height", "height"),
    ("top", "Top", "y"),
    ("left", "Left", "x"),
    ("rotation", "Rotation", "rotation"),
    ("opacity", "Opacity", "opacity"),
    ("cornerRadius", "Corner radius", "radius"),
    ("direction", "Direction", "layout.direction"),
    ("gap", "Gap", "layout.gap"),
    ("padding", "Padding", "layout.padding"),
    ("alignment", "Alignment", "layout.align"),
    ("fontFamily", "Font", "fontFamily"),
    ("fontStyle", "Font style", "fontStyle"),
    ("fontSize", "Font size", "fontSize"),
    ("lineHeight", "Line height", "lineHeight"),
    ("letterSpacing", "Letter spacing", "letterSpacing"),
    ("textAlign", "Text align", "textAlign"),
    ("fill", "Fill", "fills"),
    ("stroke", "Stroke", "strokes"),
    ("strokeWeight", "Stroke weight", "strokeWidth"),
    ("effects", "Effects", "effects"),
];

fn categories(snapshot: &DocumentSnapshot) -> Vec<Value> {
    snapshot
        .metadata
        .get(CATEGORIES)
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_else(|| {
            [
                ("development", "Development"),
                ("interaction", "Interaction"),
                ("accessibility", "Accessibility"),
                ("content", "Content"),
            ]
            .into_iter()
            .zip(COLORS)
            .map(|((id, name), color)| json!({"id":id,"name":name,"color":color}))
            .collect()
        })
}

fn category_index(categories: &[Value], value: &Value) -> Result<usize> {
    let key = value
        .as_str()
        .ok_or_else(|| EngineError::invalid("Expected a category ID or name"))?
        .trim();
    categories
        .iter()
        .position(|entry| entry["id"] == key)
        .or_else(|| {
            categories.iter().position(|entry| {
                entry["name"]
                    .as_str()
                    .is_some_and(|name| name.eq_ignore_ascii_case(key))
            })
        })
        .ok_or_else(|| EngineError::invalid("Annotation category does not exist"))
}

fn label(value: &Value, limit: usize) -> Result<String> {
    value
        .as_str()
        .map(|s| s.trim().chars().take(limit).collect())
        .ok_or_else(|| EngineError::invalid("Expected a text value"))
}

fn color(value: &Value) -> Result<String> {
    let color = label(value, 32)?;
    let hex = color.strip_prefix('#').unwrap_or(&color);
    if !matches!(hex.len(), 3 | 4 | 6 | 8) || !hex.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(EngineError::invalid("Expected a hex color"));
    }
    let digits = if hex.len() < 5 {
        hex.chars().flat_map(|ch| [ch, ch]).collect::<String>()
    } else {
        hex.to_owned()
    };
    Ok(format!("#{}", digits.to_uppercase()))
}

fn pins(value: &Value) -> Result<Vec<Value>> {
    let entries = value
        .as_array()
        .filter(|list| list.len() <= 84)
        .ok_or_else(|| EngineError::invalid("Expected an array of annotation properties"))?;
    let mut seen = BTreeSet::new();
    let mut output = Vec::new();
    for entry in entries {
        let name = label(entry, 80)?;
        let (key, _, _) = PINS
            .iter()
            .find(|(key, title, _)| {
                key.eq_ignore_ascii_case(&name) || title.eq_ignore_ascii_case(&name)
            })
            .ok_or_else(|| EngineError::invalid(format!("Unknown annotation property {name}")))?;
        if seen.insert(*key) {
            output.push(json!(key));
        }
    }
    Ok(output)
}

pub(super) fn annotation(context: &Context, action: &str) -> Result<Value> {
    let snapshot = context.snapshot;
    let params = context.params;
    let mut categories = categories(snapshot);
    let counts = || {
        let mut counts = BTreeMap::new();
        for note in snapshot.nodes.values().flat_map(|node| {
            node.properties
                .get(ANNOTATIONS)
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
        }) {
            if let Some(id) = note["category"].as_str() {
                *counts.entry(id.to_owned()).or_insert(0usize) += 1;
            }
        }
        counts
    };
    match action {
        "categories" => {
            let counts = counts();
            for item in &mut categories {
                item["count"] = json!(
                    counts
                        .get(item["id"].as_str().unwrap_or_default())
                        .copied()
                        .unwrap_or(0)
                );
            }
            return Ok(json!({"categories":categories}));
        }
        "addCategory" | "editCategory" | "removeCategory" => {
            let mut edits = Vec::new();
            let mut removed = None;
            let id = if action == "removeCategory" {
                let category = categories.remove(category_index(&categories, &params["id"])?);
                let id = category["id"].as_str().unwrap();
                removed = Some(counts().get(id).copied().unwrap_or(0));
                // An absent category no longer appears in its annotations. The stable IDs are never reused.
                id.to_owned()
            } else {
                let position = if action == "editCategory" {
                    category_index(&categories, &params["id"])?
                } else {
                    if categories.len() >= 64 {
                        return Err(EngineError::new(
                            "resource_limit",
                            "At most 64 annotation categories",
                        ));
                    }
                    let default_color = COLORS
                        .iter()
                        .find(|&&color| !categories.iter().any(|item| item["color"] == color))
                        .unwrap_or(&COLORS[0]);
                    categories.push(json!({"id":uuid::Uuid::new_v4().to_string(),"name":"","color":default_color}));
                    categories.len() - 1
                };
                if let Some(value) = params
                    .get("name")
                    .or_else(|| (action == "addCategory").then_some(&Value::Null))
                {
                    let name = label(value, 64)?;
                    if name.is_empty()
                        || categories.iter().enumerate().any(|(i, item)| {
                            i != position
                                && item["name"]
                                    .as_str()
                                    .is_some_and(|other| other.eq_ignore_ascii_case(&name))
                        })
                    {
                        return Err(EngineError::invalid(
                            "Category names must be nonempty and unique",
                        ));
                    }
                    categories[position]["name"] = json!(name);
                }
                if let Some(value) = params.get("color") {
                    categories[position]["color"] = json!(color(value)?);
                }
                categories[position]["id"].as_str().unwrap().to_owned()
            };
            edits.push(Command::DocumentMetadata {
                properties: Properties::from([(CATEGORIES.into(), json!(categories))]),
            });
            context.commit(edits)?;
            return Ok(removed.map_or_else(
                || json!({"id":id}),
                |uncategorized| json!({"id":id,"uncategorized":uncategorized}),
            ));
        }
        "list" => return annotation_list(context, &categories),
        _ => {}
    }
    let raw = context.one()?;
    let node = &snapshot.nodes[&raw];
    if node.parent_id.is_none() {
        return Err(EngineError::invalid("Select a layer on the page"));
    }
    let mut entries = array(node.properties.get(ANNOTATIONS));
    let mut result = json!({"id":context.alias(&raw)});
    match action {
        "add" | "edit" => {
            let position = if action == "edit" {
                index(params, "index")?
            } else {
                if entries.len() >= 64 {
                    return Err(EngineError::new(
                        "resource_limit",
                        "At most 64 annotations per layer",
                    ));
                }
                entries.push(json!({"label":"","properties":[]}));
                entries.len() - 1
            };
            let note = entries
                .get_mut(position)
                .ok_or_else(|| EngineError::invalid("Annotation index is out of bounds"))?;
            if let Some(value) = params.get("label").or_else(|| params.get("text")) {
                note["label"] = json!(label(value, 5000)?);
            }
            if let Some(value) = params.get("properties") {
                note["properties"] = json!(pins(value)?);
            }
            if let Some(value) = params.get("category") {
                note["category"] = if value.is_null() {
                    Value::Null
                } else {
                    categories[category_index(&categories, value)?]["id"].clone()
                };
            }
            if note["label"].as_str() == Some("")
                && note["properties"].as_array().is_none_or(Vec::is_empty)
            {
                return Err(EngineError::invalid(
                    "An annotation needs text or a pinned property",
                ));
            }
            result["index"] = json!(position);
        }
        "remove" => {
            if params.get("index").is_some() {
                let position = index(params, "index")?;
                if position >= entries.len() {
                    return Err(EngineError::invalid("Annotation index is out of bounds"));
                }
                entries.remove(position);
            } else {
                entries.clear();
            }
        }
        _ => return Err(EngineError::invalid("Unknown annotation action")),
    }
    context.commit(vec![context.patch(&raw, ANNOTATIONS, json!(entries))])?;
    Ok(result)
}

fn annotation_list(context: &Context, categories: &[Value]) -> Result<Value> {
    let params = context.params;
    let snapshot = context.snapshot;
    let targets = if let Some(ids) = params.get("ids") {
        ids.as_array()
            .ok_or_else(|| EngineError::invalid("ids must be an array"))?
            .iter()
            .map(|id| context.resolve(id))
            .collect::<Result<Vec<_>>>()?
    } else if let Some(id) = params.get("id") {
        vec![context.resolve(id)?]
    } else {
        let page = if params["page"] == "all" {
            None
        } else if let Some(id) = params.get("page") {
            let raw = context.resolve(id)?;
            Some(
                snapshot
                    .pages
                    .iter()
                    .find(|page| page.root_node_id == raw)
                    .ok_or_else(|| EngineError::invalid("Expected a page ID"))?
                    .id
                    .as_str(),
            )
        } else {
            Some(context.state.page_id.as_str())
        };
        let mut targets = Vec::new();
        for page in snapshot
            .pages
            .iter()
            .filter(|p| page.is_none_or(|id| p.id == id))
        {
            let mut stack = vec![page.root_node_id.as_str()];
            while let Some(raw) = stack.pop() {
                if snapshot.nodes[raw]
                    .properties
                    .get(ANNOTATIONS)
                    .and_then(Value::as_array)
                    .is_some_and(|values| !values.is_empty())
                {
                    targets.push(raw.to_owned());
                    if targets.len() >= 2000 {
                        break;
                    }
                }
                stack.extend(
                    children(snapshot, raw)
                        .into_iter()
                        .rev()
                        .map(|node| node.id.as_str()),
                );
            }
        }
        targets
    };
    let category_filter = params
        .get("category")
        .map(|value| {
            if value == "none" {
                Ok(Value::Null)
            } else {
                category_index(categories, value).map(|index| categories[index]["id"].clone())
            }
        })
        .transpose()?;
    let mut scenes = BTreeMap::new();
    let mut notes = Vec::new();
    for id in targets.into_iter().take(2000) {
        let node = &snapshot.nodes[&id];
        let Some(entries) = node.properties.get(ANNOTATIONS).and_then(Value::as_array) else {
            continue;
        };
        let Some(page) = context.page(&id) else {
            continue;
        };
        if !scenes.contains_key(&page.id) {
            scenes.insert(page.id.clone(), paths::scene(snapshot, &page.id)?);
        }
        let authored = scenes[&page.id]
            .item(&id)
            .map_or(&node.properties, |item| &item.properties);
        for (index, note) in entries.iter().enumerate() {
            let category = categories
                .iter()
                .find(|category| category["id"] == note["category"]);
            if category_filter.as_ref().is_some_and(|filter| {
                category.map_or(&Value::Null, |category| &category["id"]) != filter
            }) {
                continue;
            }
            let props: Vec<_> = note["properties"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|name| {
                    let (key, label, field) = PINS.iter().find(|(key, _, _)| name == key)?;
                    let value = if let Some((parent, field)) = field.split_once('.') {
                        authored.get(parent).and_then(|value| value.get(field))
                    } else {
                        authored.get(*field)
                    };
                    let mut pin = json!({"property":key,"label":label,"value":value});
                    if let Some(color) = value
                        .and_then(|value| value.get(0))
                        .and_then(|value| value.get("color"))
                    {
                        pin["color"] = color.clone();
                    }
                    Some(pin)
                })
                .collect();
            let mut value = json!({"id":context.alias(&id),"name":node.string("name").unwrap_or_default(),"index":index,"label":note["label"],"properties":props});
            if let Some(category) = category {
                value["category"] = category.clone();
            }
            notes.push(value);
        }
    }
    Ok(json!({"annotations":notes}))
}

fn resource_url(value: &Value) -> Result<String> {
    let url = value
        .as_str()
        .ok_or_else(|| EngineError::invalid("A resource requires a URL"))?
        .trim();
    let valid = url.len() <= 2048
        && !url.chars().any(|c| c.is_whitespace() || c.is_control())
        && url.split_once("://").is_some_and(|(scheme, rest)| {
            (scheme.eq_ignore_ascii_case("http") || scheme.eq_ignore_ascii_case("https"))
                && rest.split(['/', '?', '#']).next().is_some_and(|host| {
                    !host.is_empty() && !host.starts_with(':') && !host.contains(['@', '\\'])
                })
        });
    if !valid {
        return Err(EngineError::invalid(
            "Expected an HTTP or HTTPS URL with a host",
        ));
    }
    Ok(url.to_owned())
}

pub(super) fn dev_resource(context: &Context, action: &str) -> Result<Value> {
    let params = context.params;
    let raw = context.one()?;
    let node = &context.snapshot.nodes[&raw];
    if node.parent_id.is_none() {
        return Err(EngineError::invalid("Pages cannot have dev resources"));
    }
    let mut links = array(node.properties.get(RESOURCES));
    if action == "list" {
        for (index, link) in links.iter_mut().enumerate() {
            link["index"] = json!(index);
        }
        if let Some(main) = node
            .string("componentId")
            .and_then(|id| context.snapshot.nodes.get(id))
        {
            let set = main
                .string("variantSetId")
                .and_then(|id| context.snapshot.nodes.get(id));
            for origin in std::iter::once(main).chain(set) {
                let from = context.alias(&origin.id);
                for mut link in array(origin.properties.get(RESOURCES)) {
                    link["from"] = json!(from);
                    links.push(link);
                }
            }
        }
        return Ok(json!(links));
    }
    let output = match action {
        "add" | "edit" => {
            let index = if action == "edit" {
                index(params, "index")?
            } else {
                if links.len() >= 32 {
                    return Err(EngineError::new(
                        "resource_limit",
                        "At most 32 resources per layer",
                    ));
                }
                links.push(json!({}));
                links.len() - 1
            };
            let link = links
                .get_mut(index)
                .ok_or_else(|| EngineError::invalid("Resource index is out of bounds"))?;
            if let Some(url) = params
                .get("url")
                .or_else(|| (action == "add").then_some(&Value::Null))
            {
                link["url"] = json!(resource_url(url)?);
            }
            let name = params
                .get("name")
                .filter(|v| !v.is_null())
                .map(|value| label(value, 200))
                .transpose()?;
            if let Some(name) = name.filter(|name| !name.is_empty()) {
                link["name"] = json!(name);
            } else if action == "add" {
                let url = link["url"].as_str().unwrap();
                let name = url.split_once("://").map_or(url, |(_, rest)| rest);
                let name = name
                    .strip_prefix("www.")
                    .unwrap_or(name)
                    .trim_end_matches('/');
                link["name"] = json!(name.chars().take(200).collect::<String>());
            }
            json!({"id":context.alias(&raw),"index":index})
        }
        "remove" => {
            let removed = if params.get("index").is_some() {
                let position = index(params, "index")?;
                if position >= links.len() {
                    return Err(EngineError::invalid("Resource index is out of bounds"));
                }
                links.remove(position);
                1
            } else {
                let len = links.len();
                links.clear();
                len
            };
            json!({"removed":removed})
        }
        _ => return Err(EngineError::invalid("Unknown resource action")),
    };
    context.commit(vec![context.patch(&raw, RESOURCES, json!(links))])?;
    Ok(output)
}
