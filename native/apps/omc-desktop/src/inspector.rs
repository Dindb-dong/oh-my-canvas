use crate::{
    app::{Action, App, Control, FOOTER, HEADER, Inspector, RIGHT},
    geometry::Rect,
};
use omc_model::NodeKind;
use serde_json::Value;

pub fn controls(app: &App) -> Vec<Control> {
    if app.width < 1050. || app.document().is_none() {
        return vec![];
    }
    let x = app.width - RIGHT + 16.;
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
            rect: Rect::new(x + index as f64 * 70., HEADER + 37., 66., 28.),
            label: label.into(),
            action: Action::Inspector(tab),
            selected: app.inspector == tab,
            field_value: None,
        });
    }
    let mut y = HEADER + 100. - app.inspector_scroll as f64 * 54.;
    let mut add = |id: u64,
                   rect: Rect,
                   label: String,
                   action: Action,
                   value: Option<String>,
                   selected: bool| {
        if rect.y >= HEADER + 88. && rect.y + rect.height < app.height - FOOTER - 8. {
            controls.push(Control {
                id,
                rect,
                label,
                action,
                selected,
                field_value: value,
            });
        }
    };
    if app.inspector == Inspector::Assets {
        let Some(doc) = app.document() else {
            return controls;
        };
        for (index, namespace) in ["styles", "tokens"].into_iter().enumerate() {
            let entities = omc_style::catalog_entities(doc, namespace);
            add(
                610_000 + index as u64,
                Rect::new(x, y, 208., 30.),
                if namespace == "styles" {
                    "+ Paint style from selection"
                } else {
                    "+ Color token from selection"
                }
                .into(),
                Action::CreateCatalog(namespace.into()),
                None,
                false,
            );
            y += 42.;
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
                let base = 620_000 + index as u64 * 100_000 + i as u64 * 3;
                add(
                    base,
                    Rect::new(x, y, 146., 28.),
                    name.chars().take(20).collect(),
                    Action::EditCatalog {
                        namespace: namespace.into(),
                        id: id.clone(),
                        property: "name".into(),
                    },
                    None,
                    false,
                );
                add(
                    base + 1,
                    Rect::new(x + 151., y, 57., 28.),
                    "Apply".into(),
                    Action::ApplyCatalog {
                        namespace: namespace.into(),
                        id: id.clone(),
                    },
                    None,
                    false,
                );
                y += 32.;
                add(
                    base + 2,
                    Rect::new(x, y, 208., 30.),
                    value.chars().take(26).collect(),
                    Action::EditCatalog {
                        namespace: namespace.into(),
                        id: id.clone(),
                        property: "value".into(),
                    },
                    None,
                    false,
                );
                y += 44.;
            }
            y += 20.;
        }
        return controls;
    }
    let Some(node) = app.node() else {
        return controls;
    };
    let fields: &[(&str, &str)] = if app.inspector == Inspector::Text {
        &[
            ("fontFamily", "Font family"),
            ("fontSize", "Font size"),
            ("fontWeight", "Weight (100–900)"),
            ("lineHeight", "Line height"),
            ("letterSpacing", "Letter spacing"),
            ("textAlign", "Align: left / center / right"),
            ("fill", "Text color"),
        ]
    } else {
        &[
            ("name", "Name"),
            ("x", "X"),
            ("y", "Y"),
            ("width", "Width"),
            ("height", "Height"),
            ("rotation", "Rotation"),
            ("cornerRadius", "Corner radius"),
            ("fill", "Fill"),
            ("stroke", "Stroke"),
            ("strokeWidth", "Stroke width"),
            ("opacity", "Opacity (0–1)"),
        ]
    };
    for (i, (property, label)) in fields.iter().enumerate() {
        let value = node.properties.get(*property).or_else(|| {
            app.scene
                .as_ref()
                .and_then(|s| s.item(&node.id))
                .and_then(|n| n.properties.get(*property))
        });
        let value = value
            .map(|v| {
                v.as_str()
                    .map(str::to_string)
                    .unwrap_or_else(|| v.to_string())
            })
            .unwrap_or_else(|| match *property {
                "opacity" => "1".into(),
                "fontFamily" => "sans-serif".into(),
                "fontSize" => "16".into(),
                "fontWeight" => "400".into(),
                "textAlign" => "left".into(),
                _ => String::new(),
            });
        add(
            500 + i as u64,
            Rect::new(x, y, 208., 34.),
            (*label).into(),
            Action::Field((*property).into()),
            Some(value),
            false,
        );
        y += 56.;
    }
    if app.inspector == Inspector::Design {
        for (index, (left, right)) in [
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
        ]
        .into_iter()
        .enumerate()
        {
            add(
                600 + index as u64 * 2,
                Rect::new(x, y, 100., 30.),
                left.0.into(),
                left.1,
                None,
                false,
            );
            add(
                601 + index as u64 * 2,
                Rect::new(x + 108., y, 100., 30.),
                right.0.into(),
                right.1,
                None,
                false,
            );
            y += 38.;
        }
        add(
            610,
            Rect::new(x, y, 208., 30.),
            "Make component".into(),
            Action::Group(true),
            None,
            false,
        );
        y += 38.;
        if node.kind == NodeKind::Component {
            add(
                611,
                Rect::new(x, y, 208., 30.),
                "Add instance".into(),
                Action::Instance,
                None,
                false,
            );
        }
        if node.kind == NodeKind::Instance {
            add(
                612,
                Rect::new(x, y, 208., 30.),
                "Detach instance".into(),
                Action::Detach,
                None,
                false,
            );
        }
    }
    controls
}
