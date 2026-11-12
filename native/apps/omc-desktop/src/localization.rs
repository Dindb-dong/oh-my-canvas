use serde_json::Value;
use std::{path::Path, sync::OnceLock};

static LABELS: OnceLock<Value> = OnceLock::new();
static SYSTEM: OnceLock<String> = OnceLock::new();

pub fn chosen(profile: &Path) -> String {
    std::fs::read(profile.join("native-v1/profile-preferences.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .and_then(|prefs| prefs["language"].as_str().map(str::to_owned))
        .unwrap_or_else(|| "ko".into())
}

pub fn label<'a>(language: &str, key: &'a str) -> &'a str {
    let dictionaries = LABELS.get_or_init(|| {
        serde_json::from_str(include_str!("../locales/editor-labels.json"))
            .expect("embedded catalog")
    });
    let language = if language.eq_ignore_ascii_case("system") {
        SYSTEM.get_or_init(system_language).as_str()
    } else {
        language
    };
    let normalized = language.replace('_', "-").to_ascii_lowercase();
    let mut parts = normalized.split('-');
    let base = parts.next().unwrap_or("en");
    let region = parts.next().unwrap_or("");
    let matching = |tag: &str| {
        dictionaries
            .as_object()?
            .iter()
            .find_map(|(code, messages)| code.eq_ignore_ascii_case(tag).then_some(messages))
    };
    matching(&normalized)
        .or_else(|| match (base, region) {
            ("zh", "tw" | "hk" | "mo") => matching("zh-Hant"),
            ("zh", _) => matching("zh-Hans"),
            ("pt", _) => matching("pt-BR"),
            _ => matching(base),
        })
        .and_then(|messages| messages[key].as_str())
        .unwrap_or(key)
}

pub fn inspector_label<'a>(language: &str, authored: &'a str) -> &'a str {
    if language.eq_ignore_ascii_case("ko") {
        return authored;
    }
    let key = match authored {
        "위치" => "Position",
        "정렬" => "Alignment",
        "치수" => "Size",
        "회전" => "Rotation",
        "레이아웃" => "Layout",
        "모양" => "Appearance",
        "불투명도" => "Opacity",
        "타이포그래피" => "Typography",
        "채우기" => "Fill",
        "선" => "Stroke",
        "효과" => "Effects",
        "내보내기" => "Export",
        _ => return authored,
    };
    label(language, key)
}

fn system_language() -> String {
    let configured = ["LC_ALL", "LC_MESSAGES", "LANGUAGE", "LANG"]
        .into_iter()
        .filter_map(|name| std::env::var(name).ok())
        .filter_map(|value| value.split(['.', ':', '@']).next().map(str::to_owned))
        .find(|tag| !tag.is_empty() && tag != "C" && tag != "POSIX");
    if let Some(language) = configured {
        return language;
    }
    #[cfg(target_os = "macos")]
    if let Ok(output) = std::process::Command::new("/usr/bin/defaults")
        .args(["read", "-g", "AppleLocale"])
        .output()
        && output.status.success()
        && let Ok(language) = String::from_utf8(output.stdout)
    {
        return language.trim().into();
    }
    "en".into()
}
