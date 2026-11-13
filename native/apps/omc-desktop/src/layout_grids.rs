use omc_scene::Scene;
use serde_json::Value;
use skia_safe::{Canvas, Color4f, Matrix, Paint, Rect};

pub fn draw(canvas: &Canvas, scene: &Scene, zoom: f64) {
    for item in scene.items.iter().filter(|item| !item.hidden) {
        let Some(grids) = item.properties.get("layoutGrids").and_then(Value::as_array) else {
            continue;
        };
        let mut parent = item.parent;
        let mut hidden = false;
        while let Some(index) = parent {
            let ancestor = &scene.items[index];
            hidden |= ancestor.hidden;
            parent = ancestor.parent;
        }
        if hidden || item.width <= 0. || item.height <= 0. {
            continue;
        }
        let save = canvas.save();
        let [a, b, c, d, x, y] = item.world.0.map(|value| value as f32);
        canvas.concat(&Matrix::new_all(a, c, x, b, d, y, 0., 0., 1.));
        let (width, height) = (item.width as f32, item.height as f32);
        canvas.clip_rect(Rect::from_wh(width, height), None, Some(false));
        for grid in grids
            .iter()
            .take(128)
            .filter(|grid| grid["visible"] != false)
        {
            draw_grid(canvas, grid, width, height, zoom);
        }
        canvas.restore_to_count(save);
    }
}

fn draw_grid(canvas: &Canvas, grid: &Value, width: f32, height: f32, zoom: f64) {
    let number = |key: &str, default: f32| {
        grid[key]
            .as_f64()
            .filter(|number| number.is_finite())
            .map_or(default, |number| number.clamp(0., 1e5) as f32)
    };
    let mut paint = Paint::default();
    let color = grid["color"]
        .as_str()
        .and_then(omc_style::parse_color)
        .unwrap_or(omc_style::Color {
            r: 1.,
            g: 0.,
            b: 0.,
            a: 0.1,
        });
    paint.set_color4f(Color4f::new(color.r, color.g, color.b, color.a), None);
    if grid["kind"] == "grid" {
        let step = number("size", 10.).max(1.);
        if f64::from(step) * zoom < 3. {
            return;
        }
        paint.set_stroke_width((1. / zoom.max(0.05)) as f32);
        let axes = [(width, height, false), (height, width, true)];
        for (extent, cross, horizontal) in axes {
            let count = (extent / step).floor().clamp(0., 1024.) as usize;
            for i in 1..=count {
                let at = i as f32 * step;
                let (from, to) = if horizontal {
                    ((0., at), (cross, at))
                } else {
                    ((at, 0.), (at, cross))
                };
                canvas.draw_line(from, to, &paint);
            }
        }
        return;
    }
    let columns = grid["kind"] == "columns";
    let extent = if columns { width } else { height };
    let gutter = number("gutter", 20.);
    let offset = number("offset", 0.).min(extent);
    let available = (extent - offset * 2.).max(0.);
    let align = grid["align"].as_str().unwrap_or("stretch");
    let fixed = number("size", 10.).max(1.);
    let mut count = grid["count"].as_u64().unwrap_or(5).min(256) as usize;
    if count == 0 {
        count = if align == "stretch" {
            1
        } else {
            ((available + gutter) / (fixed + gutter))
                .floor()
                .clamp(0., 256.) as usize
        };
    }
    if count == 0 {
        return;
    }
    let gaps = gutter * count.saturating_sub(1) as f32;
    let size = if align == "stretch" {
        ((available - gaps) / count as f32).max(0.)
    } else {
        fixed
    };
    let block = size * count as f32 + gaps;
    let mut at = match align {
        "center" => (extent - block) / 2.,
        "end" | "max" => extent - offset - block,
        _ => offset,
    };
    for _ in 0..count {
        let rect = if columns {
            Rect::from_xywh(at, 0., size, height)
        } else {
            Rect::from_xywh(0., at, width, size)
        };
        canvas.draw_rect(rect, &paint);
        at += size + gutter;
    }
}

