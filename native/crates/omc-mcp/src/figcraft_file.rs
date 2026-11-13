//! Bounded FigCraft v1 archives for editable basic layers.
use super::*;
use crate::figcraft::{dev_diff, dev_status, prototype_settings};
use base64::Engine;
use omc_model::{NodeKind, Page, rank_between};
use omc_style::prototype::{
    INTERACTIONS as PROTOTYPE_INTERACTIONS, SETTINGS as PROTOTYPE_SETTINGS,
};
mod comments;
mod prototype_archive;
pub use comments::WireComments;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    io::{Cursor, Read, Write},
    path::Path,
};
use zip::{ZipArchive, ZipWriter, write::SimpleFileOptions};

const MAX_FILE: usize = 16 * 1024 * 1024;
const MAX_NODES: usize = 10_000;

pub(super) const FILE_COMMANDS: &[(&str, &str, bool, &str)] = &[
    (
        "file.openRecent",
        "Open recent file",
        false,
        "path?, index?, clear?, remove?",
    ),
    ("file.fontReport", "Inspect document fonts", false, ""),
    ("file.markSaved", "Mark file saved", false, ""),
    ("file.recover", "Recover file copy", false, "path | data"),
    ("file.rename", "Rename file", true, "name"),
    ("file.duplicate", "Duplicate file", false, ""),
    (
        "file.import",
        "Import editable file content",
        true,
        "path | data + name, x?, y?, center?",
    ),
    (
        "file.placeImage",
        "Place raster image",
        true,
        "path | data, x?, y?, width?, height?, parent?, name?, target?, mode?",
    ),
    ("file.revert", "Revert file to saved", false, ""),
    (
        "file.exportFramesPdf",
        "Export frames to PDF",
        false,
        "path?, page?",
    ),
    (
        "page.setBackground",
        "Set page background",
        true,
        "id?, color",
    ),
];

#[derive(Clone)]
pub(super) struct FigFile {
    pub path: String,
    pub digest: Vec<u8>,
    upstream_archive: bool,
}

impl ToolRouter {
    pub(super) fn fig_open_file(&self, session: &str, params: &Value) -> Result<Value> {
        let mut recent = self.fig_file_access.lock().unwrap();
        let input = FileInput::read(params)?;
        let digest = Sha256::digest(&input.bytes).to_vec();
        let existing = self
            .states
            .lock()
            .unwrap()
            .iter()
            .find_map(|((owner, id), state)| {
                let file = state.fig_file.as_ref()?;
                (owner == session && input.path.as_deref() == Some(file.path.as_str()))
                    .then(|| (id.clone(), file.clone(), state.fig_saved_revision))
            });
        if let Some((document, file, saved)) = existing {
            let context = self.workspace.context(&document)?;
            if params["reload"] == true && file.digest != digest {
                if saved != Some(context.revision.sequence) {
                    return Err(EngineError::new("conflict", "document has unsaved changes"));
                }
                let snapshot = self.workspace.snapshot(&document)?;
                self.fig_replace_file(session, &snapshot, &input)?;
                self.workspace.bind(session, &document)?;
                remember_recent(recent.entry(session.into()).or_default(), &file.path);
                return Ok(
                    json!({"document":external_id(&document),"path":file.path,"reloaded":true}),
                );
            }
            self.workspace.bind(session, &document)?;
            remember_recent(recent.entry(session.into()).or_default(), &file.path);
            return Ok(
                json!({"document":external_id(&document),"path":file.path,"stale":file.digest != digest}),
            );
        }

        let (content, current_page, warnings, upstream_archive) = self.fig_decode_input(&input)?;
        let images = content
            .nodes
            .values()
            .filter(|node| node.kind == NodeKind::Image)
            .count();
        let snapshot = self
            .workspace
            .create(session, &content.title.clone(), Some(content))?;
        self.context_from(session, &snapshot)?;
        if let Some(path) = input.path.as_deref() {
            remember_recent(recent.entry(session.into()).or_default(), path);
        }
        self.fig_file_state(
            session,
            &snapshot,
            current_page,
            input.path.as_ref().map(|path| FigFile {
                path: path.clone(),
                digest,
                upstream_archive,
            }),
            input.path.as_ref().map(|_| snapshot.sequence),
        )?;
        Ok(
            json!({"document":external_id(&snapshot.id),"path":input.path,
            "summary":{"name":snapshot.title,"pages":snapshot.pages.len(),"layers":snapshot.nodes.len()-snapshot.pages.len(),"images":images},"warnings":warnings}),
        )
    }

    pub(super) fn fig_open_recent(&self, session: &str, params: &Value) -> Result<Value> {
        let path = params
            .get("path")
            .map(|_| string(params, "path"))
            .transpose()?;
        if path.is_some_and(|path| !Path::new(path).is_absolute()) {
            return Err(invalid("file path must be absolute"));
        }
        let index = params
            .get("index")
            .map(|index| {
                index
                    .as_u64()
                    .and_then(|index| usize::try_from(index).ok())
                    .ok_or_else(|| invalid("recent file index must be a non-negative integer"))
            })
            .transpose()?;
        if path.is_some() && index.is_some() {
            return Err(invalid("supply either path or index"));
        }
        let mut recent = self.fig_file_access.lock().unwrap();
        let history = recent.entry(session.into()).or_default();
        if params["clear"] == true {
            history.clear();
        }
        if let Some(remove) = params["remove"].as_str() {
            history.retain(|path| path != remove);
        }
        let target = if let Some(path) = path {
            Some(path.to_owned())
        } else if let Some(index) = index {
            Some(
                history
                    .get(index)
                    .ok_or_else(|| invalid("recent file index out of bounds"))?
                    .clone(),
            )
        } else {
            None
        };
        if let Some(target) = target {
            if !Path::new(&target).is_file() {
                history.retain(|path| path != &target);
                return Err(invalid("recent file no longer exists"));
            }
            drop(recent);
            return self.fig_open_file(session, &json!({"path":target}));
        }
        Ok(json!({"files":history.iter().map(|path| json!({
            "path":path, "name":Path::new(path).file_name().and_then(|n| n.to_str()).unwrap_or(path), "exists":Path::new(path).is_file()
        })).collect::<Vec<_>>()}))
    }

    pub(super) fn fig_recover_file(&self, session: &str, params: &Value) -> Result<Value> {
        let bytes = match (params.get("path"), params.get("data")) {
            (Some(_), None) => resources::read_explicit(string(params, "path")?, MAX_FILE)?,
            (None, Some(data)) => file_data(data)?,
            _ => return Err(invalid("supply exactly one of path or data")),
        };
        let (content, page_index) = decode(&bytes)?;
        let snapshot = self
            .workspace
            .create(session, &content.title.clone(), Some(content))?;
        self.context_from(session, &snapshot)?;
        self.fig_file_state(session, &snapshot, page_index, None, None)?;
        Ok(json!({"document":external_id(&snapshot.id), "name":snapshot.title}))
    }

