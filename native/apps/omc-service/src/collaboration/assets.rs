//! Only assets referenced by the current room transfer can cross the peer endpoint.
use base64::{Engine as _, engine::general_purpose::STANDARD};
use omc_assets::AssetStore;
use omc_protocol::{EngineError, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{collections::BTreeSet, path::Path};

const MAX_ASSET_TRANSFER: usize = 3 * 1024 * 1024;
const MAX_ASSET_COUNT: usize = 128;

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Packet {
    hash: String,
    data: String,
}

pub(super) fn collect(profile: &Path, document_data: &Value) -> Result<Vec<Packet>> {
    let hashes = references(document_data)?;
    if hashes.is_empty() {
        return Ok(vec![]);
    }
    let store = AssetStore::open(profile)?;
    let mut total = 0;
    hashes
        .into_iter()
        .map(|hash| {
            let bytes = store.read(&hash)?;
            total += bytes.len();
            if total > MAX_ASSET_TRANSFER {
                return Err(limit());
            }
            media_type(&bytes)?;
            Ok(Packet {
                hash,
                data: STANDARD.encode(bytes),
            })
        })
        .collect()
}

pub(super) fn install(profile: &Path, document_data: &Value, assets: Vec<Packet>) -> Result<()> {
    let mut expected = references(document_data)?;
    if expected.len() != assets.len() {
        return Err(EngineError::invalid(
            "room transfer is missing referenced asset bytes",
        ));
    }
    if expected.is_empty() {
        return Ok(());
    }
    let mut verified = Vec::with_capacity(assets.len());
    let mut total = 0;
    for asset in assets {
        if !expected.remove(&asset.hash) {
            return Err(EngineError::invalid(
                "room transfer supplied an unreferenced asset",
            ));
        }
        let bytes = STANDARD
            .decode(asset.data)
            .map_err(|_| EngineError::invalid("invalid room asset bytes"))?;
        total += bytes.len();
        if total > MAX_ASSET_TRANSFER {
            return Err(limit());
        }
        if hex::encode(Sha256::digest(&bytes)) != asset.hash {
            return Err(EngineError::invalid("room asset hash mismatch"));
        }
        let mime = media_type(&bytes)?;
        verified.push((bytes, mime));
    }
    let store = AssetStore::open(profile)?;
    for (bytes, mime) in verified {
        store.ingest(&bytes, mime)?;
    }
    Ok(())
}

fn references(value: &Value) -> Result<BTreeSet<String>> {
    fn visit(value: &Value, hashes: &mut BTreeSet<String>, depth: usize) -> Result<()> {
        if depth > 96 {
            return Err(EngineError::invalid(
                "room asset references are nested too deeply",
            ));
        }
        match value {
            Value::Array(values) => {
                for value in values {
                    visit(value, hashes, depth + 1)?;
                }
            }
            Value::Object(values) => {
                for (key, value) in values {
                    let is_hash = matches!(
                        key.as_str(),
                        "assetHash" | "imageHash" | "fontHash" | "hash"
                    ) || key.starts_with("assets/") && key.ends_with("/hash");
                    if is_hash
                        && let Some(hash) = value.as_str().filter(|hash| {
                            hash.len() == 64
                                && hash
                                    .bytes()
                                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
                        })
                    {
                        hashes.insert(hash.to_owned());
                        if hashes.len() > MAX_ASSET_COUNT {
                            return Err(limit());
                        }
                    }
                    visit(value, hashes, depth + 1)?;
                }
            }
            _ => {}
        }
        Ok(())
    }
    let mut hashes = BTreeSet::new();
    visit(value, &mut hashes, 0)?;
    Ok(hashes)
}

fn limit() -> EngineError {
    EngineError::new(
        "resource_limit",
        "room asset transfer exceeds 3 MiB or 128 assets",
    )
}

fn media_type(bytes: &[u8]) -> Result<&'static str> {
    let media = if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        "image/png"
    } else if bytes.starts_with(b"\xff\xd8\xff") {
        "image/jpeg"
    } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        "image/webp"
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        "image/gif"
    } else if bytes.starts_with(b"OTTO") {
        "font/otf"
    } else if bytes.starts_with(b"ttcf") || bytes.starts_with(b"\0\x01\0\0") {
        "font/ttf"
    } else if bytes.starts_with(b"wOFF") {
        "font/woff"
    } else if bytes.starts_with(b"wOF2") {
        "font/woff2"
    } else if std::str::from_utf8(bytes).is_ok_and(|s| s.contains("<svg")) {
        "image/svg+xml"
    } else {
        return Err(EngineError::invalid("unsupported room asset format"));
    };
    Ok(media)
}
