use super::*;
use flate2::read::GzDecoder;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock},
    time::Duration,
};

const CATALOG: &[u8] = include_bytes!("../../data/figcraft-font-catalog.json.gz");

#[derive(Deserialize)]
struct Source {
    name: String,
    repo: String,
    revision: String,
    families: Vec<Family>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Family {
    name: String,
    files: Vec<File>,
    font_count: usize,
}

#[derive(Deserialize)]
struct File(String, u64, String, Option<String>, Option<String>);

#[derive(Clone)]
enum Status {
    Downloading { done: u64, total: u64 },
    Installed,
    Failed(String),
}

impl Status {
    fn json(&self, family: &str) -> Value {
        match self {
            Self::Downloading { done, total } => {
                json!({"family":family,"state":"downloading","done":done,"total":total})
            }
            Self::Installed => json!({"family":family,"state":"installed"}),
            Self::Failed(error) => json!({"family":family,"state":"failed","error":error}),
        }
    }
}

#[derive(Clone, Default)]
pub(crate) struct Downloads(Arc<Mutex<BTreeMap<String, (String, Status)>>>);

fn catalog() -> &'static [Source] {
    static SOURCES: OnceLock<Vec<Source>> = OnceLock::new();
    SOURCES.get_or_init(|| {
        serde_json::from_reader(GzDecoder::new(CATALOG))
            .expect("bundled FigCraft font catalog is valid")
    })
}

fn store_dir(profile: &Path) -> PathBuf {
    profile.join("native-v1/font-store")
}

fn family_dir(profile: &Path, source: &Source, family: &Family) -> PathBuf {
    let id = Sha256::digest(format!(
        "{}\0{}\0{}",
        source.repo, source.revision, family.name
    ));
    store_dir(profile).join(hex::encode(id))
}

fn is_installed(profile: &Path, source: &Source, family: &Family) -> bool {
    family_dir(profile, source, family)
        .join("verified")
        .is_file()
}

pub(super) fn font_source(name: &str) -> Option<&'static str> {
    catalog().iter().find_map(|source| {
        source
            .families
            .iter()
            .any(|family| family.name.eq_ignore_ascii_case(name))
            .then_some(source.name.as_str())
    })
}

fn io_error(error: impl std::fmt::Display) -> EngineError {
    EngineError::new("font_download_failed", error.to_string())
}

impl Downloads {
    fn set(&self, key: &str, status: Status) {
        if let Some(entry) = self.0.lock().unwrap().get_mut(key) {
            entry.1 = status;
        }
    }

    pub(super) fn list(&self, profile: &Path) -> Value {
        let jobs = self.0.lock().unwrap();
        let downloads: Vec<_> = jobs
            .values()
            .map(|(family, status)| status.json(family))
            .collect();
        json!({"allowed":omc_text::profile_font_downloads_allowed(profile),"downloads":downloads})
    }

    pub(super) fn run(&self, profile: &Path, requested: &str) -> Result<Value> {
        let requested = requested.trim();
        let key = requested.to_lowercase();
        let (source, family) = catalog()
            .iter()
            .find_map(|source| {
                source
                    .families
                    .iter()
                    .find(|family| family.name.to_lowercase() == key)
                    .map(|family| (source, family))
            })
            .ok_or_else(|| EngineError::invalid("font family is absent from the pinned catalog"))?;
        let total = family.files.iter().map(|file| file.1).sum();
        let status = Status::Downloading { done: 0, total };
        {
            let mut jobs = self.0.lock().unwrap();
            if is_installed(profile, source, family) {
                jobs.remove(&key);
                return Ok(Status::Installed.json(&family.name));
            }
            if let Some((_, running @ Status::Downloading { .. })) = jobs.get(&key) {
                return Ok(running.json(&family.name));
            }
            if !omc_text::profile_font_downloads_allowed(profile) {
                return Err(EngineError::new(
                    "permission_denied",
                    "font downloads are off in the desktop settings",
                ));
            }
            if jobs
                .values()
                .filter(|(_, state)| matches!(state, Status::Downloading { .. }))
                .count()
                >= 4
            {
                return Err(EngineError::new(
                    "busy",
                    "four font families are already downloading",
                ));
            }
            jobs.insert(key.clone(), (family.name.clone(), status.clone()));
        }
        let downloads = self.clone();
        let owner = profile.to_owned();
        let job = key.clone();
        if let Err(error) = std::thread::Builder::new()
            .name("omc-font-download".into())
            .spawn(move || {
                let result = install(&owner, source, family, |done| {
                    downloads.set(&job, Status::Downloading { done, total });
                });
                downloads.set(
                    &job,
                    match result {
                        Ok(()) => Status::Installed,
                        Err(error) => Status::Failed(error.message),
                    },
                );
            })
        {
            self.0.lock().unwrap().remove(&key);
            return Err(io_error(error));
        }
        let mut result = status.json(&family.name);
        result["source"] = source.name.clone().into();
        result["files"] = family.font_count.into();
        Ok(result)
    }
}

