use super::{
    ACCENT, ACCENT_HOVER, INK, LINE, MUTED, WORKSPACE, control_text, fill, mark, rect, round,
    selection_background, selection_ink, stroke, text,
};
use crate::app::{Action, App, Control, HEADER, HomeAction, HomeMenu, HomeView};
use crate::geometry::Rect;
use skia_safe::{Canvas, ClipOp, Color, CubicResampler, Font, Paint, RRect};
use std::{
    ops::Range,
    time::{SystemTime, UNIX_EPOCH},
};

pub(crate) const LIBRARY_CARD_FIRST: u64 = 1 << 40;
pub(crate) const LIBRARY_CARD_END: u64 = LIBRARY_CARD_FIRST + 1_000_000;
pub(super) const FIRST: u64 = LIBRARY_CARD_FIRST - 4_000_000;
const SECONDARY: u64 = FIRST + 1_000_000;
const MENU: u64 = super::POPUP_FIRST + 10_000;
const GAP: f64 = 24.;
const PADDING: f64 = 30.;
const FOOT: f64 = 56.;
const ROW: f64 = 34.;

const SEARCH: &str = "M11 11l4 4M12 7a5 5 0 1 1-10 0 5 5 0 0 1 10 0Z";
const CLOCK: &str = "M15 8a7 7 0 1 1-14 0 7 7 0 0 1 14 0ZM8 3v5l3 2";
const FOLDER: &str = "M1 4h5l2 2h7v7H1Z";
const TRASH: &str = "M2 4h12M6 4V2h4v2M4 5l1 9h6l1-9M7 7v4m2-4v4";
const STAR: &str = "M8 1l2.1 4.4 4.9.7-3.5 3.4.8 4.8L8 12l-4.3 2.3.8-4.8L1 6.1l4.9-.7Z";
const FILE: &str = "M4 1h5l4 4v10H4ZM9 1v5h4";
const MORE: &str = "M3 8h.1M8 8h.1M13 8h.1";
const RESTORE: &str = "M1 8h4M1 8V4m0 4a7 7 0 1 1 3 5";

