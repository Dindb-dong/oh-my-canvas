use super::*;
use crate::paths::{Edge, Point, Segment};
use serde::{Deserialize, Serialize};

#[derive(Clone, Default, Deserialize, Serialize)]
struct EditSelection {
    vertices: BTreeSet<usize>,
    segments: BTreeSet<usize>,
    handles: BTreeSet<(usize, bool)>,
}

#[derive(Default, Deserialize, Serialize)]
struct EditState {
    page: String,
    active: String,
    ids: Vec<String>,
    tool: String,
    pen: Option<usize>,
    selected: BTreeMap<String, EditSelection>,
}

struct Network {
    geometry: Vec<Segment>,
    vertices: Vec<usize>,
    edges: Vec<(usize, usize, usize)>,
}

impl Network {
    fn new(node: &Node) -> Result<Self> {
        let geometry = paths::geometry(node)?;
        let mut vertices = Vec::new();
        let mut edges = Vec::new();
        let mut start = 0;
        for (index, segment) in geometry.iter().enumerate() {
            let vertex = vertices.len();
            if vertex == 0 && !matches!(segment.edge, Edge::Move) {
                return Err(EngineError::invalid(
                    "vector contour must begin with a point",
                ));
            }
            match segment.edge {
                Edge::Move => start = vertex,
                Edge::Line | Edge::Cubic(..) => edges.push((index, vertex - 1, vertex)),
                Edge::Close => {
                    edges.push((index, vertex - 1, start));
                    continue;
                }
            }
            vertices.push(index);
        }
        Ok(Self {
            geometry,
            vertices,
            edges,
        })
    }

    fn point(&self, vertex: usize) -> Point {
        self.geometry[self.vertices[vertex]].end
    }

    fn vertex_set(&self, selected: &EditSelection) -> BTreeSet<usize> {
        let mut vertices = selected.vertices.clone();
        for &segment in &selected.segments {
            if let Some((_, a, b)) = self.edges.get(segment) {
                vertices.extend([*a, *b]);
            }
        }
        vertices.retain(|index| *index < self.vertices.len());
        vertices
    }

    fn validate(&self, selection: &EditSelection) -> Result<()> {
        if selection.vertices.iter().any(|&n| n >= self.vertices.len())
            || selection.segments.iter().any(|&n| n >= self.edges.len())
            || selection
                .handles
                .iter()
                .any(|&(n, _)| n >= self.edges.len())
        {
            return Err(EngineError::invalid("unknown vector element index"));
        }
        Ok(())
    }

    fn edit_points(&mut self, selected: &BTreeSet<usize>, transform: Affine) {
        let point = |(x, y)| transform.point(x, y);
        for &(index, a, b) in &self.edges {
            if let Edge::Cubic(first, last) = self.geometry[index].edge {
                self.geometry[index].edge = Edge::Cubic(
                    if selected.contains(&a) {
                        point(first)
                    } else {
                        first
                    },
                    if selected.contains(&b) {
                        point(last)
                    } else {
                        last
                    },
                );
            }
        }
        for &vertex in selected {
            let index = self.vertices[vertex];
            self.geometry[index].end = point(self.geometry[index].end);
        }
    }

    fn controls(&self, edge: usize) -> (Point, Point) {
        let (index, a, b) = self.edges[edge];
        match self.geometry[index].edge {
            Edge::Cubic(first, last) => (first, last),
            _ => (self.point(a), self.point(b)),
        }
    }

    fn set_handle(
        &mut self,
        edge: usize,
        start: bool,
        value: Point,
        independent: bool,
    ) -> Result<()> {
        let (index, from, to) = self.edges[edge];
        if matches!(self.geometry[index].edge, Edge::Close) {
            return Err(EngineError::invalid(
                "closing edges must be split before editing handles",
            ));
        }
        let (first, last) = self.controls(edge);
        self.geometry[index].edge = if start {
            Edge::Cubic(value, last)
        } else {
            Edge::Cubic(first, value)
        };
        let vertex = if start { from } else { to };
        let mode = self.geometry[self.vertices[vertex]].mode.as_deref();
        if independent || !matches!(mode, Some("symmetric" | "aligned" | "smooth")) {
            return Ok(());
        }
        let other = self
            .edges
            .iter()
            .enumerate()
            .find_map(|(other, &(_, a, b))| {
                (other != edge && if start { b == vertex } else { a == vertex }).then_some(other)
            });
        if let Some(other) = other {
            let origin = self.point(vertex);
            let (other_first, other_last) = self.controls(other);
            let old = if start { other_last } else { other_first };
            let distance = (value.0 - origin.0).hypot(value.1 - origin.1);
            let factor = if mode == Some("symmetric") {
                1.
            } else if distance == 0. {
                0.
            } else {
                (old.0 - origin.0).hypot(old.1 - origin.1) / distance
            };
            let reflected = (
                origin.0 + (origin.0 - value.0) * factor,
                origin.1 + (origin.1 - value.1) * factor,
            );
            if !matches!(self.geometry[self.edges[other].0].edge, Edge::Close) {
                self.set_handle(other, !start, reflected, true)?;
            }
        }
        Ok(())
    }

    fn bend(&mut self, edge: usize, t: f64, point: Point) -> Result<()> {
        let &(index, a, b) = self
            .edges
            .get(edge)
            .ok_or_else(|| EngineError::invalid("unknown vector segment"))?;
        let start = self.point(a);
        let end = self.point(b);
        let (first, last) = if matches!(self.geometry[index].edge, Edge::Cubic(..)) {
            self.controls(edge)
        } else {
            (mix(start, end, 1. / 3.), mix(start, end, 2. / 3.))
        };
        let m = 1. - t;
        let wa = 3. * m * m * t;
        let wb = 3. * m * t * t;
        let at = (
            m * m * m * start.0 + wa * first.0 + wb * last.0 + t * t * t * end.0,
            m * m * m * start.1 + wa * first.1 + wb * last.1 + t * t * t * end.1,
        );
        let shift = ((point.0 - at.0) / (wa + wb), (point.1 - at.1) / (wa + wb));
        self.set_handle(edge, true, (first.0 + shift.0, first.1 + shift.1), true)?;
        self.set_handle(edge, false, (last.0 + shift.0, last.1 + shift.1), true)
    }

    fn connect(&mut self, a: usize, b: usize) -> Result<()> {
        if a == b
            || a >= self.vertices.len()
            || b >= self.vertices.len()
            || self
                .edges
                .iter()
                .any(|&(_, x, y)| (x == a && y == b) || (x == b && y == a))
        {
            return Err(EngineError::invalid(
                "choose distinct unconnected vector points",
            ));
        }
        let (a_index, b_index) = (self.vertices[a], self.vertices[b]);
        let is_start = |index: usize| matches!(self.geometry[index].edge, Edge::Move);
        let is_end = |index: usize| {
            self.geometry
                .get(index + 1)
                .is_none_or(|segment| matches!(segment.edge, Edge::Move))
        };
        let (end, start) = if is_end(a_index) && is_start(b_index) {
            (a_index, b_index)
        } else if is_end(b_index) && is_start(a_index) {
            (b_index, a_index)
        } else {
            return Err(EngineError::invalid(
                "connect requires an open contour's end and another point at its start",
            ));
        };
        let contour_start = self.geometry[..=end]
            .iter()
            .rposition(|s| matches!(s.edge, Edge::Move))
            .unwrap();
        if contour_start == start {
            self.geometry
                .insert(end + 1, Segment::new(Edge::Close, (0., 0.)));
            return Ok(());
        }
        let contour_end = self.geometry[start + 1..]
            .iter()
            .position(|s| matches!(s.edge, Edge::Move))
            .map_or(self.geometry.len(), |offset| start + 1 + offset);
        let mut contour = self.geometry[start..contour_end].to_vec();
        if contour
            .iter()
            .any(|segment| matches!(segment.edge, Edge::Close))
        {
            return Err(EngineError::invalid(
                "open the target contour before connecting",
            ));
        }
        contour[0].edge = Edge::Line;
        self.geometry.drain(start..contour_end);
        let insert = if end > start {
            end + 1 - (contour_end - start)
        } else {
            end + 1
        };
        self.geometry.splice(insert..insert, contour);
        Ok(())
    }

