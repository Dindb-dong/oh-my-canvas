use super::*;
use base64::Engine;
use omc_export::{ExportArtifact, ExportOptions};
use omc_import::ImportOptions;
use std::{io::Write, path::Path};

mod replica;

impl ToolRouter {
    pub fn import_bytes_native(
        &self,
        session: &str,
        format: &str,
        bytes: &[u8],
        title: Option<&str>,
        strict: bool,
    ) -> Result<(DocumentSnapshot, Value)> {
        self.import_bytes_job(session, format, bytes, title, strict, None)
    }
    pub(crate) fn import_bytes_job(
        &self,
        session: &str,
        format: &str,
        bytes: &[u8],
        title: Option<&str>,
        strict: bool,
        job: Option<&omc_workspace::jobs::JobContext>,
    ) -> Result<(DocumentSnapshot, Value)> {
        if format == "omc" {
            let value = serde_json::from_slice::<Value>(bytes)
                .map_err(|error| EngineError::invalid(error.to_string()))?;
            if value["format"] == replica::FORMAT {
                return self
                    .import_replica(session, value, title, job)
                    .map(|snapshot| (snapshot, json!([])));
            }
        }
        let imported = omc_import::import_bytes(
            format,
            bytes,
            &ImportOptions {
                strict,
                max_input_bytes: 256 * 1024 * 1024,
                ..Default::default()
            },
        )
        .map_err(|e| EngineError::invalid(e.to_string()))?;
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
        let mut content = imported.content;
        if let Some(title) = title {
            content.title = title.into();
        }
        if let Some(job) = job {
            job.begin_commit()?;
        }
        let snapshot = self
            .workspace
            .create(session, &content.title.clone(), Some(content))?;
        if let Some(job) = job {
            job.mark_committed();
        }
        Ok((snapshot, json!(imported.diagnostics)))
    }
    pub(crate) fn import_document(self: &Arc<Self>, session: &str, args: Value) -> Result<Value> {
        if let Some(path) = args["filePath"].as_str() {
            let size = std::fs::metadata(path).map_err(resources::io_error)?.len();
            if size > 4 * 1024 * 1024 {
                let reserve = usize::try_from(size)
                    .unwrap_or(usize::MAX)
                    .saturating_mul(2);
                let router = Arc::clone(self);
                let session = session.to_owned();
                let owner = session.clone();
                return self.workspace.submit_job(
                    &owner,
                    "import",
                    reserve,
                    Vec::new(),
                    move |job| {
                        job.check_cancelled()?;
                        job.progress(json!({"phase":"reading"}));
                        let bytes =
                            resources::read_explicit(string(&args, "filePath")?, 64 * 1024 * 1024)?;
                        job.check_cancelled()?;
                        router.import_tool_bytes(&session, &args, &bytes, Some(&job))
                    },
                );
            }
        }
        let bytes = if let Some(payload) = args["payload"].as_str() {
            payload.as_bytes().to_vec()
        } else {
            resources::read_explicit(string(&args, "filePath")?, 64 * 1024 * 1024)?
        };
        self.import_tool_bytes(session, &args, &bytes, None)
    }

    fn import_tool_bytes(
        &self,
        session: &str,
        args: &Value,
        bytes: &[u8],
        job: Option<&omc_workspace::jobs::JobContext>,
    ) -> Result<Value> {
        let format = string(args, "format")?;
        if format == "omc" {
            let value = serde_json::from_slice::<Value>(bytes)
                .map_err(|error| EngineError::invalid(error.to_string()))?;
            match value["format"].as_str() {
                Some(replica::FORMAT) => {
                    if args["mode"] == "copy" {
                        return Err(EngineError::invalid(
                            "a history package is imported by identity; export an independent copy with mode copy",
                        ));
                    }
                    let snapshot =
                        self.import_replica(session, value, args["title"].as_str(), job)?;
                    let mut result = self.context_from(session, &snapshot)?;
                    result["diagnostics"] = json!([]);
                    result["mode"] = "merge".into();
                    return Ok(result);
                }
                Some("oh-my-canvas") => {
                    return Err(EngineError::new(
                        "unsupported_feature",
                        "this Electron OMC file contains Yjs history; export canvas JSON in Electron for an independent native copy and review conversion diagnostics",
                    ));
                }
                _ if args["mode"] == "merge" => {
                    return Err(EngineError::new(
                        "unsupported_feature",
                        "this OMC snapshot has no causal operation history; import it as a copy or export a native document with mode merge",
                    ));
                }
                _ => {}
            }
        }
        let (snapshot, diagnostics) = self.import_bytes_job(
            session,
            format,
            bytes,
            args["title"].as_str(),
            args["strict"].as_bool().unwrap_or(true),
            job,
        )?;
        let mut result = self.context_from(session, &snapshot)?;
        result["diagnostics"] = diagnostics;
        Ok(result)
    }
    pub fn export_bytes_native(&self, document: &str, args: &Value) -> Result<ExportArtifact> {
        self.export_snapshot_native(self.workspace.snapshot(document)?, args)
    }

