use super::*;
use omc_scene::measurement::{self, Line, between, edges, line, mid, overlap, union};
use omc_scene::{Scene, SceneItem};
use std::collections::BTreeSet;

pub(super) const COMMANDS: &[(&str, &str, bool, &str)] = &[
    (
        "inspect.properties",
        "Inspect properties",
        false,
        "id?, colorFormat?",
    ),
    ("inspect.assets", "Inspect assets", false, "ids?"),
    ("measure.distances", "Measure distances", false, "ids?, to?"),
    (
        "devMode.addMeasurement",
        "Add measurement",
        true,
        "from?, to?, side?",
    ),
    (
        "devMode.removeMeasurement",
        "Remove measurement",
        true,
        "from?, index?",
    ),
    (
        "devMode.measurements",
        "List measurements",
        false,
        "page?, id?",
    ),
    (
        "measure.padding",
        "Measure auto layout padding",
        false,
        "id?",
    ),
];

impl ToolRouter {
    pub(super) fn fig_inspect_command(
        &self,
        session: &str,
        snapshot: &DocumentSnapshot,
        state: &ViewState,
        selection: &[Value],
        name: &str,
        params: &Value,
    ) -> Result<Value> {
        let document = &snapshot.id;
        let id = json!({"type":"integer","minimum":1});
        let ids = json!({"type":"array","maxItems":200,"items":id});
        let fields = match name {
            "inspect.properties" => {
                json!({"id":id,"colorFormat":{"type":"string","enum":["hex","rgb","css","hsl","hsb"]}})
            }
            "inspect.assets" => json!({"ids":ids}),
            "measure.distances" => json!({"ids":ids,"to":id}),
            "devMode.addMeasurement" => {
                json!({"from":id,"to":id,"side":{"type":"string","enum":["top","right","bottom","left"]}})
            }
            "devMode.removeMeasurement" => {
                json!({"from":id,"index":{"type":"integer","minimum":0}})
            }
            "devMode.measurements" => json!({"id":id,"page":{"type":"integer","minimum":0}}),
            _ => json!({"id":id}),
        };
        schema::check(
            &json!({"type":"object","properties":fields,"additionalProperties":false}),
            params,
            "params",
        )?;
        let page = match params["page"].as_u64() {
            Some(index) => snapshot
                .pages
                .get(index as usize)
                .map(|page| page.id.as_str())
                .ok_or_else(|| EngineError::invalid("unknown page index"))?,
            None => &state.page_id,
        };
        let scene = paths::scene(snapshot, page)?;
        let locate = |id: &str| {
            scene
                .item(id)
                .ok_or_else(|| EngineError::invalid("layer is not on the current page"))
        };
        let alias = |id: &str| self.fig_alias(session, document, id);
        let first = || {
            self.fig_layer(
                session,
                snapshot,
                params
                    .get("id")
                    .or_else(|| selection.first())
                    .ok_or_else(|| EngineError::invalid("select a layer or pass id"))?,
            )
        };
        match name {
            "devMode.addMeasurement" | "devMode.removeMeasurement" => {
                let from = self.fig_layer(
                    session,
                    snapshot,
                    params
                        .get("from")
                        .or_else(|| selection.first())
                        .ok_or_else(|| EngineError::invalid("select a layer or pass from"))?,
                )?;
                let item = locate(&from)?;
                let mut rows = item
                    .properties
                    .get(measurement::PROPERTY)
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                let result = if name == "devMode.addMeasurement" {
                    let side = params["side"].as_str();
                    let to = params
                        .get("to")
                        .map(|id| self.fig_layer(session, snapshot, id))
                        .transpose()?;
                    if side.is_some() && to.is_some() {
                        return Err(EngineError::invalid("pass either to or side"));
                    }
                    if let Some(to) = &to {
                        locate(to)?;
                        if to == &from {
                            return Err(EngineError::invalid("choose two different layers"));
                        }
                    }
                    if rows.len() >= 64 {
                        return Err(EngineError::new(
                            "resource_limit",
                            "64 measurements per layer",
                        ));
                    }
                    let lines = measurement::anchored(&scene, item, to.as_deref(), side);
                    if lines.is_empty() {
                        return Err(EngineError::invalid("measurement has no nonzero distance"));
                    }
                    let index = rows.len();
                    rows.push(json!({"to":to,"side":side}));
                    json!({"from":alias(&from),"index":index,"lines":lines})
                } else {
                    let removed = if let Some(index) = params["index"].as_u64() {
                        if index < rows.len() as u64 {
                            rows.remove(index as usize);
                            1
                        } else {
                            0
                        }
                    } else {
                        let count = rows.len();
                        rows.clear();
                        count
                    };
                    if removed == 0 {
                        return Ok(json!({"removed":0}));
                    }
                    json!({"removed":removed})
                };
                self.submit(
                    session,
                    document,
                    Command::NodeSet {
                        node_id: from,
                        properties: Properties::from([(measurement::PROPERTY.into(), json!(rows))]),
                    },
                    &Value::Null,
                    Some(snapshot.sequence),
                )?;
                Ok(result)
            }
            "devMode.measurements" => {
                let filter = params
                    .get("id")
                    .map(|id| self.fig_layer(session, snapshot, id))
                    .transpose()?;
                let mut result = Vec::new();
                for item in &scene.items {
                    let Some(node) = snapshot.nodes.get(&item.id) else {
                        continue;
                    };
                    let Some(rows) = node
                        .properties
                        .get(measurement::PROPERTY)
                        .and_then(Value::as_array)
                    else {
                        continue;
                    };
                    for (index, row) in rows.iter().enumerate() {
                        let to = row["to"].as_str();
                        if filter
                            .as_deref()
                            .is_some_and(|id| id != item.id && Some(id) != to)
                        {
                            continue;
                        }
                        let side = row["side"].as_str();
                        let lines = measurement::anchored(&scene, item, to, side);
                        if lines.is_empty() {
                            continue;
                        }
                        let labels = lines
                            .iter()
                            .filter_map(|line| line.label.as_deref())
                            .collect::<Vec<_>>();
                        result.push(json!({"from":alias(&item.id),"fromName":node.string("name"),"index":index,
                            "to":to.map(alias),"toName":to.and_then(|id|snapshot.nodes.get(id)).and_then(|node|node.string("name")),"side":side,"labels":labels,"lines":lines}));
                    }
                }
                Ok(json!(result))
            }
            "measure.distances" => {
                let ids = self.fig_layers(session, snapshot, fig_ids(params, selection)?)?;
                let first = ids
                    .first()
                    .ok_or_else(|| EngineError::invalid("select layers or pass ids"))?;
                let to = params
                    .get("to")
                    .map(|id| self.fig_layer(session, snapshot, id))
                    .transpose()?
                    .or_else(|| {
                        snapshot.nodes[first]
                            .parent_id
                            .clone()
                            .filter(|id| id != &state.root)
                    })
                    .ok_or_else(|| EngineError::invalid("pass to for a top-level selection"))?;
                let mut bounds = None;
                for id in ids {
                    let next = edges(locate(&id)?.bounds);
                    bounds = Some(bounds.map_or(next, |previous| union(previous, next)));
                }
                Ok(json!({"lines":between(bounds.unwrap(),edges(locate(&to)?.bounds))}))
            }
            "measure.padding" => {
                let id = first()?;
                let item = locate(&id)?;
                let has_layout =
                    |item: &SceneItem| item.properties.get("layout").is_some_and(Value::is_object);
                let frame = if has_layout(item) {
                    item
                } else {
                    item.parent
                        .map(|index| &scene.items[index])
                        .filter(|item| has_layout(item))
                        .ok_or_else(|| {
                            EngineError::invalid("layer is outside an auto layout frame")
                        })?
                };
                Ok(json!({"frame":alias(&frame.id),"lines":padding(&scene,frame)}))
            }
            "inspect.assets" => {
                let targets = self.fig_layers(session, snapshot, fig_ids(params, selection)?)?;
                let mut pending = targets.into_iter().rev().collect::<Vec<_>>();
                let mut seen = BTreeSet::new();
                let mut assets = Vec::new();
                while let Some(id) = pending.pop() {
                    if !seen.insert(id.clone()) {
                        continue;
                    }
                    let item = locate(&id)?;
                    if item.hidden {
                        continue;
                    }
                    let node = &snapshot.nodes[&id];
                    let authored = node
                        .properties
                        .get("exports")
                        .and_then(Value::as_array)
                        .filter(|rows| !rows.is_empty());
                    let (kind, formats) = if let Some(settings) = authored {
                        (
                            "export",
                            settings
                                .iter()
                                .map(|setting| {
                                    let format = setting["format"]
                                        .as_str()
                                        .unwrap_or("png")
                                        .to_ascii_uppercase();
                                    let size = setting["size"]
                                        .as_str()
                                        .map(str::to_owned)
                                        .unwrap_or_else(|| {
                                            let spec = &setting["size"];
                                            let unit = match spec["by"].as_str() {
                                                Some("width") => "w",
                                                Some("height") => "h",
                                                _ => "x",
                                            };
                                            format!(
                                                "{}{unit}",
                                                spec["value"].as_f64().unwrap_or(1.)
                                            )
                                        });
                                    format!("{format} {size}")
                                })
                                .collect::<Vec<_>>(),
                        )
                    } else if has_image(item) {
                        ("image", vec!["PNG 1x".to_owned()])
                    } else if item.width <= 128.
                        && item.height <= 128.
                        && vector_icon(&scene, item, 0) == Some(true)
                    {
                        ("icon", vec!["SVG 1x".to_owned()])
                    } else {
                        pending.extend(
                            children(snapshot, &id)
                                .iter()
                                .rev()
                                .map(|node| node.id.clone()),
                        );
                        continue;
                    };
                    assets.push(json!({"id":alias(&id),"name":node.string("name").unwrap_or(""),"kind":kind,"exports":formats}));
                    if assets.len() == 200 {
                        break;
                    }
                    pending.extend(
                        children(snapshot, &id)
                            .iter()
                            .rev()
                            .map(|node| node.id.clone()),
                    );
                }
                Ok(json!({"assets":assets}))
            }
            "inspect.properties" => {
                let id = first()?;
                let item = locate(&id)?;
                let node = &snapshot.nodes[&id];
                let display = params["colorFormat"].as_str().unwrap_or("hex");
                let [x, y, _, _] = item.local.bounds(item.width, item.height);
                let px = |value| format!("{}px", rounded(value));
                let mut sections = vec![json!({"title":"Layout","rows":[
                    row("X",px(x)),row("Y",px(y)),row("Width",px(item.width)),row("Height",px(item.height))
                ]})];
                if let Some(layout) = node
                    .properties
                    .get("layout")
                    .filter(|value| value.is_object())
                {
                    sections.push(
                        json!({"title":"Auto layout","rows":layout.as_object().unwrap().iter()
                        .map(|(key,value)|row(key,display_value(value))).collect::<Vec<_>>() }),
                    );
                }
                if node.kind == NodeKind::Text {
                    let font = [
                        ("Family", "fontFamily"),
                        ("Weight", "fontWeight"),
                        ("Size", "fontSize"),
                        ("Line height", "lineHeight"),
                        ("Letter spacing", "letterSpacing"),
                        ("Align", "textAlign"),
                    ];
                    let rows = font
                        .into_iter()
                        .filter_map(|(label, key)| {
                            item.properties
                                .get(key)
                                .map(|value| row(label, display_value(value)))
                        })
                        .collect::<Vec<_>>();
                    if !rows.is_empty() {
                        sections.push(json!({"title":"Typography","rows":rows}));
                    }
                }
                for (title, key, single, style_key) in [
                    ("Fills", "fills", "fill", "fillStyleId"),
                    ("Strokes", "strokes", "stroke", "strokeStyleId"),
                ] {
                    let stack = item
                        .properties
                        .get(key)
                        .and_then(Value::as_array)
                        .cloned()
                        .unwrap_or_else(|| {
                            item.properties
                                .get(single)
                                .filter(|value| *value != "none" && *value != "transparent")
                                .map(|value| vec![json!({"type":"solid","color":value})])
                                .unwrap_or_default()
                        });
                    let mut rows = stack
                        .iter()
                        .enumerate()
                        .map(|(index, paint)| {
                            let label = if stack.len() == 1 {
                                title.to_owned()
                            } else {
                                format!("{title} {}", index + 1)
                            };
                            if let Some(color) = paint["color"]
                                .as_str()
                                .and_then(|c| omc_style::parse_color(c))
                            {
                                let mut r = row(&label, format_color(color, display));
                                r["color"] = json!(format_color(color, "hex"));
                                r
                            } else {
                                row(&label, paint["type"].as_str().unwrap_or("Paint").to_owned())
                            }
                        })
                        .collect::<Vec<_>>();
                    if let Some(first) = rows.first_mut()
                        && let Some(style) = node.string(style_key)
                        && let Some(token) = snapshot.metadata.get(&format!("styles/{style}/name"))
                    {
                        first["token"] = token.clone();
                    }
                    if !rows.is_empty() {
                        sections.push(json!({"title":title,"rows":rows}));
                    }
                }
                let mut effects = Vec::new();
                for key in ["effects", "shadows"] {
                    if let Some(values) = item.properties.get(key).and_then(Value::as_array) {
                        effects.extend(values.iter().map(|effect| {
                            row(
                                effect["type"].as_str().unwrap_or("Effect"),
                                display_value(effect),
                            )
                        }));
                    }
                }
                if !effects.is_empty() {
                    sections.push(json!({"title":"Effects","rows":effects}));
                }
                Ok(json!({"sections":sections}))
            }
            _ => Err(EngineError::invalid("unknown inspection command")),
        }
    }
}

