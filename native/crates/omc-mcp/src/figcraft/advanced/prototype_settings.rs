use super::*;
use omc_style::prototype::{SETTINGS, color_hex};

struct Device {
    name: &'static str,
    size: [f64; 2],
    colors: &'static [(&'static str, &'static str)],
    rotates: bool,
}

const PHONES: &[(&str, &str)] = &[("Black", "#3A3B3F"), ("White", "#EEEDE8")];
const PRO: &[(&str, &str)] = &[("Black", "#3B3A38"), ("Silver", "#D7D7D5")];
const DEVICES: &[Device] = &[
    Device {
        name: "iPhone 17",
        size: [402., 874.],
        colors: PHONES,
        rotates: true,
    },
    Device {
        name: "iPhone 17 Pro",
        size: [402., 874.],
        colors: PRO,
        rotates: true,
    },
    Device {
        name: "iPhone 17 Pro Max",
        size: [440., 956.],
        colors: PRO,
        rotates: true,
    },
    Device {
        name: "iPhone Air",
        size: [420., 912.],
        colors: PHONES,
        rotates: true,
    },
    Device {
        name: "iPhone 16",
        size: [393., 852.],
        colors: &[
            ("Black", "#35373B"),
            ("White", "#F4F2EF"),
            ("Pink", "#E6B3BF"),
            ("Teal", "#AAC4BF"),
            ("Ultramarine", "#A5AED4"),
        ],
        rotates: true,
    },
    Device {
        name: "iPhone 16 Pro",
        size: [402., 874.],
        colors: &[("Black", "#3B3A38"), ("White", "#ECEBE6")],
        rotates: true,
    },
    Device {
        name: "iPhone 16 Pro Max",
        size: [440., 956.],
        colors: &[
            ("Black", "#3B3A38"),
            ("White", "#ECEBE6"),
            ("Natural", "#BFB9AF"),
            ("Sand", "#C6AC8F"),
        ],
        rotates: true,
    },
    Device {
        name: "iPhone 16 Plus",
        size: [430., 932.],
        colors: PHONES,
        rotates: true,
    },
    Device {
        name: "iPhone 15 Pro",
        size: [393., 852.],
        colors: PRO,
        rotates: true,
    },
    Device {
        name: "iPhone 15 Pro Max",
        size: [430., 932.],
        colors: PRO,
        rotates: true,
    },
    Device {
        name: "iPhone 15 Plus",
        size: [430., 932.],
        colors: PHONES,
        rotates: true,
    },
    Device {
        name: "iPhone 14 Pro",
        size: [393., 852.],
        colors: PHONES,
        rotates: true,
    },
    Device {
        name: "iPhone 14 Pro Max",
        size: [430., 932.],
        colors: PHONES,
        rotates: true,
    },
    Device {
        name: "iPhone 14",
        size: [390., 844.],
        colors: PHONES,
        rotates: true,
    },
    Device {
        name: "Android Compact",
        size: [412., 917.],
        colors: &[
            ("Black", "#2E2F33"),
            ("Silver", "#D6D8DB"),
            ("Green", "#A6C0A3"),
        ],
        rotates: true,
    },
    Device {
        name: "Android Medium",
        size: [700., 840.],
        colors: &[("Black", "#2E2F33"), ("Silver", "#D6D8DB")],
        rotates: true,
    },
    Device {
        name: "iPad mini",
        size: [744., 1133.],
        colors: &[
            ("Grey", "#6A6B6F"),
            ("Silver", "#E0E1E3"),
            ("Blue", "#9CB1C9"),
            ("Purple", "#C6BCD7"),
        ],
        rotates: true,
    },
    Device {
        name: "MacBook Air",
        size: [1280., 832.],
        colors: &[
            ("Silver", "#C9CACE"),
            ("Grey", "#7B7C80"),
            ("Dark blue", "#2E333D"),
            ("Cream", "#E0D9CB"),
        ],
        rotates: false,
    },
    Device {
        name: "Desktop",
        size: [1440., 1024.],
        colors: &[("Silver", "#B8B9BD"), ("Black", "#2C2C2E")],
        rotates: false,
    },
];

