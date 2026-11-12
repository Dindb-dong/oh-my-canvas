mod color_style;
mod colors;
mod component_recovery;
mod edit;
mod objects;
mod operations;
mod regions;
mod rename;
mod slots;

use super::*;
use crate::{paths, vector};
use omc_scene::{Affine, Scene, SceneItem};
use skia_safe::Path;
use std::collections::BTreeSet;
use std::fmt::Write;

pub(super) const COMMANDS: &[(&str, &str, bool, &str)] = &[
    (
        "vector.create",
        "Create editable vector",
        true,
        "path | points, closed?, x?, y?, width?, height?, parent?, index?, name?, props?, select?",
    ),
    (
        "vector.simplify",
        "Simplify vector",
        true,
        "ids?, tolerance?",
    ),
    ("vector.offset", "Offset path", true, "ids?, offset"),
    ("vector.join", "Join paths", true, "ids?"),
    ("vector.smoothJoin", "Smooth join paths", true, "ids?"),
    ("vector.flatten", "Flatten", true, "ids?"),
    ("vector.outlineStroke", "Outline stroke", true, "ids?"),
    ("vector.reverse", "Reverse path direction", true, "ids?"),
    (
        "vector.fillRule",
        "Set fill rule",
        true,
        "ids? | id?, region?, rule",
    ),
    (
        "vector.reverseLoop",
        "Reverse loop",
        true,
        "ids? | id?, region, loop",
    ),
    ("bool.union", "Union selection", true, "ids?"),
    ("bool.subtract", "Subtract selection", true, "ids?"),
    ("bool.intersect", "Intersect selection", true, "ids?"),
    ("bool.exclude", "Exclude selection", true, "ids?"),
    ("bool.flatten", "Flatten boolean", true, "ids?"),
    ("transform.move", "Move", true, "ids?, dx, dy"),
    ("transform.moveTo", "Move to", true, "ids?, x, y"),
    ("transform.nudge", "Nudge", true, "dx, dy, big?"),
    (
        "transform.nudgeSize",
        "Resize by nudge",
        true,
        "dw, dh, big?",
    ),
    (
        "transform.rotate",
        "Rotate",
        true,
        "ids?, degrees, cx?, cy?",
    ),
    (
        "transform.rotationOrigin",
        "Show rotation origin",
        false,
        "on?",
    ),
    (
        "transform.setRotationOrigin",
        "Set rotation origin",
        false,
        "x, y | reset",
    ),
    (
        "transform.resize",
        "Resize",
        true,
        "ids?, width?, height?, anchor?",
    ),
    ("transform.scale", "Scale", true, "ids?, factor, cx?, cy?"),
    ("vector.edit.begin", "Edit vector", true, "id? | ids?"),
    ("vector.edit.end", "Done editing", false, ""),
    ("vector.edit.state", "Vector edit state", false, ""),
    ("vector.edit.tool", "Vector edit tool", false, "tool"),
    (
        "vector.edit.select",
        "Select points",
        false,
        "vertices?, segments?, handles?, regions?, id?, add?",
    ),
    ("vector.edit.selectAll", "Select all points", false, ""),
    (
        "vector.edit.moveVertices",
        "Move points",
        true,
        "vertices?, dx, dy",
    ),
    ("vector.edit.nudge", "Nudge points", true, "dx, dy"),
    ("vector.edit.position", "Set point position", true, "x?, y?"),
    (
        "vector.edit.setHandle",
        "Set handle",
        true,
        "segment, start, x, y, independent?",
    ),
    (
        "vector.edit.moveHandles",
        "Move handles",
        true,
        "dx, dy, handles?, independent?",
    ),
    (
        "vector.edit.mirroring",
        "Handle mirroring",
        true,
        "mode, vertices?",
    ),
    (
        "vector.edit.smooth",
        "Smooth points",
        true,
        "vertices?, smooth?",
    ),
    ("vector.edit.bend", "Bend segment", true, "segment, t, x, y"),
    ("vector.edit.connect", "Connect points", true, "a, b"),
    ("vector.edit.pen", "Pen point", true, "x, y, dx?, dy?"),
    ("vector.edit.penEnd", "End pen path", false, ""),
    (
        "vector.edit.cut",
        "Cut path",
        true,
        "segment?, t?, vertex?, from?, to?",
    ),
    (
        "vector.edit.paint",
        "Paint closed vector region",
        true,
        "x?, y?, points?",
    ),
    (
        "vector.edit.erase",
        "Erase vector geometry",
        true,
        "points, radius?",
    ),
    (
        "vector.edit.widthPoint",
        "Variable stroke width point",
        true,
        "action?, index?, t?, width?, scale?, side?",
    ),
    (
        "vector.edit.cornerRadius",
        "Set point corner radius",
        true,
        "radius, vertices?",
    ),
    (
        "vector.edit.strokeCap",
        "Set point stroke cap",
        true,
        "cap, vertices?",
    ),
    (
        "vector.edit.strokeJoin",
        "Set point stroke join",
        true,
        "join, vertices?",
    ),
    ("vector.edit.addVertex", "Add point", true, "segment, t"),
    (
        "vector.deleteHeal",
        "Delete and heal points",
        true,
        "vertices?",
    ),
    (
        "vector.edit.delete",
        "Delete points",
        true,
        "vertices?, segments?",
    ),
    ("vector.edit.lasso", "Lasso select", false, "points, add?"),
    ("vector.edit.bounds", "Selected point bounds", false, ""),
    (
        "vector.edit.resize",
        "Resize points",
        true,
        "width?, height?, center?",
    ),
    (
        "vector.edit.rotate",
        "Rotate points",
        true,
        "angle, cx?, cy?",
    ),
    (
        "vector.edit.transform",
        "Transform points",
        true,
        "matrix, vertices?",
    ),
    (
        "shapeBuilder.regions",
        "Shape builder regions",
        false,
        "ids?",
    ),
    (
        "shapeBuilder.merge",
        "Merge regions",
        true,
        "ids?, regions?, points?",
    ),
    (
        "shapeBuilder.remove",
        "Remove regions",
        true,
        "ids?, regions?, points?",
    ),
    ("shapeBuilder.mode", "Shape builder mode", false, "mode"),
    ("object.flipH", "Flip horizontal", true, "ids?"),
    ("object.flipV", "Flip vertical", true, "ids?"),
    ("object.rotate180", "Rotate 180°", true, "ids?"),
    ("object.rotateLeft", "Rotate 90° left", true, "ids?"),
    ("object.rotateRight", "Rotate 90° right", true, "ids?"),
    (
        "object.rasterize",
        "Rasterize selection",
        true,
        "ids?, scale?",
    ),
    (
        "object.batchRename",
        "Batch rename",
        true,
        "ids?, find?, regex?, replace?, name?, start?",
    ),
    (
        "object.swapFillStroke",
        "Swap fill and stroke",
        true,
        "ids?",
    ),
    ("object.setThumbnail", "Set as thumbnail", true, "id?"),
    (
        "component.makeSlot",
        "Make slot",
        true,
        "id?, name?, preferred?",
    ),
    ("component.removeSlot", "Remove slot", true, "id?"),
    (
        "component.pushChanges",
        "Push instance changes to main",
        true,
        "id?",
    ),
    (
        "component.restoreMain",
        "Restore the deleted main component",
        true,
        "id?",
    ),
    (
        "instance.slotInsert",
        "Insert component into slot",
        true,
        "id?, slot?, component, index?, replace?",
    ),
    (
        "instance.resetSlot",
        "Reset slot to default content",
        true,
        "id?, slot?",
    ),
    ("selection.colors", "Selection colors", false, "ids?"),
    (
        "selection.applyColorStyle",
        "Apply selection color style",
        true,
        "targets, style, library?",
    ),
    (
        "selection.createColorStyle",
        "Create selection color style",
        true,
        "targets, name, description?",
    ),
    (
        "selection.bindColorVariable",
        "Bind selection color variable",
        true,
        "targets, variable",
    ),
    (
        "selection.detachColor",
        "Detach selection color",
        true,
        "targets",
    ),
    (
        "selection.selectColor",
        "Select layers with color",
        false,
        "targets",
    ),
    ("object.resizeToFit", "Resize to fit", true, "ids?"),
    ("object.moveToPage", "Move to page", true, "ids?, page"),
    (
        "object.wrapInSection",
        "Wrap in new section",
        true,
        "ids?, name?",
    ),
    (
        "object.convertToSection",
        "Convert to section",
        true,
        "ids?",
    ),
    ("object.convertToGroup", "Convert to group", true, "ids?"),
    ("object.convertToFrame", "Convert to frame", true, "ids?"),
    (
        "section.toggleContents",
        "Hide or show section contents",
        true,
        "ids?, hidden?",
    ),
];

