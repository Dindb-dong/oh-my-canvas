use super::ComputedStyle;
use omc_model::{Node, NodeKind, Properties};
use serde_json::json;

const TEXT: &[&str] = &[
    "fontFamily",
    "fontWeight",
    "fontStyle",
    "fontSize",
    "lineHeight",
    "letterSpacing",
];
const CORNERS: &[&str] = &[
    "radius",
    "radii",
    "cornerRadius",
    "cornerSmoothing",
    "radiusTopLeft",
    "radiusTopRight",
    "radiusBottomLeft",
    "radiusBottomRight",
];
const APPEARANCE: &[&str] = &[
    "fill",
    "fills",
    "stroke",
    "strokes",
    "strokeWidth",
    "strokeAlignment",
    "strokeSides",
    "strokeCap",
    "strokeJoin",
    "strokeDashArray",
    "effects",
    "shadows",
    "opacity",
    "blendMode",
];

pub fn is_appearance_key(key: &str) -> bool {
    APPEARANCE.contains(&key)
}

pub fn copy_appearance_keys(node: &Node) -> impl Iterator<Item = &'static str> {
    let text = if node.kind == NodeKind::Text {
        TEXT
    } else {
        &[]
    };
    let corners = if matches!(
        node.kind,
        NodeKind::Frame | NodeKind::Rect | NodeKind::Component
    ) {
        CORNERS
    } else {
        &[]
    };
    APPEARANCE.iter().chain(corners).chain(text).copied()
}

/// Copy rendered appearance values without linking the next layer to its source style.
pub fn drawing_defaults(node: &Node, appearance: &Properties, style: &ComputedStyle) -> Properties {
    let is_text = node.kind == NodeKind::Text;
    let effects = ["blur", "blurHidden", "backgroundBlur", "backdropBlur"];
    let typography = [
        ("fontFamily", "font-family"),
        ("fontSize", "font-size"),
        ("fontWeight", "font-weight"),
        ("fontStyle", "font-style"),
        ("lineHeight", "line-height"),
        ("letterSpacing", "letter-spacing"),
        ("textDecoration", "text-decoration"),
        ("textDecorationStyle", "text-decoration-style"),
        ("textDecorationColor", "text-decoration-color"),
        ("textDecorationThickness", "text-decoration-thickness"),
        ("textAlign", "text-align"),
        ("textCase", "text-transform"),
        ("fontVariations", "omc-font-variations"),
        ("fontFeatures", "omc-font-features"),
    ];
    let mut properties: Properties = copy_appearance_keys(node)
        .chain(effects)
        .filter_map(|key| {
            appearance
                .get(key)
                .map(|value| (key.to_owned(), value.clone()))
        })
        .collect();
    for (property, css) in [
        ("opacity", "opacity"),
        ("strokeWidth", "border-width"),
        ("cornerRadius", "border-radius"),
    ] {
        if !properties.contains_key(property)
            && let Some(value) = style
                .get(css)
                .and_then(|value| value.trim_end_matches("px").parse::<f64>().ok())
        {
            properties.insert(property.into(), json!(value));
        }
    }
    if !properties.contains_key("stroke")
        && let Some(color) = style.color("border-color")
    {
        properties.insert("stroke".into(), json!(color.hex()));
    }
    if is_text {
        for (key, css) in typography {
            if let Some(value) = appearance.get(key) {
                properties.insert(key.into(), value.clone());
            } else if let Some(value) = style.get(css) {
                properties.entry(key.into()).or_insert(json!(value));
            }
        }
    }
    if !properties.contains_key("fill") {
        let css = if is_text { "color" } else { "background-color" };
        properties.insert(
            "fill".into(),
            json!(
                style
                    .color(css)
                    .map(|color| color.hex())
                    .unwrap_or_else(|| {
                        if is_text {
                            "#000000".into()
                        } else {
                            "transparent".into()
                        }
                    })
            ),
        );
    }
    properties
}
