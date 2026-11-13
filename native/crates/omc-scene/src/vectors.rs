use super::{Affine, SceneItem};
use omc_model::NodeKind;
use omc_style::{LengthContext, resolve_length};
use serde_json::Value;
use skia_safe::{Matrix, Path, PathFillType, PathOp, PathVerb, Point, RRect, Rect};

pub fn shape_path(item: &SceneItem) -> Option<Path> {
    let mut path = Path::new();
    let rect = Rect::from_wh(item.width as f32, item.height as f32);
    match item.kind {
        NodeKind::Ellipse => {
            path.add_oval(rect, None);
        }
        NodeKind::Line => {
            let (x, y) = (item.width as f32, item.height as f32);
            path.move_to((0., 0.)).line_to((x, y));
            let length = x.hypot(y);
            if item.properties.get("arrowHead") == Some(&Value::Bool(true)) && length > 0. {
                let weight = item
                    .properties
                    .get("strokeWidth")
                    .and_then(Value::as_f64)
                    .unwrap_or(1.) as f32;
                let size = (4. * weight).clamp(6., length.max(6.)).min(length);
                let (ux, uy) = (x / length, y / length);
                let (hx, hy) = (x - ux * size, y - uy * size);
                path.move_to((hx - uy * size / 2., hy + ux * size / 2.))
                    .line_to((x, y))
                    .line_to((hx + uy * size / 2., hy - ux * size / 2.));
            }
        }
        NodeKind::Path => {
            let svg = item
                .properties
                .get("path")
                .and_then(Value::as_str)
                .unwrap_or("");
            if !svg.is_empty() {
                path = Path::from_svg(svg)?;
                if let Some(radii) = item
                    .properties
                    .get("vectorCornerRadii")
                    .and_then(Value::as_object)
                    .filter(|radii| !radii.is_empty())
                {
                    path = rounded_vector(&path, radii);
                }
            }
            if item.properties.get("fillRule").and_then(Value::as_str) == Some("evenodd") {
                path.set_fill_type(PathFillType::EvenOdd);
            }
        }
        _ => {
            let radius =
                item.style
                    .get("border-radius")
                    .and_then(|value| {
                        resolve_length(
                            value,
                            LengthContext {
                                percent_basis: item.width.min(item.height),
                                ..Default::default()
                            },
                        )
                    })
                    .unwrap_or(0.)
                    .clamp(0., item.width.min(item.height).max(0.) / 2.) as f32;
            path.add_rrect(RRect::new_rect_xy(rect, radius, radius), None);
        }
    }
    Some(path)
}

fn rounded_vector(path: &Path, radii: &serde_json::Map<String, Value>) -> Path {
    let mut result = Path::new();
    let mut records = Vec::new();
    let mut index = 0usize;
    let mut flush = |records: &mut Vec<(PathVerb, Vec<Point>, f32)>, closed: bool| {
        if records.is_empty() {
            return;
        }
        let count = records.len();
        let points = records
            .iter()
            .map(|(_, points, _)| *points.last().unwrap())
            .collect::<Vec<_>>();
        let corner = |i: usize| {
            let point = points[i];
            let radius = radii
                .get(&(index + i).to_string())
                .and_then(Value::as_f64)
                .unwrap_or(0.) as f32;
            let next = (i + 1) % count;
            if radius <= 0.
                || count < 3
                || !closed && (i == 0 || next == 0)
                || i > 0 && records[i].0 != PathVerb::Line
                || next > 0 && records[next].0 != PathVerb::Line
            {
                return (point, point);
            }
            let previous = points[(i + count - 1) % count];
            let next = points[next];
            let toward = |neighbor: Point| {
                let (dx, dy) = (neighbor.x - point.x, neighbor.y - point.y);
                let length = dx.hypot(dy);
                if length <= 1e-6 {
                    point
                } else {
                    let t = (radius / length).min(0.5);
                    Point::new(point.x + dx * t, point.y + dy * t)
                }
            };
            (toward(previous), toward(next))
        };
        result.move_to(corner(0).1);
        for i in (1..count).chain(closed.then_some(0)) {
            let (entry, exit) = corner(i);
            let (verb, controls, weight) = &records[i];
            match verb {
                PathVerb::Quad => {
                    result.quad_to(controls[1], entry);
                }
                PathVerb::Conic => {
                    result.conic_to(controls[1], entry, *weight);
                }
                PathVerb::Cubic => {
                    result.cubic_to(controls[1], controls[2], entry);
                }
                _ => {
                    result.line_to(entry);
                }
            }
            if entry != exit {
                result.quad_to(points[i], exit);
            }
        }
        if closed {
            result.close();
        }
        index += count;
        records.clear();
    };
    for record in path.iter() {
        match record.verb() {
            PathVerb::Move => {
                flush(&mut records, false);
                records.push((
                    record.verb(),
                    record.points().to_vec(),
                    record.conic_weight(),
                ));
            }
            PathVerb::Close => {
                if records.last().is_some_and(|record| {
                    record.0 == PathVerb::Line && record.1.last() == records[0].1.last()
                }) {
                    records.pop();
                }
                flush(&mut records, true);
            }
            _ => records.push((
                record.verb(),
                record.points().to_vec(),
                record.conic_weight(),
            )),
        }
    }
    flush(&mut records, false);
    result
}

