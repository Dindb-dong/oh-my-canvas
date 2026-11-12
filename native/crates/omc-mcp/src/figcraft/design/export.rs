use super::*;
use base64::{Engine, engine::general_purpose::STANDARD};
use std::{
    io::{Cursor, Write},
    path::{Path, PathBuf},
};
use zip::{CompressionMethod, ZipWriter, write::SimpleFileOptions};

const MAX_FILES: usize = 1000;
const MAX_BYTES: usize = 256 << 20;
const BOOL_OPTIONS: &[&str] = &[
    "cropMarks",
    "bleedMarks",
    "cmyk",
    "contentsOnly",
    "includeBoundingBox",
    "svgOutlineText",
    "svgIdAttribute",
    "svgSimplifyStroke",
];
const FILE_OVERRIDES: &[&str] = &[
    "bleed",
    "cropMarks",
    "bleedMarks",
    "cmyk",
    "vdCompat",
    "colorProfile",
];

fn settings_of(node: &Node) -> &[Value] {
    node.properties
        .get("exports")
        .and_then(Value::as_array)
        .map_or(&[], Vec::as_slice)
}

fn default_setting() -> Value {
    json!({"size":{"by":"scale","value":1},"suffix":"","format":"png","quality":90})
}

fn next_setting(previous: Option<&Value>) -> Value {
    let mut next = default_setting();
    if let Some(scale) = previous
        .filter(|previous| previous["size"]["by"] == "scale")
        .and_then(|previous| previous["size"]["value"].as_f64())
    {
        let scale = (scale.floor() + 1.).min(64.);
        next["size"] = json!({"by":"scale","value":scale});
        next["suffix"] = json!(format!("@{scale}x"));
    }
    next
}

pub(crate) fn normalize_fig_export_setting(patch: &Value) -> Result<Value> {
    let mut setting = default_setting();
    merge_setting(&mut setting, patch)?;
    Ok(setting)
}

fn merge_setting(setting: &mut Value, patch: &Value) -> Result<()> {
    if !patch.is_object() {
        return Err(EngineError::invalid("export setting must be an object"));
    }
    if let Some(size) = patch.get("size").filter(|value| !value.is_null()) {
        let normalized;
        let size = if let Some(text) = size.as_str() {
            let text = text.trim().trim_start_matches('@').to_ascii_lowercase();
            normalized = if let Ok(value) = text.parse::<f64>() {
                json!({"by":"scale","value":value})
            } else {
                json!(text)
            };
            &normalized
        } else if let Some(value) = size.as_f64() {
            normalized = json!({"by":"scale","value":value});
            &normalized
        } else {
            size
        };
        let constraint = fig_export_size(size)?;
        let max = if constraint["type"] == "scale" {
            64.
        } else {
            16_384.
        };
        if constraint["value"].as_f64().unwrap() > max {
            return Err(EngineError::invalid(format!(
                "size value cannot exceed {max}"
            )));
        }
        setting["size"] = json!({"by":constraint["type"],"value":constraint["value"]});
    }
    if let Some(suffix) = patch.get("suffix").filter(|value| !value.is_null()) {
        let suffix = suffix
            .as_str()
            .ok_or_else(|| EngineError::invalid("suffix must be a string"))?;
        setting["suffix"] = json!(
            suffix
                .chars()
                .filter(|c| !c.is_control())
                .take(200)
                .collect::<String>()
        );
    }
    if let Some(format) = patch.get("format").filter(|value| !value.is_null()) {
        let format = format.as_str().unwrap_or_default().to_ascii_lowercase();
        let format = match format.as_str() {
            "jpeg" => "jpg",
            "png" | "jpg" | "svg" | "pdf" | "webp" | "xml" => &format,
            _ => {
                return Err(EngineError::invalid(
                    "format must be png, jpg, svg, pdf, webp or xml",
                ));
            }
        };
        setting["format"] = json!(format);
    }
    if let Some(value) = patch.get("quality").filter(|value| !value.is_null()) {
        let quality = value
            .as_u64()
            .filter(|value| (1..=100).contains(value))
            .ok_or_else(|| EngineError::invalid("quality must be an integer between 1 and 100"))?;
        setting["quality"] = json!(quality);
    }
    if let Some(value) = patch.get("bleed").filter(|value| !value.is_null()) {
        setting["bleed"] = json!(bleed_points(value)?);
    }
    for (key, allowed) in [
        ("vdCompat", &["bestEffort", "exact", "ignore"][..]),
        ("colorProfile", &["sameAsFile", "srgb", "displayP3"][..]),
    ] {
        if let Some(value) = patch.get(key).filter(|value| !value.is_null()) {
            let value = value
                .as_str()
                .filter(|value| allowed.contains(value))
                .ok_or_else(|| {
                    EngineError::invalid(format!("{key} must be {}", allowed.join(", ")))
                })?;
            setting[key] = json!(value);
        }
    }
    for key in BOOL_OPTIONS {
        if let Some(value) = patch.get(key).filter(|value| !value.is_null()) {
            setting[key] = json!(
                value
                    .as_bool()
                    .ok_or_else(|| EngineError::invalid(format!("{key} must be a boolean")))?
            );
        }
    }
    Ok(())
}