pub(crate) struct LibraryGrid {
    pub area: Rect,
    pub columns: usize,
    pub visible_rows: usize,
    pub count: usize,
    pub max_scroll: f64,
    pub row_stride: f64,
    width: f64,
    height: f64,
}
impl LibraryGrid {
    fn new(width: f64, height: f64, count: usize) -> Self {
        let x = sidebar_width(width) + PADDING;
        let y = HEADER + 104.;
        let area = Rect::new(
            x,
            y,
            (width - x - PADDING).max(1.),
            (height - y - 12.).max(1.),
        );
        let columns = (((area.width + GAP) / (255. + GAP)).floor() as usize).clamp(1, 3);
        let width = (area.width - (columns - 1) as f64 * GAP) / columns as f64;
        let height = width * 9. / 16. + FOOT;
        let row_stride = height + GAP;
        let visible_rows = (area.height / row_stride).floor().max(1.) as usize;
        let content = (count.div_ceil(columns) as f64 * row_stride - GAP).max(0.);
        Self {
            area,
            columns,
            visible_rows,
            count,
            max_scroll: (content - area.height).max(0.),
            row_stride,
            width,
            height,
        }
    }
    pub fn visible_range(&self, scroll: f64) -> Range<usize> {
        let y = scroll.clamp(0., self.max_scroll);
        let first = (y / self.row_stride).floor() as usize * self.columns;
        let end = ((y + self.area.height) / self.row_stride).ceil() as usize * self.columns;
        first.min(self.count)..end.min(self.count)
    }
    pub fn reveal(&self, index: usize, scroll: f64) -> f64 {
        let top = (index / self.columns) as f64 * self.row_stride;
        let minimum = (top + self.height - self.area.height).min(top);
        scroll.clamp(minimum, top).clamp(0., self.max_scroll)
    }
    fn card(&self, index: usize, scroll: f64) -> Rect {
        Rect::new(
            self.area.x + (index % self.columns) as f64 * (self.width + GAP),
            self.area.y + (index / self.columns) as f64 * self.row_stride
                - scroll.clamp(0., self.max_scroll),
            self.width,
            self.height,
        )
    }
}
fn sidebar_width(width: f64) -> f64 {
    if width < 900. { 190. } else { 240. }
}
fn visible_folders(app: &App) -> impl Iterator<Item = &crate::client::FolderEntry> {
    let query = app.home_query().trim().to_lowercase();
    app.home_folders
        .iter()
        .filter(move |folder| query.is_empty() || folder.title.to_lowercase().contains(&query))
}
pub(crate) fn library_grid(app: &App) -> LibraryGrid {
    PaintLayout::new(app).grid
}
pub(super) struct PaintLayout<'a> {
    grid: LibraryGrid,
    docs: Vec<&'a crate::client::DocumentEntry>,
}
impl<'a> PaintLayout<'a> {
    pub(super) fn new(app: &'a App) -> Self {
        let docs = app.home_documents();
        let count = if matches!(app.home_view, HomeView::Folders) {
            visible_folders(app).count()
        } else {
            docs.len()
        };
        let grid = LibraryGrid::new(app.width, app.height, count);
        Self { grid, docs }
    }
}
pub(super) fn is_control(id: u64) -> bool {
    (FIRST..LIBRARY_CARD_END).contains(&id)
}
pub(super) fn is_menu_control(id: u64) -> bool {
    id >= MENU
}
fn clipped(a: Rect, b: Rect) -> Option<Rect> {
    let x = a.x.max(b.x);
    let y = a.y.max(b.y);
    let right = (a.x + a.width).min(b.x + b.width);
    let bottom = (a.y + a.height).min(b.y + b.height);
    (right > x && bottom > y).then(|| Rect::new(x, y, right - x, bottom - y))
}
fn label<'a>(app: &App, value: &'a str) -> &'a str {
    crate::localization::label(&app.interface_language, value)
}
fn is_folder_view(app: &App) -> bool {
    matches!(app.home_view, HomeView::Folders | HomeView::Folder(_))
}
fn menu_box(app: &App) -> Rect {
    let moving = matches!(app.home_menu, Some(HomeMenu::Move(_)));
    let width = if moving { 340. } else { 280. };
    let height = if moving {
        (98. + ROW * (1 + app.home_folders.len()) as f64).min(app.height - 92.)
    } else {
        144.
    };
    Rect::new(
        (app.width - width) / 2.,
        (app.height - height) / 2.,
        width,
        height,
    )
}
fn menu_list(panel: Rect) -> Rect {
    Rect::new(
        panel.x + 12.,
        panel.y + 54.,
        panel.width - 24.,
        panel.height - 66.,
    )
}
pub(crate) fn library_move_scroll_max(app: &App) -> f64 {
    ((1 + app.home_folders.len()) as f64 * ROW - menu_list(menu_box(app)).height).max(0.)
}

