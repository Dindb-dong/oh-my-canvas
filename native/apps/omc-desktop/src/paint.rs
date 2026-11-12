use crate::{
    app::{
        Action, App, Control, Drag, EditTarget, FOOTER, HEADER, Inspector, LEFT, Popup, RIGHT, Tool,
    },
    commands::{layer_hidden, layer_locked},
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
const INSPECTOR_FIELD: Color = Color::from_rgb(245, 245, 245);

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
const TAB_LABEL_X: f64 = 35.;
const TAB_LABEL_RIGHT_PAD: f64 = 2.;
const LAYER_FIRST: u64 = 1 << 32;
const LAYER_CONTROLS: u64 = 4;
const MCP_BUTTON_WIDTH: f64 = 62.;
const MCP_HEADER_SPACE: f64 = 198.;
const COLLABORATE_BLUE: Color = Color::from_rgb(37, 99, 235);
const POPUP_FIRST: u64 = 1 << 48;

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
            (TAB_LABEL_X + TAB_LABEL_RIGHT_PAD + tab_strip::CLOSE_WIDTH + title_width)
                .clamp(tab_strip::MIN_TAB_WIDTH, 220.)
        })
        .collect();
    let x = tab_strip::HOME_X + tab_strip::HOME_WIDTH;
    let room = (app.width - x - tab_strip::BUTTON_WIDTH - MCP_HEADER_SPACE).max(0.);
    let active = app
        .tabs
        .iter()
        .position(|id| Some(id) == app.active.as_ref());
    (tab_strip::layout(&preferred, room, active), x)
}