fn bleed_points(value: &Value) -> Result<f64> {
    let parsed = value.as_f64().or_else(|| {
        let text = value.as_str()?.trim();
        for (unit, scale) in [
            ("mm", 72. / 25.4),
            ("cm", 72. / 2.54),
            ("in", 72.),
            ("pt", 1.),
        ] {
            if let Some(number) = text.strip_suffix(unit) {
                return number
                    .trim()
                    .parse::<f64>()
                    .ok()
                    .map(|number| number * scale);
            }
        }
        text.parse().ok()
    });
    parsed
        .filter(|value| (0. ..=144.).contains(value))
        .ok_or_else(|| EngineError::invalid("bleed must be between 0 and 144 points"))
}

pub(super) fn settings(
    snapshot: &DocumentSnapshot,
    ids: &[String],
    action: &str,
    params: &Value,
    commands: &mut Vec<Command>,
) -> Result<Value> {
    let index = if action == "add" {
        None
    } else {
        Some(
            optional_index(params, "index")?
                .ok_or_else(|| EngineError::invalid("index is required"))?,
        )
    };
    let mut patch = default_setting();
    match action {
        "add" => {
            if let Some(setting) = params.get("setting").filter(|value| !value.is_null()) {
                merge_setting(&mut patch, setting)?;
            }
        }
        "update" => merge_setting(&mut patch, params)?,
        _ => {}
    }
    for id in ids {
        let mut list = settings_of(&snapshot.nodes[id]).to_vec();
        match (action, index) {
            ("add", _) => list.push(if params["setting"].is_null() {
                next_setting(list.last())
            } else {
                patch.clone()
            }),
            ("update", Some(index)) if index < list.len() => {
                merge_setting(&mut list[index], params)?
            }
            ("remove", Some(index)) if index < list.len() => {
                list.remove(index);
            }
            _ => continue,
        }
        commands.push(set(id, json!({"exports": list}))?);
    }
    Ok(json!({"ok":true}))
}

struct ExportJob {
    id: String,
    name: String,
    setting: Value,
}

