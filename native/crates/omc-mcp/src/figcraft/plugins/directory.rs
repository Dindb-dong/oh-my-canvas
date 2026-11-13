//! FigCraft v0.17.0's uncompressed FCPLUGB1 bundle, within the native sandbox limits.
use super::*;
use sha2::{Digest, Sha256};
use std::{cmp::Ordering, path::Path};

const MAGIC: &[u8; 8] = b"FCPLUGB1";
const MAX_BUNDLE: usize = 32 * 1024 * 1024;
const MAX_ASSETS: usize = 32;

#[derive(Clone)]
pub(super) struct Asset {
    name: String,
    bytes: Vec<u8>,
}

fn version_parts(version: &str) -> Option<Vec<u64>> {
    if version.len() > 32 {
        return None;
    }
    let parts = version
        .split('.')
        .map(|part| {
            if part.is_empty() || !part.bytes().all(|byte| byte.is_ascii_digit()) {
                return None;
            }
            part.parse().ok()
        })
        .collect::<Option<Vec<_>>>()?;
    (parts.len() <= 4).then_some(parts)
}

pub fn compare_directory_versions(a: &str, b: &str) -> Option<Ordering> {
    let mut a = version_parts(a)?;
    let mut b = version_parts(b)?;
    a.resize(4, 0);
    b.resize(4, 0);
    Some(a.cmp(&b))
}

fn asset_name(name: &str) -> Result<()> {
    let stem = name
        .split('.')
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase();
    let device = matches!(stem.as_str(), "con" | "prn" | "aux" | "nul")
        || (stem.len() == 4
            && (stem.starts_with("com") || stem.starts_with("lpt"))
            && stem.as_bytes()[3].is_ascii_digit());
    if name.is_empty()
        || name.len() > 64
        || name.starts_with('.')
        || name.ends_with('.')
        || device
        || !name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_'))
    {
        return Err(EngineError::invalid("Invalid plugin bundle asset name"));
    }
    Ok(())
}

fn disk_assets(plugin: &Plugin) -> Result<Vec<Asset>> {
    let Some(base) = plugin.path.as_deref().and_then(Path::parent) else {
        return Ok(plugin.directory_assets.clone());
    };
    let folder = base.join("assets");
    match std::fs::symlink_metadata(&folder) {
        Ok(info) if !info.is_dir() => {
            return Err(EngineError::invalid(
                "Plugin assets must be a folder inside the plugin",
            ));
        }
        Ok(_) => (),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(plugin_error(error)),
    }
    let mut entries = Vec::new();
    let mut remaining = MAX_BUNDLE.saturating_sub(plugin.wasm.len());
    for entry in std::fs::read_dir(&folder).map_err(plugin_error)? {
        let entry = entry.map_err(plugin_error)?;
        let kind = entry.file_type().map_err(plugin_error)?;
        if kind.is_symlink() {
            return Err(EngineError::invalid(
                "Plugin assets may not be symbolic links",
            ));
        }
        if !kind.is_file() {
            continue;
        }
        if entries.len() >= MAX_ASSETS {
            return Err(EngineError::invalid(
                "Plugin bundle may contain at most 32 assets",
            ));
        }
        let name = entry
            .file_name()
            .into_string()
            .map_err(|_| EngineError::invalid("Plugin asset names must be UTF-8"))?;
        asset_name(&name)?;
        let path = entry.path().canonicalize().map_err(plugin_error)?;
        if path.parent() != Some(folder.as_path()) {
            return Err(EngineError::invalid("Plugin asset escapes its folder"));
        }
        let bytes = read_bounded(&path, remaining)?;
        remaining -= bytes.len();
        entries.push(Asset { name, bytes });
    }
    entries.sort_by(|a, b| a.name.cmp(&b.name));
    validate_assets(&entries)?;
    Ok(entries)
}

