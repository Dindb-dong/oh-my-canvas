use crate::{
    app::{Action, App, Control, FOOTER, HEADER, Inspector, Popup, RIGHT},
    geometry::Rect,
};
use omc_model::NodeKind;
use serde_json::Value;
use std::borrow::Cow;

fn computed_field(item: &omc_scene::SceneItem, property: &str) -> Option<String> {
    let name = match property {
        "fontFamily" => "font-family",
        "fontSize" => "font-size",
        "fontWeight" => "font-weight",
        "lineHeight" => "line-height",
        "letterSpacing" => "letter-spacing",
        "textAlign" => "text-align",
        "fill" if item.kind == NodeKind::Text => "color",
        "fill" => "background-color",
        "stroke" => "border-color",
        "strokeWidth" => "border-width",
        "cornerRadius" => "border-radius",
        "opacity" => "opacity",
        _ => return None,
    };
    let value = item.style.get(name)?;
    Some(match (property, value) {
        ("fontWeight", "normal") => "400".into(),
        ("fontWeight", "bold") => "700".into(),
        ("fontSize" | "lineHeight" | "letterSpacing" | "strokeWidth" | "cornerRadius", _) => {
            value.strip_suffix("px").unwrap_or(value).into()
        }
        _ => value.into(),
    })
}

// FigCraft v0.17.0 (5bc71c1), crates/ui-egui/src/widgets.rs:
// compact numeric grid, col_width, and section_header_resp. MIT notice in docs/licensing/.
const ROW_H: f64 = 32.;
const FIELD_H: f64 = 24.;
const PAD: f64 = 16.;
const PAD_RIGHT: f64 = 8.;
const SECTION_H: f64 = 40.;
const TAB_BAR_BOTTOM: f64 = HEADER + 90.;
const SELECTION_HEADER_H: f64 = 46.;
const ZOOM_ID: u64 = 600_002;
const ZOOM_CHOICES: [f64; 3] = [0.5, 1., 2.];

// FigCraft v0.17.0 panels/right.rs puts Design and Prototype before the zoom menu.
const TABS: [(&str, Inspector, f64); 2] = [
    ("Design", Inspector::Design, 45.),
    ("Prototype", Inspector::Prototype, 72.),
];

pub fn field_lead(property: &str) -> Option<&'static str> {
    match property {
        "x" => Some("X"),
        "y" => Some("Y"),
        "width" => Some("W"),
        "height" => Some("H"),
        "rotation" => Some("∠"),
        "opacity" => Some("◐"),
        "cornerRadius" => Some("반경"),
        "lineHeight" => Some("행간"),
        "letterSpacing" => Some("자간"),
        "textAlign" => Some("정렬"),
        "strokeWidth" => Some("폭"),
        "name" => Some("이름"),
        _ => None,
    }
}

fn compact_number(value: f64) -> String {
    let value = if value.abs() < 0.005 { 0. } else { value };
    format!("{value:.2}")
        .trim_end_matches('0')
        .trim_end_matches('.')
        .to_owned()
}

pub fn display_value<'a>(property: &str, raw: &'a str) -> Cow<'a, str> {
    let number = || raw.parse::<f64>().ok().filter(|n| n.is_finite());
    let display = match property {
        "opacity" => number().map(|value| format!("{}%", compact_number(value * 100.))),
        "rotation" => number().map(|value| format!("{}°", compact_number(value))),
        "fontWeight" => match number() {
            Some(100.) => return Cow::Borrowed("Thin"),
            Some(200.) => return Cow::Borrowed("Extra Light"),
            Some(300.) => return Cow::Borrowed("Light"),
            Some(400.) => return Cow::Borrowed("Regular"),
            Some(500.) => return Cow::Borrowed("Medium"),
            Some(600.) => return Cow::Borrowed("Semibold"),
            Some(700.) => return Cow::Borrowed("Bold"),
            Some(800.) => return Cow::Borrowed("Extra Bold"),
            Some(900.) => return Cow::Borrowed("Black"),
            _ => number().map(compact_number),
        },
        "lineHeight" if raw.is_empty() || raw == "normal" => return Cow::Borrowed("Auto"),
        "letterSpacing" if raw.is_empty() || raw == "normal" || number() == Some(0.) => {
            return Cow::Borrowed("0%");
        }
        "fill" | "stroke" if raw.is_empty() => return Cow::Borrowed("없음"),
        "x" | "y" | "width" | "height" | "fontSize" | "lineHeight" | "letterSpacing"
        | "strokeWidth" | "cornerRadius" => number().map(compact_number),
        _ => None,
    };
    display.map(Cow::Owned).unwrap_or(Cow::Borrowed(raw))
}

