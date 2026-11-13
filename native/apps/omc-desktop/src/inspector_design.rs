//! Design-panel composition adapted from FigCraft v0.17.0 (MIT):
//! panels/right.rs, panels/layout_panel.rs, panels/typography/fields.rs and panels/paints.rs.
use crate::{
    app::{Action, App, Control, Inspector},
    geometry::Rect,
};
use omc_model::{Node, NodeKind};
use omc_scene::SceneItem;
use serde_json::{Value, json};

#[derive(Clone, Copy, Debug)]
pub enum Command {
    Disabled,
    Align(&'static str, f64),
    Rotate,
    Toggle(&'static str),
    Set(&'static str, &'static str),
    Edit(&'static str),
    Fit(&'static str),
    Catalog(Inspector),
    Component,
    AddPaint(&'static str),
    PaintVisible(&'static str, usize),
    RemovePaint(&'static str, usize),
    AddShadow,
    RemoveShadow(usize),
    Export,
}

#[derive(Clone, Debug)]
pub enum Decoration {
    Rule(f64),
    Text(Rect, &'static str, bool),
    Segment(Rect),
}

pub struct Layout {
    pub controls: Vec<Control>,
    pub decorations: Vec<Decoration>,
    pub height: f64,
}

const PAD: f64 = 12.;
const COL: f64 = 87.5;
const GAP: f64 = 8.;
const FIELD: f64 = 24.;
const FIRST: u64 = 660_000;

struct Panel<'a> {
    node: &'a Node,
    item: Option<&'a SceneItem>,
    x: f64,
    y: f64,
    width: f64,
    next: u64,
    layout: Layout,
}

impl Panel<'_> {
    fn control(
        &mut self,
        x: f64,
        y: f64,
        w: f64,
        label: &str,
        action: Action,
        value: Option<String>,
        selected: bool,
    ) {
        self.layout.controls.push(Control {
            id: self.next,
            rect: Rect::new(self.x + x, self.y + y, w, FIELD),
            label: label.into(),
            action,
            selected,
            field_value: value,
        });
        self.next += 1;
    }

    fn icon(
        &mut self,
        x: f64,
        y: f64,
        width: f64,
        glyph: &'static str,
        label: &'static str,
        command: Command,
        selected: bool,
    ) {
        self.control(
            x,
            y,
            width,
            label,
            Action::InspectorIcon(glyph, command),
            None,
            selected,
        );
    }

    fn field(&mut self, x: f64, y: f64, w: f64, key: &str, label: &str) {
        let value = super::inspector::field_value(self.node, self.item, key);
        self.control(
            x,
            y,
            w,
            label,
            Action::Field(key.into()),
            Some(value),
            false,
        );
    }

    fn caption(&mut self, y: f64, label: &'static str, muted: bool) {
        self.layout.decorations.push(Decoration::Text(
            Rect::new(self.x + PAD, self.y + y, self.width - 2. * PAD, 16.),
            label,
            muted,
        ));
    }

    fn heading(&mut self, y: f64, label: &'static str, muted: bool) {
        self.layout.decorations.push(Decoration::Rule(self.y + y));
        self.caption(y + 12., label, muted);
    }

    fn segment(
        &mut self,
        x: f64,
        y: f64,
        w: f64,
        items: &[(&'static str, &'static str, Command, bool)],
    ) {
        self.layout.decorations.push(Decoration::Segment(Rect::new(
            self.x + x,
            self.y + y,
            w,
            FIELD,
        )));
        let cell = w / items.len() as f64;
        for (i, &(glyph, name, command, selected)) in items.iter().enumerate() {
            self.icon(x + i as f64 * cell, y, cell, glyph, name, command, selected);
        }
    }

    fn trailing(
        &mut self,
        y: f64,
        index: usize,
        glyph: &'static str,
        label: &'static str,
        command: Command,
    ) {
        self.icon(
            self.width - 29. - index as f64 * 28.,
            y,
            FIELD,
            glyph,
            label,
            command,
            false,
        );
    }

    fn dropdown(&mut self, x: f64, y: f64, w: f64, key: &'static str, label: &'static str) {
        self.field(x, y, w, key, label);
        self.icon(
            x + w - 20.,
            y,
            20.,
            "chevron",
            label,
            Command::Edit(key),
            false,
        );
    }
}

pub fn compose(app: &App, y: f64, header_y: f64) -> Option<Layout> {
    let node = app.node()?;
    let item = app.scene.as_ref().and_then(|scene| scene.item(&node.id));
    let mut p = Panel {
        node,
        item,
        x: app.width - app.right_width(),
        width: app.right_width(),
        y,
        next: FIRST,
        layout: Layout {
            controls: Vec::new(),
            decorations: Vec::new(),
            height: 0.,
        },
    };
    let text = node.kind == NodeKind::Text;
    let second = PAD + COL + GAP;
    let editable = app.selected.len() == 1;
    let transformable = editable && node.properties.get("transform").is_none();
    let has_frame = node
        .parent_id
        .as_ref()
        .and_then(|id| app.document()?.nodes.get(id))
        .is_some_and(|parent| {
            matches!(
                parent.kind,
                NodeKind::Frame | NodeKind::Component | NodeKind::Instance
            ) && app
                .page
                .as_ref()
                .and_then(|id| app.document()?.pages.iter().find(|page| &page.id == id))
                .is_none_or(|page| page.root_node_id != parent.id)
        });
    let when = |enabled, command| if enabled { command } else { Command::Disabled };
    // The selected-layer header sits above the independently scrolling property body.
    let header = header_y - y;
    p.control(
        PAD,
        header,
        90.,
        "Layer actions",
        Action::InspectorLayerMenu,
        None,
        false,
    );
    p.icon(
        p.width - 81.,
        header + 2.,
        FIELD,
        "component",
        "Make component",
        when(editable, Command::Component),
        false,
    );
    p.trailing(header + 2., 1, "mask", "Use as mask", Command::Disabled);
    p.trailing(
        header + 2.,
        0,
        "boolean",
        "Boolean operations",
        Command::Disabled,
    );
    p.heading(0., "위치", false);
    p.caption(38., "정렬", true);
    let align = |axis, amount| when(transformable && has_frame, Command::Align(axis, amount));
    p.segment(
        PAD,
        56.5,
        COL,
        &[
            ("align-left", "Align left", align("x", 0.), false),
            (
                "align-center",
                "Align horizontal centers",
                align("x", 0.5),
                false,
            ),
            ("align-right", "Align right", align("x", 1.), false),
        ],
    );
    p.segment(
        second,
        56.5,
        COL,
        &[
            ("align-top", "Align top", align("y", 0.), false),
            (
                "align-middle",
                "Align vertical centers",
                align("y", 0.5),
                false,
            ),
            ("align-bottom", "Align bottom", align("y", 1.), false),
        ],
    );
    p.caption(82., "위치", true);
    p.field(PAD, 100.5, COL, "x", "X");
    p.field(second, 100.5, COL, "y", "Y");
    p.trailing(100.5, 0, "constraints", "Constraints", Command::Disabled);
    p.caption(126., "회전", true);
    p.field(PAD, 144.5, COL, "rotation", "Rotation");
    p.segment(
        second,
        144.5,
        COL,
        &[
            (
                "rotate",
                "Rotate 90°",
                when(transformable, Command::Rotate),
                false,
            ),
            (
                "flip-x",
                "Flip horizontally",
                when(transformable, Command::Toggle("flipX")),
                false,
            ),
            (
                "flip-y",
                "Flip vertically",
                when(transformable, Command::Toggle("flipY")),
                false,
            ),
        ],
    );

    p.heading(181., "레이아웃", false);
    p.caption(219., "치수", true);
    p.field(PAD, 237.5, COL, "width", "Width");
    p.field(second, 237.5, COL, "height", "Height");
    p.trailing(
        237.5,
        0,
        if node.properties.get("inspectorAspectRatio") == Some(&Value::Bool(true)) {
            "link"
        } else {
            "link-off"
        },
        "Lock aspect ratio",
        when(editable, Command::Toggle("inspectorAspectRatio")),
    );
    for (x, key, label) in [
        (PAD, "width", "Width sizing"),
        (second, "height", "Height sizing"),
    ] {
        let fixed = node.properties.get(key).is_some()
            || item.is_some_and(|item| item.style.get(key).is_some_and(|value| value != "auto"));
        let value = if fixed { "고정" } else { "맞춤" };
        p.control(
            x,
            269.5,
            COL,
            label,
            Action::InspectorChoice("hug", when(editable && text, Command::Fit(key))),
            Some(value.into()),
            false,
        );
    }

    p.heading(298., "모양", false);
    p.trailing(
        306.,
        2,
        if crate::commands::layer_hidden(node) {
            "eye-off-small"
        } else {
            "eye-small"
        },
        "Show or hide layer",
        when(editable, Command::Toggle("hidden")),
    );
    p.trailing(
        306.,
        1,
        "variable",
        "Variables",
        Command::Catalog(Inspector::Tokens),
    );
    p.trailing(
        306.,
        0,
        "blend",
        "Blend mode",
        when(editable, Command::Edit("blendMode")),
    );
    p.caption(336., "불투명도", true);
    p.field(PAD, 354.5, COL, "opacity", "Opacity");
    if !text
        && matches!(
            node.kind,
            NodeKind::Rect | NodeKind::Frame | NodeKind::Component | NodeKind::Instance
        )
    {
        p.field(second, 354.5, COL, "cornerRadius", "Corner radius");
    }

    let mut y = 391.;
    if text {
        p.heading(y, "타이포그래피", false);
        p.trailing(
            y + 8.,
            1,
            "variable",
            "Typography variables",
            Command::Catalog(Inspector::Tokens),
        );
        p.trailing(
            y + 8.,
            0,
            "styles",
            "Typography styles",
            Command::Catalog(Inspector::Assets),
        );
        p.dropdown(
            PAD,
            y + 44.5,
            p.width - PAD - 5.,
            "fontFamily",
            "Font family",
        );
        p.dropdown(PAD, y + 76.5, COL, "fontWeight", "Weight");
        p.field(second, y + 76.5, COL + 12., "fontSize", "Font size");
        p.trailing(
            y + 76.5,
            0,
            "chevron",
            "Font size",
            Command::Edit("fontSize"),
        );
        p.field(PAD, y + 108.5, COL, "lineHeight", "Line height");
        p.field(second, y + 108.5, COL, "letterSpacing", "Letter spacing");
        p.control(
            PAD,
            y + 140.5,
            COL,
            "Paragraph spacing",
            Action::InspectorChoice("paragraph", Command::Disabled),
            Some("0".into()),
            false,
        );
        p.segment(
            second,
            y + 140.5,
            84.,
            &[
                (
                    "hug",
                    "Auto width",
                    when(editable, Command::Fit("both")),
                    !node.properties.contains_key("width")
                        && !node.properties.contains_key("height"),
                ),
                (
                    "text-height",
                    "Auto height",
                    when(editable, Command::Fit("auto-height")),
                    node.properties.contains_key("width")
                        && !node.properties.contains_key("height"),
                ),
                (
                    "fixed",
                    "Fixed size",
                    when(editable, Command::Fit("fixed")),
                    node.properties.contains_key("height"),
                ),
                ("more", "Text sizing options", Command::Disabled, false),
            ],
        );
        let alignment = super::inspector::field_value(node, item, "textAlign");
        let vertical = node
            .properties
            .get("textVerticalAlign")
            .and_then(Value::as_str)
            .unwrap_or("top");
        p.segment(
            PAD,
            y + 172.5,
            96.,
            &[
                (
                    "text-left",
                    "Align text left",
                    when(editable, Command::Set("textAlign", "left")),
                    alignment == "left" || alignment == "start",
                ),
                (
                    "text-center",
                    "Align text center",
                    when(editable, Command::Set("textAlign", "center")),
                    alignment == "center",
                ),
                (
                    "text-right",
                    "Align text right",
                    when(editable, Command::Set("textAlign", "right")),
                    alignment == "right" || alignment == "end",
                ),
                (
                    "text-justify",
                    "Justify text",
                    when(editable, Command::Set("textAlign", "justify")),
                    alignment == "justify",
                ),
            ],
        );
        p.segment(
            116.,
            y + 172.5,
            72.,
            &[
                (
                    "text-top",
                    "Align text top",
                    when(editable, Command::Set("textVerticalAlign", "top")),
                    vertical == "top",
                ),
                (
                    "text-middle",
                    "Align text middle",
                    when(editable, Command::Set("textVerticalAlign", "middle")),
                    vertical == "middle",
                ),
                (
                    "text-bottom",
                    "Align text bottom",
                    when(editable, Command::Set("textVerticalAlign", "bottom")),
                    vertical == "bottom",
                ),
            ],
        );
        p.icon(
            p.width - 35.,
            y + 172.5,
            FIELD,
            "more",
            "Advanced typography",
            Command::Disabled,
            false,
        );
        y += 201.5;
    }

    y = paint_section(&mut p, y, "fill", "채우기", editable);
    y = paint_section(&mut p, y, "stroke", "선", editable);
    let shadows = effective(node, item, "shadows").and_then(Value::as_array);
    p.heading(y, "효과", shadows.is_none_or(Vec::is_empty));
    p.trailing(
        y + 6.,
        1,
        "styles",
        "Effect styles",
        Command::Catalog(Inspector::Assets),
    );
    p.trailing(
        y + 6.,
        0,
        "plus",
        "Add drop shadow",
        when(editable, Command::AddShadow),
    );
    if let Some(shadows) = shadows {
        for index in 0..shadows.len() {
            p.control(
                PAD,
                y + 37. + index as f64 * 32.,
                155.,
                "그림자",
                Action::InspectorChoice("effect", Command::Disabled),
                None,
                false,
            );
            p.trailing(
                y + 37. + index as f64 * 32.,
                0,
                "minus",
                "Remove effect",
                when(editable, Command::RemoveShadow(index)),
            );
        }
        y += shadows.len() as f64 * 32.;
    }
    y += 41.;
    p.heading(y, "내보내기", true);
    p.trailing(y + 8., 0, "plus", "Export page", Command::Export);
    p.layout.height = y + 52.;
    Some(p.layout)
}

fn effective<'a>(node: &'a Node, item: Option<&'a SceneItem>, key: &str) -> Option<&'a Value> {
    node.properties
        .get(key)
        .or_else(|| item?.properties.get(key))
}

fn paint_section(
    p: &mut Panel<'_>,
    y: f64,
    key: &'static str,
    label: &'static str,
    editable: bool,
) -> f64 {
    let entries = paints(p.node, p.item, key);
    let mutable = |command| if editable { command } else { Command::Disabled };
    p.heading(y, label, entries.is_empty());
    p.trailing(
        y + 7.5,
        1,
        "styles",
        "Paint styles",
        Command::Catalog(Inspector::Assets),
    );
    p.trailing(
        y + 7.5,
        0,
        "plus",
        if key == "fill" {
            "Add fill"
        } else {
            "Add stroke"
        },
        if key == "fill" && p.node.kind == NodeKind::Text && !entries.is_empty() {
            Command::Disabled
        } else {
            mutable(Command::AddPaint(key))
        },
    );
    for (index, entry) in entries.iter().enumerate() {
        let top = y + 44.5 + index as f64 * 32.;
        p.layout.decorations.push(Decoration::Segment(Rect::new(
            p.x + PAD,
            p.y + top,
            155.,
            FIELD,
        )));
        let color = entry.get("color").and_then(Value::as_str);
        if let Some(color) = color.filter(|_| solid(entry)) {
            p.control(
                PAD,
                top,
                107.,
                if key == "fill" {
                    "Fill color"
                } else {
                    "Stroke color"
                },
                Action::Field(format!("{key}:{index}:color")),
                Some(color.into()),
                false,
            );
        } else {
            p.control(
                PAD,
                top,
                107.,
                "Gradient or image",
                Action::InspectorChoice("fill", Command::Disabled),
                Some("페인트".into()),
                false,
            );
        }
        let opacity = entry.get("opacity").and_then(Value::as_f64).unwrap_or(1.);
        p.control(
            PAD + 107.,
            top,
            48.,
            "Paint opacity",
            Action::Field(format!("{key}:{index}:opacity")),
            Some(opacity.to_string()),
            false,
        );
        let hidden = entry.get("hidden") == Some(&Value::Bool(true))
            || entry.get("visible") == Some(&Value::Bool(false));
        p.trailing(
            top,
            1,
            if hidden { "eye-off" } else { "eye" },
            "Toggle paint visibility",
            mutable(Command::PaintVisible(key, index)),
        );
        p.trailing(
            top,
            0,
            "minus",
            "Remove paint",
            mutable(Command::RemovePaint(key, index)),
        );
    }
    if key == "stroke" && !entries.is_empty() {
        let width = entries[0]
            .get("width")
            .or_else(|| entries[0].get("thickness"))
            .and_then(Value::as_f64)
            .unwrap_or(1.);
        p.control(
            PAD,
            y + 44.5 + entries.len() as f64 * 32.,
            COL,
            "Stroke width",
            Action::Field("stroke:0:width".into()),
            Some(width.to_string()),
            false,
        );
        return y + 41. + (entries.len() + 1) as f64 * 32.;
    }
    y + if entries.is_empty() {
        41.
    } else {
        40.5 + entries.len() as f64 * 32.
    }
}

fn solid(entry: &Value) -> bool {
    entry
        .get("type")
        .or_else(|| entry.get("kind"))
        .and_then(Value::as_str)
        .is_none_or(|kind| kind.eq_ignore_ascii_case("solid"))
}

fn paints(node: &Node, item: Option<&SceneItem>, key: &str) -> Vec<Value> {
    let stack = if key == "fill" { "fills" } else { "strokes" };
    if let Some(entries) = effective(node, item, stack).and_then(Value::as_array) {
        return entries.clone();
    }
    let color = super::inspector::field_value(node, item, key);
    omc_style::parse_color(&color)
        .filter(|color| color.a > 0.)
        .map(|_| {
            let mut paint = json!({"type":"solid","color":color,"opacity":1});
            if key == "stroke" {
                let width = super::inspector::field_value(node, item, "strokeWidth");
                if let Ok(width) = width.parse::<f64>() {
                    paint["width"] = json!(width);
                }
            }
            vec![paint]
        })
        .unwrap_or_default()
}

pub fn paint_command(
    node: &Node,
    item: Option<&SceneItem>,
    field: &str,
    input: &str,
) -> Option<Result<Value, String>> {
    let (key, tail) = field.split_once(':')?;
    let (index, property) = tail.split_once(':')?;
    let index = index.parse::<usize>().ok()?;
    let mut entries = paints(node, item, key);
    let Some(entry) = entries.get_mut(index).and_then(Value::as_object_mut) else {
        return Some(Err("The paint row no longer exists.".into()));
    };
    let value = match property {
        "color" => {
            let color = omc_style::parse_color(input)
                .or_else(|| omc_style::parse_color(&format!("#{input}")));
            let Some(color) = color else {
                return Some(Err("Enter a valid color.".into()));
            };
            json!(color.hex())
        }
        "width" => match input.trim().parse::<f64>() {
            Ok(value) if (0. ..=10000.).contains(&value) => json!(value),
            _ => return Some(Err("Enter a stroke width from 0 to 10000.".into())),
        },
        "opacity" => match percent(input) {
            Ok(value) => json!(value),
            Err(error) => return Some(Err(error)),
        },
        _ => return None,
    };
    entry.insert(property.into(), value);
    Some(Ok(set_paints(node, key, entries)))
}

pub fn percent(input: &str) -> Result<f64, String> {
    let input = input.trim();
    let (raw, scale) = input
        .strip_suffix('%')
        .map_or((input, 1.), |value| (value, 100.));
    let value = raw
        .trim()
        .parse::<f64>()
        .map_err(|_| "Enter an opacity from 0% to 100%.".to_string())?
        / scale;
    if !(0. ..=1.).contains(&value) {
        return Err("Enter an opacity from 0% to 100%.".into());
    }
    Ok(value)
}

fn set_paints(node: &Node, key: &str, entries: Vec<Value>) -> Value {
    let stack = if key == "fill" { "fills" } else { "strokes" };
    let scalar = if entries.is_empty() {
        json!("transparent")
    } else {
        Value::Null
    };
    let mut commands =
        vec![json!({"type":"node.set","nodeId":node.id,"properties":{stack:entries}})];
    commands.push(if scalar.is_null() {
        json!({"type":"node.unset","nodeId":node.id,"properties":[key]})
    } else {
        json!({"type":"node.set","nodeId":node.id,"properties":{key:scalar}})
    });
    json!({"type":"batch","commands":commands})
}

pub fn mutation(app: &App, command: Command) -> Option<Value> {
    let node = app.node()?;
    let item = app.scene.as_ref()?.item(&node.id)?;
    let set = |properties| json!({"type":"node.set","nodeId":node.id,"properties":properties});
    let unset = |properties| json!({"type":"node.unset","nodeId":node.id,"properties":properties});
    Some(match command {
        Command::Align(axis, weight) => {
            let parent = item
                .parent
                .and_then(|index| app.scene.as_ref()?.items.get(index))?;
            let (outer, inner) = if axis == "x" {
                (parent.width, item.width)
            } else {
                (parent.height, item.height)
            };
            set(json!({axis:(outer-inner)*weight}))
        }
        Command::Rotate => set(
            json!({"rotation":(node.properties.get("rotation").and_then(Value::as_f64).unwrap_or(0.) + 90.).rem_euclid(360.)}),
        ),
        Command::Set(key, value) => set(json!({key:value})),
        Command::Fit("fixed") => set(json!({"width":item.width,"height":item.height})),
        Command::Fit("both") => unset(json!(["width", "height"])),
        Command::Fit("auto-height") => json!({"type":"batch","commands":[
            set(json!({"width":item.width})),
            unset(json!(["height"])),
        ]}),
        Command::Fit(key) if node.properties.contains_key(key) => unset(json!([key])),
        Command::Fit(key) => set(json!({key:if key == "width" {item.width} else {item.height}})),
        Command::AddPaint(key) => {
            let mut entries = paints(node, Some(item), key);
            if entries.len() >= 32 {
                return None;
            }
            entries.push(json!({"type":"solid","color":"#000000","opacity":1}));
            set_paints(node, key, entries)
        }
        Command::PaintVisible(key, index) => {
            let mut entries = paints(node, Some(item), key);
            let entry = entries.get_mut(index)?.as_object_mut()?;
            let hidden = entry.get("visible") == Some(&Value::Bool(false))
                || entry.get("hidden") == Some(&Value::Bool(true));
            entry.remove("hidden");
            entry.insert("visible".into(), json!(hidden));
            set_paints(node, key, entries)
        }
        Command::RemovePaint(key, index) => {
            let mut entries = paints(node, Some(item), key);
            if index >= entries.len() {
                return None;
            }
            entries.remove(index);
            set_paints(node, key, entries)
        }
        Command::AddShadow | Command::RemoveShadow(_) => {
            let mut shadows = effective(node, Some(item), "shadows")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            if let Command::RemoveShadow(index) = command {
                if index >= shadows.len() {
                    return None;
                }
                shadows.remove(index);
            } else if shadows.len() < 32 {
                shadows.push(json!({"color":"#00000040","offsetX":0,"offsetY":4,"blur":8}));
            }
            set(json!({"shadows":shadows}))
        }
        _ => return None,
    })
}
