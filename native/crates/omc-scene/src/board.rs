//! Derived board connector geometry, rebuilt whenever the attached layers move.
use crate::{Affine, SceneItem};
use serde_json::{Value, json};
use skia_safe::{Path, PathOp, Rect};
use std::collections::BTreeMap;

type Point = (f64, f64);

#[derive(Clone, Copy)]
struct Anchor {
    point: Point,
    direction: Point,
}

pub(crate) fn derive(items: &mut [SceneItem], indices: &BTreeMap<String, usize>) {
    for index in 0..items.len() {
        let item = &items[index];
        let Some(connector) = item.properties.get("boardConnector") else {
            continue;
        };
        let Some(world_inverse) = item.world.inverse() else {
            continue;
        };
        let Some((a, b)) = anchors(connector, items, indices) else {
            continue;
        };
        let (mut path, label, portions) = route(connector, a, b);
        let world = item.world;
        let bounds = path.compute_tight_bounds().with_outset((2., 2.));
        path.transform(&crate::vectors::matrix(world_inverse));
        let children = item.children.clone();
        let path_data = path.to_svg();
        let item = &mut items[index];
        item.properties.insert("path".into(), json!(path_data));
        item.properties
            .insert("boardConnectorPortions".into(), json!(portions));
        item.bounds = bounds_array(bounds);
        for child in children {
            if items[child].properties.get("boardConnectorLabel") != Some(&Value::Bool(true)) {
                continue;
            }
            let item = &mut items[child];
            let at = world_inverse.point(label.0, label.1);
            let local = Affine::translation(at.0 - item.width / 2., at.1 - item.height / 2.);
            item.local = local;
            item.world = world.multiply(local);
            item.bounds = item.world.bounds(item.width, item.height);
            let [x, y, w, h] = item.bounds;
            let mut merged = bounds;
            merged.join(Rect::from_xywh(x as f32, y as f32, w as f32, h as f32));
            items[index].bounds = bounds_array(merged);
        }
    }
}

fn bounds_array(bounds: Rect) -> [f64; 4] {
    [
        bounds.left as f64,
        bounds.top as f64,
        bounds.width() as f64,
        bounds.height() as f64,
    ]
}

fn anchors(
    connector: &Value,
    items: &[SceneItem],
    indices: &BTreeMap<String, usize>,
) -> Option<(Anchor, Anchor)> {
    let from = &connector["from"];
    let to = &connector["to"];
    let item_for = |end: &Value| {
        end["layer"]
            .as_str()
            .and_then(|layer| indices.get(layer))
            .map(|index| &items[*index])
    };
    let (from_item, to_item) = (item_for(from), item_for(to));
    let center = |item: Option<&SceneItem>, end: &Value| {
        item.map(|item| item.world.point(item.width / 2., item.height / 2.))
            .or_else(|| point(&end["point"]))
            .or_else(|| point(&end["fallback"]))
    };
    let (a, b) = (center(from_item, from)?, center(to_item, to)?);
    Some((anchor(from, from_item, a, b), anchor(to, to_item, b, a)))
}

fn anchor(end: &Value, item: Option<&SceneItem>, center: Point, other: Point) -> Anchor {
    let Some(item) = item else {
        return Anchor {
            point: center,
            direction: (0., 0.),
        };
    };
    let local_other = item
        .world
        .inverse()
        .map_or(other, |inv| inv.point(other.0, other.1));
    let x = local_other.0 - item.width / 2.;
    let y = local_other.1 - item.height / 2.;
    let side = match end["side"].as_str() {
        Some(side @ ("left" | "right" | "top" | "bottom")) => side,
        _ if x.abs() * item.height >= y.abs() * item.width => {
            if x < 0. {
                "left"
            } else {
                "right"
            }
        }
        _ => {
            if y < 0. {
                "top"
            } else {
                "bottom"
            }
        }
    };
    let (position, direction) = match side {
        "left" => ((0., 0.5), (-1., 0.)),
        "right" => ((1., 0.5), (1., 0.)),
        "top" => ((0.5, 0.), (0., -1.)),
        _ => ((0.5, 1.), (0., 1.)),
    };
    let (u, v) = point(&end["at"]).unwrap_or(position);
    let at = item.world.point(u * item.width, v * item.height);
    let edge = item
        .world
        .point(u * item.width + direction.0, v * item.height + direction.1);
    Anchor {
        point: at,
        direction: unit(sub(edge, at)),
    }
}

