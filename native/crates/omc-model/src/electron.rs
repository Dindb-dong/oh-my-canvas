//! Metadata shared by Electron import and the native scene projection.
use crate::Node;
use serde_json::{Map, Value, json};

pub const COMPONENT_FIELDS: &[&str] = &[
    "name",
    "layout",
    "electronLayout",
    "minWidth",
    "minHeight",
    "maxWidth",
    "maxHeight",
    "alignSelf",
    "absolute",
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

pub fn has_override(overrides: &Value, field: &str) -> bool {
    overrides.get(field).is_some()
        || overrides
            .as_array()
            .is_some_and(|fields| fields.iter().any(|value| value.as_str() == Some(field)))
}

pub fn component_link(source: &Node, instance: &Node, overrides: &Value, root: bool) -> Value {
    let inherited = COMPONENT_FIELDS.iter().copied().filter(|field| {
        if root && matches!(*field, "x" | "y") {
            return false;
        }
        if has_override(overrides, field) {
            return false;
        }
        let aliases: &[&str] = match *field {
            "text" | "textRuns" => &["characters", "content", "textStyle"],
            "fontFamily" | "fontSize" | "fontWeight" | "fontStyle" | "textAlign"
            | "textVerticalAlign" | "lineHeight" | "letterSpacing" => &["textStyle", "content"],
            "layout" | "electronLayout" => &[
                "layout",
                "inlineStyles",
                "hSizing",
                "vSizing",
                "widthSizing",
                "heightSizing",
            ],
            "x" | "y" => &["geometry", "position"],
            "rotation" => &["geometry"],
            "width" => &["geometry", "size", "hSizing", "widthSizing", "inlineStyles"],
            "height" => &[
                "geometry",
                "size",
                "vSizing",
                "heightSizing",
                "inlineStyles",
            ],
            "fill" | "fills" => &["paint", "fills", "fillStyleId"],
            "stroke" | "strokes" | "strokeWidth" => &["paint", "strokes", "strokeStyleId"],
            "minWidth" | "minHeight" | "maxWidth" | "maxHeight" | "absolute" => &["layout"],
            "shadows" | "blur" | "backgroundBlur" => &["effects", "effectStyleId"],
            "visible" => &["hidden"],
            _ => &[],
        };
        !aliases.iter().any(|alias| has_override(overrides, alias))
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
