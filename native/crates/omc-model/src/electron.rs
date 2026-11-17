//! Metadata shared by Electron import and the native scene projection.
use crate::Node;
use serde_json::{Map, Value, json};

pub const COMPONENT_FIELDS: &[&str] = &[
    "name",
    "x",
    "y",
    "width",
    "height",
    "rotation",
    "visible",
    "opacity",
    "clipContent",
    "blendMode",
    "fills",
    "fill",
    "strokes",
    "stroke",
    "strokeWidth",
    "shadows",
    "blur",
    "backgroundBlur",
    "blurHidden",
    "backgroundBlurHidden",
    "radii",
    "radius",
    "cornerRadius",
    "radiusTopLeft",
    "radiusTopRight",
    "radiusBottomRight",
    "radiusBottomLeft",
    "cornerSmoothing",
    "fontFamily",
    "fontSize",
    "fontWeight",
    "fontStyle",
    "lineHeight",
    "letterSpacing",
    "text",
    "textRuns",
    "textAlign",
    "textVerticalAlign",
    "path",
    "assetHash",
];

pub fn is_component_definition(node: &Node) -> bool {
    node.kind == crate::NodeKind::Component || node.properties.contains_key("electronComponentMain")
}

pub fn component_link(source: &Node, instance: &Node, overrides: &Value, root: bool) -> Value {
    let inherited = COMPONENT_FIELDS.iter().copied().filter(|field| {
        if root && matches!(*field, "x" | "y") {
            return false;
        }
        if overrides.get(*field).is_some() {
            return false;
        }
        let aliases: &[&str] = match *field {
            "text" | "textRuns" => &["characters", "content", "textStyle"],
            "fontFamily" | "fontSize" | "fontWeight" | "fontStyle" | "textAlign"
            | "textVerticalAlign" | "lineHeight" | "letterSpacing" => &["textStyle", "content"],
            "width" => &["hSizing", "widthSizing", "inlineStyles"],
            "height" => &["vSizing", "heightSizing", "inlineStyles"],
            "fill" | "fills" => &["fillStyleId"],
            "stroke" | "strokes" | "strokeWidth" => &["strokeStyleId"],
            "shadows" | "blur" | "backgroundBlur" => &["effects", "effectStyleId"],
            "visible" => &["hidden"],
            _ => &[],
        };
        !aliases.iter().any(|alias| overrides.get(*alias).is_some())
    });
    let fields: Map<_, _> = inherited
        .map(|field| {
            (
                field.into(),
                json!([source.properties.get(field), instance.properties.get(field)]),
            )
        })
        .collect();
    json!({"nodeId":source.id,"fields":fields,"root":root,"propertyValues":instance.properties.get("componentProperties")})
}
