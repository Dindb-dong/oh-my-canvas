use serde::{Deserialize, Serialize};
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Color {
    pub r: f32,
    pub g: f32,
    pub b: f32,
    pub a: f32,
}
impl Color {
    pub const TRANSPARENT: Self = Self {
        r: 0.,
        g: 0.,
        b: 0.,
        a: 0.,
    };
    pub fn rgba(self) -> [f32; 4] {
        [self.r, self.g, self.b, self.a]
    }
    pub fn hex(self) -> String {
        format!(
            "#{:02x}{:02x}{:02x}{:02x}",
            (self.r.clamp(0., 1.) * 255.).round() as u8,
            (self.g.clamp(0., 1.) * 255.).round() as u8,
            (self.b.clamp(0., 1.) * 255.).round() as u8,
            (self.a.clamp(0., 1.) * 255.).round() as u8
        )
    }
}
pub fn parse_color(input: &str) -> Option<Color> {
    let lower = input.trim().to_ascii_lowercase();
    let s = lower.as_str();
    let known = match s {
        "transparent" => Some("#00000000"),
        "black" => Some("#000000"),
        "white" => Some("#ffffff"),
        "red" => Some("#ff0000"),
        "green" => Some("#008000"),
        "blue" => Some("#0000ff"),
        "yellow" => Some("#ffff00"),
        "gray" | "grey" => Some("#808080"),
        "orange" => Some("#ffa500"),
        "purple" => Some("#800080"),
        "pink" => Some("#ffc0cb"),
        "cyan" | "aqua" => Some("#00ffff"),
        "magenta" | "fuchsia" => Some("#ff00ff"),
        "navy" => Some("#000080"),
        "teal" => Some("#008080"),
        "lime" => Some("#00ff00"),
        "silver" => Some("#c0c0c0"),
        "maroon" => Some("#800000"),
        "olive" => Some("#808000"),
        "rebeccapurple" => Some("#663399"),
        _ => None,
    };
    let s = known.unwrap_or(s);
    if let Some(hex) = s.strip_prefix('#') {
        let full = match hex.len() {
            3 | 4 => hex.chars().flat_map(|c| [c, c]).collect::<String>(),
            6 | 8 => hex.into(),
            _ => return None,
        };
        let byte = |at| {
            u8::from_str_radix(&full[at..at + 2], 16)
                .ok()
                .map(|v| v as f32 / 255.)
        };
        if !full.is_ascii() {
            return None;
        }
        return Some(Color {
            r: byte(0)?,
            g: byte(2)?,
            b: byte(4)?,
            a: if full.len() == 8 { byte(6)? } else { 1. },
        });
    }
    let (function, body) = s.split_once('(')?;
    let body = body.strip_suffix(')')?;
    let pieces: Vec<_> = body
        .split([',', '/', ' '])
        .filter(|s| !s.is_empty())
        .collect();
    if pieces.len() != 3 && pieces.len() != 4 {
        return None;
    }
    let alpha = if pieces.len() == 4 {
        channel(pieces[3], 1.)?
    } else {
        1.
    };
    match function {
        "rgb" | "rgba" => Some(Color {
            r: channel(pieces[0], 255.)?,
            g: channel(pieces[1], 255.)?,
            b: channel(pieces[2], 255.)?,
            a: alpha,
        }),
        "hsl" | "hsla" => {
            let h = pieces[0]
                .trim_end_matches("deg")
                .parse::<f32>()
                .ok()?
                .rem_euclid(360.)
                / 60.;
            let sat = channel(pieces[1], 1.)?;
            let light = channel(pieces[2], 1.)?;
            let c = (1. - (2. * light - 1.).abs()) * sat;
            let x = c * (1. - (h % 2. - 1.).abs());
            let m = light - c / 2.;
            let (r, g, b) = match h as u32 {
                0 => (c, x, 0.),
                1 => (x, c, 0.),
                2 => (0., c, x),
                3 => (0., x, c),
                4 => (x, 0., c),
                _ => (c, 0., x),
            };
            Some(Color {
                r: r + m,
                g: g + m,
                b: b + m,
                a: alpha,
            })
        }
        _ => None,
    }
}
fn channel(s: &str, max: f32) -> Option<f32> {
    let n = if let Some(s) = s.strip_suffix('%') {
        s.parse::<f32>().ok()? / 100.
    } else {
        s.parse::<f32>().ok()? / max
    };
    n.is_finite().then_some(n.clamp(0., 1.))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn colors_and_alpha() {
        assert_eq!(parse_color("#abc8").unwrap().hex(), "#aabbcc88");
        assert_eq!(
            parse_color("rgb(100% 0% 0% / 50%)").unwrap().hex(),
            "#ff000080"
        );
        assert_eq!(
            parse_color("hsl(120deg 100% 50%)").unwrap().hex(),
            "#00ff00ff"
        );
        assert!(parse_color("url(file:///etc/passwd)").is_none());
    }
}