    pub(super) fn fig_adopt_window_file(&self, session: &str, document: &str) {
        let path = {
            let mut states = self.states.lock().unwrap();
            let Some(source) = states.iter().find_map(|((owner, id), state)| {
                (id == document && owner != session && state.fig_file.is_some()).then(|| {
                    (
                        state.fig_file.clone().unwrap(),
                        state.fig_saved_revision,
                        state.page_id.clone(),
                        state.root.clone(),
                    )
                })
            }) else {
                return;
            };
            let Some(target) = states.get_mut(&(session.into(), document.into())) else {
                return;
            };
            if target.fig_file.is_some() {
                return;
            }
            let (file, saved, page, root) = source;
            let path = file.path.clone();
            target.fig_file = Some(file);
            target.fig_saved_revision = saved;
            target.page_id = page;
            target.root = root;
            path
        };
        let mut recent = self.fig_file_access.lock().unwrap();
        remember_recent(recent.entry(session.into()).or_default(), &path);
    }

    fn fig_file_state(
        &self,
        session: &str,
        snapshot: &DocumentSnapshot,
        page_index: usize,
        file: Option<FigFile>,
        saved: Option<u64>,
    ) -> Result<()> {
        let page = snapshot
            .pages
            .get(page_index)
            .ok_or_else(|| invalid("file has no current page"))?;
        let mut states = self.states.lock().unwrap();
        let state = states
            .get_mut(&(session.into(), snapshot.id.clone()))
            .ok_or_else(|| invalid("file session was closed"))?;
        if state.page_id != page.id {
            state.aliases.clear();
            state.view["selection"] = json!([]);
        }
        state.page_id = page.id.clone();
        state.root = page.root_node_id.clone();
        state.fig_file = file;
        state.fig_saved_revision = saved;
        Ok(())
    }

    fn fig_decode_input(&self, input: &FileInput) -> Result<(DocumentContent, usize, Value, bool)> {
        if input.extension == "figcraft" {
            if let Some((content, page)) = self.fig_decode_catalog_archive(&input.bytes)? {
                return Ok((content, page, json!([]), false));
            }
            let (content, page) = decode(&input.bytes)?;
            return Ok((content, page, json!([]), true));
        }
        if input.extension == "json" {
            let file = omc_protocol::decode_json_with_limit(&input.bytes, MAX_FILE)?;
            if file["format"] == "figcraft" {
                let (content, page) = decode_document(&file)?;
                return Ok((content, page, json!([]), false));
            }
        }
        if matches!(input.extension.as_str(), "png" | "jpg" | "jpeg" | "webp") {
            let mut content = DocumentContent::empty(&input.title);
            let mut node = self.fig_image_node(&input.bytes, &input.title, &Value::Null)?;
            node.parent_id = Some(content.pages[0].root_node_id.clone());
            content.nodes.insert(node.id.clone(), node);
            return Ok((content, 0, json!([]), false));
        }
        let imported = omc_import::import_bytes(
            &input.extension,
            &input.bytes,
            &omc_import::ImportOptions {
                strict: false,
                max_input_bytes: MAX_FILE,
                ..Default::default()
            },
        )
        .map_err(invalid)?;
        let store = self.resources()?.0;
        for asset in imported.resources {
            let saved = store.ingest(&asset.bytes, &asset.media_type)?;
            if saved.hash != asset.hash {
                return Err(EngineError::new(
                    "corrupt_state",
                    "import resource identity mismatch",
                ));
            }
        }
        Ok((imported.content, 0, json!(imported.diagnostics), false))
    }

    pub(super) fn fig_file_command(
        &self,
        session: &str,
        snapshot: &DocumentSnapshot,
        state: &ViewState,
        name: &str,
        params: &Value,
    ) -> Option<Result<Value>> {
        let run = || -> Result<Value> {
            let id = &snapshot.id;
            match name {
                "file.fontReport" => Ok(font_report(snapshot)),
                "file.exportFramesPdf" => self.fig_frames_pdf(session, snapshot, state, params),
                "file.markSaved" => {
                    self.workspace.checkpoint(id)?;
                    let mut states = self.states.lock().unwrap();
                    let state = states
                        .get_mut(&(session.into(), id.clone()))
                        .ok_or_else(|| invalid("file session was closed"))?;
                    state.fig_saved_revision = Some(snapshot.sequence);
                    Ok(json!({"ok":true}))
                }
                "file.rename" => {
                    let name = string(params, "name")?.trim();
                    if name.is_empty() || name.len() > 240 {
                        return Err(invalid("name must contain 1–240 bytes"));
                    }
                    self.submit(
                        session,
                        id,
                        Command::DocumentRename { title: name.into() },
                        &Value::Null,
                        Some(snapshot.sequence),
                    )?;
                    Ok(json!({"name":name}))
                }
                "file.duplicate" => {
                    let mut content = copy_content(snapshot);
                    content.title = format!("{} (Copy)", snapshot.title);
                    let page_index = snapshot
                        .pages
                        .iter()
                        .position(|page| page.id == state.page_id)
                        .unwrap_or(0);
                    let copy =
                        self.workspace
                            .create(session, &content.title.clone(), Some(content))?;
                    self.context_from(session, &copy)?;
                    self.fig_file_state(session, &copy, page_index, None, None)?;
                    Ok(json!({"id":external_id(&copy.id),"name":copy.title}))
                }
                "page.setBackground" => {
                    let root = match params.get("id") {
                        Some(page) => self.fig_layer(session, snapshot, page)?,
                        None => state.root.clone(),
                    };
                    if !snapshot.pages.iter().any(|page| page.root_node_id == root) {
                        return Err(invalid("page id required"));
                    }
                    let color = match &params["color"] {
                        Value::String(color) => read_color(&encode_color(color)?)?,
                        color => read_color(color)?,
                    };
                    self.submit(
                        session,
                        id,
                        Command::NodeSet {
                            node_id: root.clone(),
                            properties: properties(&json!({"fill":color}))?,
                        },
                        &Value::Null,
                        Some(snapshot.sequence),
                    )?;
                    Ok(json!({"id":self.fig_alias(session,id,&root),"color":color}))
                }
                "file.import" => {
                    let input = FileInput::read(params)?;
                    if matches!(input.extension.as_str(), "png" | "jpg" | "jpeg" | "webp") {
                        return self.fig_place_image(
                            session,
                            snapshot,
                            state,
                            params,
                            &input.bytes,
                            &input.title,
                        );
                    }
                    let (content, _, warnings, _) = self.fig_decode_input(&input)?;
                    self.fig_import_content(
                        session, snapshot, state, params, &input, content, warnings,
                    )
                }
                "file.placeImage" => {
                    let (bytes, name) = image_input(params)?;
                    self.fig_place_image(session, snapshot, state, params, &bytes, &name)
                }
                "file.revert" => {
                    let _access = self.fig_file_access.lock().unwrap();
                    let file = state
                        .fig_file
                        .as_ref()
                        .ok_or_else(|| invalid("file has no saved path"))?;
                    let input = FileInput::read(&json!({"path":file.path}))?;
                    self.fig_replace_file(session, snapshot, &input)
                }
                _ => unreachable!(),
            }
        };
        FILE_COMMANDS
            .iter()
            .any(|command| command.0 == name && !matches!(name, "file.openRecent" | "file.recover"))
            .then(run)
    }