impl ToolRouter {
    pub(super) fn fig_export_layers(
        &self,
        session: &str,
        snapshot: &DocumentSnapshot,
        state: &ViewState,
        selection: &[Value],
        params: &Value,
    ) -> Result<Value> {
        let assets = params["assets"].as_bool().unwrap_or(false);
        let mut ids = self.fig_layers(session, snapshot, fig_ids(params, selection)?)?;
        if ids.is_empty() {
            ids = if assets {
                vec![state.root.clone()]
            } else {
                descendants(snapshot, &[state.root.clone()])
                    .into_iter()
                    .filter(|id| !settings_of(&snapshot.nodes[id]).is_empty())
                    .collect()
            };
        }
        let directory = params
            .get("dir")
            .filter(|value| !value.is_null())
            .map(|value| {
                value
                    .as_str()
                    .map(PathBuf::from)
                    .filter(|path| path.is_absolute())
                    .ok_or_else(|| EngineError::invalid("dir must be an absolute path"))
            })
            .transpose()?;
        let overwrite = params["overwrite"].as_bool().unwrap_or(false);
        let archive = directory.is_none() && params["zip"].as_bool().unwrap_or(false);
        let overrides = Value::Object(
            FILE_OVERRIDES
                .iter()
                .filter_map(|key| {
                    params
                        .get(key)
                        .filter(|value| !value.is_null())
                        .map(|value| (key.to_string(), value.clone()))
                })
                .collect(),
        );
        let mut validation = default_setting();
        merge_setting(&mut validation, &overrides)?;
        let jobs = jobs(snapshot, &ids, assets)?;
        if jobs.is_empty() {
            return Err(EngineError::invalid(
                "no export settings; add one with export.add",
            ));
        }
        let mut files = Vec::with_capacity(jobs.len());
        let mut artifacts = Vec::with_capacity(jobs.len());
        let mut used = BTreeSet::new();
        let mut bytes_total = 0usize;
        for job in jobs {
            let mut setting = job.setting;
            if ["bleed", "cropMarks", "bleedMarks", "cmyk"]
                .iter()
                .any(|key| !overrides[key].is_null())
            {
                for (key, value) in [
                    ("bleed", json!(0)),
                    ("cropMarks", json!(false)),
                    ("bleedMarks", json!(false)),
                    ("cmyk", json!(false)),
                ] {
                    setting[key] = value;
                }
            }
            merge_setting(&mut setting, &overrides)?;
            let format = setting["format"].as_str().unwrap_or("png");
            let page = page_of(snapshot, &job.id)?;
            let mut args = json!({
                "format":format,
                "ids":[job.id],
                "pageId":page,
                "quality":setting["quality"].as_u64().unwrap_or(90) as f64 / 100.,
                "constraint":fig_export_size(&setting["size"])?,
            });
            apply_export_options(
                snapshot,
                page,
                &[job.id.clone()],
                format,
                &setting,
                &mut args,
            )?;
            let artifact = self.export_snapshot_native(snapshot.clone(), &args)?;
            bytes_total = bytes_total.saturating_add(artifact.bytes.len());
            if bytes_total > MAX_BYTES {
                return Err(EngineError::new(
                    "resource_limit",
                    "layer export exceeds 256 MiB",
                ));
            }
            let alias = self.fig_alias(session, &snapshot.id, &job.id);
            used.insert(job.id);
            let mut file = json!({"name":job.name,"id":alias,"bytes":artifact.bytes.len()});
            if format == "xml" {
                file["warnings"] = json!(
                    artifact
                        .diagnostics
                        .iter()
                        .filter(
                            |diagnostic| diagnostic.code == "vector_drawable_compatibility"
                                || (args["vdCompat"] != "ignore" && diagnostic.fidelity_lost)
                        )
                        .map(|diagnostic| &diagnostic.original)
                        .collect::<Vec<_>>()
                );
            }
            files.push(file);
            artifacts.push(artifact.bytes);
        }
        let skipped = ids.iter().filter(|id| !used.contains(*id)).count();
        let data = if let Some(directory) = directory {
            std::fs::create_dir_all(&directory).map_err(resources::io_error)?;
            let directory = std::fs::canonicalize(directory).map_err(resources::io_error)?;
            let paths = files
                .iter()
                .map(|file| prepare_output(&directory, file["name"].as_str().unwrap(), overwrite))
                .collect::<Result<Vec<_>>>()?;
            for ((file, bytes), path) in files.iter_mut().zip(artifacts).zip(paths) {
                interchange::write_explicit(&path, &bytes, overwrite)?;
                file["path"] = json!(path);
            }
            None
        } else if archive {
            let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
            let options =
                SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
            for (file, bytes) in files.iter().zip(artifacts) {
                writer
                    .start_file(file["name"].as_str().unwrap(), options)
                    .map_err(zip_error)?;
                writer.write_all(&bytes).map_err(resources::io_error)?;
            }
            Some(STANDARD.encode(writer.finish().map_err(zip_error)?.into_inner()))
        } else {
            for (file, bytes) in files.iter_mut().zip(artifacts) {
                file["data"] = json!(STANDARD.encode(bytes));
            }
            None
        };
        let mut output = json!({"files":files,"skipped":skipped});
        if let Some(data) = data {
            output["data"] = json!(data);
        }
        Ok(output)
    }
}

fn page_of<'a>(snapshot: &'a DocumentSnapshot, id: &'a str) -> Result<&'a str> {
    let mut node = &snapshot.nodes[id];
    while let Some(parent) = node.parent_id.as_ref() {
        node = &snapshot.nodes[parent];
    }
    snapshot
        .pages
        .iter()
        .find(|page| page.root_node_id == node.id)
        .map(|page| page.id.as_str())
        .ok_or_else(|| EngineError::invalid("layer does not belong to a page"))
}