fn body_y(app: &App) -> f64 {
    if app.inspector_scroll == 0. {
        return body_top(app);
    }
    body_top(app) - scroll_offset(app.inspector_scroll, scroll_extent(app))
}

fn body_top(app: &App) -> f64 {
    if (app.inspector == Inspector::Design && app.node().is_some())
        || matches!(app.inspector, Inspector::Inspect | Inspector::Prototype)
    {
        TAB_BAR_BOTTOM + SELECTION_HEADER_H
    } else {
        TAB_BAR_BOTTOM
    }
}

fn catalog_namespace(tab: Inspector) -> Option<&'static str> {
    match tab {
        Inspector::Assets => Some("styles"),
        Inspector::Tokens => Some("tokens"),
        _ => None,
    }
}

fn scroll_extent(app: &App) -> f64 {
    let Some(doc) = app.document().filter(|_| app.inspector_visible()) else {
        return 0.;
    };
    let height = if let Some(namespace) = catalog_namespace(app.inspector) {
        let entities = omc_style::catalog_entities(doc, namespace);
        SECTION_H + (1. + 2. * entities.len() as f64) * ROW_H
    } else if app.inspector == Inspector::Design && app.node().is_some() {
        crate::inspector_design::compose(app, 0., 0.).map_or(0., |layout| layout.height)
    } else {
        section_height_for_rows(detail_rows(app).len())
    };
    (height - (app.height - FOOTER - body_top(app)).max(0.)).max(0.)
}

fn scroll_offset(offset: f64, extent: f64) -> f64 {
    offset.clamp(0., extent)
}

pub fn max_scroll(app: &App) -> f64 {
    scroll_extent(app)
}

pub fn scrollbar(app: &App) -> Option<Rect> {
    let top = body_top(app);
    let height = app.height - FOOTER - top;
    let extent = max_scroll(app);
    if height <= 24. || extent <= 0. || app.cursor.0 < app.width - RIGHT {
        return None;
    }
    let thumb = (height * height / (height + extent)).max(18.);
    let y = top + (height - thumb) * scroll_offset(app.inspector_scroll, extent) / extent;
    Some(Rect::new(app.width - 5., y, 3., thumb))
}

pub fn sections(app: &App) -> Vec<(&'static str, f64)> {
    if !app.inspector_visible() || app.document().is_none() {
        return Vec::new();
    }
    let top = body_top(app);
    let y = body_y(app);
    if matches!(app.inspector, Inspector::Assets | Inspector::Tokens) {
        let label = if app.inspector == Inspector::Assets {
            "로컬 스타일"
        } else {
            "변수"
        };
        return (y >= top).then_some((label, y + 22.)).into_iter().collect();
    }
    let label = match app.inspector {
        Inspector::Design if app.node().is_none() => "페이지",
        Inspector::Prototype => "인터랙션",
        Inspector::Inspect => "속성",
        _ => return Vec::new(),
    };
    (y >= top && y + SECTION_H <= app.height - FOOTER)
        .then_some((label, y + 22.))
        .into_iter()
        .collect()
}

pub fn design_layout(app: &App) -> Option<crate::inspector_design::Layout> {
    (app.inspector_visible() && app.inspector == Inspector::Design)
        .then(|| crate::inspector_design::compose(app, body_y(app), TAB_BAR_BOTTOM + 12.))?
}

pub fn design_body_top(app: &App) -> f64 {
    body_top(app)
}

