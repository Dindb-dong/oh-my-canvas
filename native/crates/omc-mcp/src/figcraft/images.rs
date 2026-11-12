use super::*;

pub(super) const COMMANDS: &[(&str, &str, bool, &str)] = &[
    (
        "image.place",
        "Place image",
        true,
        "data | path, x?, y?, width?, height?, parent?, name?, target?, mode?",
    ),
    (
        "image.replace",
        "Replace image",
        true,
        "ids?, target?, index?, data | path",
    ),
    (
        "image.adjust",
        "Adjust image",
        true,
        "ids?, target?, index?, preset?, filters?",
    ),
    (
        "image.savePreset",
        "Save image preset",
        true,
        "name, filters?, ids?, target?, index?",
    ),
    ("image.deletePreset", "Delete image preset", true, "name"),
    (
        "image.crop",
        "Crop image",
        true,
        "id?, ids?, index?, crop? [x,y,width,height]",
    ),
    ("image.presets", "Image presets", false, ""),
];

const PRESET_KEY: &str = "figImagePresets";
const FIELDS: [&str; 7] = [
    "exposure",
    "contrast",
    "saturation",
    "temperature",
    "tint",
    "highlights",
    "shadows",
];
const BUILT_IN: [(&str, &str, [f64; 7]); 7] = [
    ("vivid", "Vivid", [0., 0.2, 0.45, 0., 0., -0.1, 0.1]),
    ("muted", "Muted", [0., -0.15, -0.45, 0., 0., 0., 0.]),
    ("warm", "Warm", [0., 0., 0.1, 0.5, 0.1, 0., 0.]),
    ("cool", "Cool", [0., 0., 0., -0.5, -0.05, 0., 0.]),
    (
        "blackAndWhite",
        "Black & white",
        [0., 0.15, -1., 0., 0., 0., 0.],
    ),
    ("fade", "Fade", [0., -0.35, -0.2, 0., 0., -0.1, 0.35]),
    ("reset", "Reset", [0.; 7]),
];

fn filter_values(values: [f64; 7]) -> Value {
    Value::Object(
        FIELDS
            .into_iter()
            .zip(values)
            .map(|(key, value)| (key.into(), json!(value)))
            .collect(),
    )
}
fn merge_filters(base: &Value, patch: &Value) -> Result<Value> {
    let mut result = filter_values(FIELDS.map(|key| base[key].as_f64().unwrap_or(0.)));
    if let Some(fields) = patch.as_object() {
        for (key, value) in fields {
            let value = value
                .as_f64()
                .filter(|v| (-1.0..=1.0).contains(v))
                .ok_or_else(|| EngineError::invalid("image filter values must be in -1..1"))?;
            if !FIELDS.contains(&key.as_str()) {
                return Err(EngineError::invalid(format!("unknown image filter {key}")));
            }
            result[key] = json!(value);
        }
    } else if !patch.is_null() {
        return Err(EngineError::invalid("filters must be an object"));
    }
    Ok(result)
}
fn stack(node: &Node, key: &str) -> Vec<Value> {
    node.properties
        .get(key)
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_else(|| {
            let fallback = if key == "fills" { "fill" } else { "stroke" };
            node.string(fallback)
                .filter(|color| *color != "none" && *color != "transparent")
                .map(|color| {
                    vec![
                        json!({"type":"solid","color":color,"width":node.number("strokeWidth",1.)}),
                    ]
                })
                .unwrap_or_default()
        })
}
fn image(paint: &Value) -> bool {
    paint["type"] == "image" || paint["image"].is_object()
}

