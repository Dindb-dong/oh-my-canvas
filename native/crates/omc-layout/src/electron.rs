use super::{LayoutBox, alignment, content_alignment, placement, tracks};
use omc_model::{DocumentSnapshot, Node};
use omc_style::{LengthContext, resolve_length};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use taffy::prelude::*;

pub(super) fn rules(node: &Node) -> &Value {
    node.properties
        .get("electronLayout")
        .unwrap_or(&Value::Null)
}

pub(super) fn resized(node: &Node, axis: &str) -> bool {
    let Some(original) = rules(node)["original"][axis].as_f64() else {
        return false;
    };
    node.properties
        .get(axis)
        .and_then(Value::as_f64)
        .is_some_and(|current| current != original)
}

pub(super) fn flows(node: &Node) -> bool {
    if node.properties.contains_key("layout") {
        return false;
    }
    matches!(
        rules(node)["layout"]["type"].as_str(),
        Some("flex" | "grid")
    )
}

pub(super) fn apply(
    node: &Node,
    parent: Option<&Node>,
    parent_flow: bool,
    style: &mut Style,
    viewport: (f64, f64),
) {
    let data = rules(node);
    if !data.is_object() {
        return;
    }
    let layout = &data["layout"];
    let dir = |layout: &Value| match layout["direction"].as_str() {
        Some("column") => FlexDirection::Column,
        Some("column-reverse") => FlexDirection::ColumnReverse,
        Some("row-reverse") => FlexDirection::RowReverse,
        _ => FlexDirection::Row,
    };
    let parent_layout = parent
        .map(|parent| &rules(parent)["layout"])
        .unwrap_or(&Value::Null);
    let context = LengthContext {
        viewport_width: viewport.0,
        viewport_height: viewport.1,
        percent_basis: viewport.0,
        ..Default::default()
    };
    let num = |v: &Value| v.as_f64().unwrap_or(0.) as f32;
    let size_mode = |axis: &str, short: &str, long: &str| {
        data[short]
            .as_str()
            .or_else(|| data[long].as_str())
            .or_else(|| data["layoutSizing"][axis].as_str())
    };
    let flow_child = parent_flow
        && data["absolute"] != true
        && data["layoutPositioning"] != "absolute"
        && node.properties.get("visible") != Some(&Value::Bool(false));
    if parent_flow && !flow_child {
        style.position = Position::Absolute;
    }
    let horizontal = size_mode("width", "hSizing", "widthSizing");
    let vertical = size_mode("height", "vSizing", "heightSizing");
    let column = matches!(
        dir(parent_layout),
        FlexDirection::Column | FlexDirection::ColumnReverse
    );
    let mut axis = |axis: &str, mode: Option<&str>, main: bool, target: &mut Dimension| {
        if resized(node, axis) {
            return;
        }
        let percentage = data["inlineStyles"][axis]
            .as_str()
            .and_then(|value| value.strip_suffix('%'))
            .and_then(|ratio| ratio.parse::<f32>().ok())
            .filter(|ratio| ratio.is_finite());
        if let Some(percentage) = percentage {
            *target = percent(percentage / 100.);
        } else if mode == Some("hug")
            || node.kind == omc_model::NodeKind::Text
                && (data["autoResize"] == "widthAndHeight"
                    || axis == "height" && data["autoResize"] == "height")
        {
            *target = auto();
        } else if flow_child && mode == Some("fill") {
            *target = auto();
            if main && parent_layout["type"] != "grid" {
                style.flex_grow = 1.;
                style.flex_basis = length(0.);
            }
        }
    };
    axis("width", horizontal, !column, &mut style.size.width);
    axis("height", vertical, column, &mut style.size.height);

    for (key, css, result) in [
        ("minWidth", "min-width", &mut style.min_size.width),
        ("minHeight", "min-height", &mut style.min_size.height),
        ("maxWidth", "max-width", &mut style.max_size.width),
        ("maxHeight", "max-height", &mut style.max_size.height),
    ] {
        if let Some(v) = data["inlineStyles"][css]
            .as_str()
            .and_then(|v| v.strip_suffix('%'))
            .and_then(|v| v.parse::<f32>().ok())
            .filter(|v| v.is_finite())
        {
            *result = percent(v / 100.);
        } else if let Some(v) = data[key].as_f64() {
            *result = length(v as f32);
        }
    }
    if flow_child {
        style.position = Position::Relative;
        style.inset = Rect::ZERO.map(|_| auto());
        style.flex_shrink = 0.;
        let grid = parent_layout["type"] == "grid";
        let self_align = alignment(data["alignSelf"].as_str());
        if grid {
            let cell = &data["gridCell"];
            style.justify_self = if horizontal == Some("fill") && !resized(node, "width") {
                Some(AlignItems::Stretch)
            } else {
                alignment(cell["hAlign"].as_str())
            };
            style.align_self = if vertical == Some("fill") && !resized(node, "height") {
                Some(AlignItems::Stretch)
            } else {
                alignment(cell["vAlign"].as_str()).or(self_align)
            };
            for (key, span, track) in [
                ("column", "columnSpan", &mut style.grid_column),
                ("row", "rowSpan", &mut style.grid_row),
            ] {
                if let Some(start) = cell[key].as_u64() {
                    let span = cell[span].as_u64().unwrap_or(1);
                    if let Some(value) = placement(&format!("{start} / span {span}")) {
                        *track = value;
                    }
                }
            }
        } else {
            let cross = if column { "width" } else { "height" };
            let cross_mode = if column { horizontal } else { vertical };
            let stretch = !resized(node, cross)
                && (cross_mode == Some("fill")
                    || self_align.or_else(|| alignment(parent_layout["alignItems"].as_str()))
                        == Some(AlignItems::Stretch));
            style.align_self = if stretch {
                Some(AlignItems::Stretch)
            } else {
                self_align
            };
            if stretch {
                if column {
                    style.size.width = auto();
                } else {
                    style.size.height = auto();
                }
            }
        }
    } else if let Some(parent) = parent {
        let old_extent = &rules(parent)["original"];
        for (axis, coordinate, constraint, old, length_target, position, opposite) in [
            (
                "width",
                "left",
                "horizontal",
                &old_extent["width"],
                &mut style.size.width,
                &mut style.inset.left,
                &mut style.inset.right,
            ),
            (
                "height",
                "top",
                "vertical",
                &old_extent["height"],
                &mut style.size.height,
                &mut style.inset.top,
                &mut style.inset.bottom,
            ),
        ] {
            let current = &data["inlineStyles"][coordinate];
            if let Some(percent_value) = current
                .as_str()
                .and_then(|v| v.strip_suffix('%'))
                .and_then(|v| v.parse::<f32>().ok())
                .filter(|v| v.is_finite())
            {
                *position = percent(percent_value / 100.);
                continue;
            }
            if let Some(px) = current
                .as_f64()
                .or_else(|| current.as_str().and_then(|v| resolve_length(v, context)))
            {
                *position =
                    length(px as f32 + padding(parent_layout)[if axis == "width" { 3 } else { 0 }]);
                continue;
            }
            let Some(before) = old.as_f64() else { continue };
            let mode = data[format!("{constraint}Constraint")]
                .as_str()
                .or_else(|| data["constraints"][constraint].as_str());
            let field = if axis == "width" { "x" } else { "y" };
            let start = node
                .properties
                .get(field)
                .and_then(Value::as_f64)
                .unwrap_or(0.);
            let extent = node
                .properties
                .get(axis)
                .and_then(Value::as_f64)
                .unwrap_or(0.);
            match mode {
                Some("right" | "bottom") => {
                    *position = auto();
                    *opposite = length((before - start - extent) as f32);
                }
                Some("stretch" | "leftAndRight" | "topAndBottom") => {
                    *length_target = auto();
                    *opposite = length((before - start - extent) as f32);
                }
                Some("scale") if before > 0. => {
                    *position = percent((start / before) as f32);
                    *length_target = percent((extent / before).max(0.) as f32);
                }
                _ => (),
            }
        }
    }
    if !flows(node) {
        return;
    }
    let [top, right, bottom, left] = padding(layout).map(length);
    style.padding = Rect {
        top,
        right,
        bottom,
        left,
    };
    let gap = &layout["gap"];
    style.gap = Size {
        width: length(num(gap
            .get("column")
            .or_else(|| layout.get("columnGap"))
            .unwrap_or(gap))),
        height: length(num(gap
            .get("row")
            .or_else(|| layout.get("rowGap"))
            .unwrap_or(gap))),
    };
    style.justify_content =
        content_alignment(layout["justifyContent"].as_str()).or(Some(AlignContent::Start));
    style.align_items = alignment(layout["alignItems"].as_str()).or(Some(AlignItems::Start));
    style.align_content =
        content_alignment(layout["alignContent"].as_str()).or(Some(AlignContent::Start));
    if layout["type"] == "grid" {
        style.display = Display::Grid;
        style.justify_items =
            alignment(layout["justifyItems"].as_str()).or(Some(AlignItems::Start));
        for (axis, target) in [
            ("columns", &mut style.grid_template_columns),
            ("rows", &mut style.grid_template_rows),
        ] {
            let Some(spec) = layout[axis].as_array() else {
                continue;
            };
            let css = spec
                .iter()
                .map(|track| match track["type"].as_str() {
                    Some("fixed") => format!("{}px", num(&track["size"])),
                    Some("fr" | "fraction") => format!(
                        "{}fr",
                        track["size"]
                            .as_f64()
                            .or_else(|| track["value"].as_f64())
                            .unwrap_or(1.)
                    ),
                    _ => "auto".into(),
                })
                .collect::<Vec<_>>()
                .join(" ");
            if let Some(values) = tracks(&css, context) {
                *target = values;
            }
        }
    } else {
        style.display = Display::Flex;
        style.flex_direction = dir(layout);
        style.flex_wrap = match (layout["wrap"].as_bool(), layout["wrap"].as_str()) {
            (Some(true), _) | (_, Some("wrap")) => FlexWrap::Wrap,
            (_, Some("wrap-reverse")) => FlexWrap::WrapReverse,
            _ => FlexWrap::NoWrap,
        };
    }
}

