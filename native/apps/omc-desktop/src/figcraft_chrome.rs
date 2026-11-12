//! FigCraft v0.17.0 (`5bc71c1a`) toolbar.rs, panels/layers.rs and icons/draw.rs,
//! adapted from egui to the native Skia editor under the upstream MIT license.

use crate::{app::Tool, geometry::Rect};
use omc_model::NodeKind;
use skia_safe::{Canvas, Color, Paint, PaintStyle, PathBuilder, Rect as SkRect, paint};
use std::f32::consts::{FRAC_PI_2, PI, TAU};

pub const RAIL_WIDTH: f64 = 52.;
pub const SIDEBAR_WIDTH: f64 = 240.;
pub const INSPECTOR_WIDTH: f64 = 232.;

const GLYPH: f64 = 18.;
const CARET: f64 = 14.;
const RAIL_ICON: f64 = 20.;
const TOOL_CELL: f64 = 32.;
const PAD: f64 = 8.;
const GAP: f64 = 8.;
const DIVIDER: f64 = 1.;
const FLYOUT_GAP: f64 = 2.;
const FLYOUT_W: f64 = 16.;
const GROUP_STRIDE: f64 = TOOL_CELL + FLYOUT_GAP + FLYOUT_W + GAP;
const ACTIONS_X: f64 = PAD + GROUPS.len() as f64 * GROUP_STRIDE;
const DIVIDER_X: f64 = ACTIONS_X + 3. * (TOOL_CELL + GAP);
const MODES_X: f64 = DIVIDER_X + DIVIDER + GAP;
const DOCK_WIDTH: f64 = MODES_X + 3. * TOOL_CELL + PAD;
const BORDER: Color = Color::from_rgb(0xe6, 0xe6, 0xe6);
const FIELD: Color = Color::from_rgb(0xf5, 0xf5, 0xf5);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DockGroup {
    Move,
    Frame,
    Shape,
    Text,
}

const GROUPS: [DockGroup; 4] = [
    DockGroup::Move,
    DockGroup::Frame,
    DockGroup::Shape,
    DockGroup::Text,
];

impl DockGroup {
    pub fn tools(self) -> &'static [Tool] {
        match self {
            Self::Move => &[Tool::Select, Tool::Pan],
            Self::Frame => &[Tool::Frame],
            Self::Shape => &[Tool::Rect, Tool::Ellipse],
            Self::Text => &[Tool::Text],
        }
    }

    pub fn active_tool(self, active: Tool) -> Tool {
        let tools = self.tools();
        if tools.contains(&active) {
            active
        } else {
            tools[0]
        }
    }
}

pub fn dock_rect(viewport: Rect) -> Option<Rect> {
    let width = DOCK_WIDTH.min((viewport.width - 16.).max(0.));
    (width >= 200. && viewport.height >= 64.).then(|| {
        Rect::new(
            viewport.x + (viewport.width - width) * 0.5,
            viewport.y + viewport.height - 12. - 48.,
            width,
            48.,
        )
    })
}

fn dock_hit(dock: Rect, x: f64, width: f64) -> Rect {
    let scale = dock.width / DOCK_WIDTH;
    Rect::new(dock.x + x * scale, dock.y + PAD, width * scale, TOOL_CELL)
}

pub fn dock_groups(dock: Rect) -> impl Iterator<Item = (DockGroup, Rect, Rect)> {
    GROUPS.into_iter().enumerate().map(move |(i, group)| {
        let x = PAD + i as f64 * GROUP_STRIDE;
        (
            group,
            dock_hit(dock, x, TOOL_CELL),
            dock_hit(dock, x + TOOL_CELL + FLYOUT_GAP, FLYOUT_W),
        )
    })
}

pub fn dock_utilities(dock: Rect) -> [Rect; 3] {
    std::array::from_fn(|i| dock_hit(dock, ACTIONS_X + i as f64 * (TOOL_CELL + GAP), TOOL_CELL))
}