    pub fn thumbnail_png(&self, snapshot: &DocumentSnapshot) -> Result<Option<Vec<u8>>> {
        let Some(id) = snapshot
            .nodes
            .values()
            .find(|node| node.properties.get("figThumbnail") == Some(&Value::Bool(true)))
            .map(|node| &node.id)
        else {
            return Ok(None);
        };
        let mut root = &snapshot.nodes[id];
        while let Some(parent) = root
            .parent_id
            .as_ref()
            .and_then(|id| snapshot.nodes.get(id))
        {
            root = parent;
        }
        let Some(page) = snapshot
            .pages
            .iter()
            .find(|page| page.root_node_id == root.id)
        else {
            return Ok(None);
        };
        let scene = crate::paths::scene(snapshot, &page.id)?;
        let Some([x, y, width, height]) = scene.bounds(id) else {
            return Ok(None);
        };
        if width <= 0. || height <= 0. {
            return Ok(None);
        }
        let args = json!({
            "format":"png","pageId":page.id,"ids":[id],"scale":(128. / width.max(height)).min(4.),
            "bounds":{"x":x,"y":y,"width":width,"height":height},"strict":false,
        });
        self.export_snapshot_native(snapshot.clone(), &args)
            .map(|artifact| Some(artifact.bytes))
    }