    fn pen(
        &mut self,
        active: Option<usize>,
        point: Point,
        handle: Point,
        scale: f64,
    ) -> Result<Option<usize>> {
        let nearby = (0..self.vertices.len()).find(|&index| {
            let old = self.point(index);
            (old.0 - point.0).hypot(old.1 - point.1) < 3. / scale.max(0.01)
        });
        if let Some(from) = active {
            let from_index = *self
                .vertices
                .get(from)
                .ok_or_else(|| EngineError::invalid("the pen's starting point was removed"))?;
            if let Some(to) = nearby {
                self.connect(from, to)?;
                return Ok(None);
            }
            if self
                .geometry
                .get(from_index + 1)
                .is_some_and(|segment| !matches!(segment.edge, Edge::Move))
            {
                return Err(EngineError::invalid(
                    "continue the pen from an open contour's end",
                ));
            }
            let edge = if handle == (0., 0.) {
                Edge::Line
            } else {
                Edge::Cubic(self.point(from), (point.0 - handle.0, point.1 - handle.1))
            };
            self.geometry
                .insert(from_index + 1, Segment::new(edge, point));
            return Ok(Some(from + 1));
        }
        if let Some(vertex) = nearby {
            return Ok(Some(vertex));
        }
        self.geometry.push(Segment::new(Edge::Move, point));
        Ok(Some(self.vertices.len()))
    }

    fn cut_segment(&mut self, edge: usize, t: f64) -> Result<()> {
        let &(index, a, b) = self
            .edges
            .get(edge)
            .ok_or_else(|| EngineError::invalid("unknown vector segment"))?;
        let start = self.point(a);
        let end = self.point(b);
        let segment = &mut self.geometry[index];
        if let Edge::Cubic(first, last) = segment.edge {
            let ab = mix(start, first, t);
            let bc = mix(first, last, t);
            let cd = mix(last, end, t);
            let abc = mix(ab, bc, t);
            let bcd = mix(bc, cd, t);
            segment.edge = Edge::Cubic(bcd, cd);
            self.geometry
                .insert(index, Segment::new(Edge::Cubic(ab, abc), mix(abc, bcd, t)));
        } else {
            self.geometry
                .insert(index, Segment::new(Edge::Line, mix(start, end, t)));
        }
        self.cut_at(index)
    }

    fn cut_at(&mut self, index: usize) -> Result<()> {
        let start = self.geometry[..=index]
            .iter()
            .rposition(|s| matches!(s.edge, Edge::Move))
            .unwrap();
        let end = self.geometry[index + 1..]
            .iter()
            .position(|s| matches!(s.edge, Edge::Move))
            .map_or(self.geometry.len(), |offset| index + 1 + offset);
        let vertex = self.geometry[index].end;
        if matches!(self.geometry[end - 1].edge, Edge::Close) {
            let mut result = vec![Segment::new(Edge::Move, vertex)];
            result.extend_from_slice(&self.geometry[index + 1..end - 1]);
            result.push(Segment::new(Edge::Line, self.geometry[start].end));
            result.extend_from_slice(&self.geometry[start + 1..=index]);
            self.geometry.splice(start..end, result);
        } else if start < index && index < end - 1 {
            self.geometry
                .insert(index + 1, Segment::new(Edge::Move, vertex));
        } else {
            return Err(EngineError::invalid(
                "cut requires an interior point or closed contour",
            ));
        }
        Ok(())
    }

    fn cut_line(&mut self, from: Point, to: Point) -> Result<bool> {
        let mut starts = self
            .geometry
            .iter()
            .enumerate()
            .filter_map(|(index, segment)| matches!(segment.edge, Edge::Move).then_some(index))
            .collect::<Vec<_>>();
        starts.push(self.geometry.len());
        let mut output = Vec::new();
        let mut changed = false;
        for range in starts.windows(2) {
            let contour = &self.geometry[range[0]..range[1]];
            let mut pieces = vec![contour[0].clone()];
            let mut cuts = BTreeSet::new();
            let closed = contour
                .last()
                .is_some_and(|segment| matches!(segment.edge, Edge::Close));
            let mut previous = contour[0].end;
            for segment in &contour[1..] {
                let end = if matches!(segment.edge, Edge::Close) {
                    contour[0].end
                } else {
                    segment.end
                };
                let cubic = matches!(segment.edge, Edge::Cubic(..));
                let (a, b) = match segment.edge {
                    Edge::Cubic(a, b) => (a, b),
                    _ => (mix(previous, end, 1. / 3.), mix(previous, end, 2. / 3.)),
                };
                let mut curve = [previous, a, b, end];
                let mut after = 0.;
                for t in curve_intersections(curve, from, to) {
                    let [left, right] = split_curve(curve, (t - after) / (1. - after));
                    let edge = if cubic {
                        Edge::Cubic(left[1], left[2])
                    } else {
                        Edge::Line
                    };
                    pieces.push(Segment::new(edge, left[3]));
                    cuts.insert(pieces.len() - 1);
                    curve = right;
                    after = t;
                }
                let edge = if cubic {
                    Edge::Cubic(curve[1], curve[2])
                } else {
                    Edge::Line
                };
                pieces.push(Segment {
                    edge,
                    end,
                    mode: segment.mode.clone(),
                });
                previous = end;
            }
            if cuts.is_empty() {
                output.extend_from_slice(contour);
                continue;
            }
            changed = true;
            if closed {
                let first = *cuts.first().unwrap();
                output.push(Segment::new(Edge::Move, pieces[first].end));
                for index in (first + 1..pieces.len()).chain(1..=first) {
                    output.push(pieces[index].clone());
                    if cuts.contains(&index) && index != first {
                        output.push(Segment::new(Edge::Move, pieces[index].end));
                    }
                }
            } else {
                for (index, piece) in pieces.into_iter().enumerate() {
                    let end = piece.end;
                    output.push(piece);
                    if cuts.contains(&index) {
                        output.push(Segment::new(Edge::Move, end));
                    }
                }
            }
        }
        if output.len() > 10_000 {
            return Err(EngineError::new(
                "resource_limit",
                "cut exceeds 10000 path verbs",
            ));
        }
        self.geometry = output;
        Ok(changed)
    }

