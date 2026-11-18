use super::*;
use omc_scene::{Scene, SceneItem};
use omc_style::Diagnostic;
use omc_workspace::jobs::JobContext;
use sha2::{Digest, Sha256};
use std::collections::{BTreeSet, btree_map::Entry};

pub(crate) const MAX_FRAMES: usize = 100;
const MAX_PDF_BYTES: usize = 64 * 1024 * 1024;

impl ToolRouter {
    pub(super) fn export_frame_pdf(
        &self,
        session: &str,
        id: &str,
        args: &Value,
        job: Option<&JobContext>,
    ) -> Result<(ExportArtifact, usize)> {
        if args["format"] != "pdf" {
            return Err(EngineError::invalid("pdfFrameIds requires PDF format"));
        }
        if args.as_object().is_some_and(|object| {
            object.keys().any(|key| {
                !matches!(
                    key.as_str(),
                    "id" | "format" | "pdfFrameIds" | "filePath" | "overwrite"
                )
            })
        }) {
            return Err(EngineError::invalid(
                "frame PDFs use their frame dimensions and cannot be combined with other export options",
            ));
        }
        let ids = args["pdfFrameIds"]
            .as_array()
            .filter(|ids| (1..=MAX_FRAMES).contains(&ids.len()))
            .ok_or_else(|| EngineError::invalid("pdfFrameIds requires 1–100 frame IDs"))?;
        let _profile_fonts = omc_text::font_scope(
            omc_text::session_fonts()
                .or_else(|| omc_text::profile_font_manager(&self.workspace.profile)),
        );
        let snapshot = self.workspace.snapshot(id)?;
        let mut used = BTreeSet::new();
        let mut scenes = BTreeMap::new();
        let mut targets = Vec::with_capacity(ids.len());
        for value in ids {
            let given = value
                .as_str()
                .ok_or_else(|| EngineError::invalid("frame ID must be a string"))?;
            let raw = if omc_model::valid_id(given, "node") {
                given.to_owned()
            } else {
                self.resolve(session, id, given)?
            };
            if !used.insert(raw.clone()) {
                return Err(EngineError::invalid(
                    "pdfFrameIds contains duplicate frames",
                ));
            }
            let page = crate::figcraft_catalog::node_page(&snapshot, &raw)
                .filter(|page| page.root_node_id != raw)
                .ok_or_else(|| EngineError::invalid("frame not found in this document"))?;
            if let Entry::Vacant(entry) = scenes.entry(page.id.as_str()) {
                if let Some(job) = job {
                    job.check_cancelled()?;
                }
                entry.insert(crate::paths::scene(&snapshot, &page.id)?);
            }
            targets.push((page.id.as_str(), raw));
        }
        let frames = targets.iter().map(|(page, raw)| {
            let scene = &scenes[page];
            let frame = scene
                .item(raw)
                .filter(|item| item.kind == omc_model::NodeKind::Frame)
                .filter(|item| {
                    std::iter::successors(Some(*item), |item| {
                        item.parent.map(|parent| &scene.items[parent])
                    })
                    .all(|item| !item.hidden)
                })
                .ok_or_else(|| EngineError::invalid("choose a visible frame in this document"))?;
            Ok((scene, frame))
        });
        let (bytes, diagnostics) = render(
            &snapshot.title,
            frames,
            &self.resources()?,
            MAX_PDF_BYTES,
            job,
        )?;
        Ok((
            ExportArtifact {
                sha256: hex::encode(Sha256::digest(&bytes)),
                bytes,
                media_type: "application/pdf".into(),
                extension: "pdf".into(),
                diagnostics,
                epoch: snapshot.epoch,
                sequence: snapshot.sequence,
            },
            ids.len(),
        ))
    }
}

