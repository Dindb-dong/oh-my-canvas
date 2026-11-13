use super::{Value, parse_color};

pub fn board_ink_color(value: &Value) -> Result<String, String> {
    let value = value.as_str().ok_or_else(|| "color must be text")?;
    let hex = match value.to_ascii_lowercase().as_str() {
        "yellow" => "#ffe78a",
        "orange" => "#ffc994",
        "red" => "#ffaea6",
        "pink" => "#f7b9da",
        "violet" => "#d4c2fc",
        "blue" => "#acd3fa",
        "green" => "#c2e8a6",
        "gray" => "#e3e1dd",
        _ => value,
    };
    let color = parse_color(hex).ok_or_else(|| "Unknown board color")?;
    let [r, g, b, a] =
        [color.r, color.g, color.b, color.a].map(|value| (value * 255.).round() as u8);
    Ok(if a == 255 {
        format!("#{r:02x}{g:02x}{b:02x}")
    } else {
        format!("#{r:02x}{g:02x}{b:02x}{a:02x}")
    })
}

pub fn board_stamp_name(value: &Value) -> Result<&'static str, String> {
    if value.is_null() {
        return Ok("thumbsUp");
    }
    let text = value.as_str().ok_or("stamp must be text")?;
    match text.to_ascii_lowercase().as_str() {
        "thumbsup" => Ok("thumbsUp"),
        "heart" => Ok("heart"),
        "plusone" => Ok("plusOne"),
        "star" => Ok("star"),
        "question" => Ok("question"),
        "check" => Ok("check"),
        _ => Err("Unknown board stamp".into()),
    }
}
