use super::*;
use std::io::{Cursor, Read, Write};
use zip::{ZipArchive, ZipWriter, write::SimpleFileOptions};

const MEMBER: &str = "omc-native/document.omc";
const CURRENT_PAGE: &str = "omc-native/current-page";
const LIMIT: usize = 16 * 1024 * 1024;

pub(crate) fn needs_native(snapshot: &DocumentSnapshot) -> bool {
    snapshot.metadata.keys().any(|key| {
        key == "figcraftPublishedLibrary"
            || key.starts_with("libraries/")
            || key.starts_with("figcraftCollections/")
            || key.starts_with("tokens/")
    })
}

impl ToolRouter {
    pub(crate) fn fig_encode_catalog_archive(
        &self,
        snapshot: &DocumentSnapshot,
        page_id: &str,
    ) -> Result<Vec<u8>> {
        let package = omc_export::export(
            snapshot,
            &omc_export::ExportOptions {
                format: "omc".into(),
                ..Default::default()
            },
            &self.resources()?,
        )
        .map_err(|error| EngineError::invalid(error.to_string()))?
        .bytes;
        if package.len() > LIMIT {
            return Err(EngineError::new(
                "resource_limit",
                "portable catalog archive exceeds 16 MiB",
            ));
        }
        let mut zip = ZipWriter::new(Cursor::new(Vec::new()));
        zip.start_file(MEMBER, SimpleFileOptions::default())
            .map_err(archive_error)?;
        zip.write_all(&package).map_err(archive_error)?;
        let page = snapshot
            .pages
            .iter()
            .position(|page| page.id == page_id)
            .unwrap_or(0);
        zip.start_file(CURRENT_PAGE, SimpleFileOptions::default())
            .map_err(archive_error)?;
        zip.write_all(page.to_string().as_bytes())
            .map_err(archive_error)?;
        Ok(zip.finish().map_err(archive_error)?.into_inner())
    }

    pub(crate) fn fig_decode_catalog_archive(
        &self,
        bytes: &[u8],
    ) -> Result<Option<(DocumentContent, usize)>> {
        self.fig_decode_catalog_archive_with_resources(bytes, true)
    }

    pub(super) fn fig_decode_catalog_archive_with_resources(
        &self,
        bytes: &[u8],
        ingest: bool,
    ) -> Result<Option<(DocumentContent, usize)>> {
        let Ok(mut zip) = ZipArchive::new(Cursor::new(bytes)) else {
            return Ok(None);
        };
        if zip.index_for_name(MEMBER).is_none() {
            return Ok(None);
        }
        if zip.len() > 2
            || zip
                .file_names()
                .any(|name| !matches!(name, MEMBER | CURRENT_PAGE))
        {
            return Err(EngineError::invalid(
                "Invalid native FigCraft catalog archive",
            ));
        }
        let member = zip.by_name(MEMBER).map_err(archive_error)?;
        if member.size() > LIMIT as u64 {
            return Err(EngineError::new(
                "resource_limit",
                "portable catalog archive exceeds 16 MiB",
            ));
        }
        let mut bytes = Vec::new();
        member
            .take(LIMIT as u64 + 1)
            .read_to_end(&mut bytes)
            .map_err(archive_error)?;
        if bytes.len() > LIMIT {
            return Err(EngineError::new(
                "resource_limit",
                "portable catalog archive exceeds 16 MiB",
            ));
        }
        let page = if let Some(index) = zip.index_for_name(CURRENT_PAGE) {
            let mut value = String::new();
            zip.by_index(index)
                .map_err(archive_error)?
                .take(32)
                .read_to_string(&mut value)
                .map_err(archive_error)?;
            value.parse::<usize>().map_err(archive_error)?
        } else {
            0
        };
        let content = self.fig_decode_native_catalog_bytes(&bytes, ingest)?;
        if page >= content.pages.len() {
            return Err(EngineError::invalid(
                "Native archive current page is out of range",
            ));
        }
        Ok(Some((content, page)))
    }

    pub(super) fn fig_decode_native_catalog_bytes(
        &self,
        bytes: &[u8],
        ingest: bool,
    ) -> Result<DocumentContent> {
        let file = omc_protocol::decode_json_with_limit(bytes, LIMIT)?;
        if file["format"] != "omc.native/1" {
            return Err(EngineError::invalid(
                "Expected a native OMC document archive",
            ));
        }
        let imported = omc_import::import_bytes(
            "omc",
            bytes,
            &omc_import::ImportOptions {
                strict: true,
                max_input_bytes: LIMIT,
                ..Default::default()
            },
        )
        .map_err(|error| EngineError::invalid(error.to_string()))?;
        let content: DocumentContent =
            serde_json::from_value(file["content"].clone()).map_err(archive_error)?;
        content.validate().map_err(EngineError::invalid)?;
        if !ingest {
            return Ok(content);
        }
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
        Ok(content)
    }
}

fn archive_error(error: impl std::fmt::Display) -> EngineError {
    EngineError::invalid(error.to_string())
}