pub(crate) fn field_value(
    node: &omc_model::Node,
    item: Option<&omc_scene::SceneItem>,
    property: &str,
) -> String {
    item.and_then(|item| computed_field(item, property))
        .or_else(|| {
            node.properties
                .get(property)
                .or_else(|| item?.properties.get(property))
                .map(|v| {
                    v.as_str()
                        .map(str::to_string)
                        .unwrap_or_else(|| v.to_string())
                })
        })
        .or_else(|| match (property, item) {
            ("x", Some(item)) => Some(item.local.0[4].to_string()),
            ("y", Some(item)) => Some(item.local.0[5].to_string()),
            ("width", Some(item)) => Some(item.width.to_string()),
            ("height", Some(item)) => Some(item.height.to_string()),
            _ => None,
        })
        .unwrap_or_else(|| match property {
            "x" | "y" | "rotation" | "letterSpacing" => "0".into(),
            "opacity" => "1".into(),
            "fontFamily" => "sans-serif".into(),
            "fontSize" => "16".into(),
            "fontWeight" => "400".into(),
            "textAlign" => "left".into(),
            _ => String::new(),
        })
}

fn section_height_for_rows(rows: usize) -> f64 {
    SECTION_H + rows as f64 * ROW_H
}

enum DetailRow {
    Text(String),
    Button(String, Action, bool),
}

impl DetailRow {
    fn text(label: impl Into<String>) -> Self {
        Self::Text(label.into())
    }

    fn button(label: impl Into<String>, action: Action) -> Self {
        Self::Button(label.into(), action, false)
    }
}

fn detail_rows(app: &App) -> Vec<DetailRow> {
    let Some(doc) = app.document() else {
        return vec![];
    };
    match app.inspector {
        Inspector::Design if app.node().is_none() => {
            let Some(page) = doc
                .pages
                .iter()
                .find(|page| Some(&page.id) == app.page.as_ref())
            else {
                return vec![];
            };
            vec![
                DetailRow::text(page.title.clone()),
                DetailRow::button("페이지 이름 바꾸기", Action::RenamePage),
                DetailRow::button("페이지 추가", Action::NewPage),
            ]
        }
        Inspector::Inspect => {
            let Some(node) = app.node().filter(|_| app.selected.len() == 1) else {
                return vec![DetailRow::text("검사할 레이어 하나를 선택하세요")];
            };
            let item = app.scene.as_ref().and_then(|scene| scene.item(&node.id));
            let value = |property| {
                let raw = field_value(node, item, property);
                display_value(property, &raw).into_owned()
            };
            let [x, y, width, height] = if let Some(item) = item {
                [item.local.0[4], item.local.0[5], item.width, item.height].map(compact_number)
            } else {
                [value("x"), value("y"), value("width"), value("height")]
            };
            let mut rows = vec![
                DetailRow::text(format!("위치   X {x}  Y {y}")),
                DetailRow::text(format!("크기   {width} × {height}")),
                DetailRow::text(format!("불투명도   {}", value("opacity"))),
                DetailRow::text(format!("채우기   {}", value("fill"))),
            ];
            if node.kind == NodeKind::Text {
                rows.push(DetailRow::text(format!(
                    "{}   {} px",
                    value("fontFamily"),
                    value("fontSize")
                )));
            }
            if item.is_some() {
                rows.push(DetailRow::button("CSS 복사", Action::CopyInspectorCss));
            }
            rows
        }
        Inspector::Prototype => {
            let Some(page_id) = app.page.as_deref() else {
                return vec![];
            };
            if app.prototype_frame.is_some() {
                return vec![DetailRow::button("미리보기 종료", Action::PrototypeExit)];
            }
            let node = app.node().filter(|_| app.selected.len() == 1);
            let mut rows = vec![];
            if crate::prototype::preview_frame(doc, page_id, node.map(|n| n.id.as_str())).is_some()
            {
                rows.push(DetailRow::button("▷ 미리보기", Action::PrototypePreview));
            }
            let Some(node) = node else {
                rows.push(DetailRow::text("연결할 레이어 하나를 선택하세요"));
                return rows;
            };
            if !crate::prototype::can_set_target(doc, page_id, &node.id) {
                rows.push(DetailRow::text("최상위 프레임 안의 레이어를 선택하세요"));
                return rows;
            }
            let target = crate::prototype::target(doc, page_id, &node.id);
            rows.push(DetailRow::text(if target.is_some() {
                "클릭 시 이동"
            } else {
                "클릭 시 이동할 프레임을 선택하세요"
            }));
            if crate::prototype::has_target(doc, &node.id) {
                rows.push(DetailRow::button(
                    "연결 제거",
                    Action::PrototypeTarget(None),
                ));
            }
            let frames = crate::prototype::targets(doc, page_id, &node.id);
            if frames.is_empty() {
                rows.push(DetailRow::text("이동할 최상위 프레임이 없습니다"));
            }
            for frame in frames {
                rows.push(DetailRow::Button(
                    frame.string("name").unwrap_or(&frame.id).into(),
                    Action::PrototypeTarget(Some(frame.id.clone())),
                    target.is_some_and(|selected| selected.id == frame.id),
                ));
            }
            rows
        }
        _ => vec![],
    }
}

