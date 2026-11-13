use super::*;
use std::{collections::BTreeSet, path::Path};

struct Format {
    name: String,
    width: f64,
    height: f64,
}

struct Cell {
    text: Option<String>,
    paint: Option<Properties>,
    visible: Option<bool>,
    fit: Option<Value>,
}

fn read_cell(value: &Value) -> Result<Cell> {
    fn text(value: &Value) -> String {
        match value {
            Value::String(value) => value.clone(),
            Value::Null => String::new(),
            value => value.to_string(),
        }
    }

    let (text, paint, visible, fit) = if let Some(value) = value.as_object() {
        let paint = value
            .get("fill")
            .map(|value| {
                if !value
                    .as_str()
                    .is_some_and(|color| omc_style::parse_color(color).is_some())
                {
                    return Err(EngineError::invalid("cell fill must be a color"));
                }
                let paint = design::normalize_selection_paint(Some(value), "#000000")?;
                Ok(Properties::from([
                    ("fill".into(), paint["color"].clone()),
                    ("fills".into(), json!([paint])),
                ]))
            })
            .transpose()?;
        let visible = value
            .get("visible")
            .map(|value| {
                value
                    .as_bool()
                    .ok_or_else(|| EngineError::invalid("cell visibility must be a boolean"))
            })
            .transpose()?;
        let fit = match value.get("fit") {
            None | Some(Value::Bool(false) | Value::Null) => None,
            Some(Value::Bool(true)) => Some(json!({})),
            Some(Value::Object(value)) => Some(Value::Object(value.clone())),
            Some(_) => {
                return Err(EngineError::invalid(
                    "cell fit must be a boolean or text.fit options",
                ));
            }
        };
        (value.get("text").map(text), paint, visible, fit)
    } else {
        (Some(text(value)), None, None, None)
    };
    Ok(Cell {
        text,
        paint,
        visible,
        fit,
    })
}

fn format(value: &Value) -> Result<Format> {
    let dimension = |key: &str| {
        value[key]
            .as_f64()
            .filter(|value| (1. ..=20_000.).contains(value))
            .ok_or_else(|| {
                EngineError::invalid("data formats require width and height between 1 and 20000")
            })
    };
    let width = dimension("width")?;
    let height = dimension("height")?;
    let name = value["name"]
        .as_str()
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| format!("{}x{}", width as u32, height as u32));
    Ok(Format {
        name,
        width,
        height,
    })
}

fn copy_ranks(snapshot: &DocumentSnapshot, parent: &str, count: usize) -> Result<Vec<String>> {
    let last = children(snapshot, parent)
        .last()
        .map(|node| u128::from_str_radix(&node.rank, 16).unwrap_or(0))
        .unwrap_or(0);
    let step = (u128::MAX - last) / (count as u128 + 1);
    if step == 0 {
        return Err(EngineError::new(
            "resource_limit",
            "insufficient sibling ranks for data copies",
        ));
    }
    Ok((1..=count)
        .map(|i| format!("{:032x}", last + step * i as u128))
        .collect())
}

fn apply_fit(node: &mut Node, current: f64, chosen: f64) {
    if (current - chosen).abs() < 0.01 {
        return;
    }
    node.properties.insert("fontSize".into(), json!(chosen));
    if let Some(runs) = node
        .properties
        .get_mut("textRuns")
        .and_then(Value::as_array_mut)
    {
        for run in runs {
            if let Some(attributes) = run["attributes"].as_object_mut() {
                for key in ["fontSize", "font-size"] {
                    if let Some(size) = attributes.get_mut(key) {
                        let original = size
                            .as_f64()
                            .or_else(|| size.as_str()?.trim_end_matches("px").parse().ok());
                        if let Some(original) = original {
                            *size = json!(original * chosen / current);
                        }
                    }
                }
            }
        }
    }
}