pub(super) fn controls(
    app: &App,
    mut add: impl FnMut(u64, Rect, String, Action, bool, Option<String>),
) {
    let side = sidebar_width(app.width);
    let open = |kind| Action::Home(HomeAction::View(kind));
    add(
        FIRST,
        Rect::new(16., HEADER + 57., side - 32., 34.),
        label(app, "Search canvases").into(),
        Action::Home(HomeAction::Search),
        false,
        Some(app.home_search.clone()),
    );
    for (i, (name, view)) in [
        ("Recents", HomeView::Recents),
        ("All folders", HomeView::Folders),
        ("Trash", HomeView::Trash),
        ("Starred", HomeView::Starred),
    ]
    .into_iter()
    .enumerate()
    {
        let selected = app.home_view == view
            || matches!(
                (&app.home_view, &view),
                (HomeView::Folder(_), HomeView::Folders)
            );
        add(
            FIRST + 1 + i as u64,
            Rect::new(12., HEADER + 105. + i as f64 * 37., side - 24., 33.),
            label(app, name).into(),
            open(view),
            selected,
            None,
        );
    }
    let shortcut_rows = ((app.height - HEADER - 277.) / 30.).max(0.) as usize;
    for (i, doc) in app
        .documents
        .iter()
        .filter(|d| d.starred && !d.trashed && !d.archived)
        .take(shortcut_rows)
        .enumerate()
    {
        add(
            FIRST + 64 + i as u64,
            Rect::new(12., HEADER + 277. + i as f64 * 30., side - 24., 29.),
            doc.title.clone(),
            Action::Open(doc.id.clone()),
            false,
            None,
        );
    }
    let right = app.width - PADDING;
    if !matches!(app.home_view, HomeView::Trash) {
        let (title, action) = if is_folder_view(app) {
            ("New folder", Action::Home(HomeAction::NewFolder))
        } else {
            ("New canvas", Action::New)
        };
        let drafting = is_folder_view(app) && app.home_folder_draft();
        let input = if drafting { Some(String::new()) } else { None };
        let width = if drafting { 168. } else { 111. };
        add(
            FIRST + 8,
            Rect::new(
                right - width - if drafting { 75. } else { 0. },
                HEADER + 26.,
                width,
                32.,
            ),
            label(app, if drafting { "Folder name" } else { title }).into(),
            action,
            false,
            input,
        );
        if drafting {
            add(
                FIRST + 10,
                Rect::new(right - 68., HEADER + 26., 68., 32.),
                label(app, "Create").into(),
                Action::Home(HomeAction::CommitFolder),
                false,
                None,
            );
        } else {
            add(
                FIRST + 9,
                Rect::new(right - 210., HEADER + 26., 89., 32.),
                label(app, "Open file").into(),
                Action::Import,
                false,
                None,
            );
        }
    }
    let layout = PaintLayout::new(app);
    let grid = &layout.grid;
    let visible = grid.visible_range(app.library_scroll);
    if matches!(app.home_view, HomeView::Folders) {
        for (i, folder) in visible_folders(app)
            .enumerate()
            .skip(visible.start)
            .take(visible.len())
        {
            if let Some(r) = clipped(grid.card(i, app.library_scroll), grid.area) {
                add(
                    LIBRARY_CARD_FIRST + i as u64,
                    r,
                    folder.title.clone(),
                    open(HomeView::Folder(folder.id.clone())),
                    false,
                    None,
                );
            }
        }
    } else {
        for i in visible {
            let doc = layout.docs[i];
            let full = grid.card(i, app.library_scroll);
            if let Some(r) = clipped(full, grid.area) {
                let action = if doc.trashed {
                    HomeAction::Restore(doc.id.clone())
                } else {
                    HomeAction::Menu(doc.id.clone())
                };
                let card_action = if doc.trashed {
                    Action::Home(action.clone())
                } else {
                    Action::Open(doc.id.clone())
                };
                add(
                    LIBRARY_CARD_FIRST + i as u64,
                    r,
                    doc.title.clone(),
                    card_action,
                    false,
                    None,
                );
                let y = full.y + full.height - 42.;
                if !doc.trashed
                    && let Some(r) =
                        clipped(Rect::new(full.x + full.width - 63., y, 26., 28.), grid.area)
                {
                    add(
                        SECONDARY + i as u64 * 2,
                        r,
                        format!(
                            "{} {}",
                            label(
                                app,
                                if doc.starred {
                                    "Remove star from"
                                } else {
                                    "Star"
                                }
                            ),
                            doc.title
                        ),
                        Action::Home(HomeAction::Star(doc.id.clone())),
                        doc.starred,
                        None,
                    );
                }
                if let Some(r) =
                    clipped(Rect::new(full.x + full.width - 33., y, 26., 28.), grid.area)
                {
                    add(
                        SECONDARY + i as u64 * 2 + 1,
                        r,
                        format!(
                            "{} {}",
                            label(
                                app,
                                if doc.trashed {
                                    "Restore"
                                } else {
                                    "Actions for"
                                }
                            ),
                            doc.title
                        ),
                        Action::Home(action),
                        false,
                        None,
                    );
                }
            }
        }
    }
    if let Some(menu) = &app.home_menu {
        add(
            MENU,
            Rect::new(0., HEADER, app.width, app.height - HEADER),
            label(app, "Dismiss menu").into(),
            Action::ClosePopup,
            false,
            None,
        );
        let panel = menu_box(app);
        let content = menu_list(panel);
        match menu {
            HomeMenu::Actions(id) => {
                let rows = [
                    ("Move to folder", HomeAction::Move(id.clone())),
                    ("Move to Trash", HomeAction::Trash(id.clone())),
                ];
                for (i, (title, action)) in rows.into_iter().enumerate() {
                    add(
                        MENU + 1 + i as u64,
                        Rect::new(content.x, content.y + i as f64 * ROW, content.width, ROW),
                        label(app, title).into(),
                        Action::Home(action),
                        false,
                        None,
                    );
                }
            }
            HomeMenu::Move(id) => {
                let scroll = app.home_menu_scroll.clamp(0., library_move_scroll_max(app));
                for (i, (name, folder)) in std::iter::once((label(app, "Local workspace"), None))
                    .chain(
                        app.home_folders
                            .iter()
                            .map(|f| (f.title.as_str(), Some(f.id.clone()))),
                    )
                    .enumerate()
                {
                    let region = Rect::new(
                        content.x,
                        content.y + i as f64 * ROW - scroll,
                        content.width,
                        ROW,
                    );
                    if let Some(region) = clipped(region, content) {
                        add(
                            MENU + 1 + i as u64,
                            region,
                            name.into(),
                            Action::Home(HomeAction::MoveTo(id.clone(), folder)),
                            false,
                            None,
                        );
                    }
                }
            }
        }
    }
}

