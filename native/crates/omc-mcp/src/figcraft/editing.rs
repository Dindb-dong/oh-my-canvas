use super::*;
use omc_model::new_id;
use std::collections::BTreeSet;

pub(super) const COMMANDS: &[(&str, &str, bool, &str)] = &[
    ("edit.duplicate", "Duplicate", true, "ids?, dx?, dy?, map?"),
    ("pref.renameDuplicates", "Rename duplicated layers", false, "on?"),
    ("select.matching", "Select matching layers", false, ""),
    ("select.sameFill", "Select same fill", false, ""),
    ("select.sameStroke", "Select same stroke", false, ""),
    ("select.sameEffect", "Select same effect", false, ""),
    ("select.sameText", "Select same text properties", false, ""),
    ("select.sameFont", "Select same font", false, ""),
    ("select.sameInstance", "Select same instance", false, ""),
    ("select.sameProperties", "Select same properties", false, ""),
    ("object.hideOthers", "Hide other layers", true, ""),
    (
        "edit.findReplace",
        "Find and replace",
        true,
        "find, replace?, layerNames?, select?",
    ),
];

impl ToolRouter {
    pub(super) fn fig_rename_duplicates(&self, params: &Value) -> Result<Value> {
        schema::check(&json!({"type":"object","additionalProperties":false,
            "properties":{"on":{"type":"boolean"}}}), params, "params")?;
        let catalog = self.workspace.catalog.lock().unwrap();
        let mut preferences = catalog.preference()?;
        let current = preferences["renameDuplicates"].as_bool().unwrap_or(false);
        let on = params["on"].as_bool().unwrap_or(!current);
        preferences["renameDuplicates"] = json!(on);
        catalog.set_preference(&preferences)?;
        Ok(json!({"on":on}))
    }

