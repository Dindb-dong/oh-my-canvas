use super::*;
use std::fmt::Write as _;

pub(super) type Point = (f64, f64);
pub(super) const MAX_POINTS: usize = 512;

pub(super) struct InkState {
    pub pencil_brush: Value,
    pub marker: String,
    pub highlighter: String,
}

impl Default for InkState {
    fn default() -> Self {
        Self {
            pencil_brush: Value::Null,
            marker: "#1e1e1e".into(),
            highlighter: "#ffe78a".into(),
        }
    }
}

impl InkState {
    pub fn color(&self, tool: Tool) -> &str {
        match tool {
            Tool::Marker => &self.marker,
            Tool::Highlighter => &self.highlighter,
            _ => "#202020",
        }
    }
}

fn ink_width(tool: Tool) -> f32 {
    match tool {
        Tool::Highlighter => 20.,
        Tool::Marker => 4.,
        _ => 2.,
    }
}

fn erase_area(points: &[Point], radius: f64) -> Option<skia_safe::Path> {
    let &(x, y) = points.first()?;
    if points.len() == 1 {
        return Some(skia_safe::Path::circle(
            (x as f32, y as f32),
            radius as f32,
            None,
        ));
    }
    let mut line = skia_safe::PathBuilder::new();
    line.move_to((x as f32, y as f32));
    for &(x, y) in &points[1..] {
        line.line_to((x as f32, y as f32));
    }
    let mut paint = skia_safe::Paint::default();
    paint.set_style(skia_safe::PaintStyle::Stroke);
    paint.set_stroke_width((radius * 2.) as f32);
    paint.set_stroke_cap(skia_safe::PaintCap::Round);
    paint.set_stroke_join(skia_safe::PaintJoin::Round);
    let mut area = skia_safe::Path::new();
    skia_safe::path_utils::fill_path_with_paint(&line.detach(None), &paint, &mut area, None, None)
        .then_some(area)
}

#[derive(Clone, Copy)]
pub(super) struct PenVertex {
    pub point: Point,
    pub tangent: Point,
}

fn distance(a: Point, b: Point) -> f64 {
    (a.0 - b.0).hypot(a.1 - b.1)
}

pub(super) fn sample(points: &mut Vec<Point>, point: Point, threshold: f64) {
    if points
        .last()
        .is_some_and(|last| distance(*last, point) < threshold)
    {
        return;
    }
    if points.len() >= MAX_POINTS {
        let mut retain = false;
        points.retain(|_| {
            retain = !retain;
            retain
        });
    }
    points.push(point);
}

fn curve(vertices: &[PenVertex], closed: bool) -> Option<String> {
    let first = vertices.first()?;
    let mut path = format!("M {} {}", first.point.0, first.point.1);
    for (from, to) in vertices
        .iter()
        .zip(vertices.iter().skip(1).chain(closed.then_some(first)))
    {
        let (x, y) = to.point;
        let a = from.tangent;
        let b = to.tangent;
        if a == (0., 0.) && b == (0., 0.) {
            let _ = write!(path, " L {x} {y}");
        } else {
            let _ = write!(
                path,
                " C {} {} {} {} {x} {y}",
                from.point.0 + a.0,
                from.point.1 + a.1,
                x - b.0,
                y - b.1
            );
        }
    }
    if closed {
        path.push_str(" Z");
    }
    Some(path)
}

fn smooth(points: &[Point]) -> Vec<PenVertex> {
    points
        .iter()
        .enumerate()
        .map(|(index, &point)| {
            let left = points[index.saturating_sub(1)];
            let right = points[(index + 1).min(points.len() - 1)];
            PenVertex {
                point,
                tangent: ((right.0 - left.0) / 6., (right.1 - left.1) / 6.),
            }
        })
        .collect()
}

