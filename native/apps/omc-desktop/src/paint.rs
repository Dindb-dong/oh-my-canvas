use crate::{
    app::{
        Action, App, Control, Drag, EditTarget, FOOTER, HEADER, Inspector, LEFT, Popup, RIGHT, Tool,
    },
    figcraft_chrome::{self, RAIL_WIDTH, RailItem},
    geometry::Rect,
    scene_cache::SceneCacheKey,
    tab_strip,
};
use omc_render::paint_scene_preview;
use skia_safe::{
    Canvas, Color, ColorType, Font, FontMgr, FontStyle, Paint, PaintStyle, Rect as SkRect, Surface,
};
use std::{num::NonZeroU32, path::Path};

const INK: Color = Color::from_rgb(32, 32, 32);
const MUTED: Color = Color::from_rgb(115, 115, 115);
const LINE: Color = Color::from_rgb(226, 226, 226);
const ACCENT: Color = Color::from_rgb(0, 214, 143);
const SELECTED: Color = Color::from_rgb(213, 249, 238);
const SELECTED_INK: Color = Color::from_rgb(0, 105, 72);
const COMPONENT: Color = Color::from_rgb(144, 51, 236);
const WORKSPACE: Color = Color::from_rgb(242, 242, 242);

const FILE_MENU: Rect = Rect {
    x: RAIL_WIDTH + 4.,
    y: HEADER + 61.,
    width: 174.,
    height: 174.,
};
const FILE_ACTIONS: [(u64, &str, Action); 5] = [
    (14, "Paste HTML", Action::ImportHtml),
    (12, "Import", Action::Import),
    (34, "Save", Action::Save),
    (13, "Export", Action::Export),
    (11, "New document", Action::New),
];

const TAB_BG: Color = Color::from_rgb(232, 232, 232);
const POPUP_FIRST: u64 = 2_000_000;

fn sidebar_top() -> f64 {
    HEADER + 60.
}

fn tabs(app: &App) -> (tab_strip::TabLayout, f64) {
    let preferred: Vec<_> = app
        .tabs
        .iter()
        .map(|id| {
            let title_width = app.snapshots.get(id).map_or(56., |doc| {
                doc.title
                    .chars()
                    .map(|c| if c.is_ascii() { 7. } else { 13. })
                    .sum::<f64>()
            });
            (64. + title_width).clamp(tab_strip::MIN_TAB_WIDTH, 220.)
        })
        .collect();
    let x = tab_strip::HOME_X + tab_strip::HOME_WIDTH;
    let room = (app.width - x - tab_strip::BUTTON_WIDTH - 70.).max(0.);
    let active = app
        .tabs
        .iter()
        .position(|id| Some(id) == app.active.as_ref());
    (tab_strip::layout(&preferred, room, active), x)
}

fn popup_rect(app: &App) -> Option<Rect> {
    match app.popup? {
        Popup::Files => Some(FILE_MENU),
        Popup::Tabs => {
            let (layout, x) = tabs(app);
            let hidden = app.tabs.len() - layout.widths.len();
            let edge = x + layout.widths.iter().sum::<f64>() + tab_strip::OVERFLOW_WIDTH;
            let available = (app.height - HEADER - 12.).max(0.);
            Some(Rect::new(
                (edge - 220.).max(8.),
                HEADER + 4.,
                220.,
                (12. + hidden as f64 * 30.).min(available),
            ))
        }
        Popup::Tools(group) => {
            let dock = palette_rect(app)?;
            let (_, button, _) =
                figcraft_chrome::dock_groups(dock).find(|(item, _, _)| *item == group)?;
            Some(figcraft_chrome::dock_flyout(
                dock,
                button,
                app.canvas_rect(),
                group.tools().len(),
            ))
        }
    }
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
    figcraft_chrome::dock_rect(app.canvas_rect())
}