pub(super) fn background(canvas: &Canvas, app: &App, layout: &PaintLayout, font: &Font) {
    let side = sidebar_width(app.width);
    fill(
        canvas,
        Rect::new(0., HEADER, side, app.height - HEADER),
        Color::from_rgb(251, 251, 252),
    );
    fill(
        canvas,
        Rect::new(side - 1., HEADER, 1., app.height - HEADER),
        LINE,
    );
    text(
        canvas,
        label(app, "Local workspace"),
        22.,
        HEADER + 31.,
        15.,
        INK,
        font,
    );
    fill(canvas, Rect::new(16., HEADER + 260., side - 32., 1.), LINE);
    text(
        canvas,
        label(app, "Starred shortcuts"),
        22.,
        HEADER + 273.,
        11.,
        MUTED,
        font,
    );
    let grid = &layout.grid;
    let heading = match &app.home_view {
        HomeView::Recents => label(app, "Recents"),
        HomeView::Folders => label(app, "All folders"),
        HomeView::Trash => label(app, "Trash"),
        HomeView::Starred => label(app, "Starred"),
        HomeView::Folder(id) => app
            .home_folders
            .iter()
            .find(|f| &f.id == id)
            .map_or(label(app, "All folders"), |f| &f.title),
    };
    let title_width =
        (grid.area.width - if app.home_folder_draft() { 260. } else { 225. }).max(95.);
    control_text(
        canvas,
        Rect::new(grid.area.x, HEADER + 16., title_width, 35.),
        heading,
        0.,
        HEADER + 48.,
        25.,
        INK,
        font,
    );
    let summary = format!(
        "{} {}",
        grid.count,
        label(
            app,
            if matches!(app.home_view, HomeView::Folders) {
                "folders"
            } else {
                "canvases"
            }
        )
    );
    text(
        canvas,
        &summary,
        grid.area.x,
        HEADER + 80.,
        12.,
        MUTED,
        font,
    );
    fill(
        canvas,
        Rect::new(side, grid.area.y - 15., app.width - side, 1.),
        LINE,
    );
    if grid.count == 0 {
        let hint = if !app.service_connected {
            "Loading canvases…"
        } else if !app.home_query().is_empty() {
            "No matches."
        } else {
            match app.home_view {
                HomeView::Trash => "Trash is empty.",
                HomeView::Starred => "No starred canvases.",
                HomeView::Folders => "No folders yet.",
                _ => "No canvases yet.",
            }
        };
        text(
            canvas,
            label(app, hint),
            grid.area.x,
            grid.area.y + 24.,
            14.,
            MUTED,
            font,
        );
    }
    if grid.max_scroll > 0. {
        let thumb = (grid.area.height * grid.area.height / (grid.area.height + grid.max_scroll))
            .max(20.)
            .min(grid.area.height);
        let fraction = app.library_scroll.clamp(0., grid.max_scroll) / grid.max_scroll;
        round(
            canvas,
            Rect::new(
                app.width - 11.,
                grid.area.y + (grid.area.height - thumb) * fraction,
                4.,
                thumb,
            ),
            Color::from_rgb(180, 181, 186),
            2.,
        );
    }
}

