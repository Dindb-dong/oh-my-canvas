use super::*;
use omc_scene::{Affine, Scene, SceneOptions};
use std::fmt::Write;
use svgtypes::{SimplePathSegment, SimplifyingPathParser};

type Point = (f64, f64);

#[derive(Clone, Copy)]
enum Edge {
    Move,
    Line,
    Cubic(Point, Point),
    Close,
}

#[derive(Clone)]
struct Segment {
    edge: Edge,
    end: Point,
    mode: Option<String>,
}

impl Segment {
    fn new(edge: Edge, end: Point) -> Self {
        Self {
            edge,
            end,
            mode: None,
        }
    }

    fn transform(&mut self, transform: Affine) {
        let point = |(x, y)| transform.point(x, y);
        self.end = point(self.end);
        if let Edge::Cubic(first, second) = self.edge {
            self.edge = Edge::Cubic(point(first), point(second));
        }
    }

    fn controls(&self, start: Point) -> (Point, Point) {
        match self.edge {
            Edge::Cubic(first, second) => (first, second),
            _ => (start, self.end),
        }
    }

    fn drawable(&self) -> bool {
        matches!(self.edge, Edge::Line | Edge::Cubic(..))
    }
}

fn lerp(a: Point, b: Point, t: f64) -> Point {
    (a.0 + (b.0 - a.0) * t, a.1 + (b.1 - a.1) * t)
}

fn geometry(node: &Node) -> Result<Vec<Segment>> {
    if node.kind != omc_model::NodeKind::Path {
        return Err(EngineError::invalid("choose an editable vector path"));
    }
    let path = node
        .string("path")
        .ok_or_else(|| EngineError::invalid("path geometry missing"))?;
    let mut segments: Vec<Segment> = Vec::new();
    for (index, value) in SimplifyingPathParser::from(path).enumerate() {
        if index >= 10_000 {
            return Err(EngineError::new(
                "resource_limit",
                "path exceeds 10000 segments",
            ));
        }
        let (edge, end) = match value.map_err(|error| EngineError::invalid(error.to_string()))? {
            SimplePathSegment::MoveTo { x, y } => (Edge::Move, (x, y)),
            SimplePathSegment::LineTo { x, y } => (Edge::Line, (x, y)),
            SimplePathSegment::CurveTo {
                x1,
                y1,
                x2,
                y2,
                x,
                y,
            } => (Edge::Cubic((x1, y1), (x2, y2)), (x, y)),
            SimplePathSegment::Quadratic { x1, y1, x, y } => {
                let start = segments
                    .last()
                    .ok_or_else(|| EngineError::invalid("missing path start"))?
                    .end;
                (
                    Edge::Cubic(
                        lerp(start, (x1, y1), 2. / 3.),
                        lerp((x, y), (x1, y1), 2. / 3.),
                    ),
                    (x, y),
                )
            }
            SimplePathSegment::ClosePath => (Edge::Close, (0., 0.)),
        };
        let mut segment = Segment::new(edge, end);
        segment.mode = node
            .properties
            .get("pathHandleModes")
            .and_then(|modes| modes[index].as_str())
            .map(str::to_owned);
        segments.push(segment);
    }
    if segments.is_empty() {
        return Err(EngineError::invalid("path is empty"));
    }
    Ok(segments)
}

pub(super) fn scene(snapshot: &DocumentSnapshot, page: &str) -> Result<Scene> {
    omc_scene::build_scene(
        snapshot,
        &SceneOptions {
            page_id: Some(page.into()),
            ..Default::default()
        },
    )
    .map_err(|error| EngineError::invalid(error.to_string()))
}

pub(super) fn editable(scene: &Scene, id: &str) -> bool {
    let mut item = scene.item(id);
    while let Some(node) = item {
        if node.hidden || node.locked {
            return false;
        }
        item = node.parent.map(|parent| &scene.items[parent]);
    }
    scene.item(id).is_some()
}

