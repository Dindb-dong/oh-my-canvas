use super::*;
use std::io::{Cursor, Read, Seek};

/// Validated directory with bounded, one-entry-at-a-time decompression.
pub(super) struct Archive<R: Read + Seek> {
    inner: zip::ZipArchive<R>,
    entries: BTreeMap<String, usize>,
    read: std::collections::BTreeSet<usize>,
    expanded: usize,
    limit: usize,
}

impl<R: Read + Seek> Archive<R> {
    pub(super) fn new(reader: R, options: &ImportOptions) -> Result<Self, ImportError> {
        let mut inner = zip::ZipArchive::new(reader)
            .map_err(|error| ImportError::Invalid(error.to_string()))?;
        if inner.len() > 100_000 {
            return Err(ImportError::ResourceLimit("archive entry limit".into()));
        }
        let limit = options
            .max_input_bytes
            .saturating_mul(4)
            .min(512 * 1024 * 1024);
        let mut declared = 0_u64;
        let mut entries = BTreeMap::new();
        for index in 0..inner.len() {
            let entry = inner
                .by_index(index)
                .map_err(|error| ImportError::Invalid(error.to_string()))?;
            let name = entry.name();
            if name.starts_with('/')
                || name.contains('\\')
                || name.contains(':')
                || name.split('/').any(|part| part == "." || part == "..")
                || entry
                    .unix_mode()
                    .is_some_and(|mode| mode & 0o170000 == 0o120000)
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
            if !entry.is_dir() && entries.insert(name.to_owned(), index).is_some() {
                return Err(ImportError::Invalid("duplicate archive entry".into()));
            }
        }
        Ok(Self {
            inner,
            entries,
            read: Default::default(),
            expanded: 0,
            limit,
        })
    }

    pub(super) fn read(
        &mut self,
        name: &str,
        maximum: usize,
    ) -> Result<Option<Vec<u8>>, ImportError> {
        let Some(&index) = self.entries.get(name) else {
            return Ok(None);
        };
        let mut entry = self
            .inner
            .by_index(index)
            .map_err(|error| ImportError::Invalid(error.to_string()))?;
        if entry.size() > maximum as u64 {
            return Err(ImportError::ResourceLimit(
                "archive entry exceeds working reservation".into(),
            ));
        }
        let length = usize::try_from(entry.size())
            .map_err(|_| ImportError::ResourceLimit("archive entry length".into()))?;
        let mut bytes = vec![0; length];
        entry
            .read_exact(&mut bytes)
            .map_err(|error| ImportError::Invalid(error.to_string()))?;
        // Reading through EOF verifies the CRC and rejects a forged length.
        let mut extra = [0_u8; 1];
        if entry
            .read(&mut extra)
            .map_err(|error| ImportError::Invalid(error.to_string()))?
            != 0
        {
            return Err(ImportError::ResourceLimit(
                "archive entry exceeds declared length".into(),
            ));
        }
        if self.read.insert(index) {
            self.expanded = self
                .expanded
                .checked_add(bytes.len())
                .ok_or_else(|| ImportError::ResourceLimit("archive size overflow".into()))?;
            if self.expanded > self.limit {
                return Err(ImportError::ResourceLimit(
                    "expanded archive byte limit".into(),
                ));
            }
        }
        Ok(Some(bytes))
    }

    pub(super) fn finish(
        mut self,
        check: &mut dyn FnMut() -> Result<(), ImportError>,
    ) -> Result<R, ImportError> {
        // Validate CRCs and actual lengths even for entries that are not referenced by a paint.
        let mut buffer = [0_u8; 64 * 1024];
        for index in self.entries.values() {
            if self.read.contains(index) {
                continue;
            }
            let mut entry = self
                .inner
                .by_index(*index)
                .map_err(|error| ImportError::Invalid(error.to_string()))?;
            loop {
                check()?;
                let count = entry
                    .read(&mut buffer)
                    .map_err(|error| ImportError::Invalid(error.to_string()))?;
                if count == 0 {
                    break;
                }
                self.expanded = self
                    .expanded
                    .checked_add(count)
                    .ok_or_else(|| ImportError::ResourceLimit("archive size overflow".into()))?;
                if self.expanded > self.limit {
                    return Err(ImportError::ResourceLimit(
                        "expanded archive byte limit".into(),
                    ));
                }
            }
        }
        Ok(self.inner.into_inner())
    }
}

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
