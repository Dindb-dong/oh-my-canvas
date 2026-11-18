use super::*;
use omc_scene::measurement::{between, edges};

const TREE_LIMIT: usize = 400;

pub(super) fn order_documents(docs: &mut [Value], sort: Option<&str>) {
    let sort = sort.unwrap_or("recent");
    docs.sort_by(|a, b| {
        let order = match sort {
            "oldest" => a["updatedAtMs"].as_i64().cmp(&b["updatedAtMs"].as_i64()),
            "recent" => b["updatedAtMs"].as_i64().cmp(&a["updatedAtMs"].as_i64()),
            _ => {
                let a = a["title"].as_str().unwrap_or_default();
                let b = b["title"].as_str().unwrap_or_default();
                a.to_lowercase()
                    .cmp(&b.to_lowercase())
                    .then_with(|| a.cmp(b))
            }
        };
        order.then_with(|| a["id"].as_str().cmp(&b["id"].as_str()))
    });
}

impl ToolRouter {
    pub(super) fn measure_layers(
        &self,
        session: &str,
        document: &str,
        args: &Value,
    ) -> Result<Value> {
        let from = self.resolve(session, document, string(args, "from")?)?;
        let to = self.resolve(session, document, string(args, "to")?)?;
        let state = self.state(session, document)?;
        let snapshot = self.workspace.snapshot(document)?;
        let scene = paths::scene(&snapshot, &state.page_id)?;
        let bounds = |id| {
            scene
                .bounds(id)
                .ok_or_else(|| EngineError::invalid("layer is not on the selected page"))
        };
        let from_bounds = bounds(&from)?;
        let to_bounds = bounds(&to)?;
        let segments: Vec<_> = between(edges(from_bounds), edges(to_bounds))
            .into_iter()
            .map(|line| {
                json!({
                    "start": {"x": line.x0, "y": line.y0},
                    "end": {"x": line.x1, "y": line.y1},
                    "distance": if line.dashed { None } else {
                        Some((line.x1 - line.x0).hypot(line.y1 - line.y0))
                    },
                    "dashed": line.dashed,
                })
            })
            .collect();
        let layer = |raw_id: String, [x, y, width, height]: [f64; 4]| json!({"rawId":raw_id,"bounds":{"x":x,"y":y,"width":width,"height":height}});
        Ok(json!({
            "ok": true,
            "coordinateSpace": "world",
            "unit": "px",
            "pageId": state.page_id,
            "revision": {"epoch": snapshot.epoch, "sequence": snapshot.sequence.to_string()},
            "from": layer(from, from_bounds),
            "to": layer(to, to_bounds),
            "segments": segments,
        }))
    }

    pub(super) fn legacy_stdio_connection(&self) -> Result<Value> {
        let executable = std::env::current_exe()
            .map_err(resources::io_error)?
            .with_file_name(if cfg!(windows) {
                "omc-cli.exe"
            } else {
                "omc-cli"
            });
        if !executable.is_file() {
            return Ok(json!({"ok":true,"transport":"stdio","available":false,
                "error":"The native MCP CLI is missing from this build.","config":""}));
        }
        let profile = std::path::absolute(&self.workspace.profile).map_err(resources::io_error)?;
        let command = executable
            .to_str()
            .ok_or_else(|| EngineError::invalid("MCP executable path must be Unicode"))?;
        let profile = profile
            .to_str()
            .ok_or_else(|| EngineError::invalid("MCP profile path must be Unicode"))?;
        let config = serde_json::to_string_pretty(&json!({"mcpServers":{"oh-my-canvas":{
            "command":command,"args":["--profile",profile],
        }}}))
        .map_err(|error| EngineError::invalid(error.to_string()))?;
        Ok(
            json!({"ok":true,"transport":"stdio","available":true,"scope":"loopback","authenticated":true,"config":config}),
        )
    }

