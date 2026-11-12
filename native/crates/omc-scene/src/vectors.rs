use super::{Affine, SceneItem};
use omc_model::NodeKind;
use omc_style::{LengthContext, resolve_length};
use serde_json::Value;
use skia_safe::{Matrix, Path, PathFillType, PathOp, RRect, Rect};

pub fn shape_path(item: &SceneItem) -> Option<Path> {
    let mut path = Path::new();
    let rect = Rect::from_wh(item.width as f32, item.height as f32);
    match item.kind {
        NodeKind::Ellipse => {
            path.add_oval(rect, None);
        }
        NodeKind::Line => {
            path.move_to((0., 0.))
                .line_to((item.width as f32, item.height as f32));
        }
        NodeKind::Path => {
            let svg = item
                .properties
                .get("path")
                .and_then(Value::as_str)
                .unwrap_or("");
            if !svg.is_empty() {
                path = Path::from_svg(svg)?;
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

pub fn combine_paths<'a>(
    operands: impl IntoIterator<Item = &'a SceneItem>,
    items: &[SceneItem],
    parent_inverse: Affine,
    operation: &str,
) -> Option<Path> {
    let op = match operation {
        "union" | "flatten" => PathOp::Union,
        "subtract" => PathOp::Difference,
        "intersect" => PathOp::Intersect,
        "exclude" => PathOp::XOR,
        _ => return None,
    };
    let mut builder = BooleanGeometry {
        items,
        parent_inverse,
        verbs: 0,
    };
    let path = builder.combine(&mut operands.into_iter(), op, 0)?;
    if operation == "flatten" {
        path.op(&path, PathOp::Union)
    } else {
        Some(path)
    }
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
                self.combine(&mut children, PathOp::Union, depth + 1)?
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
                Some(result) => result.op(&path, operation)?,
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
