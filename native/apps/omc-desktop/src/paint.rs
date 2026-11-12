use crate::{
    app::{Action, App, Control, Drag, EditTarget, FOOTER, HEADER, LEFT, RIGHT, Tool},
    geometry::Rect,
    scene_cache::SceneCacheKey,
};
use omc_render::paint_scene_preview;
use skia_safe::{
    AlphaType, Canvas, Color, ColorType, Font, FontMgr, FontStyle, ImageInfo, Paint, PaintStyle,
    Rect as SkRect, Surface,
};
use std::{num::NonZeroU32, path::Path};

const INK: Color = Color::from_rgb(32, 33, 36);
const MUTED: Color = Color::from_rgb(106, 106, 106);
const LINE: Color = Color::from_rgb(229, 229, 229);
const ACCENT: Color = Color::from_rgb(37, 99, 235);
const SELECTED: Color = Color::from_rgb(239, 246, 255);
const SELECTED_INK: Color = Color::from_rgb(30, 64, 175);
const WORKSPACE: Color = Color::from_rgb(245, 245, 245);
const FILE_ACTIONS: [(u64, f64, &str, Action); 4] = [
    (12, 76., "Import…", Action::Import),
    (13, 76., "Export…", Action::Export),
    (34, 62., "Save", Action::Save),
    (11, 72., "+ New", Action::New),
];
const TOOLS: [Tool; 6] = [
    Tool::Select,
    Tool::Frame,
    Tool::Rect,
    Tool::Ellipse,
    Tool::Text,
    Tool::Pan,
];
const TAB_START: f64 = LEFT + 10.;
const TAB_MAX: f64 = 168.;
const TAB_MIN: f64 = 92.;
const TAB_GAP: f64 = 4.;
const STRIP_GAP: f64 = 8.;

fn file_actions_x(width: f64) -> f64 {
    width
        - 16.
        - FILE_ACTIONS
            .iter()
            .map(|(_, w, _, _)| w + STRIP_GAP)
            .sum::<f64>()
        + STRIP_GAP
}

fn tab_rects(width: f64, count: usize, active: usize) -> impl Iterator<Item = (usize, Rect, Rect)> {
    let available = (file_actions_x(width) - STRIP_GAP - TAB_START).max(0.);
    let capacity = ((available + TAB_GAP) / (TAB_MIN + TAB_GAP)) as usize;
    let visible = count.min(capacity);
    let start = active.saturating_add(1).saturating_sub(visible);
    let tab_width = ((available + TAB_GAP) / visible.max(1) as f64 - TAB_GAP).min(TAB_MAX);
    (start..start + visible).enumerate().map(move |(i, index)| {
        let x = TAB_START + i as f64 * (tab_width + TAB_GAP);
        (
            index,
            Rect::new(x, 8., tab_width - 30., 36.),
            Rect::new(x + tab_width - 30., 8., 30., 36.),
        )
    })
}

fn palette(viewport: Rect) -> Option<Rect> {
    let width = (viewport.width - 24.).min(316.);
    if width < 168. || viewport.height < 140. {
        return None;
    }
    Some(Rect::new(
        viewport.x + (viewport.width - width) * 0.5,
        viewport.y + viewport.height - 62.,
        width,
        48.,
    ))
}

fn palette_tools(palette: Rect) -> impl Iterator<Item = (usize, Tool, Rect)> {
    let width = (palette.width - 12.) / TOOLS.len() as f64;
    TOOLS.into_iter().enumerate().map(move |(index, tool)| {
        (
            index,
            tool,
            Rect::new(
                palette.x + 6. + index as f64 * width,
                palette.y + 6.,
                width,
                36.,
            ),
        )
    })
}

pub fn palette_rect(app: &App) -> Option<Rect> {
    if app
        .editing
        .as_ref()
        .is_some_and(|edit| !matches!(edit.target, EditTarget::Property { .. }))
    {
        return None;
    }
    app.document()?;
    palette(app.canvas_rect())
}

fn layers_heading(app: &App) -> f64 {
    let pages = app.document().map_or(0, |doc| doc.pages.len());
    HEADER + 84. + pages as f64 * 29.
}