fn edited(app: &App, time: i64) -> String {
    if time <= 0 {
        return label(app, "Local canvas").into();
    }
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as i64);
    let days = now.saturating_sub(time) / 86_400_000;
    if days <= 0 {
        return label(app, "Edited today").into();
    }
    if app.interface_language == "ko" {
        format!("{days}일 전 수정")
    } else if days == 1 {
        "Edited yesterday".into()
    } else {
        format!("Edited {days} days ago")
    }
}
pub(super) fn draw(canvas: &Canvas, app: &App, layout: &PaintLayout, c: &Control, font: &Font) {
    let focused = c.id == app.focus && app.keyboard_focus_visible;
    let hover = app.action_available(&c.action) && c.rect.contains(app.cursor.0, app.cursor.1);
    let r = c.rect;
    if c.id == MENU {
        let panel = menu_box(app);
        let mut shade = Paint::default();
        shade.set_color(Color::from_argb(70, 0, 0, 0));
        canvas.draw_rect(rect(r), &shade);
        round(canvas, panel, Color::WHITE, 12.);
        stroke(canvas, panel, LINE, 1.);
        let title = if matches!(app.home_menu, Some(HomeMenu::Move(_))) {
            "Move to folder"
        } else {
            "Canvas actions"
        };
        text(
            canvas,
            label(app, title),
            panel.x + 16.,
            panel.y + 30.,
            17.,
            INK,
            font,
        );
        return;
    }
    if c.id >= MENU + 1 {
        if hover || focused {
            round(canvas, r, selection_background(), 6.);
        }
        let tint = if matches!(c.action, Action::Home(HomeAction::Trash(_))) {
            Color::from_rgb(185, 28, 28)
        } else {
            INK
        };
        control_text(
            canvas,
            r,
            &c.label,
            10.,
            r.y + (r.height + 9.) / 2.,
            13.,
            tint,
            font,
        );
        return;
    }
    if (LIBRARY_CARD_FIRST..LIBRARY_CARD_END).contains(&c.id) {
        let grid = &layout.grid;
        let index = (c.id - LIBRARY_CARD_FIRST) as usize;
        let card = grid.card(index, app.library_scroll);
        let preview = Rect::new(card.x, card.y, card.width, card.height - FOOT);
        let doc = layout.docs.get(index).copied();
        canvas.save();
        canvas.clip_rect(rect(grid.area), ClipOp::Intersect, false);
        canvas.clip_rrect(
            RRect::new_rect_xy(rect(card), 12., 12.),
            ClipOp::Intersect,
            true,
        );
        fill(canvas, card, Color::WHITE);
        fill(canvas, preview, WORKSPACE);
        if let Some(image) = doc.and_then(|d| app.home_thumbnail(d)) {
            let scale = ((preview.width - 20.) / f64::from(image.width()))
                .min((preview.height - 14.) / f64::from(image.height()));
            let (w, h) = (
                f64::from(image.width()) * scale,
                f64::from(image.height()) * scale,
            );
            canvas.draw_image_rect_with_sampling_options(
                image,
                None,
                rect(Rect::new(
                    preview.x + (preview.width - w) / 2.,
                    preview.y + (preview.height - h) / 2.,
                    w,
                    h,
                )),
                CubicResampler::mitchell(),
                &Paint::default(),
            );
        } else {
            mark(
                canvas,
                preview,
                if doc.is_some() { FILE } else { FOLDER },
                MUTED,
            );
        }
        fill(
            canvas,
            Rect::new(card.x, preview.y + preview.height, card.width, 1.),
            LINE,
        );
        mark(
            canvas,
            Rect::new(card.x + 12., preview.y + preview.height + 14., 24., 24.),
            if doc.is_some() { FILE } else { FOLDER },
            ACCENT,
        );
        let title = Rect::new(
            card.x + 43.,
            preview.y + preview.height + 3.,
            (card.width - 43. - if doc.is_some() { 68. } else { 10. }).max(1.),
            21.,
        );
        control_text(canvas, title, &c.label, 0., title.y + 17., 14., INK, font);
        let metadata = doc.map_or_else(
            || label(app, "Folder").into(),
            |d| edited(app, d.updated_at_ms),
        );
        let details = Rect::new(title.x, title.y + 20., title.width, 19.);
        control_text(
            canvas,
            details,
            &metadata,
            0.,
            details.y + 15.,
            11.,
            MUTED,
            font,
        );
        canvas.restore();
        canvas.save();
        canvas.clip_rect(rect(grid.area), ClipOp::Intersect, false);
        let mut border = Paint::default();
        border
            .set_anti_alias(true)
            .set_style(super::PaintStyle::Stroke)
            .set_stroke_width(if focused { 2. } else { 1. });
        border.set_color(crate::theme::color(if focused || hover {
            ACCENT
        } else {
            LINE
        }));
        canvas.draw_round_rect(rect(card), 12., 12., &border);
        canvas.restore();
        return;
    }
    if c.id >= SECONDARY {
        if hover || focused || c.selected {
            round(canvas, r, selection_background(), 6.);
        }
        let glyph = match &c.action {
            Action::Home(HomeAction::Star(_)) => STAR,
            Action::Home(HomeAction::Restore(_)) => RESTORE,
            _ => MORE,
        };
        if c.selected && glyph == STAR {
            super::draw_mark(canvas, r, glyph, ACCENT, super::PaintStyle::Fill, 1.35);
        } else {
            mark(
                canvas,
                r,
                glyph,
                if focused || hover {
                    selection_ink()
                } else {
                    MUTED
                },
            );
        }
    } else if let Some(value) = c.field_value.as_ref() {
        round(canvas, r, WORKSPACE, 6.);
        if focused {
            stroke(canvas, r, ACCENT, 1.3);
        }
        let search = c.id == FIRST;
        if search {
            mark(
                canvas,
                Rect::new(r.x + 6., r.y, 21., r.height),
                SEARCH,
                MUTED,
            );
        }
        let editing = if search {
            app.home_editing_text().is_some() && !app.home_folder_draft()
        } else {
            app.home_folder_draft()
        };
        if !editing {
            let caption = if value.is_empty() { &c.label } else { value };
            control_text(
                canvas,
                r,
                caption,
                if search { 32. } else { 9. },
                r.y + 22.,
                12.,
                if value.is_empty() { MUTED } else { INK },
                font,
            );
        }
    } else if matches!(c.id, id if id == FIRST + 8 || id == FIRST + 9 || id == FIRST + 10) {
        let primary = c.id != FIRST + 9;
        round(
            canvas,
            r,
            if primary {
                if hover { ACCENT_HOVER } else { ACCENT }
            } else if hover {
                WORKSPACE
            } else {
                Color::WHITE
            },
            6.,
        );
        if focused || !primary {
            stroke(canvas, r, if focused { selection_ink() } else { LINE }, 1.);
        }
        let _foreground = primary.then(|| crate::theme::enter(false));
        control_text(
            canvas,
            r,
            &c.label,
            11.,
            r.y + 21.,
            13.,
            if primary { Color::WHITE } else { INK },
            font,
        );
    } else {
        if hover || focused || c.selected {
            round(
                canvas,
                r,
                if c.selected || focused {
                    selection_background()
                } else {
                    WORKSPACE
                },
                6.,
            );
        }
        let icon = match c.id - FIRST {
            1 => CLOCK,
            2 => FOLDER,
            3 => TRASH,
            4 => STAR,
            _ => FILE,
        };
        let tint = if c.selected || focused {
            selection_ink()
        } else {
            INK
        };
        mark(canvas, Rect::new(r.x + 6., r.y, 24., r.height), icon, tint);
        control_text(
            canvas,
            r,
            &c.label,
            35.,
            r.y + (r.height + 9.) / 2.,
            13.,
            tint,
            font,
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn fractional_offsets_move_cards_and_keep_partial_rows() {
        let grid = LibraryGrid::new(1440., 850., 30);
        assert_eq!(grid.columns, 3);
        assert!((grid.card(0, 0.).y - grid.card(0, 0.5).y - 0.5).abs() < f64::EPSILON);
        assert_eq!(grid.visible_range(grid.row_stride - 2.).start, 0);
        assert_eq!(grid.visible_range(grid.row_stride).start, 3);
        assert!(grid.visible_range(grid.reveal(29, 0.)).contains(&29));
        assert_eq!(LibraryGrid::new(760., 520., 2).columns, 1);
    }
}