pub fn detail_text(app: &App) -> Vec<(Rect, String)> {
    if !app.inspector_visible() || (app.inspector == Inspector::Design && app.node().is_some()) {
        return vec![];
    }
    let body = body_y(app) + SECTION_H;
    detail_rows(app)
        .into_iter()
        .enumerate()
        .filter_map(|(index, row)| {
            let DetailRow::Text(label) = row else {
                return None;
            };
            let bounds = detail_rect(app, body + index as f64 * ROW_H);
            row_visible(app, bounds).then_some((bounds, label))
        })
        .collect()
}

fn detail_rect(app: &App, y: f64) -> Rect {
    Rect::new(app.width - RIGHT + PAD, y, RIGHT - PAD - PAD_RIGHT, FIELD_H)
}

fn row_visible(app: &App, rect: Rect) -> bool {
    rect.y >= body_top(app) && rect.y + rect.height <= app.height - FOOTER
}

pub fn css_for_selection(app: &App) -> Option<String> {
    if app.selected.len() != 1 {
        return None;
    }
    let item = app.scene.as_ref()?.item(&app.node()?.id)?;
    let mut declarations = format!(
        "width: {}px;\nheight: {}px;",
        compact_number(item.width),
        compact_number(item.height)
    );
    let properties = [
        "opacity",
        "background-color",
        "border-color",
        "border-width",
        "border-radius",
        "color",
        "font-family",
        "font-size",
        "font-weight",
        "line-height",
        "letter-spacing",
        "text-align",
    ];
    for property in properties {
        if let Some(value) = item.style.get(property) {
            declarations.push_str(&format!("\n{property}: {value};"));
        }
    }
    Some(declarations)
}

fn zoom_button_rect(width: f64) -> Rect {
    Rect::new(width - 64., HEADER + 58., 56., FIELD_H)
}

