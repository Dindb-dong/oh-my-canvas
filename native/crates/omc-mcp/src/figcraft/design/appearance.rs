use super::*;
use omc_style::{Color, parse_color};

impl ToolRouter {
    pub(super) fn fig_document_colors(
        &self,
        session: &str,
        snapshot: &DocumentSnapshot,
        state: &ViewState,
        params: &Value,
    ) -> Result<Value> {
        let page = params
            .get("page")
            .map(|page| self.fig_layer(session, snapshot, page))
            .transpose()?
            .unwrap_or_else(|| state.root.clone());
        let page = snapshot
            .pages
            .iter()
            .find(|p| p.root_node_id == page)
            .ok_or_else(|| EngineError::invalid("page does not exist"))?;
        let scene = paths::scene(snapshot, &page.id)?;
        let mut counts = BTreeMap::<String, usize>::new();
        for item in scene
            .items
            .iter()
            .filter(|item| snapshot.nodes.contains_key(&item.id))
        {
            let node = &snapshot.nodes[&item.id];
            for (key, single) in [("fills", "fill"), ("strokes", "stroke")] {
                for paint in paint_stack(&item.properties, node.kind, key, single) {
                    if paint["visible"] == false || paint["hidden"] == true {
                        continue;
                    }
                    if !matches!(paint["type"].as_str(), None | Some("solid" | "color")) {
                        continue;
                    }
                    if let Some(value) = color(paint.get("color").unwrap_or(&paint)) {
                        if value.a > 0. {
                            *counts.entry(hex(value)).or_default() += 1;
                        }
                    }
                }
            }
        }
        let mut colors = counts.into_iter().collect::<Vec<_>>();
        colors.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
        let limit = optional_index(params, "limit")?.unwrap_or(21).clamp(1, 500);
        Ok(
            json!({"colors":colors.into_iter().take(limit).map(|(color,count)| json!({"color":color,"count":count})).collect::<Vec<_>>() }),
        )
    }