    fn erase(&mut self, world: Affine, brush: &[Point], radius: f64) -> Result<bool> {
        let mut starts = self
            .geometry
            .iter()
            .enumerate()
            .filter_map(|(index, segment)| matches!(segment.edge, Edge::Move).then_some(index))
            .collect::<Vec<_>>();
        starts.push(self.geometry.len());
        let mut output = Vec::new();
        let mut changed = false;
        let mut work = 0usize;
        let world_point = |(x, y)| world.point(x, y);
        let covered = |point: Point| {
            let point = world_point(point);
            let distance2 = if brush.len() == 1 {
                point_distance2(point, brush[0])
            } else {
                brush
                    .windows(2)
                    .map(|pair| distance_to_segment2(point, pair[0], pair[1]))
                    .fold(f64::INFINITY, f64::min)
            };
            distance2 <= radius * radius
        };
        for range in starts.windows(2) {
            let contour = &self.geometry[range[0]..range[1]];
            let mut pieces = Vec::new();
            let mut touched = false;
            let mut connect = false;
            let mut previous = contour[0].end;
            for segment in &contour[1..] {
                let end = if matches!(segment.edge, Edge::Close) {
                    contour[0].end
                } else {
                    segment.end
                };
                let cubic = matches!(segment.edge, Edge::Cubic(..));
                let (a, b) = match segment.edge {
                    Edge::Cubic(a, b) => (a, b),
                    _ => (mix(previous, end, 1. / 3.), mix(previous, end, 2. / 3.)),
                };
                let curve = [previous, a, b, end];
                let world_curve = curve.map(world_point);
                let length = world_curve
                    .windows(2)
                    .map(|pair| point_distance2(pair[0], pair[1]).sqrt())
                    .sum::<f64>();
                let steps = (2. * length / radius).ceil().max(16.) as usize;
                work = work.saturating_add(steps.saturating_mul(brush.len()));
                if steps > 4096 || work > 2_000_000 {
                    return Err(EngineError::new(
                        "resource_limit",
                        "erase exceeds the brush geometry budget",
                    ));
                }
                let mut changes = Vec::new();
                let initially = covered(previous);
                let mut is_inside = initially;
                for step in 1..=steps {
                    let t = step as f64 / steps as f64;
                    let inside = covered(split_curve(curve, t)[0][3]);
                    if inside != is_inside {
                        let mut left = (step - 1) as f64 / steps as f64;
                        let mut right = t;
                        for _ in 0..24 {
                            let mid = (left + right) / 2.;
                            if covered(split_curve(curve, mid)[0][3]) == is_inside {
                                left = mid;
                            } else {
                                right = mid;
                            }
                        }
                        changes.push((left + right) / 2.);
                        is_inside = inside;
                    }
                }
                let mut remainder = curve;
                let mut after = 0.;
                let mut inside = initially;
                touched |= initially || !changes.is_empty();
                for t in changes.into_iter().chain(std::iter::once(1.)) {
                    let [piece, right] = split_curve(remainder, (t - after) / (1. - after));
                    if inside {
                        connect = false;
                    } else {
                        if !connect {
                            pieces.push(Segment::new(Edge::Move, piece[0]));
                        }
                        let edge = if cubic {
                            Edge::Cubic(piece[1], piece[2])
                        } else {
                            Edge::Line
                        };
                        let mode = if t == 1. { segment.mode.clone() } else { None };
                        pieces.push(Segment {
                            edge,
                            end: piece[3],
                            mode,
                        });
                        connect = true;
                    }
                    remainder = right;
                    after = t;
                    inside = !inside;
                }
                previous = end;
            }
            if contour.len() == 1 && covered(contour[0].end) {
                touched = true;
            }
            if touched {
                output.extend(pieces);
                changed = true;
            } else {
                output.extend_from_slice(contour);
            }
        }
        if output.len() > 10_000 {
            return Err(EngineError::new(
                "resource_limit",
                "erase exceeds 10000 path verbs",
            ));
        }
        self.geometry = output;
        Ok(changed)
    }

    fn overlay(&self, item: &SceneItem, selection: &EditSelection) -> Value {
        let world = |(x, y)| {
            let (x, y) = item.world.point(x, y);
            json!([x, y])
        };
        let vertices = self.vertices.iter().enumerate().map(|(i,&segment)| {
            let p = &self.geometry[segment];
            json!({"index":i,"point":world(p.end),"selected":selection.vertices.contains(&i),"mirroring":match p.mode.as_deref() {Some("aligned"|"smooth")=>"angle",Some("symmetric")=>"angleAndLength",_=>"none"}})
        }).collect::<Vec<_>>();
        let segments = self.edges.iter().enumerate().map(|(i,&(_,a,b))| {
            let (first,last) = self.controls(i);
            json!({"index":i,"start":a,"end":b,"startHandle":world(first),"endHandle":world(last),"selected":selection.segments.contains(&i)})
        }).collect::<Vec<_>>();
        let local = self
            .vertices
            .iter()
            .map(|&index| self.geometry[index].end)
            .collect::<Vec<_>>();
        json!({"vertices":vertices,"segments":segments,"selectedHandles":selection.handles,
            "network":{"vertices":local,"segments":self.edges.iter().enumerate().map(|(i,&(_,a,b))| {
                let (first,last)=self.controls(i);
                json!({"start":a,"end":b,"startHandle":first,"endHandle":last})
            }).collect::<Vec<_>>()}})
    }
}

impl ToolRouter {
    pub(super) fn fig_vector_object_transform(
        &self,
        session: &str,
        snapshot: &DocumentSnapshot,
        state: &ViewState,
        selection: &[Value],
        name: &str,
    ) -> Result<Option<Value>> {
        let Ok(edit) = serde_json::from_value::<EditState>(state.view["vectorEdit"].clone()) else {
            return Ok(None);
        };
        if edit.page != state.page_id || edit.ids.is_empty() {
            return Ok(None);
        }
        let scene = paths::scene(snapshot, &state.page_id)?;
        let mut points = Vec::new();
        for id in &edit.ids {
            let Some(item) = scene.item(id).filter(|_| paths::editable(&scene, id)) else {
                continue;
            };
            let Some(node) = snapshot.nodes.get(id) else {
                continue;
            };
            let Some(selected) = edit.selected.get(id) else {
                continue;
            };
            let network = Network::new(node)?;
            points.extend(network.vertex_set(selected).iter().map(|&index| {
                let (x, y) = network.point(index);
                item.world.point(x, y)
            }));
        }
        let [x, y, w, h] = point_bounds(points.into_iter())?;
        let matrix = super::objects::object_affine(name, (x + w / 2., y + h / 2.)).0;
        self.fig_vector_edit(
            session,
            snapshot,
            state,
            selection,
            "vector.edit.transform",
            &json!({"matrix":matrix}),
        )
        .map(Some)
    }

