use crate::{
    app::{Action, App, Control, FOOTER, HEADER, Inspector, RIGHT},
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
const GUTTER: f64 = 8.;
const SECTION_H: f64 = 40.;
const BODY_TOP: f64 = HEADER + 136.;
const DESIGN_ACTION_ROWS: usize = 4;

fn col_width(w: f64) -> f64 {
    ((w - PAD - PAD_RIGHT - GUTTER * 2. - 24.) / 2.).max(40.)
}

type Field = (&'static str, &'static str);
type Row = (Field, Option<Field>);

struct Section {
    title: &'static str,
    rows: &'static [Row],
}

const POSITION: Section = Section {
    title: "위치",
    rows: &[
        (("x", "X"), Some(("y", "Y"))),
        (("rotation", "Rotation"), None),
    ],
};
const LAYOUT: Section = Section {
    title: "레이아웃",
    rows: &[(("width", "Width"), Some(("height", "Height")))],
};
const APPEARANCE: Section = Section {
    title: "모양",
    rows: &[(("opacity", "Opacity (0–1)"), None)],
};
const SHAPE_APPEARANCE: Section = Section {
    title: "모양",
    rows: &[(
        ("opacity", "Opacity (0–1)"),
        Some(("cornerRadius", "Corner radius")),
    )],
};
// FigCraft's panels/typography/fields.rs supplies the font and paragraph row order.
const TYPOGRAPHY: Section = Section {
    title: "타이포그래피",
    rows: &[
        (("fontFamily", "Font family"), None),
        (("fontWeight", "Weight"), Some(("fontSize", "Font size"))),
        (
            ("lineHeight", "Line height"),
            Some(("letterSpacing", "Letter spacing")),
        ),
        (("textAlign", "Align: left / center / right"), None),
    ],
};
const FILL: Section = Section {
    title: "채우기",
    rows: &[(("fill", "Fill"), None)],
};
const TEXT_FILL: Section = Section {
    title: "채우기",
    rows: &[(("fill", "Text color"), None)],
};
const STROKE: Section = Section {
    title: "선",
    rows: &[(("stroke", "Stroke"), Some(("strokeWidth", "Stroke width")))],
};
const NAME: Section = Section {
    title: "레이어",
    rows: &[(("name", "Name"), None)],
};

// Port of FigCraft crates/ui-egui/src/panels/right.rs::design's section ordering.
fn body_sections(tab: Inspector, kind: NodeKind) -> &'static [Section] {
    match (tab, kind) {
        (Inspector::Design, NodeKind::Text) => &[
            POSITION, LAYOUT, APPEARANCE, TYPOGRAPHY, TEXT_FILL, STROKE, NAME,
        ],
        (Inspector::Design, _) => &[POSITION, LAYOUT, SHAPE_APPEARANCE, FILL, STROKE, NAME],
        (Inspector::Text, _) => &[TYPOGRAPHY, TEXT_FILL],
        _ => &[],
    }
}

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
        return BODY_TOP;
    }
    BODY_TOP - scroll_offset(app.inspector_scroll, scroll_extent(app))
}

fn section_height(section: &Section) -> f64 {
    SECTION_H + section.rows.len() as f64 * ROW_H + GUTTER
}

fn catalog_namespace(tab: Inspector) -> Option<&'static str> {
    match tab {
        Inspector::Assets => Some("styles"),
        Inspector::Tokens => Some("tokens"),
        _ => None,
    }
}

fn design_action_rows(tab: Inspector, kind: NodeKind) -> usize {
    if tab == Inspector::Design {
        DESIGN_ACTION_ROWS + usize::from(matches!(kind, NodeKind::Component | NodeKind::Instance))
    } else {
        0
    }
}

fn scroll_extent(app: &App) -> f64 {
    let Some(doc) = app.document().filter(|_| app.inspector_visible()) else {
        return 0.;
    };
    let height = if let Some(namespace) = catalog_namespace(app.inspector) {
        let entities = omc_style::catalog_entities(doc, namespace);
        SECTION_H + (1. + 2. * entities.len() as f64) * ROW_H
    } else if let Some(node) = app.node() {
        let sections = body_sections(app.inspector, node.kind);
        sections.iter().map(section_height).sum::<f64>()
            + design_action_rows(app.inspector, node.kind) as f64 * ROW_H
    } else {
        return 0.;
    };
    (height - (app.height - FOOTER - BODY_TOP).max(0.)).max(0.)
}

fn scroll_offset(offset: f64, extent: f64) -> f64 {
    offset.clamp(0., extent)
}

pub fn max_scroll(app: &App) -> f64 {
    scroll_extent(app)
}

pub fn scrollbar(app: &App) -> Option<Rect> {
    let height = app.height - FOOTER - BODY_TOP;
    let extent = max_scroll(app);
    if height <= 24. || extent <= 0. || app.cursor.0 < app.width - RIGHT {
        return None;
    }
    let thumb = (height * height / (height + extent)).max(18.);
    let y = BODY_TOP + (height - thumb) * scroll_offset(app.inspector_scroll, extent) / extent;
    Some(Rect::new(app.width - 5., y, 3., thumb))
}