    pub(super) fn fig_appearance(
        &self,
        session: &str,
        snapshot: &DocumentSnapshot,
        ids: &[String],
        domain: &str,
        action: &str,
        params: &Value,
        commands: &mut Vec<Command>,
    ) -> Result<Value> {
        if matches!(action, "widthProfile" | "brush") {
            let (field, value) = if action == "widthProfile" {
                ("widthProfile", width_profile(params)?)
            } else {
                ("strokeBrush", brush(params)?)
            };
            for id in ids {
                let node = &snapshot.nodes[id];
                if value.is_null() {
                    if node.properties.contains_key(field) {
                        commands.push(Command::NodeUnset {
                            node_id: id.clone(),
                            properties: vec![field.into()],
                        });
                    }
                    continue;
                }
                let mut patch = Properties::from([(field.into(), value.clone())]);
                if action == "brush"
                    && paint_stack(&node.properties, node.kind, "strokes", "stroke").is_empty()
                {
                    patch.insert("strokes".into(),json!([{"type":"solid","color":"#000000","width":node.number("strokeWidth",1.)}]));
                    patch.insert("stroke".into(), json!("#000000"));
                }
                commands.push(Command::NodeSet {
                    node_id: id.clone(),
                    properties: patch,
                });
            }
            return Ok(json!({"ok":true}));
        }
        if params.get("regions").is_some() {
            return Err(EngineError::new(
                "unsupported_feature",
                "native vector subregions do not have independent paint stacks",
            ));
        }
        let key = match domain {
            "fill" => "fills",
            "stroke" => "strokes",
            "effect" => "effects",
            _ => "layoutGrids",
        };
        let clip_key = (
            session.to_owned(),
            if domain == "effect" {
                "effect"
            } else {
                "paint"
            }
            .to_owned(),
        );
        let entries = |node: &Node| match domain {
            "fill" | "stroke" => paint_stack(&node.properties, node.kind, key, domain),
            "effect" => effect_stack(node),
            _ => node
                .properties
                .get(key)
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default(),
        };
        let index = optional_index(params, "index")?;
        let pattern = if action == "pattern" {
            let source = self.fig_layer(session, snapshot, &params["source"])?;
            if snapshot.nodes[&source].parent_id.is_none() {
                return Err(EngineError::invalid("pattern source must be a layer"));
            }
            let mut value = pattern_paint(params, &source)?;
            paint_options(&mut value, params)?;
            Some(value)
        } else {
            None
        };

        if action == "copy" {
            let node = &snapshot.nodes[&ids[0]];
            let entries = entries(node);
            let at = index.unwrap_or(entries.len().saturating_sub(1));
            let entry = entries
                .get(at)
                .ok_or_else(|| EngineError::invalid("appearance index not found"))?;
            let mut clip = json!({"domain":domain,"entry":entry,"document":snapshot.id});
            if domain == "stroke" {
                clip["settings"] = json!(stroke_settings(node));
            }
            self.fig_design_clipboard
                .lock()
                .unwrap()
                .insert(clip_key, clip);
            return Ok(entry.clone());
        }
        let pasted = if action == "paste" {
            Some(
                self.fig_design_clipboard
                    .lock()
                    .unwrap()
                    .get(&clip_key)
                    .cloned()
                    .filter(|clip| clip["domain"] == domain)
                    .ok_or_else(|| EngineError::invalid("no copied entry of this type"))?,
            )
        } else {
            None
        };
        for id in ids {
            let node = &snapshot.nodes[id];
            let mut list = entries(node);
            let before = list.clone();
            let top = list.len().saturating_sub(1);
            let at = index.unwrap_or(top);
            match action {
                "add" => list.push(match domain {
                    "effect" => effect(params.get("effect"), params["type"].as_str())?,
                    "grid" => grid(params.get("grid"))?,
                    _ => paint(
                        params.get("paint").or_else(|| params.get("color")),
                        default_color(node.kind, domain),
                    )?,
                }),
                "remove" => {
                    if at < list.len() {
                        list.remove(at);
                    }
                }
                "move" => {
                    let from = optional_index(params, "from")?
                        .ok_or_else(|| EngineError::invalid("from required"))?;
                    let to = optional_index(params, "to")?
                        .ok_or_else(|| EngineError::invalid("to required"))?;
                    if from >= list.len() || to >= list.len() {
                        return Err(EngineError::invalid("appearance index not found"));
                    }
                    let entry = list.remove(from);
                    list.insert(to, entry);
                }
                "set" if domain == "effect" => {
                    let value = effect(
                        Some(
                            params
                                .get("effect")
                                .ok_or_else(|| EngineError::invalid("effect required"))?,
                        ),
                        None,
                    )?;
                    *list
                        .get_mut(at)
                        .ok_or_else(|| EngineError::invalid("effect index not found"))? = value;
                }
                "set" => {
                    if list.is_empty() {
                        list.push(paint(None, default_color(node.kind, domain))?);
                    }
                    let slot = list
                        .get_mut(at)
                        .ok_or_else(|| EngineError::invalid("paint index not found"))?;
                    if let Some(value) = params.get("paint") {
                        *slot = paint(Some(value), default_color(node.kind, domain))?;
                    } else if !slot.is_object() {
                        *slot = paint(Some(slot), default_color(node.kind, domain))?;
                    }
                    if let Some(value) = params.get("color") {
                        let color =
                            color(value).ok_or_else(|| EngineError::invalid("invalid color"))?;
                        slot["type"] = json!("solid");
                        slot["color"] = json!(hex(color));
                    }
                    paint_options(slot, params)?;
                }
                "pattern" => {
                    let entry = pattern.as_ref().unwrap();
                    check_pattern(snapshot, id, entry["source"].as_str().unwrap())?;
                    if list.is_empty() && at == 0 {
                        list.push(entry.clone());
                    } else {
                        *list
                            .get_mut(at)
                            .ok_or_else(|| EngineError::invalid("fill index not found"))? =
                            entry.clone();
                    }
                }
                "paste" => {
                    let clip = pasted.as_ref().unwrap();
                    let entry = clip["entry"].clone();
                    if entry["type"] == "pattern" {
                        if clip["document"] != snapshot.id {
                            return Err(EngineError::invalid(
                                "a pattern cannot be pasted into another document",
                            ));
                        }
                        check_pattern(snapshot, id, string(&entry, "source")?)?;
                    }
                    if index.is_some() && !list.is_empty() {
                        *list
                            .get_mut(at)
                            .ok_or_else(|| EngineError::invalid("appearance index not found"))? =
                            entry;
                    } else if at == 0 || index.is_none() {
                        list.push(entry);
                    } else {
                        return Err(EngineError::invalid("appearance index not found"));
                    }
                }
                _ => return Err(EngineError::invalid("unknown appearance action")),
            }
            if list.len() > if domain == "effect" { 32 } else { 128 } {
                return Err(EngineError::invalid(
                    "appearance stack exceeds its entry limit",
                ));
            }
            if list == before && pasted.is_none() {
                continue;
            }
            let mut patch = Properties::from([(key.into(), json!(list))]);
            let reference = match domain {
                "fill" => Some("fillStyleId"),
                "stroke" => Some("strokeStyleId"),
                "effect" => Some("effectStyleId"),
                _ => None,
            };
            if let Some(reference) = reference.filter(|key| node.properties.contains_key(*key)) {
                commands.push(Command::NodeUnset {
                    node_id: id.clone(),
                    properties: vec![reference.into()],
                });
            }
            if matches!(domain, "fill" | "stroke") {
                let first = list
                    .iter()
                    .rev()
                    .find(|paint| paint["visible"] != false && paint["hidden"] != true)
                    .and_then(|value| value.get("color"))
                    .and_then(color);
                if domain == "stroke" {
                    let settings = pasted
                        .as_ref()
                        .map(|clip| properties(&clip["settings"]))
                        .transpose()?
                        .unwrap_or_else(|| stroke_settings(node));
                    let native = [
                        ("strokeWidth", "width"),
                        ("strokeAlignment", "align"),
                        ("strokeCap", "cap"),
                        ("strokeJoin", "join"),
                        ("strokeDashArray", "dash"),
                    ];
                    for (field, to) in native {
                        if let Some(value) = settings.get(field) {
                            for entry in &mut list {
                                if entry.is_object()
                                    && (pasted.is_some() || entry.get(to).is_none())
                                {
                                    entry[to] = value.clone();
                                }
                            }
                        }
                    }
                    patch.extend(settings);
                    patch.insert(key.into(), json!(list));
                }
                patch.insert(
                    domain.into(),
                    json!(first.map_or_else(|| "transparent".to_owned(), hex)),
                );
            } else if domain == "effect" {
                let shadows = list
                    .iter()
                    .filter(|effect| {
                        matches!(effect["type"].as_str(), Some("dropShadow" | "innerShadow"))
                    })
                    .cloned()
                    .collect::<Vec<_>>();
                let sigma = list
                    .iter()
                    .filter(|effect| effect["type"] == "layerBlur" && effect["visible"] != false)
                    .filter_map(|effect| effect["radius"].as_f64())
                    .map(|radius| radius * radius)
                    .sum::<f64>()
                    .sqrt()
                    .min(256.);
                patch.insert("shadows".into(), json!(shadows));
                patch.insert("blur".into(), json!(sigma));
                let backdrop = list
                    .iter()
                    .filter(|effect| {
                        effect["type"] == "backgroundBlur" && effect["visible"] != false
                    })
                    .filter_map(|effect| effect["radius"].as_f64())
                    .map(|radius| radius * radius)
                    .sum::<f64>()
                    .sqrt()
                    .min(256.);
                patch.insert("backgroundBlur".into(), json!(backdrop));
                if node.properties.contains_key("blurHidden") {
                    commands.push(Command::NodeUnset {
                        node_id: id.clone(),
                        properties: vec!["blurHidden".into()],
                    });
                }
            }
            commands.push(Command::NodeSet {
                node_id: id.clone(),
                properties: patch,
            });
        }
        Ok(json!({"ok":true}))
    }
}