    pub(super) fn fig_editing_command(
        &self,
        session: &str,
        snapshot: &DocumentSnapshot,
        state: &ViewState,
        selection: &[Value],
        name: &str,
        params: &Value,
    ) -> Result<Value> {
        let document = &snapshot.id;
        let key = (session.into(), document.clone());
        let mut nodes = Vec::new();
        let mut pending = vec![state.root.as_str()];
        while let Some(id) = pending.pop() {
            if id != state.root {
                nodes.push(&snapshot.nodes[id]);
            }
            pending.extend(
                children(snapshot, id)
                    .iter()
                    .rev()
                    .map(|node| node.id.as_str()),
            );
        }
        let mut commands = Vec::new();
        let mut result = json!({"ok":true});
        let mut new_selection = None;
        match name {
            name if name.starts_with("select.") => {
                schema::check(
                    &json!({"type":"object","additionalProperties":false}),
                    params,
                    "params",
                )?;
                let found = if let Some(first) = selection.first() {
                    let id = self.fig_layer(session, snapshot, first)?;
                    let first = &snapshot.nodes[&id];
                    nodes
                        .into_iter()
                        .filter(|node| matches_properties(name, first, node))
                        .map(|node| json!(self.fig_alias(session, document, &node.id)))
                        .collect::<Vec<_>>()
                } else {
                    vec![]
                };
                result = json!({"selection":found});
                new_selection = Some(found);
            }
            "edit.duplicate" => {
                schema::check(
                    &json!({"type":"object","additionalProperties":false,
                    "properties":{"ids":{"type":"array","maxItems":200,"items":{"type":"integer","minimum":1}},
                    "dx":{"type":"number"},"dy":{"type":"number"},"map":{"type":"boolean"}}}),
                    params,
                    "params",
                )?;
                let raw = self.fig_layers(session, snapshot, fig_ids(params, selection)?)?;
                let chosen = raw.iter().map(String::as_str).collect::<BTreeSet<_>>();
                let inside = |node: &Node| {
                    let mut ancestor = node.parent_id.as_deref();
                    while let Some(id) = ancestor {
                        if chosen.contains(id) {
                            return true;
                        }
                        ancestor = snapshot.nodes[id].parent_id.as_deref();
                    }
                    false
                };
                let roots = nodes
                    .into_iter()
                    .filter(|node| chosen.contains(node.id.as_str()) && !inside(node))
                    .collect::<Vec<_>>();
                if roots.is_empty() {
                    return Err(EngineError::invalid(
                        "select one or more layers on the current page",
                    ));
                }
                let scene = paths::scene(snapshot, &state.page_id)?;
                let rename = self.workspace.catalog.lock().unwrap().preference()?["renameDuplicates"] == true;
                let previous = &state.view["figDuplicate"];
                let repeated = params.get("dx").is_none()
                    && params.get("dy").is_none()
                    && previous["copies"] == json!(selection)
                    && params.get("ids").is_none();
                let repeat_offset = repeated
                    .then(|| {
                        let origin = |key: &str| -> Option<(f64, f64)> {
                            let ids = self
                                .fig_layers(session, snapshot, previous[key].as_array()?)
                                .ok()?;
                            ids.iter()
                                .filter_map(|id| scene.bounds(id))
                                .map(|[x, y, _, _]| (x, y))
                                .reduce(|(x, y), (a, b)| (x.min(a), y.min(b)))
                        };
                        let (ax, ay) = origin("sources")?;
                        let (bx, by) = origin("copies")?;
                        Some((bx - ax, by - ay))
                    })
                    .flatten();
                let mut all = Vec::new();
                let mut by_root = BTreeMap::new();
                let root_aliases = roots
                    .iter()
                    .map(|node| json!(self.fig_alias(session, document, &node.id)))
                    .collect::<Vec<_>>();
                for root in roots {
                    let mut pending = vec![root];
                    let main = root.kind == NodeKind::Component
                        && !root.properties.contains_key("variantOf")
                        && !root.properties.contains_key("variantSetId");
                    while let Some(node) = pending.pop() {
                        if all.len() >= 100 {
                            return Err(EngineError::new(
                                "resource_limit",
                                "duplicate exceeds 100 layers",
                            ));
                        }
                        by_root.insert(node.id.clone(), (root.id.clone(), main));
                        all.push(node);
                        if !main {
                            pending.extend(children(snapshot, &node.id).into_iter().rev());
                        }
                    }
                }
                let map = all
                    .iter()
                    .map(|node| (node.id.clone(), new_id("node")))
                    .collect::<BTreeMap<_, _>>();
                let mut copies = Vec::new();
                for node in all {
                    let (root, main) = &by_root[&node.id];
                    let mut copy = node.clone();
                    copy.id = map[&node.id].clone();
                    copy.home_shard = new_id("shard");
                    let parent = node
                        .parent_id
                        .as_ref()
                        .ok_or_else(|| EngineError::invalid("cannot duplicate page root"))?;
                    if root == &node.id {
                        let siblings = children(snapshot, parent);
                        let next = siblings
                            .iter()
                            .position(|s| s.id == node.id)
                            .and_then(|i| siblings.get(i + 1));
                        copy.rank = rank_between(Some(&node.rank), next.map(|s| s.rank.as_str()))
                            .ok_or_else(|| {
                            EngineError::new("resource_limit", "sibling rank exhausted")
                        })?;
                        let default = if node.kind == NodeKind::Frame && parent == &state.root {
                            node.number("width", 0.) + 100.
                        } else {
                            0.
                        };
                        let explicit = params.get("dx").is_some() || params.get("dy").is_some();
                        let (dx, dy) = repeat_offset.unwrap_or_else(|| {
                            if explicit {
                                (
                                    params["dx"].as_f64().unwrap_or(0.),
                                    params["dy"].as_f64().unwrap_or(0.),
                                )
                            } else {
                                (default, 0.)
                            }
                        });
                        let inverse = scene
                            .item(parent)
                            .and_then(|item| item.world.inverse())
                            .ok_or_else(|| {
                                EngineError::invalid("parent transform is not invertible")
                            })?;
                        let (x0, y0) = inverse.point(0., 0.);
                        let (x1, y1) = inverse.point(dx, dy);
                        copy.properties
                            .insert("x".into(), json!(node.number("x", 0.) + x1 - x0));
                        copy.properties
                            .insert("y".into(), json!(node.number("y", 0.) + y1 - y0));
                        if *main {
                            copy.kind = NodeKind::Instance;
                            copy.properties.retain(|key, _| {
                                matches!(
                                    key.as_str(),
                                    "x" | "y"
                                        | "name"
                                        | "width"
                                        | "height"
                                        | "transform"
                                        | "rotation"
                                        | "flipX"
                                        | "flipY"
                                )
                            });
                            copy.properties.insert("componentId".into(), json!(node.id));
                        }
                        if rename && copy.kind != NodeKind::Instance {
                            let name = copy.string("name").unwrap_or("Layer");
                            let updated = name.rsplit_once(' ').and_then(|(base, suffix)| {
                                suffix.parse::<u64>().ok()?.checked_add(1).map(|number| format!("{base} {number}"))
                            }).unwrap_or_else(|| format!("{name} 2"));
                            copy.properties.insert("name".into(), json!(updated));
                        }
                        copies.push(json!(self.fig_alias(session, document, &copy.id)));
                    } else {
                        copy.parent_id = Some(map[parent].clone());
                    }
                    remap_values(&mut copy.properties, &map);
                    if *main {
                        copy.properties.insert("componentId".into(), json!(node.id));
                    }
                    commands.push(Command::NodeCreate { node: copy });
                }
                result = json!({"ids":copies});
                if params["map"] == true {
                    result["map"] = Value::Object(
                        map.iter()
                            .map(|(a, b)| {
                                (
                                    self.fig_alias(session, document, a).to_string(),
                                    json!(self.fig_alias(session, document, b)),
                                )
                            })
                            .collect(),
                    );
                }
                self.submit(
                    session,
                    document,
                    Command::Batch {
                        commands: std::mem::take(&mut commands),
                    },
                    &Value::Null,
                    Some(snapshot.sequence),
                )?;
                self.fig_selection(&key, &copies);
                if let Some(state) = self.states.lock().unwrap().get_mut(&key) {
                    state.view["figDuplicate"] = json!({"sources":root_aliases,"copies":copies});
                }
                return Ok(result);
            }
            "object.hideOthers" => {
                schema::check(
                    &json!({"type":"object","additionalProperties":false}),
                    params,
                    "params",
                )?;
                let mut keep = BTreeSet::new();
                for id in self.fig_layers(session, snapshot, selection)? {
                    let mut current = Some(id.as_str());
                    while let Some(id) = current {
                        if !keep.insert(id.to_owned()) {
                            break;
                        }
                        current = snapshot.nodes[id].parent_id.as_deref();
                    }
                }
                for node in children(snapshot, &state.root) {
                    if !keep.contains(&node.id)
                        && node.properties.get("visible") != Some(&json!(false))
                    {
                        commands.push(Command::NodeSet {
                            node_id: node.id.clone(),
                            properties: Properties::from([("visible".into(), json!(false))]),
                        });
                    }
                }
            }
            "edit.findReplace" => {
                schema::check(
                    &json!({"type":"object","additionalProperties":false,"required":["find"],
                    "properties":{"find":{"type":"string","minLength":1,"maxLength":4096},"replace":{"type":"string","maxLength":65536},
                    "layerNames":{"type":"boolean"},"select":{"type":"boolean"}}}),
                    params,
                    "params",
                )?;
                let needle = string(params, "find")?.chars().collect::<Vec<_>>();
                if needle.is_empty() {
                    return Err(EngineError::invalid("find must not be empty"));
                }
                let replace = params["replace"].as_str().map(|text| {
                    text.replace("\r\n", "\n")
                        .replace(['\r', '\u{2028}', '\u{2029}'], "\n")
                });
                let mut matches = Vec::new();
                for node in nodes {
                    let title = node.string("name").unwrap_or("");
                    let title_hits = if params["layerNames"] == true {
                        ranges(title, &needle)
                    } else {
                        Vec::new()
                    };
                    let body = node
                        .string("text")
                        .filter(|_| node.kind == NodeKind::Text)
                        .unwrap_or("");
                    let body_hits = ranges(body, &needle);
                    if title_hits.is_empty() && body_hits.is_empty() {
                        continue;
                    }
                    matches.push(json!(self.fig_alias(session, document, &node.id)));
                    let Some(replace) = &replace else {
                        continue;
                    };
                    if !title_hits.is_empty() {
                        let mut title = title.to_owned();
                        for (start, end) in title_hits.into_iter().rev() {
                            title.replace_range(start..end, replace);
                        }
                        commands.push(Command::NodeSet {
                            node_id: node.id.clone(),
                            properties: Properties::from([("name".into(), json!(title))]),
                        });
                    }
                    if commands.len() + body_hits.len() > 100 {
                        return Err(EngineError::new(
                            "resource_limit",
                            "find and replace exceeds 100 atomic operations",
                        ));
                    }
                    for (start, end) in body_hits.into_iter().rev() {
                        let start = body[..start].encode_utf16().count();
                        let end = body[..end].encode_utf16().count();
                        let range = self.workspace.text_selection(document, json!({"nodeId":node.id,"start":start,"end":end,"revision":snapshot.revision()}))?;
                        let selection = serde_json::from_value(range).map_err(|error| {
                            EngineError::new("internal_error", error.to_string())
                        })?;
                        commands.push(Command::TextSplice {
                            selection,
                            text: replace.clone(),
                            attributes: Properties::new(),
                        });
                    }
                }
                result = json!({"matches":matches});
                if params["select"] != false {
                    new_selection = Some(matches);
                }
            }
            _ => return Err(EngineError::invalid("unknown editing command")),
        }
        if !commands.is_empty() {
            self.submit(
                session,
                document,
                Command::Batch { commands },
                &Value::Null,
                Some(snapshot.sequence),
            )?;
        }
        if let Some(selection) = new_selection {
            self.fig_selection(&key, &selection);
        }
        Ok(result)
    }
}