pub(crate) fn render<'a>(
    title: &str,
    frames: impl IntoIterator<Item = Result<(&'a Scene, &'a SceneItem)>>,
    resources: &dyn omc_render::ResourceProvider,
    limit: usize,
    job: Option<&JobContext>,
) -> Result<(Vec<u8>, Vec<Diagnostic>)> {
    let mut output = BoundedPdf {
        bytes: Vec::new(),
        limit,
        exceeded: false,
    };
    let mut diagnostics = Vec::new();
    {
        let metadata = skia_safe::pdf::Metadata {
            title: title.into(),
            ..Default::default()
        };
        let mut document = skia_safe::pdf::new_document(&mut output, Some(&metadata));
        for frame in frames {
            if let Some(job) = job {
                job.check_cancelled()?;
            }
            let (scene, frame) = frame?;
            let [x, y, width, height] = frame.bounds;
            if !(0.01..=1_000_000.).contains(&width) || !(0.01..=1_000_000.).contains(&height) {
                return Err(EngineError::invalid(
                    "PDF frame dimensions are outside the supported range",
                ));
            }
            let mut page = document.begin_page((width as f32, height as f32), None);
            let canvas = page.canvas();
            canvas.translate((-x as f32, -y as f32));
            let page_diagnostics =
                omc_render::paint_scene_frame(canvas, scene, &frame.id, resources)
                    .map_err(|e| EngineError::invalid(e.to_string()))?;
            if page_diagnostics
                .iter()
                .any(|diagnostic| diagnostic.fidelity_lost)
            {
                return Err(EngineError::new(
                    "unsupported_feature",
                    "PDF rendering would lose frame content",
                ));
            }
            diagnostics.extend(page_diagnostics);
            document = page.end_page();
        }
        document.close();
    }
    if output.exceeded {
        return Err(EngineError::new(
            "resource_limit",
            "PDF exceeds the byte limit",
        ));
    }
    if !output.bytes.starts_with(b"%PDF-") {
        return Err(EngineError::invalid("PDF encoding failed"));
    }
    Ok((output.bytes, diagnostics))
}

struct BoundedPdf {
    bytes: Vec<u8>,
    limit: usize,
    exceeded: bool,
}

impl Write for BoundedPdf {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if self.exceeded || bytes.len() > self.limit - self.bytes.len() {
            self.exceeded = true;
            return Err(std::io::Error::other("PDF byte limit exceeded"));
        }
        self.bytes.extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exports_frames_across_document_pages_in_explicit_order() {
        let directory = tempfile::tempdir().unwrap();
        let workspace = Workspace::open(directory.path(), None).unwrap();
        let router = Arc::new(ToolRouter::new(workspace.clone()));
        let session = workspace.session_open(None).unwrap()["sessionId"]
            .as_str()
            .unwrap()
            .to_owned();
        let call = |name, args| router.call(&session, name, args, Value::Null).unwrap();
        let document = call("create_document", json!({"title":"Ordered frame PDF"}));
        let id = document["documentId"].as_str().unwrap();
        let native = native_id(id).unwrap();
        let frame = |width, height, color| {
            call(
                "create_shape",
                json!({"documentId":id,"type":"frame","x":150,"y":65,"width":width,"height":height,
                    "properties":{"fills":[{"type":"solid","color":color}]}}),
            )["rawIds"][0]
                .as_str()
                .unwrap()
                .to_owned()
        };
        let first = frame(110, 80, "#ff0000");
        call(
            "page",
            json!({"action":"create","documentId":id,"name":"Second"}),
        );
        let second_page = workspace.snapshot(&native).unwrap().pages[1].id.clone();
        call("select_page", json!({"id":second_page,"documentId":id}));
        let second = frame(205, 125, "#008000");
        let before = workspace.snapshot(&native).unwrap().revision();
        let args = json!({"id":id,"format":"pdf","pdfFrameIds":[second,first]});
        let result = router.export_document(&session, &native, args).unwrap();
        assert_eq!(result["pages"], 2);
        assert_eq!(result["mimeType"], "application/pdf");
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(result["base64"].as_str().unwrap())
            .unwrap();
        let pdf = String::from_utf8_lossy(&bytes);
        let first_on_paper = pdf.find("/MediaBox [0 0 205 125]").unwrap();
        let second_on_paper = pdf.find("/MediaBox [0 0 110 80]").unwrap();
        assert!(first_on_paper < second_on_paper);
        assert_eq!(workspace.snapshot(&native).unwrap().revision(), before);
        assert_eq!(
            router
                .export_document(
                    &session,
                    &native,
                    json!({"id":id,"format":"pdf","pdfFrameIds":[first,first]}),
                )
                .unwrap_err()
                .code,
            "invalid_argument"
        );
        assert_eq!(
            router
                .export_document(
                    &session,
                    &native,
                    json!({"id":id,"format":"png","pdfFrameIds":[first]}),
                )
                .unwrap_err()
                .code,
            "invalid_argument"
        );
    }
}