impl ToolRouter {
    pub(super) fn fig_geometry_command(
        &self,
        session: &str,
        snapshot: &DocumentSnapshot,
        state: &ViewState,
        selection: &[Value],
        name: &str,
        params: &Value,
    ) -> Result<Value> {
        if matches!(name, "component.pushChanges" | "component.restoreMain") {
            return self.fig_component_recovery(session, snapshot, state, selection, name, params);
        }
        if matches!(
            name,
            "component.makeSlot"
                | "component.removeSlot"
                | "instance.slotInsert"
                | "instance.resetSlot"
        ) {
            return self.fig_slot_command(session, snapshot, state, selection, name, params);
        }
        if matches!(
            name,
            "selection.applyColorStyle"
                | "selection.createColorStyle"
                | "selection.bindColorVariable"
                | "selection.detachColor"
        ) {
            return self.fig_selection_color_style(session, snapshot, name, params);
        }
        if matches!(name, "selection.colors" | "selection.selectColor") {
            return self.fig_selection_colors(session, snapshot, state, selection, name, params);
        }
        if name.starts_with("vector.edit.") || name == "vector.deleteHeal" {
            return self.fig_vector_edit(session, snapshot, state, selection, name, params);
        }
        if name.starts_with("shapeBuilder.") {
            return self.fig_shape_builder(session, snapshot, state, selection, name, params);
        }
        if matches!(
            name,
            "object.flipH"
                | "object.flipV"
                | "object.rotate180"
                | "object.rotateLeft"
                | "object.rotateRight"
        ) && params.get("ids").is_none()
            && params.get("id").is_none()
            && let Some(result) =
                self.fig_vector_object_transform(session, snapshot, state, selection, name)?
        {
            return Ok(result);
        }
        if matches!(
            name,
            "object.rasterize"
                | "object.resizeToFit"
                | "object.moveToPage"
                | "object.wrapInSection"
                | "object.convertToSection"
                | "object.convertToFrame"
                | "object.convertToGroup"
                | "section.toggleContents"
        ) {
            return self.fig_container_operation(session, snapshot, state, selection, name, params);
        }
        let document = &snapshot.id;
        let ids = if name == "vector.create" {
            Vec::new()
        } else {
            geometry_targets(self, session, snapshot, selection, params)?
        };
        let commands = match name {
            "object.setThumbnail" => {
                return self.fig_set_thumbnail(session, snapshot, &ids[0]);
            }
            "object.batchRename" | "object.swapFillStroke" => {
                return self.fig_object_style(session, snapshot, &ids, name, params);
            }
            "vector.create" => vec![Command::NodeCreate {
                node: create_vector(self, session, snapshot, state, params)?,
            }],
            "bool.union" | "bool.subtract" | "bool.intersect" | "bool.exclude" => {
                boolean_commands(snapshot, state, &ids, name.trim_start_matches("bool."))?
            }
            "bool.flatten" | "vector.flatten" => vector::build(
                snapshot,
                &state.page_id,
                "boolean",
                &ids,
                &json!({"operation":"flatten"}),
            )?,
            "vector.outlineStroke" => vector::build(
                snapshot,
                &state.page_id,
                "outline",
                &ids,
                &json!({"kind":"stroke"}),
            )?,
            "vector.simplify" | "vector.offset" | "vector.join" | "vector.smoothJoin" => {
                operations::build(snapshot, state, &ids, name, params)?
            }
            "vector.reverse" | "vector.reverseLoop" => {
                let mut commands = Vec::new();
                let arguments = if name == "vector.reverseLoop" {
                    let region = geometry_index(params, "region")?;
                    if region != 0 {
                        return Err(EngineError::invalid("this vector has only one fill region"));
                    }
                    json!({"action":"reverse","contour":geometry_index(params,"loop")?})
                } else {
                    json!({"action":"reverse"})
                };
                for id in &ids {
                    commands.extend(paths::edit(snapshot, &state.page_id, id, None, &arguments)?);
                }
                commands
            }
            "vector.fillRule" => {
                if params.get("region").is_some() && geometry_index(params, "region")? != 0 {
                    return Err(EngineError::invalid("this vector has only one fill region"));
                }
                let rule = match string(params, "rule")? {
                    "nonZero" => "nonzero",
                    "evenOdd" => "evenodd",
                    _ => return Err(EngineError::invalid("rule must be nonZero or evenOdd")),
                };
                let scene = paths::scene(snapshot, &state.page_id)?;
                ids.iter()
                    .map(|id| {
                        if snapshot.nodes[id].kind != NodeKind::Path
                            || !paths::editable(&scene, id)
                            || scene
                                .item(id)
                                .is_some_and(|item| item.boolean_operation().is_some())
                        {
                            return Err(EngineError::invalid("choose editable vector paths"));
                        }
                        Ok(Command::NodeSet {
                            node_id: id.clone(),
                            properties: Properties::from([("fillRule".into(), json!(rule))]),
                        })
                    })
                    .collect::<Result<Vec<_>>>()?
            }
            "transform.rotationOrigin" | "transform.setRotationOrigin" => {
                let old = rotation_origin(state, &ids);
                let next = if name == "transform.rotationOrigin" {
                    let on = optional_flag(params, "on")?.unwrap_or(old["on"] != true);
                    json!({"ids":ids,"on":on,"point":old["point"]})
                } else {
                    let point = if optional_flag(params, "reset")? == Some(true) {
                        Value::Null
                    } else {
                        json!([geometry_number(params, "x")?, geometry_number(params, "y")?])
                    };
                    json!({"ids":ids,"on":old["on"] == true,"point":point})
                };
                let mut states = self.states.lock().unwrap();
                let view = &mut states
                    .get_mut(&(session.into(), document.clone()))
                    .ok_or_else(|| EngineError::invalid("desktop session closed"))?
                    .view;
                if !view.is_object() {
                    *view = json!({});
                }
                view["rotationOrigin"] = next.clone();
                return Ok(json!({"on":next["on"],"point":next["point"]}));
            }
            _ => transform_commands(snapshot, state, &ids, name, params)?,
        };
        let created = commands
            .iter()
            .filter_map(|command| match command {
                Command::NodeCreate { node } => Some(node.id.clone()),
                _ => None,
            })
            .collect::<Vec<_>>();
        if !commands.is_empty() {
            self.submit(
                session,
                document,
                Command::Batch { commands },
                &Value::Null,
                Some(snapshot.sequence),
            )?;
        }
        let aliases = |raw: &[String]| {
            raw.iter()
                .map(|id| json!(self.fig_alias(session, document, id)))
                .collect::<Vec<_>>()
        };
        if created.is_empty() {
            return Ok(json!({"ids":aliases(&ids)}));
        }
        let created = aliases(&created);
        if optional_flag(params, "select")?.unwrap_or(true) {
            self.fig_selection(&(session.into(), document.clone()), &created);
        }
        Ok(json!({"id":created[0],"ids":created,"selection":created}))
    }
}

