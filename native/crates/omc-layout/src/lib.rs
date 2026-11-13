//! Shared native box layout. Camera changes do not modify authored dimensions.
use omc_model::{DocumentSnapshot, Node, NodeKind};
use omc_style::{ComputedStyle, Diagnostic, LengthContext, compute_styles, resolve_length};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use taffy::prelude::*;

#[derive(Debug, thiserror::Error)]
pub enum LayoutError {
    #[error("unknown page or root: {0}")]
    UnknownRoot(String),
    #[error("invalid layout dimensions")]
    InvalidDimensions,
    #[error("invalid containment at {0}")]
    InvalidContainment(String),
    #[error("native layout failed: {0}")]
    Backend(String),
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct LayoutBox {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub content_x: f64,
    pub content_y: f64,
    pub content_width: f64,
    pub content_height: f64,
}
pub struct LayoutSnapshot {
    pub root_id: String,
    pub boxes: BTreeMap<String, LayoutBox>,
    pub styles: BTreeMap<String, ComputedStyle>,
    pub order: Vec<String>,
    pub diagnostics: Vec<Diagnostic>,
    pub visited_nodes: usize,
}
#[derive(Clone)]
struct MeasureContext {
    text: String,
    runs: Option<serde_json::Value>,
    style: ComputedStyle,
}

pub fn layout(
    snapshot: &DocumentSnapshot,
    page_id: Option<&str>,
    viewport: (f64, f64),
) -> Result<LayoutSnapshot, LayoutError> {
    if !viewport.0.is_finite()
        || !viewport.1.is_finite()
        || viewport.0 <= 0.
        || viewport.1 <= 0.
        || viewport.0 > 1_000_000.
        || viewport.1 > 1_000_000.
    {
        return Err(LayoutError::InvalidDimensions);
    }
    let root = match page_id {
        Some(id) => snapshot
            .pages
            .iter()
            .find(|p| p.id == id)
            .map(|p| p.root_node_id.as_str())
            .or_else(|| snapshot.nodes.contains_key(id).then_some(id)),
        None => snapshot.pages.first().map(|p| p.root_node_id.as_str()),
    }
    .ok_or_else(|| LayoutError::UnknownRoot(page_id.unwrap_or("").into()))?;
    let styles = compute_styles(snapshot, viewport);
    let mut children: BTreeMap<String, Vec<&Node>> = BTreeMap::new();
    for node in snapshot.nodes.values() {
        if let Some(parent) = &node.parent_id {
            children.entry(parent.clone()).or_default().push(node);
        }
    }
    for values in children.values_mut() {
        values.sort_by(|a, b| (&a.rank, &a.id).cmp(&(&b.rank, &b.id)));
    }
    let mut tree: TaffyTree<MeasureContext> = TaffyTree::new();
    tree.disable_rounding();
    let mut ids = BTreeMap::new();
    let mut order = Vec::new();
    let mut visiting = BTreeSet::new();
    let mut diagnostics = Vec::new();
    let root_id = add_node(
        root,
        root,
        snapshot,
        &children,
        &styles,
        &mut tree,
        &mut ids,
        &mut order,
        &mut visiting,
        &mut diagnostics,
        viewport,
        0,
    )?;
    let mut measure_error = None;
    tree.compute_layout_with_measure(
        root_id,
        Size {
            width: AvailableSpace::Definite(viewport.0 as f32),
            height: AvailableSpace::Definite(viewport.1 as f32),
        },
        |known, available, _, context, _| {
            if let (Some(width), Some(height)) = (known.width, known.height) {
                return Size { width, height };
            }
            let Some(context) = context else {
                return Size {
                    width: known.width.unwrap_or(0.),
                    height: known.height.unwrap_or(0.),
                };
            };
            let width = known
                .width
                .unwrap_or(match available.width {
                    AvailableSpace::Definite(v) => v,
                    AvailableSpace::MinContent => 1.,
                    AvailableSpace::MaxContent => 100000.,
                })
                .max(0.01);
            match omc_text::measure_runs(
                &context.text,
                context.runs.as_ref(),
                &context.style,
                width as f64,
            ) {
                Ok(text) => Size {
                    // SkParagraph rounds its layout width down before deciding line breaks.
                    width: known
                        .width
                        .unwrap_or(text.width.ceil().min(width as f64) as f32),
                    height: known.height.unwrap_or(text.height as f32),
                },
                Err(error) => {
                    measure_error = Some(error.to_string());
                    Size::ZERO
                }
            }
        },
    )
    .map_err(|e| LayoutError::Backend(e.to_string()))?;
    if let Some(error) = measure_error {
        return Err(LayoutError::Backend(error));
    }
    let mut boxes = BTreeMap::new();
    for id in &order {
        let item = tree
            .layout(ids[id])
            .map_err(|e| LayoutError::Backend(e.to_string()))?;
        let x = item.location.x as f64;
        let y = item.location.y as f64;
        let width = item.size.width as f64;
        let height = item.size.height as f64;
        let left = (item.padding.left + item.border.left) as f64;
        let top = (item.padding.top + item.border.top) as f64;
        boxes.insert(
            id.clone(),
            LayoutBox {
                x,
                y,
                width,
                height,
                content_x: left,
                content_y: top,
                content_width: (width - left - (item.padding.right + item.border.right) as f64)
                    .max(0.),
                content_height: (height - top - (item.padding.bottom + item.border.bottom) as f64)
                    .max(0.),
            },
        );
    }
    for id in &order {
        if let Some(style) = styles.get(id) {
            diagnostics.extend(style.diagnostics.iter().cloned());
        }
    }
    Ok(LayoutSnapshot {
        root_id: root.into(),
        boxes,
        styles,
        visited_nodes: order.len(),
        order,
        diagnostics,
    })
}

#[allow(clippy::too_many_arguments)]
fn add_node(
    id: &str,
    root: &str,
    snapshot: &DocumentSnapshot,
    children: &BTreeMap<String, Vec<&Node>>,
    styles: &BTreeMap<String, ComputedStyle>,
    tree: &mut TaffyTree<MeasureContext>,
    ids: &mut BTreeMap<String, NodeId>,
    order: &mut Vec<String>,
    visiting: &mut BTreeSet<String>,
    diagnostics: &mut Vec<Diagnostic>,
    viewport: (f64, f64),
    depth: usize,
) -> Result<NodeId, LayoutError> {
    if depth > 512 || !visiting.insert(id.into()) {
        return Err(LayoutError::InvalidContainment(id.into()));
    }
    let node = snapshot
        .nodes
        .get(id)
        .ok_or_else(|| LayoutError::UnknownRoot(id.into()))?;
    let style = styles.get(id).cloned().unwrap_or_default();
    let parent_flow = node
        .parent_id
        .as_ref()
        .and_then(|id| styles.get(id))
        .and_then(|s| s.get("display"))
        .is_some_and(|d| matches!(d, "flex" | "grid" | "inline-flex" | "inline-grid"));
    let tstyle = taffy_style(node, &style, viewport, id == root, parent_flow, diagnostics);
    order.push(id.into());
    let mut child_ids = Vec::new();
    if let Some(child_list) = children.get(id) {
        for child in child_list {
            child_ids.push(add_node(
                &child.id,
                root,
                snapshot,
                children,
                styles,
                tree,
                ids,
                order,
                visiting,
                diagnostics,
                viewport,
                depth + 1,
            )?);
        }
    }
    // Text nodes with authored children are rejected by the engine; text is measured only once per width.
    let tid = if node.kind == NodeKind::Text {
        let text = node
            .properties
            .get("text")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        tree.new_leaf_with_context(
            tstyle,
            MeasureContext {
                text: text.into(),
                runs: node.properties.get("textRuns").cloned(),
                style,
            },
        )
    } else {
        tree.new_with_children(tstyle, &child_ids)
    }
    .map_err(|e| LayoutError::Backend(e.to_string()))?;
    ids.insert(id.into(), tid);
    visiting.remove(id);
    Ok(tid)
}

fn taffy_style(
    node: &Node,
    s: &ComputedStyle,
    viewport: (f64, f64),
    root: bool,
    parent_flow: bool,
    diagnostics: &mut Vec<Diagnostic>,
) -> Style {
    let context = LengthContext {
        viewport_width: viewport.0,
        viewport_height: viewport.1,
        percent_basis: viewport.0,
        ..Default::default()
    };
    let dim = |key: &str, default: Dimension| {
        s.get(key).map(|v| dimension(v, context)).unwrap_or(default)
    };
    let native = !node.properties.contains_key("tag");
    let leaf = !matches!(
        node.kind,
        NodeKind::Frame
            | NodeKind::Group
            | NodeKind::Component
            | NodeKind::Instance
            | NodeKind::Text
    );
    let mut style = Style {
        display: match s.get("display") {
            Some("none") => Display::None,
            Some("flex") | Some("inline-flex") => Display::Flex,
            Some("grid") | Some("inline-grid") => Display::Grid,
            _ => Display::Block,
        },
        position: if s.get("position") == Some("absolute")
            || (!root
                && native
                && !parent_flow
                && (node.properties.contains_key("x") || node.properties.contains_key("y")))
        {
            Position::Absolute
        } else {
            Position::Relative
        },
        size: Size {
            width: dim(
                "width",
                if root {
                    length(viewport.0 as f32)
                } else if native && leaf {
                    length(100.)
                } else {
                    auto()
                },
            ),
            height: dim(
                "height",
                if root {
                    length(viewport.1 as f32)
                } else if native && leaf {
                    length(100.)
                } else {
                    auto()
                },
            ),
        },
        min_size: Size {
            width: dim("min-width", auto()),
            height: dim("min-height", auto()),
        },
        max_size: Size {
            width: dim("max-width", auto()),
            height: dim("max-height", auto()),
        },
        inset: Rect {
            left: s.get("left").map(|v| lpa(v, context)).unwrap_or(auto()),
            right: s.get("right").map(|v| lpa(v, context)).unwrap_or(auto()),
            top: s
                .get("top")
                .map(|v| {
                    lpa(
                        v,
                        LengthContext {
                            percent_basis: viewport.1,
                            ..context
                        },
                    )
                })
                .unwrap_or(auto()),
            bottom: s
                .get("bottom")
                .map(|v| {
                    lpa(
                        v,
                        LengthContext {
                            percent_basis: viewport.1,
                            ..context
                        },
                    )
                })
                .unwrap_or(auto()),
        },
        box_sizing: if s.get("box-sizing") == Some("content-box") {
            BoxSizing::ContentBox
        } else {
            BoxSizing::BorderBox
        },
        flex_direction: match s.get("flex-direction") {
            Some("column") => FlexDirection::Column,
            Some("row-reverse") => FlexDirection::RowReverse,
            Some("column-reverse") => FlexDirection::ColumnReverse,
            _ => FlexDirection::Row,
        },
        flex_wrap: match s.get("flex-wrap") {
            Some("wrap") => FlexWrap::Wrap,
            Some("wrap-reverse") => FlexWrap::WrapReverse,
            _ => FlexWrap::NoWrap,
        },
        flex_grow: s.number("flex-grow", 0.) as f32,
        flex_shrink: s.number("flex-shrink", 1.) as f32,
        flex_basis: dim("flex-basis", auto()),
        align_items: alignment(s.get("align-items")),
        align_self: alignment(s.get("align-self")),
        justify_items: alignment(s.get("justify-items")),
        justify_content: content_alignment(s.get("justify-content")),
        align_content: content_alignment(s.get("align-content")),
        ..Style::default()
    };
    if parent_flow && native && s.get("position").is_none() {
        style.inset = auto();
    }
    style.padding = Rect {
        left: lp(s.get("padding-left").unwrap_or("0"), context),
        right: lp(s.get("padding-right").unwrap_or("0"), context),
        top: lp(s.get("padding-top").unwrap_or("0"), context),
        bottom: lp(s.get("padding-bottom").unwrap_or("0"), context),
    };
    style.margin = Rect {
        left: lpa(s.get("margin-left").unwrap_or("0"), context),
        right: lpa(s.get("margin-right").unwrap_or("0"), context),
        top: lpa(s.get("margin-top").unwrap_or("0"), context),
        bottom: lpa(s.get("margin-bottom").unwrap_or("0"), context),
    };
    let border = lp(s.get("border-width").unwrap_or("0"), context);
    style.border = Rect {
        left: border,
        right: border,
        top: border,
        bottom: border,
    };
    let gaps: Vec<_> = s.get("gap").unwrap_or("0").split_whitespace().collect();
    style.gap = Size {
        width: lp(
            s.get("column-gap")
                .unwrap_or(gaps.get(1).copied().unwrap_or(gaps[0])),
            context,
        ),
        height: lp(s.get("row-gap").unwrap_or(gaps[0]), context),
    };
    if let Some(value) = s.get("grid-template-columns") {
        style.grid_template_columns = tracks(value, context).unwrap_or_else(|| {
            diagnostics.push(Diagnostic::unsupported(
                Some(&node.id),
                Some("grid-template-columns"),
                value,
            ));
            Vec::new()
        });
    }
    if let Some(value) = s.get("grid-template-rows") {
        style.grid_template_rows = tracks(value, context).unwrap_or_else(|| {
            diagnostics.push(Diagnostic::unsupported(
                Some(&node.id),
                Some("grid-template-rows"),
                value,
            ));
            Vec::new()
        });
    }
    if let Some(value) = s.get("grid-column") {
        style.grid_column = placement(value).unwrap_or_else(|| {
            diagnostics.push(Diagnostic::unsupported(
                Some(&node.id),
                Some("grid-column"),
                value,
            ));
            auto()
        });
    }
    if let Some(value) = s.get("grid-row") {
        style.grid_row = placement(value).unwrap_or_else(|| {
            diagnostics.push(Diagnostic::unsupported(
                Some(&node.id),
                Some("grid-row"),
                value,
            ));
            auto()
        });
    }
    style
}

fn dimension(value: &str, c: LengthContext) -> Dimension {
    if value == "auto" {
        auto()
    } else if let Some(p) = value.strip_suffix('%').and_then(|s| s.parse::<f32>().ok()) {
        percent(p / 100.)
    } else {
        resolve_length(value, c)
            .map(|v| length(v as f32))
            .unwrap_or(auto())
    }
}
fn lp(value: &str, c: LengthContext) -> LengthPercentage {
    if let Some(p) = value.strip_suffix('%').and_then(|s| s.parse::<f32>().ok()) {
        percent(p / 100.)
    } else {
        length(resolve_length(value, c).unwrap_or(0.) as f32)
    }
}
fn lpa(value: &str, c: LengthContext) -> LengthPercentageAuto {
    if value == "auto" {
        auto()
    } else if let Some(p) = value.strip_suffix('%').and_then(|s| s.parse::<f32>().ok()) {
        percent(p / 100.)
    } else {
        length(resolve_length(value, c).unwrap_or(0.) as f32)
    }
}
fn alignment(value: Option<&str>) -> Option<AlignItems> {
    match value {
        Some("start") | Some("flex-start") => Some(AlignItems::Start),
        Some("end") | Some("flex-end") => Some(AlignItems::End),
        Some("center") => Some(AlignItems::Center),
        Some("stretch") => Some(AlignItems::Stretch),
        Some("baseline") => Some(AlignItems::Baseline),
        _ => None,
    }
}
fn content_alignment(value: Option<&str>) -> Option<AlignContent> {
    match value {
        Some("start") | Some("flex-start") => Some(AlignContent::Start),
        Some("end") | Some("flex-end") => Some(AlignContent::End),
        Some("center") => Some(AlignContent::Center),
        Some("stretch") => Some(AlignContent::Stretch),
        Some("space-between") => Some(AlignContent::SpaceBetween),
        Some("space-around") => Some(AlignContent::SpaceAround),
        Some("space-evenly") => Some(AlignContent::SpaceEvenly),
        _ => None,
    }
}
const MAX_GRID_TRACKS: usize = 128;

fn placement(value: &str) -> Option<Line<GridPlacement>> {
    let parse = |s: &str| -> Option<GridPlacement> {
        let mut words = s.split_ascii_whitespace();
        let placement = match words.next()? {
            "span" => {
                let span = words.next()?.parse::<u16>().ok()?;
                (span > 0 && usize::from(span) <= MAX_GRID_TRACKS)
                    .then_some(GridPlacement::Span(span))?
            }
            "auto" => auto(),
            n => {
                let index = n.parse::<i16>().ok()?;
                // Taffy uses signed line arithmetic for implicit placement and spans.
                if index == 0 || usize::from(index.unsigned_abs()) > MAX_GRID_TRACKS + 1 {
                    return None;
                }
                line(index)
            }
        };
        words.next().is_none().then_some(placement)
    };
    if let Some((start, end)) = value.split_once('/') {
        Some(Line {
            start: parse(start)?,
            end: parse(end)?,
        })
    } else {
        Some(Line {
            start: parse(value)?,
            end: auto(),
        })
    }
}

fn grid_parts(value: &str, comma_separated: bool) -> Option<Vec<&str>> {
    if value.len() > 4096 {
        return None;
    }
    let mut parts = Vec::new();
    let mut depth = 0;
    let mut start = 0;
    for (index, byte) in value.bytes().enumerate() {
        if byte == b'(' {
            depth += 1;
            if depth > 24 {
                return None;
            }
        } else if byte == b')' {
            depth -= 1;
            if depth < 0 {
                return None;
            }
        } else if depth == 0
            && if comma_separated {
                byte == b','
            } else {
                byte.is_ascii_whitespace()
            }
        {
            if comma_separated || index > start {
                parts.push(value[start..index].trim());
            }
            start = index + 1;
        }
    }
    if comma_separated || start < value.len() {
        parts.push(value[start..].trim());
    }
    (depth == 0 && !parts.is_empty() && parts.len() <= MAX_GRID_TRACKS).then_some(parts)
}

fn grid_function<'a>(value: &'a str, prefix: &str) -> Option<&'a str> {
    value.strip_prefix(prefix)?.strip_suffix(')')
}