pub fn sections(app: &App) -> Vec<(&'static str, f64)> {
    if !app.inspector_visible() || app.document().is_none() {
        return Vec::new();
    }
    let mut y = body_y(app);
    if matches!(app.inspector, Inspector::Assets | Inspector::Tokens) {
        let label = if app.inspector == Inspector::Assets {
            "로컬 스타일"
        } else {
            "변수"
        };
        return (y >= BODY_TOP)
            .then_some((label, y + 22.))
            .into_iter()
            .collect();
    }
    let Some(node) = app.node() else {
        return Vec::new();
    };
    body_sections(app.inspector, node.kind)
        .iter()
        .filter_map(|section| {
            let start = y;
            y += section_height(section);
            (start >= BODY_TOP && start + SECTION_H <= app.height - FOOTER)
                .then_some((section.title, start + 22.))
        })
        .collect()
}

fn field_value(
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

pub fn controls(app: &App) -> Vec<Control> {
    let Some(doc) = app.document().filter(|_| app.inspector_visible()) else {
        return vec![];
    };
    let x = app.width - RIGHT + PAD;
    let wide = RIGHT - PAD - PAD_RIGHT;
    let col = col_width(RIGHT);
    let mut controls = vec![];
    for (index, (label, tab)) in [
        ("Design", Inspector::Design),
        ("Text", Inspector::Text),
        ("Assets", Inspector::Assets),
    ]
    .into_iter()
    .enumerate()
    {
        controls.push(Control {
            id: 600_000 + index as u64,
            rect: Rect::new(x - 8. + index as f64 * 52., HEADER + 58., 50., FIELD_H),
            label: label.into(),
            action: Action::Inspector(tab),
            selected: app.inspector == tab,
            field_value: None,
        });
    }
    let mut y = body_y(app);
    let mut add = |id: u64, rect: Rect, label: String, action: Action, value: Option<String>| {
        if rect.y >= BODY_TOP && rect.y + rect.height <= app.height - FOOTER {
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
    let Some(node) = app.node() else {
        return controls;
    };
    let item = app.scene.as_ref().and_then(|scene| scene.item(&node.id));
    let mut field_id = 500;
    for section in body_sections(app.inspector, node.kind) {
        y += SECTION_H;
        for (first, second) in section.rows {
            let (property, label) = first;
            let field_width = if second.is_some() || matches!(*property, "rotation" | "opacity") {
                col
            } else {
                wide
            };
            add(
                field_id,
                Rect::new(x, y, field_width, FIELD_H),
                (*label).into(),
                Action::Field((*property).into()),
                Some(field_value(node, item, property)),
            );
            field_id += 1;
            if let Some((property, label)) = second {
                add(
                    field_id,
                    Rect::new(x + col + GUTTER, y, col, FIELD_H),
                    (*label).into(),
                    Action::Field((*property).into()),
                    Some(field_value(node, item, property)),
                );
                field_id += 1;
            }
            y += ROW_H;
        }
        y += GUTTER;
    }
    if app.inspector == Inspector::Design {
        let pairs = [
            (
                ("Backward", Action::Reorder(false)),
                ("Forward", Action::Reorder(true)),
            ),
            (
                ("Hide / show", Action::ToggleProperty("hidden".into())),
                ("Lock / unlock", Action::ToggleProperty("locked".into())),
            ),
            (
                ("Group", Action::Group(false)),
                ("Ungroup", Action::Ungroup),
            ),
        ];
        debug_assert_eq!(pairs.len() + 1, DESIGN_ACTION_ROWS);
        for (index, (left, right)) in pairs.into_iter().enumerate() {
            add(
                600 + index as u64 * 2,
                Rect::new(x, y, col, FIELD_H),
                left.0.into(),
                left.1,
                None,
            );
            add(
                601 + index as u64 * 2,
                Rect::new(x + col + GUTTER, y, col, FIELD_H),
                right.0.into(),
                right.1,
                None,
            );
            y += ROW_H;
        }
        add(
            610,
            Rect::new(x, y, wide, FIELD_H),
            "Make component".into(),
            Action::Group(true),
            None,
        );
        y += ROW_H;
        if node.kind == NodeKind::Component {
            add(
                611,
                Rect::new(x, y, wide, FIELD_H),
                "Add instance".into(),
                Action::Instance,
                None,
            );
        }
        if node.kind == NodeKind::Instance {
            add(
                612,
                Rect::new(x, y, wide, FIELD_H),
                "Detach instance".into(),
                Action::Detach,
                None,
            );
        }
    }
    controls
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn figcraft_grid_keeps_text_sections_and_reserves_the_icon_column() {
        assert_eq!(col_width(240.), 88.);
        assert_eq!(FIELD_H + GUTTER, ROW_H);
        let design = body_sections(Inspector::Design, NodeKind::Text);
        let labels: Vec<_> = design.iter().map(|section| section.title).collect();
        assert_eq!(
            labels,
            [
                "위치",
                "레이아웃",
                "모양",
                "타이포그래피",
                "채우기",
                "선",
                "레이어"
            ]
        );
        assert_eq!(
            design[3].rows[1],
            (("fontWeight", "Weight"), Some(("fontSize", "Font size")))
        );
    }

    #[test]
    fn final_scroll_step_stops_at_the_exact_content_edge() {
        assert_eq!(scroll_offset(-10., 91.), 0.);
        assert_eq!(scroll_offset(0.5, 91.), 0.5);
        assert_eq!(scroll_offset(92., 91.), 91.);
        assert_eq!(scroll_offset(200., 91.), 91.);
        assert_eq!(scroll_offset(1., 0.), 0.);
        assert_eq!(design_action_rows(Inspector::Design, NodeKind::Instance), 5);
        assert_eq!(design_action_rows(Inspector::Text, NodeKind::Text), 0);
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