fn popup_entries(app: &App) -> Vec<(String, Action, bool)> {
    match app.popup {
        Some(Popup::InspectorLayer) => {
            let Some(node) = app.node() else {
                return vec![];
            };
            let mut entries = vec![
                ("레이어 이름".into(), Action::Field("name".into()), false),
                ("뒤로 보내기".into(), Action::Reorder(false), false),
                ("앞으로 가져오기".into(), Action::Reorder(true), false),
                (
                    "잠금 전환".into(),
                    Action::ToggleProperty("locked".into()),
                    false,
                ),
                ("그룹".into(), Action::Group(false), false),
            ];
            match node.kind {
                NodeKind::Group => entries.push(("그룹 해제".into(), Action::Ungroup, false)),
                NodeKind::Component => {
                    entries.push(("인스턴스 추가".into(), Action::Instance, false))
                }
                NodeKind::Instance => entries.push(("인스턴스 분리".into(), Action::Detach, false)),
                _ => {}
            }
            entries
        }
        Some(Popup::InspectorBlend) => {
            let current = app
                .node()
                .and_then(|node| node.properties.get("blendMode"))
                .and_then(Value::as_str)
                .unwrap_or("normal");
            [
                ("표준", "normal"),
                ("곱하기", "multiply"),
                ("스크린", "screen"),
                ("오버레이", "overlay"),
            ]
            .into_iter()
            .map(|(label, value)| {
                (
                    label.into(),
                    Action::InspectorIcon(
                        "blend",
                        crate::inspector_design::Command::Set("blendMode", value),
                    ),
                    current == value,
                )
            })
            .collect()
        }
        Some(Popup::InspectorZoom) => [
            (
                "확대".into(),
                Action::ZoomPercent(app.camera.zoom * 1.25),
                false,
            ),
            (
                "축소".into(),
                Action::ZoomPercent(app.camera.zoom / 1.25),
                false,
            ),
            ("화면에 맞추기".into(), Action::Fit, false),
        ]
        .into_iter()
        .chain(ZOOM_CHOICES.into_iter().map(|zoom| {
            (
                format!("{:.0}%", zoom * 100.),
                Action::ZoomPercent(zoom),
                (app.camera.zoom - zoom).abs() < 0.001,
            )
        }))
        .collect(),
        _ => vec![],
    }
}

pub fn popup_rect(app: &App) -> Option<Rect> {
    let entries = popup_entries(app);
    if entries.is_empty() || !app.inspector_visible() {
        return None;
    }
    let height = 12. + 28. * entries.len() as f64;
    let anchor = match app.popup {
        Some(Popup::InspectorLayer) => TAB_BAR_BOTTOM + 41.,
        Some(Popup::InspectorBlend) => app
            .controls
            .iter()
            .find(|c| c.label == "Blend mode")
            .map_or(TAB_BAR_BOTTOM + 91., |c| c.rect.y + c.rect.height),
        _ => HEADER + 91.,
    };
    Some(Rect::new(
        app.width - 170.,
        anchor.min(app.height - height - 8.),
        162.,
        height,
    ))
}

pub fn popup_controls(app: &App, first_id: u64) -> Vec<Control> {
    let Some(menu) = popup_rect(app) else {
        return vec![];
    };
    popup_entries(app)
        .into_iter()
        .enumerate()
        .map(|(index, (label, action, selected))| Control {
            id: first_id + index as u64,
            rect: Rect::new(
                menu.x + 6.,
                menu.y + 6. + index as f64 * 28.,
                menu.width - 12.,
                28.,
            ),
            label,
            action,
            selected,
            field_value: None,
        })
        .collect()
}