pub fn draw_guides(canvas: &Canvas, scene: &Scene, origin: (f64, f64), zoom: f64, viewport: Rect) {
    let paint = Paint::new(Color4f::new(242. / 255., 72. / 255., 34. / 255., 1.), None);
    let to_screen = |(x, y): (f64, f64)| -> (f32, f32) {
        ((origin.0 + x * zoom) as f32, (origin.1 + y * zoom) as f32)
    };
    for (index, item) in scene.items.iter().enumerate() {
        let Some(guides) = item.properties.get("guides").and_then(Value::as_array) else {
            continue;
        };
        let page = index == scene.root;
        if !page {
            let mut ancestor = item.parent;
            let mut hidden = item.hidden;
            while let Some(i) = ancestor.filter(|i| *i != scene.root) {
                let parent = &scene.items[i];
                hidden |= parent.hidden
                    || (matches!(
                        parent.kind,
                        omc_model::NodeKind::Frame
                            | omc_model::NodeKind::Component
                            | omc_model::NodeKind::Instance
                    ) && parent.properties.get("primitive").and_then(Value::as_str)
                        != Some("section"));
                ancestor = parent.parent;
            }
            if hidden {
                continue;
            }
        }
        for guide in guides.iter().take(10_000) {
            let Some(offset) = guide["offset"].as_f64() else {
                continue;
            };
            let vertical = guide["vertical"].as_bool().unwrap_or(true);
            let (start, end) = if page {
                let (x, y) = to_screen((offset, offset));
                if vertical {
                    ((x, viewport.top), (x, viewport.bottom))
                } else {
                    ((viewport.left, y), (viewport.right, y))
                }
            } else {
                let (start, end) = if vertical {
                    ((offset, 0.), (offset, item.height))
                } else {
                    ((0., offset), (item.width, offset))
                };
                (
                    to_screen(item.world.point(start.0, start.1)),
                    to_screen(item.world.point(end.0, end.1)),
                )
            };
            canvas.draw_line(start, end, &paint);
        }
    }
}

pub fn board_preferences(profile: &std::path::Path) -> Value {
    std::fs::read(profile.join("native-v1/board-grid.json"))
        .ok()
        .filter(|bytes| bytes.len() < 4096)
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or(Value::Null)
}

pub fn draw_board_background(
    canvas: &Canvas,
    viewport: Rect,
    origin: (f64, f64),
    zoom: f64,
    settings: &Value,
) {
    canvas.draw_rect(
        viewport,
        &Paint::new(Color4f::new(0.984, 0.98, 0.973, 1.), None),
    );
    let style = settings["style"].as_str().unwrap_or("dots");
    if style == "none" || viewport.is_empty() {
        return;
    }
    let raw_step = settings["spacing"].as_f64().unwrap_or(24.).clamp(4., 512.) * zoom;
    if !raw_step.is_finite() || raw_step <= 0. {
        return;
    }
    let factor = (12. / raw_step).log2().ceil().max(0.).min(20.) as u32;
    let step = raw_step * 2_f64.powi(factor as i32);
    let major = settings["major"].as_u64().unwrap_or(5).clamp(2, 12) as i64;
    let contrast = settings["contrast"].as_f64().unwrap_or(1.).clamp(0.25, 4.) as f32;
    let size = settings["size"].as_f64().unwrap_or(1.).clamp(0.5, 4.) as f32;
    let mut faint = Paint::new(
        Color4f::new(0.39, 0.37, 0.32, (0.15 * contrast).min(0.7)),
        None,
    );
    faint.set_anti_alias(true).set_stroke_width(size);
    let mut dark = faint.clone();
    dark.set_alpha_f((0.32 * contrast).min(0.85));
    let start = |edge: f32, origin: f64| ((f64::from(edge) - origin) / step).ceil() as i64;
    let first_x = start(viewport.left, origin.0);
    let first_y = start(viewport.top, origin.1);
    let grid_positions = |start: i64, origin: f64, edge: f32| {
        (start..start.saturating_add(1024))
            .map(move |i| (i, (origin + i as f64 * step) as f32))
            .take_while(move |&(_, at)| at < edge)
    };
    let save = canvas.save();
    canvas.clip_rect(viewport, None, Some(false));
    if style == "dots" {
        let mut points = Vec::new();
        for (_, x) in grid_positions(first_x, origin.0, viewport.right) {
            points.extend(
                grid_positions(first_y, origin.1, viewport.bottom)
                    .map(|(_, y)| skia_safe::Point::new(x, y)),
            );
        }
        faint
            .set_stroke_width(1.5 * size)
            .set_stroke_cap(skia_safe::paint::Cap::Round);
        canvas.draw_points(skia_safe::canvas::PointMode::Points, &points, &faint);
    } else {
        for (i, x) in grid_positions(first_x, origin.0, viewport.right) {
            let paint = if style == "graph" && i.rem_euclid(major) == 0 {
                &dark
            } else {
                &faint
            };
            canvas.draw_line((x, viewport.top), (x, viewport.bottom), paint);
        }
        for (i, y) in grid_positions(first_y, origin.1, viewport.bottom) {
            let paint = if style == "graph" && i.rem_euclid(major) == 0 {
                &dark
            } else {
                &faint
            };
            canvas.draw_line((viewport.left, y), (viewport.right, y), paint);
        }
    }
    canvas.restore_to_count(save);
}