pub(super) fn geometry_targets(
    router: &ToolRouter,
    session: &str,
    snapshot: &DocumentSnapshot,
    selection: &[Value],
    params: &Value,
) -> Result<Vec<String>> {
    let targets = if let Some(ids) = params.get("ids") {
        ids.as_array()
            .ok_or_else(|| EngineError::invalid("ids must be an array"))?
    } else if let Some(id) = params.get("id") {
        std::slice::from_ref(id)
    } else {
        selection
    };
    if targets.is_empty() || targets.len() > 200 {
        return Err(EngineError::invalid("choose 1–200 layers"));
    }
    let mut seen = BTreeSet::new();
    let targets = router.fig_layers(session, snapshot, targets)?;
    Ok(targets
        .into_iter()
        .filter(|id| seen.insert(id.clone()))
        .collect())
}

pub(super) fn geometry_number(params: &Value, key: &str) -> Result<f64> {
    optional_number(params, key)?.ok_or_else(|| EngineError::invalid(format!("{key} is required")))
}

pub(super) fn optional_number(params: &Value, key: &str) -> Result<Option<f64>> {
    params
        .get(key)
        .map(|v| {
            v.as_f64()
                .filter(|v| v.is_finite())
                .ok_or_else(|| EngineError::invalid(format!("{key} must be a finite number")))
        })
        .transpose()
}

