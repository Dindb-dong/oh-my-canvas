use serde_json::{Value, json};

pub fn parse_stroke_brush(params: &Value) -> Result<Value, String> {
    let Some(preset) = params.get("preset").filter(|value| !value.is_null()) else {
        return Ok(Value::Null);
    };
    let preset = preset.as_str().ok_or("brush preset must be a string")?;
    if !matches!(
        preset,
        "taper" | "ink" | "ribbon" | "bristle" | "dots" | "stars" | "confetti" | "leaves"
    ) {
        return Err("unknown brush preset".into());
    }
    let mut brush = json!({"preset":preset});
    for (key, default, min, max) in [
        ("spacing", 1.5, 0.1, 100.),
        ("sizeJitter", 0., 0., 1.),
        ("rotationJitter", 0., 0., 1.),
        ("scatter", 0., 0., 4.),
    ] {
        let value = params.get(key).map_or(Ok(default), |value| {
            value
                .as_f64()
                .filter(|value| value.is_finite())
                .ok_or_else(|| format!("{key} must be a finite number"))
        })?;
        brush[key] = json!(value.clamp(min, max));
    }
    let seed = params.get("seed").map_or(Ok(0), |value| {
        value.as_u64().ok_or("seed must be a nonnegative integer")
    })?;
    brush["seed"] = json!(seed.min(u64::from(u32::MAX)));
    Ok(brush)
}