    pub(super) fn fig_vector_edit(
        &self,
        session: &str,
        snapshot: &DocumentSnapshot,
        state: &ViewState,
        selection: &[Value],
        name: &str,
        params: &Value,
    ) -> Result<Value> {
        let mut edit: EditState =
            serde_json::from_value(state.view["vectorEdit"].clone()).unwrap_or_default();
        if edit.page != state.page_id {
            edit = EditState::default();
        }
        let document = &snapshot.id;
        let alias = |id: &str| self.fig_alias(session, document, id);
        let store = |edit: &EditState| -> Result<()> {
            let mut states = self.states.lock().unwrap();
            let view = &mut states
                .get_mut(&(session.into(), document.clone()))
                .ok_or_else(|| EngineError::invalid("desktop session closed"))?
                .view;
            if !view.is_object() {
                *view = json!({});
            }
            view["vectorEdit"] = json!(edit);
            Ok(())
        };
        if name == "vector.edit.end" {
            store(&EditState::default())?;
            return Ok(json!({"editing":false}));
        }
        let scene = paths::scene(snapshot, &state.page_id)?;
        if name == "vector.edit.begin" {
            let ids = geometry_targets(self, session, snapshot, selection, params)?;
            let mut commands = Vec::new();
            let mut paths = Vec::new();
            for item in geometry_items(&scene, &ids)? {
                if item.kind == NodeKind::Path && item.boolean_operation().is_none() {
                    Network::new(&snapshot.nodes[&item.id])?;
                    paths.push(item.id.clone());
                } else {
                    let conversion = vector::build(
                        snapshot,
                        &state.page_id,
                        "boolean",
                        std::slice::from_ref(&item.id),
                        &json!({"operation":"flatten"}),
                    )?;
                    let converted = conversion
                        .iter()
                        .find_map(|command| match command {
                            Command::NodeCreate { node } => Some(node.id.clone()),
                            _ => None,
                        })
                        .ok_or_else(|| EngineError::invalid("could not convert shape to vector"))?;
                    paths.push(converted);
                    commands.extend(conversion);
                }
            }
            if !commands.is_empty() {
                self.submit(
                    session,
                    document,
                    Command::Batch { commands },
                    &Value::Null,
                    Some(snapshot.sequence),
                )?;
            }
            edit = EditState {
                page: state.page_id.clone(),
                active: paths[0].clone(),
                ids: paths,
                tool: "move".into(),
                pen: None,
                selected: BTreeMap::new(),
            };
            store(&edit)?;
            let ids = edit
                .ids
                .iter()
                .map(|id| json!(alias(id)))
                .collect::<Vec<_>>();
            self.fig_selection(&(session.into(), document.clone()), &ids);
            return Ok(json!({"editing":true,"id":ids[0],"ids":ids}));
        }
        edit.ids
            .retain(|id| snapshot.nodes.contains_key(id) && paths::editable(&scene, id));
        if !edit.ids.contains(&edit.active) {
            edit.active = edit.ids.first().cloned().unwrap_or_default();
        }
        if edit.ids.is_empty() {
            return if name == "vector.edit.state" {
                Ok(json!({"editing":false}))
            } else {
                Err(EngineError::invalid("begin vector editing first"))
            };
        }
        let mut networks = edit
            .ids
            .iter()
            .map(|id| Ok((id.clone(), Network::new(&snapshot.nodes[id])?)))
            .collect::<Result<BTreeMap<_, _>>>()?;
        if name == "vector.edit.state" {
            let mut result = networks[&edit.active].overlay(
                scene.item(&edit.active).unwrap(),
                edit.selected
                    .get(&edit.active)
                    .unwrap_or(&EditSelection::default()),
            );
            result["id"] = json!(alias(&edit.active));
            result["ids"] = json!(edit.ids.iter().map(|id| alias(id)).collect::<Vec<_>>());
            result["tool"] = json!(edit.tool);
            result["editing"] = true.into();
            result["pen"] = json!(edit.pen);
            return Ok(result);
        }
        if name == "vector.edit.penEnd" {
            edit.pen = None;
            store(&edit)?;
            return Ok(json!({"pen":null}));
        }
        if name == "vector.edit.tool" {
            let tool = string(params, "tool")?;
            if !matches!(
                tool,
                "move" | "pen" | "bend" | "paint" | "lasso" | "cut" | "eraser" | "width"
            ) {
                return Err(EngineError::invalid("unknown vector tool"));
            }
            edit.tool = tool.into();
            store(&edit)?;
            return Ok(json!({"tool":tool}));
        }
        if name == "vector.edit.select" {
            if let Some(id) = params.get("id") {
                let id = self.fig_layer(session, snapshot, id)?;
                if !edit.ids.contains(&id) {
                    return Err(EngineError::invalid(
                        "layer is outside the vector edit session",
                    ));
                }
                if edit.active != id {
                    edit.pen = None;
                }
                edit.active = id;
            }
            let network = &networks[&edit.active];
            let mut selection = EditSelection {
                vertices: index_set(params, "vertices")?.unwrap_or_default(),
                segments: index_set(params, "segments")?.unwrap_or_default(),
                handles: handle_set(params)?.unwrap_or_default(),
            };
            if let Some(regions) = index_set(params, "regions")? {
                if regions.iter().any(|&index| index != 0) {
                    return Err(EngineError::invalid("this vector has only one fill region"));
                }
                if !regions.is_empty() {
                    if !network
                        .geometry
                        .iter()
                        .any(|s| matches!(s.edge, Edge::Close))
                    {
                        return Err(EngineError::invalid("an open vector has no filled region"));
                    }
                    selection.vertices.extend(0..network.vertices.len());
                }
            }
            network.validate(&selection)?;
            if optional_flag(params, "add")? != Some(true) {
                edit.selected.clear();
            }
            let current = edit.selected.entry(edit.active.clone()).or_default();
            current.vertices.extend(selection.vertices);
            current.segments.extend(selection.segments);
            current.handles.extend(selection.handles);
            store(&edit)?;
            return Ok(
                json!({"id":alias(&edit.active),"vertices":current_selection(&edit).vertices,
                "segments":current_selection(&edit).segments,"handles":current_selection(&edit).handles}),
            );
        }
        if matches!(name, "vector.edit.selectAll" | "vector.edit.lasso") {
            let polygon = if name == "vector.edit.lasso" {
                Some(
                    params["points"]
                        .as_array()
                        .filter(|p| (3..=2000).contains(&p.len()))
                        .ok_or_else(|| EngineError::invalid("lasso needs 3–2000 points"))?
                        .iter()
                        .map(point_pair)
                        .collect::<Result<Vec<_>>>()?,
                )
            } else {
                None
            };
            if optional_flag(params, "add")? != Some(true) {
                edit.selected.clear();
            }
            let mut count = 0;
            for id in &edit.ids {
                let network = &networks[id];
                let item = scene.item(id).unwrap();
                let target = edit.selected.entry(id.clone()).or_default();
                target
                    .vertices
                    .extend((0..network.vertices.len()).filter(|&vertex| {
                        let (x, y) = network.point(vertex);
                        polygon
                            .as_ref()
                            .is_none_or(|polygon| inside_polygon(item.world.point(x, y), polygon))
                    }));
                count += target.vertices.len();
            }
            store(&edit)?;
            return Ok(json!({"selected":count}));
        }
        if name == "vector.edit.bounds" {
            let network = &networks[&edit.active];
            let selected = network.vertex_set(&current_selection(&edit));
            let item = scene.item(&edit.active).unwrap();
            let [x, y, w, h] = point_bounds(selected.iter().map(|&index| network.point(index)))?;
            let (px, py) = item.local.point(x, y);
            let corners = [(x, y), (x + w, y), (x + w, y + h), (x, y + h)]
                .map(|(x, y)| item.world.point(x, y));
            return Ok(
                json!({"x":px,"y":py,"width":w,"height":h,"corners":corners,"points":selected.len()}),
            );
        }
        let explicit_vertices = index_set(params, "vertices")?;
        let explicit_segments = index_set(params, "segments")?;
        let explicit_handles = handle_set(params)?;
        let active_only = explicit_vertices.is_some()
            || explicit_segments.is_some()
            || explicit_handles.is_some()
            || matches!(
                name,
                "vector.edit.setHandle"
                    | "vector.edit.addVertex"
                    | "vector.edit.position"
                    | "vector.edit.resize"
                    | "vector.edit.bend"
                    | "vector.edit.connect"
                    | "vector.edit.pen"
                    | "vector.edit.paint"
                    | "vector.edit.widthPoint"
                    | "vector.edit.rotate"
            );
        let cut_line = if name == "vector.edit.cut"
            && (params.get("from").is_some() || params.get("to").is_some())
        {
            let from = point_pair(&params["from"])?;
            let to = point_pair(&params["to"])?;
            if from == to {
                return Err(EngineError::invalid("cut line needs distinct endpoints"));
            }
            Some((from, to))
        } else {
            None
        };
        let erase = if name == "vector.edit.erase" {
            let brush = params["points"]
                .as_array()
                .filter(|points| (1..=256).contains(&points.len()))
                .ok_or_else(|| EngineError::invalid("erase requires 1–256 brush points"))?
                .iter()
                .map(point_pair)
                .collect::<Result<Vec<_>>>()?;
            let radius = optional_number(params, "radius")?.unwrap_or(8.);
            if !(0.01..=10_000.).contains(&radius) {
                return Err(EngineError::invalid("erase radius must be 0.01–10000"));
            }
            Some((brush, radius))
        } else {
            None
        };
        let mut commands = Vec::new();
        for id in &edit.ids {
            if (active_only || name == "vector.edit.cut" && cut_line.is_none())
                && id != &edit.active
            {
                continue;
            }
            let network = networks.get_mut(id).unwrap();
            let item = scene.item(id).unwrap();
            let mut selection = edit.selected.get(id).cloned().unwrap_or_default();
            if let Some(explicit) = &explicit_vertices {
                selection.vertices = explicit.clone();
                selection.segments.clear();
            }
            if let Some(explicit) = &explicit_segments {
                selection.segments = explicit.clone();
            }
            if let Some(explicit) = &explicit_handles {
                selection.handles = explicit.clone();
            }
            network.validate(&selection)?;
            let vertices = network.vertex_set(&selection);
            match name {
                "vector.edit.moveVertices"
                | "vector.edit.nudge"
                | "vector.edit.position"
                | "vector.edit.resize"
                | "vector.edit.rotate"
                | "vector.edit.transform" => {
                    if vertices.is_empty() {
                        continue;
                    }
                    let transform = point_transform(name, params, item, network, &vertices)?;
                    network.edit_points(&vertices, transform);
                }
                "vector.edit.setHandle" => {
                    let edge = geometry_index(params, "segment")?;
                    if edge >= network.edges.len() {
                        return Err(EngineError::invalid("unknown vector segment"));
                    }
                    let start = optional_flag(params, "start")?
                        .ok_or_else(|| EngineError::invalid("start is required"))?;
                    network.set_handle(
                        edge,
                        start,
                        (geometry_number(params, "x")?, geometry_number(params, "y")?),
                        optional_flag(params, "independent")?.unwrap_or(false),
                    )?;
                }
                "vector.edit.moveHandles" => {
                    if selection.handles.is_empty() {
                        continue;
                    }
                    let transform = local_delta(
                        item,
                        geometry_number(params, "dx")?,
                        geometry_number(params, "dy")?,
                    )?;
                    let handles = selection
                        .handles
                        .iter()
                        .map(|&(edge, start)| {
                            let (first, last) = network.controls(edge);
                            let (x, y) = if start { first } else { last };
                            (edge, start, transform.point(x, y))
                        })
                        .collect::<Vec<_>>();
                    for (edge, start, point) in handles {
                        network.set_handle(
                            edge,
                            start,
                            point,
                            optional_flag(params, "independent")?.unwrap_or(false),
                        )?;
                    }
                }
                "vector.edit.mirroring" => {
                    if vertices.is_empty() {
                        continue;
                    }
                    let mode = match string(params, "mode")? {
                        "none" => "free",
                        "angle" => "aligned",
                        "angleAndLength" => "symmetric",
                        _ => return Err(EngineError::invalid("unknown mirroring mode")),
                    };
                    for vertex in vertices {
                        network.geometry[network.vertices[vertex]].mode = Some(mode.into());
                    }
                }
                "vector.edit.smooth" => {
                    if vertices.is_empty() {
                        continue;
                    }
                    let smooth = optional_flag(params, "smooth")?.unwrap_or(true);
                    for vertex in vertices {
                        let index = network.vertices[vertex];
                        network.geometry[index].mode =
                            Some(if smooth { "smooth" } else { "corner" }.into());
                        let current = network.point(vertex);
                        let previous = network
                            .edges
                            .iter()
                            .find_map(|&(_, a, b)| (b == vertex).then_some(network.point(a)))
                            .unwrap_or(current);
                        let next = network
                            .edges
                            .iter()
                            .find_map(|&(_, a, b)| (a == vertex).then_some(network.point(b)))
                            .unwrap_or(current);
                        let (dx, dy) = if smooth {
                            ((next.0 - previous.0) / 6., (next.1 - previous.1) / 6.)
                        } else {
                            (0., 0.)
                        };
                        let around = network
                            .edges
                            .iter()
                            .enumerate()
                            .filter_map(|(i, &(index, a, b))| {
                                if matches!(network.geometry[index].edge, Edge::Close) {
                                    None
                                } else if a == vertex {
                                    Some((i, true, (current.0 + dx, current.1 + dy)))
                                } else if b == vertex {
                                    Some((i, false, (current.0 - dx, current.1 - dy)))
                                } else {
                                    None
                                }
                            })
                            .collect::<Vec<_>>();
                        for (edge, start, point) in around {
                            network.set_handle(edge, start, point, true)?;
                        }
                    }
                }
                "vector.edit.bend" => {
                    let t = geometry_number(params, "t")?;
                    if !(0. < t && t < 1.) {
                        return Err(EngineError::invalid("t must lie inside the segment"));
                    }
                    let inverse = item.world.inverse().ok_or_else(|| {
                        EngineError::invalid("vector transform is not invertible")
                    })?;
                    network.bend(
                        geometry_index(params, "segment")?,
                        t,
                        inverse.point(geometry_number(params, "x")?, geometry_number(params, "y")?),
                    )?;
                }
                "vector.edit.connect" => {
                    network.connect(geometry_index(params, "a")?, geometry_index(params, "b")?)?;
                    edit.selected.remove(id);
                }
                "vector.edit.pen" => {
                    let inverse = item.world.inverse().ok_or_else(|| {
                        EngineError::invalid("vector transform is not invertible")
                    })?;
                    let (x, y) = (geometry_number(params, "x")?, geometry_number(params, "y")?);
                    let point = inverse.point(x, y);
                    let handle = inverse.point(
                        x + optional_number(params, "dx")?.unwrap_or(0.),
                        y + optional_number(params, "dy")?.unwrap_or(0.),
                    );
                    let scale = item.world.0[0].hypot(item.world.0[1]);
                    edit.pen = network.pen(
                        edit.pen,
                        point,
                        (handle.0 - point.0, handle.1 - point.1),
                        scale,
                    )?;
                    edit.selected.remove(id);
                }
                "vector.edit.cut" => {
                    if let Some((from, to)) = cut_line {
                        let inverse = item.world.inverse().ok_or_else(|| {
                            EngineError::invalid("vector transform is not invertible")
                        })?;
                        if !network
                            .cut_line(inverse.point(from.0, from.1), inverse.point(to.0, to.1))?
                        {
                            continue;
                        }
                    } else if params.get("vertex").is_some() {
                        let vertex = geometry_index(params, "vertex")?;
                        let index = *network
                            .vertices
                            .get(vertex)
                            .ok_or_else(|| EngineError::invalid("unknown vector point"))?;
                        network.cut_at(index)?;
                    } else {
                        let t = optional_number(params, "t")?.unwrap_or(0.5);
                        if !(0. < t && t < 1.) {
                            return Err(EngineError::invalid("t must lie inside the segment"));
                        }
                        network.cut_segment(geometry_index(params, "segment")?, t)?;
                    }
                    edit.selected.remove(id);
                    edit.pen = None;
                }
                "vector.edit.paint" => {
                    let points = if let Some(points) = params.get("points") {
                        points
                            .as_array()
                            .filter(|points| (1..=10_000).contains(&points.len()))
                            .ok_or_else(|| EngineError::invalid("points must be an array"))?
                            .iter()
                            .map(point_pair)
                            .collect::<Result<Vec<_>>>()?
                    } else {
                        vec![(geometry_number(params, "x")?, geometry_number(params, "y")?)]
                    };
                    if !network
                        .geometry
                        .iter()
                        .any(|segment| matches!(segment.edge, Edge::Close))
                        || !points.iter().any(|&(x, y)| item.contains(x, y))
                    {
                        return Err(EngineError::invalid(
                            "no closed vector region at the supplied points",
                        ));
                    }
                    let mut patch = Properties::new();
                    if let Some(previous) = item
                        .properties
                        .get("vectorSavedFills")
                        .filter(|v| !v.is_null())
                    {
                        patch.insert("fills".into(), previous.clone());
                        patch.insert("vectorSavedFills".into(), Value::Null);
                    } else {
                        let fills = vector::solid_fills(item)?;
                        let has_fill = fills.iter().any(|fill| {
                            fill["visible"] != false
                                && fill["hidden"] != true
                                && fill["color"]
                                    .as_str()
                                    .and_then(omc_style::parse_color)
                                    .is_none_or(|color| color.a > 0.)
                        });
                        if has_fill {
                            patch.insert("vectorSavedFills".into(), json!(fills));
                            patch.insert("fills".into(), json!([]));
                        } else {
                            patch.insert(
                                "fills".into(),
                                json!([{"type":"solid","color":"#d9d9d9"}]),
                            );
                        }
                    }
                    commands.push(Command::NodeSet {
                        node_id: id.clone(),
                        properties: patch,
                    });
                    continue;
                }
                "vector.edit.erase" => {
                    let (brush, radius) = erase.as_ref().unwrap();
                    if !network.erase(item.world, brush, *radius)? {
                        continue;
                    }
                    edit.selected.remove(id);
                    edit.pen = None;
                    if network.geometry.is_empty() {
                        commands.push(Command::NodeDelete {
                            node_ids: vec![id.clone()],
                        });
                        continue;
                    }
                }
                "vector.edit.widthPoint" => {
                    let profile = width_point(item, params)?;
                    commands.push(Command::NodeSet {
                        node_id: id.clone(),
                        properties: Properties::from([("widthProfile".into(), profile)]),
                    });
                    continue;
                }
                "vector.edit.cornerRadius" => {
                    if vertices.is_empty() {
                        continue;
                    }
                    let radius = geometry_number(params, "radius")?;
                    if !(0. ..=100_000.).contains(&radius) {
                        return Err(EngineError::invalid("radius must be 0–100000"));
                    }
                    let mut radii = item
                        .properties
                        .get("vectorCornerRadii")
                        .and_then(Value::as_object)
                        .cloned()
                        .unwrap_or_default();
                    for vertex in vertices {
                        let corner = network
                            .edges
                            .iter()
                            .filter(|&&(_, a, b)| a == vertex || b == vertex)
                            .collect::<Vec<_>>();
                        if radius > 0.
                            && (corner.len() != 2
                                || corner.iter().any(|&&(edge, _, _)| {
                                    matches!(network.geometry[edge].edge, Edge::Cubic(..))
                                }))
                        {
                            return Err(EngineError::invalid(
                                "a rounded vector point needs two straight edges",
                            ));
                        }
                        if radius == 0. {
                            radii.remove(&vertex.to_string());
                        } else {
                            radii.insert(vertex.to_string(), json!(radius));
                        }
                    }
                    commands.push(Command::NodeSet {
                        node_id: id.clone(),
                        properties: Properties::from([(
                            "vectorCornerRadii".into(),
                            Value::Object(radii),
                        )]),
                    });
                    continue;
                }
                "vector.edit.strokeCap" | "vector.edit.strokeJoin" => {
                    if vertices.is_empty() {
                        continue;
                    }
                    let cap = name == "vector.edit.strokeCap";
                    let field = if cap { "cap" } else { "join" };
                    let property = if cap {
                        "vectorPointCaps"
                    } else {
                        "vectorPointJoins"
                    };
                    let value = params
                        .get(field)
                        .ok_or_else(|| EngineError::invalid(format!("{field} is required")))?;
                    let allowed = if cap {
                        matches!(
                            value.as_str(),
                            Some(
                                "none"
                                    | "round"
                                    | "square"
                                    | "lineArrow"
                                    | "triangleArrow"
                                    | "reversedTriangle"
                                    | "circleFilled"
                                    | "diamondFilled"
                            )
                        )
                    } else {
                        matches!(value.as_str(), Some("miter" | "bevel" | "round"))
                    };
                    if !value.is_null() && !allowed {
                        return Err(EngineError::invalid(format!("unknown stroke {field}")));
                    }
                    let mut overrides = item
                        .properties
                        .get(property)
                        .and_then(Value::as_object)
                        .cloned()
                        .unwrap_or_default();
                    for vertex in vertices {
                        let neighbors = network
                            .edges
                            .iter()
                            .filter(|&&(_, a, b)| a == vertex || b == vertex)
                            .collect::<Vec<_>>();
                        if value.is_null() {
                            overrides.remove(&vertex.to_string());
                        } else if cap && neighbors.len() == 1
                            || !cap
                                && neighbors.len() == 2
                                && neighbors.iter().all(|&&(edge, _, _)| {
                                    !matches!(network.geometry[edge].edge, Edge::Cubic(..))
                                })
                        {
                            overrides.insert(vertex.to_string(), value.clone());
                        } else {
                            return Err(EngineError::invalid(if cap {
                                "stroke caps require an open endpoint"
                            } else {
                                "a stroke join needs two straight edges"
                            }));
                        }
                    }
                    commands.push(Command::NodeSet {
                        node_id: id.clone(),
                        properties: Properties::from([(property.into(), Value::Object(overrides))]),
                    });
                    continue;
                }
                "vector.edit.addVertex" => {
                    let edge = geometry_index(params, "segment")?;
                    let &(index, a, b) = network
                        .edges
                        .get(edge)
                        .ok_or_else(|| EngineError::invalid("unknown vector segment"))?;
                    let t = geometry_number(params, "t")?;
                    if !(0. < t && t < 1.) {
                        return Err(EngineError::invalid("t must lie inside the segment"));
                    }
                    if matches!(network.geometry[index].edge, Edge::Close) {
                        let (a, b) = (network.point(a), network.point(b));
                        network.geometry.insert(
                            index,
                            Segment::new(
                                Edge::Line,
                                (a.0 + (b.0 - a.0) * t, a.1 + (b.1 - a.1) * t),
                            ),
                        );
                    } else {
                        commands.extend(paths::edit(
                            snapshot,
                            &state.page_id,
                            id,
                            None,
                            &json!({"action":"insert_node","index":index,"t":t}),
                        )?);
                        edit.selected.remove(id);
                        continue;
                    }
                    edit.selected.remove(id);
                }
                "vector.deleteHeal" => {
                    if vertices.is_empty() {
                        continue;
                    }
                    let indices = vertices
                        .into_iter()
                        .map(|i| network.vertices[i])
                        .collect::<Vec<_>>();
                    commands.extend(paths::edit(
                        snapshot,
                        &state.page_id,
                        id,
                        None,
                        &json!({"action":"delete_nodes","indices":indices}),
                    )?);
                    edit.selected.remove(id);
                    continue;
                }
                "vector.edit.delete" => {
                    if selection.vertices.is_empty() && selection.segments.is_empty() {
                        continue;
                    }
                    delete_elements(network, &selection);
                    if network.geometry.is_empty() {
                        commands.push(Command::NodeDelete {
                            node_ids: vec![id.clone()],
                        });
                        edit.selected.remove(id);
                        continue;
                    }
                    edit.selected.remove(id);
                }
                _ => return Err(EngineError::invalid("unknown vector edit command")),
            }
            commands.push(paths::path_command(id, &network.geometry)?);
        }
        if commands.is_empty() {
            return Err(EngineError::invalid(
                "select vector points or handles first",
            ));
        }
        self.submit(
            session,
            document,
            Command::Batch { commands },
            &Value::Null,
            Some(snapshot.sequence),
        )?;
        store(&edit)?;
        Ok(
            json!({"id":alias(&edit.active),"ids":edit.ids.iter().map(|id| alias(id)).collect::<Vec<_>>(),"pen":edit.pen}),
        )
    }
}