pub(super) fn command(context: &Context, action: &str) -> Result<Value> {
    if action == "settings" {
        return settings(context);
    }
    let catalog = context.router.workspace.catalog.lock().unwrap();
    let mut preferences = catalog.preference()?;
    let mut options = preferences["prototypePresentation"]
        .as_object()
        .cloned()
        .unwrap_or_default();
    let params = context.params;
    let result = if action == "linkNotice" {
        let shown = params
            .get("show")
            .filter(|value| !value.is_null())
            .map(|value| {
                value
                    .as_bool()
                    .ok_or_else(|| EngineError::invalid("show must be true or false"))
            })
            .transpose()?
            .unwrap_or(true);
        options.insert("linkNotice".into(), json!(shown));
        json!({"shown":shown})
    } else {
        let mut update = serde_json::Map::new();
        if let Some(scale) = params.get("scale").filter(|value| !value.is_null()) {
            if scale
                .as_str()
                .is_none_or(|value| !matches!(value, "fit" | "fitWidth" | "fill" | "actual"))
            {
                return Err(EngineError::invalid(
                    "scale must be fit, fitWidth, fill or actual",
                ));
            }
            update.insert("scale".into(), scale.clone());
        }
        for key in ["deviceFrame", "hotspotHints", "inspect", "hideUi"] {
            if let Some(value) = params.get(key).filter(|value| !value.is_null()) {
                if !value.is_boolean() {
                    return Err(EngineError::invalid(format!("{key} must be true or false")));
                }
                update.insert(key.into(), value.clone());
            }
        }
        if update.is_empty() {
            return Err(EngineError::invalid("Set a presentation option"));
        }
        options.extend(update);
        json!({"ok":true})
    };
    preferences["prototypePresentation"] = json!(options);
    catalog.set_preference(&preferences)?;
    Ok(result)
}

fn defaults() -> Value {
    json!({"device":"None","rotation":"portrait","background":"#1E1E1E","color":null,
        "screen":null,"customSize":{"width":1280.,"height":720.},"responsive":false})
}

fn settings(context: &Context) -> Result<Value> {
    let root = &context.state.root;
    let previous = context.snapshot.nodes[root]
        .properties
        .get(SETTINGS)
        .cloned()
        .unwrap_or_else(defaults);
    let mut next = normalized(&previous, context.params)?;
    if next != previous
        && context
            .params
            .as_object()
            .is_some_and(|fields| fields.values().any(|value| !value.is_null()))
    {
        context.commit(vec![context.patch(root, SETTINGS, next.clone())])?;
    }
    next.as_object_mut().unwrap().remove("body");
    next["ok"] = json!(true);
    Ok(next)
}

pub(crate) fn decode_archive_settings(input: &Value) -> Result<Option<Value>> {
    let mut previous = defaults();
    let mut params = input
        .as_object()
        .cloned()
        .ok_or_else(|| EngineError::invalid("Invalid prototype settings"))?;
    if let Some(size) = params
        .remove("custom_size")
        .or_else(|| params.remove("customSize"))
    {
        let valid = |index: usize| size[index].as_f64().filter(|n| (1. ..=10_000.).contains(n));
        let [Some(width), Some(height)] = [valid(0), valid(1)] else {
            return Err(EngineError::invalid("Invalid prototype screen size"));
        };
        previous["customSize"] = json!({"width":width,"height":height});
    }
    let next = normalized(&previous, &Value::Object(params))?;
    Ok((next != defaults()).then_some(next))
}