pub(super) fn geometry_index(params: &Value, key: &str) -> Result<usize> {
    params[key]
        .as_u64()
        .and_then(|value| usize::try_from(value).ok())
        .ok_or_else(|| EngineError::invalid(format!("{key} must be a non-negative integer")))
}

pub(super) fn optional_flag(params: &Value, key: &str) -> Result<Option<bool>> {
    params
        .get(key)
        .map(|value| {
            value
                .as_bool()
                .ok_or_else(|| EngineError::invalid(format!("{key} must be a boolean")))
        })
        .transpose()
}

pub(super) fn point_pair(point: &Value) -> Result<(f64, f64)> {
    if point.as_array().is_none_or(|point| point.len() != 2) {
        return Err(EngineError::invalid("expected point [x,y]"));
    }
    match (point[0].as_f64(), point[1].as_f64()) {
        (Some(x), Some(y)) if x.is_finite() && y.is_finite() && x.abs().max(y.abs()) <= 1e8 => {
            Ok((x, y))
        }
        _ => Err(EngineError::invalid(
            "expected finite point coordinates within range",
        )),
    }
}

fn create_vector(
    router: &ToolRouter,
    session: &str,
    snapshot: &DocumentSnapshot,
    state: &ViewState,
    params: &Value,
) -> Result<Node> {
    optional_flag(params, "select")?;
    let svg = if params.get("path").is_some() {
        if params.get("points").is_some() {
            return Err(EngineError::invalid("provide path or points"));
        }
        string(params, "path")?.to_owned()
    } else {
        let points = params["points"]
            .as_array()
            .filter(|points| (2..=10_000).contains(&points.len()))
            .ok_or_else(|| EngineError::invalid("provide 2–10000 vector points"))?;
        let mut svg = String::new();
        for (i, point) in points.iter().enumerate() {
            let (x, y) = point_pair(point)?;
            let verb = if i == 0 { 'M' } else { 'L' };
            write!(svg, "{verb}{x} {y} ").unwrap();
        }
        svg
    };
    let mut path = Path::from_svg(&svg)
        .filter(|path| path.is_finite() && (2..=10_000).contains(&path.count_verbs()))
        .ok_or_else(|| {
            EngineError::invalid("provide valid SVG vector geometry within 10000 verbs")
        })?;
    if optional_flag(params, "closed")? == Some(true) {
        path.close();
    }
    let parent = params
        .get("parent")
        .map(|id| router.fig_layer(session, snapshot, id))
        .transpose()?
        .unwrap_or_else(|| state.root.clone());
    let parent_node = &snapshot.nodes[&parent];
    if !matches!(
        parent_node.kind,
        NodeKind::Frame | NodeKind::Group | NodeKind::Component
    ) {
        return Err(EngineError::invalid("vector parent must be a container"));
    }
    let scene = paths::scene(snapshot, &state.page_id)?;
    if !paths::editable(&scene, &parent) {
        return Err(EngineError::invalid(
            "vector parent is locked, hidden, or outside this page",
        ));
    }
    let siblings = children(snapshot, &parent);
    let index = if params.get("index").is_some() {
        geometry_index(params, "index")?
    } else {
        siblings.len()
    };
    if index > siblings.len() {
        return Err(EngineError::invalid("layer index exceeds child count"));
    }
    let rank = rank_between(
        index
            .checked_sub(1)
            .and_then(|i| siblings.get(i))
            .map(|n| n.rank.as_str()),
        siblings.get(index).map(|n| n.rank.as_str()),
    )
    .ok_or_else(|| {
        EngineError::new("resource_limit", "sibling ordering requires rank rebalance")
    })?;
    let (_, [left, top, width, height], _) = omc_scene::path_geometry(&path);
    let scale_x = resize_ratio(optional_number(params, "width")?, width)?;
    let scale_y = resize_ratio(optional_number(params, "height")?, height)?;
    let (sx, sy) = (
        scale_x.or(scale_y).unwrap_or(1.),
        scale_y.or(scale_x).unwrap_or(1.),
    );
    let (svg, [_, _, w, h], fill_rule) =
        omc_scene::normalize_path(path, Affine([sx, 0., 0., sy, 0., 0.]));
    let mut node = Node::new(NodeKind::Path);
    node.home_shard = parent_node.home_shard.clone();
    node.rank = rank;
    node.parent_id = Some(parent);
    node.properties = fig_properties(params.get("props").unwrap_or(&json!({})))?;
    node.properties.retain(|_, value| !value.is_null());
    let title = params
        .get("name")
        .map(|_| string(params, "name"))
        .transpose()?
        .unwrap_or("Vector");
    node.properties.extend([
        (
            "x".into(),
            json!(optional_number(params, "x")?.unwrap_or(0.) + left),
        ),
        (
            "y".into(),
            json!(optional_number(params, "y")?.unwrap_or(0.) + top),
        ),
        ("width".into(), json!(w)),
        ("height".into(), json!(h)),
        ("name".into(), json!(title)),
        ("path".into(), json!(svg)),
        ("fillRule".into(), json!(fill_rule)),
    ]);
    if !node.properties.contains_key("fill") && !node.properties.contains_key("stroke") {
        if optional_flag(params, "closed")? == Some(true)
            || node
                .string("path")
                .is_some_and(|path| path.trim_end().ends_with(['Z', 'z']))
        {
            node.properties.insert("fill".into(), json!("#d9d9d9"));
        } else {
            node.properties.insert("stroke".into(), json!("#000000"));
            node.properties.insert("strokeWidth".into(), json!(1.));
        }
    }
    Ok(node)
}