fn route(connector: &Value, a: Anchor, b: Anchor) -> (Path, Point, usize) {
    let mut points = vec![a.point];
    let mut path = Path::new();
    let distance = length(sub(b.point, a.point));
    let a_direction = if length(a.direction) > 0. {
        a.direction
    } else {
        unit(sub(b.point, a.point))
    };
    let b_direction = if length(b.direction) > 0. {
        b.direction
    } else {
        unit(sub(a.point, b.point))
    };
    let style = connector["style"].as_str().unwrap_or("elbow");
    let middle = point(&connector["control"]);
    let mut label = midpoint(a.point, b.point);
    let mut curve = None;
    if style == "curved" {
        let arm = (distance / 3.).clamp(12., 160.);
        let c1 = middle.map_or(add(a.point, mul(a_direction, arm)), |m| {
            add(m, sub(a.point, label))
        });
        let c2 = middle.map_or(add(b.point, mul(b_direction, arm)), |m| {
            add(m, sub(b.point, label))
        });
        label = add(mul(add(a.point, b.point), 0.125), mul(add(c1, c2), 0.375));
        curve = Some((c1, c2));
    } else if style == "elbow" {
        let arm = (distance / 5.).clamp(12., 32.);
        let aa = add(a.point, mul(axis(a_direction), arm));
        let bb = add(b.point, mul(axis(b_direction), arm));
        let horizontal = a_direction.0.abs() >= a_direction.1.abs();
        let end_horizontal = b_direction.0.abs() >= b_direction.1.abs();
        points.push(aa);
        if horizontal != end_horizontal {
            points.push(if horizontal {
                (bb.0, aa.1)
            } else {
                (aa.0, bb.1)
            });
        } else if horizontal {
            let x = (aa.0 + bb.0) / 2.;
            points.extend([(x, aa.1), (x, bb.1)]);
        } else {
            let y = (aa.1 + bb.1) / 2.;
            points.extend([(aa.0, y), (bb.0, y)]);
        }
        points.push(bb);
    }
    points.push(b.point);
    points.dedup_by(|a, b| length(sub(*a, *b)) < 0.001);
    if points.len() < 2 {
        return (path, label, 0);
    }
    let portions = if style == "elbow" {
        points.len() - 1
    } else if style == "curved" {
        1
    } else {
        0
    };
    if style == "elbow"
        && let (Some(control), Some(portion)) = (middle, connector["portion"].as_u64())
        && (portion as usize) < portions
    {
        let portion = portion as usize;
        let from = points[portion];
        let to = points[portion + 1];
        let horizontal = (from.0 - to.0).abs() > (from.1 - to.1).abs();
        let shift = |p: Point| {
            if horizontal {
                (p.0, control.1)
            } else {
                (control.0, p.1)
            }
        };
        let (start, end) = (shift(from), shift(to));
        let first = portion == 0;
        let last = portion + 1 == points.len() - 1;
        let mut moved = Vec::with_capacity(points.len() + 2);
        moved.extend_from_slice(&points[..portion]);
        if first {
            moved.push(from);
        }
        moved.extend([start, end]);
        if last {
            moved.push(to);
        }
        moved.extend_from_slice(&points[portion + 2..]);
        moved.dedup_by(|a, b| length(sub(*a, *b)) < 0.001);
        points = moved;
    }
    if let Some(controls) = curve {
        path.move_to(skia_point(a.point)).cubic_to(
            skia_point(controls.0),
            skia_point(controls.1),
            skia_point(b.point),
        );
    } else {
        path.move_to(skia_point(points[0]));
        for p in &points[1..] {
            path.line_to(skia_point(*p));
        }
        label = along(&points, 0.5);
    }
    let start_dir = unit(sub(a.point, curve.map_or(points[1], |c| c.0)));
    let end_dir = unit(sub(
        b.point,
        curve.map_or(points[points.len() - 2], |c| c.1),
    ));
    let start = cap(
        a.point,
        start_dir,
        connector["startCap"].as_str().unwrap_or("none"),
    );
    let end = cap(
        b.point,
        end_dir,
        connector["endCap"].as_str().unwrap_or("triangleArrow"),
    );
    let mut paint = skia_safe::Paint::default();
    paint
        .set_style(skia_safe::paint::Style::Stroke)
        .set_stroke_width(2.)
        .set_stroke_join(skia_safe::paint::Join::Round);
    let mut fill = Path::new();
    skia_safe::path_utils::fill_path_with_paint(&path, &paint, &mut fill, None, None);
    for tip in [start, end].into_iter().flatten() {
        fill = fill.op(&tip, PathOp::Union).unwrap_or_else(|| {
            fill.add_path(&tip, (0., 0.), None);
            fill
        });
    }
    (fill, label, portions)
}