fn matches_properties(command: &str, a: &Node, b: &Node) -> bool {
    let fields = |keys: &[&str]| {
        keys.iter()
            .all(|key| a.properties.get(*key) == b.properties.get(*key))
    };
    let has = |key: &str| {
        a.properties
            .get(key)
            .is_some_and(|v| v.as_array().is_some_and(|items| !items.is_empty()) || v.is_string())
    };
    let font = ["fontFamily", "fontStyle", "fontWeight", "fontSlant"];
    let fills = ["fill", "fills"];
    let strokes = [
        "stroke",
        "strokes",
        "strokeWidth",
        "strokeAlignment",
        "strokeCap",
        "strokeJoin",
        "strokeDashArray",
        "strokeSides",
    ];
    let text = [
        "fontSize",
        "lineHeight",
        "letterSpacing",
        "paragraphSpacing",
        "textAlign",
        "textDecoration",
        "textCase",
        "fontFeatures",
        "fontVariations",
    ];
    match command {
        "select.matching" => a.kind == b.kind && fields(&["name"]),
        "select.sameFill" => fills.iter().any(|key| has(key)) && fields(&fills),
        "select.sameStroke" => ["stroke", "strokes"].iter().any(|key| has(key)) && fields(&strokes),
        "select.sameEffect" => has("effects") && fields(&["effects"]),
        "select.sameFont" => a.kind == NodeKind::Text && b.kind == NodeKind::Text && fields(&font),
        "select.sameText" => {
            a.kind == NodeKind::Text && b.kind == NodeKind::Text && fields(&font) && fields(&text)
        }
        "select.sameInstance" => {
            a.kind == NodeKind::Instance && b.kind == NodeKind::Instance && fields(&["componentId"])
        }
        "select.sameProperties" => {
            a.kind == b.kind
                && fields(&fills)
                && fields(&strokes)
                && fields(&[
                    "effects",
                    "radius",
                    "radii",
                    "cornerSmoothing",
                    "radiusTopLeft",
                    "radiusTopRight",
                    "radiusBottomLeft",
                    "radiusBottomRight",
                ])
        }
        _ => false,
    }
}

fn ranges(value: &str, needle: &[char]) -> Vec<(usize, usize)> {
    let mut chars = value.char_indices().collect::<Vec<_>>();
    chars.push((value.len(), '\0'));
    let mut result = Vec::new();
    let mut i = 0;
    while i + needle.len() < chars.len() {
        if chars[i..i + needle.len()]
            .iter()
            .zip(needle)
            .all(|((_, a), b)| a == b || a.to_lowercase().eq(b.to_lowercase()))
        {
            result.push((chars[i].0, chars[i + needle.len()].0));
            i += needle.len();
        } else {
            i += 1;
        }
    }
    result
}