fn validate_assets(assets: &[Asset]) -> Result<()> {
    let mut names = std::collections::BTreeSet::new();
    for asset in assets {
        asset_name(&asset.name)?;
        if !names.insert(asset.name.to_ascii_lowercase()) {
            return Err(EngineError::invalid("Duplicate plugin bundle asset name"));
        }
    }
    Ok(())
}

fn put_part(bytes: &mut Vec<u8>, part: &[u8]) {
    bytes.extend((part.len() as u32).to_le_bytes());
    bytes.extend(part);
}

fn encode(plugin: &Plugin) -> Result<Vec<u8>> {
    if version_parts(&plugin.manifest.version).is_none() {
        return Err(EngineError::invalid(
            "Directory plugins require a numeric version such as 1.0.0",
        ));
    }
    let assets = disk_assets(plugin)?;
    let manifest = serde_json::to_vec(&plugin.manifest).map_err(plugin_error)?;
    let length = MAGIC.len()
        + 12
        + manifest.len()
        + plugin.wasm.len()
        + assets
            .iter()
            .map(|asset| 8 + asset.name.len() + asset.bytes.len())
            .sum::<usize>();
    if length > MAX_BUNDLE {
        return Err(EngineError::new(
            "resource_limit",
            "Plugin bundle exceeds 32 MiB",
        ));
    }
    let mut bytes = Vec::with_capacity(length);
    bytes.extend(MAGIC);
    put_part(&mut bytes, &manifest);
    put_part(&mut bytes, &plugin.wasm);
    bytes.extend((assets.len() as u32).to_le_bytes());
    for asset in &assets {
        put_part(&mut bytes, asset.name.as_bytes());
        put_part(&mut bytes, &asset.bytes);
    }
    Ok(bytes)
}

fn consume<'a>(bytes: &mut &'a [u8], size: usize) -> Result<&'a [u8]> {
    let (part, rest) = bytes
        .split_at_checked(size)
        .ok_or_else(|| EngineError::invalid("Plugin bundle is incomplete"))?;
    *bytes = rest;
    Ok(part)
}

fn read_size(bytes: &mut &[u8]) -> Result<usize> {
    let number: [u8; 4] = consume(bytes, 4)?.try_into().unwrap();
    Ok(u32::from_le_bytes(number) as usize)
}

fn take_part<'a>(bytes: &mut &'a [u8]) -> Result<&'a [u8]> {
    let length = read_size(bytes)?;
    consume(bytes, length)
}

fn decode(mut bytes: &[u8]) -> Result<Plugin> {
    if bytes.len() > MAX_BUNDLE || consume(&mut bytes, MAGIC.len())? != MAGIC {
        return Err(EngineError::invalid(
            "Expected a bounded FigCraft plugin bundle",
        ));
    }
    let manifest =
        Manifest::parse(std::str::from_utf8(take_part(&mut bytes)?).map_err(plugin_error)?)
            .map_err(plugin_error)?;
    if version_parts(&manifest.version).is_none() {
        return Err(EngineError::invalid(
            "Directory plugins require a numeric version",
        ));
    }
    let wasm = take_part(&mut bytes)?;
    check_module(wasm, &limits(None)).map_err(plugin_error)?;
    let count = read_size(&mut bytes)?;
    if count > MAX_ASSETS {
        return Err(EngineError::invalid("Plugin bundle has too many assets"));
    }
    let mut assets = Vec::with_capacity(count);
    for _ in 0..count {
        let name = std::str::from_utf8(take_part(&mut bytes)?).map_err(plugin_error)?;
        asset_name(name)?;
        assets.push(Asset {
            name: name.to_owned(),
            bytes: take_part(&mut bytes)?.to_vec(),
        });
    }
    validate_assets(&assets)?;
    if !bytes.is_empty() {
        return Err(EngineError::invalid("Unexpected data after plugin bundle"));
    }
    Ok(Plugin {
        manifest,
        wasm: wasm.to_vec(),
        path: None,
        directory_assets: assets,
    })
}

