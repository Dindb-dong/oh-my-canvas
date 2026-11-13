//! Deterministic outputs from one explicit immutable document revision.
mod code;
mod code_context;
mod platform_code;
mod print_pdf;
mod vector_drawable;
use base64::Engine;
pub use code::{export_html, export_react, inspect_web};
use omc_model::{DocumentContent, DocumentSnapshot};
use omc_render::{RasterFormat, RenderOptions, ResourceProvider};
use omc_scene::{SceneOptions, build_scene_in_color_profile};
use omc_style::Diagnostic;
pub use platform_code::{inspect_platform, platform_property};
pub use print_pdf::PdfPrintOptions;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExportOptions {
    pub format: String,
    pub page_id: Option<String>,
    pub width: f64,
    pub height: f64,
    pub scale: f64,
    pub time_ms: f64,
    pub quality: u32,
    #[serde(default)]
    pub display_p3: bool,
    #[serde(default)]
    pub svg_outline_text: bool,
    #[serde(default)]
    pub svg_outline_strokes: bool,
    #[serde(default)]
    pub vector_drawable_compat: Option<String>,
    #[serde(default)]
    pub pdf_print: PdfPrintOptions,
    pub strict: bool,
    pub max_surface_bytes: usize,
}
impl Default for ExportOptions {
    fn default() -> Self {
        Self {
            format: "png".into(),
            page_id: None,
            width: 1440.,
            height: 900.,
            scale: 1.,
            time_ms: 0.,
            quality: 90,
            display_p3: false,
            svg_outline_text: false,
            svg_outline_strokes: false,
            vector_drawable_compat: None,
            pdf_print: PdfPrintOptions::default(),
            strict: true,
            max_surface_bytes: 256 * 1024 * 1024,
        }
    }
}
#[derive(Clone, Debug)]
pub struct ExportArtifact {
    pub bytes: Vec<u8>,
    pub media_type: String,
    pub extension: String,
    pub diagnostics: Vec<Diagnostic>,
    pub epoch: String,
    pub sequence: u64,
    pub sha256: String,
}
#[derive(Debug, thiserror::Error)]
pub enum ExportError {
    #[error(transparent)]
    Scene(#[from] omc_scene::SceneError),
    #[error(transparent)]
    Render(#[from] omc_render::RenderError),
    #[error("export failed: {0}")]
    Invalid(String),
    #[error("resource unavailable: {0}")]
    Resource(String),
    #[error("unsupported export: {0}")]
    Unsupported(String),
}

pub fn export(
    snapshot: &DocumentSnapshot,
    options: &ExportOptions,
    resources: &dyn ResourceProvider,
) -> Result<ExportArtifact, ExportError> {
    let (bytes, media_type, extension, diagnostics) = match options
        .format
        .to_ascii_lowercase()
        .as_str()
    {
        "omc" | "native" | "json" => (
            export_native(snapshot, resources)?,
            "application/vnd.ohmycanvas.native+json",
            "omc",
            Vec::new(),
        ),
        "html" => {
            let (source, diagnostics) = export_html(snapshot, options.page_id.as_deref())?;
            let (source, diagnostics) = embed_source_assets(source, diagnostics, resources)?;
            (source.into_bytes(), "text/html", "html", diagnostics)
        }
        "react" | "jsx" => {
            let (source, diagnostics) = export_react(snapshot, options.page_id.as_deref(), false)?;
            let (source, diagnostics) = embed_source_assets(source, diagnostics, resources)?;
            (source.into_bytes(), "text/jsx", "jsx", diagnostics)
        }
        "tailwind" => {
            let (source, diagnostics) = export_react(snapshot, options.page_id.as_deref(), true)?;
            let (source, diagnostics) = embed_source_assets(source, diagnostics, resources)?;
            (source.into_bytes(), "text/jsx", "jsx", diagnostics)
        }
        format => {
            let profile = if matches!(format, "png" | "jpg" | "jpeg" | "webp") {
                omc_style::ColorProfile::from_metadata(&snapshot.metadata)
            } else {
                omc_style::ColorProfile::Srgb
            };
            let mut scene = build_scene_in_color_profile(
                snapshot,
                &SceneOptions {
                    page_id: options.page_id.clone(),
                    width: options.width,
                    height: options.height,
                    time_ms: options.time_ms,
                    strict: options.strict,
                },
                profile,
            )?;
            let render_options = RenderOptions {
                scale: options.scale,
                background: None,
                max_surface_bytes: options.max_surface_bytes,
            };
            let mut diagnostics = scene.diagnostics.clone();
            let (bytes, media_type, extension) = match format {
                "png" => {
                    let (b, d) = omc_render::render_encoded_with_profile(
                        &scene,
                        &render_options,
                        resources,
                        RasterFormat::Png,
                        options.quality,
                        options.display_p3,
                    )?;
                    diagnostics = d;
                    (b, "image/png", "png")
                }
                "jpeg" | "jpg" => {
                    let (b, d) = omc_render::render_encoded_with_profile(
                        &scene,
                        &RenderOptions {
                            background: Some([1., 1., 1., 1.]),
                            ..render_options
                        },
                        resources,
                        RasterFormat::Jpeg,
                        options.quality,
                        options.display_p3,
                    )?;
                    diagnostics = d;
                    (b, "image/jpeg", "jpg")
                }
                "webp" => {
                    let (b, d) = omc_render::render_encoded_with_profile(
                        &scene,
                        &render_options,
                        resources,
                        RasterFormat::Webp,
                        options.quality,
                        options.display_p3,
                    )?;
                    diagnostics = d;
                    (b, "image/webp", "webp")
                }
                "pdf" => {
                    let (b, d) = if options.pdf_print == PdfPrintOptions::default() {
                        omc_render::render_pdf_with_diagnostics(&scene, resources)?
                    } else {
                        print_pdf::export(
                            &scene,
                            resources,
                            options.pdf_print,
                            options.max_surface_bytes,
                        )?
                    };
                    diagnostics = d;
                    (b, "application/pdf", "pdf")
                }
                "svg" | "xml" => {
                    if scene
                        .items
                        .iter()
                        .any(|i| i.style.get("filter").is_some_and(|f| f != "none"))
                    {
                        return Err(ExportError::Unsupported(
                            "SVG filter conversion requires an explicit rasterization policy"
                                .into(),
                        ));
                    }
                    if !options.scale.is_finite() || !(0. < options.scale && options.scale <= 64.) {
                        return Err(ExportError::Invalid(
                            "SVG scale must be greater than 0 and at most 64".into(),
                        ));
                    }
                    if options.svg_outline_strokes {
                        for item in &mut scene.items {
                            item.properties
                                .insert("_svgOutlineStroke".into(), json!(true));
                        }
                    }
                    let canvas = skia_safe::svg::Canvas::new(
                        skia_safe::Rect::from_wh(
                            (scene.width * options.scale) as f32,
                            (scene.height * options.scale) as f32,
                        ),
                        (format == "xml" || options.svg_outline_text)
                            .then_some(skia_safe::svg::canvas::Flags::CONVERT_TEXT_TO_PATHS),
                    );
                    canvas.scale((options.scale as f32, options.scale as f32));
                    diagnostics.extend(omc_render::paint_scene(&canvas, &scene, resources)?);
                    let bytes = canvas.end().as_bytes().to_vec();
                    if format == "xml" {
                        let (drawable, warnings) = vector_drawable::convert(
                            &bytes,
                            scene.width * options.scale,
                            scene.height * options.scale,
                            options
                                .vector_drawable_compat
                                .as_deref()
                                .unwrap_or("bestEffort"),
                        )?;
                        diagnostics.extend(warnings.into_iter().map(|warning| Diagnostic {
                            code: "vector_drawable_compatibility".into(),
                            severity: "warning".into(),
                            node_id: None,
                            property: None,
                            original: warning.clone(),
                            action: warning,
                            fidelity_lost: false,
                        }));
                        (drawable, "application/xml", "xml")
                    } else {
                        (bytes, "image/svg+xml", "svg")
                    }
                }
                _ => return Err(ExportError::Unsupported(format.into())),
            };
            (bytes, media_type, extension, diagnostics)
        }
    };
    if options.strict && diagnostics.iter().any(|d| d.fidelity_lost) {
        return Err(ExportError::Unsupported(
            diagnostics
                .iter()
                .filter(|d| d.fidelity_lost)
                .map(|d| d.original.clone())
                .collect::<Vec<_>>()
                .join("; "),
        ));
    }
    let sha256 = digest(&bytes);
    Ok(ExportArtifact {
        bytes,
        media_type: media_type.into(),
        extension: extension.into(),
        diagnostics,
        epoch: snapshot.epoch.clone(),
        sequence: snapshot.sequence,
        sha256,
    })
}

pub fn export_native(
    snapshot: &DocumentSnapshot,
    resources: &dyn ResourceProvider,
) -> Result<Vec<u8>, ExportError> {
    let content = DocumentContent {
        title: snapshot.title.clone(),
        pages: snapshot.pages.clone(),
        nodes: snapshot.nodes.clone(),
        metadata: snapshot.metadata.clone(),
    };
    let content_bytes =
        serde_jcs::to_vec(&content).map_err(|e| ExportError::Invalid(e.to_string()))?;
    let content_digest = digest(&content_bytes);
    let mut hashes = BTreeSet::new();
    for node in snapshot.nodes.values() {
        for (key, value) in &node.properties {
            collect_hashes(key, value, &mut hashes);
        }
    }
    for (key, value) in &snapshot.metadata {
        collect_hashes(key.rsplit('/').next().unwrap_or(key), value, &mut hashes);
    }
    let mut assets = Vec::new();
    let mut total = content_bytes.len();
    for hash in hashes {
        let bytes = resources.get(&hash).map_err(ExportError::Resource)?;
        total = total
            .checked_add(bytes.len().saturating_mul(4).div_ceil(3) + 512)
            .ok_or_else(|| ExportError::Resource("package byte overflow".into()))?;
        if total > 256 * 1024 * 1024 {
            return Err(ExportError::Resource(
                "in-memory portable package exceeds 256 MiB".into(),
            ));
        }
        if digest(&bytes) != hash {
            return Err(ExportError::Resource(format!(
                "asset checksum mismatch: {hash}"
            )));
        }
        let media = native_asset_media_type(&bytes).ok_or_else(|| {
            ExportError::Unsupported(format!("unknown portable asset type: {hash}"))
        })?;
        assets.push(json!({"hash":hash,"mediaType":media,"byteLength":bytes.len(),"base64":base64::engine::general_purpose::STANDARD.encode(bytes)}));
    }
    serde_json::to_vec(&json!({"format":"omc.native/1","purpose":"independent-editable-copy","sourceRevision":{"epoch":snapshot.epoch,"sequence":snapshot.sequence.to_string()},"contentSha256":content_digest,"content":content,"assets":assets})).map_err(|e|ExportError::Invalid(e.to_string()))
}

pub fn native_asset_media_type(bytes: &[u8]) -> Option<&'static str> {
    Some(if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        "image/png"
    } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        "image/jpeg"
    } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        "image/webp"
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        "image/gif"
    } else if bytes.starts_with(b"\0\x01\0\0") || bytes.starts_with(b"ttcf") {
        "font/ttf"
    } else if bytes.starts_with(b"OTTO") {
        "font/otf"
    } else if bytes.starts_with(b"wOFF") {
        "font/woff"
    } else if bytes.starts_with(b"wOF2") {
        "font/woff2"
    } else if std::str::from_utf8(&bytes).is_ok_and(|s| s.contains("<svg")) {
        "image/svg+xml"
    } else {
        return None;
    })
}

