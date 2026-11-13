use skia_safe::{FontMgr, textlayout::TypefaceFontProvider};
use std::{
    cell::RefCell,
    collections::BTreeMap,
    path::{Path, PathBuf},
};

type Cache = BTreeMap<PathBuf, (Vec<PathBuf>, Option<FontMgr>)>;
thread_local! {
    static CACHE: RefCell<Cache> = const { RefCell::new(BTreeMap::new()) };
}

/// Family directories are immutable and installed by atomic rename.
pub fn profile_font_generation(profile: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(profile.join("native-v1/font-store")) else {
        return Vec::new();
    };
    let mut families: Vec<_> = entries
        .flatten()
        .filter(|entry| {
            entry.file_type().is_ok_and(|kind| kind.is_dir())
                && entry.file_name().to_str().is_some_and(|name| {
                    name.len() == 64 && name.bytes().all(|b| b.is_ascii_hexdigit())
                })
        })
        .map(|entry| entry.path())
        .collect();
    families.sort();
    families
}

pub fn profile_font_manager(profile: &Path) -> Option<FontMgr> {
    let generation = profile_font_generation(profile);
    if let Some(manager) = CACHE.with(|cache| {
        cache
            .borrow()
            .get(profile)
            .and_then(|(previous, manager)| (*previous == generation).then(|| manager.clone()))
    }) {
        return manager;
    }
    let mut provider = TypefaceFontProvider::new();
    let system = FontMgr::default();
    let mut count = 0;
    for entry in generation
        .iter()
        .filter_map(|family| std::fs::read_dir(family).ok())
        .flatten()
        .flatten()
    {
        let path = entry.path();
        if !entry.file_type().is_ok_and(|kind| kind.is_file())
            || !matches!(
                path.extension().and_then(|value| value.to_str()),
                Some("ttf" | "otf" | "ttc" | "otc")
            )
        {
            continue;
        }
        let Ok(bytes) = std::fs::read(path) else {
            continue;
        };
        for index in 0..font_face_count(&bytes) {
            if let Some(face) = system.new_from_data(&bytes, Some(index)) {
                provider.register_typeface(face, None);
                count += 1;
            }
        }
    }
    let manager = (count != 0).then(|| FontMgr::from(provider));
    CACHE.with(|cache| {
        let mut cache = cache.borrow_mut();
        if cache.len() >= 8 && !cache.contains_key(profile) {
            cache.pop_first();
        }
        cache.insert(profile.to_owned(), (generation, manager.clone()));
    });
    manager
}

pub fn font_face_count(bytes: &[u8]) -> usize {
    if bytes.starts_with(b"ttcf") {
        bytes
            .get(8..12)
            .and_then(|count| count.try_into().ok())
            .map(u32::from_be_bytes)
            .filter(|count| (1..=64).contains(count))
            .unwrap_or(0) as usize
    } else {
        1
    }
}

const DOWNLOADS_ALLOWED: &[u8] = b"OMC_USER_ALLOWED_FONT_DOWNLOADS_V1\n";

fn permission_path(profile: &Path) -> PathBuf {
    profile.join("native-v1/allow-font-downloads")
}

pub fn profile_font_downloads_allowed(profile: &Path) -> bool {
    use std::io::Read;
    let path = permission_path(profile);
    let limit = DOWNLOADS_ALLOWED.len() as u64;
    if !std::fs::symlink_metadata(&path).is_ok_and(|info| info.is_file() && info.len() == limit) {
        return false;
    }
    let mut bytes = Vec::with_capacity(DOWNLOADS_ALLOWED.len());
    std::fs::File::open(path)
        .and_then(|file| file.take(limit + 1).read_to_end(&mut bytes))
        .is_ok_and(|_| bytes == DOWNLOADS_ALLOWED)
}

/// This is an owner-side setting. MCP routes only read it.
pub fn set_profile_font_downloads(profile: &Path, allowed: bool) -> std::io::Result<()> {
    use std::{
        io::{ErrorKind, Write},
        sync::atomic::{AtomicU64, Ordering},
    };

    let path = permission_path(profile);
    if !allowed {
        return match std::fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error),
        };
    }
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let parent = path.parent().unwrap();
    std::fs::create_dir_all(parent)?;
    let stage = parent.join(format!(
        ".allow-font-downloads-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed),
    ));
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&stage)?;
    let result = file
        .write_all(DOWNLOADS_ALLOWED)
        .and_then(|_| file.sync_all());
    drop(file);
    let result = result.and_then(|_| std::fs::rename(&stage, path));
    if result.is_err() {
        let _ = std::fs::remove_file(stage);
    }
    result
}