    fn fig_frames_pdf(
        &self,
        session: &str,
        snapshot: &DocumentSnapshot,
        state: &ViewState,
        params: &Value,
    ) -> Result<Value> {
        if ["cropMarks", "bleedMarks", "cmyk"]
            .iter()
            .any(|option| params.get(option).is_some_and(|value| value != false))
            || params
                .get("bleed")
                .is_some_and(|value| value.as_f64() != Some(0.))
        {
            return Err(unsupported("PDF bleed, print marks, or CMYK"));
        }
        let page = if let Some(alias) = params.get("page") {
            let root = self.fig_layer(session, snapshot, alias)?;
            snapshot
                .pages
                .iter()
                .find(|page| page.root_node_id == root)
                .ok_or_else(|| invalid("page id required"))?
                .id
                .clone()
        } else {
            state.page_id.clone()
        };
        let scene = omc_scene::build_scene(
            snapshot,
            &omc_scene::SceneOptions {
                page_id: Some(page),
                ..Default::default()
            },
        )
        .map_err(invalid)?;
        let mut frames = scene.items[scene.root]
            .children
            .iter()
            .map(|index| &scene.items[*index])
            .filter(|frame| frame.kind == NodeKind::Frame && !frame.hidden)
            .collect::<Vec<_>>();
        if frames.is_empty() {
            return Err(invalid("the page has no visible frames"));
        }
        if frames.len() > 100 {
            return Err(EngineError::new(
                "resource_limit",
                "PDF has more than 100 frames",
            ));
        }
        frames.sort_by(|a, b| {
            a.bounds[1]
                .total_cmp(&b.bounds[1])
                .then_with(|| a.bounds[0].total_cmp(&b.bounds[0]))
        });
        let count = frames.len();
        let resources = self.resources()?;
        let mut bytes = Vec::new();
        {
            let metadata = skia_safe::pdf::Metadata {
                title: snapshot.title.clone(),
                ..Default::default()
            };
            let mut document = skia_safe::pdf::new_document(&mut bytes, Some(&metadata));
            for frame in frames {
                let [x, y, width, height] = frame.bounds;
                if !(0.01..=1_000_000.).contains(&width) || !(0.01..=1_000_000.).contains(&height) {
                    return Err(invalid(
                        "PDF frame dimensions are outside the supported range",
                    ));
                }
                let mut page = document.begin_page((width as f32, height as f32), None);
                let canvas = page.canvas();
                canvas.translate((-x as f32, -y as f32));
                let diagnostics =
                    omc_render::paint_scene_frame(canvas, &scene, &frame.id, &resources)
                        .map_err(invalid)?;
                if diagnostics
                    .iter()
                    .any(|diagnostic| diagnostic.fidelity_lost)
                {
                    return Err(unsupported("PDF rendering would lose frame content"));
                }
                document = page.end_page();
            }
            document.close();
        }
        if !bytes.starts_with(b"%PDF-") {
            return Err(invalid("PDF encoding failed"));
        }
        if let Some(path) = params.get("path") {
            let path = path
                .as_str()
                .ok_or_else(|| invalid("path must be a string"))?;
            interchange::write_explicit(path, &bytes, false)?;
            Ok(json!({"path":path,"bytes":bytes.len(),"pages":count}))
        } else {
            if bytes.len() > MAX_FILE {
                return Err(EngineError::new(
                    "resource_limit",
                    "PDF exceeds the inline size limit; use a path",
                ));
            }
            Ok(
                json!({"format":"pdf","pages":count,"data":base64::engine::general_purpose::STANDARD.encode(&bytes)}),
            )
        }
    }

    fn fig_import_content(
        &self,
        session: &str,
        snapshot: &DocumentSnapshot,
        state: &ViewState,
        params: &Value,
        input: &FileInput,
        mut content: DocumentContent,
        warnings: Value,
    ) -> Result<Value> {
        if content
            .metadata
            .iter()
            .any(|(key, value)| input.extension != "svg" || key != "sourceFormat" || value != "svg")
        {
            return Err(unsupported("appending file metadata"));
        }
        let summary = json!({
            "name":content.title,"pages":content.pages.len(),
            "layers":content.nodes.len() - content.pages.len(),
            "images":content.nodes.values().filter(|n| n.kind == NodeKind::Image).count()
        });
        let (commands, imported) = if input.extension == "svg" {
            let mut root = content
                .nodes
                .remove(&content.pages[0].root_node_id)
                .ok_or_else(|| invalid("SVG root missing"))?;
            root.parent_id = Some(state.root.clone());
            root.rank = append_rank(
                children(snapshot, &state.root)
                    .last()
                    .map(|n| n.rank.as_str()),
            )?;
            let offset = |key: &str, dimension: &str| -> Result<f64> {
                let value = file_number(params, key, 0.)?;
                let half = if params["center"] == true {
                    root.properties
                        .get(dimension)
                        .and_then(Value::as_f64)
                        .unwrap_or(0.)
                        / 2.
                } else {
                    0.
                };
                Ok(value - half)
            };
            let x = offset("x", "width")?;
            let y = offset("y", "height")?;
            root.properties.extend([
                ("name".into(), json!(input.title)),
                ("x".into(), json!(x)),
                ("y".into(), json!(y)),
            ]);
            let imported = vec![root.id.clone()];
            let mut commands = vec![Command::NodeCreate { node: root }];
            commands.extend(
                content
                    .nodes
                    .into_values()
                    .map(|node| Command::NodeCreate { node }),
            );
            (commands, imported)
        } else {
            let mut last = snapshot.pages.last().map(|p| p.rank.clone());
            for page in &mut content.pages {
                page.rank = append_rank(last.as_deref())?;
                last = Some(page.rank.clone());
            }
            let imported = content
                .pages
                .iter()
                .map(|p| p.root_node_id.clone())
                .collect();
            (page_commands(content)?, imported)
        };
        let receipt = self.submit(
            session,
            &snapshot.id,
            Command::Batch { commands },
            &Value::Null,
            Some(snapshot.sequence),
        )?;
        let ids = imported
            .iter()
            .map(|node| self.fig_alias(session, &snapshot.id, node))
            .collect::<Vec<_>>();
        Ok(json!({"summary":summary,"ids":ids,"warnings":warnings,"revision":receipt["revision"]}))
    }

    fn fig_replace_file(
        &self,
        session: &str,
        snapshot: &DocumentSnapshot,
        input: &FileInput,
    ) -> Result<Value> {
        let (content, current_page, warnings, upstream_archive) = self.fig_decode_input(input)?;
        if !snapshot.metadata.is_empty()
            || !content.metadata.is_empty()
            || warnings.as_array().is_some_and(|warnings| {
                warnings
                    .iter()
                    .any(|warning| warning["fidelityLost"] == true)
            })
        {
            return Err(unsupported(
                "replacing file with unsupported document metadata or conversion losses",
            ));
        }
        let current_id = content
            .pages
            .get(current_page)
            .ok_or_else(|| invalid("file has no current page"))?
            .id
            .clone();
        let title = content.title.clone();
        let mut commands = page_commands(content)?;
        commands.extend(snapshot.pages.iter().map(|page| Command::PageDelete {
            page_id: page.id.clone(),
        }));
        if title != snapshot.title {
            commands.push(Command::DocumentRename { title });
        }
        let receipt = self.submit(
            session,
            &snapshot.id,
            Command::Batch { commands },
            &Value::Null,
            Some(snapshot.sequence),
        )?;
        let revision = receipt["revision"].as_u64().ok_or_else(|| {
            EngineError::new(
                "corrupt_state",
                "file replacement has no committed revision",
            )
        })?;
        let updated = self.workspace.snapshot(&snapshot.id)?;
        let page_index = updated
            .pages
            .iter()
            .position(|p| p.id == current_id)
            .ok_or_else(|| invalid("file page unavailable after replacement"))?;
        let path = input
            .path
            .clone()
            .ok_or_else(|| invalid("file path required"))?;
        self.fig_file_state(
            session,
            &updated,
            page_index,
            Some(FigFile {
                path,
                digest: Sha256::digest(&input.bytes).to_vec(),
                upstream_archive,
            }),
            Some(revision),
        )?;
        Ok(json!({"ok":true,"revision":revision}))
    }