impl ToolRouter {
    pub(super) fn fig_data_fill(
        &self,
        session: &str,
        snapshot: &DocumentSnapshot,
        state: &ViewState,
        params: &Value,
    ) -> Result<Value> {
        let source = self.fig_layer(session, snapshot, &params["id"])?;
        let source_node = &snapshot.nodes[&source];
        let parent = source_node
            .parent_id
            .as_deref()
            .filter(|_| source_node.kind == NodeKind::Frame)
            .ok_or_else(|| EngineError::invalid("data.fill requires a frame layer"))?;
        let rows = params["rows"]
            .as_array()
            .filter(|rows| rows.len() <= 500 && rows.iter().all(Value::is_object))
            .ok_or_else(|| EngineError::invalid("rows must be an array of at most 500 objects"))?;
        let formats = if params["formats"].is_null() {
            vec![None]
        } else {
            params["formats"]
                .as_array()
                .filter(|formats| (1..=12).contains(&formats.len()))
                .ok_or_else(|| EngineError::invalid("formats must contain 1–12 sizes"))?
                .iter()
                .map(|value| format(value).map(Some))
                .collect::<Result<Vec<_>>>()?
        };
        let number = |key: &str, default: f64| {
            params
                .get(key)
                .map(|value| {
                    value
                        .as_f64()
                        .filter(|value| value.is_finite())
                        .ok_or_else(|| EngineError::invalid(format!("{key} must be a number")))
                })
                .transpose()
                .map(|value| value.unwrap_or(default))
        };
        let gap = number("gap", 100.)?;
        let scale = number("scale", 1.)?;
        if !(0.1..=8.).contains(&scale) {
            return Err(EngineError::invalid(
                "data export scale must be from 0.1 to 8",
            ));
        }
        let export_format = params["format"]
            .as_str()
            .unwrap_or("png")
            .to_ascii_lowercase();
        if !matches!(
            export_format.as_str(),
            "png" | "jpg" | "webp" | "svg" | "pdf"
        ) {
            return Err(EngineError::invalid(
                "data export format must be png, jpg, webp, svg or pdf",
            ));
        }
        let output_dir = params
            .get("dir")
            .map(|value| {
                value
                    .as_str()
                    .map(Path::new)
                    .ok_or_else(|| EngineError::invalid("dir must be a path"))
            })
            .transpose()?;
        let mut output = json!({"ids":[],"missing":[]});
        if rows.is_empty() {
            if output_dir.is_some() {
                output["files"] = json!([]);
            }
            return Ok(output);
        }

        let mut subtree = Vec::new();
        let mut pending = vec![source_node];
        while let Some(node) = pending.pop() {
            subtree.push(node);
            pending.extend(children(snapshot, &node.id).into_iter().rev());
        }
        let count = rows.len() * formats.len();
        if subtree.len().saturating_mul(count) > 16_000 {
            return Err(EngineError::new(
                "resource_limit",
                "data copies exceed 16000 native layers",
            ));
        }
        let scene = paths::scene(snapshot, &state.page_id)?;
        let source_item = scene
            .item(&source)
            .ok_or_else(|| EngineError::invalid("source frame is outside the active page"))?;
        let parent_inverse = scene
            .item(parent)
            .and_then(|parent| parent.world.inverse())
            .ok_or_else(|| EngineError::invalid("source parent transform is not invertible"))?;
        let (origin_x, origin_y) = parent_inverse.point(0., 0.);
        let column = formats
            .iter()
            .flatten()
            .map(|format| format.width)
            .fold(source_item.width, f64::max);
        let source_name = source_node
            .properties
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("Frame");
        let mut ranks = copy_ranks(snapshot, parent, count)?.into_iter();
        let mut drafts = Vec::with_capacity(subtree.len() * count);
        let mut results = Vec::with_capacity(count);
        let mut fits = Vec::new();
        let mut missing = Vec::new();
        let mut missing_keys = BTreeSet::new();
        let target_names = subtree
            .iter()
            .skip(1)
            .filter_map(|node| node.properties.get("name").and_then(Value::as_str))
            .collect::<BTreeSet<_>>();
        for (row_index, row) in rows.iter().enumerate() {
            let row = row.as_object().unwrap();
            let name = row
                .get("name")
                .and_then(Value::as_str)
                .map(str::to_owned)
                .unwrap_or_else(|| format!("{source_name} {}", row_index + 1));
            let mut cells = BTreeMap::new();
            for (key, value) in row.iter().filter(|(key, _)| *key != "name") {
                if target_names.contains(key.as_str()) {
                    cells.insert(key.as_str(), read_cell(value)?);
                } else if missing_keys.insert(key.clone()) {
                    missing.push(key.clone());
                }
            }
            let dx = (column + gap) * (row_index + 1) as f64;
            let mut dy = 0.;
            for format in &formats {
                let map = subtree
                    .iter()
                    .map(|node| (node.id.clone(), omc_model::new_id("node")))
                    .collect::<BTreeMap<_, _>>();
                let (x, y) = parent_inverse.point(dx, dy);
                let copy_name = format
                    .as_ref()
                    .map(|format| format!("{name}-{}", format.name))
                    .unwrap_or_else(|| name.clone());
                results.push((map[&source].clone(), copy_name.clone()));
                for (index, node) in subtree.iter().enumerate() {
                    let mut copy = (*node).clone();
                    copy.id = map[&node.id].clone();
                    copy.home_shard = omc_model::new_id("shard");
                    remap_values(&mut copy.properties, &map);
                    if index == 0 {
                        copy.rank = ranks.next().unwrap();
                        copy.properties
                            .insert("x".into(), json!(node.number("x", 0.) + x - origin_x));
                        copy.properties
                            .insert("y".into(), json!(node.number("y", 0.) + y - origin_y));
                        copy.properties.insert("name".into(), json!(copy_name));
                        if let Some(format) = format {
                            copy.properties.insert("width".into(), json!(format.width));
                            copy.properties
                                .insert("height".into(), json!(format.height));
                            dy += format.height + gap;
                        }
                    } else {
                        copy.parent_id = node.parent_id.as_ref().map(|parent| map[parent].clone());
                        if let Some(cell) = node
                            .properties
                            .get("name")
                            .and_then(Value::as_str)
                            .and_then(|name| cells.get(name))
                        {
                            if copy.kind == NodeKind::Text {
                                if let Some(text) = &cell.text {
                                    copy.properties.insert("text".into(), json!(text));
                                    copy.properties.remove("textRuns");
                                }
                                if let Some(fit) = &cell.fit {
                                    fits.push((drafts.len(), fit.clone()));
                                }
                            }
                            if let Some(paint) = &cell.paint {
                                copy.properties.remove("fillStyleId");
                                copy.properties.extend(paint.clone());
                            }
                            if let Some(visible) = cell.visible {
                                copy.properties.insert("visible".into(), json!(visible));
                            }
                        }
                    }
                    drafts.push(copy);
                }
            }
        }
        if !fits.is_empty() {
            let draft_snapshot = with_drafts(snapshot, &drafts);
            let scene = paths::scene(&draft_snapshot, &state.page_id)?;
            for (index, options) in fits {
                let node = &mut drafts[index];
                let item = scene
                    .item(&node.id)
                    .ok_or_else(|| EngineError::invalid("data text is outside the active page"))?;
                let fit = text::fit_text_node(node, item, &options)?;
                apply_fit(node, fit.current, fit.chosen);
            }
        }
        let mut export_snapshot = output_dir.map(|_| with_drafts(snapshot, &drafts));
        let mut envelope = CommandEnvelope::new(
            &snapshot.id,
            &snapshot.epoch,
            Command::NodeCreateMany { nodes: drafts },
        );
        envelope.preconditions = Preconditions::Revision {
            revision: omc_model::Revision {
                epoch: snapshot.epoch.clone(),
                sequence: snapshot.sequence,
            },
        };
        let receipt = self.execute_observed(session, envelope)?;
        let ids: Vec<_> = results
            .iter()
            .map(|(id, _)| self.fig_alias(session, &snapshot.id, id))
            .collect();
        output["ids"] = json!(ids);
        output["missing"] = json!(missing);

        if let (Some(dir), Some(ref mut export_snapshot)) = (output_dir, export_snapshot.take()) {
            export_snapshot.sequence = receipt["revision"]["sequence"]
                .as_str()
                .and_then(|value| value.parse().ok())
                .unwrap_or(snapshot.sequence);
            let mut files = Vec::new();
            let mut errors = Vec::new();
            let mut used = BTreeSet::new();
            let mut suffixes = BTreeMap::new();
            for ((raw, name), id) in results.iter().zip(ids) {
                let base = filename(name);
                let next = suffixes.entry(base.to_lowercase()).or_insert(1u64);
                let path = loop {
                    let stem = if *next == 1 {
                        base.clone()
                    } else {
                        format!("{base} {next}")
                    };
                    *next += 1;
                    let file = format!("{stem}.{export_format}");
                    if used.insert(file.to_lowercase()) {
                        break dir.join(file).to_string_lossy().into_owned();
                    }
                };
                let args = json!({
                    "ids":[raw], "pageId":state.page_id, "scale":scale, "format":export_format,
                    "filePath":path, "colorProfile":export_snapshot.metadata.get("colorProfile"),
                });
                let result = self
                    .export_snapshot_native(export_snapshot.clone(), &args)
                    .and_then(|artifact| self.deliver_export(session, &args, artifact));
                match result {
                    Ok(_) => files.push(path),
                    Err(error) => errors.push(json!({"id":id,"path":path,"error":error.message})),
                }
            }
            output["files"] = json!(files);
            if !errors.is_empty() {
                output["errors"] = json!(errors);
            }
        }
        Ok(output)
    }
}

fn with_drafts(snapshot: &DocumentSnapshot, drafts: &[Node]) -> DocumentSnapshot {
    let mut result = snapshot.clone();
    result
        .nodes
        .extend(drafts.iter().map(|draft| (draft.id.clone(), draft.clone())));
    result
}

fn filename(name: &str) -> String {
    let value: String = name
        .chars()
        .take(80)
        .map(|character| {
            if character.is_alphanumeric() || matches!(character, ' ' | '-' | '_') {
                character
            } else {
                '-'
            }
        })
        .collect();
    let value = value.trim();
    if value.is_empty() {
        "copy".into()
    } else {
        value.into()
    }
}
