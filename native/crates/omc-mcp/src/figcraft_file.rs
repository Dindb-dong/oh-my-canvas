//! Bounded FigCraft v1 archives for editable basic layers.
use super::*;
use base64::Engine;
use omc_model::{NodeKind, Page};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    io::{Cursor, Read, Write},
    path::Path,
};
use zip::{ZipArchive, ZipWriter, write::SimpleFileOptions};

const MAX_FILE: usize = 16 * 1024 * 1024;
const MAX_NODES: usize = 10_000;

#[derive(Clone)]
pub(super) struct FigFile {
    pub path: String,
    pub digest: Vec<u8>,
    pub revision: u64,
}

impl ToolRouter {
    pub(super) fn fig_open_file(&self, session: &str, params: &Value) -> Result<Value> {
        let path = string(params, "path")?;
        let _file_access = self.fig_file_access.lock().unwrap();
        let source = resources::read_explicit(path, MAX_FILE)?;
        let digest = Sha256::digest(&source).to_vec();
        let existing = self
            .states
            .lock()
            .unwrap()
            .iter()
            .find_map(|((owner, id), state)| {
                let file = state.fig_file.as_ref()?;
                (owner == session && file.path == path).then(|| (id.clone(), file.clone()))
            });
        if let Some((document, file)) = existing {
            let context = self.workspace.context(&document)?;
            if params["reload"] == true && file.digest != digest {
                if context.revision.sequence != file.revision {
                    return Err(EngineError::new("conflict", "document has unsaved changes"));
                }
                return Err(unsupported(
                    "reloading an existing native document from disk",
                ));
            }
            self.workspace.bind(session, &document)?;
            return Ok(
                json!({"document":external_id(&document),"path":path,"stale":file.digest != digest}),
            );
        }
        let extension = extension(path)?;
        let (snapshot, current_page, warnings) = if extension == "figcraft" {
            let (content, index) = decode(&source)?;
            let title = content.title.clone();
            (
                self.workspace.create(session, &title, Some(content))?,
                index,
                json!([]),
            )
        } else {
            let (snapshot, warnings) =
                self.import_bytes_native(session, &extension, &source, None, true)?;
            (snapshot, 0, warnings)
        };
        self.context_from(session, &snapshot)?;
        let mut states = self.states.lock().unwrap();
        let state = states
            .get_mut(&(session.into(), snapshot.id.clone()))
            .unwrap();
        state.fig_file = Some(FigFile {
            path: path.into(),
            digest,
            revision: snapshot.sequence,
        });
        if let Some(page) = snapshot.pages.get(current_page) {
            state.page_id = page.id.clone();
            state.root = page.root_node_id.clone();
        }
        Ok(json!({"document":external_id(&snapshot.id),"path":path,
            "summary":{"name":snapshot.title,"pages":snapshot.pages.len(),"layers":snapshot.nodes.len()-snapshot.pages.len(),"images":0},"warnings":warnings}))
    }