fn current_selection(edit: &EditState) -> EditSelection {
    edit.selected.get(&edit.active).cloned().unwrap_or_default()
}

fn index_set(params: &Value, name: &str) -> Result<Option<BTreeSet<usize>>> {
    params
        .get(name)
        .map(|items| {
            items
                .as_array()
                .filter(|items| items.len() <= 10_000)
                .ok_or_else(|| EngineError::invalid(format!("{name} must be an array of indices")))?
                .iter()
                .map(|v| {
                    v.as_u64()
                        .and_then(|v| usize::try_from(v).ok())
                        .ok_or_else(|| EngineError::invalid("invalid vector index"))
                })
                .collect()
        })
        .transpose()
}

fn handle_set(params: &Value) -> Result<Option<BTreeSet<(usize, bool)>>> {
    params
        .get("handles")
        .map(|items| {
            items
                .as_array()
                .filter(|items| items.len() <= 10_000)
                .ok_or_else(|| EngineError::invalid("handles must be an array"))?
                .iter()
                .map(|v| {
                    match (
                        v.as_array().map(Vec::len),
                        v[0].as_u64().and_then(|v| usize::try_from(v).ok()),
                        v[1].as_bool(),
                    ) {
                        (Some(2), Some(index), Some(start)) => Ok((index, start)),
                        _ => Err(EngineError::invalid("expected handle [segment,start]")),
                    }
                })
                .collect()
        })
        .transpose()
}