pub(super) fn center_absolute_children(
    snapshot: &DocumentSnapshot,
    order: &[String],
    boxes: &mut BTreeMap<String, LayoutBox>,
) {
    let mut active = BTreeSet::new();
    for id in order {
        let node = &snapshot.nodes[id];
        let parent_active = node
            .parent_id
            .as_ref()
            .is_some_and(|id| active.contains(id));
        if parent_active || resized(node, "width") || resized(node, "height") {
            active.insert(id);
        }
        let Some(parent) = node
            .parent_id
            .as_ref()
            .and_then(|id| snapshot.nodes.get(id))
            .filter(|_| parent_active)
        else {
            continue;
        };
        let data = rules(node);
        if flows(parent) && data["absolute"] != true && data["layoutPositioning"] != "absolute" {
            continue;
        }
        let Some(parent_box) = boxes.get(&parent.id).copied() else {
            continue;
        };
        let Some(child) = boxes.get_mut(id) else {
            continue;
        };
        let original = &rules(parent)["original"];
        for (coordinate, axis, anchor, mode, solved, target) in [
            (
                "x",
                "width",
                "left",
                "horizontal",
                parent_box.width,
                &mut child.x,
            ),
            (
                "y",
                "height",
                "top",
                "vertical",
                parent_box.height,
                &mut child.y,
            ),
        ] {
            let constraint = data[format!("{mode}Constraint")]
                .as_str()
                .or_else(|| data["constraints"][mode].as_str());
            if constraint == Some("center")
                && data["inlineStyles"][anchor].is_null()
                && let Some(previous) = original[axis].as_f64()
                && let Some(start) = node.properties.get(coordinate).and_then(Value::as_f64)
            {
                // The parent's resolved size can come from fill or hug instead of its authored size.
                *target = start + (solved - previous) / 2.;
            }
        }
    }
}