    pub(super) fn legacy_tree(
        &self,
        session: &str,
        snapshot: &DocumentSnapshot,
        args: &Value,
    ) -> Result<Value> {
        let state = self.state(session, &snapshot.id)?;
        let root = args["id"]
            .as_str()
            .map(|id| self.resolve(session, &snapshot.id, id))
            .transpose()?
            .unwrap_or_else(|| state.root.clone());
        if !snapshot.nodes.contains_key(&root) || !is_descendant(snapshot, &root, &state.root) {
            return Err(EngineError::invalid("Layer is outside the selected page"));
        }
        let mut traversal = Tree {
            router: self,
            session,
            snapshot,
            max_depth: args["depth"].as_u64().unwrap_or(4) as usize,
            detailed: args["detail"] == "detailed",
            flat: Vec::new(),
            truncated: false,
        };
        let tree = traversal.walk(&root, 0);
        let mut result = json!({"ok":true,"revision":snapshot.sequence,"tree":tree,
            "nodes":traversal.flat,"count":traversal.flat.len(),"truncated":traversal.truncated});
        if traversal.detailed {
            let scene = paths::scene(snapshot, &state.page_id)?;
            let mut pending = vec![root];
            let mut diagnostics = Vec::new();
            for _ in 0..TREE_LIMIT {
                let Some(id) = pending.pop() else { break };
                pending.extend(
                    children(snapshot, &id)
                        .into_iter()
                        .rev()
                        .map(|node| node.id.clone()),
                );
                let Some(item) = scene.item(&id) else {
                    continue;
                };
                let [x, y, width, height] = item.bounds;
                let clipped = item.text.as_ref().is_some_and(|text| {
                    text.truncated
                        || text.width > item.width + 0.5
                        || text.height > item.height + 0.5
                });
                let overflow = item
                    .parent
                    .filter(|&parent| parent != scene.root)
                    .is_some_and(|parent| {
                        let [px, py, pw, ph] = scene.items[parent].bounds;
                        x < px || y < py || x + width > px + pw || y + height > py + ph
                    });
                diagnostics.push(json!({"id":self.alias(session,&snapshot.id,&id),
                    "bounds":{"x":x,"y":y,"width":width,"height":height},
                    "clippedText":clipped,"overflowParent":overflow,
                    "diagnostics":scene.diagnostics.iter().filter(|entry| entry.node_id.as_deref()==Some(&id)).collect::<Vec<_>>()}));
            }
            result["diagnostics"] = json!(diagnostics);
        }
        Ok(result)
    }
}

struct Tree<'a> {
    router: &'a ToolRouter,
    session: &'a str,
    snapshot: &'a DocumentSnapshot,
    max_depth: usize,
    detailed: bool,
    flat: Vec<Value>,
    truncated: bool,
}

impl Tree<'_> {
    fn walk(&mut self, id: &str, depth: usize) -> Option<Value> {
        if self.flat.len() >= TREE_LIMIT {
            self.truncated = true;
            return None;
        }
        let node = self.snapshot.nodes.get(id)?;
        let children = children(self.snapshot, id);
        let mut row = self
            .router
            .describe(self.session, &self.snapshot.id, node, self.detailed);
        if let Some(reference) = node.string("dataRef").or_else(|| node.string("data-ref")) {
            row["ref"] = json!(reference);
        }
        if self.detailed {
            for key in ["hidden", "locked"] {
                row[key] = json!(
                    node.properties
                        .get(key)
                        .and_then(Value::as_bool)
                        .unwrap_or(false)
                );
            }
            for key in ["layout", "fills"] {
                if let Some(value) = node.properties.get(key) {
                    row[key] = value.clone();
                }
            }
        }
        if !children.is_empty() {
            row["childCount"] = json!(children.len());
            if depth >= self.max_depth {
                row["collapsed"] = true.into();
            }
        }
        let mut flat = row.clone();
        flat["depth"] = json!(depth);
        self.flat.push(flat);
        if !children.is_empty() && depth < self.max_depth {
            row["children"] = json!(
                children
                    .into_iter()
                    .filter_map(|child| self.walk(&child.id, depth + 1))
                    .collect::<Vec<_>>()
            );
        }
        Some(row)
    }
}

fn is_descendant(snapshot: &DocumentSnapshot, node: &str, root: &str) -> bool {
    let mut current = Some(node);
    while let Some(id) = current {
        if id == root {
            return true;
        }
        current = snapshot
            .nodes
            .get(id)
            .and_then(|node| node.parent_id.as_deref());
    }
    false
}