    pub(crate) fn export_snapshot_native(
        &self,
        mut snapshot: DocumentSnapshot,
        args: &Value,
    ) -> Result<ExportArtifact> {
        let _profile_fonts = omc_text::font_scope(
            omc_text::session_fonts()
                .or_else(|| omc_text::profile_font_manager(&self.workspace.profile)),
        );
        let mut options = ExportOptions {
            format: args["format"].as_str().unwrap_or("png").into(),
            page_id: args["pageId"].as_str().map(str::to_owned),
            scale: args["scale"].as_f64().unwrap_or(1.),
            display_p3: args["colorProfile"] == "displayP3",
            svg_outline_text: args["svgOutlineText"] == true,
            svg_outline_strokes: args["svgSimplifyStroke"] == false,
            vector_drawable_compat: args["vdCompat"].as_str().map(str::to_owned),
            pdf_print: omc_export::PdfPrintOptions {
                bleed: args["bleed"].as_f64().unwrap_or(0.),
                crop_marks: args["cropMarks"] == true,
                bleed_marks: args["bleedMarks"] == true,
                cmyk: args["cmyk"] == true,
            },
            quality: (args["quality"].as_f64().unwrap_or(0.9) * 100.)
                .round()
                .clamp(0., 100.) as u32,
            strict: args["strict"].as_bool().unwrap_or(true),
            time_ms: args["timeMs"].as_f64().unwrap_or(0.),
            ..Default::default()
        };
        if let Some(width) = args["width"].as_f64() {
            options.width = width;
        }
        if let Some(height) = args["height"].as_f64() {
            options.height = height;
        }
        let bounds = args
            .get("bounds")
            .map(|bounds| {
                let field = |key| {
                    bounds[key]
                        .as_f64()
                        .ok_or_else(|| EngineError::invalid(format!("bounds {key} required")))
                };
                let rectangle = [field("x")?, field("y")?, field("width")?, field("height")?];
                if !rectangle.iter().all(|value| value.is_finite())
                    || rectangle[2] <= 0.
                    || rectangle[3] <= 0.
                {
                    return Err(EngineError::invalid(
                        "export bounds must be finite and positive",
                    ));
                }
                Ok(rectangle)
            })
            .transpose()?;
        let page_id = options
            .page_id
            .clone()
            .or_else(|| snapshot.pages.first().map(|page| page.id.clone()))
            .ok_or_else(|| EngineError::invalid("no export page"))?;
        let selected = args["ids"].as_array().filter(|ids| !ids.is_empty());
        let page_root = snapshot
            .pages
            .iter()
            .find(|page| page.id == page_id)
            .map(|page| page.root_node_id.clone())
            .ok_or_else(|| EngineError::invalid("export page not found"))?;
        let selected = selected.filter(|ids| ids.as_slice() != [json!(page_root)]);
        let mut backdrop_origin = (0., 0.);
        if let Some(ids) = selected {
            let ids = ids
                .iter()
                .map(|id| {
                    id.as_str()
                        .ok_or_else(|| EngineError::invalid("invalid layer ID"))
                })
                .collect::<Result<Vec<_>>>()?;
            let (result, [_, _, width, height]) =
                selection_snapshot(&snapshot, &page_id, &ids, bounds, options.strict)?;
            snapshot = result;
            options.page_id = None;
            options.width = width;
            options.height = height;
        } else if let Some([x, y, width, height]) = bounds {
            options.width = width;
            options.height = height;
            let root = snapshot
                .nodes
                .get_mut(&page_root)
                .ok_or_else(|| EngineError::invalid("export page has no root"))?;
            root.properties.insert("x".into(), json!(-x));
            root.properties.insert("y".into(), json!(-y));
            backdrop_origin = (x, y);
        }
        if !matches!(options.format.as_str(), "omc" | "json" | "native") {
            if args["omitFill"] == true
                || snapshot
                    .nodes
                    .values()
                    .any(|node| node.properties.get("omitFillOnExport") == Some(&Value::Bool(true)))
            {
                for node in snapshot.nodes.values_mut().filter(|node| {
                    node.kind == omc_model::NodeKind::Frame
                        && (args["omitFill"] == true
                            || node.properties.get("omitFillOnExport") == Some(&Value::Bool(true)))
                }) {
                    node.properties.insert("fill".into(), json!("transparent"));
                    for key in ["fills", "fillStyleId"] {
                        node.properties.remove(key);
                    }
                }
            }
            if let Some(background) = args["background"].as_str() {
                let color = omc_style::parse_color(background).ok_or_else(|| {
                    EngineError::invalid("export background must be a valid color")
                })?;
                let parent = if selected.is_some() {
                    snapshot.pages[0].root_node_id.clone()
                } else {
                    page_root
                };
                let mut layer = Node::new(omc_model::NodeKind::Rect);
                layer.rank = omc_model::rank_between(
                    None,
                    children(&snapshot, &parent)
                        .first()
                        .map(|node| node.rank.as_str()),
                )
                .ok_or_else(|| {
                    EngineError::new("resource_limit", "background ordering rank exhausted")
                })?;
                layer.parent_id = Some(parent);
                layer.properties = properties(&json!({
                    "x":backdrop_origin.0,"y":backdrop_origin.1,"width":options.width,"height":options.height,
                    "fill":format!("rgba({},{},{},{})",(color.r*255.).round(),(color.g*255.).round(),(color.b*255.).round(),color.a)
                }))?;
                snapshot.nodes.insert(layer.id.clone(), layer);
            }
        }
        apply_export_scale(args, &mut options)?;
        omc_export::export(&snapshot, &options, &self.resources()?)
            .map_err(|e| EngineError::new("unsupported_feature", e.to_string()))
    }
    pub(crate) fn export_document(&self, session: &str, id: &str, args: Value) -> Result<Value> {
        self.export_document_job(session, id, args, None)
    }
    pub(crate) fn export_document_job(
        &self,
        session: &str,
        id: &str,
        mut args: Value,
        job: Option<&omc_workspace::jobs::JobContext>,
    ) -> Result<Value> {
        if let Some(ids) = args["ids"].as_array() {
            let raw = ids
                .iter()
                .map(|value| self.resolve(session, id, value.as_str().unwrap_or_default()))
                .collect::<Result<Vec<_>>>()?;
            args["ids"] = json!(raw);
            if args.get("pageId").is_none() {
                args["pageId"] = self.state(session, id)?.page_id.into();
            }
        }
        let artifact = if args["mode"] == "merge" {
            self.export_replica(id, &args)?
        } else {
            self.export_bytes_native(id, &args)?
        };
        if let Some(job) = job {
            job.begin_commit()?;
        }
        self.deliver_export(session, &args, artifact)
    }
    pub(crate) fn export_tool(
        &self,
        session: &str,
        id: &str,
        name: &str,
        mut args: Value,
    ) -> Result<Value> {
        if name == "screenshot" {
            return self.legacy_screenshot(session, id, &args);
        }
        let page = self.state(session, id)?.page_id;
        if name == "get_html" {
            if let Some(layer) = args.as_object_mut().and_then(|args| args.remove("id")) {
                args["ids"] = json!([layer]);
            }
            args["format"] = "html".into();
        }
        args["pageId"] = page.into();
        self.export_document(session, id, args)
    }