pub fn controls(app: &App) -> Vec<Control> {
    let Some(doc) = app.document().filter(|_| app.inspector_visible()) else {
        return vec![];
    };
    let x = app.width - RIGHT + PAD;
    let wide = RIGHT - PAD - PAD_RIGHT;
    let mut controls = vec![];
    let mut tab_x = app.width - RIGHT + 4.;
    for (index, (label, tab, width)) in TABS.into_iter().enumerate() {
        controls.push(Control {
            id: 600_000 + index as u64,
            rect: Rect::new(tab_x, HEADER + 58., width, FIELD_H),
            label: label.into(),
            action: Action::Inspector(tab),
            selected: app.inspector == tab,
            field_value: None,
        });
        tab_x += width + 2.;
    }
    controls.push(Control {
        id: ZOOM_ID,
        rect: zoom_button_rect(app.width),
        label: format!("Zoom {:.0}%", app.camera.zoom * 100.),
        action: Action::InspectorZoom,
        selected: app.popup == Some(Popup::InspectorZoom),
        field_value: None,
    });
    let mut y = body_y(app);
    let mut add = |id: u64, rect: Rect, label: String, action: Action, value: Option<String>| {
        if row_visible(app, rect) {
            controls.push(Control {
                id,
                rect,
                label,
                action,
                selected: false,
                field_value: value,
            });
        }
    };
    if let Some(namespace) = catalog_namespace(app.inspector) {
        let entities = omc_style::catalog_entities(doc, namespace);
        y += SECTION_H;
        add(
            610_000,
            Rect::new(x, y, wide, FIELD_H),
            if namespace == "styles" {
                "+ Paint style from selection"
            } else {
                "+ Color token from selection"
            }
            .into(),
            Action::CreateCatalog(namespace.into()),
            None,
        );
        y += ROW_H;
        for (i, (id, entity)) in entities.iter().enumerate() {
            let name = entity.get("name").and_then(Value::as_str).unwrap_or(id);
            let value = entity
                .get("value")
                .map(|v| {
                    v.as_str()
                        .map(str::to_string)
                        .unwrap_or_else(|| v.to_string())
                })
                .unwrap_or_default();
            let base = 620_000 + i as u64 * 3;
            add(
                base,
                Rect::new(x, y, wide - 65., FIELD_H),
                name.chars().take(20).collect(),
                Action::EditCatalog {
                    namespace: namespace.into(),
                    id: id.clone(),
                    property: "name".into(),
                },
                None,
            );
            add(
                base + 1,
                Rect::new(x + wide - 57., y, 57., FIELD_H),
                "Apply".into(),
                Action::ApplyCatalog {
                    namespace: namespace.into(),
                    id: id.clone(),
                },
                None,
            );
            y += ROW_H;
            add(
                base + 2,
                Rect::new(x, y, wide, FIELD_H),
                value.chars().take(26).collect(),
                Action::EditCatalog {
                    namespace: namespace.into(),
                    id: id.clone(),
                    property: "value".into(),
                },
                None,
            );
            y += ROW_H;
        }
        return controls;
    }
    if let Some(layout) = design_layout(app) {
        controls.extend(layout.controls.into_iter().filter(|control| {
            control.rect.y < body_top(app) && control.id < 660_004 || row_visible(app, control.rect)
        }));
    } else {
        for (index, row) in detail_rows(app).into_iter().enumerate() {
            let DetailRow::Button(label, action, selected) = row else {
                continue;
            };
            let rect = detail_rect(app, y + SECTION_H + index as f64 * ROW_H);
            if row_visible(app, rect) {
                controls.push(Control {
                    id: 650_000 + index as u64,
                    rect,
                    label,
                    action,
                    selected,
                    field_value: None,
                });
            }
        }
    }
    controls
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn final_scroll_step_stops_at_the_exact_content_edge() {
        assert_eq!(scroll_offset(-10., 91.), 0.);
        assert_eq!(scroll_offset(0.5, 91.), 0.5);
        assert_eq!(scroll_offset(92., 91.), 91.);
        assert_eq!(scroll_offset(200., 91.), 91.);
        assert_eq!(scroll_offset(1., 0.), 0.);
    }

    #[test]
    fn right_tabs_leave_room_for_the_zoom_menu() {
        let tabs_width = TABS.iter().map(|(_, _, width)| width + 2.).sum::<f64>();
        assert!(8. + tabs_width <= zoom_button_rect(RIGHT).x);
        assert_eq!(
            TABS.map(|(_, tab, _)| tab),
            [Inspector::Design, Inspector::Prototype]
        );
        assert_eq!(section_height_for_rows(3), SECTION_H + ROW_H * 3.);
    }

    #[test]
    fn visible_values_are_compact_and_keep_raw_edit_units_separate() {
        assert_eq!(display_value("opacity", "1.0"), "100%");
        assert_eq!(display_value("opacity", "0.425"), "42.5%");
        assert_eq!(display_value("rotation", "-0.001"), "0°");
        assert_eq!(display_value("fontWeight", "400.0"), "Regular");
        assert_eq!(display_value("fontWeight", "700"), "Bold");
        assert_eq!(display_value("lineHeight", ""), "Auto");
        assert_eq!(display_value("lineHeight", "normal"), "Auto");
        assert_eq!(display_value("width", "136.91275167785227"), "136.91");
        assert_eq!(
            display_value("fontFamily", "Apple SD Gothic Neo"),
            "Apple SD Gothic Neo"
        );
    }
}