fn color(value: &Value) -> Option<Color> {
    if let Some(text) = value.as_str() {
        return parse_color(text);
    }
    let get = |key: &str| {
        value
            .get(key)?
            .as_f64()
            .filter(|value| (0. ..=1.).contains(value))
            .map(|value| value as f32)
    };
    Some(Color {
        r: get("r")?,
        g: get("g")?,
        b: get("b")?,
        a: get("a").or_else(|| value.get("a").is_none().then_some(1.))?,
    })
}

fn hex(color: Color) -> String {
    let mut value = color.hex().to_ascii_uppercase();
    if value.ends_with("FF") {
        value.truncate(7);
    }
    value
}

fn default_color(kind: NodeKind, domain: &str) -> &'static str {
    if domain == "stroke" {
        "#000000"
    } else if matches!(
        kind,
        NodeKind::Frame | NodeKind::Component | NodeKind::Instance
    ) {
        "#FFFFFF"
    } else {
        "#D9D9D9"
    }
}

pub(in crate::figcraft) fn paint_stack(properties: &Properties, kind: NodeKind, key: &str, single: &str) -> Vec<Value> {
    if let Some(list) = properties.get(key).and_then(Value::as_array) {
        return list.clone();
    }
    if let Some(color) = properties
        .get(single)
        .and_then(color)
        .filter(|color| color.a > 0.)
    {
        let mut entry = json!({"type":"solid","color":hex(color)});
        if single == "stroke" {
            for (from, to) in [
                ("strokeWidth", "width"),
                ("strokeAlignment", "align"),
                ("strokeCap", "cap"),
                ("strokeJoin", "join"),
                ("strokeDashArray", "dash"),
            ] {
                if let Some(value) = properties.get(from) {
                    entry[to] = value.clone();
                }
            }
        }
        return vec![entry];
    }
    if single == "fill" && kind == NodeKind::Text {
        return vec![json!({"type":"solid","color":"#000000"})];
    }
    Vec::new()
}