fn rect(r: Rect) -> SkRect {
    SkRect::from_xywh(r.x as f32, r.y as f32, r.width as f32, r.height as f32)
}
fn fill(canvas: &Canvas, r: Rect, color: Color) {
    let mut p = Paint::default();
    p.set_color(color);
    canvas.draw_rect(rect(r), &p);
}
fn round(canvas: &Canvas, r: Rect, color: Color, radius: f32) {
    let mut p = Paint::default();
    p.set_color(color);
    p.set_anti_alias(true);
    canvas.draw_round_rect(rect(r), radius, radius, &p);
}
fn stroke(canvas: &Canvas, r: Rect, color: Color, width: f32) {
    let mut p = Paint::default();
    p.set_color(color);
    p.set_anti_alias(true);
    p.set_style(PaintStyle::Stroke);
    p.set_stroke_width(width);
    canvas.draw_rect(rect(r), &p);
}
fn text(canvas: &Canvas, body: &str, x: f64, y: f64, size: f32, color: Color, font: &Font) {
    if !body.is_ascii()
        && let Some(layout) = crate::text_ui::layout(body, size, color, 10000.)
    {
        layout.paint(canvas, x, y - layout.alphabetic_baseline);
        return;
    }
    let mut p = Paint::default();
    p.set_color(color);
    p.set_anti_alias(true);
    let mut f = font.clone();
    f.set_size(size);
    canvas.draw_str(body, (x as f32, y as f32), &f, &p);
}
fn shortened(s: &str, n: usize) -> String {
    let mut result: String = s.chars().take(n).collect();
    if s.chars().count() > n {
        result.push('…');
    }
    result
}

pub fn controls(app: &App) -> Vec<Control> {
    let mut controls = vec![];
    let mut add =
        |id: u64, r: Rect, label: String, action: Action, selected: bool, value: Option<String>| {
            controls.push(Control {
                id,
                rect: r,
                label,
                action,
                selected,
                field_value: value,
            })
        };
    add(
        10,
        Rect::new(76., 8., 142., 36.),
        "Oh My Canvas".into(),
        Action::Refresh,
        false,
        None,
    );
    let mut x = file_actions_x(app.width);
    for (id, width, label, action) in FILE_ACTIONS {
        add(
            id,
            Rect::new(x, 9., width, 34.),
            label.into(),
            action,
            false,
            None,
        );
        x += width + STRIP_GAP;
    }
    let active = app
        .tabs
        .iter()
        .position(|id| Some(id) == app.active.as_ref())
        .unwrap_or(0);
    // shortcut: the strip keeps the active tab visible, add explicit overflow navigation for crowded sessions.
    for (index, open, close) in tab_rects(app.width, app.tabs.len(), active) {
        let id = &app.tabs[index];
        let title = app
            .snapshots
            .get(id)
            .map(|d| d.title.as_str())
            .unwrap_or("Opening…");
        let selected = Some(id) == app.active.as_ref();
        add(
            100 + index as u64,
            open,
            title.into(),
            Action::Open(id.clone()),
            selected,
            None,
        );
        add(
            200 + index as u64,
            close,
            format!("Close {title}"),
            Action::Close(id.clone()),
            selected,
            None,
        );
    }
    if let Some(palette) = palette_rect(app) {
        for (index, tool, rect) in palette_tools(palette) {
            add(
                20 + index as u64,
                rect,
                tool.label().into(),
                Action::Tool(tool),
                app.tool == tool,
                None,
            );
        }
    }
    if app.active.is_some() {
        let viewport = app.canvas_rect();
        let right = viewport.x + viewport.width;
        for (i, (label, action)) in [
            ("Undo", Action::Undo),
            ("Redo", Action::Redo),
            ("Fit", Action::Fit),
        ]
        .into_iter()
        .enumerate()
        {
            add(
                30 + i as u64,
                Rect::new(right - 167. + i as f64 * 51., viewport.y + 10., 47., 28.),
                label.into(),
                action,
                false,
                None,
            );
        }
    }
    if let Some(doc) = app.document() {
        add(
            35,
            Rect::new(12., HEADER + 8., LEFT - 24., 34.),
            format!("Rename {}", doc.title),
            Action::RenameDocument,
            false,
            None,
        );
        add(
            36,
            Rect::new(78., HEADER + 51., 66., 24.),
            "+ Page".into(),
            Action::NewPage,
            false,
            None,
        );
        add(
            37,
            Rect::new(149., HEADER + 51., 65., 24.),
            "Rename".into(),
            Action::RenamePage,
            false,
            None,
        );
        let mut y = HEADER + 82.;
        for (i, page) in doc.pages.iter().enumerate() {
            if y + 26. > app.height - FOOTER {
                break;
            }
            add(
                300 + i as u64,
                Rect::new(12., y, LEFT - 24., 26.),
                page.title.clone(),
                Action::Page(page.id.clone()),
                app.page.as_ref() == Some(&page.id),
                None,
            );
            y += 29.;
        }
        y = layers_heading(app) + 29.;
        let visible = ((app.height - FOOTER - y) / 29.).max(0.) as usize;
        for index in app
            .visible_layers
            .iter()
            .skip(app.layer_scroll)
            .take(visible)
        {
            let row = &app.layers[*index];
            let indent = (row.depth.min(7) * 12) as f64;
            let label = row.name.clone();
            add(
                1000 + *index as u64,
                Rect::new(30. + indent, y, LEFT - 42. - indent, 27.),
                label,
                Action::Layer(row.id.clone()),
                app.selected.contains(&row.id),
                None,
            );
            if row.has_children {
                add(
                    1_000_000 + *index as u64,
                    Rect::new(10. + indent, y, 20., 27.),
                    if app.collapsed.contains(&row.id) {
                        format!("Expand {}", row.name)
                    } else {
                        format!("Collapse {}", row.name)
                    },
                    Action::ToggleLayer(row.id.clone()),
                    false,
                    None,
                );
            }
            y += 29.;
        }
    } else {
        for (i, doc) in app
            .documents
            .iter()
            .filter(|d| !d.archived)
            .take(15)
            .enumerate()
        {
            let y = HEADER + 42. + i as f64 * 36.;
            if y + 32. > app.height - FOOTER {
                break;
            }
            add(
                400 + i as u64,
                Rect::new(16., y, LEFT - 32., 32.),
                doc.title.clone(),
                Action::Open(doc.id.clone()),
                false,
                None,
            );
        }
    }
    controls.extend(crate::inspector::controls(app));
    controls
}