    fn legacy_screenshot(&self, session: &str, id: &str, args: &Value) -> Result<Value> {
        use sha2::{Digest, Sha256};
        let snapshot = self.workspace.snapshot(id)?;
        let state = self.state(session, id)?;
        let scene = paths::scene(&snapshot, &state.page_id)?;
        let raw = args["id"]
            .as_str()
            .map(|id_value| self.resolve(session, id, id_value))
            .transpose()?;
        let layers = match raw.as_deref() {
            Some(raw) if raw != state.root => vec![
                scene
                    .items
                    .iter()
                    .position(|item| item.id == raw)
                    .ok_or_else(|| EngineError::invalid("layer is outside the selected page"))?,
            ],
            _ => scene.items[scene.root].children.clone(),
        };
        let [left, mut top, right, bottom] = layers
            .iter()
            .filter_map(|&index| {
                let item = &scene.items[index];
                let [x, y, width, height] = item.bounds;
                (!item.hidden).then_some([x, y, x + width, y + height])
            })
            .reduce(|[x, y, r, b], [nx, ny, nr, nb]| [x.min(nx), y.min(ny), r.max(nr), b.max(nb)])
            .ok_or_else(|| EngineError::invalid("no visible layer available for screenshot"))?;
        let width = (right - left).max(1.);
        let mut height = (bottom - top).max(1.);
        let (scale, slices) = if args["mode"] == "overview" {
            ((340_000. / (width * height)).sqrt().min(1.), 1)
        } else {
            let slices = ((height - 120.) / 1448.).ceil().max(1.) as u64;
            let slice = args["slice"].as_u64().unwrap_or(0).min(slices - 1);
            let offset = slice as f64 * 1448.;
            top += offset;
            height = (height - offset).clamp(1., 1568.);
            (1., slices)
        };
        let pixel_width = (width * scale).ceil().max(1.);
        let pixel_height = (height * scale).ceil().max(1.);
        if !pixel_width.is_finite()
            || !pixel_height.is_finite()
            || pixel_width.max(pixel_height) > 16_384.
            || pixel_width * pixel_height > 32_000_000.
        {
            return Err(EngineError::new(
                "resource_limit",
                "screenshot dimensions exceed the renderer limit",
            ));
        }
        let mut surface =
            skia_safe::surfaces::raster_n32_premul((pixel_width as i32, pixel_height as i32))
                .ok_or_else(|| {
                    EngineError::new("resource_limit", "screenshot surface allocation failed")
                })?;
        let canvas = surface.canvas();
        canvas.clear(skia_safe::Color::TRANSPARENT);
        canvas.scale((scale as f32, scale as f32));
        canvas.translate((-left as f32, -top as f32));
        let diagnostics =
            omc_render::paint_scene_layers(canvas, &scene, &layers, &self.resources()?)
                .map_err(|e| EngineError::invalid(e.to_string()))?;
        let bytes = surface
            .image_snapshot()
            .encode(None, skia_safe::EncodedImageFormat::PNG, 100)
            .ok_or_else(|| EngineError::new("internal_error", "screenshot PNG encoding failed"))?
            .as_bytes()
            .to_vec();
        let sha256 = hex::encode(Sha256::digest(&bytes));
        let mut result = self.artifact_result(
            session,
            ExportArtifact {
                bytes,
                media_type: "image/png".into(),
                extension: "png".into(),
                diagnostics,
                epoch: snapshot.epoch,
                sequence: snapshot.sequence,
                sha256,
            },
        )?;
        result["slices"] = slices.into();
        Ok(result)
    }