fn layers_heading(app: &App) -> f64 {
    let pages = app.document().map_or(0, |doc| doc.pages.len());
    sidebar_top() + 55. + pages as f64 * 36.
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
        46,
        Rect::new(tab_strip::HOME_X, 0., tab_strip::HOME_WIDTH, HEADER),
        "Home".into(),
        Action::Library,
        app.library_open || app.active.is_none(),
        None,
    );
    let (layout, mut tab_x) = tabs(app);
    for (index, width) in layout.widths.iter().enumerate() {
        let id = &app.tabs[layout.first + index];
        let title = app
            .snapshots
            .get(id)
            .map(|doc| doc.title.as_str())
            .unwrap_or("Opening…");
        let selected = app.active.as_ref() == Some(id);
        add(
            3000 + index as u64,
            Rect::new(tab_x, 0., width - tab_strip::CLOSE_WIDTH, HEADER),
            title.into(),
            Action::Open(id.clone()),
            selected,
            None,
        );
        add(
            3100 + index as u64,
            Rect::new(
                tab_x + width - tab_strip::CLOSE_WIDTH,
                0.,
                tab_strip::CLOSE_WIDTH,
                HEADER,
            ),
            format!("Close {title}"),
            Action::Close(id.clone()),
            selected,
            None,
        );
        tab_x += width;
    }
    if layout.overflow {
        add(
            47,
            Rect::new(tab_x, 0., tab_strip::OVERFLOW_WIDTH, HEADER),
            "More tabs".into(),
            Action::TabOverflow,
            app.popup == Some(Popup::Tabs),
            None,
        );
        tab_x += tab_strip::OVERFLOW_WIDTH;
    }
    add(
        48,
        Rect::new(tab_x + 6., 4., tab_strip::BUTTON_WIDTH, 32.),
        "New tab".into(),
        Action::New,
        false,
        None,
    );
    add(
        10,
        Rect::new(7., HEADER + 8., 38., 33.),
        "Oh My Canvas".into(),
        Action::Refresh,
        false,
        None,
    );
    for (item, rect) in figcraft_chrome::rail_controls(HEADER) {
        let (id, label, action, selected) = match item {
            RailItem::File => (
                40,
                "Files",
                Action::Files,
                matches!(app.inspector, Inspector::Design | Inspector::Text),
            ),
            RailItem::Assets => (
                41,
                "Assets",
                Action::Inspector(Inspector::Assets),
                app.inspector == Inspector::Assets,
            ),
            RailItem::Variables => (
                42,
                "Variables",
                Action::Inspector(Inspector::Tokens),
                app.inspector == Inspector::Tokens,
            ),
        };
        add(id, rect, label.into(), action, selected, None);
    }
    let right = app.width - RIGHT;
    for (id, x, width, label, action) in [
        (14, 8., 82., "Paste HTML", Action::ImportHtml),
        (12, 94., 62., "Import", Action::Import),
        (34, 170., 56., "Save", Action::Save),
    ] {
        add(
            id,
            Rect::new(right + x, HEADER + 8., width, 32.),
            label.into(),
            action,
            false,
            None,
        );
    }
    if let Some(palette) = palette_rect(app) {
        for (index, (group, rect, chevron)) in figcraft_chrome::dock_groups(palette).enumerate() {
            let tool = group.active_tool(app.tool);
            add(
                20 + index as u64,
                rect,
                tool.label().into(),
                Action::Tool(tool),
                app.tool == tool,
                None,
            );
            add(
                80 + index as u64,
                chevron,
                format!(
                    "{} tools",
                    match group {
                        figcraft_chrome::DockGroup::Move => "Move",
                        figcraft_chrome::DockGroup::Frame => "Frame",
                        figcraft_chrome::DockGroup::Shape => "Shape",
                        figcraft_chrome::DockGroup::Text => "Text",
                    }
                ),
                Action::ToolMenu(group),
                app.popup == Some(Popup::Tools(group)),
                None,
            );
        }
        for ((id, label, action), rect) in [
            (30, "Undo", Action::Undo),
            (31, "Redo", Action::Redo),
            (32, "Fit", Action::Fit),
        ]
        .into_iter()
        .zip(figcraft_chrome::dock_utilities(palette))
        {
            add(id, rect, label.into(), action, false, None);
        }
        for ((id, label, action, selected), rect) in [
            (
                60,
                "Text inspector",
                Action::Inspector(Inspector::Text),
                app.inspector == Inspector::Text,
            ),
            (
                61,
                "Design inspector",
                Action::Inspector(Inspector::Design),
                app.inspector == Inspector::Design,
            ),
            (
                62,
                "Variables",
                Action::Inspector(Inspector::Tokens),
                app.inspector == Inspector::Tokens,
            ),
            (63, "Paste HTML", Action::ImportHtml, false),
        ]
        .into_iter()
        .zip(figcraft_chrome::dock_modes(palette))
        {
            add(id, rect, label.into(), action, selected, None);
        }
    }
    if let Some(doc) = app.document() {
        add(
            35,
            Rect::new(RAIL_WIDTH + 12., HEADER + 10., LEFT - RAIL_WIDTH - 30., 28.),
            format!("Rename {}", doc.title),
            Action::RenameDocument,
            false,
            None,
        );
        let top = sidebar_top();
        add(
            37,
            Rect::new(LEFT - 76., top + 11., 30., 30.),
            "Rename page".into(),
            Action::RenamePage,
            false,
            None,
        );
        add(
            36,
            Rect::new(LEFT - 36., top + 11., 26., 30.),
            "+ Page".into(),
            Action::NewPage,
            false,
            None,
        );
        let mut y = top + 52.;
        for (i, page) in doc.pages.iter().enumerate() {
            if y + 32. > app.height - FOOTER {
                break;
            }
            add(
                300 + i as u64,
                Rect::new(RAIL_WIDTH + 10., y, LEFT - RAIL_WIDTH - 20., 32.),
                page.title.clone(),
                Action::Page(page.id.clone()),
                app.page.as_ref() == Some(&page.id),
                None,
            );
            y += 36.;
        }
        y = layers_heading(app) + 41.;
        let visible = ((app.height - FOOTER - y) / 37.).max(0.) as usize;
        for index in app
            .visible_layers
            .iter()
            .skip(app.layer_scroll)
            .take(visible)
        {
            let row = &app.layers[*index];
            let indent = (row.depth.min(7) * 16) as f64;
            add(
                1000 + *index as u64,
                Rect::new(RAIL_WIDTH + 10., y, LEFT - RAIL_WIDTH - 20., 32.),
                row.name.clone(),
                Action::Layer(row.id.clone()),
                app.selected.contains(&row.id),
                None,
            );
            if row.has_children {
                add(
                    1_000_000 + *index as u64,
                    Rect::new(RAIL_WIDTH + 11. + indent, y, 17., 32.),
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
            y += 37.;
        }
    } else {
        for (i, doc) in app
            .documents
            .iter()
            .filter(|doc| !doc.archived)
            .take(15)
            .enumerate()
        {
            let y = HEADER + 55. + i as f64 * 36.;
            if y + 32. > app.height - FOOTER {
                break;
            }
            add(
                400 + i as u64,
                Rect::new(RAIL_WIDTH + 10., y, LEFT - RAIL_WIDTH - 20., 32.),
                doc.title.clone(),
                Action::Open(doc.id.clone()),
                false,
                None,
            );
        }
    }
    if let Some(menu) = popup_rect(app) {
        match app.popup {
            Some(Popup::Files) => {
                for (index, (_, label, action)) in FILE_ACTIONS.into_iter().enumerate() {
                    add(
                        POPUP_FIRST + index as u64,
                        Rect::new(
                            menu.x + 6.,
                            menu.y + 7. + index as f64 * 32.,
                            menu.width - 12.,
                            32.,
                        ),
                        label.into(),
                        action,
                        false,
                        None,
                    );
                }
            }
            Some(Popup::Tabs) => {
                let (layout, _) = tabs(app);
                for (index, id) in app
                    .tabs
                    .iter()
                    .enumerate()
                    .filter(|(index, _)| {
                        !(layout.first..layout.first + layout.widths.len()).contains(index)
                    })
                    .take(((menu.height - 12.) / 30.).max(0.) as usize)
                    .enumerate()
                    .map(|(row, (_, id))| (row, id))
                {
                    let title = app
                        .snapshots
                        .get(id)
                        .map(|doc| doc.title.as_str())
                        .unwrap_or("Opening…");
                    add(
                        POPUP_FIRST + index as u64,
                        Rect::new(
                            menu.x + 6.,
                            menu.y + 6. + index as f64 * 30.,
                            menu.width - 12.,
                            30.,
                        ),
                        title.into(),
                        Action::Open(id.clone()),
                        false,
                        None,
                    );
                }
            }
            Some(Popup::Tools(group)) => {
                for (index, tool, rect) in figcraft_chrome::dock_flyout_rows(menu, group) {
                    add(
                        POPUP_FIRST + index as u64,
                        rect,
                        tool.label().into(),
                        Action::Tool(tool),
                        tool == app.tool,
                        None,
                    );
                }
            }
            None => {}
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

fn mark(canvas: &Canvas, r: Rect, source: &'static str, color: Color) {
    thread_local! {
        static MARKS: std::cell::RefCell<std::collections::HashMap<&'static str, skia_safe::Path>> =
            std::cell::RefCell::new(std::collections::HashMap::new());
    }
    let mut paint = Paint::default();
    paint.set_anti_alias(true);
    paint.set_color(color);
    paint.set_style(PaintStyle::Stroke);
    paint.set_stroke_width(1.35);
    paint.set_stroke_cap(skia_safe::paint::Cap::Round);
    paint.set_stroke_join(skia_safe::paint::Join::Round);
    canvas.save();
    canvas.translate((
        (r.x + (r.width - 16.) * 0.5) as f32,
        (r.y + (r.height - 16.) * 0.5) as f32,
    ));
    MARKS.with(|marks| {
        let mut marks = marks.borrow_mut();
        let path = marks
            .entry(source)
            .or_insert_with(|| skia_safe::Path::from_svg(source).unwrap_or_default());
        canvas.draw_path(path, &paint);
    });
    canvas.restore();
}

fn draw_control(canvas: &Canvas, app: &App, control: &Control, font: &Font) {
    use omc_model::NodeKind;
    let r = control.rect;
    let hovered = r.contains(app.cursor.0, app.cursor.1);
    if r.y < HEADER {
        if control.selected {
            fill(canvas, r, Color::WHITE);
        } else if hovered {
            round(canvas, r, Color::from_rgb(222, 222, 222), 5.);
        }
        let icon = match control.id {
            46 => Some("M2 7l6-5 6 5v7h-4v-4H6v4H2z"),
            47 => Some("M4 6l4 4 4-4"),
            48 => Some("M8 2v12M2 8h12"),
            _ => match control.action {
                Action::Close(_) => Some("M4 4l8 8M12 4l-8 8"),
                Action::Open(_) => {
                    mark(
                        canvas,
                        Rect::new(r.x + 9., r.y, 20., r.height),
                        "M2 14l2-8 6-4 4 4-4 6zM2 14l6-6m-1-1 2 2",
                        SELECTED_INK,
                    );
                    control_text(
                        canvas,
                        Rect::new(r.x + 35., r.y, (r.width - 37.).max(0.), r.height),
                        &control.label,
                        0.,
                        r.y + 24.,
                        13.,
                        INK,
                        font,
                    );
                    None
                }
                _ => None,
            },
        };
        if let Some(icon) = icon {
            mark(canvas, r, icon, INK);
        }
        if app.focus == control.id && app.keyboard_focus_visible {
            stroke(canvas, r, SELECTED_INK, 1.35);
        }
        return;
    }
    if let Some((item, label)) = match control.id {
        40 => Some((RailItem::File, "파일")),
        41 => Some((RailItem::Assets, "에셋")),
        42 => Some((RailItem::Variables, "변수")),
        _ => None,
    } {
        let icon = figcraft_chrome::rail_mark(r);
        if control.selected || hovered {
            round(
                canvas,
                icon,
                if control.selected {
                    SELECTED
                } else {
                    WORKSPACE
                },
                7.,
            );
        }
        figcraft_chrome::paint_rail_icon(
            canvas,
            item,
            r,
            if control.selected { SELECTED_INK } else { INK },
        );
        text(
            canvas,
            label,
            r.x + (r.width - 20.) * 0.5,
            r.y + 49.,
            10.,
            INK,
            font,
        );
        if app.focus == control.id && app.keyboard_focus_visible {
            stroke(canvas, icon, SELECTED_INK, 1.4);
        }
        return;
    }
    if let Action::ToolMenu(_) = control.action {
        if hovered || control.selected {
            round(canvas, r, WORKSPACE, 5.);
        }
        figcraft_chrome::paint_dock_chevron(canvas, r, MUTED);
        if app.focus == control.id && app.keyboard_focus_visible {
            stroke(canvas, r, SELECTED_INK, 1.35);
        }
        return;
    }
    if (60..=63).contains(&control.id) {
        if control.selected || hovered {
            round(canvas, r, Color::WHITE, 5.);
        }
        figcraft_chrome::paint_dock_mode(
            canvas,
            (control.id - 60) as usize,
            r,
            if control.selected {
                SELECTED_INK
            } else {
                MUTED
            },
        );
        if app.focus == control.id && app.keyboard_focus_visible {
            stroke(canvas, r, SELECTED_INK, 1.35);
        }
        return;
    }
    let tool = match control.action {
        Action::Tool(tool) => Some(tool),
        _ => None,
    };
    let background = if control.id == 34 || control.selected && tool.is_some() {
        Some(ACCENT)
    } else if matches!(control.action, Action::Layer(_)) && control.selected {
        Some(SELECTED)
    } else if control.selected || hovered || control.field_value.is_some() {
        Some(WORKSPACE)
    } else {
        None
    };
    if let Some(color) = background {
        round(canvas, r, color, 6.);
    }
    if app.focus == control.id && app.keyboard_focus_visible {
        stroke(
            canvas,
            Rect::new(r.x + 1., r.y + 1., r.width - 2., r.height - 2.),
            SELECTED_INK,
            1.35,
        );
    }
    if let Some(tool) = tool {
        figcraft_chrome::paint_tool_icon(canvas, tool, r, INK);
        return;
    }
    if (30..=32).contains(&control.id) {
        figcraft_chrome::paint_dock_utility(canvas, (control.id - 30) as usize, r, INK);
        return;
    }
    let icon = match control.id {
        36 => Some("M8 3v10M3 8h10"),
        37 => Some("M3 13l1-4 6-6 3 3-6 6zM9 4l3 3"),
        _ => match &control.action {
            Action::Close(_) => Some("M4 4l8 8M12 4l-8 8"),
            Action::ToggleLayer(id) if app.collapsed.contains(id) => Some("M6 4l4 4-4 4"),
            Action::ToggleLayer(_) => Some("M4 6l4 4 4-4"),
            _ => None,
        },
    };
    if let Some(icon) = icon {
        mark(
            canvas,
            r,
            icon,
            if matches!(control.action, Action::ToggleLayer(_)) {
                MUTED
            } else {
                INK
            },
        );
        return;
    }
    if let Action::Layer(id) = &control.action {
        let row = app.layers.get((control.id - 1000) as usize);
        let depth = row.map_or(0, |row| row.depth).min(7);
        let kind = app
            .document()
            .and_then(|doc| doc.nodes.get(id))
            .map_or(NodeKind::Frame, |n| n.kind.clone());
        let color = if matches!(kind, NodeKind::Component | NodeKind::Instance) {
            COMPONENT
        } else {
            INK
        };
        let auto_layout = row.is_some_and(|row| row.auto_layout);
        let x = r.x + 18. + depth as f64 * 16.;
        figcraft_chrome::paint_layer_icon(
            canvas,
            &kind,
            auto_layout,
            Rect::new(x, r.y, 16., r.height),
            color,
        );
        control_text(
            canvas,
            Rect::new(x + 21., r.y, (r.x + r.width - x - 21.).max(0.), r.height),
            &control.label,
            0.,
            r.y + 20.,
            12.,
            color,
            font,
        );
        return;
    }
    if let Some(value) = &control.field_value {
        if !matches!(
            (&app.editing, &control.action),
            (Some(edit), Action::Field(property))
                if matches!(&edit.target, EditTarget::Property { property: current, .. } if current == property)
        ) {
            let property = match &control.action {
                Action::Field(property) => property.as_str(),
                _ => "",
            };
            let lead = crate::inspector::field_lead(property);
            let displayed = crate::inspector::display_value(property, value);
            let mut value: &str = displayed.as_ref();
            let baseline = r.y + r.height * 0.5 + 4.;
            if matches!(property, "fill" | "stroke")
                && let Some(color) = omc_style::parse_color(value)
            {
                let swatch = Rect::new(r.x + 5., r.y + (r.height - 16.) * 0.5, 16., 16.);
                let rgba = [color.r, color.g, color.b, color.a]
                    .map(|channel| (channel * 255.).round() as u8);
                round(
                    canvas,
                    swatch,
                    Color::from_argb(rgba[3], rgba[0], rgba[1], rgba[2]),
                    3.,
                );
                stroke(canvas, swatch, LINE, 1.);
                let hex = color.hex();
                let hex = hex.get(1..7).unwrap_or(&hex).to_ascii_uppercase();
                control_text(
                    canvas,
                    Rect::new(r.x + 27., r.y, r.width - 30., r.height),
                    &hex,
                    0.,
                    baseline,
                    12.,
                    INK,
                    font,
                );
                return;
            }
            if value.is_empty() {
                value = "—";
            }
            if let Some(lead) = lead {
                let width = if lead.is_ascii() {
                    lead.len() as f64 * 6.5
                } else {
                    lead.chars().count() as f64 * 10.
                };
                text(canvas, lead, r.x + 8., baseline, 11., MUTED, font);
                let start = 14. + width;
                control_text(
                    canvas,
                    Rect::new(r.x + start, r.y, (r.width - start).max(0.), r.height),
                    value,
                    0.,
                    baseline,
                    12.,
                    INK,
                    font,
                );
            } else {
                control_text(canvas, r, value, 8., baseline, 12., INK, font);
            }
        }
        return;
    }
    let label = match (&control.action, control.id) {
        (_, 10) => "OMC",
        (_, 35) => control
            .label
            .strip_prefix("Rename ")
            .unwrap_or(&control.label),
        (Action::Inspector(Inspector::Design), _) => "디자인",
        (Action::Inspector(Inspector::Text), _) => "텍스트",
        (Action::Inspector(Inspector::Assets), _) => "에셋",
        (Action::Inspector(Inspector::Tokens), _) => "변수",
        _ => &control.label,
    };
    let mut title = font.clone();
    if control.id == 35 || matches!(control.action, Action::Page(_)) && control.selected {
        title.set_embolden(true);
    }
    control_text(
        canvas,
        r,
        label,
        5.,
        r.y + r.height * 0.5 + 4.,
        if control.id == 35 { 15. } else { 12. },
        INK,
        &title,
    );
}

fn tool_title(tool: Tool) -> &'static str {
    match tool {
        Tool::Select => "이동",
        Tool::Pan => "손 도구",
        Tool::Frame => "프레임",
        Tool::Rect => "사각형",
        Tool::Ellipse => "타원",
        Tool::Text => "텍스트",
    }
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

fn check_surface_size(width: u32, height: u32) -> Result<(), String> {
    if width == 0 || height == 0 || u64::from(width) * u64::from(height) > 33_554_432 {
        return Err("The window surface is outside its 128 MiB budget.".into());
    }
    Ok(())
}

fn render(
    app: &App,
    width: u32,
    height: u32,
    scale: f64,
    interactive: bool,
) -> Result<Surface, String> {
    check_surface_size(width, height)?;
    let mut surface = skia_safe::surfaces::raster_n32_premul((width as i32, height as i32))
        .ok_or("Could not allocate a native drawing surface.")?;
    render_to_canvas(app, surface.canvas(), scale, interactive)?;
    Ok(surface)
}

fn render_to_canvas(
    app: &App,
    canvas: &Canvas,
    scale: f64,
    allow_pan_preview: bool,
) -> Result<(), String> {
    canvas.scale((scale as f32, scale as f32));
    canvas.clear(Color::WHITE);
    thread_local! {
        static UI_FONT: Option<Font> = {
            let manager = FontMgr::default();
            manager.match_family_style("sans-serif", FontStyle::normal())
                .or_else(|| manager.legacy_make_typeface(None, FontStyle::normal()))
                .map(|face| Font::from_typeface(face, 13.))
        };
    }
    let font = UI_FONT
        .with(Clone::clone)
        .ok_or("No native UI font is available.")?;
    let viewport = app.canvas_rect();
    fill(canvas, viewport, WORKSPACE);
    fill(canvas, Rect::new(0., 0., app.width, HEADER), TAB_BG);
    fill(canvas, Rect::new(0., HEADER - 1., app.width, 1.), LINE);
    fill(
        canvas,
        Rect::new(RAIL_WIDTH - 1., HEADER, 1., app.height - HEADER),
        LINE,
    );
    fill(
        canvas,
        Rect::new(LEFT - 1., HEADER, 1., app.height - HEADER),
        LINE,
    );
    fill(canvas, Rect::new(15., HEADER + 48., 18., 1.), LINE);
    if app.document().is_some() {
        let top = sidebar_top();
        let layers = layers_heading(app);
        text(
            canvas,
            "로컬 문서",
            RAIL_WIDTH + 17.,
            HEADER + 47.,
            11.,
            MUTED,
            &font,
        );
        fill(
            canvas,
            Rect::new(RAIL_WIDTH, top, LEFT - RAIL_WIDTH, 1.),
            LINE,
        );
        text(
            canvas,
            "페이지",
            RAIL_WIDTH + 17.,
            top + 30.,
            12.,
            INK,
            &font,
        );
        fill(
            canvas,
            Rect::new(RAIL_WIDTH, layers, LEFT - RAIL_WIDTH, 1.),
            LINE,
        );
        text(
            canvas,
            "레이어",
            RAIL_WIDTH + 17.,
            layers + 28.,
            12.,
            INK,
            &font,
        );
    } else {
        text(
            canvas,
            "로컬 문서",
            RAIL_WIDTH + 16.,
            HEADER + 32.,
            14.,
            INK,
            &font,
        );
    }
    if app.inspector_visible() {
        let panel_x = app.width - RIGHT;
        let x = panel_x + 16.;
        fill(
            canvas,
            Rect::new(panel_x, HEADER, 1., app.height - HEADER),
            LINE,
        );
        fill(canvas, Rect::new(panel_x, HEADER + 50., RIGHT, 1.), LINE);
        if app.document().is_some() {
            fill(canvas, Rect::new(panel_x, HEADER + 90., RIGHT, 1.), LINE);
            text(
                canvas,
                &format!("{:.0}%", app.camera.zoom * 100.),
                app.width - 39.,
                HEADER + 74.,
                11.,
                INK,
                &font,
            );
            if let Some(node) = app.node() {
                let label = match node.kind {
                    omc_model::NodeKind::Text => "텍스트",
                    omc_model::NodeKind::Frame => "프레임",
                    omc_model::NodeKind::Rect => "사각형",
                    omc_model::NodeKind::Ellipse => "타원",
                    omc_model::NodeKind::Component => "컴포넌트",
                    omc_model::NodeKind::Instance => "인스턴스",
                    _ => "레이어",
                };
                text(canvas, label, x, HEADER + 119., 14., INK, &font);
            } else if !matches!(app.inspector, Inspector::Assets | Inspector::Tokens) {
                text(
                    canvas,
                    "레이어를 선택하세요",
                    x,
                    HEADER + 117.,
                    12.,
                    MUTED,
                    &font,
                );
            }
            for (label, y) in crate::inspector::sections(app) {
                fill(
                    canvas,
                    Rect::new(panel_x + 1., y - 22., RIGHT - 1., 1.),
                    LINE,
                );
                text(canvas, label, x, y, 12., INK, &font);
            }
        }
    }
    canvas.save();
    canvas.clip_rect(rect(viewport), None, Some(false));
    if let Some(scene) = &app.scene {
        let translations = app.drag_translations();
        let key = SceneCacheKey::new(app.scene_generation, viewport, scale, app.camera);
        let moving = !translations.is_empty();
        let paint = |canvas: &Canvas| {
            paint_scene_preview(canvas, scene, app.resources.as_ref(), &translations).map(|_| ())
        };
        let cached = if !allow_pan_preview || moving {
            None
        } else {
            let panning = allow_pan_preview && app.uses_pan_raster();
            if panning
                && app.pan_cache.borrow_mut().paint(
                    canvas,
                    app.scene_generation,
                    viewport,
                    scale,
                    app.camera,
                    scene,
                    &app.resources,
                    WORKSPACE,
                    true,
                )
            {
                Some(Ok(()))
            } else {
                let mut cache = app.scene_cache.borrow_mut();
                match key {
                    Some(key) if panning && cache.pan_preview(canvas, key, WORKSPACE) => {
                        Some(Ok(()))
                    }
                    Some(key) => Some(cache.paint(canvas, key, WORKSPACE, paint)),
                    None => {
                        cache.clear();
                        None
                    }
                }
            }
        };
        canvas.translate((viewport.x as f32, viewport.y as f32));
        canvas.translate((app.camera.x as f32, app.camera.y as f32));
        canvas.scale((app.camera.zoom as f32, app.camera.zoom as f32));
        let cached = cached.or_else(|| {
            if !allow_pan_preview || !moving {
                return None;
            }
            app.move_cache.borrow_mut().paint(
                canvas,
                key?,
                scene,
                app.resources.as_ref(),
                &translations,
            )
        });
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
            if let Some([mut x, mut y, w, h]) = scene.bounds(id) {
                if let Some(delta) = app.move_delta() {
                    let mut item = scene.item(id);
                    while let Some(candidate) = item {
                        if translations.contains_key(&candidate.id) {
                            (x, y) = (x + delta.0, y + delta.1);
                            break;
                        }
                        item = candidate.parent.map(|parent| &scene.items[parent]);
                    }
                }
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
                Drag::Move { .. } => {}
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
        figcraft_chrome::paint_dock(canvas, r);
    }
    if !app.inspector_visible() {
        round(
            canvas,
            Rect::new(app.width - RIGHT, HEADER, RIGHT, 50.),
            Color::WHITE,
            8.,
        );
    }
    for control in &app.controls {
        if control.id < POPUP_FIRST {
            draw_control(canvas, app, control, &font);
        }
    }
    if let Some(thumb) = crate::inspector::scrollbar(app) {
        round(canvas, thumb, Color::from_rgb(198, 198, 198), 1.5);
    }
    if let Some(menu) = popup_rect(app) {
        let tools = matches!(app.popup, Some(Popup::Tools(_)));
        round(
            canvas,
            Rect::new(menu.x - 2., menu.y + 2., menu.width + 4., menu.height + 1.),
            LINE,
            13.,
        );
        round(canvas, menu, if tools { INK } else { Color::WHITE }, 13.);
        for control in app
            .controls
            .iter()
            .filter(|control| control.id >= POPUP_FIRST)
        {
            let r = control.rect;
            let hovered = r.contains(app.cursor.0, app.cursor.1);
            if let Action::Tool(tool) = control.action {
                if hovered || control.selected {
                    round(canvas, r, Color::from_rgb(61, 61, 61), 5.);
                }
                if control.selected {
                    mark(
                        canvas,
                        Rect::new(r.x + 2., r.y, 19., r.height),
                        "M4 8l3 3 5-6",
                        ACCENT,
                    );
                }
                figcraft_chrome::paint_tool_icon(
                    canvas,
                    tool,
                    Rect::new(r.x + 20., r.y, 25., r.height),
                    Color::WHITE,
                );
                text(
                    canvas,
                    tool_title(tool),
                    r.x + 48.,
                    r.y + 20.,
                    12.,
                    Color::WHITE,
                    &font,
                );
                text(
                    canvas,
                    figcraft_chrome::dock_tool_shortcut(tool),
                    r.x + r.width - 18.,
                    r.y + 20.,
                    11.,
                    Color::WHITE,
                    &font,
                );
            } else {
                draw_control(canvas, app, control, &font);
            }
        }
    } else if let Some(dock) = palette_rect(app)
        && let Some(control) = app.controls.iter().find(|control| {
            (20..=23).contains(&control.id) && control.rect.contains(app.cursor.0, app.cursor.1)
        })
        && let Action::Tool(tool) = control.action
    {
        let label = format!(
            "{}  {}",
            tool_title(tool),
            figcraft_chrome::dock_tool_shortcut(tool)
        );
        let width = label.chars().count() as f64 * 9. + 18.;
        let tip = figcraft_chrome::dock_tooltip(dock, control.rect, viewport, width);
        figcraft_chrome::paint_dock_tooltip(canvas, tip);
        control_text(
            canvas,
            tip,
            &label,
            8.,
            tip.y + tip.height * 0.5 + 4.,
            12.,
            INK,
            &font,
        );
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
    if app.status != "Ready" {
        control_text(
            canvas,
            Rect::new(
                RAIL_WIDTH + 14.,
                app.height - FOOTER,
                LEFT - RAIL_WIDTH - 28.,
                FOOTER,
            ),
            &app.status,
            0.,
            app.height - 6.,
            10.,
            MUTED,
            &font,
        );
    }
    if !app.inspector_visible() && app.document().is_some() {
        text(
            canvas,
            &format!("{:.0}%", app.camera.zoom * 100.),
            app.width - 68.,
            app.height - 8.,
            11.,
            MUTED,
            &font,
        );
    }
    Ok(())
}

fn copy_present_row(out: &mut [u32], source: &[u32], red_first: bool) {
    if cfg!(target_endian = "little") && !red_first {
        for (out, source) in out.iter_mut().zip(source) {
            *out = *source & 0x00ff_ffff;
        }
    } else {
        for (out, source) in out.iter_mut().zip(source) {
            let [first, green, third, _] = source.to_ne_bytes();
            let (red, blue) = if red_first {
                (first, third)
            } else {
                (third, first)
            };
            *out = u32::from(red) << 16 | u32::from(green) << 8 | u32::from(blue);
        }
    }
}

pub fn draw(app: &mut App) -> Result<bool, String> {
    let Some(window) = app.window.as_ref().cloned() else {
        return Ok(false);
    };
    let size = window.inner_size();
    if size.width == 0 || size.height == 0 {
        return Ok(false);
    }
    app.controls = controls(app);
    let scale = window.scale_factor();
    #[cfg(target_os = "macos")]
    if let Some(mut presenter) = app.gpu_presenter.take() {
        let result = check_surface_size(size.width, size.height).and_then(|_| {
            presenter.present(&window, size, scale, |canvas| {
                render_to_canvas(app, canvas, scale, true)
            })
        });
        app.gpu_presenter = Some(presenter);
        return result;
    }
    let mut raster = render(app, size.width, size.height, scale, true)?;
    let pixmap = raster
        .peek_pixels()
        .ok_or("Could not read the native drawing surface.")?;
    let pixels = pixmap
        .pixels::<u32>()
        .ok_or("Unexpected native pixel format.")?;
    let stride = pixmap.row_bytes() / 4;
    let width = size.width as usize;
    let red_first = pixmap.color_type() == ColorType::RGBA8888;
    let Some(surface) = &mut app.surface else {
        return Ok(false);
    };
    surface
        .resize(
            NonZeroU32::new(size.width).ok_or("Empty width")?,
            NonZeroU32::new(size.height).ok_or("Empty height")?,
        )
        .map_err(|e| e.to_string())?;
    let mut buffer = surface.buffer_mut().map_err(|e| e.to_string())?;
    for (out, row) in buffer.chunks_exact_mut(width).zip(pixels.chunks(stride)) {
        copy_present_row(out, &row[..width], red_first);
    }
    buffer.present().map_err(|e| e.to_string())?;
    Ok(true)
}
pub fn screenshot(app: &App, path: &Path) -> Result<(), String> {
    let window = app.window.as_ref().ok_or("No native window")?;
    let size = window.inner_size();
    let mut surface = render(app, size.width, size.height, window.scale_factor(), false)?;
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
    fn present_rows_preserve_rgb_and_clear_alpha() {
        let mut out = [0; 1];
        copy_present_row(
            &mut out,
            &[u32::from_ne_bytes([0x12, 0x34, 0x56, 0xff])],
            true,
        );
        assert_eq!(out, [0x0012_3456]);
        copy_present_row(
            &mut out,
            &[u32::from_ne_bytes([0x56, 0x34, 0x12, 0xff])],
            false,
        );
        assert_eq!(out, [0x0012_3456]);
    }

    #[test]
    fn dock_tools_fit_compact_and_standard_windows() {
        for (width, height) in [(960., 640.), (1440., 900.)] {
            let view = Rect::new(LEFT, HEADER, width - LEFT - RIGHT, height - HEADER);
            let dock = figcraft_chrome::dock_rect(view).unwrap();
            assert!(dock.x >= view.x && dock.x + dock.width <= view.x + view.width);
            assert!(dock.y + dock.height <= view.y + view.height);
            let tools: Vec<_> = figcraft_chrome::dock_groups(dock)
                .map(|(_, r, _)| r)
                .collect();
            assert_eq!(tools.len(), 4);
            let mut end = dock.x;
            for rect in tools
                .into_iter()
                .chain(figcraft_chrome::dock_utilities(dock))
            {
                assert!(rect.x + 1e-8 >= end && rect.width > 0.);
                assert!(rect.y >= dock.y && rect.y + rect.height <= dock.y + dock.height);
                end = rect.x + rect.width;
            }
            assert!(end <= dock.x + dock.width + 1e-8);
        }
    }
}