fn control_text(
    canvas: &Canvas,
    bounds: Rect,
    body: &str,
    padding: f64,
    baseline: f64,
    size: f32,
    color: Color,
    font: &Font,
) {
    let width = bounds.width - padding * 2.;
    if width <= 0. {
        return;
    }
    let mut font_at_size = font.clone();
    font_at_size.set_size(size);
    let width_of = |value: &str| {
        if value.is_ascii() {
            font_at_size.measure_str(value, None).0 as f64
        } else {
            value
                .chars()
                .map(|c| if c.is_ascii() { 0.55 } else { 1. })
                .sum::<f64>()
                * f64::from(size)
        }
    };
    let shortened;
    let max_chars = (width / f64::from(size) * 4.).ceil() as usize;
    let limit = body
        .char_indices()
        .nth(max_chars)
        .map_or(body.len(), |(i, _)| i);
    let label = if limit < body.len() || width_of(body) > width {
        let mut end = 0;
        for (index, _) in body[..limit].char_indices().rev() {
            end = index;
            if width_of(&body[..end]) + f64::from(size) <= width {
                break;
            }
        }
        shortened = format!("{}…", &body[..end]);
        &shortened
    } else {
        body
    };
    canvas.save();
    canvas.clip_rect(rect(bounds), None, false);
    text(
        canvas,
        label,
        bounds.x + padding,
        baseline,
        size,
        color,
        font,
    );
    canvas.restore();
}

