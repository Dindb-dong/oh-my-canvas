use super::*;
use omc_scene::Affine;

const ANCHORS: [&str; 9] = ["tl", "t", "tr", "l", "c", "r", "bl", "b", "br"];
type Point = (f64, f64);

pub(super) fn parse_anchor(value: &str) -> Option<usize> {
    ANCHORS
        .iter()
        .position(|anchor| anchor.eq_ignore_ascii_case(value.trim()))
}
pub(super) fn anchor_name(anchor: usize) -> &'static str {
    ANCHORS[anchor]
}

#[derive(Clone)]
pub struct ScaleDrag {
    bounds: [f64; 4],
    handle: (usize, usize),
    pub factor: f64,
    pub pivot: Point,
    offset: Point,
}

fn at(bounds: [f64; 4], x: usize, y: usize) -> Point {
    (
        bounds[0] + bounds[2] * x as f64 / 2.,
        bounds[1] + bounds[3] * y as f64 / 2.,
    )
}

impl ScaleDrag {
    pub fn update(&mut self, pointer: Point, anchor: usize, centered: bool) {
        let (x, y) = self.handle;
        let (ax, ay) = (anchor % 3, anchor / 3);
        let pivot = if centered {
            (1, 1)
        } else if x != 1 && x == ax || y != 1 && y == ay {
            (2 - x, 2 - y)
        } else {
            (ax, ay)
        };
        self.pivot = at(self.bounds, pivot.0, pivot.1);
        let handle = at(self.bounds, x, y);
        let target = (pointer.0 + self.offset.0, pointer.1 + self.offset.1);
        let ratio = |from: f64, end: f64, axis: f64, side| {
            (side != 1 && (axis - from).abs() > 1e-8).then(|| (end - from) / (axis - from))
        };
        let factor = [
            ratio(self.pivot.0, target.0, handle.0, x),
            ratio(self.pivot.1, target.1, handle.1, y),
        ]
        .into_iter()
        .flatten()
        .filter(|factor| factor.is_finite())
        .max_by(|a, b| (a - 1.).abs().total_cmp(&(b - 1.).abs()))
        .unwrap_or(1.);
        self.factor = if factor < 0. {
            factor.clamp(-1000., -0.01)
        } else {
            factor.clamp(0.01, 1000.)
        };
    }

    fn transform(&self) -> Affine {
        let k = self.factor;
        Affine([
            k,
            0.,
            0.,
            k,
            self.pivot.0 * (1. - k),
            self.pivot.1 * (1. - k),
        ])
    }

    pub fn preview(&self) -> [f64; 4] {
        let [x, y, w, h] = self.bounds;
        self.transform()
            .multiply(Affine::translation(x, y))
            .bounds(w, h)
    }
}

impl App {
    fn scale_roots<'a>(
        &'a self,
        scene: &'a Scene,
    ) -> impl Iterator<Item = &'a omc_scene::SceneItem> {
        self.selected.iter().filter_map(|id| {
            let item = scene.item(id)?;
            let mut parent = item.parent?;
            if item.hidden || item.locked {
                return None;
            }
            loop {
                let owner = &scene.items[parent];
                if owner.locked || owner.hidden || self.selected.contains(&owner.id) {
                    return None;
                }
                let Some(next) = owner.parent else { break };
                parent = next;
            }
            Some(item)
        })
    }

    pub(crate) fn scale_selection_bounds(&self) -> Option<[f64; 4]> {
        self.scale_roots(self.scene.as_ref()?)
            .map(|item| item.bounds)
            .reduce(|a, b| {
                let (x, y) = (a[0].min(b[0]), a[1].min(b[1]));
                [
                    x,
                    y,
                    (a[0] + a[2]).max(b[0] + b[2]) - x,
                    (a[1] + a[3]).max(b[1] + b[3]) - y,
                ]
            })
    }

    pub(super) fn begin_scale(&mut self, pointer: Point) -> bool {
        let Some(bounds) = self.scale_selection_bounds() else {
            return false;
        };
        let handles = (0..9).filter(|&index| index != 4).map(|index| {
            let handle = (index % 3, index / 3);
            let (x, y) = at(bounds, handle.0, handle.1);
            let offset = (x - pointer.0, y - pointer.1);
            (handle, offset, offset.0.hypot(offset.1))
        });
        let Some((handle, offset, distance)) = handles.min_by(|a, b| a.2.total_cmp(&b.2)) else {
            return false;
        };
        if distance > 7. / self.camera.zoom {
            return false;
        }
        let mut drag = ScaleDrag {
            bounds,
            handle,
            factor: 1.,
            pivot: pointer,
            offset,
        };
        drag.update(pointer, self.scale_anchor, self.modifiers.alt_key());
        self.drag = Some(Drag::Scale(drag));
        true
    }

    pub(super) fn finish_scale(&mut self, drag: ScaleDrag) {
        if (drag.factor - 1.).abs() < 1e-8 {
            return;
        }
        let Some(scene) = &self.scene else { return };
        let world_scale = drag.transform();
        let commands = self
            .scale_roots(scene)
            .filter_map(|item| {
                let parent = &scene.items[item.parent?];
                let local = parent
                    .world
                    .inverse()?
                    .multiply(world_scale)
                    .multiply(item.world);
                if !local
                    .0
                    .iter()
                    .all(|value| value.is_finite() && value.abs() <= 1e9)
                {
                    return None;
                }
                Some(json!({"type":"node.set","nodeId":item.id,
                "properties":omc_scene::absolute_placement(item, local)}))
            })
            .collect::<Vec<_>>();
        if !commands.is_empty() {
            self.mutate(json!({"type":"batch","commands":commands}), "scale");
        }
    }
}