pub fn dock_modes(dock: Rect) -> [Rect; 3] {
    std::array::from_fn(|i| dock_hit(dock, MODES_X + i as f64 * TOOL_CELL, TOOL_CELL))
}

pub fn dock_flyout(dock: Rect, button: Rect, viewport: Rect, rows: usize) -> Rect {
    let width = 220_f64.min(viewport.width);
    let height = 2. * PAD + TOOL_CELL * rows as f64;
    Rect::new(
        button
            .x
            .min(viewport.x + viewport.width - width)
            .max(viewport.x),
        dock.y - 8. - height,
        width,
        height,
    )
}

pub fn dock_flyout_rows(menu: Rect, group: DockGroup) -> impl Iterator<Item = (usize, Tool, Rect)> {
    group
        .tools()
        .iter()
        .copied()
        .enumerate()
        .map(move |(i, tool)| {
            (
                i,
                tool,
                Rect::new(
                    menu.x + PAD,
                    menu.y + PAD + i as f64 * TOOL_CELL,
                    menu.width - 2. * PAD,
                    TOOL_CELL,
                ),
            )
        })
}

pub fn dock_tool_shortcut(tool: Tool) -> &'static str {
    match tool {
        Tool::Select => "V",
        Tool::Pan => "H",
        Tool::Frame => "F",
        Tool::Rect => "R",
        Tool::Ellipse => "O",
        Tool::Text => "T",
    }
}

pub fn dock_tooltip(dock: Rect, button: Rect, viewport: Rect, label_width: f64) -> Rect {
    let width = (label_width + 18.).min(viewport.width);
    let center = button.x + button.width * 0.5;
    Rect::new(
        (center - width * 0.5)
            .min(viewport.x + viewport.width - width)
            .max(viewport.x),
        (dock.y - 34.).max(viewport.y),
        width,
        30.,
    )
}

pub fn paint_dock_tooltip(canvas: &Canvas, tip: Rect) {
    let shadow = Rect::new(tip.x - 2., tip.y - 1., tip.width + 4., tip.height + 5.);
    round(canvas, shadow, 15., Color::from_argb(19, 0, 0, 0));
    round(canvas, tip, 13., Color::WHITE);
}

pub fn paint_dock(canvas: &Canvas, dock: Rect) {
    for (i, alpha) in [(6., 10), (3., 16), (1., 24)] {
        let shadow = Rect::new(
            dock.x - i,
            dock.y - i * 0.5,
            dock.width + 2. * i,
            dock.height + 2. * i,
        );
        round(
            canvas,
            shadow,
            (13. + i) as f32,
            Color::from_argb(alpha, 0, 0, 0),
        );
    }
    round(canvas, dock, 13., BORDER);
    round(
        canvas,
        Rect::new(dock.x + 1., dock.y + 1., dock.width - 2., dock.height - 2.),
        12.,
        Color::WHITE,
    );
    let [first, _, last] = dock_modes(dock);
    round(
        canvas,
        Rect::new(
            first.x,
            first.y,
            last.x + last.width - first.x,
            first.height,
        ),
        5.,
        FIELD,
    );
    let divider = dock_hit(dock, DIVIDER_X, DIVIDER);
    canvas.draw_rect(
        SkRect::from_xywh(
            divider.x as f32,
            divider.y as f32,
            divider.width as f32,
            divider.height as f32,
        ),
        &colored(BORDER),
    );
}

pub fn paint_dock_chevron(canvas: &Canvas, bounds: Rect, color: Color) {
    draw_glyph(canvas, bounds, CARET, color, |g| {
        g.path(&[(4.5, 6.), (8., 9.5), (11.5, 6.)], false);
    });
}