    pub(super) fn fig_image_node(&self, bytes: &[u8], name: &str, params: &Value) -> Result<Node> {
        let mime = resources::detect_mime(bytes)?;
        if !matches!(mime, "image/png" | "image/jpeg" | "image/webp") {
            return Err(unsupported(format!("image format {mime}")));
        }
        let codec = skia_safe::Codec::from_data(skia_safe::Data::new_copy(bytes))
            .ok_or_else(|| invalid("invalid raster image"))?;
        let size = codec.dimensions();
        if size.width <= 0
            || size.height <= 0
            || i64::from(size.width) * i64::from(size.height) > 64 * 1024 * 1024
        {
            return Err(EngineError::new(
                "resource_limit",
                "image exceeds 64 megapixels",
            ));
        }
        let width = file_number(params, "width", f64::from(size.width))?;
        let height = file_number(
            params,
            "height",
            width * f64::from(size.height) / f64::from(size.width),
        )?;
        if width <= 0. || height <= 0. {
            return Err(invalid("image width and height must be positive"));
        }
        let fit = match params["mode"].as_str().unwrap_or("fill") {
            "fit" => "contain",
            "fill" | "crop" => "cover",
            "tile" => "tile",
            mode => return Err(unsupported(format!("image mode {mode}"))),
        };
        let x = file_number(params, "x", 0.)?;
        let y = file_number(params, "y", 0.)?;
        let asset = self.resources()?.0.ingest(bytes, mime)?;
        let mut node = Node::new(NodeKind::Image);
        node.properties = properties(
            &json!({"name":name,"x":x,"y":y,"width":width,"height":height,
            "assetHash":asset.hash,"imageFit":fit}),
        )?;
        Ok(node)
    }

    pub(super) fn fig_place_image(
        &self,
        session: &str,
        snapshot: &DocumentSnapshot,
        state: &ViewState,
        params: &Value,
        bytes: &[u8],
        name: &str,
    ) -> Result<Value> {
        if params.get("target").is_some() {
            return Err(unsupported("image fills on existing layers"));
        }
        let parent = match params.get("parent") {
            Some(parent) => self.fig_layer(session, snapshot, parent)?,
            None => state.root.clone(),
        };
        if !snapshot.nodes.get(&parent).is_some_and(|node| {
            matches!(
                node.kind,
                NodeKind::Frame | NodeKind::Group | NodeKind::Component
            )
        }) {
            return Err(invalid("image parent must be a frame, group, or component"));
        }
        let mut ancestor = parent.as_str();
        while let Some(next) = snapshot.nodes[ancestor].parent_id.as_deref() {
            ancestor = next;
        }
        if ancestor != state.root {
            return Err(invalid("image parent must be on the current page"));
        }
        let mut node =
            self.fig_image_node(bytes, params["name"].as_str().unwrap_or(name), params)?;
        node.parent_id = Some(parent.clone());
        node.rank = append_rank(children(snapshot, &parent).last().map(|n| n.rank.as_str()))?;
        let raw_id = node.id.clone();
        let mut result = json!({
            "image":node.properties["assetHash"],
            "width":node.properties["width"],"height":node.properties["height"],"imageProfile":null
        });
        self.submit(
            session,
            &snapshot.id,
            Command::NodeCreate { node },
            &Value::Null,
            Some(snapshot.sequence),
        )?;
        result["id"] = json!(self.fig_alias(session, &snapshot.id, &raw_id));
        self.fig_selection(
            &(session.into(), snapshot.id.clone()),
            &[result["id"].clone()],
        );
        Ok(result)
    }