impl ToolRouter {
    fn fig_crop_image(
        &self,
        session: &str,
        snapshot: &DocumentSnapshot,
        state: &ViewState,
        ids: &[String],
        params: &Value,
    ) -> Result<Value> {
        let [id] = ids else {
            return Err(EngineError::invalid("select one layer to crop its image"));
        };
        let scene = crate::paths::scene(snapshot, &state.page_id)?;
        let item = scene
            .item(id)
            .ok_or_else(|| EngineError::invalid("layer is outside this page"))?;
        let node = &snapshot.nodes[id];
        let mut fills = stack(node, "fills");
        let requested = params["index"].as_u64().map(|value| value as usize);
        let selected = requested.or_else(|| {
            fills.iter().rposition(|paint| {
                image(paint) && paint["visible"] != false && paint["hidden"] != true
            })
        });
        let (index, is_node_image) = match selected {
            Some(index) if fills.get(index).is_some_and(image) => (index, false),
            None | Some(0) if node.kind == NodeKind::Image && fills.is_empty() => (0, true),
            Some(_) => return Err(EngineError::invalid("index does not select an image fill")),
            None => return Err(EngineError::invalid("layer has no visible image fill")),
        };
        let (hash, mode, old) = if is_node_image {
            (
                node.string("assetHash"),
                item.style
                    .get("object-fit")
                    .or_else(|| node.string("imageFit"))
                    .unwrap_or("cover"),
                node.properties.get("imageCrop"),
            )
        } else {
            let paint = &fills[index];
            (
                paint["assetHash"]
                    .as_str()
                    .or_else(|| paint["image"]["hash"].as_str()),
                paint["mode"].as_str().unwrap_or("fill"),
                paint.get("crop"),
            )
        };
        let rect = if let Some(explicit) = params.get("crop") {
            let rect: [f64; 4] = serde_json::from_value(explicit.clone()).map_err(|_| {
                EngineError::invalid("crop needs four normalized image coordinates")
            })?;
            if rect.iter().any(|v| !v.is_finite() || v.abs() > 10_000.)
                || rect[2] <= 0.
                || rect[3] <= 0.
            {
                return Err(EngineError::invalid(
                    "crop needs positive size and bounded coordinates",
                ));
            }
            explicit.clone()
        } else if let Some(rect) = old {
            rect.clone()
        } else {
            let bytes = self
                .resources()?
                .0
                .read(hash.ok_or_else(|| EngineError::invalid("image paint has no asset"))?)?;
            let codec = skia_safe::Codec::from_data(skia_safe::Data::new_copy(&bytes))
                .ok_or_else(|| EngineError::invalid("invalid raster image"))?;
            let dimensions = codec.dimensions();
            if item.width <= 0.
                || item.height <= 0.
                || dimensions.width <= 0
                || dimensions.height <= 0
            {
                return Err(EngineError::invalid("cannot crop a zero-sized image"));
            }
            let (w, h) = (f64::from(dimensions.width), f64::from(dimensions.height));
            let normalized = match (is_node_image, mode) {
                (true, "fill") | (false, "stretch") => [0., 0., 1., 1.],
                (_, "tile") => [0., 0., w / item.width, h / item.height],
                _ => {
                    let (sx, sy) = (item.width / w, item.height / h);
                    let scale = if matches!(mode, "fit" | "contain") {
                        sx.min(sy)
                    } else {
                        sx.max(sy)
                    };
                    let (width, height) = (w * scale / item.width, h * scale / item.height);
                    [(1. - width) / 2., (1. - height) / 2., width, height]
                }
            };
            json!(normalized)
        };
        if old != Some(&rect) {
            let properties = if is_node_image {
                Properties::from([("imageCrop".into(), rect.clone())])
            } else {
                if mode != "crop" {
                    let sampling = if mode == "tile" {
                        "repeat"
                    } else if mode == "fit" {
                        "decal"
                    } else {
                        "clamp"
                    };
                    fills[index]["cropSampling"] = json!(sampling);
                }
                fills[index]["mode"] = json!("crop");
                fills[index]["crop"] = rect.clone();
                Properties::from([
                    ("fills".into(), json!(fills)),
                    ("fillStyleId".into(), Value::Null),
                ])
            };
            self.submit(
                session,
                &snapshot.id,
                Command::NodeSet {
                    node_id: id.clone(),
                    properties,
                },
                &Value::Null,
                Some(snapshot.sequence),
            )?;
        }
        Ok(json!({"id":self.fig_alias(session,&snapshot.id,id),"index":index,"crop":rect}))
    }