fn padding(layout: &Value) -> [f32; 4] {
    let input = &layout["padding"];
    if let Some(value) = input.as_f64() {
        return [value as f32; 4];
    }
    let keys = ["top", "right", "bottom", "left"];
    std::array::from_fn(|i| {
        input
            .get(i)
            .or_else(|| input.get(i % 2))
            .or_else(|| input.get(keys[i]))
            .and_then(Value::as_f64)
            .unwrap_or(0.) as f32
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use omc_model::{DocumentContent, NodeKind};
    use serde_json::json;

    #[test]
    fn imported_flex_preserves_saved_geometry_then_reflows_fill_and_absolute_children() {
        let mut doc = DocumentContent::empty("Electron flex");
        let mut board = Node::new(NodeKind::Frame);
        board.parent_id = Some(doc.pages[0].root_node_id.clone());
        board.properties.extend([
            ("width".into(), json!(100)),
            ("height".into(), json!(60)),
            ("x".into(), json!(10)),
            ("y".into(), json!(20)),
            ("electronLayout".into(), json!({"original":{"width":100,"height":60},"layout":{
                "type":"flex","direction":"row","padding":{"left":5,"right":5},"gap":10,"alignItems":"center"}})),
        ]);
        let mut shape = |box_: [u32; 4], authored: Value| {
            let mut child = Node::new(NodeKind::Rect);
            child.parent_id = Some(board.id.clone());
            let [x, y, width, height] = box_;
            child.properties.extend([
                ("x".into(), json!(x)),
                ("y".into(), json!(y)),
                ("width".into(), json!(width)),
                ("height".into(), json!(height)),
                ("electronLayout".into(), authored),
            ]);
            child.rank = format!("{:032x}", x);
            let id = child.id.clone();
            doc.nodes.insert(id.clone(), child);
            id
        };
        let fixed = shape(
            [5, 20, 25, 20],
            json!({"original":{"width":25,"height":20}}),
        );
        let fill = shape(
            [40, 20, 55, 20],
            json!({"original":{"width":55,"height":20},"hSizing":"fill"}),
        );
        let absolute = shape(
            [80, 7, 12, 12],
            json!({"original":{"width":12,"height":12},"absolute":true,"horizontalConstraint":"right"}),
        );
        let parent = doc.nodes.get_mut(&fill).unwrap();
        parent.kind = NodeKind::Frame;
        parent.properties.get_mut("electronLayout").unwrap()["layout"] =
            json!({"type":"flex","direction":"column"});
        let mut centered = Node::new(NodeKind::Rect);
        centered.parent_id = Some(fill.clone());
        centered.properties.extend([
            ("x".into(), json!(12)),
            ("y".into(), json!(0)),
            ("width".into(), json!(10)),
            ("height".into(), json!(10)),
            (
                "electronLayout".into(),
                json!({"absolute":true, "horizontalConstraint":"center"}),
            ),
        ]);
        let centered_id = centered.id.clone();
        doc.nodes.insert(centered_id.clone(), centered);
        let board_id = board.id.clone();
        doc.nodes.insert(board_id.clone(), board);
        let mut snapshot = DocumentSnapshot {
            id: "doc".into(),
            epoch: "epoch".into(),
            sequence: 0,
            title: doc.title,
            pages: doc.pages,
            nodes: doc.nodes,
            metadata: doc.metadata,
        };
        let bounds = |doc: &DocumentSnapshot| crate::layout(doc, None, (400., 300.)).unwrap().boxes;
        let before = bounds(&snapshot);
        assert_eq!((before[&fill].x, before[&fill].width), (40., 55.));
        snapshot
            .nodes
            .get_mut(&board_id)
            .unwrap()
            .properties
            .insert("width".into(), json!(160));
        let after = bounds(&snapshot);
        assert_eq!(
            (after[&fixed].x, after[&fixed].y, after[&fixed].width),
            (5., 20., 25.)
        );
        assert_eq!(
            (after[&fill].x, after[&fill].y, after[&fill].width),
            (40., 20., 115.)
        );
        assert_eq!((after[&absolute].x, after[&absolute].y), (140., 7.));
        assert_eq!((before[&centered_id].x, after[&centered_id].x), (12., 42.));
    }
}