fn point_bounds(points: impl Iterator<Item = Point>) -> Result<[f64; 4]> {
    points
        .map(|(x, y)| [x, y, x, y])
        .reduce(|[x, y, r, b], [a, c, d, e]| [x.min(a), y.min(c), r.max(d), b.max(e)])
        .map(|[x, y, r, b]| [x, y, r - x, b - y])
        .ok_or_else(|| EngineError::invalid("select vector points first"))
}

fn local_delta(item: &SceneItem, x: f64, y: f64) -> Result<Affine> {
    let inverse = item
        .world
        .inverse()
        .ok_or_else(|| EngineError::invalid("vector transform is not invertible"))?;
    Ok(inverse
        .multiply(Affine::translation(x, y))
        .multiply(item.world))
}

fn point_transform(
    name: &str,
    params: &Value,
    item: &SceneItem,
    network: &Network,
    selected: &BTreeSet<usize>,
) -> Result<Affine> {
    let points = || selected.iter().map(|&index| network.point(index));
    let result = match name {
        "vector.edit.moveVertices" => Affine::translation(
            geometry_number(params, "dx")?,
            geometry_number(params, "dy")?,
        ),
        "vector.edit.nudge" => local_delta(
            item,
            geometry_number(params, "dx")?,
            geometry_number(params, "dy")?,
        )?,
        "vector.edit.position" => {
            let [x, y, _, _] = point_bounds(points().map(|(x, y)| item.local.point(x, y)))?;
            let (px, py) = (optional_number(params, "x")?, optional_number(params, "y")?);
            if px.is_none() && py.is_none() {
                return Err(EngineError::invalid("provide x or y"));
            }
            item.local
                .inverse()
                .ok_or_else(|| EngineError::invalid("vector transform is not invertible"))?
                .multiply(Affine::translation(
                    px.unwrap_or(x) - x,
                    py.unwrap_or(y) - y,
                ))
                .multiply(item.local)
        }
        "vector.edit.resize" => {
            let [x, y, w, h] = point_bounds(points())?;
            let (width, height) = (
                optional_number(params, "width")?,
                optional_number(params, "height")?,
            );
            if width.is_none() && height.is_none() {
                return Err(EngineError::invalid("provide width or height"));
            }
            let sx = resize_ratio(width, w)?.unwrap_or(1.);
            let sy = resize_ratio(height, h)?.unwrap_or(1.);
            let pivot = if optional_flag(params, "center")? == Some(true) {
                (x + w / 2., y + h / 2.)
            } else {
                (x, y)
            };
            around(pivot, Affine([sx, 0., 0., sy, 0., 0.]))
        }
        "vector.edit.rotate" | "vector.edit.transform" => {
            let global = if name == "vector.edit.rotate" {
                let [x, y, w, h] = point_bounds(points().map(|(x, y)| item.world.point(x, y)))?;
                let pivot = (
                    optional_number(params, "cx")?.unwrap_or(x + w / 2.),
                    optional_number(params, "cy")?.unwrap_or(y + h / 2.),
                );
                let (sin, cos) = (-geometry_number(params, "angle")?.to_radians()).sin_cos();
                around(pivot, Affine([cos, sin, -sin, cos, 0., 0.]))
            } else {
                let values = params["matrix"]
                    .as_array()
                    .filter(|values| values.len() == 6)
                    .ok_or_else(|| EngineError::invalid("matrix requires six finite numbers"))?;
                let mut matrix = [0.; 6];
                for (out, value) in matrix.iter_mut().zip(values) {
                    *out = value.as_f64().filter(|v| v.is_finite()).ok_or_else(|| {
                        EngineError::invalid("matrix requires six finite numbers")
                    })?;
                }
                Affine(matrix)
            };
            item.world
                .inverse()
                .ok_or_else(|| EngineError::invalid("vector transform is not invertible"))?
                .multiply(global)
                .multiply(item.world)
        }
        _ => return Err(EngineError::invalid("unknown point transform")),
    };
    if result
        .0
        .iter()
        .any(|value| !value.is_finite() || value.abs() > 1e9)
    {
        return Err(EngineError::invalid(
            "point transform exceeds supported coordinates",
        ));
    }
    Ok(result)
}