fn stroke_settings(node: &Node) -> Properties {
    [
        "strokeWidth",
        "strokeAlignment",
        "strokeCap",
        "strokeJoin",
        "strokeDashArray",
    ]
    .into_iter()
    .filter_map(|key| {
        node.properties
            .get(key)
            .map(|value| (key.into(), value.clone()))
    })
    .collect()
}

pub(in crate::figcraft) fn paint(value: Option<&Value>, default: &str) -> Result<Value> {
    let Some(value) = value else {
        return Ok(json!({"type":"solid","color":default}));
    };
    if let Some(color) = color(value) {
        return Ok(json!({"type":"solid","color":hex(color)}));
    }
    if !value.is_object() {
        return Err(EngineError::invalid("paint must be a color or an object"));
    }
    let mut result = value.clone();
    let kind = value["type"]
        .as_str()
        .or_else(|| value["kind"].as_str())
        .unwrap_or("solid");
    let kind = if kind == "gradient" {
        value["gradient"]
            .get("kind")
            .or_else(|| value.get("kind"))
            .and_then(Value::as_str)
            .unwrap_or("linear")
    } else {
        kind
    };
    match kind {
        "solid" | "color" => {
            result["type"] = json!("solid");
            result["color"] = json!(hex(color(&value["color"])
                .ok_or_else(|| EngineError::invalid("invalid paint color"))?));
        }
        "linear" | "linear-gradient" | "gradientLinear" | "radial" | "radial-gradient"
        | "gradientRadial" | "angular" | "gradientAngular" | "conic" => {
            result["type"] = json!(match kind {
                "gradientLinear" => "linear",
                "gradientRadial" => "radial",
                "gradientAngular" => "angular",
                v => v,
            });
            let stop_list = if result["gradient"].is_object() {
                result["gradient"].get_mut("stops")
            } else {
                result.get_mut("stops")
            };
            let stops = stop_list
                .and_then(Value::as_array_mut)
                .filter(|stops| (2..=128).contains(&stops.len()))
                .ok_or_else(|| EngineError::invalid("gradient needs between 2 and 128 stops"))?;
            let mut previous = 0.;
            for stop in stops {
                let at = stop
                    .get("offset")
                    .or_else(|| stop.get("position"))
                    .or_else(|| stop.get("t"))
                    .and_then(Value::as_f64)
                    .filter(|at| (previous..=1.).contains(at))
                    .ok_or_else(|| {
                        EngineError::invalid("gradient stops must increase between 0 and 1")
                    })?;
                let color = color(&stop["color"])
                    .ok_or_else(|| EngineError::invalid("invalid gradient stop color"))?;
                let opacity = stop
                    .get("opacity")
                    .map(|value| {
                        value
                            .as_f64()
                            .filter(|value| (0. ..=1.).contains(value))
                            .ok_or_else(|| {
                                EngineError::invalid("gradient stop opacity must be 0..1")
                            })
                    })
                    .transpose()?;
                *stop = json!({"offset":at,"color":hex(color)});
                if let Some(opacity) = opacity {
                    stop["opacity"] = json!(opacity);
                }
                previous = at;
            }
        }
        _ => {
            return Err(EngineError::new(
                "unsupported_feature",
                "this paint type is not supported by the native paint stack",
            ));
        }
    }
    paint_options(&mut result, value)?;
    Ok(result)
}

