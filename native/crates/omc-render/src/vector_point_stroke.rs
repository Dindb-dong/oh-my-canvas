use omc_scene::SceneItem;
use serde_json::Value;
use skia_safe::{
    Paint, Path, PathOp, PathVerb, Point,
    paint::{Cap, Join},
};

pub(super) fn outline(
    item: &SceneItem,
    path: &Path,
    paint: &Paint,
    outline: Option<Path>,
) -> Option<Path> {
    let caps = item
        .properties
        .get("vectorPointCaps")
        .and_then(Value::as_object)
        .filter(|caps| !caps.is_empty());
    let joins = item
        .properties
        .get("vectorPointJoins")
        .and_then(Value::as_object)
        .filter(|joins| !joins.is_empty());
    if caps.is_none() && joins.is_none() {
        return outline;
    }
    let width = paint.stroke_width();
    if width <= 0. {
        return outline;
    }
    let mut result = if let Some(outline) = outline {
        outline
    } else {
        let mut initial = paint.clone();
        if caps.is_some() {
            initial.set_stroke_cap(Cap::Butt);
        }
        stroke(path, &initial)?
    };
    let vertices = contours(path);
    let mut index = 0;
    for (points, closed) in vertices {
        let count = points.len();
        for (i, point) in points.iter().enumerate() {
            let key = (index + i).to_string();
            if !closed && (i == 0 || i + 1 == count) {
                if let Some(caps) = caps {
                    let cap = caps.get(&key).and_then(Value::as_str).unwrap_or(
                        match paint.stroke_cap() {
                            Cap::Round => "round",
                            Cap::Square => "square",
                            _ => "none",
                        },
                    );
                    let toward = if i == 0 { point.next } else { point.previous };
                    if let Some(toward) = toward {
                        let shape = cap_shape(point.at, toward, width, cap);
                        if !shape.is_empty() {
                            result = result.op(&shape, PathOp::Union)?;
                        }
                    }
                }
            } else if let Some(join) = joins
                .and_then(|joins| joins.get(&key))
                .and_then(Value::as_str)
            {
                let (Some(previous), Some(next)) = (point.previous, point.next) else {
                    continue;
                };
                let radius = ((previous.x - point.at.x).hypot(previous.y - point.at.y) * 0.49)
                    .min((next.x - point.at.x).hypot(next.y - point.at.y) * 0.49)
                    .min(width * paint.stroke_miter().max(2.));
                if radius <= width * 0.5 {
                    continue;
                }
                let mut disk = Path::new();
                disk.add_circle(point.at, radius, None);
                let mut local = Path::new();
                local.move_to(previous).line_to(point.at).line_to(next);
                let mut local_paint = paint.clone();
                local_paint
                    .set_stroke_cap(Cap::Butt)
                    .set_path_effect(None)
                    .set_stroke_join(match join {
                        "round" => Join::Round,
                        "bevel" => Join::Bevel,
                        _ => Join::Miter,
                    });
                let patched = stroke(&local, &local_paint)?.op(&disk, PathOp::Intersect)?;
                result = result
                    .op(&disk, PathOp::Difference)?
                    .op(&patched, PathOp::Union)?;
            }
        }
        index += count;
    }
    (result.is_finite() && result.count_verbs() <= 10_000).then_some(result)
}

struct Vertex {
    at: Point,
    previous: Option<Point>,
    next: Option<Point>,
}

fn contours(path: &Path) -> Vec<(Vec<Vertex>, bool)> {
    let mut contours = Vec::new();
    let mut vertices: Vec<Vertex> = Vec::new();
    for record in path.iter() {
        let points = record.points();
        match record.verb() {
            PathVerb::Move => {
                if !vertices.is_empty() {
                    contours.push((std::mem::take(&mut vertices), false));
                }
                vertices.push(Vertex {
                    at: points[0],
                    previous: None,
                    next: None,
                });
            }
            PathVerb::Close => {
                if vertices.len() > 1
                    && vertices
                        .last()
                        .is_some_and(|vertex| vertex.at == vertices[0].at)
                {
                    vertices.pop();
                }
                if vertices.len() > 1 {
                    let first = vertices[0].at;
                    let last = vertices.last().unwrap().at;
                    vertices[0].previous = Some(last);
                    vertices.last_mut().unwrap().next = Some(first);
                }
                if !vertices.is_empty() {
                    contours.push((std::mem::take(&mut vertices), true));
                }
            }
            _ => {
                if let Some(previous) = vertices.last_mut() {
                    let next = points
                        .iter()
                        .skip(1)
                        .copied()
                        .find(|point| *point != previous.at)
                        .unwrap_or(previous.at);
                    previous.next = Some(next);
                    let at = *points.last().unwrap();
                    let before = points
                        .iter()
                        .rev()
                        .skip(1)
                        .copied()
                        .find(|point| *point != at)
                        .unwrap_or(at);
                    vertices.push(Vertex {
                        at,
                        previous: Some(before),
                        next: None,
                    });
                }
            }
        }
    }
    if !vertices.is_empty() {
        contours.push((vertices, false));
    }
    contours
}

fn stroke(path: &Path, paint: &Paint) -> Option<Path> {
    let mut outline = Path::new();
    skia_safe::path_utils::fill_path_with_paint(path, paint, &mut outline, None, None)
        .then_some(outline)
}

fn cap_shape(at: Point, toward: Point, width: f32, cap: &str) -> Path {
    let mut shape = Path::new();
    let (dx, dy) = (at.x - toward.x, at.y - toward.y);
    let length = dx.hypot(dy);
    if length <= 1e-6 {
        return shape;
    }
    let (dx, dy) = (dx / length, dy / length);
    let point = |along: f32, across: f32| {
        Point::new(
            at.x + width * (dx * along - dy * across),
            at.y + width * (dy * along + dx * across),
        )
    };
    let mut polygon = |points: &[(f32, f32)]| {
        shape.move_to(point(points[0].0, points[0].1));
        for &(x, y) in &points[1..] {
            shape.line_to(point(x, y));
        }
        shape.close();
    };
    match cap {
        "round" => {
            shape.add_circle(at, width * 0.5, None);
        }
        "square" => polygon(&[(0., -0.5), (0.5, -0.5), (0.5, 0.5), (0., 0.5)]),
        "triangleArrow" => polygon(&[(-2., -1.5), (0.5, 0.), (-2., 1.5)]),
        "reversedTriangle" => polygon(&[(0.5, -1.5), (-2., 0.), (0.5, 1.5)]),
        "lineArrow" => {
            let mut line = Path::new();
            line.move_to(point(-1.5, -1.5))
                .line_to(point(0., 0.))
                .line_to(point(-1.5, 1.5));
            let mut paint = Paint::default();
            paint
                .set_style(skia_safe::PaintStyle::Stroke)
                .set_stroke_width(width)
                .set_stroke_join(Join::Round)
                .set_stroke_cap(Cap::Round);
            shape = stroke(&line, &paint).unwrap_or_default();
        }
        "circleFilled" => {
            shape.add_circle(at, width, None);
        }
        "diamondFilled" => polygon(&[(-1.5, 0.), (0., -1.), (1.5, 0.), (0., 1.)]),
        _ => {}
    }
    shape
}