fn boolean_commands(
    snapshot: &DocumentSnapshot,
    state: &ViewState,
    ids: &[String],
    operation: &str,
) -> Result<Vec<Command>> {
    let scene = paths::scene(snapshot, &state.page_id)?;
    let items = geometry_items(&scene, ids)?;
    let parent_of = |item: &SceneItem| item.parent.map(|index| &scene.items[index]);
    if items
        .iter()
        .all(|item| parent_of(item).is_some_and(|p| p.boolean_operation().is_some()))
    {
        return Ok(ids
            .iter()
            .map(|id| Command::NodeSet {
                node_id: id.clone(),
                properties: Properties::from([(
                    "booleanOperandOperation".into(),
                    json!(operation),
                )]),
            })
            .collect());
    }
    if items.len() == 1 && items[0].boolean_operation().is_some() {
        let item = items[0];
        let mut commands = vec![Command::NodeSet {
            node_id: item.id.clone(),
            properties: Properties::from([("booleanOperation".into(), json!(operation))]),
        }];
        for &index in &item.children {
            let child = &scene.items[index];
            if child.properties.contains_key("booleanOperandOperation") {
                commands.push(Command::NodeUnset {
                    node_id: child.id.clone(),
                    properties: vec!["booleanOperandOperation".into()],
                });
            }
        }
        return Ok(commands);
    }
    if items.len() < 2 {
        return Err(EngineError::invalid("choose at least two Boolean operands"));
    }
    vector::build(
        snapshot,
        &state.page_id,
        "boolean",
        ids,
        &json!({"operation":operation}),
    )
}