fn cap(tip: Point, direction: Point, kind: &str) -> Option<Path> {
    if kind == "none" {
        return None;
    }
    let perpendicular = (-direction.1, direction.0);
    let base = sub(tip, mul(direction, 9.));
    let left = add(base, mul(perpendicular, 4.5));
    let right = sub(base, mul(perpendicular, 4.5));
    let mut path = Path::new();
    match kind {
        "circleFilled" | "circle" => {
            let center = sub(tip, mul(direction, 4.));
            path.add_circle(skia_point(center), 4., None);
        }
        "diamondFilled" | "diamond" => {
            path.move_to(skia_point(tip))
                .line_to(skia_point(left))
                .line_to(skia_point(sub(tip, mul(direction, 18.))))
                .line_to(skia_point(right))
                .close();
        }
        "squareFilled" | "square" => {
            let head_left = add(tip, mul(perpendicular, 4.5));
            let head_right = sub(tip, mul(perpendicular, 4.5));
            path.move_to(skia_point(head_left))
                .line_to(skia_point(left))
                .line_to(skia_point(right))
                .line_to(skia_point(head_right))
                .close();
        }
        "lineArrow" | "triangle" => {
            path.move_to(skia_point(left))
                .line_to(skia_point(tip))
                .line_to(skia_point(right));
            let mut paint = skia_safe::Paint::default();
            paint
                .set_style(skia_safe::paint::Style::Stroke)
                .set_stroke_width(2.);
            let mut outline = Path::new();
            skia_safe::path_utils::fill_path_with_paint(&path, &paint, &mut outline, None, None);
            return Some(outline);
        }
        _ => {
            path.move_to(skia_point(tip))
                .line_to(skia_point(left))
                .line_to(skia_point(right))
                .close();
        }
    }
    Some(path)
}

fn along(points: &[Point], fraction: f64) -> Point {
    let mut target = points
        .windows(2)
        .map(|p| length(sub(p[1], p[0])))
        .sum::<f64>()
        * fraction;
    for p in points.windows(2) {
        let delta = sub(p[1], p[0]);
        let step = length(delta);
        if target <= step {
            return add(p[0], mul(delta, target / step));
        }
        target -= step;
    }
    *points.last().unwrap()
}
fn point(value: &Value) -> Option<Point> {
    Some((value[0].as_f64()?, value[1].as_f64()?))
}
fn skia_point((x, y): Point) -> (f32, f32) {
    (x as f32, y as f32)
}
fn add(a: Point, b: Point) -> Point {
    (a.0 + b.0, a.1 + b.1)
}
fn sub(a: Point, b: Point) -> Point {
    (a.0 - b.0, a.1 - b.1)
}
fn mul(a: Point, k: f64) -> Point {
    (a.0 * k, a.1 * k)
}
fn midpoint(a: Point, b: Point) -> Point {
    mul(add(a, b), 0.5)
}
fn length(p: Point) -> f64 {
    p.0.hypot(p.1)
}
fn unit(p: Point) -> Point {
    let n = length(p);
    if n > 1e-9 { mul(p, 1. / n) } else { (0., 0.) }
}
fn axis(p: Point) -> Point {
    if p.0.abs() >= p.1.abs() {
        (p.0.signum(), 0.)
    } else {
        (0., p.1.signum())
    }
}
