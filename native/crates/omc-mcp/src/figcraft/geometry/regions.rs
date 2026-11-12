use super::*;
use skia_safe::{Matrix, PathOp};
use std::collections::BTreeMap;

struct Part<'a> {
    item: &'a SceneItem,
    stroke: bool,
    path: Path,
    fills: Vec<Value>,
}

struct Region {
    path: Path,
    parts: Vec<usize>,
    point: (f32, f32),
}

impl ToolRouter {
    pub(super) fn fig_shape_builder(
        &self,
        session: &str,
        snapshot: &DocumentSnapshot,
        state: &ViewState,
        selection: &[Value],
        name: &str,
        params: &Value,
    ) -> Result<Value> {
        let document = &snapshot.id;
        if name == "shapeBuilder.mode" {
            let mode = string(params, "mode")?;
            if !matches!(mode, "merge" | "remove") {
                return Err(EngineError::invalid("mode must be merge or remove"));
            }
            let mut states = self.states.lock().unwrap();
            let view = &mut states
                .get_mut(&(session.into(), document.clone()))
                .ok_or_else(|| EngineError::invalid("desktop session closed"))?
                .view;
            if !view.is_object() {
                *view = json!({});
            }
            view["shapeBuilderMode"] = mode.into();
            return Ok(json!({"mode":mode}));
        }
        let ids = geometry_targets(self, session, snapshot, selection, params)?;
        if ids.len() > 24 {
            return Err(EngineError::new(
                "resource_limit",
                "shape builder accepts at most 24 layers",
            ));
        }
        let scene = paths::scene(snapshot, &state.page_id)?;
        let mut items = geometry_items(&scene, &ids)?;
        let indices: BTreeMap<_, _> = scene
            .items
            .iter()
            .enumerate()
            .map(|(i, item)| (item.id.as_str(), i))
            .collect();
        items.sort_by_key(|item| indices[item.id.as_str()]);
        let mut parts = Vec::new();
        for item in &items {
            if !matches!(
                item.kind,
                NodeKind::Rect
                    | NodeKind::Ellipse
                    | NodeKind::Line
                    | NodeKind::Path
                    | NodeKind::Frame
            ) || !item.children.is_empty() && item.boolean_operation().is_none()
            {
                return Err(EngineError::invalid(
                    "shape builder requires shapes without content layers",
                ));
            }
            let mut fills = vector::solid_fills(item)?;
            fills.retain(visible_paint);
            if !fills.is_empty() {
                let path = omc_scene::shape_path(item)
                    .ok_or_else(|| EngineError::invalid("invalid shape geometry"))?;
                let path = page_path(path, item.world)?;
                if let Some(path) = area(path)? {
                    parts.push(Part {
                        item,
                        stroke: false,
                        path,
                        fills,
                    });
                }
            }
            let has_strokes = item
                .properties
                .get("strokes")
                .and_then(Value::as_array)
                .map_or_else(
                    || {
                        item.style
                            .color("border-color")
                            .is_some_and(|color| color.a > 0.)
                    },
                    |strokes| strokes.iter().any(visible_paint),
                );
            if has_strokes {
                for (path, fill) in omc_render::stroke_outlines(item)
                    .map_err(|error| EngineError::invalid(error.to_string()))?
                {
                    if visible_paint(&fill)
                        && let Some(path) = area(page_path(path, item.world)?)?
                    {
                        parts.push(Part {
                            item,
                            stroke: true,
                            path,
                            fills: vec![fill],
                        });
                    }
                }
            }
        }
        if parts.len() > 64 {
            return Err(EngineError::new(
                "resource_limit",
                "shape builder accepts at most 64 fill and stroke parts",
            ));
        }
        let regions = partition(&parts)?;
        let alias = |id: &str| self.fig_alias(session, document, id);
        if name == "shapeBuilder.regions" {
            let values = regions.iter().enumerate().map(|(index,region)| {
                let (svg,bounds,_) = omc_scene::path_geometry(&region.path);
                let mut seen = BTreeSet::new();
                let sources = region.parts.iter().rev().filter_map(|&part| {
                    let id = alias(&parts[part].item.id);
                    seen.insert(id).then_some(id)
                }).collect::<Vec<_>>();
                let covering = region.parts.iter().rev().map(|&part| json!({"id":alias(&parts[part].item.id),"stroke":parts[part].stroke})).collect::<Vec<_>>();
                json!({"index":index,"path":svg,"sources":sources,"parts":covering,"bounds":bounds,"point":region.point})
            }).collect::<Vec<_>>();
            return Ok(
                json!({"sources":items.iter().map(|item|alias(&item.id)).collect::<Vec<_>>(),"regions":values}),
            );
        }
        let mut selection = BTreeSet::new();
        if let Some(list) = params.get("regions") {
            for index in list
                .as_array()
                .filter(|list| list.len() <= 512)
                .ok_or_else(|| EngineError::invalid("regions must be an array"))?
            {
                let index = index
                    .as_u64()
                    .filter(|&index| index < regions.len() as u64)
                    .ok_or_else(|| EngineError::invalid("unknown shape builder region"))?;
                selection.insert(index as usize);
            }
        }
        if let Some(points) = params.get("points") {
            for point in points
                .as_array()
                .filter(|list| list.len() <= 512)
                .ok_or_else(|| EngineError::invalid("points must be an array"))?
            {
                let (x, y) = point_pair(point)?;
                if let Some(index) = regions
                    .iter()
                    .position(|region| region.path.contains((x as f32, y as f32)))
                {
                    selection.insert(index);
                }
            }
        }
        if selection.is_empty() {
            return Err(EngineError::invalid(
                "choose at least one shape builder region",
            ));
        }
        let mut cutters = BTreeMap::<usize, Path>::new();
        let mut merged = Path::new();
        for &index in &selection {
            let region = &regions[index];
            merged = merge(&merged, &region.path, PathOp::Union)?;
            for &part in &region.parts {
                let prior = cutters.remove(&part).unwrap_or_default();
                cutters.insert(part, merge(&prior, &region.path, PathOp::Union)?);
            }
        }
        let mut commands = Vec::new();
        let mut outlines = Vec::new();
        let mut changed = Vec::new();
        let mut removed = Vec::new();
        for item in &items {
            if !cutters.keys().any(|&index| parts[index].item.id == item.id) {
                continue;
            }
            let parent = &scene.items[item.parent.unwrap()];
            let mut made = false;
            for (index, part) in parts
                .iter()
                .enumerate()
                .filter(|(_, part)| part.item.id == item.id)
            {
                let path = if let Some(cutter) = cutters.get(&index) {
                    merge(&part.path, cutter, PathOp::Difference)?
                } else {
                    part.path.clone()
                };
                if path.is_empty() {
                    continue;
                }
                let node = region_node(
                    snapshot,
                    part,
                    parent,
                    path,
                    item.properties
                        .get("name")
                        .and_then(Value::as_str)
                        .unwrap_or("Vector"),
                )?;
                if part.stroke {
                    outlines.push(alias(&node.id));
                }
                changed.push(alias(&node.id));
                commands.push(Command::NodeCreate { node });
                made = true;
            }
            commands.push(vector::hide(&item.id));
            if !made {
                removed.push(alias(&item.id));
            }
        }
        let mut result =
            json!({"changed":changed,"removed":removed,"outlines":outlines,"regions":selection});
        if name == "shapeBuilder.merge" {
            let source = &parts[*regions[*selection.first().unwrap()].parts.last().unwrap()];
            let parent = &scene.items[source.item.parent.unwrap()];
            let node = region_node(snapshot, source, parent, merged, "Shape builder")?;
            result["id"] = json!(alias(&node.id));
            commands.push(Command::NodeCreate { node });
        }
        self.submit(
            session,
            document,
            Command::Batch { commands },
            &Value::Null,
            Some(snapshot.sequence),
        )?;
        if let Some(id) = result.get("id") {
            self.fig_selection(
                &(session.into(), document.clone()),
                std::slice::from_ref(id),
            );
        }
        Ok(result)
    }
}