pub(crate) fn apply_export_options(
    snapshot: &DocumentSnapshot,
    page: &str,
    ids: &[String],
    format: &str,
    setting: &Value,
    args: &mut Value,
) -> Result<()> {
    let unavailable = |feature| {
        EngineError::new(
            "unsupported_feature",
            format!("layer export does not support {feature}"),
        )
    };
    if format == "xml" {
        args["vdCompat"] = setting["vdCompat"].clone();
        args["strict"] = json!(false);
    }
    if format == "pdf" {
        for key in ["bleed", "cropMarks", "bleedMarks", "cmyk"] {
            args[key] = setting[key].clone();
        }
    }
    if matches!(format, "png" | "jpg" | "webp") {
        args["colorProfile"] = match setting["colorProfile"].as_str() {
            None | Some("sameAsFile") => snapshot
                .metadata
                .get("colorProfile")
                .cloned()
                .unwrap_or(json!("srgb")),
            Some(profile) => json!(profile),
        };
    }
    if format == "svg" {
        args["svgOutlineText"] = json!(setting["svgOutlineText"].as_bool().unwrap_or(true));
        args["svgSimplifyStroke"] = json!(setting["svgSimplifyStroke"].as_bool().unwrap_or(true));
        if setting["svgIdAttribute"] == true {
            return Err(unavailable("custom SVG layer IDs"));
        }
    }
    let slice = ids.iter().any(|id| snapshot.nodes.get(id).is_some_and(|node| node.string("primitive") == Some("slice")));
    let surrounding = setting["contentsOnly"] == false || slice;
    if setting["includeBoundingBox"] == true || surrounding {
        let scene = paths::scene(snapshot, page)?;
        let [x, y, right, bottom] = ids
            .iter()
            .filter_map(|id| scene.item(id))
            .map(|item| {
                let [x, y, width, height] = if setting["includeBoundingBox"] == true {
                    item.world.bounds(item.width, item.height)
                } else {
                    item.bounds
                };
                [x, y, x + width, y + height]
            })
            .reduce(
                |[x, y, right, bottom], [next_x, next_y, next_right, next_bottom]| {
                    [
                        x.min(next_x),
                        y.min(next_y),
                        right.max(next_right),
                        bottom.max(next_bottom),
                    ]
                },
            )
            .ok_or_else(|| EngineError::invalid("export layer is unavailable"))?;
        let (width, height) = (right - x, bottom - y);
        args["bounds"] = json!({"x":x,"y":y,"width":width.max(1.),"height":height.max(1.)});
    }
    if surrounding {
        let root = snapshot
            .pages
            .iter()
            .find(|candidate| candidate.id == page)
            .ok_or_else(|| EngineError::invalid("page unavailable"))?;
        args["ids"] = json!(
            children(snapshot, &root.root_node_id)
                .into_iter()
                .filter(|node| node.string("primitive") != Some("slice"))
                .map(|node| &node.id)
                .collect::<Vec<_>>()
        );
    }
    Ok(())
}

fn descendants(snapshot: &DocumentSnapshot, roots: &[String]) -> Vec<String> {
    let mut stack = roots.iter().rev().cloned().collect::<Vec<_>>();
    let mut seen = BTreeSet::new();
    let mut ids = Vec::new();
    while let Some(id) = stack.pop() {
        if seen.insert(id.clone()) {
            stack.extend(
                children(snapshot, &id)
                    .into_iter()
                    .rev()
                    .map(|child| child.id.clone()),
            );
            ids.push(id);
        }
    }
    ids
}

