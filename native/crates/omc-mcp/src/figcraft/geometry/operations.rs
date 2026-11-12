use super::*;
use crate::paths::{Edge, Point, Segment};
use skia_safe::{Paint, PaintStyle, PathOp};

pub(super) fn build(
    snapshot: &DocumentSnapshot,
    state: &ViewState,
    ids: &[String],
    name: &str,
    params: &Value,
) -> Result<Vec<Command>> {
    let scene = paths::scene(snapshot, &state.page_id)?;
    let items = geometry_items(&scene, ids)?;
    match name {
        "vector.simplify" => {
            let tolerance = optional_number(params, "tolerance")?.unwrap_or(1.);
            if !(0. ..=100_000.).contains(&tolerance) {
                return Err(EngineError::invalid("tolerance must be 0–100000"));
            }
            items
                .iter()
                .map(|item| {
                    let geometry = paths::geometry(&snapshot.nodes[&item.id])?;
                    let mut output = Vec::new();
                    let mut contour = Vec::new();
                    let mut flush = |contour: &mut Vec<Segment>| {
                        output.extend(simplify(contour, tolerance, item.world));
                        contour.clear();
                    };
                    for segment in geometry {
                        if matches!(segment.edge, Edge::Move | Edge::Cubic(..) | Edge::Close) {
                            flush(&mut contour);
                        }
                        contour.push(segment);
                    }
                    flush(&mut contour);
                    paths::path_command(&item.id, &output)
                })
                .collect()
        }
        "vector.offset" => {
            let offset = geometry_number(params, "offset")?;
            if offset.abs() > 100_000. {
                return Err(EngineError::invalid("offset must be within ±100000"));
            }
            let mut commands = Vec::new();
            for item in items {
                if !item.children.is_empty() && item.boolean_operation().is_none() {
                    continue;
                }
                if !matches!(
                    item.kind,
                    NodeKind::Rect
                        | NodeKind::Ellipse
                        | NodeKind::Path
                        | NodeKind::Line
                        | NodeKind::Frame
                ) {
                    return Err(EngineError::invalid("offset requires vector geometry"));
                }
                let path = omc_scene::shape_path(item)
                    .ok_or_else(|| EngineError::invalid("invalid vector geometry"))?;
                let mut band = Path::new();
                let mut paint = Paint::default();
                paint
                    .set_style(PaintStyle::Stroke)
                    .set_stroke_width((2. * offset.abs()) as f32)
                    .set_stroke_join(skia_safe::PaintJoin::Round)
                    .set_stroke_cap(skia_safe::PaintCap::Round);
                let adjusted = if offset == 0. {
                    path
                } else {
                    if !skia_safe::path_utils::fill_path_with_paint(
                        &path, &paint, &mut band, None, None,
                    ) {
                        return Err(EngineError::invalid("offset cannot outline this path"));
                    }
                    path.op(
                        &band,
                        if offset > 0. {
                            PathOp::Union
                        } else {
                            PathOp::Difference
                        },
                    )
                    .ok_or_else(|| EngineError::invalid("offset cannot simplify this path"))?
                };
                if adjusted.count_verbs() > 10_000 {
                    return Err(EngineError::new(
                        "resource_limit",
                        "offset exceeds 10000 path verbs",
                    ));
                }
                if adjusted.is_empty() {
                    commands.push(vector::hide(&item.id));
                } else if item.kind == NodeKind::Path && item.boolean_operation().is_none() {
                    let (svg, _, rule) = omc_scene::path_geometry(&adjusted);
                    let mut patch = Properties::new();
                    vector::set_path(&mut patch, svg, rule);
                    patch.insert("pathHandleModes".into(), json!([]));
                    patch.insert("primitive".into(), Value::Null);
                    commands.push(Command::NodeSet {
                        node_id: item.id.clone(),
                        properties: patch,
                    });
                } else {
                    let parent = &scene.items[item.parent.unwrap()];
                    let local = parent
                        .world
                        .inverse()
                        .ok_or_else(|| EngineError::invalid("parent transform is not invertible"))?
                        .multiply(item.world);
                    let (svg, [x, y, w, h], rule) = omc_scene::normalize_path(adjusted, local);
                    let mut path = vector::sibling(snapshot, item, parent, NodeKind::Path);
                    vector::set_path(&mut path.properties, svg, rule);
                    vector::set_position(&mut path.properties, x, y, w, h);
                    vector::copy_boolean_paint(item, &mut path);
                    vector::copy_effects(item, &mut path);
                    path.properties.insert(
                        "name".into(),
                        json!(
                            item.properties
                                .get("name")
                                .and_then(Value::as_str)
                                .unwrap_or("Offset")
                        ),
                    );
                    commands.push(Command::NodeCreate { node: path });
                    commands.push(vector::hide(&item.id));
                }
            }
            Ok(commands)
        }
        "vector.join" | "vector.smoothJoin" => {
            if items.len() > 2 {
                return Err(EngineError::invalid("choose one or two open paths"));
            }
            let mut args = json!({"action":"join","smooth":name=="vector.smoothJoin"});
            if let [a, b] = items.as_slice() {
                let endpoint = |item: &SceneItem| -> Result<[Point; 2]> {
                    let g = paths::geometry(&snapshot.nodes[&item.id])?;
                    let (x, y) = g[0].end;
                    let (ex, ey) = g.last().unwrap().end;
                    Ok([item.world.point(x, y), item.world.point(ex, ey)])
                };
                let (ae, be) = (endpoint(a)?, endpoint(b)?);
                let (first, second) = (0..2)
                    .flat_map(|a| (0..2).map(move |b| (a, b)))
                    .min_by(|&(ai, bi), &(aj, bj)| {
                        let dist = |(x, y): Point, (a, b): Point| (x - a).hypot(y - b);
                        dist(ae[ai], be[bi]).total_cmp(&dist(ae[aj], be[bj]))
                    })
                    .unwrap();
                args["firstStart"] = json!(first == 0);
                args["secondEnd"] = json!(second == 1);
            }
            paths::edit(
                snapshot,
                &state.page_id,
                &ids[0],
                ids.get(1).map(String::as_str),
                &args,
            )
        }
        _ => Err(EngineError::invalid("unknown vector operation")),
    }
}

fn simplify(segments: &[Segment], tolerance: f64, transform: Affine) -> Vec<Segment> {
    if segments.len() < 3 {
        return segments.to_vec();
    }
    let points = segments
        .iter()
        .map(|segment| {
            let (x, y) = segment.end;
            transform.point(x, y)
        })
        .collect::<Vec<_>>();
    let mut keep = BTreeSet::from([0, segments.len() - 1]);
    let mut ranges = vec![(0, segments.len() - 1)];
    while let Some((first, last)) = ranges.pop() {
        let a = points[first];
        let b = points[last];
        let farthest = (first + 1..last)
            .map(|index| (index, distance(points[index], a, b)))
            .max_by(|a, b| a.1.total_cmp(&b.1));
        if let Some((index, _)) = farthest.filter(|(_, distance)| *distance > tolerance) {
            keep.insert(index);
            ranges.extend([(first, index), (index, last)]);
        }
    }
    keep.into_iter()
        .map(|index| segments[index].clone())
        .collect()
}

fn distance((x, y): Point, (a, b): Point, (c, d): Point) -> f64 {
    let (dx, dy) = (c - a, d - b);
    let len = dx * dx + dy * dy;
    let t = if len == 0. {
        0.
    } else {
        ((x - a) * dx + (y - b) * dy) / len
    }
    .clamp(0., 1.);
    (x - a - t * dx).hypot(y - b - t * dy)
}