fn visible_paint(paint: &Value) -> bool {
    paint["visible"] != false
        && paint["hidden"] != true
        && paint["opacity"].as_f64().unwrap_or(1.) > 0.
        && paint["color"]
            .as_str()
            .or(paint.as_str())
            .and_then(omc_style::parse_color)
            .is_none_or(|color| color.a > 0.)
}

fn page_path(mut path: Path, affine: Affine) -> Result<Path> {
    let [a, b, c, d, x, y] = affine.0.map(|value| value as f32);
    path.transform(&Matrix::new_all(a, c, x, b, d, y, 0., 0., 1.));
    if !path.is_finite() || path.count_verbs() > 10_000 {
        return Err(EngineError::new(
            "resource_limit",
            "shape builder path exceeds supported geometry",
        ));
    }
    Ok(path)
}

fn merge(a: &Path, b: &Path, op: PathOp) -> Result<Path> {
    let path = a
        .op(b, op)
        .ok_or_else(|| EngineError::invalid("shape builder could not combine geometry"))?;
    if !path.is_finite() || path.count_verbs() > 10_000 {
        return Err(EngineError::new(
            "resource_limit",
            "shape builder path exceeds 10000 verbs",
        ));
    }
    Ok(path)
}

fn area(path: Path) -> Result<Option<Path>> {
    let simple = merge(&path, &path, PathOp::Union)?;
    Ok((!simple.is_empty() && !simple.compute_tight_bounds().is_empty()).then_some(simple))
}