fn popup_rect(app: &App) -> Option<Rect> {
    match app.popup? {
        Popup::Files => Some(FILE_MENU),
        Popup::Mcp => Some(Rect::new(app.width - 322., HEADER + 8., 310., 119.)),
        Popup::Collaboration => Some(Rect::new(app.width - 342., HEADER + 8., 330., 254.)),
        Popup::InspectorZoom | Popup::InspectorLayer | Popup::InspectorBlend => {
            crate::inspector::popup_rect(app)
        }
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
    if app.prototype_frame.is_some() {
        return None;
    }
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
// FigCraft's desktop UI uses the bundled Inter Regular face and a system Hangul fallback.
fn inspector_font() -> Option<Font> {
    thread_local! {
        static INTER: Option<Font> = FontMgr::default()
            .new_from_data(include_bytes!("../fonts/Inter-Regular.ttf"), None)
            .map(inspector_typeface);
    }
    INTER.with(Clone::clone)
}

fn inspector_typeface(face: skia_safe::Typeface) -> Font {
    let mut font = Font::from_typeface(face, 11.);
    font.set_hinting(skia_safe::FontHinting::None);
    font.set_subpixel(true);
    font
}

fn inspector_label(
    canvas: &Canvas,
    body: &str,
    x: f64,
    y: f64,
    size: f32,
    color: Color,
    font: &Font,
) {
    thread_local! {
        static HANGUL: Option<Font> = {
            let manager = FontMgr::default();
            ["Malgun Gothic", "Apple SD Gothic Neo", "Noto Sans CJK KR", "Noto Sans KR", "NanumGothic"]
                .iter()
                .find_map(|name| manager.match_family_style(name, FontStyle::normal()))
                .map(inspector_typeface)
        };
    }
    if body
        .chars()
        .all(|ch| ch == ' ' || ('가'..='힣').contains(&ch))
        && let Some(mut hangul) = HANGUL.with(Clone::clone)
        && hangul.str_to_glyphs_vec(body).iter().all(|&id| id != 0)
    {
        let mut paint = Paint::default();
        paint.set_color(color);
        paint.set_anti_alias(true);
        hangul.set_size(size);
        canvas.draw_str(body, (x as f32, y as f32), &hangul, &paint);
    } else {
        text(canvas, body, x, y, size, color, font);
    }
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
    add(
        49,
        Rect::new(app.width - MCP_HEADER_SPACE + 4., 5., MCP_BUTTON_WIDTH, 30.),
        "MCP".into(),
        Action::Mcp,
        app.popup == Some(Popup::Mcp),
        None,
    );
    add(
        50,
        Rect::new(app.width - 122., 5., 110., 30.),
        "Collaborate".into(),
        Action::Collaborate,
        app.popup == Some(Popup::Collaboration),
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
                matches!(
                    app.inspector,
                    Inspector::Design | Inspector::Prototype | Inspector::Inspect
                ),
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
                61,
                "디자인 모드",
                Action::Inspector(Inspector::Design),
                app.inspector == Inspector::Design,
            ),
            (
                62,
                "프로토타입 모드",
                Action::Inspector(Inspector::Prototype),
                app.inspector == Inspector::Prototype,
            ),
            (
                63,
                "검사 모드",
                Action::Inspector(Inspector::Inspect),
                app.inspector == Inspector::Inspect,
            ),
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
            let Some(node) = doc.nodes.get(&row.id) else {
                continue;
            };
            let indent = (row.depth.min(6) * 16) as f64;
            let id = LAYER_FIRST + *index as u64 * LAYER_CONTROLS;
            let bounds = layer_bounds(y);
            let [lock, eye] = figcraft_chrome::layer_action_bounds(bounds);
            let locked = layer_locked(node);
            let hidden = layer_hidden(node);
            add(
                id,
                bounds,
                row.name.clone(),
                Action::Layer(row.id.clone()),
                app.selected.contains(&row.id),
                None,
            );
            if row.has_children {
                add(
                    id + 1,
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
            let lock_label = if locked { "Unlock" } else { "Lock" };
            let eye_label = if hidden { "Show" } else { "Hide" };
            add(
                id + 2,
                lock,
                format!("{lock_label} {}", row.name),
                Action::LayerLock(row.id.clone()),
                locked || row.locked_above,
                None,
            );
            add(
                id + 3,
                eye,
                format!("{eye_label} {}", row.name),
                Action::LayerVisibility(row.id.clone()),
                hidden,
                None,
            );
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
    for control in crate::inspector::controls(app) {
        add(
            control.id,
            control.rect,
            control.label,
            control.action,
            control.selected,
            control.field_value,
        );
    }
    if let Some(menu) = popup_rect(app) {
        match app.popup {
            Some(Popup::InspectorZoom | Popup::InspectorLayer | Popup::InspectorBlend) => {
                for control in crate::inspector::popup_controls(app, POPUP_FIRST) {
                    add(
                        control.id,
                        control.rect,
                        control.label,
                        control.action,
                        control.selected,
                        control.field_value,
                    );
                }
            }
            Some(Popup::Collaboration) => {
                let mode = app.collaboration["mode"].as_str().unwrap_or("offline");
                let actions = match mode {
                    "hosting" => [
                        ("Copy invitation", "invite"),
                        ("Refresh participants", "status"),
                        ("Stop hosting", "leave"),
                    ],
                    "connected" | "reconnecting" => [
                        ("Refresh participants", "status"),
                        ("Leave session", "leave"),
                        ("", ""),
                    ],
                    _ => [
                        ("Host on local network", "host-lan"),
                        ("Host on this device", "host"),
                        ("Join from clipboard", "join"),
                    ],
                };
                for (index, (label, action)) in actions
                    .into_iter()
                    .enumerate()
                    .filter(|(_, (_, action))| !action.is_empty())
                {
                    add(
                        POPUP_FIRST + index as u64,
                        Rect::new(
                            menu.x + 12.,
                            menu.y + 134. + index as f64 * 36.,
                            menu.width - 24.,
                            32.,
                        ),
                        label.into(),
                        Action::Collaboration(action),
                        false,
                        None,
                    );
                }
            }
            Some(Popup::Mcp) => {
                add(
                    POPUP_FIRST,
                    Rect::new(menu.x + 12., menu.y + 72., menu.width - 24., 34.),
                    "Copy MCP configuration".into(),
                    Action::CopyMcpConfiguration,
                    false,
                    None,
                );
            }
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
    controls
}

fn layer_actions_revealed(app: &App, control: &Control) -> bool {
    let base = control.id - (control.id - LAYER_FIRST) % LAYER_CONTROLS;
    layer_bounds(control.rect.y - (32. - control.rect.height) / 2.)
        .contains(app.cursor.0, app.cursor.1)
        || app.keyboard_focus_visible && (base..base + LAYER_CONTROLS).contains(&app.focus)
}

fn layer_bounds(y: f64) -> Rect {
    Rect::new(RAIL_WIDTH + 10., y, LEFT - RAIL_WIDTH - 20., 32.)
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
    draw_mark(canvas, r, source, color, PaintStyle::Stroke, 1.35);
}

fn draw_mark(
    canvas: &Canvas,
    r: Rect,
    source: &'static str,
    color: Color,
    style: PaintStyle,
    stroke_width: f32,
) {
    thread_local! {
        static MARKS: std::cell::RefCell<std::collections::HashMap<&'static str, skia_safe::Path>> =
            std::cell::RefCell::new(std::collections::HashMap::new());
    }
    let mut paint = Paint::default();
    paint.set_anti_alias(true);
    paint.set_color(color);
    paint.set_style(style);
    paint.set_stroke_width(stroke_width);
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

// Geometry adapted from FigCraft v0.17.0 icons/draw.rs (MIT).
fn inspector_glyph(canvas: &Canvas, r: Rect, name: &str, color: Color) {
    let (path, filled) = match name {
        "align-left" => ("M2 2H3V14H2ZM4 4H13V7H4ZM4 9H9V12H4Z", true),
        "align-center" => ("M7 2H8V14H7ZM2 4H13V7H2ZM4 9H11V12H4Z", true),
        "align-right" => ("M13 2H14V14H13ZM3 4H12V7H3ZM7 9H12V12H7Z", true),
        "align-top" => ("M2 2H14V3H2ZM4 4H7V13H4ZM9 4H12V9H9Z", true),
        "align-middle" => ("M2 7H14V8H2ZM4 2H7V13H4ZM9 4H12V11H9Z", true),
        "align-bottom" => ("M2 13H14V14H2ZM4 3H7V12H4ZM9 7H12V12H9Z", true),
        "component" => (
            "M8 1.7l2.5 2.5L8 6.7 5.5 4.2ZM11.8 5.5l2.5 2.5-2.5 2.5L9.3 8ZM8 9.3l2.5 2.5L8 14.3l-2.5-2.5ZM4.2 5.5 6.7 8l-2.5 2.5L1.7 8Z",
            true,
        ),
        "mask" | "opacity" => ("M8 2.5a5.5 5.5 0 1 0 0 11a5.5 5.5 0 1 0 0-11", false),
        "boolean" => ("M2.5 2.5h7v4h4v7h-7v-4h-4Z", false),
        "constraints" => (
            "M3.5 2.5h9q1 0 1 1v9q0 1-1 1h-9q-1 0-1-1v-9q0-1 1-1ZM10 7.5h3M7.5 3v3",
            false,
        ),
        "rotate" => (
            "M7.218 3.562A5 5 0 1 1 4.464 4.964M4.464 8.15V4.964H1.28",
            false,
        ),
        "flip-x" => ("M7.5 1v2m0 2v2m0 2v2m0 2v2M5.5 3.5v9h-4Z", false),
        "flip-y" => ("M1 7.5h2m2 0h2m2 0h2m2 0h2M3.5 5.5h9v-4Z", false),
        "link" => (
            "M7 11l-2 2a2.5 2.5 0 0 1-3.5-3.5l2-2m5-2 2-2a2.5 2.5 0 0 1 3.5 3.5l-2 2M6 10l4-4",
            false,
        ),
        "link-off" => (
            "M1.944 10.944l2-2a2.2 2.2 0 0 1 3.112 3.112l-2 2a2.2 2.2 0 0 1-3.112-3.112ZM8.944 3.944l2-2a2.2 2.2 0 0 1 3.112 3.112l-2 2a2.2 2.2 0 0 1-3.112-3.112ZM9.5 12v2M12 9.5h2M2 6.5h2M6.5 2v2",
            false,
        ),
        "eye" | "eye-small" => (
            "M2.5 7.5a7 7 0 0 1 11 0 7 7 0 0 1-11 0ZM10 7.5a2 2 0 1 0-4 0 2 2 0 1 0 4 0Z",
            false,
        ),
        "eye-off" | "eye-off-small" => {
            ("M2.5 7.5a7 7 0 0 1 11 0 7 7 0 0 1-11 0ZM3 13l10-11", false)
        }
        "variable" => ("M8 1.5l5.5 3.25v6.5L8 14.5l-5.5-3.25v-6.5Z", false),
        "blend" => (
            "M10 8a4 4 0 1 0-8 0 4 4 0 1 0 8 0ZM14 8a4 4 0 1 0-8 0 4 4 0 1 0 8 0Z",
            false,
        ),
        "styles" => (
            "M7.2 5a2.2 2.2 0 1 1-4.4 0 2.2 2.2 0 1 1 4.4 0ZM13.2 5a2.2 2.2 0 1 1-4.4 0 2.2 2.2 0 1 1 4.4 0ZM7.2 11a2.2 2.2 0 1 1-4.4 0 2.2 2.2 0 1 1 4.4 0ZM13.2 11a2.2 2.2 0 1 1-4.4 0 2.2 2.2 0 1 1 4.4 0Z",
            true,
        ),
        "chevron" => ("M4.5 6l3.5 3.5L11.5 6", false),
        "hug" => ("M2 5l3 3-3 3M14 5l-3 3 3 3M5 8h6", false),
        "fixed" => ("M2 4v8m12-8v8M2 8h12", false),
        "text-height" => (
            "M4.5 3h7a1.5 1.5 0 0 1 1.5 1.5v1A1.5 1.5 0 0 1 11.5 7h-7A1.5 1.5 0 0 1 3 5.5v-1A1.5 1.5 0 0 1 4.5 3Zm0 6h7a1.5 1.5 0 0 1 1.5 1.5v1a1.5 1.5 0 0 1-1.5 1.5h-7A1.5 1.5 0 0 1 3 11.5v-1A1.5 1.5 0 0 1 4.5 9Z",
            true,
        ),
        "paragraph" | "text-justify" => ("M2 3.5h12M2 6.5h12M2 9.5h12M2 12.5h12", false),
        "text-left" => ("M2 3.5h12M2 6.5h8M2 9.5h12M2 12.5h7", false),
        "text-center" => ("M2 3.5h12M4 6.5h8M2 9.5h12M5 12.5h6", false),
        "text-right" => ("M2 3.5h12M6 6.5h8M2 9.5h12M7 12.5h7", false),
        "text-top" => ("M2 2.5h12M8 5v9M5 8l3-3 3 3", false),
        "text-middle" => ("M2 8h12M8 1v4m-2-2 2 2 2-2M8 15v-4m-2 2 2-2 2 2", false),
        "text-bottom" => ("M2 13.5h12M8 2v9M5 8l3 3 3-3", false),
        "line-height" => ("M2 2h12M2 14h12M5 11l3-6 3 6M6 9h4", false),
        "letter-spacing" => ("M1.5 2v12m13-12v12M5 11l3-6 3 6M6 9h4", false),
        "angle" => ("M13 2 3 13h11M6 9l3 4", false),
        "more" => (
            "M4.75 8a1.25 1.25 0 1 1-2.5 0 1.25 1.25 0 1 1 2.5 0ZM9.25 8a1.25 1.25 0 1 1-2.5 0 1.25 1.25 0 1 1 2.5 0ZM13.75 8a1.25 1.25 0 1 1-2.5 0 1.25 1.25 0 1 1 2.5 0Z",
            true,
        ),
        "plus" => ("M8 3v10M3 8h10", false),
        "minus" => ("M2 8h12", false),
        "effect" => ("M8 1l2 5 5 2-5 2-2 5-2-5-5-2 5-2z", false),
        _ => return,
    };
    let extent = match name {
        "plus" | "chevron" | "eye-small" | "eye-off-small" | "styles" | "variable" | "blend" => 12.,
        "more" | "component" | "rotate" | "flip-x" | "flip-y" | "angle" | "hug" | "fixed"
        | "text-height" | "paragraph" | "line-height" | "letter-spacing" | "text-left"
        | "text-right" | "text-center" | "text-justify" | "text-top" | "text-middle"
        | "text-bottom" | "link" | "link-off" => 14.,
        "eye" | "eye-off" => 16.,
        _ => 16.,
    };
    // FigCraft's 16-unit glyph grid quantizes the scale and snaps the origin at device resolution.
    let matrix = canvas.local_to_device_as_3x3();
    let pixels_per_point = matrix.scale_x();
    let k = extent * pixels_per_point / 16.;
    let k = if k >= 1. { (k * 4.).floor() / 4. } else { k };
    let scale = k / pixels_per_point;
    let snap =
        |v: f32, origin: f32| ((v * pixels_per_point + origin).round() - origin) / pixels_per_point;
    let x = snap(
        (r.x + r.width / 2.) as f32 - 8. * scale,
        matrix.translate_x(),
    );
    let y = snap(
        (r.y + r.height / 2.) as f32 - 8. * scale,
        matrix.translate_y(),
    );
    if name == "plus" {
        // One opaque device pixel, centered on the pixel just like the upstream plus mesh.
        let hairline = 1. / f64::from(pixels_per_point);
        let half = hairline / 2.;
        let x = f64::from(snap((r.x + r.width / 2.) as f32, matrix.translate_x())) + half;
        let y = f64::from(snap(
            (r.y + r.height / 2. + 1.) as f32,
            matrix.translate_y(),
        )) + half;
        let reach = f64::from((k * 5.).round()) * hairline + half;
        fill(
            canvas,
            Rect::new(x - reach, y - half, reach * 2., hairline),
            color,
        );
        fill(
            canvas,
            Rect::new(x - half, y - reach, hairline, reach * 2.),
            color,
        );
        return;
    }
    let line = if name == "chevron" {
        1. / k
    } else {
        (k * 0.9).round().max(1.) / k
    };
    canvas.save();
    canvas.translate((x, y));
    canvas.scale((scale, scale));
    let local = Rect::new(0., 0., 16., 16.);
    if name == "boolean" {
        let soft = Color::from_argb(102, color.r(), color.g(), color.b());
        draw_mark(canvas, local, path, soft, PaintStyle::Fill, line);
    }
    draw_mark(
        canvas,
        local,
        path,
        color,
        if filled {
            PaintStyle::Fill
        } else {
            PaintStyle::Stroke
        },
        line,
    );
    if let Some(overlay) = match name {
        "mask" => Some("M8 2.5a5.5 5.5 0 0 1 0 11z"),
        "opacity" => Some("M8 2.5a5.5 5.5 0 0 0 0 11z"),
        "constraints" => Some("M6 6h4v4H6Z"),
        "flip-x" => Some("M9 3l5 10H9Z"),
        "flip-y" => Some("M3 9h10v5Z"),
        "variable" => Some("M9.35 8a1.35 1.35 0 1 0-2.7 0 1.35 1.35 0 1 0 2.7 0Z"),
        _ => None,
    } {
        draw_mark(canvas, local, overlay, color, PaintStyle::Fill, line);
    }
    canvas.restore();
}

fn draw_control(canvas: &Canvas, app: &App, control: &Control, font: &Font) {
    use omc_model::NodeKind;
    let r = control.rect;
    let hovered = app.action_available(&control.action) && r.contains(app.cursor.0, app.cursor.1);
    if matches!(
        control.action,
        Action::Mcp | Action::CopyMcpConfiguration | Action::Collaborate | Action::Collaboration(_)
    ) {
        let primary = matches!(control.action, Action::Collaborate);
        round(
            canvas,
            r,
            if primary {
                COLLABORATE_BLUE
            } else {
                Color::from_rgb(227, 228, 231)
            },
            15.,
        );
        if !primary {
            round(
                canvas,
                Rect::new(r.x + 1., r.y + 1., r.width - 2., r.height - 2.),
                if control.selected || hovered {
                    Color::WHITE
                } else {
                    WORKSPACE
                },
                14.,
            );
        }
        let mut label_font = font.clone();
        label_font.set_size(12.);
        let width = f64::from(label_font.measure_str(&control.label, None).0);
        text(
            canvas,
            &control.label,
            r.x + (r.width - width) / 2.,
            r.y + r.height / 2. + 4.,
            12.,
            if primary {
                Color::WHITE
            } else if app.action_available(&control.action) {
                INK
            } else {
                MUTED
            },
            font,
        );
        if app.focus == control.id && app.keyboard_focus_visible {
            stroke(canvas, r, SELECTED_INK, 1.35);
        }
        return;
    }
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
                        Rect::new(
                            r.x + TAB_LABEL_X,
                            r.y,
                            (r.width - TAB_LABEL_X - TAB_LABEL_RIGHT_PAD).max(0.),
                            r.height,
                        ),
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
    if (61..=63).contains(&control.id) {
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
    if let Action::LayerLock(id) | Action::LayerVisibility(id) = &control.action {
        let interactive = app.action_available(&control.action);
        if !control.selected && !(interactive && layer_actions_revealed(app, control)) {
            return;
        }
        let focused = interactive && app.focus == control.id && app.keyboard_focus_visible;
        if hovered || focused {
            round(canvas, r, Color::from_argb(18, 0, 0, 0), 4.);
        }
        let inherited_lock = matches!(&control.action, Action::LayerLock(_))
            && control.selected
            && app
                .document()
                .and_then(|doc| doc.nodes.get(id))
                .is_some_and(|node| !layer_locked(node));
        let color = if inherited_lock || !interactive {
            Color::from_rgb(161, 161, 161)
        } else {
            MUTED
        };
        match control.action {
            Action::LayerLock(_) => {
                figcraft_chrome::paint_layer_lock(canvas, r, control.selected, color)
            }
            _ => figcraft_chrome::paint_layer_eye(canvas, r, control.selected, color),
        }
        if focused {
            stroke(canvas, r, SELECTED_INK, 1.35);
        }
        return;
    }
    if matches!(control.action, Action::InspectorLayerMenu) {
        if app.focus == control.id && app.keyboard_focus_visible {
            stroke(canvas, r, SELECTED_INK, 1.35);
        }
        return;
    }
    if let Action::InspectorIcon(name, _) = &control.action {
        if control.selected || hovered {
            let frame = Rect::new(r.x + 2., r.y + 2., r.width - 4., r.height - 4.);
            round(canvas, frame, Color::WHITE, 4.);
            if control.selected {
                let mut border = Paint::default();
                border.set_anti_alias(true);
                border.set_color(LINE);
                border.set_style(PaintStyle::Stroke);
                border.set_stroke_width(1.);
                let mut inside = rect(frame);
                inside.inset((0.5, 0.5));
                canvas.draw_round_rect(inside, 3.5, 3.5, &border);
            }
        }
        let secondary = name.starts_with("align-")
            || matches!(
                *name,
                "rotate"
                    | "flip-x"
                    | "flip-y"
                    | "chevron"
                    | "text-height"
                    | "fixed"
                    | "text-left"
                    | "text-center"
                    | "text-right"
                    | "text-justify"
                    | "text-top"
                    | "text-middle"
                    | "text-bottom"
            );
        let ink = if !control.selected
            && (secondary
                || !app.action_available(&control.action)
                    && !matches!(*name, "mask" | "boolean" | "constraints" | "more" | "plus"))
        {
            MUTED
        } else {
            INK
        };
        inspector_glyph(canvas, r, name, ink);
        if app.focus == control.id && app.keyboard_focus_visible {
            stroke(canvas, r, SELECTED_INK, 1.35);
        }
        return;
    }
    if let Action::InspectorChoice(name, _) = &control.action {
        round(canvas, r, INSPECTOR_FIELD, 6.);
        inspector_glyph(canvas, Rect::new(r.x + 5., r.y, 18., r.height), name, MUTED);
        if let Some(value) = control.field_value.as_deref() {
            control_text(
                canvas,
                Rect::new(r.x + 26., r.y, r.width - 42., r.height),
                value,
                0.,
                r.y + 16.,
                11.,
                INK,
                font,
            );
        } else {
            inspector_label(canvas, &control.label, r.x + 26., r.y + 16., 11., INK, font);
        }
        if *name == "hug" {
            inspector_glyph(
                canvas,
                Rect::new(r.x + r.width - 19., r.y, 17., r.height),
                "chevron",
                MUTED,
            );
        }
        return;
    }
    let tool = match control.action {
        Action::Tool(tool) => Some(tool),
        _ => None,
    };
    let background = if control.id == 34 || control.selected && tool.is_some() {
        Some(ACCENT)
    } else if matches!(control.action, Action::Layer(_)) {
        control.selected.then_some(SELECTED)
    } else if control.selected || hovered || control.field_value.is_some() {
        Some(if control.id >= 660_000 && control.field_value.is_some() {
            INSPECTOR_FIELD
        } else {
            WORKSPACE
        })
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
    if matches!(control.action, Action::InspectorZoom) {
        control_text(
            canvas,
            Rect::new(r.x, r.y, r.width - 13., r.height),
            control
                .label
                .strip_prefix("Zoom ")
                .unwrap_or(&control.label),
            9.,
            r.y + 17.,
            11.,
            INK,
            font,
        );
        inspector_glyph(
            canvas,
            Rect::new(r.x + r.width - 14., r.y, 16., r.height),
            "chevron",
            MUTED,
        );
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
        let index = (control.id - LAYER_FIRST) / LAYER_CONTROLS;
        let row = app.layers.get(index as usize);
        let depth = row.map_or(0, |row| row.depth).min(6);
        let node = app.document().and_then(|doc| doc.nodes.get(id));
        let kind = node.map_or(NodeKind::Frame, |n| n.kind.clone());
        let color = if row.is_some_and(|row| row.dimmed) || node.is_some_and(layer_hidden) {
            MUTED
        } else if matches!(kind, NodeKind::Component | NodeKind::Instance) {
            COMPONENT
        } else {
            INK
        };
        if hovered && !control.selected {
            let mut outline = Paint::default();
            outline.set_color(ACCENT);
            outline.set_anti_alias(true);
            outline.set_style(PaintStyle::Stroke);
            canvas.draw_round_rect(
                rect(Rect::new(r.x + 0.5, r.y + 0.5, r.width - 1., r.height - 1.)),
                5.,
                5.,
                &outline,
            );
        }
        let auto_layout = row.is_some_and(|row| row.auto_layout);
        let x = r.x + 18. + depth as f64 * 16.;
        figcraft_chrome::paint_layer_icon(
            canvas,
            &kind,
            auto_layout,
            Rect::new(x, r.y, 16., r.height),
            color,
        );
        let [lock, _] = figcraft_chrome::layer_action_bounds(r);
        control_text(
            canvas,
            Rect::new(x + 21., r.y, (lock.x - 4. - x - 21.).max(0.), r.height),
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
            let indexed_paint = property.contains(':');
            let displayed = crate::inspector::display_value(
                if property.ends_with(":opacity") {
                    "opacity"
                } else {
                    property
                },
                value,
            );
            let mut value: &str = displayed.as_ref();
            let baseline = r.y + r.height * 0.5 + if control.id >= 660_000 { 5. } else { 4. };
            if (matches!(property, "fill" | "stroke") || property.ends_with(":color"))
                && let Some(color) = omc_style::parse_color(value)
            {
                let swatch = Rect::new(r.x + 4., r.y + (r.height - 16.) * 0.5, 16., 16.);
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
                    if control.id >= 660_000 { 11. } else { 12. },
                    INK,
                    font,
                );
                return;
            }
            if value.is_empty() {
                value = "—";
            }
            if indexed_paint {
                fill(
                    canvas,
                    Rect::new(r.x, r.y + 4., 1., r.height - 8.),
                    Color::WHITE,
                );
            }
            let glyph = match property {
                "opacity" => Some("opacity"),
                "rotation" => Some("angle"),
                "lineHeight" => Some("line-height"),
                "letterSpacing" => Some("letter-spacing"),
                _ => None,
            };
            if let Some(glyph) = glyph {
                let value_start = if matches!(property, "opacity" | "rotation") {
                    23.
                } else {
                    25.
                };
                inspector_glyph(
                    canvas,
                    Rect::new(r.x + 4., r.y, 18., r.height),
                    glyph,
                    MUTED,
                );
                control_text(
                    canvas,
                    Rect::new(r.x + value_start, r.y, r.width - value_start - 2., r.height),
                    value,
                    0.,
                    baseline,
                    11.,
                    INK,
                    font,
                );
            } else if let Some(lead) = lead {
                let width = if lead.is_ascii() {
                    lead.len() as f64 * 6.5
                } else {
                    lead.chars().count() as f64 * 10.
                };
                text(canvas, lead, r.x + 8., baseline, 11., MUTED, font);
                let start = (14. + width).max(24.);
                control_text(
                    canvas,
                    Rect::new(r.x + start, r.y, (r.width - start).max(0.), r.height),
                    value,
                    0.,
                    baseline,
                    if control.id >= 660_000 { 11. } else { 12. },
                    INK,
                    font,
                );
            } else {
                let reserved = if matches!(property, "fontFamily" | "fontWeight") {
                    20.
                } else {
                    0.
                };
                control_text(
                    canvas,
                    Rect::new(r.x, r.y, r.width - reserved, r.height),
                    value,
                    8.,
                    baseline,
                    11.,
                    INK,
                    font,
                );
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
        (Action::Inspector(Inspector::Prototype), _) => "프로토타입",
        (Action::Inspector(Inspector::Inspect), _) => "검사",
        (Action::Inspector(Inspector::Assets), _) => "에셋",
        (Action::Inspector(Inspector::Tokens), _) => "변수",
        _ => &control.label,
    };
    if (600_000..600_002).contains(&control.id) {
        inspector_label(canvas, label, r.x + 8., r.y + 16., 11., INK, font);
        return;
    }
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

fn dock_tooltip_label(control: &Control) -> Option<String> {
    use figcraft_chrome::DockGroup;
    let command = if cfg!(target_os = "macos") {
        "⌘"
    } else {
        "Ctrl+"
    };
    let shift = if cfg!(target_os = "macos") {
        "⇧"
    } else {
        "Shift+"
    };
    let label = match &control.action {
        Action::Tool(tool) => format!(
            "{}  {}",
            tool_title(*tool),
            figcraft_chrome::dock_tool_shortcut(*tool)
        ),
        Action::ToolMenu(group) => match group {
            DockGroup::Move => "이동 도구",
            DockGroup::Frame => "프레임 도구",
            DockGroup::Shape => "도형 도구",
            DockGroup::Text => "텍스트 도구",
        }
        .into(),
        Action::Undo => format!("실행 취소  {command}Z"),
        Action::Redo => format!("다시 실행  {command}{shift}Z"),
        Action::Fit => format!("화면에 맞추기  {command}0"),
        _ if (61..=63).contains(&control.id) => control.label.clone(),
        _ => return None,
    };
    Some(label)
}

fn dock_tooltip_target(
    controls: &[Control],
    dock: Rect,
    cursor: (f64, f64),
    focus: Option<u64>,
) -> Option<&Control> {
    let dock_control = |control: &&Control| dock.contains(control.rect.x, control.rect.y);
    controls
        .iter()
        .rev()
        .filter(dock_control)
        .find(|control| control.rect.contains(cursor.0, cursor.1))
        .or_else(|| {
            let focus = focus?;
            controls
                .iter()
                .filter(dock_control)
                .find(|control| control.id == focus)
        })
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
    let design_font = inspector_font().unwrap_or_else(|| font.clone());
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
        let x = panel_x + 12.;
        fill(
            canvas,
            Rect::new(panel_x, HEADER, 1., app.height - HEADER),
            LINE,
        );
        fill(canvas, Rect::new(panel_x, HEADER + 50., RIGHT, 1.), LINE);
        if app.document().is_some() {
            fill(canvas, Rect::new(panel_x, HEADER + 90., RIGHT, 1.), LINE);
            if app.inspector == Inspector::Inspect {
                text(canvas, "검사", x, HEADER + 119., 14., INK, &font);
            } else if let Some(node) = app.node()
                && matches!(app.inspector, Inspector::Design | Inspector::Prototype)
            {
                let label = match node.kind {
                    omc_model::NodeKind::Text => "텍스트",
                    omc_model::NodeKind::Frame => "프레임",
                    omc_model::NodeKind::Rect => "사각형",
                    omc_model::NodeKind::Ellipse => "타원",
                    omc_model::NodeKind::Component => "컴포넌트",
                    omc_model::NodeKind::Instance => "인스턴스",
                    _ => "레이어",
                };
                inspector_label(canvas, label, x, HEADER + 120., 12., INK, &design_font);
            } else if app.inspector == Inspector::Prototype {
                text(canvas, "프로토타입", x, HEADER + 119., 14., INK, &font);
            }
            if let Some(layout) = crate::inspector::design_layout(app) {
                use crate::inspector_design::Decoration;
                let top = crate::inspector::design_body_top(app);
                canvas.save();
                canvas.clip_rect(
                    rect(Rect::new(
                        panel_x,
                        top,
                        RIGHT,
                        (app.height - FOOTER - top).max(0.),
                    )),
                    None,
                    Some(false),
                );
                for item in layout.decorations {
                    match item {
                        Decoration::Rule(y) => fill(canvas, Rect::new(panel_x, y, RIGHT, 1.), LINE),
                        Decoration::Text(bounds, title, muted) => {
                            inspector_label(
                                canvas,
                                title,
                                bounds.x,
                                bounds.y + 12.5,
                                if muted { 10. } else { 11. },
                                if muted { MUTED } else { INK },
                                &design_font,
                            );
                        }
                        Decoration::Segment(r) => round(canvas, r, INSPECTOR_FIELD, 6.),
                    }
                }
                canvas.restore();
            }
            for (label, y) in crate::inspector::sections(app) {
                fill(
                    canvas,
                    Rect::new(panel_x + 1., y - 22., RIGHT - 1., 1.),
                    LINE,
                );
                text(canvas, label, x, y, 12., INK, &font);
            }
            for (bounds, label) in crate::inspector::detail_text(app) {
                control_text(
                    canvas,
                    bounds,
                    &label,
                    0.,
                    bounds.y + 16.,
                    12.,
                    MUTED,
                    &font,
                );
            }
        }
    }
    canvas.save();
    canvas.clip_rect(rect(viewport), None, Some(false));
    if let (Some(frame), Some(scene)) = (app.prototype_frame.as_deref(), app.scene.as_ref()) {
        canvas.translate((
            (viewport.x + app.camera.x) as f32,
            (viewport.y + app.camera.y) as f32,
        ));
        canvas.scale((app.camera.zoom as f32, app.camera.zoom as f32));
        if let Err(error) =
            omc_render::paint_scene_frame(canvas, scene, frame, app.resources.as_ref())
        {
            text(canvas, &error.to_string(), 12., 20., 13., Color::RED, &font);
        }
    } else if let Some(scene) = &app.scene {
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
                if app.inspector == Inspector::Inspect
                    || app.selected.len() != 1
                    || !app.layer_transformable(id)
                    || scene.item(id).is_none_or(|item| {
                        item.world.0[1].abs() > 1e-8
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
    if app.active.is_some()
        && app.active == app.collaboration_document
        && let Some(peers) = app.collaboration["participants"].as_array()
    {
        for peer in peers {
            let cursor = &peer["cursor"];
            if peer["isSelf"] == true || cursor["page"].as_str() != app.page.as_deref() {
                continue;
            }
            let (Some(x), Some(y)) = (cursor["x"].as_f64(), cursor["y"].as_f64()) else {
                continue;
            };
            let x = viewport.x + app.camera.x + x * app.camera.zoom;
            let y = viewport.y + app.camera.y + y * app.camera.zoom;
            if !viewport.contains(x, y) {
                continue;
            }
            draw_mark(
                canvas,
                Rect::new(x - 2., y - 1., 16., 16.),
                "M2 1l11 9-5 .4-2 4z",
                COLLABORATE_BLUE,
                PaintStyle::Fill,
                1.,
            );
            let label = peer["name"].as_str().unwrap_or("Designer");
            let width = (label.chars().count() as f64 * 8. + 14.).min(150.);
            let badge = Rect::new(x + 8., y + 13., width, 19.);
            round(canvas, badge, COLLABORATE_BLUE, 4.);
            control_text(
                canvas,
                badge,
                label,
                6.,
                badge.y + 13.,
                11.,
                Color::WHITE,
                &font,
            );
        }
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
            let font = if (600_000..600_003).contains(&control.id)
                || (660_000..LAYER_FIRST).contains(&control.id)
            {
                &design_font
            } else {
                &font
            };
            draw_control(canvas, app, control, font);
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
        if app.popup == Some(Popup::Collaboration) {
            text(
                canvas,
                "Collaborate",
                menu.x + 14.,
                menu.y + 25.,
                15.,
                INK,
                &font,
            );
            let title = app
                .collaboration_document
                .as_ref()
                .and_then(|id| app.snapshots.get(id))
                .map_or("Join a native OMC document", |doc| doc.title.as_str());
            control_text(
                canvas,
                Rect::new(menu.x + 14., menu.y + 33., menu.width - 28., 20.),
                title,
                0.,
                menu.y + 48.,
                12.,
                INK,
                &font,
            );
            let mode = if app.collaboration_pending {
                "Working…"
            } else {
                match app.collaboration["mode"].as_str() {
                    Some("hosting") => "Hosting · native OMC room",
                    Some("connected") => "Connected · native OMC room",
                    Some("reconnecting") => "Reconnecting…",
                    _ => "Offline · up to four participants",
                }
            };
            text(canvas, mode, menu.x + 14., menu.y + 70., 12., MUTED, &font);
            if let Some(people) = app.collaboration["participants"].as_array()
                && !people.is_empty()
            {
                let names = people
                    .iter()
                    .filter_map(|person| person["name"].as_str())
                    .collect::<Vec<_>>()
                    .join(", ");
                control_text(
                    canvas,
                    Rect::new(menu.x + 14., menu.y + 76., menu.width - 28., 24.),
                    &names,
                    0.,
                    menu.y + 92.,
                    12.,
                    INK,
                    &font,
                );
            }
            if let Some(error) = app
                .error
                .as_deref()
                .or(app.collaboration["message"].as_str())
            {
                control_text(
                    canvas,
                    Rect::new(menu.x + 14., menu.y + 101., menu.width - 28., 22.),
                    error,
                    0.,
                    menu.y + 117.,
                    11.,
                    INK,
                    &font,
                );
            }
        }
        if app.popup == Some(Popup::Mcp) {
            text(
                canvas,
                "Connect your agent",
                menu.x + 14.,
                menu.y + 25.,
                15.,
                INK,
                &font,
            );
            let status = if !app.service_connected {
                "Connecting to the workspace service…"
            } else if app.mcp_configuration().is_err() {
                "MCP CLI missing from this build"
            } else {
                "Local stdio connection · current profile"
            };
            text(
                canvas,
                status,
                menu.x + 14.,
                menu.y + 51.,
                12.,
                MUTED,
                &font,
            );
        }
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
    } else if app.popup.is_none()
        && app.drag.is_none()
        && let Some(dock) = palette_rect(app)
        && let Some(control) = dock_tooltip_target(
            &app.controls,
            dock,
            app.cursor,
            app.keyboard_focus_visible.then_some(app.focus),
        )
        && let Some(label) = dock_tooltip_label(control)
    {
        let layout = crate::text_ui::layout(&label, 12., INK, 1000.);
        let width = layout.as_ref().map_or_else(
            || label.chars().count() as f64 * 12.,
            |text| text.intrinsic_width,
        );
        let tip = figcraft_chrome::dock_tooltip(dock, control.rect, viewport, width);
        figcraft_chrome::paint_dock_tooltip(canvas, tip);
        if let Some(layout) = layout {
            layout.paint(
                canvas,
                tip.x + 9.,
                tip.y + (tip.height - layout.height) / 2.,
            );
        } else {
            control_text(canvas, tip, &label, 9., tip.y + 19., 12., INK, &font);
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
    let (_, _, bytes) = screenshot_png(app)?;
    std::fs::write(path, bytes.as_bytes()).map_err(|e| e.to_string())
}

pub fn screenshot_png(app: &App) -> Result<(u32, u32, skia_safe::Data), String> {
    let window = app.window.as_ref().ok_or("No native window")?;
    let size = window.inner_size();
    if u64::from(size.width) * u64::from(size.height) > 16_777_216 {
        return Err("Native window exceeds the screenshot pixel limit.".into());
    }
    let mut surface = render(app, size.width, size.height, window.scale_factor(), false)?;
    let image = surface.image_snapshot();
    let bytes = image
        .encode(None, skia_safe::EncodedImageFormat::PNG, None)
        .ok_or("PNG encoding failed")?;
    Ok((size.width, size.height, bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dock_tooltips_follow_pointer_then_keyboard_focus_and_clear_on_leave() {
        let viewport = Rect::new(292., 40., 432., 600.);
        let dock = figcraft_chrome::dock_rect(viewport).unwrap();
        let (group, button, caret) = figcraft_chrome::dock_groups(dock).next().unwrap();
        let controls = [
            Control {
                id: 20,
                rect: button,
                label: "Select".into(),
                action: Action::Tool(Tool::Select),
                selected: false,
                field_value: None,
            },
            Control {
                id: 80,
                rect: caret,
                label: "Move tools".into(),
                action: Action::ToolMenu(group),
                selected: false,
                field_value: None,
            },
            Control {
                id: 30,
                rect: figcraft_chrome::dock_utilities(dock)[0],
                label: "Undo".into(),
                action: Action::Undo,
                selected: false,
                field_value: None,
            },
            Control {
                id: 62,
                rect: figcraft_chrome::dock_modes(dock)[1],
                label: "프로토타입".into(),
                action: Action::Inspector(Inspector::Prototype),
                selected: false,
                field_value: None,
            },
        ];
        for control in &controls {
            let cursor = (control.rect.x + 1., control.rect.y + 1.);
            let target = dock_tooltip_target(&controls, dock, cursor, Some(20)).unwrap();
            assert_eq!(target.id, control.id);
            assert!(dock_tooltip_label(target).is_some_and(|label| !label.is_empty()));
        }
        assert_eq!(
            dock_tooltip_target(&controls, dock, (-1., -1.), Some(30)).map(|control| control.id),
            Some(30)
        );
        assert!(dock_tooltip_target(&controls, dock, (-1., -1.), None).is_none());
    }

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
