use super::*;
use std::io::{Cursor, Read};

pub(super) fn unpack(
    bytes: &[u8],
    options: &ImportOptions,
) -> Result<BTreeMap<String, Vec<u8>>, ImportError> {
    validate_input(bytes, options)?;
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes))
        .map_err(|e| ImportError::Invalid(e.to_string()))?;
    if archive.len() > 100_000 {
        return Err(ImportError::ResourceLimit("archive entry limit".into()));
    }
    let limit = options
        .max_input_bytes
        .saturating_mul(4)
        .min(512 * 1024 * 1024);
    let mut declared = 0u64;
    let mut expanded = 0usize;
    let mut output = BTreeMap::new();
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|e| ImportError::Invalid(e.to_string()))?;
        let name = entry.name().to_owned();
        if name.starts_with('/')
            || name.contains('\\')
            || name.contains(':')
            || name.split('/').any(|p| p == ".." || p == ".")
            || entry.unix_mode().is_some_and(|m| m & 0o170000 == 0o120000)
        {
            return Err(ImportError::Invalid(
                "unsafe archive entry name or symlink".into(),
            ));
        }
        declared = declared
            .checked_add(entry.size())
            .ok_or_else(|| ImportError::ResourceLimit("archive size overflow".into()))?;
        if declared > limit as u64 || entry.size() > 256 * 1024 * 1024 {
            return Err(ImportError::ResourceLimit(
                "expanded archive reservation exceeded".into(),
            ));
        }
        if entry.is_dir() {
            continue;
        }
        if output.contains_key(&name) {
            return Err(ImportError::Invalid("duplicate archive entry".into()));
        }
        let mut data = Vec::new();
        entry
            .by_ref()
            .take((limit - expanded) as u64 + 1)
            .read_to_end(&mut data)
            .map_err(|e| ImportError::Invalid(e.to_string()))?;
        expanded = expanded
            .checked_add(data.len())
            .ok_or_else(|| ImportError::ResourceLimit("archive size overflow".into()))?;
        if expanded > limit {
            return Err(ImportError::ResourceLimit(
                "expanded archive byte limit".into(),
            ));
        }
        output.insert(name, data);
    }
    Ok(output)
}