fn delete_elements(network: &mut Network, selection: &EditSelection) {
    let mut output = Vec::new();
    let mut ends_at = None;
    let mut starts_at = None;
    for &(index, a, b) in &network.edges {
        let edge_index = network
            .edges
            .binary_search_by_key(&index, |(index, _, _)| *index)
            .unwrap();
        if selection.vertices.contains(&a)
            || selection.vertices.contains(&b)
            || selection.segments.contains(&edge_index)
        {
            ends_at = None;
            continue;
        }
        if ends_at != Some(a) {
            output.push(Segment::new(Edge::Move, network.point(a)));
            starts_at = Some(a);
        }
        let mut segment = network.geometry[index].clone();
        if matches!(segment.edge, Edge::Close) && starts_at != Some(b) {
            segment = Segment::new(Edge::Line, network.point(b));
        }
        output.push(segment);
        ends_at = Some(b);
    }
    network.geometry = output;
}

fn inside_polygon((x, y): Point, polygon: &[Point]) -> bool {
    let mut inside = false;
    for (&(a, b), &(c, d)) in polygon.iter().zip(polygon.iter().cycle().skip(1)) {
        if (b > y) != (d > y) && x < (c - a) * (y - b) / (d - b) + a {
            inside = !inside;
        }
    }
    inside
}