pub(super) fn filtered_styles(
    style: &omc_style::ComputedStyle,
    node: Option<&Node>,
    keys: Option<&[Value]>,
) -> (BTreeMap<String, String>, BTreeMap<String, String>) {
    const DEFAULT: &[&str] = &[
        "fill",
        "stroke",
        "opacity",
        "font-family",
        "font-size",
        "font-weight",
        "font-style",
        "line-height",
        "letter-spacing",
        "color",
        "mix-blend-mode",
    ];
    let requested = keys
        .map(|keys| keys.iter().filter_map(Value::as_str).collect::<Vec<_>>())
        .unwrap_or_else(|| DEFAULT.to_vec());
    let compatibility = requested
        .iter()
        .map(|&key| (key.to_owned(), legacy_style_value(style, node, key)))
        .collect();
    let native = if keys.is_some() {
        requested
            .into_iter()
            .map(|key| (key.to_owned(), style.get(key).unwrap_or("").to_owned()))
            .collect()
    } else {
        style.values.clone()
    };
    (compatibility, native)
}

fn legacy_style_value(style: &omc_style::ComputedStyle, node: Option<&Node>, key: &str) -> String {
    let value = style.get(key).unwrap_or("");
    match key {
        "width" | "height" | "font-size" | "letter-spacing" if value.parse::<f64>().is_ok() => {
            format!("{value}px")
        }
        "left" | "top" => {
            let property = if key == "left" { "x" } else { "y" };
            node.and_then(|node| node.properties.get(property))
                .and_then(Value::as_f64)
                .map_or_else(|| value.to_owned(), |number| format!("{number}px"))
        }
        "background-color" => node
            .and_then(|node| node.properties.get("fills"))
            .and_then(|fills| fills[0]["color"].as_str())
            .unwrap_or(value)
            .to_owned(),
        _ => value.to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn measures_world_gaps_and_container_margins_within_the_requested_page() {
        let directory = tempfile::tempdir().unwrap();
        let workspace = Workspace::open(directory.path(), None).unwrap();
        let registration = workspace.session_open(None).unwrap();
        let session = registration["sessionId"].as_str().unwrap();
        let router = Arc::new(ToolRouter::new(workspace));
        let call = |name, args| router.call(session, name, args, Value::Null).unwrap();
        let doc = call("create_document", json!({"title":"Measurement fixture"}));
        let id = doc["documentId"].as_str().unwrap();
        let native = native_id(id).unwrap();
        let frame = call(
            "create_shape",
            json!({"documentId":id,"type":"frame","x":200,"y":100,"width":100,"height":100}),
        );
        let frame = &frame["rawIds"][0];
        let left = call(
            "create_shape",
            json!({"documentId":id,"type":"rect","parentId":frame,"x":10,"y":12,"width":20,"height":30}),
        );
        let right = call(
            "create_shape",
            json!({"documentId":id,"type":"rect","parentId":frame,"x":50,"y":12,"width":30,"height":30}),
        );
        let left = &left["rawIds"][0];
        let right = &right["rawIds"][0];
        let measure =
            |from, to| router.measure_layers(session, &native, &json!({"from":from,"to":to}));
        let gap = measure(left, right).unwrap();
        assert_eq!(
            gap["from"]["bounds"],
            json!({"x":210.,"y":112.,"width":20.,"height":30.})
        );
        assert_eq!(
            gap["to"]["bounds"],
            json!({"x":250.,"y":112.,"width":30.,"height":30.})
        );
        assert_eq!(gap["coordinateSpace"], "world");
        assert_eq!(gap["unit"], "px");
        assert_eq!(gap["segments"][0]["distance"], 20.);
        let margins = measure(left, frame).unwrap();
        let distances: Vec<_> = margins["segments"]
            .as_array()
            .unwrap()
            .iter()
            .map(|segment| segment["distance"].as_f64().unwrap())
            .collect();
        assert_eq!(distances, [10., 70., 12., 58.]);
        assert_eq!(margins["revision"], gap["revision"]);

        let separate = call("create_document", json!({"title":"Unrelated document"}));
        let outside = call(
            "create_shape",
            json!({"documentId":separate["documentId"],"type":"rect","width":30,"height":30}),
        );
        assert!(measure(left, &outside["rawIds"][0]).is_err());
    }
}
