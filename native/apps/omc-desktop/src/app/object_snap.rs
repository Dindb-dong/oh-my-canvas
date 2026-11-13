use omc_scene::{Affine, Scene, SceneItem};
use std::collections::BTreeSet;

type Point = (f64, f64);
pub(super) type Guide = [Point; 2];
const SNAP_DISTANCE: f64 = 5.;

#[derive(Clone, Copy, Debug)]
struct Line {
    at: f64,
    start: f64,
    end: f64,
}

#[derive(Clone, Debug)]
pub struct GestureSnap {
    axes: [Vec<Line>; 2],
    moving: [f64; 4],
    to_page: Affine,
    from_page: Affine,
    pub(super) guides: [Option<Guide>; 2],
}

impl GestureSnap {
    pub fn new<'a>(
        scene: &Scene,
        ids: impl IntoIterator<Item = &'a str>,
        visible: [f64; 4],
    ) -> Option<Self> {
        let ids: BTreeSet<&str> = ids.into_iter().collect();
        let mut moving = scene
            .items
            .iter()
            .filter(|item| ids.contains(item.id.as_str()));
        let first = moving.next()?;
        let parent = first.parent.unwrap_or(scene.root);
        let owner = &scene.items[parent];
        let to_page = if parent == scene.root {
            Affine::IDENTITY
        } else {
            owner.world
        };
        let from_page = to_page.inverse()?;
        let bounds = |item: &SceneItem| {
            from_page
                .multiply(item.world)
                .bounds(item.width, item.height)
        };
        let moving = moving.map(bounds).fold(bounds(first), union);
        let mut snap = Self {
            axes: [Vec::new(), Vec::new()],
            moving,
            to_page,
            from_page,
            guides: [None; 2],
        };
        for index in &owner.children {
            let item = &scene.items[*index];
            if !item.hidden && !ids.contains(item.id.as_str()) && intersects(item.bounds, visible) {
                snap.add_box(bounds(item));
            }
        }
        if parent != scene.root {
            snap.add_box(bounds(owner));
        }
        for lines in &mut snap.axes {
            lines.sort_by(|a, b| a.at.total_cmp(&b.at));
            lines.dedup_by(|later, earlier| {
                if later.at != earlier.at {
                    return false;
                }
                earlier.start = earlier.start.min(later.start);
                earlier.end = earlier.end.max(later.end);
                true
            });
        }
        Some(snap)
    }

    fn add_box(&mut self, [x, y, width, height]: [f64; 4]) {
        if ![x, y, width, height].into_iter().all(f64::is_finite) {
            return;
        }
        for at in [x, x + width * 0.5, x + width] {
            self.axes[0].push(Line {
                at,
                start: y,
                end: y + height,
            });
        }
        for at in [y, y + height * 0.5, y + height] {
            self.axes[1].push(Line {
                at,
                start: x,
                end: x + width,
            });
        }
    }

    pub fn move_by(&mut self, delta: Point, zoom: f64) -> Point {
        let [x, y, w, h] = self.moving;
        let (dx, dy) = vector(self.from_page, delta);
        let (cx, cy) = self.correct(x + dx, y + dy, w, h, true, zoom);
        vector(self.to_page, (dx + cx, dy + cy))
    }

    pub fn point(&mut self, at: Point, zoom: f64) -> Point {
        let (x, y) = self.from_page.point(at.0, at.1);
        let (dx, dy) = self.correct(x, y, 0., 0., false, zoom);
        self.to_page.point(x + dx, y + dy)
    }

    fn correct(&mut self, x: f64, y: f64, w: f64, h: f64, edges: bool, zoom: f64) -> Point {
        let [a, b, c, d, _, _] = self.to_page.0;
        let thresholds = [
            SNAP_DISTANCE / (zoom * a.hypot(b)),
            SNAP_DISTANCE / (zoom * c.hypot(d)),
        ];
        let samples = [[x, x + w * 0.5, x + w], [y, y + h * 0.5, y + h]];
        let nearest = |axis: usize| {
            let coordinates = if edges {
                &samples[axis][..]
            } else {
                &samples[axis][..1]
            };
            let lines = &self.axes[axis];
            coordinates
                .iter()
                .filter_map(|coordinate| {
                    let index = lines.partition_point(|line| line.at < *coordinate);
                    [index.checked_sub(1), Some(index)]
                        .into_iter()
                        .flatten()
                        .filter_map(|index| lines.get(index))
                        .map(|line| (line.at - coordinate, *line))
                        .min_by(|a, b| a.0.abs().total_cmp(&b.0.abs()))
                })
                .filter(|(delta, _)| delta.abs() <= thresholds[axis])
                .min_by(|a, b| a.0.abs().total_cmp(&b.0.abs()))
        };
        let vertical = nearest(0);
        let horizontal = nearest(1);
        let dx = vertical.map_or(0., |(delta, _)| delta);
        let dy = horizontal.map_or(0., |(delta, _)| delta);
        self.guides = [
            vertical.map(|(_, line)| {
                [
                    self.to_page.point(line.at, line.start.min(y + dy)),
                    self.to_page.point(line.at, line.end.max(y + dy + h)),
                ]
            }),
            horizontal.map(|(_, line)| {
                [
                    self.to_page.point(line.start.min(x + dx), line.at),
                    self.to_page.point(line.end.max(x + dx + w), line.at),
                ]
            }),
        ];
        (dx, dy)
    }
}

fn vector(matrix: Affine, (x, y): Point) -> Point {
    let [a, b, c, d, _, _] = matrix.0;
    (a * x + c * y, b * x + d * y)
}

fn union([x, y, w, h]: [f64; 4], [a, b, aw, bh]: [f64; 4]) -> [f64; 4] {
    let (left, top) = (x.min(a), y.min(b));
    [
        left,
        top,
        (x + w).max(a + aw) - left,
        (y + h).max(b + bh) - top,
    ]
}

fn intersects([x, y, w, h]: [f64; 4], [a, b, aw, bh]: [f64; 4]) -> bool {
    x <= a + aw && a <= x + w && y <= b + bh && b <= y + h
}