impl ToolRouter {
    fn plugin_session(&self, session: &str) -> Arc<Mutex<Plugins>> {
        self.fig_plugins
            .lock()
            .unwrap()
            .entry(session.to_owned())
            .or_default()
            .clone()
    }

    pub fn fig_plugin_directory_state(
        &self,
        session: &str,
        remember: Option<&str>,
    ) -> (Option<String>, BTreeMap<String, String>) {
        let state = self.plugin_session(session);
        let mut state = state.lock().unwrap();
        if let Some(server) = remember {
            state.directory = Some(server.to_owned());
        }
        let versions = state
            .installed
            .iter()
            .map(|(id, plugin)| (id.clone(), plugin.manifest.version.clone()))
            .collect();
        (state.directory.clone(), versions)
    }

    pub fn fig_export_plugin_bundle(&self, session: &str, params: &Value) -> Result<Vec<u8>> {
        match (params["path"].as_str(), params["plugin"].as_str()) {
            (Some(path), None) => encode(&Plugin::load(&json!({"path":path}))?),
            (None, Some(id)) => {
                let state = self.plugin_session(session);
                let state = state.lock().unwrap();
                let plugin = state.installed.get(id).ok_or_else(|| {
                    EngineError::invalid("Plugin is not installed in this MCP session")
                })?;
                encode(plugin)
            }
            _ => Err(EngineError::invalid(
                "Choose one plugin path or installed plugin ID",
            )),
        }
    }

    pub fn fig_install_plugin_bundle(
        &self,
        session: &str,
        bytes: &[u8],
        entry: &Value,
        source: &str,
        expected: Option<&str>,
    ) -> Result<Value> {
        let sha = hex::encode(Sha256::digest(bytes));
        if entry["sha256"] != sha
            || entry["bytes"].as_u64() != Some(bytes.len() as u64)
            || expected.is_some_and(|value| !value.trim().eq_ignore_ascii_case(&sha))
        {
            return Err(EngineError::invalid(
                "Plugin bundle does not match the expected SHA-256 and size",
            ));
        }
        let plugin = decode(bytes)?;
        let manifest = &plugin.manifest;
        let shown_commands = entry["commands"]
            .as_array()
            .ok_or_else(|| EngineError::invalid("Directory entry has no command permissions"))?;
        if entry["id"] != manifest.id
            || entry["version"] != manifest.version
            || entry["api"].as_u64() != Some(u64::from(manifest.api))
            || entry["widget"] != manifest.widget
            || (manifest.permissions.access == Access::Write && entry["access"] != "write")
            || (!shown_commands.is_empty()
                && (manifest.permissions.commands.is_empty()
                    || manifest
                        .permissions
                        .commands
                        .iter()
                        .any(|command| !shown_commands.iter().any(|shown| shown == command))))
        {
            return Err(EngineError::invalid(
                "Plugin manifest does not match the directory identity and permissions",
            ));
        }
        let id = manifest.id.clone();
        let mut result = json!({"installed":id,"name":manifest.name,"version":manifest.version,
            "permissions":manifest.permissions,"sha256":sha,"path":null,"source":source});
        let state = self.plugin_session(session);
        let mut state = state.lock().unwrap();
        if state.installed.len() >= 16 && !state.installed.contains_key(&id) {
            return Err(EngineError::new(
                "resource_limit",
                "at most 16 plugins per MCP session",
            ));
        }
        let retained_bytes = state
            .installed
            .iter()
            .filter(|(installed, _)| *installed != &id)
            .flat_map(|(_, plugin)| &plugin.directory_assets)
            .chain(&plugin.directory_assets)
            .map(|asset| asset.bytes.len())
            .sum::<usize>();
        if retained_bytes > MAX_BUNDLE {
            return Err(EngineError::new(
                "resource_limit",
                "Installed plugin assets exceed 32 MiB for this MCP session",
            ));
        }
        state.panels.retain(|panel| panel.id != id);
        result["replaced"] = json!(state.installed.insert(id, plugin).is_some());
        Ok(result)
    }
}