    pub(super) fn fig_save_file(
        &self,
        session: &str,
        snapshot: &DocumentSnapshot,
        state: &ViewState,
        params: &Value,
        save_as: bool,
    ) -> Result<Value> {
        let _file_access = self.fig_file_access.lock().unwrap();
        let state = self
            .state(session, &snapshot.id)
            .unwrap_or_else(|_| state.clone());
        if save_as && params["data"] == true && params.get("path").is_none() {
            let bytes = encode(snapshot, &state.page_id)?;
            return Ok(
                json!({"name":format!("{}.figcraft",snapshot.title),"bytes":bytes.len(),
                "data":base64::engine::general_purpose::STANDARD.encode(bytes)}),
            );
        }
        let path = params["path"]
            .as_str()
            .or_else(|| {
                (!save_as)
                    .then_some(state.fig_file.as_ref())
                    .flatten()
                    .map(|file| file.path.as_str())
            })
            .ok_or_else(|| EngineError::invalid("file has no path; supply a path"))?;
        let path = if Path::new(path).extension().is_none() {
            format!("{path}.figcraft")
        } else {
            path.to_owned()
        };
        let bytes = match extension(&path)?.as_str() {
            "figcraft" => encode(snapshot, &state.page_id)?,
            "omc" => {
                self.export_bytes_native(&snapshot.id, &json!({"format":"omc"}))?
                    .bytes
            }
            other => return Err(unsupported(format!("export to {other}"))),
        };
        let previous = state.fig_file.as_ref().filter(|file| file.path == path);
        let overwrite = params["overwrite"] == true
            || if let Some(file) = previous {
                let disk = resources::read_explicit(&path, MAX_FILE)?;
                if Sha256::digest(&disk).as_slice() != file.digest {
                    return Err(EngineError::new(
                        "conflict",
                        "file changed on disk; use overwrite to replace it",
                    ));
                }
                true
            } else {
                false
            };
        interchange::write_explicit(&path, &bytes, overwrite)?;
        let mut states = self.states.lock().unwrap();
        if let Some(current) = states.get_mut(&(session.into(), snapshot.id.clone())) {
            current.fig_file = Some(FigFile {
                path: path.clone(),
                digest: Sha256::digest(&bytes).to_vec(),
                revision: snapshot.sequence,
            });
        }
        Ok(json!({"path":path,"bytes":bytes.len()}))
    }
}

fn extension(path: &str) -> Result<String> {
    Path::new(path)
        .extension()
        .and_then(|extension| extension.to_str())
        .map(str::to_ascii_lowercase)
        .ok_or_else(|| EngineError::invalid("file extension required"))
}