fn paint_options(result: &mut Value, params: &Value) -> Result<()> {
    if let Some(value) = params.get("opacity") {
        let opacity = value
            .as_f64()
            .or_else(|| {
                value
                    .as_str()
                    .and_then(|v| v.strip_suffix('%'))?
                    .parse::<f64>()
                    .ok()
                    .map(|v| v / 100.)
            })
            .filter(|v| v.is_finite())
            .ok_or_else(|| EngineError::invalid("opacity must be a number or percentage"))?;
        result["opacity"] = json!(opacity.clamp(0., 1.));
    }
    if let Some(visible) = params.get("visible") {
        if !visible.is_boolean() {
            return Err(EngineError::invalid("visible must be boolean"));
        }
        result["visible"] = visible.clone();
        result.as_object_mut().unwrap().remove("hidden");
    }
    if let Some(blend) = params.get("blend").or_else(|| params.get("blendMode")) {
        let raw = blend
            .as_str()
            .ok_or_else(|| EngineError::invalid("blend must be a mode"))?;
        let mode = raw.replace('_', "-");
        let mut normalized = String::new();
        for (i, c) in mode.chars().enumerate() {
            if c.is_ascii_uppercase() && i > 0 && !mode.chars().all(|c| !c.is_ascii_lowercase()) {
                normalized.push('-');
            }
            normalized.push(c.to_ascii_lowercase());
        }
        if ![
            "normal",
            "pass-through",
            "multiply",
            "screen",
            "overlay",
            "darken",
            "lighten",
            "color-dodge",
            "color-burn",
            "hard-light",
            "soft-light",
            "difference",
            "exclusion",
            "hue",
            "saturation",
            "color",
            "luminosity",
        ]
        .contains(&normalized.as_str())
        {
            return Err(EngineError::invalid("blend is not a native paint mode"));
        }
        result["blendMode"] = json!(normalized);
    }
    Ok(())
}

fn effect_stack(node: &Node) -> Vec<Value> {
    if let Some(effects) = node.properties.get("effects").and_then(Value::as_array) {
        return effects.clone();
    }
    let mut effects = node
        .properties
        .get("shadows")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    for shadow in &mut effects {
        if shadow.is_object() {
            shadow["type"] = if shadow["style"] == "inner" {
                json!("innerShadow")
            } else {
                json!("dropShadow")
            };
        }
    }
    if node.number("blur", 0.) > 0. {
        effects.push(json!({"type":"layerBlur","radius":node.number("blur",0.),"visible":node.properties.get("blurHidden") != Some(&json!(true))}));
    }
    if node.number("backgroundBlur", 0.) > 0. {
        effects.push(json!({"type":"backgroundBlur","radius":node.number("backgroundBlur",0.),"visible":node.properties.get("backgroundBlurHidden") != Some(&json!(true))}));
    }
    effects
}

fn effect(value: Option<&Value>, default_kind: Option<&str>) -> Result<Value> {
    let empty = json!({});
    let value = value.unwrap_or(&empty);
    if !value.is_object() {
        return Err(EngineError::invalid("effect must be an object"));
    }
    let kind = value["type"]
        .as_str()
        .or_else(|| value["kind"].as_str())
        .or(default_kind)
        .unwrap_or("dropShadow");
    let kind = match kind {
        "drop_shadow" | "drop-shadow" => "dropShadow",
        "inner_shadow" | "inner-shadow" => "innerShadow",
        "layer_blur" | "layer-blur" | "blur" => "layerBlur",
        "background_blur" | "background-blur" => "backgroundBlur",
        kind => kind,
    };
    let mut effect = value.clone();
    effect["type"] = json!(kind);
    effect["visible"] = json!(value["visible"].as_bool().unwrap_or(true));
    match kind {
        "dropShadow" | "innerShadow" => {
            if kind == "innerShadow" {
                effect["style"] = json!("inner");
            }
            effect["blur"] = json!(
                optional_number(value, "blur")?
                    .or(optional_number(value, "radius")?)
                    .unwrap_or(4.)
                    .clamp(0., 256.)
            );
            effect["spread"] = json!(
                optional_number(value, "spread")?
                    .unwrap_or(0.)
                    .clamp(-1024., 1024.)
            );
            let axis = |i: usize, key: &str| {
                value["offset"]
                    .get(i)
                    .or_else(|| value["offset"].get(key))
                    .and_then(Value::as_f64)
            };
            effect["offsetX"] = json!(
                optional_number(value, "offsetX")?
                    .or(axis(0, "x"))
                    .unwrap_or(0.)
                    .clamp(-1e6, 1e6)
            );
            effect["offsetY"] = json!(
                optional_number(value, "offsetY")?
                    .or(axis(1, "y"))
                    .unwrap_or(4.)
                    .clamp(-1e6, 1e6)
            );
            effect["color"] = json!(
                value
                    .get("color")
                    .map(|value| color(value)
                        .map(hex)
                        .ok_or_else(|| EngineError::invalid("invalid shadow color")))
                    .transpose()?
                    .unwrap_or_else(|| "#00000040".to_owned())
            );
        }
        "layerBlur" | "backgroundBlur" => {
            if value["blurType"] == "progressive" || value["blur_type"] == "progressive" {
                return Err(EngineError::new(
                    "unsupported_feature",
                    "progressive blur is not available in the native renderer",
                ));
            }
            effect["radius"] = json!(
                optional_number(value, "radius")?
                    .or(optional_number(value, "blur")?)
                    .unwrap_or(4.)
                    .clamp(0., 256.)
            )
        }
        _ => {
            return Err(EngineError::new(
                "unsupported_feature",
                "native effect commands support dropShadow, innerShadow, layerBlur and backgroundBlur",
            ));
        }
    }
    Ok(effect)
}