pub fn combine_paths<'a>(
    operands: impl IntoIterator<Item = &'a SceneItem>,
    items: &[SceneItem],
    parent_inverse: Affine,
    operation: &str,
) -> Option<Path> {
    let path = combine(operands, items, parent_inverse, operation, false)?;
    if operation == "flatten" {
        path.op(&path, PathOp::Union)
    } else {
        Some(path)
    }
}

pub(super) fn combine_boolean_operands<'a>(
    operands: impl IntoIterator<Item = &'a SceneItem>,
    items: &[SceneItem],
    parent_inverse: Affine,
    operation: &str,
) -> Option<Path> {
    combine(operands, items, parent_inverse, operation, true)
}

fn path_op(operation: &str) -> Option<PathOp> {
    match operation {
        "union" | "flatten" => Some(PathOp::Union),
        "subtract" => Some(PathOp::Difference),
        "intersect" => Some(PathOp::Intersect),
        "exclude" => Some(PathOp::XOR),
        _ => None,
    }
}

fn combine<'a>(
    operands: impl IntoIterator<Item = &'a SceneItem>,
    items: &[SceneItem],
    parent_inverse: Affine,
    operation: &str,
    use_operand_operations: bool,
) -> Option<Path> {
    BooleanGeometry {
        items,
        parent_inverse,
        verbs: 0,
    }
    .combine(
        &mut operands.into_iter(),
        path_op(operation)?,
        0,
        use_operand_operations,
    )
}

struct BooleanGeometry<'a> {
    items: &'a [SceneItem],
    parent_inverse: Affine,
    verbs: usize,
}

impl BooleanGeometry<'_> {
    fn combine<'a>(
        &mut self,
        operands: &mut dyn Iterator<Item = &'a SceneItem>,
        operation: PathOp,
        depth: usize,
        use_operand_operations: bool,
    ) -> Option<Path> {
        if depth > 64 {
            return None;
        }
        let mut result: Option<Path> = None;
        for item in operands {
            let path = if !item.children.is_empty() && item.boolean_operation().is_none() {
                let mut children = item
                    .children
                    .iter()
                    .map(|&index| &self.items[index])
                    .filter(|child| !child.hidden);
                self.combine(&mut children, PathOp::Union, depth + 1, false)?
            } else {
                let mut path = if matches!(
                    item.kind,
                    NodeKind::Rect
                        | NodeKind::Ellipse
                        | NodeKind::Path
                        | NodeKind::Line
                        | NodeKind::Frame
                        | NodeKind::Group
                        | NodeKind::Component
                ) {
                    shape_path(item)?
                } else {
                    return None;
                };
                path.transform(&matrix(self.parent_inverse.multiply(item.world)));
                self.verbs += path.count_verbs();
                if !path.is_finite() || self.verbs > 10_000 {
                    return None;
                }
                path
            };
            result = Some(match result {
                None => path,
                Some(result) => {
                    let op = if use_operand_operations {
                        item.properties
                            .get("booleanOperandOperation")
                            .and_then(Value::as_str)
                            .and_then(path_op)
                            .unwrap_or(operation)
                    } else {
                        operation
                    };
                    result.op(&path, op)?
                }
            });
            if result.as_ref()?.count_verbs() > 10_000 {
                return None;
            }
        }
        Some(result.unwrap_or_default())
    }
}

pub fn path_geometry(path: &Path) -> (String, [f64; 4], &'static str) {
    let bounds = path.compute_tight_bounds();
    let fill_rule = if path.fill_type() == PathFillType::EvenOdd {
        "evenodd"
    } else {
        "nonzero"
    };
    (
        path.to_svg(),
        [
            bounds.left as f64,
            bounds.top as f64,
            bounds.width() as f64,
            bounds.height() as f64,
        ],
        fill_rule,
    )
}

pub fn normalize_path(mut path: Path, transform: Affine) -> (String, [f64; 4], &'static str) {
    path.transform(&matrix(transform));
    let bounds = path.compute_tight_bounds();
    path.offset((-bounds.left, -bounds.top));
    let (svg, _, fill_rule) = path_geometry(&path);
    (
        svg,
        [
            bounds.left as f64,
            bounds.top as f64,
            bounds.width() as f64,
            bounds.height() as f64,
        ],
        fill_rule,
    )
}

pub(super) fn matrix(affine: Affine) -> Matrix {
    let [a, b, c, d, x, y] = affine.0.map(|value| value as f32);
    Matrix::new_all(a, c, x, b, d, y, 0., 0., 1.)
}