    pub(crate) fn deliver_export(
        &self,
        session: &str,
        args: &Value,
        artifact: ExportArtifact,
    ) -> Result<Value> {
        if let Some(path) = args["filePath"].as_str() {
            write_explicit(
                path,
                &artifact.bytes,
                args["overwrite"].as_bool().unwrap_or(false),
            )?;
            return Ok(
                json!({"ok":true,"filePath":path,"byteLength":artifact.bytes.len(),"sha256":artifact.sha256,"revision":{"epoch":artifact.epoch,"sequence":artifact.sequence.to_string()},"diagnostics":artifact.diagnostics}),
            );
        }
        self.artifact_result(session, artifact)
    }
    fn artifact_result(&self, session: &str, artifact: ExportArtifact) -> Result<Value> {
        let mut result = json!({"ok":true,"format":artifact.extension,"mimeType":artifact.media_type,"byteLength":artifact.bytes.len(),"sha256":artifact.sha256,"revision":{"epoch":artifact.epoch,"sequence":artifact.sequence.to_string()},"diagnostics":artifact.diagnostics});
        if artifact.bytes.len() > 360 * 1024 {
            let result_id =
                self.extensions
                    .put_result(session, artifact.bytes, artifact.media_type)?;
            result["resultId"] = result_id.into();
            result["delivery"] = "native_result.read".into();
        } else if artifact.media_type.starts_with("text/")
            || artifact.extension == "omc"
            || artifact.extension == "svg"
        {
            result["content"] = String::from_utf8(artifact.bytes)
                .map_err(|_| EngineError::new("corrupt_state", "text output is not UTF-8"))?
                .into();
        } else {
            result["base64"] = base64::engine::general_purpose::STANDARD
                .encode(artifact.bytes)
                .into();
        }
        Ok(result)
    }
}
fn selection_snapshot(
    snapshot: &DocumentSnapshot,
    page: &str,
    selected: &[&str],
    explicit_bounds: Option<[f64; 4]>,
    strict: bool,
) -> Result<(DocumentSnapshot, [f64; 4])> {
    let scene = paths::scene(snapshot, page)?;
    let projection = omc_scene::resolve_components(snapshot, Some(page));
    let selected: std::collections::BTreeSet<_> = selected.iter().copied().collect();
    let indices: BTreeMap<_, _> = scene
        .items
        .iter()
        .enumerate()
        .map(|(index, item)| (item.id.as_str(), index))
        .collect();
    let mut roots = selected
        .iter()
        .map(|id| {
            let index = *indices
                .get(id)
                .ok_or_else(|| EngineError::invalid("selection outside current page"))?;
            let mut current = scene.items[index].parent;
            while let Some(parent) = current {
                let item = &scene.items[parent];
                if selected.contains(item.id.as_str()) {
                    return Ok(None);
                }
                current = item.parent;
            }
            Ok(Some(index))
        })
        .collect::<Result<Vec<_>>>()?
        .into_iter()
        .flatten()
        .collect::<Vec<_>>();
    roots.sort_unstable();
    let bounds = if let Some(bounds) = explicit_bounds {
        bounds
    } else {
        let [left, top, right, bottom] = roots
            .iter()
            .map(|&index| {
                let [x, y, w, h] = scene.items[index].bounds;
                [x, y, x + w, y + h]
            })
            .reduce(|[x, y, r, b], [nx, ny, nr, nb]| [x.min(nx), y.min(ny), r.max(nr), b.max(nb)])
            .ok_or_else(|| EngineError::invalid("empty export selection"))?;
        [left, top, (right - left).max(1.), (bottom - top).max(1.)]
    };
    let mut content = DocumentContent::empty("Selection");
    let root = content.pages[0].root_node_id.clone();
    let mut all = std::collections::BTreeSet::new();
    for (order, index) in roots.into_iter().enumerate() {
        let root_item = &scene.items[index];
        let mut pending = vec![index];
        while let Some(index) = pending.pop() {
            let item = &scene.items[index];
            let id = item.id.as_str();
            if !all.insert(id) {
                continue;
            }
            let mut node = projection
                .snapshot
                .nodes
                .get(id)
                .ok_or_else(|| EngineError::invalid("selected layer is unavailable"))?
                .clone();
            if node.properties.remove("boardConnector").is_some()
                && let Some(path) = item.properties.get("path")
            {
                node.properties.insert("path".into(), path.clone());
            }
            if node.properties.get("boardConnectorLabel") == Some(&Value::Bool(true))
                && id != root_item.id
            {
                node.properties.insert("x".into(), json!(item.local.0[4]));
                node.properties.insert("y".into(), json!(item.local.0[5]));
            }
            if id == root_item.id {
                let [a, b, c, d, x, y] = item.world.0;
                node.parent_id = Some(root.clone());
                node.rank = format!("{:032x}", ((order as u128) + 1) << 64);
                node.properties.extend(properties(&json!({
                    "x":x-bounds[0],"y":y-bounds[1],"width":item.width,"height":item.height,
                    "transform":[a,b,c,d,0.,0.]
                }))?);
            }
            pending.extend(item.children.iter().copied());
            content.nodes.insert(id.to_owned(), node);
        }
    }
    include_pattern_sources(&projection.snapshot, &scene, &root, &mut content, &mut all)?;
    if strict
        && let Some(diagnostic) = projection.diagnostics.iter().find(|diagnostic| {
            diagnostic.fidelity_lost
                && diagnostic
                    .node_id
                    .as_deref()
                    .is_some_and(|id| all.contains(id))
        })
    {
        return Err(EngineError::new(
            "dependency_unavailable",
            diagnostic.action.clone(),
        ));
    }
    Ok((
        DocumentSnapshot {
            id: snapshot.id.clone(),
            title: snapshot.title.clone(),
            epoch: snapshot.epoch.clone(),
            sequence: snapshot.sequence,
            pages: content.pages,
            nodes: content.nodes,
            metadata: snapshot.metadata.clone(),
        },
        bounds,
    ))
}

