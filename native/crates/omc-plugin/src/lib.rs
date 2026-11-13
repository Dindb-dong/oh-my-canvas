//! FigCraft-compatible Wasm ABI using the upstream metered sandbox.
#![forbid(unsafe_code)]

pub mod manifest;
pub mod sandbox;
pub mod widget;

fn color_hex(input: &str) -> Option<String> {
    let input = input.strip_prefix('#').unwrap_or(input);
    if !matches!(input.len(), 3 | 4 | 6 | 8) || !input.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return None;
    }
    let mut color = String::from("#");
    for ch in input.chars().map(|ch| ch.to_ascii_uppercase()) {
        color.push(ch);
        if input.len() < 6 {
            color.push(ch);
        }
    }
    if color.ends_with("FF") && color.len() == 9 {
        color.truncate(7);
    }
    Some(color)
}