fn grid(value: Option<&Value>) -> Result<Value> {
    let default = json!({});
    let value = value.unwrap_or(&default);
    if !value.is_object() {
        return Err(EngineError::invalid("grid must be an object"));
    }
    let mut grid = value.clone();
    let kind = value["kind"].as_str().unwrap_or("grid");
    if !matches!(kind, "grid" | "columns" | "rows") {
        return Err(EngineError::invalid(
            "grid kind must be grid, columns or rows",
        ));
    }
    grid["kind"] = json!(kind);
    grid["size"] = json!(
        optional_number(value, "size")?
            .unwrap_or(10.)
            .clamp(0., 1e5)
    );
    grid["count"] = json!(optional_index(value, "count")?.unwrap_or(5).min(256));
    for (key, default) in [("gutter", 20.), ("margin", 0.), ("offset", 0.)] {
        grid[key] = json!(
            optional_number(value, key)?
                .unwrap_or(default)
                .clamp(0., 1e5)
        );
    }
    grid["align"] = json!(match value["align"].as_str().unwrap_or("stretch") {
        align @ ("stretch" | "start" | "min" | "center" | "end" | "max") => align,
        _ =>
            return Err(EngineError::invalid(
                "grid align must be stretch, start, center or end"
            )),
    });
    grid["color"] = json!(
        value
            .get("color")
            .map(|value| color(value)
                .map(hex)
                .ok_or_else(|| EngineError::invalid("invalid grid color")))
            .transpose()?
            .unwrap_or_else(|| "#FF00001A".to_owned())
    );
    Ok(grid)
}

fn width_profile(params: &Value) -> Result<Value> {
    if let Some(points) = params.get("points") {
        let points = points
            .as_array()
            .filter(|points| (1..=64).contains(&points.len()))
            .ok_or_else(|| EngineError::invalid("width profile needs 1 to 64 points"))?;
        let mut points = points
            .iter()
            .map(|point| {
                let at = point
                    .get(0)
                    .or_else(|| point.get("t"))
                    .and_then(Value::as_f64);
                let left = point
                    .get(1)
                    .or_else(|| point.get("left"))
                    .or_else(|| point.get("scale"))
                    .and_then(Value::as_f64);
                let right = point
                    .get(2)
                    .or_else(|| point.get("right"))
                    .and_then(Value::as_f64)
                    .or(left);
                match (at, left, right) {
                    (Some(at), Some(left), Some(right)) => Ok([
                        at.clamp(0., 1.),
                        left.clamp(0., 1000.),
                        right.clamp(0., 1000.),
                    ]),
                    _ => Err(EngineError::invalid(
                        "width point must have a position and scale",
                    )),
                }
            })
            .collect::<Result<Vec<_>>>()?;
        points.sort_by(|a, b| a[0].total_cmp(&b[0]));
        points.dedup_by(|a, b| a[0] == b[0]);
        return Ok(json!(points));
    }
    let preset = params
        .get("preset")
        .filter(|value| !value.is_null())
        .map(|_| string(params, "preset"))
        .transpose()?;
    let points: &[(f64, f64)] = match preset {
        None | Some("uniform") => return Ok(Value::Null),
        Some("wedge") => &[(0., 1.), (1., 0.)],
        Some("taper") => &[(0., 0.), (0.2, 1.), (0.8, 1.), (1., 0.)],
        Some("eye" | "bulge") => &[(0., 0.), (0.5, 1.), (1., 0.)],
        Some("rounded") => &[
            (0., 0.3),
            (0.05, 0.8),
            (0.15, 1.),
            (0.85, 1.),
            (0.95, 0.8),
            (1., 0.3),
        ],
        Some("pinch") => &[(0., 1.), (0.5, 0.25), (1., 1.)],
        _ => return Err(EngineError::invalid("unknown width profile preset")),
    };
    Ok(json!(
        points
            .iter()
            .map(|(t, scale)| [*t, *scale])
            .collect::<Vec<_>>()
    ))
}