fn jobs(snapshot: &DocumentSnapshot, roots: &[String], assets: bool) -> Result<Vec<ExportJob>> {
    let mut pending = roots.iter().rev().cloned().collect::<Vec<_>>();
    let mut visited = BTreeSet::new();
    let mut names = BTreeSet::new();
    let mut jobs = Vec::new();
    while let Some(id) = pending.pop() {
        if !visited.insert(id.clone()) {
            continue;
        }
        let node = &snapshot.nodes[&id];
        if assets
            && (node.properties.get("hidden") == Some(&Value::Bool(true))
                || node.properties.get("visible") == Some(&Value::Bool(false)))
        {
            continue;
        }
        let mut settings = settings_of(node).to_vec();
        let mut icon = false;
        if assets && settings.is_empty() && node.parent_id.is_some() {
            let mut has_path = false;
            icon = node.number("width", 0.) <= 128.
                && node.number("height", 0.) <= 128.
                && vector_only(snapshot, node, 0, &mut has_path)
                && has_path;
            if icon {
                let mut setting = default_setting();
                setting["format"] = json!("svg");
                settings.push(setting);
            } else if has_image(node) {
                settings.push(default_setting());
            }
        }
        if assets && !icon {
            pending.extend(
                children(snapshot, &id)
                    .into_iter()
                    .rev()
                    .map(|child| child.id.clone()),
            );
        }
        for setting in settings {
            let setting = normalize_fig_export_setting(&setting)?;
            if jobs.len() == MAX_FILES {
                return Err(EngineError::new(
                    "resource_limit",
                    "layer export exceeds 1000 files",
                ));
            }
            let base = node
                .string("name")
                .unwrap_or("Untitled")
                .split('/')
                .map(safe_name)
                .map(|part| part.trim().trim_end_matches('.').to_owned())
                .filter(|part| !part.is_empty())
                .take(32)
                .collect::<Vec<_>>()
                .join("/");
            let base = if base.is_empty() { "Untitled" } else { &base };
            let format = setting["format"].as_str().unwrap_or("png");
            let mut suffix = setting["suffix"].as_str().unwrap_or_default().to_owned();
            if suffix.is_empty()
                && matches!(format, "png" | "jpg" | "webp")
                && setting["size"]["by"] == "scale"
                && let Some(scale) = setting["size"]["value"]
                    .as_f64()
                    .filter(|scale| *scale != 1.)
            {
                suffix = format!("@{scale}x");
            }
            let stem = format!("{base}{}", safe_name(&suffix));
            let name = (1..)
                .map(|number| {
                    if number == 1 {
                        format!("{stem}.{format}")
                    } else {
                        format!("{stem} {number}.{format}")
                    }
                })
                .find(|name| names.insert(name.to_lowercase()))
                .unwrap();
            jobs.push(ExportJob {
                id: id.clone(),
                name,
                setting,
            });
        }
    }
    Ok(jobs)
}

fn has_image(node: &Node) -> bool {
    node.kind == NodeKind::Image
        || node
            .properties
            .get("fills")
            .and_then(Value::as_array)
            .is_some_and(|paints| {
                paints
                    .iter()
                    .any(|paint| paint["type"] == "image" && paint["visible"] != false)
            })
}

fn vector_only(
    snapshot: &DocumentSnapshot,
    node: &Node,
    depth: usize,
    has_path: &mut bool,
) -> bool {
    if node.properties.get("hidden") == Some(&Value::Bool(true))
        || node.properties.get("visible") == Some(&Value::Bool(false))
    {
        return true;
    }
    if has_image(node)
        || node
            .properties
            .get("fills")
            .and_then(Value::as_array)
            .is_some_and(|paints| paints.iter().any(|paint| paint["type"] == "pattern"))
    {
        return false;
    }
    match node.kind {
        NodeKind::Path | NodeKind::Line => {
            *has_path = true;
            true
        }
        NodeKind::Rect | NodeKind::Ellipse => true,
        NodeKind::Group | NodeKind::Frame | NodeKind::Component | NodeKind::Instance
            if depth < 16 =>
        {
            let children = children(snapshot, &node.id);
            !children.is_empty()
                && children
                    .into_iter()
                    .all(|node| vector_only(snapshot, node, depth + 1, has_path))
        }
        _ => false,
    }
}

fn safe_name(name: &str) -> String {
    name.chars()
        .take(100)
        .map(|character| {
            if character.is_control() || "/\\:*?\"<>|".contains(character) {
                '_'
            } else {
                character
            }
        })
        .collect()
}

fn prepare_output(root: &Path, name: &str, overwrite: bool) -> Result<String> {
    let mut path = root.to_path_buf();
    let mut components = Path::new(name).components().peekable();
    while let Some(component) = components.next() {
        let std::path::Component::Normal(segment) = component else {
            return Err(EngineError::invalid("invalid output name"));
        };
        path.push(segment);
        match std::fs::symlink_metadata(&path) {
            Ok(metadata) if components.peek().is_some() && metadata.is_dir() => {}
            Ok(metadata) if components.peek().is_none() && metadata.is_file() && overwrite => {}
            Ok(_) => return Err(EngineError::new("conflict", "output path already exists")),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                if components.peek().is_some() {
                    std::fs::create_dir(&path).map_err(resources::io_error)?;
                }
            }
            Err(error) => return Err(resources::io_error(error)),
        }
    }
    path.to_str()
        .map(str::to_owned)
        .ok_or_else(|| EngineError::invalid("invalid output path encoding"))
}

fn zip_error(error: zip::result::ZipError) -> EngineError {
    EngineError::new("io_error", error.to_string())
}