pub(crate) fn encode_archive_settings(input: &Value) -> Result<Value> {
    let color = input["background"]
        .as_str()
        .and_then(omc_style::parse_color)
        .ok_or_else(|| EngineError::invalid("Invalid prototype background"))?;
    let mut record = json!({"device":input["device"],"background":color,"rotation":input["rotation"],
        "custom_size":[input["customSize"]["width"],input["customSize"]["height"]],"responsive":input["responsive"]});
    if let Some(color) = input["color"].as_str() {
        record["color"] = json!(color);
    }
    Ok(record)
}

fn normalized(previous: &Value, params: &Value) -> Result<Value> {
    let mut next = previous.clone();
    let field = |key: &str| params.get(key).filter(|value| !value.is_null());
    if let Some(value) = field("device") {
        let name = value.as_str().unwrap_or_default();
        let choices = ["None", "Custom size"]
            .into_iter()
            .chain(DEVICES.iter().map(|device| device.name));
        let canonical = choices
            .clone()
            .find(|value| value.eq_ignore_ascii_case(name))
            .ok_or_else(|| {
                EngineError::invalid(format!(
                    "Unknown device. Choose {}",
                    choices.collect::<Vec<_>>().join(" | ")
                ))
            })?;
        next["device"] = json!(canonical);
    }
    if let Some(value) = field("background") {
        next["background"] = json!(
            color_hex(value).ok_or_else(|| EngineError::invalid("Invalid prototype background"))?
        );
    }
    if let Some(value) = field("rotation") {
        let rotation = match (
            value.as_str().map(str::to_ascii_lowercase).as_deref(),
            value.as_f64(),
        ) {
            (Some("portrait" | "0"), _) | (_, Some(0.)) => "portrait",
            (Some("landscape" | "90"), _) | (_, Some(90.)) => "landscape",
            _ => {
                return Err(EngineError::invalid(
                    "rotation must be portrait or landscape",
                ));
            }
        };
        next["rotation"] = json!(rotation);
    }
    for key in ["width", "height"] {
        if let Some(value) = field(key) {
            next["customSize"][key] = json!(
                value
                    .as_f64()
                    .filter(|side| (1. ..=10_000.).contains(side))
                    .ok_or_else(|| EngineError::invalid(format!("{key} must be 1–10000 points")))?
            );
            next["device"] = json!("Custom size");
        }
    }
    if let Some(value) = field("responsive") {
        next["responsive"] = json!(
            value
                .as_bool()
                .ok_or_else(|| EngineError::invalid("responsive must be true or false"))?
        );
    }
    let model = DEVICES.iter().find(|device| next["device"] == device.name);
    let color = field("color")
        .map(|value| {
            value
                .as_str()
                .ok_or_else(|| EngineError::invalid("color must be text"))
        })
        .transpose()?;
    let colors = model.map_or(&[][..], |device| device.colors);
    let chosen = if let Some(name) = color.filter(|name| !name.is_empty()) {
        Some(
            colors
                .iter()
                .find(|(color, _)| color.eq_ignore_ascii_case(name))
                .ok_or_else(|| {
                    EngineError::invalid(format!(
                        "Unknown device color. Choose {}",
                        colors
                            .iter()
                            .map(|(color, _)| *color)
                            .collect::<Vec<_>>()
                            .join(" | ")
                    ))
                })?,
        )
    } else {
        color
            .is_none()
            .then(|| colors.iter().find(|(name, _)| next["color"] == *name))
            .flatten()
            .or_else(|| colors.first())
    };
    next["color"] = json!(chosen.map(|(name, _)| name));
    if let Some(device) = model {
        let [width, height] = if device.rotates && next["rotation"] == "landscape" {
            [device.size[1], device.size[0]]
        } else {
            device.size
        };
        next["screen"] = json!({"width":width,"height":height});
    } else if next["device"] == "Custom size" {
        next["screen"] = next["customSize"].clone();
    } else {
        next["screen"] = Value::Null;
    }
    if let Some((_, body)) = chosen {
        next["body"] = json!(body);
    } else {
        next.as_object_mut().unwrap().remove("body");
    }
    Ok(next)
}