    pub(super) fn fig_save_file(
        &self,
        session: &str,
        snapshot: &DocumentSnapshot,
        state: &ViewState,
        params: &Value,
        save_as: bool,
    ) -> Result<Value> {
        let mut recent = self.fig_file_access.lock().unwrap();
        let snapshot = self.workspace.snapshot(&snapshot.id)?;
        let state = self
            .state(session, &snapshot.id)
            .unwrap_or_else(|_| state.clone());
        let native_catalog = crate::figcraft_catalog::library_archive::needs_native(&snapshot);
        if save_as && params["data"] == true && params.get("path").is_none() {
            let bytes = if native_catalog {
                self.fig_encode_catalog_archive(&snapshot, &state.page_id)?
            } else {
                encode(
                    &snapshot,
                    &state.page_id,
                    self.thumbnail_png(&snapshot)?.as_deref(),
                )?
            };
            let mut result = json!({"name":format!("{}.figcraft",snapshot.title),"bytes":bytes.len(),
                "data":base64::engine::general_purpose::STANDARD.encode(bytes)});
            if native_catalog {
                result["nativeCatalog"] = json!(true);
            }
            return Ok(result);
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
        let extension = extension(&path)?;
        let previous = state.fig_file.as_ref().filter(|file| file.path == path);
        if extension == "figcraft"
            && native_catalog
            && previous.is_some_and(|file| file.upstream_archive)
        {
            return Err(EngineError::new(
                "unsupported",
                "this document now contains OMC-only catalog data; use file.saveAs with a new .omc path to preserve the original FigCraft archive",
            ));
        }
        let bytes = match extension.as_str() {
            "figcraft" if native_catalog => {
                self.fig_encode_catalog_archive(&snapshot, &state.page_id)?
            }
            "figcraft" => encode(
                &snapshot,
                &state.page_id,
                self.thumbnail_png(&snapshot)?.as_deref(),
            )?,
            "omc" => {
                omc_export::export(
                    &snapshot,
                    &omc_export::ExportOptions {
                        format: "omc".into(),
                        ..Default::default()
                    },
                    &self.resources()?,
                )
                .map_err(invalid)?
                .bytes
            }
            other => return Err(unsupported(format!("export to {other}"))),
        };
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
        remember_recent(recent.entry(session.into()).or_default(), &path);
        let mut states = self.states.lock().unwrap();
        if let Some(current) = states.get_mut(&(session.into(), snapshot.id.clone())) {
            current.fig_saved_revision = Some(snapshot.sequence);
            current.fig_file = Some(FigFile {
                path: path.clone(),
                digest: Sha256::digest(&bytes).to_vec(),
                upstream_archive: extension == "figcraft" && !native_catalog,
            });
        }
        let mut result = json!({"path":path,"bytes":bytes.len()});
        if native_catalog && extension == "figcraft" {
            result["nativeCatalog"] = json!(true);
        }
        Ok(result)
    }
}

fn font_report(snapshot: &DocumentSnapshot) -> Value {
    let fonts = skia_safe::FontMgr::default();
    let known: BTreeSet<_> = fonts
        .family_names()
        .map(|name| name.to_lowercase())
        .collect();
    let mut families: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    for node in snapshot
        .nodes
        .values()
        .filter(|node| node.kind == NodeKind::Text)
    {
        if node.string("text").is_none_or(str::is_empty) {
            continue;
        }
        let mut add_families = |names: &str| {
            for name in names
                .split(',')
                .map(|name| name.trim().trim_matches(['\'', '"']))
            {
                let family: String = name.chars().filter(|c| !c.is_control()).take(160).collect();
                if !family.is_empty() && (families.len() < 256 || families.contains_key(&family)) {
                    let layers = families.entry(family).or_default();
                    if layers.len() < 25 {
                        layers.insert(
                            node.string("name")
                                .unwrap_or("Text")
                                .chars()
                                .filter(|c| !c.is_control())
                                .take(120)
                                .collect(),
                        );
                    }
                }
            }
        };
        let base = node.string("fontFamily").unwrap_or("sans-serif");
        if let Some(runs) = node
            .properties
            .get("textRuns")
            .and_then(Value::as_array)
            .filter(|runs| !runs.is_empty())
        {
            for run in runs {
                if run["text"].as_str().is_some_and(|text| !text.is_empty()) {
                    add_families(run["attributes"]["fontFamily"].as_str().unwrap_or(base));
                }
            }
        } else {
            add_families(base);
        }
    }
    let entries: Vec<_> = families
        .into_iter()
        .map(|(family, layers)| {
            let lower = family.to_lowercase();
            let available = if matches!(
                lower.as_str(),
                "sans-serif" | "serif" | "monospace" | "system-ui"
            ) {
                Some(true)
            } else if known.is_empty() {
                None
            } else {
                Some(
                    known.contains(&lower)
                        || fonts
                            .match_family_style(&family, skia_safe::FontStyle::normal())
                            .is_some(),
                )
            };
            json!({"family":family, "available":available, "layers":layers})
        })
        .collect();
    let missing = entries
        .iter()
        .filter(|entry| entry["available"] == false)
        .count();
    json!({"total":entries.len(), "missing":missing, "fonts":entries, "embeddedFontFiles":0,
        "fontLicenseNotices":0, "externalPenpotFontRefs":[]})
}

struct FileInput {
    path: Option<String>,
    extension: String,
    title: String,
    bytes: Vec<u8>,
}

impl FileInput {
    fn read(params: &Value) -> Result<Self> {
        if params.get("variables").is_some() {
            return Err(unsupported("REST variables supplied separately"));
        }
        let (path, name, bytes) = match (params.get("path"), params.get("data")) {
            (Some(path), None) => {
                let path = path
                    .as_str()
                    .ok_or_else(|| invalid("file path must be a string"))?;
                let name = Path::new(path)
                    .file_name()
                    .and_then(|n| n.to_str())
                    .ok_or_else(|| invalid("file name required"))?;
                (
                    Some(path.to_owned()),
                    name,
                    resources::read_explicit(path, MAX_FILE)?,
                )
            }
            (None, Some(data)) => (None, string(params, "name")?, file_data(data)?),
            _ => return Err(invalid("supply exactly one of path or data")),
        };
        let extension = extension(name)?;
        let title = Path::new(name)
            .file_stem()
            .and_then(|n| n.to_str())
            .ok_or_else(|| invalid("file name required"))?
            .to_owned();
        Ok(Self {
            path,
            extension,
            title,
            bytes,
        })
    }
}

fn file_data(data: &Value) -> Result<Vec<u8>> {
    let encoded = data
        .as_str()
        .ok_or_else(|| invalid("file data must be base64"))?;
    if encoded.len() > MAX_FILE.div_ceil(3) * 4 {
        return Err(EngineError::new("resource_limit", "file exceeds 16 MiB"));
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(invalid)?;
    if bytes.len() > MAX_FILE {
        return Err(EngineError::new("resource_limit", "file exceeds 16 MiB"));
    }
    Ok(bytes)
}

pub(super) fn image_input(params: &Value) -> Result<(Vec<u8>, String)> {
    match (params.get("path"), params.get("data")) {
        (Some(path), None) => {
            let path = path
                .as_str()
                .ok_or_else(|| invalid("image path must be a string"))?;
            let name = Path::new(path)
                .file_stem()
                .and_then(|n| n.to_str())
                .unwrap_or("Image");
            Ok((resources::read_explicit(path, MAX_FILE)?, name.to_owned()))
        }
        (None, Some(data)) => Ok((file_data(data)?, "Image".into())),
        _ => Err(invalid("supply exactly one of path or data")),
    }
}

fn file_number(params: &Value, key: &str, default: f64) -> Result<f64> {
    params.get(key).map_or(Ok(default), |value| {
        value
            .as_f64()
            .filter(|v| v.is_finite())
            .ok_or_else(|| invalid(format!("{key} must be numeric")))
    })
}

fn remember_recent(history: &mut Vec<String>, path: &str) {
    history.retain(|old| old != path);
    history.insert(0, path.into());
    history.truncate(50);
}

fn append_rank(last: Option<&str>) -> Result<String> {
    rank_between(last, None)
        .ok_or_else(|| EngineError::new("resource_limit", "rank rebalance required"))
}

fn page_commands(mut content: DocumentContent) -> Result<Vec<Command>> {
    let mut commands = Vec::with_capacity(content.nodes.len());
    for page in content.pages {
        let root = content
            .nodes
            .remove(&page.root_node_id)
            .ok_or_else(|| invalid("imported page root missing"))?;
        commands.push(Command::PageCreate { page, root });
    }
    commands.extend(
        content
            .nodes
            .into_values()
            .map(|node| Command::NodeCreate { node }),
    );
    Ok(commands)
}

fn extension(path: &str) -> Result<String> {
    Path::new(path)
        .extension()
        .and_then(|extension| extension.to_str())
        .map(str::to_ascii_lowercase)
        .ok_or_else(|| EngineError::invalid("file extension required"))
}

fn decode(bytes: &[u8]) -> Result<(DocumentContent, usize)> {
    decode_document(&read_wire_archive(bytes)?)
}

pub fn read_recovery_archive(path: &str) -> Result<Value> {
    read_wire_archive(&resources::read_explicit(path, MAX_FILE)?)
}

fn read_wire_archive(bytes: &[u8]) -> Result<Value> {
    if bytes.iter().find(|byte| !byte.is_ascii_whitespace()) == Some(&b'{') {
        return omc_protocol::decode_json_with_limit(bytes, MAX_FILE);
    }
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
    omc_protocol::decode_json_with_limit(&bytes, MAX_FILE)
}

fn decode_document(file: &Value) -> Result<(DocumentContent, usize)> {
    decode_wire_document(file, &mut BTreeMap::new(), &mut BTreeMap::new())
}

pub fn decode_wire_document(
    file: &Value,
    native_ids: &mut BTreeMap<u64, String>,
    page_ids: &mut BTreeMap<u64, String>,
) -> Result<(DocumentContent, usize)> {
    decode_wire_document_with_comments(file, native_ids, page_ids, &mut WireComments::default(), None)
}

pub fn decode_wire_document_with_comments(
    file: &Value,
    native_ids: &mut BTreeMap<u64, String>,
    page_ids: &mut BTreeMap<u64, String>,
    comments: &mut WireComments,
    current_snapshot: Option<&DocumentSnapshot>,
) -> Result<(DocumentContent, usize)> {
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
                    | "annotation_categories"
                    | "color_profile"
            )
        })
    }) {
        return Err(unsupported("unrecognized document metadata"));
    }
    for key in ["imageIndex", "styles", "document_colors"] {
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
        title: string(file, "name")?.into(),
        pages: vec![],
        nodes: BTreeMap::new(),
        metadata: Properties::new(),
    };
    if let Some(value) = file.get("color_profile") {
        let profile = value
            .as_str()
            .and_then(omc_style::ColorProfile::parse)
            .ok_or_else(|| invalid("invalid file color profile"))?;
        content
            .metadata
            .insert("colorProfile".into(), json!(profile.name()));
    }
    if let Some(value) = file.get("annotation_categories") {
        let categories = value
            .as_array()
            .filter(|items| items.len() <= 64)
            .ok_or_else(|| invalid("invalid annotation categories"))?;
        let mut native = Vec::new();
        let mut ids = BTreeSet::new();
        for category in categories {
            let id = string(category, "id")?;
            let name = string(category, "name")?;
            if id.is_empty()
                || id.len() > 128
                || name.trim().is_empty()
                || name.chars().count() > 64
                || !ids.insert(id)
            {
                return Err(invalid("invalid annotation category ID or name"));
            }
            native.push(json!({"id":id,"name":name,"color":read_color(&category["color"])?}));
        }
        content
            .metadata
            .insert("annotationCategories".into(), json!(native));
    }
    let mut visited = BTreeSet::new();
    let mut node_ids = BTreeMap::new();
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
            ("line", Some(_)) => NodeKind::Line,
            ("text", Some(_)) => NodeKind::Text,
            _ => return Err(unsupported(format!("layer type {kind}"))),
        });
        if let Some(id) = native_ids.get(&number) {
            native.id.clone_from(id);
        } else {
            native_ids.insert(number, native.id.clone());
        }
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
        node_ids.insert(number, id.clone());
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
        if let Some(page_id) = page_ids.get(&number) {
            page.id.clone_from(page_id);
        } else {
            page_ids.insert(number, page.id.clone());
        }
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
    for (number, id) in &node_ids {
        let record = &records[&number.to_string()];
        let node = content.nodes.get_mut(id).unwrap();
        if let Some(flows) = record.get("flows").filter(|_| node.parent_id.is_none()) {
            let flows = flows
                .as_array()
                .filter(|items| items.len() <= 100)
                .ok_or_else(|| invalid("invalid prototype flows"))?;
            let mut native = Vec::new();
            for flow in flows {
                let start = flow["start"]
                    .as_u64()
                    .and_then(|id| node_ids.get(&id))
                    .ok_or_else(|| invalid("invalid prototype flow destination"))?;
                native.push(json!({"name":string(flow, "name")?,"start":start,"description":flow["description"].as_str().unwrap_or("")}));
            }
            if !native.is_empty() {
                node.properties
                    .insert("prototypeFlows".into(), json!(native));
            }
        }
        if let Some(interactions) = record
            .get("interactions")
            .filter(|_| node.parent_id.is_some())
        {
            prototype_archive::decode(node, interactions, &node_ids)?;
        }
    }
    content.validate().map_err(invalid)?;
    comments::decode(file, &mut content, &node_ids, page_ids, comments, current_snapshot)?;
    let marked = content
        .nodes
        .values()
        .filter(|node| {
            node.string(dev_status::STATUS) == Some("readyForDev")
                && !node.properties.contains_key(dev_status::BASELINE)
        })
        .map(|node| node.id.clone())
        .collect::<Vec<_>>();
    if !marked.is_empty() {
        let tree = dev_status::Tree::new(&content.nodes);
        let baselines = marked
            .into_iter()
            .map(|id| {
                let baseline = tree.hash(&id);
                (id, baseline)
            })
            .collect::<Vec<_>>();
        for (id, baseline) in baselines {
            content
                .nodes
                .get_mut(&id)
                .unwrap()
                .properties
                .insert(dev_status::BASELINE.into(), json!(baseline));
        }
    }
    Ok((content, current))
}