fn draw_tool_icon(canvas: &Canvas, tool: Tool, bounds: Rect, color: Color) {
    let cx = (bounds.x + bounds.width / 2.) as f32;
    let cy = (bounds.y + bounds.height / 2.) as f32;
    let mut p = Paint::default();
    p.set_color(color);
    p.set_anti_alias(true);
    p.set_stroke_width(1.5);
    p.set_stroke_cap(skia_safe::paint::Cap::Round);
    let line = |x1, y1, x2, y2| canvas.draw_line((cx + x1, cy + y1), (cx + x2, cy + y2), &p);
    match tool {
        Tool::Select => {
            line(-6., -8., -6., 7.);
            line(-6., -8., 7., 2.);
            line(-6., 7., -1., 2.);
            line(-1., 2., 7., 2.);
            line(-1., 2., 3., 8.);
        }
        Tool::Frame => {
            for offset in [-4., 4.] {
                line(offset, -8., offset, 8.);
                line(-8., offset, 8., offset);
            }
        }
        Tool::Rect => {
            stroke(
                canvas,
                Rect::new(f64::from(cx) - 7., f64::from(cy) - 7., 14., 14.),
                color,
                1.5,
            );
        }
        Tool::Ellipse => {
            p.set_style(PaintStyle::Stroke);
            canvas.draw_circle((cx, cy), 7., &p);
        }
        Tool::Text => {
            line(-7., -6., 7., -6.);
            line(0., -6., 0., 7.);
            line(-3., 7., 3., 7.);
        }
        Tool::Pan => {
            line(-8., 0., 8., 0.);
            line(0., -8., 0., 8.);
            for direction in [-1., 1.] {
                for side in [-1., 1.] {
                    line(8. * direction, 0., 5. * direction, 3. * side);
                    line(0., 8. * direction, 3. * side, 5. * direction);
                }
            }
        }
    }
}

fn draw_control(canvas: &Canvas, app: &App, control: &Control, font: &Font) {
    let r = control.rect;
    let hovered = r.contains(app.cursor.0, app.cursor.1);
    let tab = r.y < HEADER && matches!(control.action, Action::Open(_) | Action::Close(_));
    let close = matches!(control.action, Action::Close(_));
    let disclosure = matches!(control.action, Action::ToggleLayer(_));
    let tool = match control.action {
        Action::Tool(tool) => Some(tool),
        _ => None,
    };
    let background = if control.selected && tool.is_some() || control.id == 11 {
        Some(ACCENT)
    } else if tab && control.selected && !hovered {
        Some(Color::WHITE)
    } else if control.selected {
        Some(SELECTED)
    } else if hovered || control.field_value.is_some() || matches!(control.id, 30..=32) {
        Some(if matches!(control.id, 30..=32) && !hovered {
            Color::WHITE
        } else {
            WORKSPACE
        })
    } else {
        None
    };
    if let Some(color) = background {
        if tab && control.selected && !hovered {
            fill(canvas, r, color);
        } else {
            round(canvas, r, color, 7.);
        }
    }
    if app.focus == control.id {
        stroke(
            canvas,
            Rect::new(r.x + 1., r.y + 1., r.width - 2., r.height - 2.),
            if background == Some(ACCENT) {
                Color::WHITE
            } else {
                ACCENT
            },
            1.5,
        );
    }

    if let Some(tool) = tool {
        draw_tool_icon(
            canvas,
            tool,
            r,
            if control.selected { Color::WHITE } else { INK },
        );
        return;
    }
    if close || disclosure {
        let cx = (r.x + r.width / 2.) as f32;
        let cy = (r.y + r.height / 2.) as f32;
        let mut p = Paint::default();
        p.set_color(MUTED);
        p.set_anti_alias(true);
        p.set_stroke_width(1.25);
        if close {
            canvas.draw_line((cx - 3., cy - 3.), (cx + 3., cy + 3.), &p);
            canvas.draw_line((cx + 3., cy - 3.), (cx - 3., cy + 3.), &p);
        } else if matches!(&control.action, Action::ToggleLayer(id) if app.collapsed.contains(id)) {
            canvas.draw_line((cx - 2., cy - 4.), (cx + 2., cy), &p);
            canvas.draw_line((cx + 2., cy), (cx - 2., cy + 4.), &p);
        } else {
            canvas.draw_line((cx - 4., cy - 2.), (cx, cy + 2.), &p);
            canvas.draw_line((cx, cy + 2.), (cx + 4., cy - 2.), &p);
        }
        return;
    }
    if let Some(value) = &control.field_value {
        control_text(
            canvas,
            Rect::new(r.x, r.y - 18., r.width, 16.),
            &control.label,
            0.,
            r.y - 6.,
            11.,
            MUTED,
            font,
        );
        if !matches!(
            (&app.editing, &control.action),
            (Some(edit), Action::Field(property))
                if matches!(&edit.target, EditTarget::Property { property: current, .. } if current == property)
        ) {
            control_text(canvas, r, value, 9., r.y + 21., 13., INK, font);
        }
        return;
    }
    let label = if control.id == 35 {
        control
            .label
            .strip_prefix("Rename ")
            .unwrap_or(&control.label)
    } else {
        &control.label
    };
    let label_color = if control.id == 11 {
        Color::WHITE
    } else if control.selected {
        SELECTED_INK
    } else {
        INK
    };
    control_text(
        canvas,
        r,
        label,
        if matches!(control.id, 10 | 35) {
            4.
        } else {
            8.
        },
        r.y + r.height * 0.5 + 4.,
        if matches!(control.id, 10 | 35) {
            14.
        } else {
            12.
        },
        label_color,
        font,
    );
}