fn segment_midpoint(
    points: &[skia_safe::Point],
    weight: f32,
    verb: skia_safe::PathVerb,
) -> Option<skia_safe::Point> {
    let blend = |weights: &[f32]| {
        let (x, y) = points
            .iter()
            .zip(weights)
            .fold((0., 0.), |(x, y), (p, k)| (x + p.x * k, y + p.y * k));
        skia_safe::Point::new(x, y)
    };
    match verb {
        skia_safe::PathVerb::Line => Some(blend(&[0.5, 0.5])),
        skia_safe::PathVerb::Quad => Some(blend(&[0.25, 0.5, 0.25])),
        skia_safe::PathVerb::Conic => {
            let total = 2. + 2. * weight;
            Some(blend(&[1. / total, 2. * weight / total, 1. / total]))
        }
        skia_safe::PathVerb::Cubic => Some(blend(&[0.125, 0.375, 0.375, 0.125])),
        _ => None,
    }
}

impl App {
    pub(super) fn pointer_vector(&mut self, point: Point) -> bool {
        match self.tool {
            Tool::Pen => {
                let origin = point;
                let point = self.snap_pen_point(point);
                let close = self.pen_vertices.len() > 2
                    && distance(self.pen_vertices[0].point, point) * self.camera.zoom < 8.;
                if close {
                    self.finish_pen(true);
                } else if self.pen_vertices.len() < MAX_POINTS {
                    self.drag = Some(Drag::PenHandle {
                        origin,
                        point,
                        end: point,
                    });
                }
                true
            }
            Tool::Pencil | Tool::Marker | Tool::Highlighter | Tool::Eraser | Tool::ShapeBuilder => {
                self.drag = Some(Drag::VectorTrace {
                    points: vec![point],
                    tool: self.tool,
                });
                true
            }
            _ => false,
        }
    }

    fn snap_pen_point(&self, point: Point) -> Point {
        let mut nearest = None;
        if self.automation.view.prefs.snap_geometry
            && !self.modifiers.super_key()
            && !self.modifiers.control_key()
        {
            let limit = 5. / self.camera.zoom;
            let mut consider = |target: Point| {
                let delta = distance(target, point);
                if delta <= limit && nearest.is_none_or(|(best, _)| delta < best) {
                    nearest = Some((delta, target));
                }
            };
            for vertex in &self.pen_vertices {
                consider(vertex.point);
            }
            if let Some(scene) = &self.scene {
                let mut remaining = 20_000usize;
                for item in scene.items.iter().rev() {
                    if remaining == 0 {
                        break;
                    }
                    let [x, y, w, h] = item.bounds;
                    if item.hidden
                        || item.kind != NodeKind::Path
                        || point.0 < x - limit
                        || point.0 > x + w + limit
                        || point.1 < y - limit
                        || point.1 > y + h + limit
                    {
                        continue;
                    }
                    let Some(path) = omc_scene::shape_path(item) else {
                        continue;
                    };
                    for record in path.iter().take(remaining) {
                        remaining -= 1;
                        let points = record.points();
                        if let Some(last) = points.last() {
                            consider(item.world.point(f64::from(last.x), f64::from(last.y)));
                        }
                        if let Some(mid) =
                            segment_midpoint(points, record.conic_weight(), record.verb())
                        {
                            consider(item.world.point(f64::from(mid.x), f64::from(mid.y)));
                        }
                    }
                }
            }
        }
        nearest.map_or_else(
            || {
                if self.pointer_pixel_snap() {
                    (point.0.round(), point.1.round())
                } else {
                    point
                }
            },
            |(_, target)| target,
        )
    }

    pub(super) fn add_pen_point(&mut self, point: Point, end: Point) {
        let tangent = if distance(point, end) * self.camera.zoom > 3. {
            (end.0 - point.0, end.1 - point.1)
        } else {
            (0., 0.)
        };
        if self
            .pen_vertices
            .last()
            .is_none_or(|last| distance(last.point, point) > 0.01)
        {
            self.pen_vertices.push(PenVertex { point, tangent });
        }
    }

    pub(super) fn finish_pen(&mut self, closed: bool) {
        let vertices = std::mem::take(&mut self.pen_vertices);
        if vertices.len() >= 2
            && let Some(path) = curve(&vertices, closed)
        {
            self.create_vector_path(path, Tool::Pen);
        }
    }