pub(crate) fn read_properties(node: &Value, kind: &str) -> Result<Properties> {
    let mut out = Properties::from([("name".into(), node["name"].clone())]);
    read_design_properties(node, &mut out)?;
    if kind == "page" {
        if let Some(background) = node.get("background") {
            out.insert("fill".into(), json!(read_color(background)?));
        }
        if let Some(settings) = node.get("prototype")
            && let Some(native) = prototype_settings::decode_archive_settings(settings)?
        {
            out.insert(PROTOTYPE_SETTINGS.into(), native);
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
                | "strokes"
                | "stroke"
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
                | "annotations"
                | "dev_resources"
                | "dev_status"
                | "dev_changed"
                | "dev_note"
                | "guides"
                | "grids"
                | "exports"
                | "interactions"
                | "plugin_data"
        ) {
            return Err(unsupported(format!("layer property {key}")));
        }
    }
    if let Some(data) = node.get("plugin_data") {
        let marker = data
            .as_object()
            .filter(|data| data.keys().all(|key| key == "figcraft.thumbnail"))
            .ok_or_else(|| unsupported("layer plugin data"))?;
        if marker.get("figcraft.thumbnail").and_then(Value::as_str) == Some("true") {
            out.insert("figThumbnail".into(), json!(true));
        }
    }
    for (source, destination, limit) in [
        ("annotations", "annotations", 64),
        ("dev_resources", "devResources", 32),
    ] {
        if let Some(entries) = node.get(source) {
            if entries.as_array().is_none_or(|values| {
                values.len() > limit || values.iter().any(|value| !value.is_object())
            }) {
                return Err(invalid(format!("invalid {source}")));
            }
            out.insert(destination.into(), entries.clone());
        }
    }
    if let Some(status) = node.get("dev_status") {
        let status = dev_status::parse(status)?;
        if !status.is_null() {
            out.insert(dev_status::STATUS.into(), status);
        }
    }
    if node
        .get("dev_changed")
        .is_some_and(|value| !value.is_boolean())
    {
        return Err(invalid("dev_changed must be boolean"));
    }
    if node["dev_changed"] == true && out.get(dev_status::STATUS) == Some(&json!("readyForDev")) {
        out.insert(
            dev_status::BASELINE.into(),
            json!(dev_status::ARCHIVE_CHANGED),
        );
    }
    if let Some(note) = node.get("dev_note") {
        if note.as_str().is_none_or(|note| note.len() > 16_000) {
            return Err(invalid("invalid dev_note"));
        }
        out.insert(dev_status::NOTE.into(), note.clone());
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
    if node.get("stroke").is_some() || node.get("strokes").is_some() {
        let stroke = &node["stroke"];
        let strokes = node["strokes"]
            .as_array()
            .ok_or_else(|| invalid("strokes must be an array"))?;
        if kind != "line"
            || strokes.len() != 1
            || stroke["align"] != "center"
            || !stroke["sides"].is_null()
            || stroke["cap_start"] != "none"
            || stroke["cap_end"] != "none"
            || stroke["join"] != "miter"
            || stroke["miter_limit"].as_f64() != Some(4.)
            || stroke["dashes"]
                .as_array()
                .is_none_or(|dashes| !dashes.is_empty())
            || stroke.as_object().is_none_or(|fields| fields.len() != 8)
        {
            return Err(unsupported(
                "stroke settings beyond a single centered line stroke",
            ));
        }
        let paint = &strokes[0];
        if paint["type"] != "solid"
            || paint.get("blend").is_some_and(|blend| blend != "normal")
            || paint["visible"] == false
            || paint["opacity"].as_f64().unwrap_or(1.) != 1.
        {
            return Err(unsupported("non-default line stroke paint"));
        }
        let weight = stroke["weight"]
            .as_f64()
            .filter(|weight| *weight > 0.)
            .ok_or_else(|| invalid("line stroke weight must be positive"))?;
        out.insert("stroke".into(), json!(read_color(&paint["color"])?));
        out.insert("strokeWidth".into(), json!(weight));
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

pub(crate) fn read_color(color: &Value) -> Result<String> {
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

fn encode(snapshot: &DocumentSnapshot, page: &str, thumbnail: Option<&[u8]>) -> Result<Vec<u8>> {
    let mut ids = BTreeMap::new();
    let document =
        serde_json::to_vec(&encode_wire_document(snapshot, page, &mut ids, 0)?).map_err(invalid)?;
    write_archive(&document, thumbnail)
}

pub fn encode_wire_document(
    snapshot: &DocumentSnapshot,
    page: &str,
    ids: &mut BTreeMap<String, usize>,
    client: u32,
) -> Result<Value> {
    encode_wire_document_with_comments(snapshot, page, ids, client, &mut WireComments::default())
}

pub fn encode_wire_document_with_comments(
    snapshot: &DocumentSnapshot,
    page: &str,
    ids: &mut BTreeMap<String, usize>,
    client: u32,
    comments: &mut WireComments,
) -> Result<Value> {
    if snapshot
        .metadata
        .keys()
        .any(|key| !matches!(key.as_str(), "annotationCategories" | "colorProfile") && !key.starts_with("comments/"))
    {
        return Err(unsupported("document-level styles or metadata"));
    }
    if snapshot.nodes.len() > MAX_NODES {
        return Err(invalid("document exceeds the archive node limit"));
    }
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
    let prefix = (client as u64) << 32;
    let mut next = ids
        .values()
        .copied()
        .filter(|id| (*id as u64) >> 32 == u64::from(client))
        .max()
        .map(|id| id as u64 + 1)
        .unwrap_or(prefix + 1);
    while let Some(raw) = pending.pop() {
        pending.extend(
            child_ids
                .get(raw.as_str())
                .into_iter()
                .flatten()
                .rev()
                .map(|node| node.id.clone()),
        );
        if let std::collections::btree_map::Entry::Vacant(slot) = ids.entry(raw) {
            if next >> 32 != u64::from(client) {
                return Err(invalid("FigCraft node id space exhausted"));
            }
            slot.insert(
                usize::try_from(next)
                    .map_err(|_| invalid("FigCraft node id exceeds platform size"))?,
            );
            next += 1;
        }
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
    let dev_tree = snapshot
        .nodes
        .values()
        .any(|node| node.properties.contains_key(dev_status::BASELINE))
        .then(|| dev_status::Tree::new(&snapshot.nodes));
    for (raw, node) in &snapshot.nodes {
        let id = ids[raw];
        let children = child_ids
            .get(raw.as_str())
            .into_iter()
            .flatten()
            .map(|node| ids[&node.id])
            .collect::<Vec<_>>();
        let mut record = if node.parent_id.is_none() {
            if node.properties.keys().any(|key| {
                !matches!(
                    key.as_str(),
                    "name"
                        | "fill"
                        | "prototypeFlows"
                        | PROTOTYPE_SETTINGS
                        | "guides"
                        | "layoutGrids"
                        | "exports"
                )
            }) {
                return Err(unsupported("page properties"));
            }
            let page = snapshot
                .pages
                .iter()
                .find(|page| page.root_node_id == *raw)
                .unwrap();
            let mut flows = Vec::new();
            if let Some(entries) = node
                .properties
                .get("prototypeFlows")
                .and_then(Value::as_array)
            {
                for flow in entries {
                    if let Some(start) = flow["start"].as_str().and_then(|raw| ids.get(raw)) {
                        flows.push(json!({"name":flow["name"],"start":start,"description":flow["description"]}));
                    }
                }
            }
            let prototype = node.properties.get(PROTOTYPE_SETTINGS)
                .map(prototype_settings::encode_archive_settings).transpose()?
                .unwrap_or_else(|| json!({"device":"None","background":{"r":0.118,"g":0.118,"b":0.118,"a":1},"rotation":"portrait"}));
            json!({"id":id,"name":page.title,"type":"page","background":encode_color(node.string("fill").unwrap_or("#F5F5F5"))?,
                "flows":flows,"prototype":prototype,"children":children,"width":0,"height":0})
        } else {
            let mut record = write_properties(node, id)?;
            if node.string(dev_status::STATUS) == Some("readyForDev")
                && let Some(baseline) = node.string(dev_status::BASELINE)
                && dev_tree
                    .as_ref()
                    .is_some_and(|tree| baseline != tree.hash(raw))
            {
                record["dev_changed"] = json!(true);
            }
            if let Some(interactions) = node.properties.get(PROTOTYPE_INTERACTIONS) {
                record["interactions"] = prototype_archive::encode(interactions, ids)?;
            } else if let Some(target) = node
                .string("prototypeClickTargetId")
                .and_then(|raw| ids.get(raw))
            {
                record["interactions"] = json!([{"trigger":{"type":"onClick"},"actions":[{"type":"navigate","dest":target}],
                    "transition":{"type":"instant"},"duration_ms":300,"easing":"easeInOut"}]);
            }
            if node.properties.get("figThumbnail") == Some(&Value::Bool(true)) {
                record["plugin_data"] = json!({"figcraft.thumbnail":"true"});
            }
            record["parent"] = json!(ids[node.parent_id.as_ref().unwrap()]);
            if !children.is_empty() {
                record["children"] = json!(children);
            }
            record
        };
        write_design_properties(node, &mut record)?;
        nodes.insert(id.to_string(), record);
    }
    let mut document = json!({"format":"figcraft","version":1,"imageIndex":[],"name":snapshot.title,"pages":pages,
        "nodes":nodes,"next_id":nodes.keys().filter_map(|key|key.parse::<u64>().ok()).max().unwrap_or(0).saturating_add(1),"styles":[],"variables":{"collections":[],"variables":[]},"current_page":current,"document_colors":[],"comments":[]});
    document["comments"] = comments::encode(snapshot, ids, client, comments)?;
    let profile = omc_style::ColorProfile::from_metadata(&snapshot.metadata);
    if profile != omc_style::ColorProfile::Srgb {
        document["color_profile"] = json!(profile.name());
    }
    if let Some(categories) = snapshot
        .metadata
        .get("annotationCategories")
        .and_then(Value::as_array)
    {
        let mut records = Vec::new();
        for category in categories {
            records.push(json!({"id":category["id"],"name":category["name"],"color":encode_color(string(category, "color")?)?}));
        }
        document["annotation_categories"] = json!(records);
    }
    Ok(document)
}

fn write_archive(document: &[u8], thumbnail: Option<&[u8]>) -> Result<Vec<u8>> {
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
    archive.write_all(document).map_err(invalid)?;
    if let Some(thumbnail) = thumbnail {
        archive
            .start_file(
                "thumbnail.png",
                SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored),
            )
            .map_err(invalid)?;
        archive.write_all(thumbnail).map_err(invalid)?;
    }
    Ok(archive.finish().map_err(invalid)?.into_inner())
}

fn read_design_properties(node: &Value, out: &mut Properties) -> Result<()> {
    if let Some(guides) = node.get("guides") {
        let guides = guides
            .as_array()
            .filter(|guides| {
                guides.len() <= 10_000
                    && guides.iter().all(|guide| {
                        guide["vertical"].is_boolean()
                            && guide["offset"]
                                .as_f64()
                                .is_some_and(|value| value.abs() <= 1e7)
                    })
            })
            .ok_or_else(|| invalid("invalid guides"))?;
        if !guides.is_empty() {
            out.insert("guides".into(), json!(guides));
        }
    }
    if let Some(grids) = node.get("grids") {
        let grids = grids
            .as_array()
            .filter(|grids| grids.len() <= 128)
            .ok_or_else(|| invalid("invalid layout grids"))?;
        let mut result = Vec::with_capacity(grids.len());
        for grid in grids {
            let mut grid = grid.clone();
            if !grid.is_object() {
                return Err(invalid("invalid layout grid"));
            }
            if let Some(color) = grid.get("color") {
                grid["color"] = json!(read_color(color)?);
            }
            result.push(grid);
        }
        if !result.is_empty() {
            out.insert("layoutGrids".into(), json!(result));
        }
    }
    if let Some(exports) = node.get("exports") {
        let exports = exports
            .as_array()
            .filter(|exports| exports.len() <= 1000)
            .ok_or_else(|| invalid("invalid export settings"))?;
        let mut result = Vec::with_capacity(exports.len());
        for export in exports {
            let mut export = export.clone();
            if !export.is_object() {
                return Err(invalid("invalid export setting"));
            }
            if export["size"].is_null() {
                export["size"] = json!({"by":"scale","value":1});
            }
            if export["format"] == "vectorDrawable" {
                export["format"] = json!("xml");
            }
            if let Some(print) = export.as_object_mut().unwrap().remove("print") {
                for key in ["bleed", "cropMarks", "bleedMarks", "cmyk"] {
                    if let Some(value) = print.get(key) {
                        export[key] = value.clone();
                    }
                }
            }
            result.push(super::figcraft::normalize_fig_export_setting(&export)?);
        }
        if !result.is_empty() {
            out.insert("exports".into(), json!(result));
        }
    }
    Ok(())
}

fn write_design_properties(node: &Node, record: &mut Value) -> Result<()> {
    if let Some(guides) = node
        .properties
        .get("guides")
        .filter(|guides| guides.as_array().is_some_and(|guides| !guides.is_empty()))
    {
        record["guides"] = guides.clone();
    }
    if let Some(grids) = node
        .properties
        .get("layoutGrids")
        .and_then(Value::as_array)
        .filter(|grids| !grids.is_empty())
    {
        let mut result = Vec::with_capacity(grids.len());
        for grid in grids {
            let mut grid = grid.clone();
            if !grid.is_object() {
                return Err(invalid("invalid layout grid"));
            }
            if let Some(color) = grid["color"].as_str() {
                grid["color"] = encode_color(color)?;
            }
            if let Some(align) = match grid["align"].as_str() {
                Some("start") => Some("min"),
                Some("end") => Some("max"),
                _ => None,
            } {
                grid["align"] = json!(align);
            }
            result.push(grid);
        }
        record["grids"] = json!(result);
    }
    if let Some(exports) = node
        .properties
        .get("exports")
        .and_then(Value::as_array)
        .filter(|exports| !exports.is_empty())
    {
        let mut result = Vec::with_capacity(exports.len());
        for export in exports {
            let mut export = export.clone();
            if !export.is_object() {
                return Err(invalid("invalid export setting"));
            }
            if export["format"] == "xml" {
                export["format"] = json!("vectorDrawable");
            }
            let mut print = serde_json::Map::new();
            for key in ["bleed", "cropMarks", "bleedMarks", "cmyk"] {
                if let Some(value) = export.as_object_mut().unwrap().remove(key) {
                    print.insert(key.into(), value);
                }
            }
            if !print.is_empty() {
                export["print"] = Value::Object(print);
            }
            result.push(export);
        }
        record["exports"] = json!(result);
    }
    Ok(())
}

pub(crate) fn write_properties(node: &Node, id: usize) -> Result<Value> {
    let kind = match node.kind {
        NodeKind::Frame => "frame",
        NodeKind::Group => "group",
        NodeKind::Rect => "rectangle",
        NodeKind::Ellipse => "ellipse",
        NodeKind::Line => "line",
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
                | "annotations"
                | "devResources"
                | dev_status::STATUS
                | dev_status::BASELINE
                | dev_diff::SNAPSHOT
                | dev_status::NOTE
                | "guides"
                | "layoutGrids"
                | "exports"
                | "prototypeClickTargetId"
                | PROTOTYPE_INTERACTIONS
                | "figThumbnail"
        ) && !(kind == "line" && matches!(key.as_str(), "stroke" | "strokeWidth"))
        {
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
    for (source, destination) in [
        ("opacity", "opacity"),
        ("visible", "visible"),
        ("locked", "locked"),
        ("annotations", "annotations"),
        ("devResources", "dev_resources"),
        (dev_status::STATUS, "dev_status"),
        (dev_status::NOTE, "dev_note"),
    ] {
        if let Some(value) = node.properties.get(source) {
            record[destination] = value.clone();
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
    } else if kind == "line" {
        let color = node.string("stroke").unwrap_or("#000000");
        let width = node.number("strokeWidth", 1.);
        if width <= 0. {
            return Err(unsupported("invisible line strokes"));
        }
        record["strokes"] = json!([
            {"type":"solid", "color":encode_color(color)?, "opacity":1, "visible":true, "blend":"normal"}
        ]);
        record["stroke"] = json!({"weight":width, "align":"center", "sides":null,
            "cap_start":"none", "cap_end":"none", "join":"miter", "miter_limit":4, "dashes":[]});
    } else if kind == "ellipse" {
        record["start"] = json!(0.);
        record["sweep"] = json!(std::f64::consts::TAU);
        record["inner"] = json!(0.);
    }
    Ok(record)
}

pub(crate) fn encode_color(value: &str) -> Result<Value> {
    let color = omc_style::parse_color(value)
        .ok_or_else(|| unsupported("a color outside the native CSS color grammar"))?;
    Ok(json!({"r":color.r,"g":color.g,"b":color.b,"a":color.a}))
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