fn rotation_origin(state: &ViewState, ids: &[String]) -> Value {
    let old = &state.view["rotationOrigin"];
    if old["ids"] == json!(ids) {
        old.clone()
    } else {
        Value::Null
    }
}

fn geometry_items<'a>(scene: &'a Scene, ids: &[String]) -> Result<Vec<&'a SceneItem>> {
    ids.iter()
        .map(|id| {
            scene
                .item(id)
                .filter(|item| item.parent.is_some() && paths::editable(scene, id))
                .ok_or_else(|| {
                    EngineError::invalid("layer is locked, hidden, or outside this page")
                })
        })
        .collect()
}

fn nudge_flow_layers(
    snapshot: &DocumentSnapshot,
    scene: &Scene,
    items: &mut Vec<&SceneItem>,
    dx: f64,
    dy: f64,
) -> Vec<Command> {
    let mut groups = BTreeMap::<usize, BTreeSet<&str>>::new();
    items.retain(|item| {
        let parent = item.parent.unwrap();
        let frame = &scene.items[parent];
        if matches!(frame.style.get("display"), Some("flex" | "grid"))
            && item.style.get("position") != Some("absolute")
        {
            groups.entry(parent).or_default().insert(&item.id);
            return false;
        }
        true
    });
    let mut commands = Vec::new();
    for (parent, selected) in groups {
        let frame = &scene.items[parent];
        let siblings: Vec<_> = frame
            .children
            .iter()
            .map(|index| &scene.items[*index])
            .filter(|child| snapshot.nodes.contains_key(&child.id))
            .collect();
        let mut order: Vec<_> = (0..siblings.len()).collect();
        for (axis, delta) in [dx, dy].into_iter().enumerate().filter(|(_, d)| *d != 0.) {
            let center = |slot: usize, dimension: usize| {
                let item = siblings[slot];
                item.local.bounds(item.width, item.height)[dimension]
                    + item.local.bounds(item.width, item.height)[dimension + 2] / 2.
            };
            let mut targets: Vec<_> = (0..siblings.len())
                .filter(|index| selected.contains(siblings[*index].id.as_str()))
                .collect();
            targets.sort_by(|left, right| {
                (center(*right, axis) * delta.signum())
                    .total_cmp(&(center(*left, axis) * delta.signum()))
            });
            let mut exchanged = BTreeSet::new();
            for current in targets {
                let score = |other: usize| {
                    let along = (center(other, axis) - center(current, axis)) * delta.signum();
                    let across = (center(other, 1 - axis) - center(current, 1 - axis)).abs();
                    (along, across)
                };
                let next = (0..siblings.len())
                    .filter(|index| {
                        let child = siblings[*index];
                        !selected.contains(child.id.as_str())
                            && !exchanged.contains(index)
                            && !child.hidden
                            && !child.locked
                            && child.style.get("position") != Some("absolute")
                            && score(*index).0 > 0.001
                    })
                    .min_by(|left, right| {
                        let (along, across) = score(*left);
                        let (other_along, other_across) = score(*right);
                        across
                            .total_cmp(&other_across)
                            .then_with(|| along.total_cmp(&other_along))
                    });
                if let Some(next) = next {
                    exchanged.insert(next);
                    let left = order.iter().position(|index| *index == current).unwrap();
                    let right = order.iter().position(|index| *index == next).unwrap();
                    order.swap(left, right);
                }
            }
        }
        for (slot, index) in order.into_iter().enumerate() {
            if slot != index {
                commands.push(Command::NodeMove {
                    node_id: siblings[index].id.clone(),
                    parent_id: Some(frame.id.clone()),
                    rank: snapshot.nodes[&siblings[slot].id].rank.clone(),
                });
            }
        }
    }
    commands
}