    pub(super) fn fig_images_command(
        &self,
        session: &str,
        snapshot: &DocumentSnapshot,
        state: &ViewState,
        selection: &[Value],
        name: &str,
        params: &Value,
    ) -> Result<Value> {
        let document = &snapshot.id;
        let mut saved = snapshot
            .metadata
            .get(PRESET_KEY)
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let id = json!({"type":"integer","minimum":1});
        let ids = json!({"type":"array","maxItems":200,"items":id});
        let which = json!({"type":"string","enum":["fill","stroke"]});
        let index = json!({"type":"integer","minimum":0,"maximum":127});
        let string_field = json!({"type":"string"});
        let fields = match name {
            "image.place" => {
                json!({"data":string_field,"path":string_field,"name":string_field,"x":{"type":"number"},"y":{"type":"number"},"width":{"type":"number"},"height":{"type":"number"},"parent":id,"target":id,"mode":{"type":"string","enum":["fill","fit","crop","tile"]}})
            }
            "image.replace" => {
                json!({"data":string_field,"path":string_field,"ids":ids,"target":which,"index":index})
            }
            "image.adjust" => {
                json!({"ids":ids,"target":which,"index":index,"preset":string_field,"filters":{"type":"object"}})
            }
            "image.savePreset" => {
                json!({"name":string_field,"ids":ids,"target":which,"index":index,"filters":{"type":"object"}})
            }
            "image.crop" => {
                json!({"id":id,"ids":ids,"index":index,"crop":{"type":"array","minItems":4,"maxItems":4,"items":{"type":"number"}}})
            }
            "image.deletePreset" => json!({"name":string_field}),
            _ => json!({}),
        };
        schema::check(
            &json!({"type":"object","properties":fields,"additionalProperties":false}),
            params,
            "params",
        )?;
        let presets = || {
            BUILT_IN.iter().map(|(id,label,filters)|json!({"id":id,"label":label,"filters":filter_values(*filters)})).collect::<Vec<_>>()
        };
        if name == "image.presets" {
            return Ok(json!({"builtIn":presets(),"saved":saved}));
        }
        if name == "image.crop" {
            let ids = params.get("id").map_or_else(
                || fig_ids(params, selection),
                |id| Ok(std::slice::from_ref(id)),
            )?;
            let ids = self.fig_layers(session, snapshot, ids)?;
            return self.fig_crop_image(session, snapshot, state, &ids, params);
        }
        let raw = self.fig_layers(session, snapshot, fig_ids(params, selection)?)?;
        let target = if params["target"] == "stroke" {
            "strokes"
        } else {
            "fills"
        };
        let index = params["index"].as_u64().map(|i| i as usize);
        let preset = if let Some(preset) = params["preset"].as_str() {
            let normalize = |name: &str| {
                name.chars()
                    .filter(|ch| ch.is_alphanumeric())
                    .flat_map(char::to_lowercase)
                    .collect::<String>()
            };
            Some(
                saved
                    .iter()
                    .find(|value| value["name"] == preset)
                    .map(|value| value["filters"].clone())
                    .or_else(|| {
                        BUILT_IN
                            .iter()
                            .find(|(id, label, _)| {
                                normalize(id) == normalize(preset)
                                    || normalize(label) == normalize(preset)
                            })
                            .map(|(_, _, values)| filter_values(*values))
                    })
                    .ok_or_else(|| EngineError::invalid("image preset was not found"))?,
            )
        } else {
            None
        };
        let commit = |commands| {
            self.submit(
                session,
                document,
                Command::Batch { commands },
                &Value::Null,
                Some(snapshot.sequence),
            )
        };
        if matches!(name, "image.savePreset" | "image.deletePreset") {
            let title = string(params, "name")?.trim();
            if title.is_empty() || title.len() > 200 || title.chars().any(char::is_control) {
                return Err(EngineError::invalid("invalid image preset name"));
            }
            let previous = saved.iter().position(|value| value["name"] == title);
            if name == "image.deletePreset" {
                let index =
                    previous.ok_or_else(|| EngineError::invalid("image preset was not found"))?;
                saved.remove(index);
            } else {
                let filters = if params.get("filters").is_some() {
                    merge_filters(&Value::Null, &params["filters"])?
                } else {
                    let node = raw
                        .first()
                        .map(|id| &snapshot.nodes[id])
                        .ok_or_else(|| EngineError::invalid("select an image"))?;
                    if node.kind == NodeKind::Image && target == "fills" && index.unwrap_or(0) == 0
                    {
                        merge_filters(
                            node.properties.get("imageFilters").unwrap_or(&Value::Null),
                            &Value::Null,
                        )?
                    } else {
                        let stack = stack(node, target);
                        let paint = index
                            .and_then(|index| stack.get(index))
                            .or_else(|| stack.iter().find(|paint| image(paint)))
                            .filter(|paint| image(paint))
                            .ok_or_else(|| {
                                EngineError::invalid("selected layer has no image paint")
                            })?;
                        merge_filters(&paint["filters"], &Value::Null)?
                    }
                };
                let item = json!({"name":title,"filters":filters});
                if let Some(index) = previous {
                    saved[index] = item;
                } else {
                    if saved.len() >= 100 {
                        return Err(EngineError::new(
                            "resource_limit",
                            "at most 100 image presets",
                        ));
                    }
                    saved.push(item);
                }
            }
            commit(vec![Command::DocumentMetadata {
                properties: Properties::from([(PRESET_KEY.into(), json!(saved))]),
            }])?;
            return Ok(json!({"ok":true}));
        }
        let new_image = if matches!(name, "image.place" | "image.replace") {
            let (bytes, label) = super::super::figcraft_file::image_input(params)?;
            if name == "image.place" && params.get("target").is_none() {
                return self.fig_place_image(session, snapshot, state, params, &bytes, &label);
            }
            let node = self.fig_image_node(&bytes, &label, &json!({}))?;
            Some((
                node.properties["assetHash"].clone(),
                node.properties["width"].clone(),
                node.properties["height"].clone(),
            ))
        } else {
            None
        };
        if name == "image.place" {
            let raw = self.fig_layer(session, snapshot, &params["target"])?;
            let node = &snapshot.nodes[&raw];
            if node.parent_id.is_none() {
                return Err(EngineError::invalid("choose a layer for the image fill"));
            }
            let (hash, width, height) = new_image.unwrap();
            let mut fills = stack(node, "fills");
            fills.push(json!({"type":"image","assetHash":hash,"mode":params["mode"].as_str().unwrap_or("fill")}));
            commit(vec![Command::NodeSet {
                node_id: raw.clone(),
                properties: Properties::from([("fills".into(), json!(fills))]),
            }])?;
            return Ok(
                json!({"id":self.fig_alias(session,document,&raw),"image":hash,"width":width,"height":height,"imageProfile":null}),
            );
        }
        if raw.is_empty() {
            return Err(EngineError::invalid("select one or more image layers"));
        }
        if name == "image.adjust" && preset.is_none() && params.get("filters").is_none() {
            return Err(EngineError::invalid("supply preset or filters"));
        }
        let mut commands = Vec::new();
        let mut changed = 0;
        for id in raw {
            let node = &snapshot.nodes[&id];
            let mut properties = Properties::new();
            let mut paints = stack(node, target);
            let mut indices = if let Some(index) = index {
                vec![index]
            } else {
                paints
                    .iter()
                    .enumerate()
                    .filter_map(|(index, paint)| image(paint).then_some(index))
                    .collect::<Vec<_>>()
            };
            if new_image.is_some() && index.is_none() {
                if let Some(last) = indices.last().copied() {
                    indices = vec![last];
                }
            }
            if indices.is_empty()
                && node.kind == NodeKind::Image
                && target == "fills"
                && index.unwrap_or(0) == 0
            {
                if let Some((hash, _, _)) = &new_image {
                    properties.insert("assetHash".into(), hash.clone());
                } else {
                    let base = preset
                        .as_ref()
                        .or_else(|| node.properties.get("imageFilters"))
                        .unwrap_or(&Value::Null);
                    properties.insert(
                        "imageFilters".into(),
                        merge_filters(base, &params["filters"])?,
                    );
                }
                changed += 1;
            } else if node.kind == NodeKind::Image
                && target == "fills"
                && indices == [0]
                && paints.is_empty()
            {
                if let Some((hash, _, _)) = &new_image {
                    properties.insert("assetHash".into(), hash.clone());
                } else {
                    let base = preset
                        .as_ref()
                        .or_else(|| node.properties.get("imageFilters"))
                        .unwrap_or(&Value::Null);
                    properties.insert(
                        "imageFilters".into(),
                        merge_filters(base, &params["filters"])?,
                    );
                }
                changed += 1;
            } else {
                let mut touched = false;
                for index in indices {
                    let Some(paint) = paints.get_mut(index) else {
                        continue;
                    };
                    if let Some((hash, _, _)) = &new_image {
                        if !image(paint) {
                            let width = paint["width"].clone();
                            *paint = json!({"type":"image","mode":"fill","width":width});
                        }
                        paint["type"] = json!("image");
                        paint["assetHash"] = hash.clone();
                        paint.as_object_mut().unwrap().remove("image");
                    } else if image(paint) {
                        let base = preset.as_ref().unwrap_or(&paint["filters"]);
                        paint["filters"] = merge_filters(base, &params["filters"])?;
                    } else {
                        continue;
                    }
                    touched = true;
                    changed += 1;
                }
                if touched {
                    properties.insert(target.into(), json!(paints));
                }
            }
            if !properties.is_empty() {
                commands.push(Command::NodeSet {
                    node_id: id,
                    properties,
                });
            }
        }
        if commands.is_empty() {
            return Err(EngineError::invalid("no matching image paints"));
        }
        commit(commands)?;
        Ok(match new_image {
            Some((image, width, height)) => {
                json!({"image":image,"width":width,"height":height,"changed":changed})
            }
            None => json!({"changed":changed}),
        })
    }
}