fn selection_dimensions(canvas: &Canvas, app: &App, viewport: Rect, font: &Font) {
    if app.selected.len() != 1
        || app.drag.is_some()
        || app.editing.is_some()
        || viewport.width < 100.
        || viewport.height < 30.
    {
        return;
    }
    let Some([x, y, width, height]) = app
        .selected
        .iter()
        .next()
        .and_then(|id| app.scene.as_ref()?.bounds(id))
    else {
        return;
    };
    let left = viewport.x + app.camera.x + x * app.camera.zoom;
    let top = viewport.y + app.camera.y + y * app.camera.zoom;
    let right = left + width * app.camera.zoom;
    let bottom = top + height * app.camera.zoom;
    if right < viewport.x
        || left > viewport.x + viewport.width
        || bottom < viewport.y
        || top > viewport.y + viewport.height
    {
        return;
    }
    let label = format!("{width:.0} × {height:.0}");
    let badge_width = (label.chars().count() as f64 * 7.4 + 14.).min(viewport.width - 8.);
    let badge_top = if bottom + 26. < viewport.y + viewport.height {
        bottom + 6.
    } else {
        top - 25.
    };
    let r = Rect::new(
        ((left + right - badge_width) * 0.5).clamp(
            viewport.x + 4.,
            viewport.x + viewport.width - badge_width - 4.,
        ),
        badge_top.clamp(viewport.y + 4., viewport.y + viewport.height - 23.),
        badge_width,
        19.,
    );
    round(canvas, r, ACCENT, 4.);
    control_text(canvas, r, &label, 7., r.y + 13., 11., Color::WHITE, font);
}

