//! Bounded source conversion produces candidates; only the engine may publish them.
mod archive;
mod fig;
mod html;
mod kiwi;
mod native;
mod sketch;
mod svg;
pub use fig::import_fig;
pub use html::import_html;
pub use native::import_json;
pub use sketch::import_sketch;
pub use svg::import_svg;

use base64::Engine;
use omc_model::DocumentContent;
use omc_style::Diagnostic;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImportOptions {
    pub strict: bool,
    pub width: f64,
    pub height: f64,
    pub max_nodes: usize,
    pub max_input_bytes: usize,
}
impl Default for ImportOptions {
    fn default() -> Self {
        Self {
            strict: true,
            width: 1440.,
            height: 900.,
            max_nodes: 100_000,
            max_input_bytes: 16 * 1024 * 1024,
        }
    }
}
#[derive(Clone, Debug)]
pub struct ImportedResource {
    pub hash: String,
    pub media_type: String,
    pub bytes: Vec<u8>,
}
#[derive(Clone, Debug)]
pub struct ImportResult {
    pub content: DocumentContent,
    pub resources: Vec<ImportedResource>,
    pub diagnostics: Vec<Diagnostic>,
    pub source_map: BTreeMap<String, String>,
}
#[derive(Debug, thiserror::Error)]
pub enum ImportError {
    #[error("invalid source: {0}")]
    Invalid(String),
    #[error("import resource limit: {0}")]
    ResourceLimit(String),
    #[error("unsupported source feature: {0}")]
    Unsupported(String),
}

pub fn import_bytes(
    kind: &str,
    bytes: &[u8],
    options: &ImportOptions,
) -> Result<ImportResult, ImportError> {
    validate_input(bytes, options)?;
    if kind.eq_ignore_ascii_case("sketch") {
        return import_sketch(bytes, options);
    }
    if kind.eq_ignore_ascii_case("fig") {
        return import_fig(bytes, options);
    }
    let text = std::str::from_utf8(bytes)
        .map_err(|_| ImportError::Invalid("source is not UTF-8".into()))?;
    match kind.to_ascii_lowercase().as_str() {
        "html" | "text/html" => import_html(text, options),
        "svg" | "image/svg+xml" => import_svg(text, options),
        "json" | "omc" | "application/json" => import_json(text, options),
        other => Err(ImportError::Unsupported(format!("format {other}"))),
    }
}

fn validate_input(bytes: &[u8], options: &ImportOptions) -> Result<(), ImportError> {
    if bytes.len() > options.max_input_bytes || options.max_input_bytes > 256 * 1024 * 1024 {
        return Err(ImportError::ResourceLimit("input byte limit".into()));
    }
    if options.max_nodes == 0
        || options.max_nodes > 1_000_000
        || !options.width.is_finite()
        || !options.height.is_finite()
        || options.width <= 0.
        || options.height <= 0.
        || options.width > 1_000_000.
        || options.height > 1_000_000.
    {
        return Err(ImportError::Invalid("invalid import options".into()));
    }
    Ok(())
}
fn finish(result: ImportResult, options: &ImportOptions) -> Result<ImportResult, ImportError> {
    if result.content.nodes.len() > options.max_nodes {
        return Err(ImportError::ResourceLimit("node limit".into()));
    }
    result.content.validate().map_err(ImportError::Invalid)?;
    if options.strict && result.diagnostics.iter().any(|d| d.fidelity_lost) {
        return Err(ImportError::Unsupported(
            result
                .diagnostics
                .iter()
                .filter(|d| d.fidelity_lost)
                .map(|d| format!("{}: {}", d.code, d.original))
                .collect::<Vec<_>>()
                .join("; "),
        ));
    }
    Ok(result)
}
fn resource(source: &str) -> Result<ImportedResource, ImportError> {
    let data = source.strip_prefix("data:").ok_or_else(|| {
        ImportError::Unsupported("external resource needs an explicit resource capability".into())
    })?;
    let (header, payload) = data
        .split_once(',')
        .ok_or_else(|| ImportError::Invalid("invalid data URI".into()))?;
    let media_type = header.strip_suffix(";base64").ok_or_else(|| {
        ImportError::Unsupported("only base64 encoded image data URIs are supported".into())
    })?;
    if !matches!(
        media_type,
        "image/png"
            | "image/jpeg"
            | "image/webp"
            | "image/gif"
            | "image/svg+xml"
            | "font/ttf"
            | "font/otf"
            | "font/woff"
            | "font/woff2"
    ) {
        return Err(ImportError::Unsupported(format!("image type {media_type}")));
    }
    if payload.len() > 64 * 1024 * 1024 {
        return Err(ImportError::ResourceLimit("inline resource limit".into()));
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(payload)
        .map_err(|e| ImportError::Invalid(e.to_string()))?;
    let valid = match media_type {
        "image/png" => bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
        "image/jpeg" => bytes.starts_with(&[0xff, 0xd8, 0xff]),
        "image/webp" => bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP"),
        "image/gif" => bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a"),
        "image/svg+xml" => std::str::from_utf8(&bytes).is_ok_and(|s| s.contains("<svg")),
        "font/ttf" | "font/otf" => {
            bytes.starts_with(b"\0\x01\0\0")
                || bytes.starts_with(b"OTTO")
                || bytes.starts_with(b"ttcf")
        }
        "font/woff" => bytes.starts_with(b"wOFF"),
        "font/woff2" => bytes.starts_with(b"wOF2"),
        _ => false,
    };
    if !valid {
        return Err(ImportError::Invalid(
            "declared image type does not match its signature".into(),
        ));
    }
    let hash = digest(&bytes);
    Ok(ImportedResource {
        hash,
        media_type: media_type.into(),
        bytes,
    })
}
fn rank(index: usize) -> String {
    format!("{:032x}", (index as u128 + 1) * u64::MAX as u128)
}

fn digest(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}