fn grid_breadth(value: &str, context: LengthContext) -> Option<TrackSizingFunction> {
    let nonnegative = |number: f32| (number.is_finite() && number >= 0.).then_some(number);
    Some(match value {
        "auto" => auto(),
        "min-content" => min_content(),
        "max-content" => max_content(),
        _ if value.ends_with("fr") => fr(nonnegative(value.strip_suffix("fr")?.parse().ok()?)?),
        _ if value.ends_with('%') => {
            percent(nonnegative(value.strip_suffix('%')?.parse().ok()?)? / 100.)
        }
        _ => length(nonnegative(resolve_length(value, context)? as f32)?),
    })
}

fn grid_track(value: &str, context: LengthContext) -> Option<GridTemplateComponent<String>> {
    let track = if let Some(body) = grid_function(value, "minmax(") {
        let [min, max] = grid_parts(body, true)?.try_into().ok()?;
        if min.ends_with("fr") {
            return None;
        }
        minmax(
            grid_breadth(min, context)?.min_sizing_function(),
            grid_breadth(max, context)?.max_sizing_function(),
        )
    } else {
        grid_breadth(value, context)?
    };
    Some(GridTemplateComponent::Single(track))
}

fn tracks(value: &str, c: LengthContext) -> Option<Vec<GridTemplateComponent<String>>> {
    let mut result = Vec::new();
    if value.trim() == "none" {
        return Some(result);
    }
    // shortcut: numeric repeat only, add auto-repeat when its responsive geometry has fixtures.
    for token in grid_parts(value.trim(), false)? {
        if let Some(body) = grid_function(token, "repeat(") {
            let [count, body] = grid_parts(body, true)?.try_into().ok()?;
            let count = count.parse::<usize>().ok()?;
            let inner = grid_parts(body, false)?;
            if count == 0 || count > (MAX_GRID_TRACKS - result.len()) / inner.len() {
                return None;
            }
            let inner = inner
                .into_iter()
                .map(|part| grid_track(part, c))
                .collect::<Option<Vec<_>>>()?;
            for _ in 0..count {
                result.extend_from_slice(&inner);
            }
        } else {
            if result.len() == MAX_GRID_TRACKS {
                return None;
            }
            result.push(grid_track(token, c)?);
        }
    }
    Some(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use omc_model::DocumentContent;
    use serde_json::json;

    #[test]
    fn grid_sizes_mixed_repeats_and_places_spanning_items() {
        let content = DocumentContent::empty("grid placement");
        let mut snapshot = DocumentSnapshot {
            id: "d".into(),
            title: content.title,
            epoch: "e".into(),
            sequence: 0,
            pages: content.pages,
            nodes: content.nodes,
            metadata: content.metadata,
        };
        let root = snapshot.pages[0].root_node_id.clone();
        snapshot.nodes.get_mut(&root).unwrap().properties.insert(
            "style".into(),
            json!("display:grid;width:100%;height:140px;grid-template-columns:20px repeat(2, minmax(50px, 1fr)) 30px;grid-template-rows:20px 30px 40px;gap:10px"),
        );
        let mut child = Node::new(NodeKind::Frame);
        child.parent_id = Some(root.clone());
        child.properties.insert(
            "style".into(),
            json!("grid-column:2 / span 2;grid-row:-2 / -1"),
        );
        let child_id = child.id.clone();
        snapshot.nodes.insert(child.id.clone(), child);

        for (viewport, width) in [(300., 230.), (180., 110.), (140., 110.)] {
            let result = layout(&snapshot, None, (viewport, 140.)).unwrap();
            let item = result.boxes[&child_id];
            assert_eq!(
                (item.x, item.y, item.width, item.height),
                (30., 70., width, 40.)
            );
            assert!(result.diagnostics.is_empty());
        }

        let invalid = "repeat(128, repeat(128, 1px))";
        snapshot.nodes.get_mut(&root).unwrap().properties.insert(
            "style".into(),
            json!(format!("display:grid;grid-template-columns:{invalid}")),
        );
        snapshot
            .nodes
            .get_mut(&child_id)
            .unwrap()
            .properties
            .insert("style".into(), json!("grid-column:0;grid-row:span 0"));
        let result = layout(&snapshot, None, (300., 140.)).unwrap();
        for (id, property, value) in [
            (&root, "grid-template-columns", invalid),
            (&child_id, "grid-column", "0"),
            (&child_id, "grid-row", "span 0"),
        ] {
            assert!(result.diagnostics.iter().any(|diagnostic| {
                diagnostic.node_id.as_ref() == Some(id)
                    && diagnostic.property.as_deref() == Some(property)
                    && diagnostic.original == value
                    && diagnostic.fidelity_lost
            }));
        }
    }

    #[test]
    fn grid_rejects_invalid_or_oversized_tracks() {
        let context = LengthContext::default();
        assert_eq!(tracks("repeat(128, 1px)", context).unwrap().len(), 128);
        for value in [
            "repeat(0, 1px)",
            "10px repeat(64, 1px 2px)",
            "repeat(2,)",
            "minmax(,1px)",
            "minmax(1fr, 20px)",
            "repeat(2, minmax(50px, 1fr)",
            "NaNfr",
            "-1px",
        ] {
            assert!(tracks(value, context).is_none(), "{value}");
        }
        for value in ["span 65535", "span -1", "32767", "-32768"] {
            assert!(placement(value).is_none(), "{value}");
        }
    }

    #[test]
    fn responsive_grid_and_native_flex_keep_authored_constraints() {
        let c = DocumentContent::empty("responsive");
        let mut s = DocumentSnapshot {
            id: "d".into(),
            title: c.title,
            epoch: "e".into(),
            sequence: 0,
            pages: c.pages,
            nodes: c.nodes,
            metadata: c.metadata,
        };
        let root = s.pages[0].root_node_id.clone();
        s.nodes.get_mut(&root).unwrap().properties.insert(
            "style".into(),
            json!("display:grid;grid-template-columns:1fr 2fr;gap:12px;width:100%;height:100px"),
        );
        let mut ids = Vec::new();
        for i in 0..2 {
            let mut node = Node::new(NodeKind::Frame);
            node.parent_id = Some(root.clone());
            node.rank = format!("{i:032x}");
            node.properties.insert("style".into(), json!("height:40px"));
            ids.push(node.id.clone());
            s.nodes.insert(node.id.clone(), node);
        }
        for width in [1440., 768., 390.] {
            let layout = layout(&s, None, (width, 200.)).unwrap();
            assert!((layout.boxes[&ids[0]].width - (width - 12.) / 3.).abs() < 0.01);
            assert!((layout.boxes[&ids[1]].x - (width - 12.) / 3. - 12.).abs() < 0.01);
        }
        s.nodes.get_mut(&root).unwrap().properties.insert(
            "style".into(),
            json!("display:flex;gap:10px;align-items:start;width:100%;height:100px"),
        );
        for id in &ids {
            s.nodes.get_mut(id).unwrap().properties.extend([
                ("x".into(), json!(999)),
                ("width".into(), json!(40)),
                ("height".into(), json!(40)),
            ]);
        }
        let layout = layout(&s, None, (390., 200.)).unwrap();
        assert_eq!(layout.boxes[&ids[0]].x, 0.);
        assert_eq!(layout.boxes[&ids[1]].x, 50.);
    }
}
