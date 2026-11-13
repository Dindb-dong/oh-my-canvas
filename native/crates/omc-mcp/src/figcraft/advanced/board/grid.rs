use super::*;

fn defaults() -> Value {
    json!({"style":"dots","spacing":24.,"major":5,"size":1.,"contrast":1.})
}

pub(super) fn preference(context: &Context) -> Result<Value> {
    let path = context
        .router
        .workspace
        .profile
        .join("native-v1/board-grid.json");
    let path_text = path
        .to_str()
        .ok_or_else(|| EngineError::invalid("Board grid preferences path is not UTF-8"))?;
    // Serialize settings writes using the workspace's settings lock.
    let _settings = context.router.workspace.catalog.lock().unwrap();
    let mut grid = std::fs::read(&path)
        .ok()
        .filter(|bytes| bytes.len() < 4096)
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .filter(Value::is_object)
        .unwrap_or_else(defaults);
    let params = context.params;
    if params["reset"] == true {
        grid = defaults();
    }
    if let Some(style) = params.get("style").filter(|value| !value.is_null()) {
        let style = style
            .as_str()
            .unwrap_or_default()
            .trim()
            .to_ascii_lowercase();
        if !matches!(style.as_str(), "dots" | "lines" | "graph" | "none") {
            return Err(EngineError::invalid(
                "style must be dots, lines, graph or none",
            ));
        }
        grid["style"] = json!(style);
    }
    for (key, min, max) in [
        ("spacing", 4., 512.),
        ("major", 2., 12.),
        ("size", 0.5, 4.),
        ("contrast", 0.25, 4.),
    ] {
        if let Some(value) = params.get(key).filter(|value| !value.is_null()) {
            let value = value
                .as_f64()
                .filter(|v| v.is_finite())
                .ok_or_else(|| EngineError::invalid(format!("{key} must be a finite number")))?;
            grid[key] = if key == "major" {
                json!(value.round().clamp(min, max) as u64)
            } else {
                json!(value.clamp(min, max))
            };
        }
    }
    if params["reset"] == true
        || ["style", "spacing", "major", "size", "contrast"]
            .iter()
            .any(|key| !params[key].is_null())
    {
        interchange::write_explicit(
            path_text,
            &serde_json::to_vec(&grid).map_err(|e| EngineError::invalid(e.to_string()))?,
            true,
        )?;
    }
    Ok(grid)
}