fn decode(bytes: &[u8]) -> Result<(DocumentContent, usize)> {
    let mut archive = ZipArchive::new(Cursor::new(bytes)).map_err(invalid)?;
    if archive.len() > 3
        || archive
            .file_names()
            .any(|name| !matches!(name, "document.json" | "thumbnail.png"))
    {
        return Err(unsupported(
            "archive entries other than document.json and thumbnail.png",
        ));
    }
    let document = archive.by_name("document.json").map_err(invalid)?;
    if document.size() > MAX_FILE as u64 {
        return Err(invalid("document.json too large"));
    }
    let mut bytes = Vec::new();
    document
        .take(MAX_FILE as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(invalid)?;
    if bytes.len() > MAX_FILE {
        return Err(invalid("document.json too large"));
    }
    let file = omc_protocol::decode_json(&bytes)?;
    if file["format"] != "figcraft" || file["version"] != 1 {
        return Err(invalid("FigCraft v1 document required"));
    }
    if file.as_object().is_none_or(|file| {
        file.keys().any(|key| {
            !matches!(
                key.as_str(),
                "format"
                    | "version"
                    | "imageIndex"
                    | "name"
                    | "pages"
                    | "nodes"
                    | "next_id"
                    | "styles"
                    | "variables"
                    | "current_page"
                    | "document_colors"
                    | "comments"
            )
        })
    }) {
        return Err(unsupported("unrecognized document metadata"));
    }
    for key in ["imageIndex", "comments", "styles", "document_colors"] {
        if file
            .get(key)
            .is_some_and(|value| value.as_array().is_none_or(|values| !values.is_empty()))
        {
            return Err(unsupported(format!("document {key}")));
        }
    }
    for key in ["collections", "variables"] {
        if file["variables"]
            .get(key)
            .is_some_and(|value| value.as_array().is_none_or(|values| !values.is_empty()))
        {
            return Err(unsupported("document variables"));
        }
    }
    let records = file["nodes"]
        .as_object()
        .filter(|nodes| nodes.len() <= MAX_NODES)
        .ok_or_else(|| invalid("invalid or oversized node map"))?;
    let roots = file["pages"]
        .as_array()
        .filter(|pages| !pages.is_empty())
        .ok_or_else(|| invalid("file must have pages"))?;
    let current = roots
        .iter()
        .position(|id| *id == file["current_page"])
        .unwrap_or(0);
    let mut content = DocumentContent {
        title: string(&file, "name")?.into(),
        pages: vec![],
        nodes: BTreeMap::new(),
        metadata: Properties::new(),
    };
    let mut visited = BTreeSet::new();
    let mut pending = vec![];
    let mut add = |data: &Value,
                   parent: Option<(&str, u64)>,
                   index: usize,
                   count: usize|
     -> Result<(u64, String, Vec<Value>, Node)> {
        let number = data
            .as_u64()
            .filter(|number| *number > 0)
            .ok_or_else(|| invalid("invalid node reference"))?;
        if !visited.insert(number) {
            return Err(invalid("duplicate or cyclic node reference"));
        }
        let node = records
            .get(&number.to_string())
            .filter(|node| node["id"] == number)
            .ok_or_else(|| invalid("missing node"))?;
        let kind = string(node, "type")?;
        let mut native = Node::new(match (kind, parent) {
            ("page", None) | ("frame", Some(_)) => NodeKind::Frame,
            ("group", Some(_)) => NodeKind::Group,
            ("rectangle", Some(_)) => NodeKind::Rect,
            ("ellipse", Some(_)) => NodeKind::Ellipse,
            ("text", Some(_)) => NodeKind::Text,
            _ => return Err(unsupported(format!("layer type {kind}"))),
        });
        native.parent_id = parent.map(|(id, _)| id.to_owned());
        if parent.is_some_and(|(_, id)| node["parent"] != id) {
            return Err(invalid("inconsistent node parent"));
        }
        native.rank = format!(
            "{:032x}",
            u128::MAX / (count as u128 + 1) * (index as u128 + 1)
        );
        native.properties = read_properties(node, kind)?;
        let id = native.id.clone();
        let children = node
            .get("children")
            .map(|value| {
                value
                    .as_array()
                    .cloned()
                    .ok_or_else(|| invalid("invalid children"))
            })
            .transpose()?
            .unwrap_or_default();
        Ok((number, id, children, native))
    };
    for (index, root) in roots.iter().enumerate() {
        let (number, id, children, node) = add(root, None, index, roots.len())?;
        let mut page = Page::new(node.string("name").unwrap_or("Page"), &id);
        page.rank.clone_from(&node.rank);
        content.pages.push(page);
        content.nodes.insert(id.clone(), node);
        pending.push((number, id, children));
    }
    while let Some((parent_number, parent_id, children)) = pending.pop() {
        for (index, child) in children.iter().enumerate() {
            let (number, id, nested, node) = add(
                child,
                Some((&parent_id, parent_number)),
                index,
                children.len(),
            )?;
            content.nodes.insert(id.clone(), node);
            pending.push((number, id, nested));
        }
    }
    if visited.len() != records.len() {
        return Err(invalid("file contains detached nodes"));
    }
    content.validate().map_err(invalid)?;
    Ok((content, current))
}

fn read_properties(node: &Value, kind: &str) -> Result<Properties> {
    let mut out = Properties::from([("name".into(), node["name"].clone())]);
    if kind == "page" {
        for key in ["flows", "guides", "layoutGrids"] {
            if node
                .get(key)
                .is_some_and(|value| value.as_array().is_none_or(|items| !items.is_empty()))
            {
                return Err(unsupported(format!("page {key}")));
            }
        }
        if let Some(background) = node.get("background") {
            out.insert("fill".into(), json!(read_color(background)?));
        }
        return Ok(out);
    }
    for key in node
        .as_object()
        .ok_or_else(|| invalid("node must be an object"))?
        .keys()
    {
        if !matches!(
            key.as_str(),
            "id" | "name"
                | "type"
                | "parent"
                | "children"
                | "blend"
                | "transform"
                | "width"
                | "height"
                | "fills"
                | "clip"
                | "characters"
                | "style"
                | "child_layout"
                | "start"
                | "sweep"
                | "inner"
                | "opacity"
                | "visible"
                | "locked"
        ) {
            return Err(unsupported(format!("layer property {key}")));
        }
    }
    if node.get("blend").is_some_and(|blend| blend != "normal")
        || kind == "ellipse"
            && (node["inner"].as_f64().unwrap_or(0.) != 0.
                || node["start"].as_f64().unwrap_or(0.) != 0.
                || (node["sweep"].as_f64().unwrap_or(std::f64::consts::TAU)
                    - std::f64::consts::TAU)
                    .abs()
                    > 1e-6)
    {
        return Err(unsupported("non-default blending or partial ellipse"));
    }
    if let Some(matrix) = node.get("transform") {
        let matrix = matrix
            .as_array()
            .filter(|matrix| matrix.len() == 6 && matrix.iter().all(Value::is_number))
            .ok_or_else(|| invalid("invalid layer transform"))?;
        let m = matrix
            .iter()
            .map(|value| value.as_f64().unwrap())
            .collect::<Vec<_>>();
        out.insert("x".into(), json!(m[4]));
        out.insert("y".into(), json!(m[5]));
        if m[..4] != [1., 0., 0., 1.] {
            out.insert("transform".into(), json!([m[0], m[2], m[1], m[3], 0., 0.]));
        }
    }
    for (source, destination) in [
        ("width", "width"),
        ("height", "height"),
        ("opacity", "opacity"),
        ("visible", "visible"),
        ("locked", "locked"),
        ("clip", "clipContent"),
    ] {
        if let Some(value) = node.get(source) {
            out.insert(destination.into(), value.clone());
        }
    }
    if let Some(fills) = node.get("fills") {
        let fills = fills
            .as_array()
            .ok_or_else(|| invalid("fills must be an array"))?;
        if fills.len() > 1 {
            return Err(unsupported("multiple paints"));
        }
        if let Some(fill) = fills.first() {
            if fill["type"] != "solid"
                || fill.get("blend").is_some_and(|blend| blend != "normal")
                || fill["visible"] == false
                || fill["opacity"].as_f64().unwrap_or(1.) != 1.
            {
                return Err(unsupported("non-default solid paint"));
            }
            out.insert("fill".into(), json!(read_color(&fill["color"])?));
        } else {
            out.insert("fill".into(), json!("transparent"));
        }
    }
    if let Some(layout) = node.get("child_layout") {
        let sizing = |axis: &str| layout[axis].as_str().unwrap_or("fixed");
        if kind != "text"
            || layout["absolute"] == true
            || layout.as_object().is_none_or(|layout| {
                layout.iter().any(|(key, value)| {
                    !matches!(key.as_str(), "sizing_h" | "sizing_v" | "absolute")
                        && !value.is_null()
                        && value.as_u64() != Some(0)
                })
            })
            || ["sizing_h", "sizing_v"]
                .iter()
                .any(|axis| !matches!(sizing(axis), "fixed" | "hug"))
        {
            return Err(unsupported("child layout options"));
        }
        if sizing("sizing_h") == "hug" {
            out.remove("width");
        }
        if sizing("sizing_v") == "hug" {
            out.remove("height");
        }
    }
    if kind == "text" {
        let style = &node["style"];
        if style["font_style"] != "Regular"
            || style["line_height"]["unit"] != "auto"
            || style["letter_spacing"]["value"].as_f64() != Some(0.)
            || style["decoration"] != "none"
            || style["case"] != "original"
            || !style["fills"].is_null()
            || !style["link"].is_null()
        {
            return Err(unsupported("non-default text style"));
        }
        for (source, destination) in [("font_family", "fontFamily"), ("font_size", "fontSize")] {
            out.insert(destination.into(), style[source].clone());
        }
        out.insert("text".into(), node["characters"].clone());
    }
    Ok(out)
}

fn read_color(color: &Value) -> Result<String> {
    let mut result = String::from("#");
    for key in ["r", "g", "b", "a"] {
        let n = color[key]
            .as_f64()
            .filter(|n| (0. ..=1.).contains(n))
            .ok_or_else(|| invalid("invalid color channel"))?;
        if key != "a" || n < 1. {
            use std::fmt::Write;
            write!(result, "{:02X}", (n * 255.).round() as u8).unwrap();
        }
    }
    Ok(result)
}

fn encode(snapshot: &DocumentSnapshot, page: &str) -> Result<Vec<u8>> {
    if !snapshot.metadata.is_empty() {
        return Err(unsupported("document-level styles, comments or metadata"));
    }
    if snapshot.nodes.len() > MAX_NODES {
        return Err(invalid("document exceeds the archive node limit"));
    }
    let mut ids = BTreeMap::new();
    let mut pending = snapshot
        .pages
        .iter()
        .map(|page| page.root_node_id.clone())
        .rev()
        .collect::<Vec<_>>();
    let mut child_ids: BTreeMap<&str, Vec<&Node>> = BTreeMap::new();
    for node in snapshot.nodes.values() {
        if let Some(parent) = &node.parent_id {
            child_ids.entry(parent).or_default().push(node);
        }
    }
    for nodes in child_ids.values_mut() {
        nodes.sort_by(|a, b| a.rank.cmp(&b.rank).then(a.id.cmp(&b.id)));
    }
    while let Some(raw) = pending.pop() {
        let number = ids.len() + 1;
        pending.extend(
            child_ids
                .get(raw.as_str())
                .into_iter()
                .flatten()
                .rev()
                .map(|node| node.id.clone()),
        );
        ids.insert(raw, number);
    }
    let mut nodes = serde_json::Map::new();
    let pages = snapshot
        .pages
        .iter()
        .map(|page| ids[&page.root_node_id])
        .collect::<Vec<_>>();
    let mut current = pages[0];
    for entry in &snapshot.pages {
        if entry.id == page {
            current = ids[&entry.root_node_id];
        }
    }
    for (raw, node) in &snapshot.nodes {
        let id = ids[raw];
        let children = child_ids
            .get(raw.as_str())
            .into_iter()
            .flatten()
            .map(|node| ids[&node.id])
            .collect::<Vec<_>>();
        let record = if node.parent_id.is_none() {
            if node
                .properties
                .keys()
                .any(|key| !matches!(key.as_str(), "name" | "fill"))
            {
                return Err(unsupported("page properties"));
            }
            let page = snapshot
                .pages
                .iter()
                .find(|page| page.root_node_id == *raw)
                .unwrap();
            json!({"id":id,"name":page.title,"type":"page","background":encode_color(node.string("fill").unwrap_or("#F5F5F5"))?,
                "flows":[],"prototype":{"device":"None","background":{"r":0.118,"g":0.118,"b":0.118,"a":1},"rotation":"portrait"},"children":children,"width":0,"height":0})
        } else {
            let mut record = write_properties(node, id)?;
            record["parent"] = json!(ids[node.parent_id.as_ref().unwrap()]);
            if !children.is_empty() {
                record["children"] = json!(children);
            }
            record
        };
        nodes.insert(id.to_string(), record);
    }
    let document=serde_json::to_vec(&json!({"format":"figcraft","version":1,"imageIndex":[],"name":snapshot.title,"pages":pages,
        "nodes":nodes,"next_id":nodes.len()+1,"styles":[],"variables":{"collections":[],"variables":[]},"current_page":current,"document_colors":[],"comments":[]})).map_err(invalid)?;
    if document.len() > MAX_FILE {
        return Err(invalid("document.json too large"));
    }
    let mut archive = ZipWriter::new(Cursor::new(Vec::new()));
    archive
        .start_file(
            "document.json",
            SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated),
        )
        .map_err(invalid)?;
    archive.write_all(&document).map_err(invalid)?;
    Ok(archive.finish().map_err(invalid)?.into_inner())
}