    pub(super) fn finish_shape_builder(&mut self, points: Vec<Point>) {
        if self.version_preview_active() || self.pending || self.inspector == Inspector::Inspect {
            return;
        }
        if self.selected.is_empty() {
            self.error = Some("Select shapes before using Shape builder.".into());
            return;
        }
        let (Some(doc), Some(page)) = (self.document(), self.page.clone()) else {
            return;
        };
        let request = Request::ShapeBuilder {
            id: doc.id.clone(),
            epoch: doc.epoch.clone(),
            sequence: doc.sequence,
            page,
            layers: self.selected.iter().cloned().collect(),
            points,
            remove: self.modifiers.alt_key(),
        };
        self.clear_text_preview();
        self.pending = true;
        self.status = "Saving…".into();
        self.error = None;
        self.send(request);
    }

    pub(super) fn finish_vector_trace(&mut self, points: &[Point], tool: Tool) {
        if let [point] = points
            && matches!(tool, Tool::Marker | Tool::Highlighter)
        {
            let (x, y) = *point;
            self.create_vector_path(format!("M {x} {y} L {} {y}", x + 0.01), tool);
        } else if points.len() >= 2
            && let Some(path) = curve(&smooth(points), false)
        {
            self.create_vector_path(path, tool);
        }
    }

    pub(super) fn finish_eraser(&mut self, points: &[Point]) {
        let Some(area) = erase_area(points, 7. / self.camera.zoom) else {
            return;
        };
        let Some(scene) = &self.scene else {
            return;
        };
        let ids = scene
            .items
            .iter()
            .filter(|item| {
                item.properties.get("boardItemType").and_then(Value::as_str) == Some("ink")
                    && self.layer_transformable(&item.id)
            })
            .filter(|item| {
                let [a, b, c, d, x, y] = item.world.0.map(|value| value as f32);
                let transform = skia_safe::Matrix::new_all(a, c, x, b, d, y, 0., 0., 1.);
                omc_render::stroke_outlines(item).is_ok_and(|paths| {
                    paths.into_iter().any(|(mut path, _)| {
                        path.transform(&transform);
                        path.op(&area, skia_safe::PathOp::Intersect)
                            .is_some_and(|overlap| !overlap.is_empty())
                    })
                })
            })
            .map(|item| item.id.clone())
            .collect::<Vec<_>>();
        if !ids.is_empty() {
            self.selected.retain(|id| !ids.contains(id));
            self.mutate(json!({"type":"node.delete","nodeIds":ids}), "erase ink");
        }
    }

    fn create_vector_path(&mut self, source: String, tool: Tool) {
        let Some(path) = skia_safe::Path::from_svg(&source) else {
            return;
        };
        let (path, [x, y, width, height], _) =
            omc_scene::normalize_path(path, omc_scene::Affine::IDENTITY);
        let Some(parent) = self.current_root() else {
            return;
        };
        let Some(doc) = self.document() else {
            return;
        };
        let (mut commands, rank) = match crate::commands::append_rank(doc, &parent) {
            Ok(result) => result,
            Err(error) => {
                self.error = Some(error);
                return;
            }
        };
        let id = format!("node_{}", Uuid::new_v4().simple());
        let name = if tool == Tool::Pen {
            "Vector"
        } else {
            tool.label()
        };
        let color = self.vector_ink.color(tool);
        let mut props = json!({"name":name,"x":x,"y":y,"width":width,"height":height,"path":path,
            "fill":"transparent","stroke":color,"strokeWidth":ink_width(tool),"strokeCap":"round","strokeJoin":"round"});
        if matches!(tool, Tool::Marker | Tool::Highlighter) {
            props["boardItemType"] = json!("ink");
            props["strokes"] = json!([{"type":"solid","color":color,"width":ink_width(tool),"cap":"round","join":"round"}]);
            props["opacity"] = json!(if tool == Tool::Highlighter { 0.45 } else { 1. });
            props["style"] = json!({"position":"absolute"});
        } else if tool == Tool::Pencil && !self.vector_ink.pencil_brush.is_null() {
            props["strokeBrush"] = self.vector_ink.pencil_brush.clone();
        }
        let node = json!({"id":id,"kind":"path","parentId":parent,"rank":rank,
            "homeShard":doc.nodes[&parent].home_shard,"properties":props});
        commands.push(json!({"type":"node.create","node":node}));
        self.selected.clear();
        self.selected.insert(id);
        self.mutate(
            json!({"type":"batch","commands":commands}),
            "vector drawing",
        );
        if !self.automation.view.prefs.keep_tool
            && !matches!(tool, Tool::Marker | Tool::Highlighter)
        {
            self.tool = Tool::Select;
        }
    }