fn has_image(item: &SceneItem) -> bool {
    item.kind == NodeKind::Image
        || ["fills", "strokes"].iter().any(|key| {
            item.properties
                .get(*key)
                .and_then(Value::as_array)
                .is_some_and(|paints| paints.iter().any(|paint| paint["type"] == "image"))
        })
}
fn vector_icon(scene: &Scene, item: &SceneItem, depth: usize) -> Option<bool> {
    if item.hidden {
        return Some(false);
    }
    if depth >= 16 || has_image(item) {
        return None;
    }
    match item.kind {
        NodeKind::Path | NodeKind::Line => Some(true),
        NodeKind::Rect | NodeKind::Ellipse => Some(false),
        NodeKind::Group | NodeKind::Frame | NodeKind::Component | NodeKind::Instance
            if !item.children.is_empty() =>
        {
            item.children.iter().try_fold(false, |result, index| {
                vector_icon(scene, &scene.items[*index], depth + 1).map(|value| result || value)
            })
        }
        _ => None,
    }
}
fn row(label: &str, value: String) -> Value {
    json!({"label":label,"value":value})
}
fn display_value(value: &Value) -> String {
    value
        .as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| value.to_string())
}
fn rounded(value: f64) -> String {
    ((value * 100.).round() / 100.).to_string()
}
fn format_color(color: omc_style::Color, format: &str) -> String {
    let (r, g, b, a) = (
        color.r as f64,
        color.g as f64,
        color.b as f64,
        color.a as f64,
    );
    let channel = |v: f64| (v.clamp(0., 1.) * 255.).round() as u8;
    let alpha = (a < 1.)
        .then(|| format!(", {}", rounded(a)))
        .unwrap_or_default();
    match format {
        "rgb" | "css" => format!(
            "rgb({} {} {}{})",
            channel(r),
            channel(g),
            channel(b),
            if a < 1. {
                format!(" / {}", rounded(a))
            } else {
                String::new()
            }
        ),
        "hsl" | "hsb" => {
            let max = r.max(g).max(b);
            let min = r.min(g).min(b);
            let delta = max - min;
            let hue = if delta == 0. {
                0.
            } else if max == r {
                (g - b) / delta
            } else if max == g {
                (b - r) / delta + 2.
            } else {
                (r - g) / delta + 4.
            };
            let light = (max + min) / 2.;
            let (sat, value) = if format == "hsb" {
                (if max == 0. { 0. } else { delta / max }, max)
            } else {
                (
                    if delta == 0. {
                        0.
                    } else {
                        delta / (1. - (2. * light - 1.).abs())
                    },
                    light,
                )
            };
            format!(
                "{format}({}, {}%, {}%{alpha})",
                rounded((hue * 60.).rem_euclid(360.)),
                rounded(sat * 100.),
                rounded(value * 100.)
            )
        }
        _ => format!(
            "#{:02X}{:02X}{:02X}{}",
            channel(r),
            channel(g),
            channel(b),
            if a < 1. {
                format!("{:02X}", channel(a))
            } else {
                String::new()
            }
        ),
    }
}