fn write_properties(node: &Node, id: usize) -> Result<Value> {
    let kind = match node.kind {
        NodeKind::Frame => "frame",
        NodeKind::Group => "group",
        NodeKind::Rect => "rectangle",
        NodeKind::Ellipse => "ellipse",
        NodeKind::Text => "text",
        kind => return Err(unsupported(format!("export layer {kind:?}"))),
    };
    for key in node.properties.keys() {
        if !matches!(
            key.as_str(),
            "name"
                | "x"
                | "y"
                | "width"
                | "height"
                | "fontSize"
                | "fontFamily"
                | "fontWeight"
                | "clipContent"
                | "opacity"
                | "visible"
                | "locked"
                | "text"
                | "textRuns"
                | "fill"
                | "transform"
        ) {
            return Err(unsupported(format!("export layer property {key}")));
        }
    }
    let (x, y) = (node.number("x", 0.), node.number("y", 0.));
    let matrix = if let Some(transform) = node.properties.get("transform") {
        let m = transform
            .as_array()
            .filter(|m| m.len() == 6 && m.iter().all(Value::is_number))
            .ok_or_else(|| invalid("invalid transform"))?;
        [
            m[0].as_f64().unwrap(),
            m[2].as_f64().unwrap(),
            m[1].as_f64().unwrap(),
            m[3].as_f64().unwrap(),
            m[4].as_f64().unwrap() + x,
            m[5].as_f64().unwrap() + y,
        ]
    } else {
        [1., 0., 0., 1., x, y]
    };
    let fills = if let Some(color) = node
        .string("fill")
        .filter(|color| *color != "transparent" && *color != "none")
    {
        vec![
            json!({"type":"solid","color":encode_color(color)?,"opacity":1,"visible":true,"blend":"normal"}),
        ]
    } else {
        vec![]
    };
    let mut record = json!({"id":id,"name":node.string("name").unwrap_or("Layer"),"type":kind,
        "transform":matrix,"width":node.number("width",0.),"height":node.number("height",0.),"fills":fills,"blend":"normal"});
    for key in ["opacity", "visible", "locked"] {
        if let Some(value) = node.properties.get(key) {
            record[key] = value.clone();
        }
    }
    if kind == "frame" {
        record["clip"] = node
            .properties
            .get("clipContent")
            .cloned()
            .unwrap_or(false.into());
    } else if kind == "text" {
        if node
            .properties
            .get("textRuns")
            .and_then(Value::as_array)
            .is_some_and(|runs| {
                runs.iter().any(|run| {
                    run["attributes"]
                        .as_object()
                        .is_some_and(|attributes| !attributes.is_empty())
                })
            })
            || node
                .properties
                .get("fontWeight")
                .is_some_and(|weight| weight != 400 && weight != "400" && weight != "normal")
        {
            return Err(unsupported("styled text runs"));
        }
        record["characters"] = json!(node.string("text").unwrap_or(""));
        let sizing = |axis| {
            if node.properties.contains_key(axis) {
                "fixed"
            } else {
                "hug"
            }
        };
        record["child_layout"] = json!({"sizing_h":sizing("width"),"sizing_v":sizing("height"),"absolute":false,
            "min_w":null,"max_w":null,"min_h":null,"max_h":null,"grid_column":null,"grid_row":null,"grid_column_span":0,"grid_row_span":0});
        record["style"] = json!({"font_family":node.string("fontFamily").unwrap_or("Inter"),"font_style":"Regular","font_size":node.number("fontSize",16.),
            "line_height":{"unit":"auto"},"letter_spacing":{"unit":"percent","value":0},"decoration":"none","case":"original","fills":null,"link":null});
    } else if kind == "ellipse" {
        record["start"] = json!(0.);
        record["sweep"] = json!(std::f64::consts::TAU);
        record["inner"] = json!(0.);
    }
    Ok(record)
}

fn encode_color(value: &str) -> Result<Value> {
    if value == "transparent" {
        return Ok(json!({"r":0,"g":0,"b":0,"a":0}));
    }
    let hex = value
        .strip_prefix('#')
        .ok_or_else(|| unsupported("non-hex color"))?;
    let hex = if hex.len() == 3 || hex.len() == 4 {
        hex.chars().flat_map(|c| [c, c]).collect::<String>()
    } else {
        hex.into()
    };
    let bytes = hex::decode(hex).map_err(invalid)?;
    if !matches!(bytes.len(), 3 | 4) {
        return Err(invalid("invalid hex color"));
    }
    Ok(
        json!({"r":bytes[0] as f64/255.,"g":bytes[1] as f64/255.,"b":bytes[2] as f64/255.,"a":bytes.get(3).copied().unwrap_or(255) as f64/255.}),
    )
}

fn unsupported(message: impl std::fmt::Display) -> EngineError {
    EngineError::new(
        "unsupported_feature",
        format!("FigCraft file compatibility does not support {message}"),
    )
}

fn invalid(error: impl std::fmt::Display) -> EngineError {
    EngineError::invalid(error.to_string())
}
