//! Immutable original bytes. Garbage collection is intentionally disabled until
//! cross-document publication leases have their dedicated recovery qualification.
use omc_protocol::{EngineError, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::{File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
};

pub const MAX_ASSET_BYTES: usize = 64 * 1024 * 1024;
#[derive(Clone)]
pub struct AssetStore {
    root: PathBuf,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Asset {
    pub hash: String,
    pub byte_length: usize,
    pub mime_type: String,
}
impl AssetStore {
    pub fn open(profile: &Path) -> Result<Self> {
        let root = profile.join("native-v1/assets/sha256");
        std::fs::create_dir_all(&root).map_err(io_error)?;
        Ok(Self {
            root: root.canonicalize().map_err(io_error)?,
        })
    }
    fn path(&self, hash: &str) -> Result<PathBuf> {
        if hash.len() != 64
            || !hash
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err(EngineError::invalid("invalid immutable asset hash"));
        }
        Ok(self.root.join(&hash[..2]).join(hash))
    }
    pub fn read(&self, hash: &str) -> Result<Vec<u8>> {
        self.read_limited(hash, MAX_ASSET_BYTES)
    }
    pub fn read_limited(&self, hash: &str, max_bytes: usize) -> Result<Vec<u8>> {
        let max_bytes = max_bytes.min(MAX_ASSET_BYTES);
        let path = self.path(hash)?;
        let metadata = std::fs::symlink_metadata(&path).map_err(io_error)?;
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            return Err(EngineError::invalid(
                "asset must be a regular immutable file",
            ));
        }
        if metadata.len() > max_bytes as u64 {
            return Err(EngineError::new(
                "resource_limit",
                format!("encoded asset exceeds {max_bytes} bytes"),
            ));
        }
        let canonical = path.canonicalize().map_err(io_error)?;
        if !canonical.starts_with(&self.root) {
            return Err(EngineError::invalid("asset outside store"));
        }
        let mut bytes = Vec::with_capacity(metadata.len() as usize);
        File::open(canonical)
            .map_err(io_error)?
            .take(max_bytes as u64 + 1)
            .read_to_end(&mut bytes)
            .map_err(io_error)?;
        if bytes.len() > max_bytes || hex::encode(Sha256::digest(&bytes)) != hash {
            return Err(EngineError::new(
                "corrupt_state",
                "immutable asset checksum mismatch",
            ));
        }
        Ok(bytes)
    }
    pub fn ingest(&self, bytes: &[u8], mime_type: &str) -> Result<Asset> {
        if bytes.is_empty() || bytes.len() > MAX_ASSET_BYTES {
            return Err(EngineError::new(
                "resource_limit",
                "asset must contain 1 byte through 64 MiB",
            ));
        }
        validate_type(bytes, mime_type)?;
        let hash = hex::encode(Sha256::digest(bytes));
        let destination = self.path(&hash)?;
        let parent = destination.parent().unwrap();
        std::fs::create_dir_all(parent).map_err(io_error)?;
        if !parent
            .canonicalize()
            .map_err(io_error)?
            .starts_with(&self.root)
        {
            return Err(EngineError::invalid("asset directory outside store"));
        }
        if destination.exists() {
            if self.read(&hash)? != bytes {
                return Err(EngineError::new(
                    "corrupt_state",
                    "asset identity collision",
                ));
            }
        } else {
            let temporary = parent.join(format!(".stage-{}", uuid::Uuid::new_v4().simple()));
            let result = (|| {
                let mut options = OpenOptions::new();
                options.write(true).create_new(true);
                #[cfg(unix)]
                {
                    use std::os::unix::fs::OpenOptionsExt;
                    options.mode(0o600);
                }
                let mut file = options.open(&temporary).map_err(io_error)?;
                file.write_all(bytes).map_err(io_error)?;
                file.sync_all().map_err(io_error)?;
                drop(file);
                // Hard-link installation is exclusive, atomic, and cannot replace another payload.
                match std::fs::hard_link(&temporary, &destination) {
                    Ok(()) => {}
                    Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                        self.read(&hash)?;
                    }
                    Err(e) => return Err(io_error(e)),
                };
                sync_directory(parent)?;
                Ok(())
            })();
            let _ = std::fs::remove_file(&temporary);
            result?;
        }
        Ok(Asset {
            hash,
            byte_length: bytes.len(),
            mime_type: mime_type.into(),
        })
    }
}
fn validate_type(bytes: &[u8], mime: &str) -> Result<()> {
    let valid = match mime {
        "image/png" => bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
        "image/jpeg" => bytes.starts_with(b"\xff\xd8\xff"),
        "image/webp" => bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP"),
        "image/gif" => bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a"),
        "image/svg+xml" => std::str::from_utf8(bytes).is_ok_and(|s| s.contains("<svg")),
        "font/ttf" | "font/otf" => {
            bytes.starts_with(b"\0\x01\0\0")
                || bytes.starts_with(b"OTTO")
                || bytes.starts_with(b"ttcf")
        }
        "font/woff" => bytes.starts_with(b"wOFF"),
        "font/woff2" => bytes.starts_with(b"wOF2"),
        _ => false,
    };
    if valid {
        Ok(())
    } else {
        Err(EngineError::invalid(
            "asset bytes do not match a supported media type",
        ))
    }
}
pub fn sync_directory(path: &Path) -> Result<()> {
    #[cfg(unix)]
    File::open(path)
        .and_then(|f| f.sync_all())
        .map_err(io_error)?;
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}
fn io_error(e: std::io::Error) -> EngineError {
    EngineError::new("storage_unavailable", e.to_string())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn verified_immutable_install_and_corruption_detection() {
        let dir = tempfile::tempdir().unwrap();
        let store = AssetStore::open(dir.path()).unwrap();
        let bytes = b"\x89PNG\r\n\x1a\nfake-test-payload";
        let asset = store.ingest(bytes, "image/png").unwrap();
        assert_eq!(store.read(&asset.hash).unwrap(), bytes);
        assert_eq!(store.ingest(bytes, "image/png").unwrap().hash, asset.hash);
        std::fs::write(store.path(&asset.hash).unwrap(), b"corrupted").unwrap();
        assert_eq!(store.read(&asset.hash).unwrap_err().code, "corrupt_state");
        assert!(store.read("../../secrets").is_err());
    }
}