pub fn paint_dock_mode(canvas: &Canvas, index: usize, bounds: Rect, color: Color) {
    draw_glyph(canvas, bounds, 14., color, |g| match index {
        0 => {
            g.path(
                &[
                    (2.5, 13.5),
                    (3.2, 10.3),
                    (10.5, 3.),
                    (13., 5.5),
                    (5.7, 12.8),
                ],
                true,
            );
            g.line(9., 4.5, 11.5, 7.);
        }
        1 => tool_glyph(g, Tool::Frame),
        2 => {
            g.circle(4.5, 11.5, 2.);
            g.line(6., 10., 13., 3.);
            g.path(&[(8.5, 2.5), (13.5, 2.5), (13.5, 7.5)], false);
        }
        3 => {
            g.path(&[(5.5, 4.), (2., 8.), (5.5, 12.)], false);
            g.path(&[(10.5, 4.), (14., 8.), (10.5, 12.)], false);
            g.line(9., 3., 7., 13.);
        }
        _ => {}
    });
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RailItem {
    File,
    Assets,
    Variables,
}

pub fn rail_controls(top: f64) -> [(RailItem, Rect); 3] {
    [RailItem::File, RailItem::Assets, RailItem::Variables].map(|item| {
        let y = top + 8. + 44. + 12. + 68. * item as u8 as f64;
        (item, Rect::new(0., y, RAIL_WIDTH, 56.))
    })
}

pub fn rail_mark(bounds: Rect) -> Rect {
    Rect::new(bounds.x + (bounds.width - 40.) * 0.5, bounds.y, 40., 36.)
}

pub fn paint_tool_icon(canvas: &Canvas, tool: Tool, bounds: Rect, color: Color) {
    draw_glyph(canvas, bounds, GLYPH, color, |g| tool_glyph(g, tool));
}

fn tool_glyph(g: &Glyph<'_>, tool: Tool) {
    match tool {
        Tool::Select => g.fill(&[
            (4., 2.),
            (4., 13.6),
            (6.9, 10.9),
            (8.8, 14.8),
            (10.6, 14.),
            (8.7, 10.2),
            (12.6, 10.2),
        ]),
        Tool::Pan => {
            for (x, top) in [(4.5, 5.), (6.5, 3.5), (8.5, 4.), (10.5, 5.5)] {
                let mut finger = vec![(x, 8.)];
                finger.extend(arc_pts(x + 1., top, 1., PI, TAU));
                finger.push((x + 2., 8.));
                g.path(&finger, false);
            }
            let mut hand = vec![(12.5, 8.), (12.5, 10.)];
            hand.extend(arc_pts(9.5, 10., 3., 0., FRAC_PI_2));
            hand.extend([(8., 13.), (3., 9.4)]);
            hand.extend(arc_pts(3.6, 8.6, 1., 2.2, 5.3));
            hand.push((4.5, 8.5));
            g.path(&hand, false);
        }
        Tool::Frame => {
            g.line(5.5, 3., 5.5, 13.);
            g.line(10.5, 3., 10.5, 13.);
            g.line(3., 5.5, 13., 5.5);
            g.line(3., 10.5, 13., 10.5);
        }
        Tool::Rect => g.rect(2.5, 2.5, 13.5, 13.5, 1.),
        Tool::Ellipse => g.circle(8., 8., 5.5),
        Tool::Text => {
            g.line(3., 3.5, 12., 3.5);
            g.line(7.5, 3., 7.5, 12.5);
            g.line(3.5, 3., 3.5, 5.5);
            g.line(11.5, 3., 11.5, 5.5);
            g.line(5.5, 12.5, 9.5, 12.5);
        }
    }
}

pub fn paint_layer_icon(
    canvas: &Canvas,
    kind: &NodeKind,
    auto_layout: bool,
    bounds: Rect,
    color: Color,
) {
    draw_glyph(canvas, bounds, 14., color, |g| match kind {
        NodeKind::Frame if auto_layout => {
            g.fill_rect(3., 2., 13., 7., 1.);
            g.fill_rect(3., 9., 13., 14., 1.);
        }
        NodeKind::Frame => tool_glyph(g, Tool::Frame),
        NodeKind::Rect => tool_glyph(g, Tool::Rect),
        NodeKind::Ellipse => tool_glyph(g, Tool::Ellipse),
        NodeKind::Text => tool_glyph(g, Tool::Text),
        NodeKind::Line => g.line(2.5, 13.5, 13.5, 2.5),
        NodeKind::Path => {
            g.path(&[(3., 12.5), (6., 4.), (10., 12.), (13., 3.5)], false);
            g.fill_rect(1.5, 11., 4.5, 14., 0.);
            g.fill_rect(11.5, 2., 14.5, 5., 0.);
        }
        NodeKind::Image => {
            g.rect(2.5, 3.5, 13.5, 12.5, 1.);
            g.path(
                &[(2.5, 11.5), (6., 8.), (9., 11.), (10.5, 9.5), (13.5, 12.5)],
                false,
            );
            g.dot(10.5, 6.5, 1.1);
        }
        NodeKind::Component => {
            for (x, y) in [(8., 4.2), (11.8, 8.), (8., 11.8), (4.2, 8.)] {
                g.fill(&[(x, y - 2.5), (x + 2.5, y), (x, y + 2.5), (x - 2.5, y)]);
            }
        }
        NodeKind::Instance => g.path(&[(8., 2.), (14., 8.), (8., 14.), (2., 8.)], true),
        NodeKind::Group => {
            for (x, y, dx, dy) in [
                (2.5, 2.5, 1., 1.),
                (13.5, 2.5, -1., 1.),
                (2.5, 13.5, 1., -1.),
                (13.5, 13.5, -1., -1.),
            ] {
                g.path(&[(x + 3.5 * dx, y), (x, y), (x, y + 3.5 * dy)], false);
            }
        }
    });
}

pub fn layer_action_bounds(row: Rect) -> [Rect; 2] {
    [36., 14.].map(|offset| {
        Rect::new(
            row.x + row.width - offset - 10.,
            row.y + (row.height - 20.) * 0.5,
            20.,
            20.,
        )
    })
}

pub fn paint_layer_lock(canvas: &Canvas, bounds: Rect, locked: bool, color: Color) {
    draw_glyph(canvas, bounds, 14., color, |g| {
        g.rect(3.5, 7.5, 12.5, 13.5, 1.);
        g.dot(8., 10.5, 1.);
        let shackle: Vec<_> = if locked {
            g.line(5.5, 7.5, 5.5, 5.5);
            g.line(10.5, 7.5, 10.5, 5.5);
            arc_pts(8., 5.5, 2.5, PI, TAU).collect()
        } else {
            g.line(10.5, 7.5, 10.5, 4.5);
            arc_pts(13., 4.5, 2.5, PI, TAU).collect()
        };
        g.path(&shackle, false);
    });
}

pub fn paint_layer_eye(canvas: &Canvas, bounds: Rect, hidden: bool, color: Color) {
    draw_glyph(canvas, bounds, 14., color, |g| {
        let radius = 7.;
        let center_y = 7.5;
        let angle = (5.5_f32 / radius).asin();
        let center_offset = radius * angle.cos();
        let mut outline: Vec<_> = arc_pts(
            8.,
            center_y + center_offset,
            radius,
            -FRAC_PI_2 - angle,
            -FRAC_PI_2 + angle,
        )
        .collect();
        outline.extend(arc_pts(
            8.,
            center_y - center_offset,
            radius,
            FRAC_PI_2 - angle,
            FRAC_PI_2 + angle,
        ));
        g.path(&outline, true);
        if hidden {
            g.line(3., 13., 13., 2.);
        } else {
            g.circle(8., center_y, 2.);
        }
    });
}

pub fn paint_rail_icon(canvas: &Canvas, item: RailItem, bounds: Rect, color: Color) {
    draw_glyph(
        canvas,
        rail_mark(bounds),
        RAIL_ICON,
        color,
        |g| match item {
            RailItem::File => {
                g.path(
                    &[
                        (3.5, 2.5),
                        (9.5, 2.5),
                        (12.5, 5.5),
                        (12.5, 13.5),
                        (3.5, 13.5),
                    ],
                    true,
                );
                g.path(&[(9.5, 2.5), (9.5, 5.5), (12.5, 5.5)], false);
            }
            RailItem::Assets => {
                g.path(&[(5., 2.), (8., 5.), (5., 8.), (2., 5.)], true);
                g.circle(11., 5., 2.5);
                g.rect(2.5, 9.5, 7.5, 13.5, 0.);
                g.path(&[(11., 9.), (13.5, 13.5), (8.5, 13.5)], true);
            }
            RailItem::Variables => {
                for (x, y) in [(5., 5.), (11., 5.), (5., 11.), (11., 11.)] {
                    g.dot(x, y, 2.2);
                }
            }
        },
    );
}

pub fn paint_dock_utility(canvas: &Canvas, index: usize, bounds: Rect, color: Color) {
    draw_glyph(canvas, bounds, 14., color, |g| {
        if index == 2 {
            for points in [
                [(2.5, 6.), (2.5, 2.5), (6., 2.5)],
                [(10., 2.5), (13.5, 2.5), (13.5, 6.)],
                [(2.5, 10.), (2.5, 13.5), (6., 13.5)],
                [(10., 13.5), (13.5, 13.5), (13.5, 10.)],
            ] {
                g.path(&points, false);
            }
            g.rect(5.5, 5.5, 10.5, 10.5, 0.);
        } else {
            let undo = index == 0;
            let f = |x| if undo { x } else { 16. - x };
            let mut turn = vec![(f(3.), 5.5), (f(9.5), 5.5)];
            let end = if undo { FRAC_PI_2 } else { -3. * FRAC_PI_2 };
            turn.extend(arc_pts(f(9.5), 9., 3.5, -FRAC_PI_2, end));
            turn.push((f(6.), 12.5));
            g.path(&turn, false);
            g.path(&[(f(5.5), 3.), (f(3.), 5.5), (f(5.5), 8.)], false);
        }
    });
}

fn arc_pts(
    cx: f32,
    cy: f32,
    radius: f32,
    start: f32,
    end: f32,
) -> impl Iterator<Item = (f32, f32)> {
    let count = ((end - start).abs() * radius * 1.5).ceil().clamp(6., 48.) as usize;
    (0..=count).map(move |i| {
        let angle = start + (end - start) * i as f32 / count as f32;
        (cx + radius * angle.cos(), cy + radius * angle.sin())
    })
}

fn round(canvas: &Canvas, rect: Rect, radius: f32, color: Color) {
    let rect = SkRect::from_xywh(
        rect.x as f32,
        rect.y as f32,
        rect.width as f32,
        rect.height as f32,
    );
    canvas.draw_round_rect(rect, radius, radius, &colored(color));
}

fn colored(color: Color) -> Paint {
    let mut paint = Paint::default();
    paint.set_anti_alias(true);
    paint.set_color(color);
    paint
}

fn draw_glyph(
    canvas: &Canvas,
    bounds: Rect,
    size: f64,
    color: Color,
    draw: impl FnOnce(&Glyph<'_>),
) {
    let saved = canvas.save();
    canvas.translate((
        (bounds.x + (bounds.width - size) / 2.) as f32,
        (bounds.y + (bounds.height - size) / 2.) as f32,
    ));
    canvas.scale((size as f32 / 16., size as f32 / 16.));
    let mut stroke = colored(color);
    stroke.set_style(PaintStyle::Stroke);
    stroke.set_stroke_width(1.);
    stroke.set_stroke_cap(paint::Cap::Round);
    stroke.set_stroke_join(paint::Join::Round);
    draw(&Glyph { canvas, stroke });
    canvas.restore_to_count(saved);
}

struct Glyph<'a> {
    canvas: &'a Canvas,
    stroke: Paint,
}

impl Glyph<'_> {
    fn line(&self, x1: f32, y1: f32, x2: f32, y2: f32) {
        self.canvas.draw_line((x1, y1), (x2, y2), &self.stroke);
    }

    fn rect(&self, l: f32, t: f32, r: f32, b: f32, radius: f32) {
        self.canvas
            .draw_round_rect(SkRect::new(l, t, r, b), radius, radius, &self.stroke);
    }

    fn circle(&self, x: f32, y: f32, r: f32) {
        self.canvas.draw_circle((x, y), r, &self.stroke);
    }

    fn dot(&self, x: f32, y: f32, r: f32) {
        self.canvas.draw_circle((x, y), r, &self.fill_paint());
    }

    fn fill_rect(&self, l: f32, t: f32, r: f32, b: f32, radius: f32) {
        self.canvas
            .draw_round_rect(SkRect::new(l, t, r, b), radius, radius, &self.fill_paint());
    }

    fn path(&self, points: &[(f32, f32)], close: bool) {
        self.polygon(points, close, &self.stroke);
    }

    fn fill(&self, points: &[(f32, f32)]) {
        self.polygon(points, true, &self.fill_paint());
    }

    fn fill_paint(&self) -> Paint {
        let mut paint = self.stroke.clone();
        paint.set_style(PaintStyle::Fill);
        paint
    }

    fn polygon(&self, points: &[(f32, f32)], close: bool, paint: &Paint) {
        let mut path = PathBuilder::new();
        path.move_to(points[0]);
        for &point in &points[1..] {
            path.line_to(point);
        }
        if close {
            path.close();
        }
        self.canvas.draw_path(&path.detach(None), paint);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tool_and_utility_hits_fit_compact_and_desktop_docks() {
        for width in [230., 432., 906.] {
            let viewport = Rect::new(292., 0., width, 700.);
            let dock = dock_rect(viewport).unwrap();
            assert_eq!(dock.y + dock.height, 688.);
            let hits = dock_groups(dock)
                .flat_map(|(_, tool, caret)| [tool, caret])
                .chain(dock_utilities(dock))
                .chain(dock_modes(dock))
                .collect::<Vec<_>>();
            assert!(
                hits.windows(2)
                    .all(|p| p[0].x + p[0].width <= p[1].x + 1e-9)
            );
            assert!(
                hits.iter()
                    .all(|hit| hit.x >= dock.x && hit.x + hit.width <= dock.x + dock.width)
            );
        }
    }

    #[test]
    fn full_dock_keeps_figcraft_cell_and_caret_spacing() {
        let viewport = Rect::new(292., 0., 906., 700.);
        let dock = dock_rect(viewport).unwrap();
        let (group, tool, caret) = dock_groups(dock).next().unwrap();
        assert_eq!(group, DockGroup::Move);
        assert_eq!(tool.x, dock.x + 8.);
        assert_eq!(tool.width, 32.);
        assert_eq!(caret.x, tool.x + 34.);
        assert_eq!(caret.width, 16.);
        assert_eq!(group.active_tool(Tool::Pan), Tool::Pan);
        let menu = dock_flyout(dock, tool, viewport, group.tools().len());
        assert_eq!(menu.width, 220.);
        assert_eq!(menu.y + menu.height, dock.y - 8.);
        assert_eq!(dock_flyout_rows(menu, group).count(), 2);
    }

    #[test]
    fn layer_actions_keep_separate_hit_regions_in_the_row() {
        let row = Rect::new(62., 256., 220., 32.);
        let [lock, eye] = layer_action_bounds(row);
        assert_eq!(lock.x + lock.width + 2., eye.x);
        assert_eq!(eye.x + eye.width + 4., row.x + row.width);
        for button in [lock, eye] {
            assert!(row.contains(button.x, button.y));
            assert!(row.contains(button.x + button.width, button.y + button.height));
        }
    }
}