fn render(app: &App, width: u32, height: u32, scale: f64) -> Result<Surface, String> {
    if width == 0 || height == 0 || u64::from(width) * u64::from(height) > 33_554_432 {
        return Err("The window surface is outside its 128 MiB budget.".into());
    }
    let mut surface = skia_safe::surfaces::raster_n32_premul((width as i32, height as i32))
        .ok_or("Could not allocate a native drawing surface.")?;
    let canvas = surface.canvas();
    canvas.scale((scale as f32, scale as f32));
    canvas.clear(Color::WHITE);
    let font_manager = FontMgr::default();
    let typeface = font_manager
        .match_family_style("sans-serif", FontStyle::normal())
        .or_else(|| font_manager.legacy_make_typeface(None, FontStyle::normal()))
        .ok_or("No native UI font is available.")?;
    let font = Font::from_typeface(typeface, 13.);
    fill(canvas, Rect::new(0., 0., app.width, HEADER), WORKSPACE);
    let viewport = app.canvas_rect();
    fill(canvas, viewport, WORKSPACE);
    fill(canvas, Rect::new(0., HEADER - 1., app.width, 1.), LINE);
    fill(
        canvas,
        Rect::new(LEFT - 1., HEADER, 1., app.height - HEADER),
        LINE,
    );
    if app.inspector_visible() {
        fill(
            canvas,
            Rect::new(app.width - RIGHT, HEADER, 1., app.height - HEADER),
            LINE,
        );
    }
    if app.document().is_some() {
        fill(canvas, Rect::new(0., HEADER + 46., LEFT - 1., 1.), LINE);
        text(canvas, "Pages", 16., HEADER + 67., 12., INK, &font);
        let heading = layers_heading(app);
        if heading + 18. < app.height - FOOTER {
            fill(canvas, Rect::new(0., heading, LEFT - 1., 1.), LINE);
            text(canvas, "Layers", 16., heading + 19., 12., INK, &font);
        }
    } else {
        text(canvas, "Your documents", 16., HEADER + 27., 13., INK, &font);
    }
    if app.inspector_visible() && app.document().is_some() {
        let panel_x = app.width - RIGHT;
        let x = panel_x + 16.;
        fill(
            canvas,
            Rect::new(panel_x + 1., HEADER + 52., RIGHT - 1., 1.),
            LINE,
        );
        if let Some(node) = app.node() {
            text(
                canvas,
                &format!("{:?}", node.kind),
                x,
                HEADER + 75.,
                14.,
                INK,
                &font,
            );
            let section = match app.inspector {
                crate::app::Inspector::Design => "Properties",
                crate::app::Inspector::Text => "Typography",
                crate::app::Inspector::Assets => "Styles and tokens",
            };
            text(canvas, section, x, HEADER + 102., 12., MUTED, &font);
        } else if app.inspector != crate::app::Inspector::Assets {
            text(
                canvas,
                "Select a layer to edit",
                x,
                HEADER + 75.,
                13.,
                MUTED,
                &font,
            );
        }
    }
    canvas.save();
    canvas.clip_rect(rect(viewport), None, Some(false));
    if let Some(scene) = &app.scene {
        let translations = app.drag_translations();
        let paint = |canvas: &Canvas| {
            paint_scene_preview(canvas, scene, &app.resources, &translations).map(|_| ())
        };
        let cached = if matches!(app.drag, Some(Drag::Move { .. })) || !translations.is_empty() {
            None
        } else {
            let mut cache = app.scene_cache.borrow_mut();
            match SceneCacheKey::new(app.scene_generation, viewport, scale, app.camera) {
                Some(key) => Some(cache.paint(canvas, key, WORKSPACE, paint)),
                None => {
                    cache.clear();
                    None
                }
            }
        };
        canvas.translate((viewport.x as f32, viewport.y as f32));
        canvas.translate((app.camera.x as f32, app.camera.y as f32));
        canvas.scale((app.camera.zoom as f32, app.camera.zoom as f32));
        if let Err(error) = cached.unwrap_or_else(|| paint(canvas)) {
            text(
                canvas,
                &format!("Some content could not be rendered: {error}"),
                12.,
                20.,
                13.,
                Color::RED,
                &font,
            );
        }
        let line_width = (1.5 / app.camera.zoom) as f32;
        for id in &app.selected {
            if let Some([x, y, w, h]) = scene.bounds(id) {
                stroke(canvas, Rect::new(x, y, w, h), ACCENT, line_width);
                if app.selected.len() != 1
                    || scene.item(id).is_none_or(|item| {
                        item.locked
                            || item.world.0[1].abs() > 1e-8
                            || item.world.0[2].abs() > 1e-8
                            || item.world.0[0] <= 0.
                            || item.world.0[3] <= 0.
                    })
                {
                    continue;
                }
                let d = 5. / app.camera.zoom;
                for (cx, cy) in [(x, y), (x + w, y), (x, y + h), (x + w, y + h)] {
                    fill(
                        canvas,
                        Rect::new(cx - d * 0.5, cy - d * 0.5, d, d),
                        Color::WHITE,
                    );
                    stroke(
                        canvas,
                        Rect::new(cx - d * 0.5, cy - d * 0.5, d, d),
                        ACCENT,
                        line_width,
                    );
                }
            }
        }
        if let Some(drag) = &app.drag {
            match drag {
                Drag::Resize { id, preview, .. } => {
                    let parent = scene
                        .item(id)
                        .and_then(|item| item.parent)
                        .map(|p| scene.items[p].world)
                        .unwrap_or(omc_scene::Affine::IDENTITY);
                    let b = parent
                        .multiply(omc_scene::Affine::translation(preview[0], preview[1]))
                        .bounds(preview[2], preview[3]);
                    stroke(
                        canvas,
                        Rect::new(b[0], b[1], b[2], b[3]),
                        ACCENT,
                        (1.5 / app.camera.zoom) as f32,
                    );
                }
                Drag::Move {
                    delta, positions, ..
                } => {
                    for (id, _, _) in positions {
                        if let Some([x, y, w, h]) = scene.bounds(id) {
                            stroke(
                                canvas,
                                Rect::new(x + delta.0, y + delta.1, w, h),
                                ACCENT,
                                line_width,
                            );
                        }
                    }
                }
                Drag::Draw { origin, end, tool } => {
                    let r = Rect::new(
                        origin.0.min(end.0),
                        origin.1.min(end.1),
                        (end.0 - origin.0).abs(),
                        (end.1 - origin.1).abs(),
                    );
                    let mut p = Paint::default();
                    p.set_anti_alias(true);
                    p.set_color(Color::from_argb(60, 37, 99, 235));
                    if *tool == Tool::Ellipse {
                        canvas.draw_oval(rect(r), &p);
                    } else {
                        canvas.draw_rect(rect(r), &p);
                    }
                    stroke(canvas, r, ACCENT, line_width);
                }
                Drag::Marquee { origin, end } => {
                    let r = Rect::new(
                        origin.0.min(end.0),
                        origin.1.min(end.1),
                        (end.0 - origin.0).abs(),
                        (end.1 - origin.1).abs(),
                    );
                    fill(canvas, r, Color::from_argb(30, 37, 99, 235));
                    stroke(canvas, r, ACCENT, line_width);
                }
                Drag::Pan { .. } | Drag::TextSelection => {}
            }
        }
    } else {
        let middle = viewport.x + viewport.width * 0.5;
        text(
            canvas,
            if app.active.is_some() {
                "Preparing canvas…"
            } else {
                "Create a document to start designing"
            },
            middle - 150.,
            viewport.y + viewport.height * 0.43,
            18.,
            INK,
            &font,
        );
        text(
            canvas,
            "Your work stays on this device",
            middle - 105.,
            viewport.y + viewport.height * 0.43 + 32.,
            13.,
            MUTED,
            &font,
        );
    }
    canvas.restore();
    selection_dimensions(canvas, app, viewport, &font);
    if let Some(r) = palette_rect(app) {
        round(
            canvas,
            Rect::new(r.x - 1., r.y + 2., r.width + 2., r.height + 1.),
            Color::from_argb(20, 0, 0, 0),
            13.,
        );
        round(canvas, r, LINE, 12.);
        round(
            canvas,
            Rect::new(r.x + 1., r.y + 1., r.width - 2., r.height - 2.),
            Color::WHITE,
            11.,
        );
    }
    for control in &app.controls {
        draw_control(canvas, app, control, &font);
    }
    if let Some(edit) = &app.editing {
        if !matches!(edit.target, EditTarget::Property { .. }) {
            let r = Rect::new(
                viewport.x + 24.,
                viewport.y + viewport.height - 118.,
                (viewport.width - 48.).max(100.),
                88.,
            );
            round(canvas, r, Color::WHITE, 8.);
            stroke(canvas, r, ACCENT, 1.5);
            text(
                canvas,
                match &edit.target {
                    EditTarget::Title => "DOCUMENT NAME · Enter to save",
                    EditTarget::Page { .. } => "PAGE NAME · Enter to save",
                    EditTarget::Catalog { property, .. } if property == "name" => {
                        "STYLE / TOKEN NAME · Enter to save"
                    }
                    EditTarget::Catalog { .. } => "STYLE / TOKEN COLOR · Enter to save",
                    _ => "EDIT TEXT · Enter to save · Shift+Enter for a new line",
                },
                r.x + 13.,
                r.y + 21.,
                10.,
                MUTED,
                &font,
            );
            if let Some(area) = crate::text_ui::editor_rect(app)
                && let Some(prepared) = crate::text_ui::prepare(&edit.buffer, area, 18.)
            {
                prepared.paint(canvas, area);
            }
            if !edit.buffer.preedit.is_empty() {
                text(
                    canvas,
                    "Composing…",
                    r.x + 13.,
                    r.y + 75.,
                    11.,
                    ACCENT,
                    &font,
                );
            }
        } else if let Some(area) = crate::text_ui::editor_rect(app) {
            fill(canvas, area, Color::WHITE);
            if let Some(prepared) = crate::text_ui::prepare(&edit.buffer, area, 13.) {
                prepared.paint(canvas, area);
            }
        }
    }
    if let Some(message) = &app.error {
        let r = Rect::new(
            viewport.x + 20.,
            HEADER + 14.,
            (viewport.width - 40.).max(100.),
            if app.recovery_text.is_some() {
                76.
            } else {
                50.
            },
        );
        round(canvas, r, Color::from_rgb(255, 237, 232), 8.);
        text(
            canvas,
            &shortened(message, 110),
            r.x + 12.,
            r.y + 24.,
            12.,
            Color::from_rgb(155, 52, 36),
            &font,
        );
        if let Some(recovery) = &app.recovery_text {
            text(
                canvas,
                &format!("Unsaved text kept: {}", shortened(recovery, 70)),
                r.x + 12.,
                r.y + 52.,
                12.,
                INK,
                &font,
            );
        }
    }
    fill(
        canvas,
        Rect::new(0., app.height - FOOTER, app.width, FOOTER),
        Color::WHITE,
    );
    fill(
        canvas,
        Rect::new(0., app.height - FOOTER, app.width, 1.),
        LINE,
    );
    control_text(
        canvas,
        Rect::new(15., app.height - FOOTER, (app.width - 100.).max(0.), FOOTER),
        &app.status,
        0.,
        app.height - 10.,
        11.,
        if app.pending { ACCENT } else { MUTED },
        &font,
    );
    text(
        canvas,
        &format!("{:.0}%", app.camera.zoom * 100.),
        app.width - 68.,
        app.height - 10.,
        11.,
        MUTED,
        &font,
    );
    Ok(surface)
}