fn include_pattern_sources<'a>(
    snapshot: &'a DocumentSnapshot,
    scene: &'a omc_scene::Scene,
    root: &str,
    content: &mut DocumentContent,
    included: &mut std::collections::BTreeSet<&'a str>,
) -> Result<()> {
    let sources = |node: &Node| {
        node.properties
            .get("fills")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter(|paint| paint["type"] == "pattern")
            .filter_map(|paint| paint["source"].as_str().map(str::to_owned))
            .collect::<Vec<_>>()
    };
    let mut pending = content.nodes.values().flat_map(sources).collect::<Vec<_>>();
    while let Some(source) = pending.pop() {
        if included.contains(source.as_str()) {
            continue;
        }
        let Some(item) = scene.item(&source) else {
            continue;
        };
        let mut subtree = vec![item.id.as_str()];
        while let Some(id) = subtree.pop() {
            if !included.insert(id) {
                continue;
            }
            let mut node = snapshot.nodes[id].clone();
            if id == source {
                node.parent_id = Some(root.to_owned());
                node.properties.extend(properties(&json!({"patternOnly":true,"x":0,"y":0,"width":item.width,"height":item.height}))?);
            }
            pending.extend(sources(&node));
            subtree.extend(
                children(snapshot, id)
                    .into_iter()
                    .map(|child| child.id.as_str()),
            );
            content.nodes.insert(id.to_owned(), node);
        }
    }
    Ok(())
}

fn apply_export_scale(args: &Value, options: &mut ExportOptions) -> Result<()> {
    if let Some(constraint) = args.get("constraint") {
        let value = constraint["value"]
            .as_f64()
            .filter(|value| value.is_finite() && *value > 0.)
            .ok_or_else(|| EngineError::invalid("constraint value must be positive"))?;
        options.scale = match constraint["type"].as_str() {
            Some("scale") => value,
            Some("width") => value / options.width,
            Some("height") => value / options.height,
            _ => return Err(EngineError::invalid("constraint type required")),
        };
    }
    if let Some(limit) = args["maxSize"].as_u64().filter(|limit| *limit > 0) {
        options.scale = options
            .scale
            .min(limit as f64 / options.width.max(options.height));
    }
    Ok(())
}

pub(super) fn write_explicit(path: &str, bytes: &[u8], overwrite: bool) -> Result<()> {
    let destination = Path::new(path);
    if !destination.is_absolute() {
        return Err(EngineError::invalid("output filePath must be absolute"));
    }
    let parent = destination
        .parent()
        .ok_or_else(|| EngineError::invalid("invalid output path"))?;
    let temporary = parent.join(format!(".omc-export-{}", uuid::Uuid::new_v4().simple()));
    let result = (|| {
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(resources::io_error)?;
        file.write_all(bytes).map_err(resources::io_error)?;
        file.sync_all().map_err(resources::io_error)?;
        drop(file);
        if overwrite {
            if std::fs::symlink_metadata(destination)
                .is_ok_and(|m| !m.is_file() || m.file_type().is_symlink())
            {
                return Err(EngineError::invalid(
                    "overwrite target must be a regular file",
                ));
            }
            std::fs::rename(&temporary, destination).map_err(resources::io_error)?;
        } else {
            std::fs::hard_link(&temporary, destination).map_err(|e| {
                if e.kind() == std::io::ErrorKind::AlreadyExists {
                    EngineError::new("conflict", "output exists; overwrite must be explicit")
                } else {
                    resources::io_error(e)
                }
            })?;
        }
        omc_assets::sync_directory(parent)?;
        Ok(())
    })();
    let _ = std::fs::remove_file(temporary);
    result
}