pub(super) fn inspect(snapshot: &DocumentSnapshot, page: &str, id: &str) -> Result<Value> {
    let scene = scene(snapshot, page)?;
    let item = scene
        .item(id)
        .ok_or_else(|| EngineError::invalid("path is outside the selected page"))?;
    let world = item.world;
    let live = item.boolean_operation().is_some();
    let authored = snapshot.nodes.get(id);
    let mut projected;
    let node = if let Some(node) = authored.filter(|_| !live) {
        node
    } else {
        projected = authored.cloned().unwrap_or_else(|| Node::new(item.kind));
        projected.properties = item.properties.clone();
        &projected
    };
    let geometry = if live && node.string("path") == Some("") {
        Vec::new()
    } else {
        geometry(node)?
    };
    let segments = geometry
        .into_iter()
        .enumerate()
        .map(|(index, mut segment)| {
            segment.transform(world);
            let (x, y) = segment.end;
            let mut result = match segment.edge {
                Edge::Move => json!({"command":"move","x":x,"y":y}),
                Edge::Line => json!({"command":"line","x":x,"y":y}),
                Edge::Cubic((x1, y1), (x2, y2)) => {
                    json!({"command":"curve","x":x,"y":y,"x1":x1,"y1":y1,"x2":x2,"y2":y2})
                }
                Edge::Close => json!({"command":"close"}),
            };
            result["index"] = index.into();
            if let Some(mode) = segment.mode {
                result["handleMode"] = mode.into();
            }
            result
        })
        .collect::<Vec<_>>();
    Ok(
        json!({"rawId":id,"coordinateSpace":"world","fillRule":node.string("fillRule").unwrap_or("nonzero"),
        "editable":!live && authored.is_some() && editable(&scene,id),"segments":segments,"path":node.string("path"),"properties":node.properties}),
    )
}

