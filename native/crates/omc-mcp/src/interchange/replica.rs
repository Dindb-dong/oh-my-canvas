use super::*;
use sha2::{Digest, Sha256};

pub(super) const FORMAT: &str = "omc.history/1";
const MAX_PACKAGE_BYTES: usize = 64 * 1024 * 1024;

impl ToolRouter {
    pub(super) fn export_replica(&self, id: &str, args: &Value) -> Result<ExportArtifact> {
        if args["format"] != "omc" || args.get("ids").is_some() || args.get("bounds").is_some() {
            return Err(EngineError::invalid(
                "merge export requires an entire OMC document",
            ));
        }
        let replica = self.workspace.replica_package(id)?;
        let history_bytes = serde_json::to_vec(&replica).map_err(json_error)?.len();
        check_size(history_bytes)?;
        let epoch = string(&replica, "epoch")?.to_owned();
        let sequence = replica["transactions"]
            .as_array()
            .ok_or_else(|| {
                EngineError::new("corrupt_state", "replica export lacks transaction history")
            })?
            .len() as u64;
        let store = self.resources()?.0;
        let mut assets = Vec::new();
        let mut reserved = history_bytes;
        for hash in omc_export::native_resource_hashes(&replica) {
            let bytes = store.read(&hash)?;
            reserved = reserved.saturating_add(bytes.len().saturating_mul(4).div_ceil(3) + 256);
            check_size(reserved)?;
            let media = omc_export::native_asset_media_type(&bytes).ok_or_else(|| {
                EngineError::invalid(format!("unrecognized portable asset type: {hash}"))
            })?;
            assets.push(json!({"hash":hash,"mediaType":media,"base64":base64::engine::general_purpose::STANDARD.encode(bytes)}));
        }
        let history_digest = omc_protocol::canonical_digest(&replica)?;
        let bytes = serde_json::to_vec(&json!({"format":FORMAT,"historySha256":history_digest,"replica":replica,"assets":assets})).map_err(json_error)?;
        check_size(bytes.len())?;
        Ok(ExportArtifact {
            sha256: digest(&bytes),
            bytes,
            media_type: "application/vnd.ohmycanvas+json".into(),
            extension: "omc".into(),
            diagnostics: Vec::new(),
            epoch,
            sequence,
        })
    }

    pub(super) fn import_replica(
        &self,
        session: &str,
        mut value: Value,
        title: Option<&str>,
        job: Option<&omc_workspace::jobs::JobContext>,
    ) -> Result<DocumentSnapshot> {
        if title.is_some_and(|title| title.trim().is_empty() || title.len() > 240) {
            return Err(EngineError::invalid("title must contain 1–240 bytes"));
        }
        let expected = string(&value, "historySha256")?.to_owned();
        let replica = value["replica"].take();
        if omc_protocol::canonical_digest(&replica)? != expected {
            return Err(EngineError::invalid("replica history checksum mismatch"));
        }
        let history_bytes = serde_json::to_vec(&replica).map_err(json_error)?.len();
        check_size(history_bytes)?;
        let mut required = omc_export::native_resource_hashes(&replica);
        let replica: omc_workspace::ReplicaPackage =
            serde_json::from_value(replica).map_err(json_error)?;
        let assets = value["assets"]
            .as_array()
            .ok_or_else(|| EngineError::invalid("replica assets must be an array"))?;
        let mut verified = Vec::new();
        for asset in assets {
            let hash = string(asset, "hash")?;
            if !required.remove(hash) {
                return Err(EngineError::invalid(
                    "duplicate or unreferenced replica asset",
                ));
            }
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(string(asset, "base64")?)
                .map_err(|error| EngineError::invalid(error.to_string()))?;
            let media = string(asset, "mediaType")?;
            if digest(&bytes) != hash || omc_export::native_asset_media_type(&bytes) != Some(media)
            {
                return Err(EngineError::invalid(
                    "replica asset checksum or media type mismatch",
                ));
            }
            verified.push((bytes, media));
        }
        if !required.is_empty() {
            return Err(EngineError::invalid(
                "replica package is missing referenced assets",
            ));
        }
        if let Some(job) = job {
            job.check_cancelled()?;
        }
        let store = self.resources()?.0;
        for (bytes, media) in verified {
            store.ingest(&bytes, media)?;
        }
        if let Some(job) = job {
            job.begin_commit()?;
        }
        let mut snapshot =
            self.workspace
                .merge_replica(session, replica, history_bytes.min(4 * 1024 * 1024))?;
        if let Some(job) = job {
            job.mark_committed();
        }
        if let Some(title) = title
            && title != snapshot.title
        {
            self.workspace.command(
                session,
                &snapshot.id,
                &snapshot.epoch,
                Command::DocumentRename {
                    title: title.into(),
                },
            )?;
            snapshot = self.workspace.snapshot(&snapshot.id)?;
        }
        Ok(snapshot)
    }
}

fn check_size(bytes: usize) -> Result<()> {
    if bytes > MAX_PACKAGE_BYTES {
        return Err(EngineError::new(
            "resource_limit",
            "replica package exceeds 64 MiB",
        ));
    }
    Ok(())
}

fn digest(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn json_error(error: serde_json::Error) -> EngineError {
    EngineError::invalid(error.to_string())
}
