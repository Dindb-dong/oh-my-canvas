use super::*;
use serde_json::Map;

const LAYOUT_KEYS: &[&str] = &[
    "layout",
    "hSizing",
    "vSizing",
    "widthSizing",
    "heightSizing",
    "layoutSizing",
    "minWidth",
    "minHeight",
    "maxWidth",
    "maxHeight",
    "absolute",
    "layoutPositioning",
    "gridCell",
    "constraints",
    "horizontalConstraint",
    "verticalConstraint",
    "alignSelf",
    "autoResize",
];

pub(super) fn layout(source: &Map<String, Value>, node: &mut Node) {
    let mut responsive = Map::new();
    for key in LAYOUT_KEYS {
        let value = source
            .get(*key)
            .or_else(|| {
                source
                    .get("editorLayout")
                    .and_then(|extensions| extensions.get(*key))
            })
            .or_else(|| {
                source
                    .get("editorText")
                    .and_then(|extensions| extensions.get(*key))
            });
        if let Some(value) = value.filter(|value| !value.is_null()) {
            responsive.insert((*key).into(), value.clone());
        }
    }
    if let Some(inline) = source.get("inlineStyles").and_then(Value::as_object) {
        let responsive_inline: Map<_, _> =
            ["width", "height", "max-width", "max-height", "left", "top"]
                .into_iter()
                .filter_map(|key| inline.get(key).map(|value| (key.into(), value.clone())))
                .collect();
        if !responsive_inline.is_empty() {
            responsive.insert("inlineStyles".into(), Value::Object(responsive_inline));
        }
    }
    // Fixed children still participate in their parent's layout.
    responsive.insert(
        "original".into(),
        json!({"width":source.get("width"),"height":source.get("height")}),
    );
    node.properties
        .insert("electronLayout".into(), Value::Object(responsive));
}

pub(super) fn effects(source: &Map<String, Value>, node: &mut Node) -> Vec<String> {
    let mut shadows = source
        .get("shadows")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut blur = if source.get("blurHidden") != Some(&Value::Bool(true)) {
        source.get("blur").and_then(Value::as_f64).unwrap_or(0.)
    } else {
        0.
    };
    let mut background = if source.get("backgroundBlurHidden") != Some(&Value::Bool(true)) {
        source
            .get("backgroundBlur")
            .and_then(Value::as_f64)
            .unwrap_or(0.)
    } else {
        0.
    };
    let mut unsupported = Vec::new();
    if let Some(effects) = source.get("effects").and_then(Value::as_array) {
        for effect in effects {
            let Some(kind) = effect["type"].as_str() else {
                continue;
            };
            if effect["hidden"] == true || effect["visible"] == false {
                continue;
            }
            let radius = effect["radius"]
                .as_f64()
                .or_else(|| effect["blur"].as_f64())
                .unwrap_or(0.)
                .max(0.);
            match kind.to_ascii_lowercase().replace(['-', '_'], "").as_str() {
                "dropshadow" | "shadow" | "innershadow" => {
                    let mut shadow = effect.as_object().unwrap().clone();
                    for (target, axis) in [("offsetX", "x"), ("offsetY", "y")] {
                        if let Some(value) = effect["offset"].get(axis).or_else(|| effect.get(axis))
                        {
                            shadow.insert(target.into(), value.clone());
                        }
                    }
                    let inner = kind.to_ascii_lowercase().replace(['-', '_'], "") == "innershadow";
                    shadow.insert(
                        "type".into(),
                        json!(if inner { "innerShadow" } else { "dropShadow" }),
                    );
                    shadows.push(Value::Object(shadow));
                }
                "blur" | "layerblur" => blur = blur.hypot(radius),
                "backgroundblur" => background = background.hypot(radius),
                _ => unsupported.push(kind.to_owned()),
            }
        }
    }
    if !shadows.is_empty() {
        node.properties.insert("shadows".into(), json!(shadows));
    }
    if blur > 0. {
        node.properties.insert("blur".into(), json!(blur.min(256.)));
    }
    if background > 0. {
        node.properties
            .insert("backgroundBlur".into(), json!(background.min(256.)));
    }
    unsupported
}

pub(super) fn link_components(doc: &Value, import: &mut ImportResult) {
    let mut matches = BTreeMap::new();
    for (key, native) in &import.source_map {
        if let Some((_, old)) = key.rsplit_once(':').filter(|(page, _)| page.contains(':')) {
            let entry = matches
                .entry(old.to_owned())
                .or_insert(Some(native.to_owned()));
            if entry.as_deref() != Some(native) {
                *entry = None;
            }
        }
    }
    if let Some(definitions) = doc["editorComponents"].as_object() {
        for definition in definitions
            .values()
            .filter(|definition| definition["deleted"] != true)
        {
            if let Some(target) = definition["mainId"]
                .as_str()
                .and_then(|id| matches.get(id))
                .and_then(Option::as_ref)
                && let Some(node) = import.content.nodes.get_mut(target)
            {
                node.properties.insert(
                    "electronComponentMain".into(),
                    json!({
                        "name":definition.get("name"),
                    }),
                );
                if let Some(values) = definition["properties"]
                    .as_array()
                    .filter(|values| !values.is_empty())
                {
                    node.properties
                        .insert("componentPropertyDefinitions".into(), json!(values));
                }
                if let Some(values) = definition["variantProperties"]
                    .as_array()
                    .filter(|values| !values.is_empty())
                {
                    node.properties
                        .insert("variantProperties".into(), json!(values));
                }
                if let Some(set) = definition["variantSetId"]
                    .as_str()
                    .and_then(|id| matches.get(id))
                    .and_then(Option::as_ref)
                {
                    node.properties.insert("variantSetId".into(), json!(set));
                }
            }
        }
    }
    let mut children = BTreeMap::<String, Vec<String>>::new();
    for child in import.content.nodes.values() {
        if let Some(parent) = &child.parent_id {
            children
                .entry(parent.clone())
                .or_default()
                .push(child.id.clone());
        }
    }
    let links: Vec<_> = import
        .content
        .nodes
        .values()
        .filter_map(|node| {
            let data = node.properties.get("electronComponentRef")?;
            let target = data["sourceId"]
                .as_str()
                .and_then(|id| matches.get(id))
                .and_then(Option::as_ref);
            let link = target
                .filter(|id| {
                    *id != &node.id && node.properties.get("electronComponentMain").is_none()
                })
                .and_then(|id| import.content.nodes.get(id))
                .map(|source| {
                    let mut link = omc_model::electron::component_link(
                        source,
                        node,
                        &data["overrides"],
                        data["isInstanceRoot"] == true,
                    );
                    link["sourceChildren"] =
                        json!(children.get(&source.id).map(Vec::as_slice).unwrap_or(&[]));
                    link
                });
            Some((node.id.clone(), link))
        })
        .collect();
    for (id, link) in links {
        let node = import.content.nodes.get_mut(&id).unwrap();
        node.properties.remove("electronComponentRef");
        if let Some(link) = link {
            node.properties.insert("electronComponentLink".into(), link);
        }
    }
}