fn partition(parts: &[Part]) -> Result<Vec<Region>> {
    let mut regions = Vec::<(Path, Vec<usize>)>::new();
    for (index, part) in parts.iter().enumerate() {
        let mut remaining = part.path.clone();
        let mut next = Vec::new();
        for (old, contributors) in regions {
            let shared = merge(&old, &part.path, PathOp::Intersect)?;
            if shared.is_empty() {
                next.push((old, contributors));
                continue;
            }
            let leftover = merge(&old, &part.path, PathOp::Difference)?;
            if !leftover.is_empty() {
                next.push((leftover, contributors.clone()));
            }
            let mut covered = contributors;
            covered.push(index);
            next.push((shared, covered));
            remaining = merge(&remaining, &old, PathOp::Difference)?;
        }
        if !remaining.is_empty() {
            next.push((remaining, vec![index]));
        }
        if next.len() > 512
            || next
                .iter()
                .map(|(path, _)| path.count_verbs())
                .sum::<usize>()
                > 100_000
        {
            return Err(EngineError::new(
                "resource_limit",
                "shape builder exceeds the region budget",
            ));
        }
        regions = next;
    }
    regions
        .into_iter()
        .map(|(path, parts)| {
            let point = inside_point(&path).ok_or_else(|| {
                EngineError::invalid("shape builder could not locate an interior point")
            })?;
            Ok(Region { path, parts, point })
        })
        .collect()
}

fn inside_point(path: &Path) -> Option<(f32, f32)> {
    let bounds = path.compute_tight_bounds();
    for steps in [1, 4, 16, 64] {
        for row in 0..steps {
            for col in 0..steps {
                let point = (
                    bounds.left + bounds.width() * (col as f32 + 0.5) / steps as f32,
                    bounds.top + bounds.height() * (row as f32 + 0.5) / steps as f32,
                );
                if path.contains(point) {
                    return Some(point);
                }
            }
        }
    }
    None
}

fn region_node(
    snapshot: &DocumentSnapshot,
    source: &Part,
    parent: &SceneItem,
    path: Path,
    name: &str,
) -> Result<Node> {
    let inverse = parent
        .world
        .inverse()
        .ok_or_else(|| EngineError::invalid("parent transform is not invertible"))?;
    let (svg, [x, y, w, h], rule) = omc_scene::normalize_path(path, inverse);
    let mut node = vector::sibling(snapshot, source.item, parent, NodeKind::Path);
    vector::set_position(&mut node.properties, x, y, w, h);
    vector::set_path(&mut node.properties, svg, rule);
    vector::copy_effects(source.item, &mut node);
    node.properties.insert("name".into(), json!(name));
    node.properties.insert("fills".into(), json!(source.fills));
    Ok(node)
}