fn brush(params: &Value) -> Result<Value> {
    omc_model::parse_stroke_brush(params).map_err(EngineError::invalid)
}

fn pattern_paint(params: &Value, source: &str) -> Result<Value> {
    let tile = params["tile"].as_str().unwrap_or("grid");
    let align = params["align"].as_str().unwrap_or("start");
    if !matches!(tile, "grid" | "horizontalHex" | "verticalHex")
        || !matches!(align, "start" | "center" | "end")
    {
        return Err(EngineError::invalid("pattern tile or alignment is invalid"));
    }
    let scale = optional_number(params, "scale")?
        .unwrap_or(1.)
        .clamp(0.01, 100.);
    let spacing = if let Some(spacing) = params.get("spacing") {
        let spacing = spacing
            .as_array()
            .filter(|v| v.len() == 2)
            .ok_or_else(|| EngineError::invalid("spacing must contain two values"))?;
        [0, 1]
            .map(|i| {
                spacing[i]
                    .as_f64()
                    .map(|v| v.clamp(0., 10_000.))
                    .ok_or_else(|| EngineError::invalid("pattern spacing must be numeric"))
            })
            .into_iter()
            .collect::<Result<Vec<_>>>()?
    } else {
        vec![0., 0.]
    };
    Ok(
        json!({"type":"pattern","source":source,"tile":tile,"align":align,"scale":scale,"spacing":spacing}),
    )
}

fn check_pattern(snapshot: &DocumentSnapshot, target: &str, source: &str) -> Result<()> {
    if snapshot.nodes[target].kind == NodeKind::Text {
        return Err(EngineError::new(
            "unsupported_feature",
            "native text does not support a pattern paint",
        ));
    }
    if !snapshot.nodes.contains_key(source) {
        return Err(EngineError::invalid("pattern source is unavailable"));
    }
    let top = |id: &str| {
        let mut node = &snapshot.nodes[id];
        while let Some(parent) = node.parent_id.as_deref() {
            node = &snapshot.nodes[parent];
        }
        node.id.as_str()
    };
    if top(target) != top(source) {
        return Err(EngineError::invalid(
            "pattern source must be on the same page",
        ));
    }
    let mut ancestor = Some(source);
    while let Some(id) = ancestor {
        if id == target {
            return Err(EngineError::invalid(
                "a layer cannot be filled with itself or a layer inside it",
            ));
        }
        ancestor = snapshot.nodes[id].parent_id.as_deref();
    }
    let mut pending = vec![source];
    let mut seen = BTreeSet::new();
    let mut child_map = BTreeMap::<&str, Vec<&str>>::new();
    for node in snapshot.nodes.values() {
        if let Some(parent) = node.parent_id.as_deref() {
            child_map.entry(parent).or_default().push(&node.id);
        }
    }
    while let Some(id) = pending.pop() {
        if id == target {
            return Err(EngineError::invalid("pattern references form a cycle"));
        }
        if !seen.insert(id) {
            continue;
        }
        pending.extend(child_map.get(id).into_iter().flatten().copied());
        if let Some(node) = snapshot.nodes.get(id) {
            pending.extend(
                node.properties
                    .get("fills")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter(|paint| paint["type"] == "pattern")
                    .filter_map(|paint| paint["source"].as_str()),
            );
        }
    }
    Ok(())
}
