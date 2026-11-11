use crate::{
    app::{Action, App, Control, Drag, EditTarget, FOOTER, HEADER, LEFT, RIGHT, Tool},
    geometry::Rect,
};
use omc_render::paint_scene_preview;
use skia_safe::{
    AlphaType, Canvas, Color, ColorType, Font, FontMgr, FontStyle, ImageInfo, Paint, PaintStyle,
    Rect as SkRect, Surface,
};
use std::{num::NonZeroU32, path::Path};

const INK: Color = Color::from_rgb(32, 38, 50);
const MUTED: Color = Color::from_rgb(115, 121, 134);
const LINE: Color = Color::from_rgb(226, 229, 236);
const ACCENT: Color = Color::from_rgb(97, 81, 215);

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
        Rect::new(16., 12., 142., 30.),
        "Oh My Canvas".into(),
        Action::Refresh,
        false,
        None,
    );
    add(
        11,
        Rect::new(app.width - 102., 12., 84., 30.),
        "+ New".into(),
        Action::New,
        false,
        None,
    );
    for (id, offset, label, action) in [
        (12, 260., "Import…", Action::Import),
        (13, 182., "Export…", Action::Export),
    ] {
        add(
            id,
            Rect::new(app.width - offset, 12., 72., 30.),
            label.into(),
            action,
            false,
            None,
        );
    }
    let mut x = LEFT + 12.;
    for (i, id) in app.tabs.iter().enumerate() {
        let title = app
            .snapshots
            .get(id)
            .map(|d| d.title.as_str())
            .unwrap_or("Opening…");
        add(
            100 + i as u64,
            Rect::new(x, 8., 170., 38.),
            shortened(title, 19),
            Action::Open(id.clone()),
            app.active.as_ref() == Some(id),
            None,
        );
        add(
            200 + i as u64,
            Rect::new(x + 145., 13., 20., 26.),
            "×".into(),
            Action::Close(id.clone()),
            false,
            None,
        );
        x += 178.;
        if x > app.width - 280. {
            break;
        }
    }
    for (i, tool) in [
        Tool::Select,
        Tool::Frame,
        Tool::Rect,
        Tool::Ellipse,
        Tool::Text,
        Tool::Pan,
    ]
    .iter()
    .enumerate()
    {
        add(
            20 + i as u64,
            Rect::new(LEFT + 12. + i as f64 * 78., 55., 72., 29.),
            tool.label().into(),
            Action::Tool(*tool),
            app.tool == *tool,
            None,
        );
    }
    let right = app.canvas_rect().x + app.canvas_rect().width;
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
            Rect::new(right - 192. + i as f64 * 62., 55., 58., 29.),
            label.into(),
            action,
            false,
            None,
        );
    }
    add(
        34,
        Rect::new(16., 55., 86., 29.),
        "Save".into(),
        Action::Save,
        false,
        None,
    );
    add(
        35,
        Rect::new(110., 55., 100., 29.),
        "Rename".into(),
        Action::RenameDocument,
        false,
        None,
    );
    if let Some(doc) = app.document() {
        add(
            36,
            Rect::new(90., HEADER + 10., 54., 24.),
            "+ Page".into(),
            Action::NewPage,
            false,
            None,
        );
        add(
            37,
            Rect::new(149., HEADER + 10., 65., 24.),
            "Rename".into(),
            Action::RenamePage,
            false,
            None,
        );
        let mut y = HEADER + 42.;
        for (i, page) in doc.pages.iter().enumerate() {
            add(
                300 + i as u64,
                Rect::new(12., y, LEFT - 24., 28.),
                shortened(&page.title, 24),
                Action::Page(page.id.clone()),
                app.page.as_ref() == Some(&page.id),
                None,
            );
            y += 32.;
        }
        y += 37.;
        let visible = ((app.height - FOOTER - y) / 29.).max(0.) as usize;
        for index in app
            .visible_layers
            .iter()
            .skip(app.layer_scroll)
            .take(visible)
        {
            let row = &app.layers[*index];
            let indent = (row.depth.min(7) * 12) as f64;
            let label = shortened(&row.name, 25 - row.depth.min(7));
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
                        "›"
                    } else {
                        "⌄"
                    }
                    .into(),
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
            add(
                400 + i as u64,
                Rect::new(16., HEADER + 42. + i as f64 * 36., LEFT - 32., 32.),
                shortened(&doc.title, 24),
                Action::Open(doc.id.clone()),
                false,
                None,
            );
        }
    }
    controls.extend(crate::inspector::controls(app));
    controls
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
    fill(canvas, Rect::new(0., 0., app.width, HEADER), Color::WHITE);
    fill(
        canvas,
        Rect::new(0., HEADER, LEFT, app.height - HEADER),
        Color::from_rgb(250, 251, 253),
    );
    let viewport = app.canvas_rect();
    fill(canvas, viewport, Color::from_rgb(239, 241, 245));
    if app.width >= 1050. {
        fill(
            canvas,
            Rect::new(app.width - RIGHT, HEADER, RIGHT, app.height - HEADER),
            Color::from_rgb(250, 251, 253),
        );
    }
    fill(canvas, Rect::new(0., HEADER - 1., app.width, 1.), LINE);
    fill(
        canvas,
        Rect::new(LEFT - 1., HEADER, 1., app.height - HEADER),
        LINE,
    );
    if app.width >= 1050. {
        fill(
            canvas,
            Rect::new(app.width - RIGHT, HEADER, 1., app.height - HEADER),
            LINE,
        );
    }
    text(
        canvas,
        if app.active.is_some() {
            "PAGES"
        } else {
            "YOUR DOCUMENTS"
        },
        16.,
        HEADER + 27.,
        11.,
        MUTED,
        &font,
    );
    if let Some(doc) = app.document() {
        text(
            canvas,
            "LAYERS",
            16.,
            HEADER + 77. + doc.pages.len() as f64 * 32.,
            11.,
            MUTED,
            &font,
        );
    }
    if app.width >= 1050. {
        text(
            canvas,
            "DESIGN",
            app.width - RIGHT + 16.,
            HEADER + 27.,
            11.,
            MUTED,
            &font,
        );
        if let Some(node) = app.node() {
            text(
                canvas,
                &format!("{:?}", node.kind),
                app.width - RIGHT + 16.,
                HEADER + 84.,
                12.,
                INK,
                &font,
            );
        } else {
            text(
                canvas,
                "Select a layer to edit",
                app.width - RIGHT + 16.,
                HEADER + 72.,
                13.,
                MUTED,
                &font,
            );
        }
    }
    canvas.save();
    canvas.clip_rect(rect(viewport), None, Some(false));
    if let Some(scene) = &app.scene {
        canvas.translate((viewport.x as f32, viewport.y as f32));
        canvas.translate((app.camera.x as f32, app.camera.y as f32));
        canvas.scale((app.camera.zoom as f32, app.camera.zoom as f32));
        if let Err(error) =
            paint_scene_preview(canvas, scene, &app.resources, &app.drag_translations())
        {
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
                    p.set_color(Color::from_argb(120, 151, 139, 236));
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
                    fill(canvas, r, Color::from_argb(30, 97, 81, 215));
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
    for control in &app.controls {
        let color = if control.selected {
            Color::from_rgb(235, 232, 255)
        } else if control.field_value.is_some() {
            Color::WHITE
        } else {
            Color::from_rgb(246, 247, 250)
        };
        round(canvas, control.rect, color, 6.);
        if app.focus == control.id {
            stroke(canvas, control.rect, ACCENT, 1.);
        }
        if let Some(value) = &control.field_value {
            text(
                canvas,
                &control.label,
                control.rect.x,
                control.rect.y - 7.,
                11.,
                MUTED,
                &font,
            );
            let value = app
                .editing
                .as_ref()
                .and_then(|edit| {
                    if let EditTarget::Property { property, .. } = &edit.target
                        && let Action::Field(p) = &control.action
                        && p == property
                    {
                        return Some(edit.buffer.display_text());
                    }
                    None
                })
                .unwrap_or_else(|| value.clone());
            text(
                canvas,
                &shortened(&value, 25),
                control.rect.x + 10.,
                control.rect.y + 23.,
                13.,
                INK,
                &font,
            );
        } else {
            text(
                canvas,
                &control.label,
                control.rect.x + 10.,
                control.rect.y + control.rect.height * 0.5 + 4.5,
                if control.id == 10 { 15. } else { 12. },
                if control.selected { ACCENT } else { INK },
                &font,
            );
        }
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
    text(
        canvas,
        &app.status,
        15.,
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
    if let Some(doc) = app.document() {
        text(
            canvas,
            &format!("{} layers · revision {}", doc.nodes.len(), doc.sequence),
            LEFT + 14.,
            app.height - 10.,
            11.,
            MUTED,
            &font,
        );
    }
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
