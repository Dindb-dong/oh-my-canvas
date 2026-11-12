use super::*;
use base64::Engine;
use omc_export::{ExportArtifact, ExportOptions};
use omc_import::ImportOptions;
use std::{io::Write, path::Path};

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
        if args["mode"] == "merge" {
            return Err(EngineError::new(
                "unsupported_feature",
                "history-preserving package merge requires the snapshot-package extension",
            ));
        }
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
                        let (snapshot, diagnostics) = router.import_bytes_job(
                            &session,
                            string(&args, "format")?,
                            &bytes,
                            args["title"].as_str(),
                            true,
                            Some(&job),
                        )?;
                        job.mark_committed();
                        let mut result = router.context_from(&session, &snapshot)?;
                        result["diagnostics"] = diagnostics;
                        Ok(result)
                    },
                );
            }
        }
        let bytes = if let Some(payload) = args["payload"].as_str() {
            payload.as_bytes().to_vec()
        } else {
            resources::read_explicit(string(&args, "filePath")?, 64 * 1024 * 1024)?
        };
        let (snapshot, diagnostics) = self.import_bytes_native(
            session,
            string(&args, "format")?,
            &bytes,
            args["title"].as_str(),
            true,
        )?;
        let mut result = self.context_from(session, &snapshot)?;
        result["diagnostics"] = diagnostics;
        Ok(result)
    }
    pub fn export_bytes_native(&self, document: &str, args: &Value) -> Result<ExportArtifact> {
        let mut snapshot = self.workspace.snapshot(document)?;
        let mut options = ExportOptions {
            format: args["format"].as_str().unwrap_or("png").into(),
            page_id: args["pageId"].as_str().map(str::to_owned),
            scale: args["scale"].as_f64().unwrap_or(1.),
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
        if let Some(bounds) = args.get("bounds") {
            options.width = bounds["width"]
                .as_f64()
                .ok_or_else(|| EngineError::invalid("bounds width required"))?;
            options.height = bounds["height"]
                .as_f64()
                .ok_or_else(|| EngineError::invalid("bounds height required"))?;
            let dx = bounds["x"].as_f64().unwrap_or(0.);
            let dy = bounds["y"].as_f64().unwrap_or(0.);
            for page in &snapshot.pages {
                if let Some(root) = snapshot.nodes.get_mut(&page.root_node_id) {
                    root.properties.insert("x".into(), json!(-dx));
                    root.properties.insert("y".into(), json!(-dy));
                }
            }
        }
        if args["omitFill"] == true {
            for page in &snapshot.pages {
                if let Some(root) = snapshot.nodes.get_mut(&page.root_node_id) {
                    root.properties.insert("fill".into(), json!("transparent"));
                    root.properties.remove("fills");
                }
            }
        }
        if args.get("background").is_some() {
            return Err(EngineError::new(
                "unsupported_feature",
                "explicit export background is not yet available in this renderer profile",
            ));
        }
        apply_export_scale(args, &mut options)?;
        if args.get("ids").is_some() {
            return Err(EngineError::new(
                "unsupported_feature",
                "selection export requires resolved node scope",
            ));
        }
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
        args: Value,
        job: Option<&omc_workspace::jobs::JobContext>,
    ) -> Result<Value> {
        let artifact = self.export_bytes_native(id, &args)?;
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
        if name == "screenshot" && args["slice"].as_u64().is_some_and(|n| n != 0) {
            return Err(EngineError::new(
                "unsupported_feature",
                "slice screenshot pagination is not implemented",
            ));
        }
        let snapshot = self.workspace.snapshot(id)?;
        let page = self.state(session, id)?.page_id;
        let selected: Vec<String> = if name == "export_selection" {
            args["ids"]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| self.resolve(session, id, v.as_str().unwrap()))
                .collect::<Result<_>>()?
        } else {
            args["id"]
                .as_str()
                .map(|raw| self.resolve(session, id, raw))
                .transpose()?
                .into_iter()
                .collect()
        };
        if selected.is_empty() || selected == vec![self.state(session, id)?.root] {
            args.as_object_mut().unwrap().remove("id");
            args.as_object_mut().unwrap().remove("ids");
            args["pageId"] = page.into();
            args["format"] = if name == "get_html" {
                "html"
            } else if name == "screenshot" {
                "png"
            } else {
                args["format"].as_str().unwrap()
            }
            .to_owned()
            .into();
            return self.export_document(session, id, args);
        }
        if args.get("bounds").is_some()
            || args.get("background").is_some()
            || args["omitFill"] == true
        {
            return Err(EngineError::new(
                "unsupported_feature",
                "these selection output options are not yet qualified",
            ));
        }
        let mut content = DocumentContent::empty("Selection");
        let root = content.pages[0].root_node_id.clone();
        let mut all = std::collections::BTreeSet::new();
        let mut pending = selected.clone();
        while let Some(raw) = pending.pop() {
            if all.insert(raw.clone()) {
                pending.extend(children(&snapshot, &raw).iter().map(|n| n.id.clone()));
            }
        }
        let scene = omc_scene::build_scene(
            &snapshot,
            &omc_scene::SceneOptions {
                page_id: Some(page),
                ..Default::default()
            },
        )
        .map_err(|e| EngineError::invalid(e.to_string()))?;
        let selected: Vec<_> = selected
            .into_iter()
            .filter(|raw| {
                !snapshot.nodes[raw]
                    .parent_id
                    .as_ref()
                    .is_some_and(|p| all.contains(p))
            })
            .collect();
        let bounds: Vec<_> = selected
            .iter()
            .map(|raw| {
                scene
                    .bounds(raw)
                    .ok_or_else(|| EngineError::invalid("selection outside current page"))
            })
            .collect::<Result<_>>()?;
        let left = bounds.iter().map(|b| b[0]).fold(f64::INFINITY, f64::min);
        let top = bounds.iter().map(|b| b[1]).fold(f64::INFINITY, f64::min);
        let right = bounds
            .iter()
            .map(|b| b[0] + b[2])
            .fold(f64::NEG_INFINITY, f64::max);
        let bottom = bounds
            .iter()
            .map(|b| b[1] + b[3])
            .fold(f64::NEG_INFINITY, f64::max);
        for raw in all {
            let mut node = snapshot
                .nodes
                .get(&raw)
                .ok_or_else(|| EngineError::invalid("selected node unavailable"))?
                .clone();
            if selected.contains(&raw) {
                let bounds = scene.bounds(&raw).unwrap();
                node.parent_id = Some(root.clone());
                node.properties.insert("x".into(), json!(bounds[0] - left));
                node.properties.insert("y".into(), json!(bounds[1] - top));
            }
            content.nodes.insert(raw, node);
        }
        content.metadata = snapshot.metadata.clone();
        let selection = DocumentSnapshot {
            id: snapshot.id,
            title: snapshot.title,
            epoch: snapshot.epoch,
            sequence: snapshot.sequence,
            pages: content.pages,
            nodes: content.nodes,
            metadata: content.metadata,
        };
        let format = if name == "get_html" {
            "html"
        } else if name == "screenshot" {
            "png"
        } else {
            string(&args, "format")?
        };
        let mut options = ExportOptions {
            format: format.into(),
            width: (right - left).max(1.),
            height: (bottom - top).max(1.),
            scale: args["scale"].as_f64().unwrap_or(1.),
            quality: (args["quality"].as_f64().unwrap_or(0.9) * 100.).round() as u32,
            ..Default::default()
        };
        apply_export_scale(&args, &mut options)?;
        let artifact = omc_export::export(&selection, &options, &self.resources()?)
            .map_err(|e| EngineError::invalid(e.to_string()))?;
        self.deliver_export(session, &args, artifact)
    }

    fn deliver_export(
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