fn mix((x, y): Point, (a, b): Point, t: f64) -> Point {
    (x + (a - x) * t, y + (b - y) * t)
}

fn split_curve([a, b, c, d]: [Point; 4], t: f64) -> [[Point; 4]; 2] {
    let ab = mix(a, b, t);
    let bc = mix(b, c, t);
    let cd = mix(c, d, t);
    let abc = mix(ab, bc, t);
    let bcd = mix(bc, cd, t);
    let point = mix(abc, bcd, t);
    [[a, ab, abc, point], [point, bcd, cd, d]]
}

// Find intersections in the curve's parameter order, using the line's signed cross product.
fn curve_intersections(curve: [Point; 4], from: Point, to: Point) -> Vec<f64> {
    let direction = (to.0 - from.0, to.1 - from.1);
    let side = |(x, y): Point| (x - from.0) * direction.1 - (y - from.1) * direction.0;
    let at = |t| {
        let [a, b, c, d] = curve;
        mix(
            mix(mix(a, b, t), mix(b, c, t), t),
            mix(mix(b, c, t), mix(c, d, t), t),
            t,
        )
    };
    let mut cuts = Vec::new();
    let mut previous = side(curve[0]);
    for step in 1..=96 {
        let t = step as f64 / 96.;
        let signed = side(at(t));
        if previous.is_sign_negative() != signed.is_sign_negative() {
            let mut left = (step - 1) as f64 / 96.;
            let mut right = t;
            for _ in 0..40 {
                let mid = (left + right) / 2.;
                if side(at(mid)).is_sign_negative() == previous.is_sign_negative() {
                    left = mid;
                } else {
                    right = mid;
                }
            }
            let cut = (left + right) / 2.;
            let (x, y) = at(cut);
            let projection = ((x - from.0) * direction.0 + (y - from.1) * direction.1)
                / (direction.0 * direction.0 + direction.1 * direction.1);
            if cut > 1e-8 && cut < 1. - 1e-8 && (0. ..=1.).contains(&projection) {
                cuts.push(cut);
            }
        }
        previous = signed;
    }
    cuts
}

fn point_distance2((x, y): Point, (a, b): Point) -> f64 {
    (x - a) * (x - a) + (y - b) * (y - b)
}

fn distance_to_segment2(point: Point, a: Point, b: Point) -> f64 {
    let (dx, dy) = (b.0 - a.0, b.1 - a.1);
    let length = dx * dx + dy * dy;
    if length == 0. {
        return point_distance2(point, a);
    }
    let t = ((point.0 - a.0) * dx + (point.1 - a.1) * dy) / length;
    point_distance2(point, mix(a, b, t.clamp(0., 1.)))
}

fn width_point(item: &SceneItem, params: &Value) -> Result<Value> {
    let width = item
        .properties
        .get("strokes")
        .and_then(Value::as_array)
        .and_then(|strokes| {
            strokes
                .iter()
                .find(|stroke| stroke["visible"] != false && stroke["hidden"] != true)
        })
        .map(|stroke| {
            stroke["width"]
                .as_f64()
                .or_else(|| stroke["thickness"].as_f64())
                .unwrap_or(1.)
        })
        .or_else(|| {
            item.style
                .color("border-color")
                .filter(|color| color.a > 0.)
                .map(|_| item.style.number("border-width", 1.))
        })
        .filter(|width| *width > 0.)
        .ok_or_else(|| EngineError::invalid("width points require a visible stroke"))?;
    let mut profile = item
        .properties
        .get("widthProfile")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|entry| {
            let (at, left) = (entry.get(0)?.as_f64()?, entry.get(1)?.as_f64()?);
            Some([
                at,
                left,
                entry.get(2).and_then(Value::as_f64).unwrap_or(left),
            ])
        })
        .collect::<Vec<_>>();
    let action = params
        .get("action")
        .map(|_| string(params, "action"))
        .transpose()?
        .unwrap_or("add");
    if action == "remove" {
        let index = geometry_index(params, "index")?;
        if index >= profile.len() {
            return Err(EngineError::invalid("unknown width point"));
        }
        profile.remove(index);
    } else {
        if !matches!(action, "add" | "set") {
            return Err(EngineError::invalid("unknown width point action"));
        }
        let index = if action == "set" {
            Some(geometry_index(params, "index")?)
        } else {
            None
        };
        let old = index
            .map(|index| {
                profile
                    .get(index)
                    .copied()
                    .ok_or_else(|| EngineError::invalid("unknown width point"))
            })
            .transpose()?;
        let t = optional_number(params, "t")?
            .or(old.map(|old| old[0]))
            .filter(|t| (0. ..=1.).contains(t))
            .ok_or_else(|| EngineError::invalid("t must be 0–1"))?;
        let side = params
            .get("side")
            .map(|_| string(params, "side"))
            .transpose()?;
        if side.is_some_and(|side| !matches!(side, "left" | "right")) {
            return Err(EngineError::invalid("side must be left or right"));
        }
        let scale = optional_number(params, "scale")?;
        let px = optional_number(params, "width")?;
        if scale.is_some() && px.is_some() {
            return Err(EngineError::invalid("provide width or scale"));
        }
        let value = scale.or(px.map(|px| px / width * if side.is_some() { 2. } else { 1. }));
        if value.is_some_and(|value| !(0. ..=1000.).contains(&value)) {
            return Err(EngineError::invalid("width scale must be 0–1000"));
        }
        let mut point = old.unwrap_or([t, 1., 1.]);
        if old.is_none() && !profile.is_empty() {
            let next = profile.partition_point(|point| point[0] < t);
            let left = profile[next.saturating_sub(1)];
            let right = profile[next.min(profile.len() - 1)];
            let ratio = if left[0] == right[0] {
                0.
            } else {
                (t - left[0]) / (right[0] - left[0])
            };
            point = [
                t,
                left[1] + (right[1] - left[1]) * ratio,
                left[2] + (right[2] - left[2]) * ratio,
            ];
        }
        point[0] = t;
        if let Some(value) = value {
            if side != Some("right") {
                point[1] = value;
            }
            if side != Some("left") {
                point[2] = value;
            }
        }
        if profile
            .iter()
            .enumerate()
            .any(|(i, point)| Some(i) != index && (point[0] - t).abs() < 1e-6)
        {
            return Err(EngineError::invalid(
                "a width point already exists at this position",
            ));
        }
        if let Some(index) = index {
            profile[index] = point;
        } else {
            if profile.len() >= 64 {
                return Err(EngineError::new(
                    "resource_limit",
                    "at most 64 width points",
                ));
            }
            profile.push(point);
        }
        profile.sort_by(|a, b| a[0].total_cmp(&b[0]));
    }
    Ok(json!(profile))
}