    pub(crate) fn vector_preview_style(&self) -> Option<(omc_style::Color, f32)> {
        match self.tool {
            Tool::Marker | Tool::Highlighter => {
                let mut color = omc_style::parse_color(self.vector_ink.color(self.tool))?;
                if self.tool == Tool::Highlighter {
                    color.a *= 0.45;
                }
                Some((color, ink_width(self.tool)))
            }
            Tool::Eraser => Some((
                omc_style::parse_color("#ff557755")?,
                14. / self.camera.zoom as f32,
            )),
            _ => None,
        }
    }

    pub(crate) fn vector_preview(&self) -> Option<skia_safe::Path> {
        let path = match self.drag.as_ref() {
            Some(Drag::VectorTrace { points, .. }) => curve(&smooth(points), false),
            Some(Drag::PenHandle { point, end, .. }) => {
                let mut vertices = self.pen_vertices.clone();
                vertices.push(PenVertex {
                    point: *point,
                    tangent: (end.0 - point.0, end.1 - point.1),
                });
                curve(&vertices, false)
            }
            _ if self.tool == Tool::Pen && !self.pen_vertices.is_empty() => {
                let mut vertices = self.pen_vertices.clone();
                vertices.push(PenVertex {
                    point: self.world(self.cursor.0, self.cursor.1),
                    tangent: (0., 0.),
                });
                curve(&vertices, false)
            }
            _ => None,
        }?;
        skia_safe::Path::from_svg(&path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pen_closes_and_preserves_dragged_tangent() {
        let nodes = [
            PenVertex {
                point: (10., 20.),
                tangent: (5., 0.),
            },
            PenVertex {
                point: (30., 20.),
                tangent: (0., 0.),
            },
            PenVertex {
                point: (20., 30.),
                tangent: (0., 0.),
            },
        ];
        let source = curve(&nodes, true).unwrap();
        assert!(source.starts_with("M 10 20 C 15 20"));
        assert!(source.ends_with(" Z"));
        assert!(skia_safe::Path::from_svg(&source).is_some());
    }

    #[test]
    fn eraser_sweep_includes_rounded_caps_without_filling_between_segments() {
        let dot = erase_area(&[(10., 20.)], 4.).unwrap();
        assert!(dot.contains((10., 20.)));
        assert!(!dot.contains((15., 20.)));
        let sweep = erase_area(&[(10., 10.), (10., 40.), (40., 40.)], 4.).unwrap();
        assert!(sweep.contains((8., 8.)));
        assert!(sweep.contains((42., 41.)));
        assert!(!sweep.contains((23., 26.)));
    }

    #[test]
    fn pencil_samples_movement_and_fits_smooth_segments() {
        let mut points = vec![(0., 0.)];
        sample(&mut points, (0.1, 0.1), 1.);
        sample(&mut points, (2., 3.), 1.);
        sample(&mut points, (5., 0.), 1.);
        assert_eq!(points.len(), 3);
        let source = curve(&smooth(&points), false).unwrap();
        assert_eq!(source.matches(" C ").count(), 2);
        assert!(skia_safe::Path::from_svg(&source).is_some());
        let mut long = (0..MAX_POINTS).map(|index| (index as f64, 0.)).collect();
        sample(&mut long, (MAX_POINTS as f64, 0.), 1.);
        assert!(long.len() < MAX_POINTS);
        assert_eq!(long.first(), Some(&(0., 0.)));
        assert_eq!(long.last(), Some(&(MAX_POINTS as f64, 0.)));
    }
}