fn transform_commands(
    snapshot: &DocumentSnapshot,
    state: &ViewState,
    ids: &[String],
    name: &str,
    params: &Value,
) -> Result<Vec<Command>> {
    let scene = paths::scene(snapshot, &state.page_id)?;
    let mut items = geometry_items(&scene, ids)?;
    let selected: BTreeSet<_> = ids.iter().map(String::as_str).collect();
    items.retain(|item| {
        let mut parent = item.parent;
        while let Some(index) = parent {
            if selected.contains(scene.items[index].id.as_str()) {
                return false;
            }
            parent = scene.items[index].parent;
        }
        true
    });
    let [x, y, right, bottom] = items
        .iter()
        .map(|item| {
            let [x, y, w, h] = item.bounds;
            [x, y, x + w, y + h]
        })
        .reduce(|[x, y, r, b], [a, c, d, e]| [x.min(a), y.min(c), r.max(d), b.max(e)])
        .ok_or_else(|| EngineError::invalid("choose layers to transform"))?;
    let (width, height) = (right - x, bottom - y);
    let origin = |x, y| -> Result<(f64, f64)> {
        Ok((
            optional_number(params, "cx")?.unwrap_or(x),
            optional_number(params, "cy")?.unwrap_or(y),
        ))
    };
    let nudge = || optional_flag(params, "big").map(|big| if big == Some(true) { 10. } else { 1. });
    let mut reorder = Vec::new();
    let transform = match name {
        "object.flipH" | "object.flipV" | "object.rotate180" | "object.rotateLeft"
        | "object.rotateRight" => {
            let center = (x + width / 2., y + height / 2.);
            let old = rotation_origin(state, ids);
            let center = if name == "object.flipH" || name == "object.flipV" {
                center
            } else {
                point_pair(&old["point"]).unwrap_or(center)
            };
            objects::object_affine(name, center)
        }
        "transform.move" => Affine::translation(
            geometry_number(params, "dx")?,
            geometry_number(params, "dy")?,
        ),
        "transform.moveTo" => Affine::translation(
            geometry_number(params, "x")? - x,
            geometry_number(params, "y")? - y,
        ),
        "transform.nudge" => {
            let amount = nudge()?;
            let dx = optional_number(params, "dx")?.unwrap_or(0.);
            let dy = optional_number(params, "dy")?.unwrap_or(0.);
            if dx == 0. && dy == 0. {
                return Ok(Vec::new());
            }
            reorder = nudge_flow_layers(snapshot, &scene, &mut items, dx, dy);
            Affine::translation(dx * amount, dy * amount)
        }
        "transform.rotate" => {
            let old = rotation_origin(state, ids);
            let (cx, cy) = point_pair(&old["point"]).unwrap_or((x + width / 2., y + height / 2.));
            let angle = geometry_number(params, "degrees")?.to_radians();
            let (sin, cos) = angle.sin_cos();
            around(origin(cx, cy)?, Affine([cos, sin, -sin, cos, 0., 0.]))
        }
        "transform.scale" => {
            let factor = geometry_number(params, "factor")?;
            if factor <= 0. || factor > 1e6 {
                return Err(EngineError::invalid(
                    "factor must be positive and at most 1000000",
                ));
            }
            around(origin(x, y)?, Affine([factor, 0., 0., factor, 0., 0.]))
        }
        "transform.resize" | "transform.nudgeSize" => {
            let (w, h) = if name == "transform.nudgeSize" {
                let amount = nudge()?;
                (
                    Some(width + geometry_number(params, "dw")? * amount),
                    Some(height + geometry_number(params, "dh")? * amount),
                )
            } else {
                (
                    optional_number(params, "width")?,
                    optional_number(params, "height")?,
                )
            };
            if w.is_none() && h.is_none() {
                return Err(EngineError::invalid("provide width or height"));
            }
            let sx = resize_ratio(w, width)?.unwrap_or(1.);
            let sy = resize_ratio(h, height)?.unwrap_or(1.);
            let (fx, fy) = match params
                .get("anchor")
                .map(|_| string(params, "anchor"))
                .transpose()?
                .unwrap_or("tl")
            {
                "tl" => (0., 0.),
                "t" => (0.5, 0.),
                "tr" => (1., 0.),
                "l" => (0., 0.5),
                "c" => (0.5, 0.5),
                "r" => (1., 0.5),
                "bl" => (0., 1.),
                "b" => (0.5, 1.),
                "br" => (1., 1.),
                _ => return Err(EngineError::invalid("unknown resize anchor")),
            };
            around(
                (x + width * fx, y + height * fy),
                Affine([sx, 0., 0., sy, 0., 0.]),
            )
        }
        _ => return Err(EngineError::invalid("unknown transform command")),
    };
    let resizing = matches!(name, "transform.resize" | "transform.nudgeSize");
    let placements = items
        .into_iter()
        .map(|item| {
            let parent = &scene.items[item.parent.unwrap()];
            let inverse = parent
                .world
                .inverse()
                .ok_or_else(|| EngineError::invalid("parent transform is not invertible"))?;
            let absolute = inverse.multiply(transform).multiply(item.world);
            if !absolute.0.iter().all(|v| v.is_finite() && v.abs() <= 1e9) {
                return Err(EngineError::invalid(
                    "transform exceeds supported coordinates",
                ));
            }
            let mut properties = vector::absolute_placement(item, absolute);
            if matches!(
                name,
                "transform.rotate"
                    | "object.rotate180"
                    | "object.rotateLeft"
                    | "object.rotateRight"
            ) {
                let [a, b, ..] = absolute.0;
                properties.insert("rotation".into(), json!(b.atan2(a).to_degrees()));
            }
            if resizing
                && item.kind != NodeKind::Path
                && !matches!(item.kind, NodeKind::Group | NodeKind::Component)
                && item.world.0[1].abs() + item.world.0[2].abs() < 1e-9
            {
                let [sx, _, _, sy, _, _] = transform.0;
                if sx > 0. && sy > 0. {
                    let [a, b, c, d, _, _] = absolute.0;
                    properties.insert("width".into(), json!(item.width * sx));
                    properties.insert("height".into(), json!(item.height * sy));
                    properties.insert(
                        "transform".into(),
                        json!([a / sx, b / sx, c / sy, d / sy, 0., 0.]),
                    );
                }
            }
            Ok(Command::NodeSet {
                node_id: item.id.clone(),
                properties,
            })
        })
        .collect::<Result<Vec<_>>>()?;
    reorder.extend(placements);
    Ok(reorder)
}

fn resize_ratio(target: Option<f64>, original: f64) -> Result<Option<f64>> {
    target
        .map(|target| {
            if target == 0. && original == 0. {
                return Ok(1.);
            }
            if target <= 0. || original <= 0. {
                return Err(EngineError::invalid("resize dimensions must be positive"));
            }
            let ratio = target / original;
            if ratio.is_finite() && ratio <= 1e6 {
                Ok(ratio)
            } else {
                Err(EngineError::invalid("resize exceeds supported scale"))
            }
        })
        .transpose()
}

fn around((x, y): (f64, f64), transform: Affine) -> Affine {
    Affine::translation(x, y)
        .multiply(transform)
        .multiply(Affine::translation(-x, -y))
}