fn embed_source_assets(
    mut source: String,
    mut diagnostics: Vec<Diagnostic>,
    resources: &dyn ResourceProvider,
) -> Result<(String, Vec<Diagnostic>), ExportError> {
    let hashes: BTreeSet<_> = diagnostics
        .iter()
        .filter(|d| d.code == "external_asset_files_required")
        .map(|d| d.original.clone())
        .collect();
    for hash in hashes {
        let bytes = resources.get(&hash).map_err(ExportError::Resource)?;
        if bytes.len() > 64 * 1024 * 1024 || digest(&bytes) != hash {
            return Err(ExportError::Resource(format!(
                "invalid or excessive asset: {hash}"
            )));
        }
        let media = native_asset_media_type(&bytes)
            .filter(|m| m.starts_with("image/"))
            .ok_or_else(|| ExportError::Resource(format!("invalid image asset: {hash}")))?;
        let pattern = format!("src=\"assets/{hash}\"");
        let occurrences = source.matches(&pattern).count();
        let encoded_length = bytes.len().saturating_mul(4).div_ceil(3);
        if source
            .len()
            .saturating_add(encoded_length.saturating_mul(occurrences))
            > 256 * 1024 * 1024
        {
            return Err(ExportError::Resource(
                "self-contained source exceeds 256 MiB".into(),
            ));
        }
        let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
        source = source.replace(&pattern, &format!("src=\"data:{media};base64,{encoded}\""));
    }
    diagnostics.retain(|d| d.code != "external_asset_files_required");
    Ok((source, diagnostics))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_roundtrip_retains_authored_units_with_fresh_ids() {
        let mut c = DocumentContent::empty("Roundtrip");
        let root = c.pages[0].root_node_id.clone();
        c.nodes
            .get_mut(&root)
            .unwrap()
            .properties
            .insert("style".into(), json!("display:flex;gap:2rem;width:80%"));
        let s = DocumentSnapshot {
            id: "doc_00000000000000000000000000000001".into(),
            title: c.title,
            epoch: "e".into(),
            sequence: 7,
            pages: c.pages,
            nodes: c.nodes,
            metadata: c.metadata,
        };
        let bytes = export_native(&s, &omc_render::EmptyResources).unwrap();
        let r = omc_import::import_json(
            std::str::from_utf8(&bytes).unwrap(),
            &omc_import::ImportOptions::default(),
        )
        .unwrap();
        assert_ne!(r.content.pages[0].root_node_id, root);
        assert!(
            r.content
                .nodes
                .values()
                .any(|n| n.properties.get("style")
                    == Some(&json!("display:flex;gap:2rem;width:80%")))
        );
    }
}

fn digest(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn collect_hashes(key: &str, value: &Value, hashes: &mut BTreeSet<String>) {
    let key = key.rsplit('/').next().unwrap_or(key);
    match value {
        Value::String(hash)
            if matches!(
                key,
                "hash" | "assetHash" | "imageHash" | "fontHash" | "resourceHashes"
            ) && hash.len() == 64
                && hash
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) =>
        {
            hashes.insert(hash.clone());
        }
        Value::Array(values) => {
            for value in values {
                collect_hashes(key, value, hashes)
            }
        }
        Value::Object(values) => {
            for (key, value) in values {
                collect_hashes(key, value, hashes)
            }
        }
        _ => (),
    }
}

pub fn native_resource_hashes(value: &Value) -> BTreeSet<String> {
    let mut hashes = BTreeSet::new();
    collect_hashes("", value, &mut hashes);
    hashes
}