pub fn draw(app: &mut App) -> Result<(), String> {
    let Some(window) = app.window.as_ref().cloned() else {
        return Ok(());
    };
    let size = window.inner_size();
    if size.width == 0 || size.height == 0 {
        return Ok(());
    }
    app.controls = controls(app);
    let mut raster = render(app, size.width, size.height, window.scale_factor())?;
    let mut pixels = vec![0u8; size.width as usize * size.height as usize * 4];
    let info = ImageInfo::new(
        (size.width as i32, size.height as i32),
        ColorType::RGBA8888,
        AlphaType::Unpremul,
        None,
    );
    if !raster.read_pixels(&info, &mut pixels, size.width as usize * 4, (0, 0)) {
        return Err("Could not read the native drawing surface.".into());
    }
    let Some(surface) = &mut app.surface else {
        return Ok(());
    };
    surface
        .resize(
            NonZeroU32::new(size.width).ok_or("Empty width")?,
            NonZeroU32::new(size.height).ok_or("Empty height")?,
        )
        .map_err(|e| e.to_string())?;
    let mut buffer = surface.buffer_mut().map_err(|e| e.to_string())?;
    for (out, rgba) in buffer.iter_mut().zip(pixels.chunks_exact(4)) {
        *out = u32::from(rgba[2]) | (u32::from(rgba[1]) << 8) | (u32::from(rgba[0]) << 16);
    }
    buffer.present().map_err(|e| e.to_string())?;
    app.presented = true;
    Ok(())
}
pub fn screenshot(app: &App, path: &Path) -> Result<(), String> {
    let window = app.window.as_ref().ok_or("No native window")?;
    let size = window.inner_size();
    let mut surface = render(app, size.width, size.height, window.scale_factor())?;
    let image = surface.image_snapshot();
    let bytes = image
        .encode(None, skia_safe::EncodedImageFormat::PNG, None)
        .ok_or("PNG encoding failed")?;
    std::fs::write(path, bytes.as_bytes()).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strip_and_tools_fit_compact_and_standard_windows() {
        for (width, height) in [(960., 640.), (1440., 900.)] {
            let file_start = file_actions_x(width);
            let visible: Vec<_> = tab_rects(width, 10, 8).collect();
            assert!(visible.iter().any(|(index, _, _)| *index == 8));
            let mut previous_end = TAB_START;
            for (_, open, close) in visible {
                assert!(open.x >= previous_end);
                assert!(open.x + open.width <= close.x);
                previous_end = close.x + close.width;
                assert!(previous_end + STRIP_GAP <= file_start);
                assert!(close.y + close.height <= HEADER);
            }

            let view = Rect::new(LEFT, HEADER, width - LEFT - RIGHT, height - HEADER - FOOTER);
            let palette = palette(view).unwrap();
            assert!(palette.x >= view.x && palette.x + palette.width <= view.x + view.width);
            assert!(palette.y + palette.height <= view.y + view.height);
            let mut previous_end = palette.x;
            assert_eq!(palette_tools(palette).count(), 6);
            for (_, _, tool) in palette_tools(palette) {
                assert!(tool.x + 1e-9 >= previous_end);
                assert!(tool.y >= palette.y && tool.y + tool.height <= palette.y + palette.height);
                previous_end = tool.x + tool.width;
                assert!(previous_end <= palette.x + palette.width);
            }
        }
    }
}