fn padding(scene: &Scene, frame: &SceneItem) -> Vec<Line> {
    let mut out = Vec::new();
    let kids = frame
        .children
        .iter()
        .map(|index| &scene.items[*index])
        .filter(|item| !item.hidden && item.style.get("position") != Some("absolute"))
        .take(512)
        .map(|item| edges(item.local.bounds(item.width, item.height)))
        .collect::<Vec<_>>();
    let [cx, cy] = kids
        .iter()
        .copied()
        .reduce(union)
        .map(|[x, y, r, b]| [mid(x, r), mid(y, b)])
        .unwrap_or([frame.width / 2., frame.height / 2.]);
    let pad = frame
        .properties
        .get("layout")
        .map(|value| &value["padding"])
        .unwrap_or(&Value::Null);
    let [t, r, b, l] = [0, 1, 2, 3].map(|i| {
        pad[i]
            .as_f64()
            .or_else(|| pad.as_f64())
            .unwrap_or(0.)
            .max(0.)
    });
    let mut draw = |a: (f64, f64), b: (f64, f64)| {
        line(
            &mut out,
            frame.world.point(a.0, a.1),
            frame.world.point(b.0, b.1),
            false,
        )
    };
    for (a, b) in [
        ((0., cy), (l, cy)),
        ((frame.width - r, cy), (frame.width, cy)),
        ((cx, 0.), (cx, t)),
        ((cx, frame.height - b), (cx, frame.height)),
    ] {
        draw(a, b);
    }
    for (i, a) in kids.iter().enumerate() {
        for axis in [0, 1] {
            let orth = 1 - axis;
            let next = kids
                .iter()
                .enumerate()
                .filter(|(j, b)| i != *j && b[axis] >= a[axis + 2] - 1e-6)
                .filter_map(|(_, b)| {
                    overlap(a[orth], a[orth + 2], b[orth], b[orth + 2])
                        .map(|middle| (b[axis], middle))
                })
                .min_by(|x, y| x.0.total_cmp(&y.0));
            if let Some((gap, at)) = next {
                if axis == 0 {
                    draw((a[2], at), (gap, at));
                } else {
                    draw((at, a[3]), (at, gap));
                }
            }
        }
    }
    out
}