pub(super) fn edit(
    snapshot: &DocumentSnapshot,
    page: &str,
    id: &str,
    other: Option<&str>,
    args: &Value,
) -> Result<Vec<Command>> {
    let scene = scene(snapshot, page)?;
    let editable_path = |id| snapshot.nodes.contains_key(id) && editable(&scene, id);
    if !editable_path(id) || other.is_some_and(|id| !editable_path(id)) {
        return Err(EngineError::invalid(
            "path is locked, hidden or outside the selected page",
        ));
    }
    if scene
        .item(id)
        .is_some_and(|item| item.boolean_operation().is_some())
        || other
            .and_then(|id| scene.item(id))
            .is_some_and(|item| item.boolean_operation().is_some())
    {
        return Err(EngineError::invalid(
            "flatten live Boolean paths before editing their points",
        ));
    }
    let node = &snapshot.nodes[id];
    let mut segments = geometry(node)?;
    let world = scene.item(id).unwrap().world;
    let inverse = world
        .inverse()
        .ok_or_else(|| EngineError::invalid("path transform is not invertible"))?;
    let action = string(args, "action")?;
    let index = args["index"].as_u64().map(|index| index as usize);
    let indices = args["indices"]
        .as_array()
        .map(|values| {
            values
                .iter()
                .map(|v| v.as_u64().unwrap() as usize)
                .collect::<Vec<_>>()
        })
        .unwrap_or_else(|| index.into_iter().collect());
    if indices.iter().any(|&index| {
        segments
            .get(index)
            .is_none_or(|segment| matches!(segment.edge, Edge::Close))
    }) {
        return Err(EngineError::invalid("unknown path node index"));
    }
    match action {
        "move_nodes" => {
            let (x, y) = inverse.point(args["dx"].as_f64().unwrap(), args["dy"].as_f64().unwrap());
            let (origin_x, origin_y) = inverse.point(0., 0.);
            let shift = |(x0, y0)| (x0 + x - origin_x, y0 + y - origin_y);
            for index in indices
                .into_iter()
                .collect::<std::collections::BTreeSet<_>>()
            {
                let segment = &mut segments[index];
                segment.end = shift(segment.end);
                if let Edge::Cubic(first, second) = segment.edge {
                    segment.edge = Edge::Cubic(first, shift(second));
                }
                if let Some(next) = segments.get_mut(index + 1)
                    && let Edge::Cubic(first, second) = next.edge
                {
                    next.edge = Edge::Cubic(shift(first), second);
                }
            }
        }
        "insert_node" => {
            let index = index.unwrap();
            let t = args["t"].as_f64().unwrap_or(0.5);
            if index == 0 || !segments[index].drawable() || !(0. < t && t < 1.) {
                return Err(EngineError::invalid(
                    "choose a segment and a split position inside it",
                ));
            }
            let from = segments[index - 1].end;
            let segment = &mut segments[index];
            let to = segment.end;
            let inserted = if let Edge::Cubic(a, b) = segment.edge {
                let (ab, bc, cd) = (lerp(from, a, t), lerp(a, b, t), lerp(b, to, t));
                let (abc, bcd) = (lerp(ab, bc, t), lerp(bc, cd, t));
                segment.edge = Edge::Cubic(bcd, cd);
                Segment::new(Edge::Cubic(ab, abc), lerp(abc, bcd, t))
            } else {
                Segment::new(Edge::Line, lerp(from, to, t))
            };
            segments.insert(index, inserted);
        }
        "delete_nodes" | "open" | "close" => {
            let mut output = Vec::new();
            let mut start = 0;
            for path in segments.split_inclusive(|segment| matches!(segment.edge, Edge::Close)) {
                let mut cuts = path
                    .iter()
                    .enumerate()
                    .filter_map(|(i, segment)| {
                        (i > 0 && matches!(segment.edge, Edge::Move)).then_some(i)
                    })
                    .collect::<Vec<_>>();
                cuts.push(path.len());
                let mut offset = 0;
                for end in cuts {
                    let subpath = &path[offset..end];
                    let closed = matches!(subpath.last().unwrap().edge, Edge::Close);
                    let modify =
                        index.is_none_or(|index| (start + offset..start + end).contains(&index));
                    let begin = output.len();
                    for (i, segment) in subpath.iter().enumerate() {
                        if matches!(segment.edge, Edge::Close)
                            || action == "delete_nodes" && indices.contains(&(start + offset + i))
                        {
                            continue;
                        }
                        let mut segment = segment.clone();
                        if output.len() == begin {
                            segment.edge = Edge::Move;
                        }
                        output.push(segment);
                    }
                    let close = if modify && action != "delete_nodes" {
                        action == "close"
                    } else {
                        closed
                    };
                    if close && output.len() > begin + 1 {
                        output.push(Segment::new(Edge::Close, (0., 0.)));
                    }
                    offset = end;
                }
                start += path.len();
            }
            segments = output;
        }
        "set_handle" | "convert_node" => {
            let index = index.unwrap();
            let p = segments[index].end;
            let previous = segments[index].drawable().then(|| segments[index - 1].end);
            let next = segments
                .get(index + 1)
                .filter(|segment| segment.drawable())
                .map(|segment| segment.end);
            let incoming = args["handle"] == "in";
            let mode = if action == "convert_node" {
                string(args, "nodeKind")?.to_owned()
            } else {
                args["mode"]
                    .as_str()
                    .or(segments[index].mode.as_deref())
                    .unwrap_or("free")
                    .to_owned()
            };
            segments[index].mode = Some(mode.clone());
            let point = if action == "set_handle" {
                if if incoming {
                    previous.is_none()
                } else {
                    next.is_none()
                } {
                    return Err(EngineError::invalid(
                        "open endpoint has no handle on this side",
                    ));
                }
                let point = &args["point"];
                Some(inverse.point(point["x"].as_f64().unwrap(), point["y"].as_f64().unwrap()))
            } else {
                None
            };
            let a = previous.unwrap_or(p);
            let b = next.unwrap_or(p);
            let delta = ((b.0 - a.0) / 6., (b.1 - a.1) / 6.);
            let mirror = |chosen: Point, old: Point| {
                let (dx, dy) = (chosen.0 - p.0, chosen.1 - p.1);
                let length = dx.hypot(dy);
                if length == 0. {
                    return p;
                }
                let factor = if mode == "symmetric" {
                    1.
                } else {
                    (old.0 - p.0).hypot(old.1 - p.1) / length
                };
                (p.0 - dx * factor, p.1 - dy * factor)
            };
            for (edge, start, left, direct) in
                [(index, a, false, incoming), (index + 1, p, true, !incoming)]
            {
                if let Some(segment) = segments.get_mut(edge).filter(|segment| segment.drawable()) {
                    let (first, second) = segment.controls(start);
                    let old = if left { first } else { second };
                    let handle = match point {
                        Some(point) if direct => point,
                        Some(point)
                            if matches!(mode.as_str(), "aligned" | "smooth" | "symmetric") =>
                        {
                            mirror(point, old)
                        }
                        Some(_) => continue,
                        None if mode == "corner" => p,
                        None if left => (p.0 + delta.0, p.1 + delta.1),
                        None => (p.0 - delta.0, p.1 - delta.1),
                    };
                    segment.edge = if left {
                        Edge::Cubic(handle, second)
                    } else {
                        Edge::Cubic(first, handle)
                    };
                }
            }
        }
        "join" | "merge" => {
            let check_open = |path: &[Segment]| -> Result<()> {
                if path.len() < 2 || path.iter().skip(1).any(|segment| !segment.drawable()) {
                    return Err(EngineError::invalid(
                        "choose one open subpath with at least two nodes",
                    ));
                }
                Ok(())
            };
            check_open(&segments)?;
            if let Some(other) = other {
                let mut other_segments = geometry(&snapshot.nodes[other])?;
                check_open(&other_segments)?;
                let transform = inverse.multiply(scene.item(other).unwrap().world);
                for segment in &mut other_segments {
                    segment.transform(transform);
                }
                if args["firstStart"] == true {
                    segments = reverse(segments);
                }
                if args["secondEnd"] == true {
                    other_segments = reverse(other_segments);
                }
                let end = segments.last_mut().unwrap();
                let start = other_segments[0].end;
                if action == "merge" || (end.end.0 - start.0).hypot(end.end.1 - start.1) < 1e-6 {
                    end.end = lerp(end.end, start, 0.5);
                    other_segments.remove(0);
                } else {
                    other_segments[0].edge = Edge::Line;
                }
                segments.extend(other_segments);
            } else {
                if action == "merge" && segments.len() > 2 {
                    let end = segments.pop().unwrap().end;
                    segments[0].end = lerp(segments[0].end, end, 0.5);
                }
                segments.push(Segment::new(Edge::Close, (0., 0.)));
            }
        }
        "primitive" => {
            let primitive = &args["primitive"];
            let kind = primitive["kind"]
                .as_str()
                .or(node
                    .properties
                    .get("primitive")
                    .and_then(|old| old["kind"].as_str()))
                .ok_or_else(|| EngineError::invalid("primitive kind required"))?;
            let count = primitive["count"]
                .as_u64()
                .or(node
                    .properties
                    .get("primitive")
                    .and_then(|old| old["count"].as_u64()))
                .unwrap_or(3);
            let ratio = primitive["ratio"]
                .as_f64()
                .or(node
                    .properties
                    .get("primitive")
                    .and_then(|old| old["ratio"].as_f64()))
                .unwrap_or(0.5)
                .clamp(0.001, 0.999);
            let item = scene.item(id).unwrap();
            let bounds = omc_render::shape_path_bounds(item)
                .map_err(|error| EngineError::invalid(error.to_string()))?;
            let total = count * if kind == "star" { 2 } else { 1 };
            let path = super::mutations::regular_polygon_path(
                bounds,
                total as usize,
                if kind == "star" { ratio } else { 1. },
            );
            return Ok(vec![Command::NodeSet {
                node_id: id.into(),
                properties: Properties::from([
                    ("path".into(), json!(path)),
                    ("pathHandleModes".into(), json!([])),
                    (
                        "primitive".into(),
                        json!({"kind":kind,"count":count,"ratio":ratio}),
                    ),
                ]),
            }]);
        }
        _ => return Err(EngineError::invalid("unknown path operation")),
    }
    let mut path = String::new();
    for segment in &segments {
        let (x, y) = segment.end;
        match segment.edge {
            Edge::Move => write!(path, "M {x} {y} "),
            Edge::Line => write!(path, "L {x} {y} "),
            Edge::Cubic((x1, y1), (x2, y2)) => write!(path, "C {x1} {y1} {x2} {y2} {x} {y} "),
            Edge::Close => write!(path, "Z "),
        }
        .unwrap();
    }
    if path.is_empty() {
        return Err(EngineError::invalid(
            "a vector must retain at least one node",
        ));
    }
    let mut commands = vec![Command::NodeSet {
        node_id: id.into(),
        properties: Properties::from([
            ("path".into(), json!(path.trim())),
            (
                "pathHandleModes".into(),
                json!(
                    segments
                        .iter()
                        .map(|segment| &segment.mode)
                        .collect::<Vec<_>>()
                ),
            ),
            ("primitive".into(), Value::Null),
        ]),
    }];
    if let Some(other) = other {
        commands.push(Command::NodeDelete {
            node_ids: vec![other.into()],
        });
    }
    Ok(commands)
}

fn reverse(path: Vec<Segment>) -> Vec<Segment> {
    let mut last = path.last().unwrap().clone();
    last.edge = Edge::Move;
    std::iter::once(last)
        .chain(path.windows(2).rev().map(|pair| {
            let mut segment = pair[0].clone();
            segment.edge = match pair[1].edge {
                Edge::Cubic(first, second) => Edge::Cubic(second, first),
                _ => Edge::Line,
            };
            segment
        }))
        .collect()
}
