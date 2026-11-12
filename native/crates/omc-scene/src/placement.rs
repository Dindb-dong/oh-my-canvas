use crate::{Affine, SceneItem};
use omc_model::Properties;
use serde_json::{Value, json};

pub fn absolute_placement(item: &SceneItem, transform: Affine) -> Properties {
    let [a, b, c, d, x, y] = transform.0;
    let mut properties = Properties::new();
    properties.extend([
        ("x".into(), json!(x)),
        ("y".into(), json!(y)),
        ("width".into(), json!(item.width)),
        ("height".into(), json!(item.height)),
    ]);
    properties.insert("transform".into(), json!([a, b, c, d, 0., 0.]));
    let mut style = match item.properties.get("style") {
        Some(Value::Object(style)) => style.clone(),
        Some(Value::String(style)) => omc_style::parse_declarations(style)
            .into_iter()
            .map(|declaration| {
                let value = if declaration.important {
                    format!("{} !important", declaration.value)
                } else {
                    declaration.value
                };
                (declaration.name, Value::String(value))
            })
            .collect(),
        _ => Default::default(),
    };
    for key in [
        "left",
        "top",
        "right",
        "bottom",
        "width",
        "height",
        "min-width",
        "max-width",
        "min-height",
        "max-height",
        "margin",
        "margin-left",
        "margin-right",
        "margin-top",
        "margin-bottom",
    ] {
        style.remove(key);
    }
    style.insert("position".into(), json!("absolute"));
    properties.insert("style".into(), Value::Object(style));
    properties
}