fn install(
    profile: &Path,
    source: &Source,
    family: &Family,
    mut progress: impl FnMut(u64),
) -> Result<()> {
    let root = store_dir(profile);
    std::fs::create_dir_all(&root).map_err(io_error)?;
    let stage = root.join(format!(".stage-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&stage).map_err(io_error)?;
    let result = (|| {
        let client = reqwest::blocking::Client::builder()
            .https_only(true)
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(60))
            .build()
            .map_err(io_error)?;
        let mut done = 0;
        for (index, file) in family.files.iter().enumerate() {
            if !omc_text::profile_font_downloads_allowed(profile) {
                return Err(EngineError::new(
                    "permission_denied",
                    "font downloads were turned off",
                ));
            }
            let path = if index < family.font_count {
                let extension = Path::new(&file.0)
                    .extension()
                    .and_then(|extension| extension.to_str())
                    .filter(|extension| matches!(*extension, "ttf" | "otf" | "ttc" | "otc"))
                    .ok_or_else(|| io_error("invalid font extension in pinned catalog"))?;
                stage.join(format!("{index}.{extension}"))
            } else {
                stage.join("LICENSE.txt")
            };
            download(&client, source, file, &path, |bytes| progress(done + bytes))?;
            if index < family.font_count {
                let bytes = std::fs::read(&path).map_err(io_error)?;
                let manager = skia_safe::FontMgr::default();
                let count = omc_text::font_face_count(&bytes);
                if count == 0
                    || (0..count).any(|face| manager.new_from_data(&bytes, Some(face)).is_none())
                {
                    return Err(io_error("pinned file does not contain a readable font"));
                }
            }
            done += file.1;
        }
        if !omc_text::profile_font_downloads_allowed(profile) {
            return Err(EngineError::new(
                "permission_denied",
                "font downloads were turned off",
            ));
        }
        std::fs::write(
            stage.join("verified"),
            format!("{}\n{}\n", source.repo, source.revision),
        )
        .map_err(io_error)?;
        std::fs::rename(&stage, family_dir(profile, source, family)).map_err(io_error)
    })();
    if result.is_err() {
        let _ = std::fs::remove_dir_all(&stage);
    }
    result
}

fn download(
    client: &reqwest::blocking::Client,
    source: &Source,
    file: &File,
    destination: &Path,
    mut progress: impl FnMut(u64),
) -> Result<()> {
    let File(path, size, hash, repo, revision) = file;
    let repo = repo.as_deref().unwrap_or(&source.repo);
    let revision = revision.as_deref().unwrap_or(&source.revision);
    let addresses = [
        format!("https://raw.githubusercontent.com/{repo}/{revision}/{path}"),
        format!("https://cdn.jsdelivr.net/gh/{repo}@{revision}/{path}"),
    ];
    let mut last = io_error("no pinned font source is available");
    for url in addresses {
        let response = match client
            .get(url)
            .send()
            .and_then(|response| response.error_for_status())
        {
            Ok(response) if response.status().is_success() => response,
            Ok(_) => {
                last = io_error("font source returned a redirect");
                continue;
            }
            Err(error) => {
                last = io_error(error.without_url());
                continue;
            }
        };
        let mut output = std::fs::File::create(destination).map_err(io_error)?;
        match verify(response, &mut output, *size, hash, &mut progress) {
            Ok(()) => return output.sync_all().map_err(io_error),
            Err(error) => last = error,
        }
    }
    Err(last)
}

fn verify(
    input: impl Read,
    output: &mut impl Write,
    size: u64,
    hash: &str,
    mut progress: impl FnMut(u64),
) -> Result<()> {
    let mut reader = input.take(size + 1);
    let mut hasher = Sha256::new();
    let mut buffer = [0; 32 * 1024];
    let mut done = 0;
    loop {
        let read = reader.read(&mut buffer).map_err(io_error)?;
        if read == 0 {
            break;
        }
        done += read as u64;
        if done > size {
            return Err(io_error("font source exceeded the pinned size"));
        }
        let chunk = &buffer[..read];
        output.write_all(chunk).map_err(io_error)?;
        hasher.update(chunk);
        progress(done);
    }
    if done != size || hex::encode(hasher.finalize()) != hash {
        return Err(io_error(
            "font source did not match the pinned size and checksum",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pinned_catalog_and_checksum_validation() {
        assert_eq!(
            catalog()
                .iter()
                .map(|source| source.families.len())
                .sum::<usize>(),
            2070
        );
        assert_eq!(font_source("42dot Sans"), Some("Google Fonts"));
        assert_eq!(font_source("Noto Fangsong KSS Rotated"), Some("Noto"));
        let bytes = b"test";
        let hash = hex::encode(Sha256::digest(bytes));
        assert!(verify(bytes.as_slice(), &mut Vec::new(), 4, &hash, |_| {}).is_ok());
        assert!(verify(bytes.as_slice(), &mut Vec::new(), 3, &hash, |_| {}).is_err());
        assert!(verify(bytes.as_slice(), &mut Vec::new(), 4, "bad", |_| {}).is_err());
    }
}
