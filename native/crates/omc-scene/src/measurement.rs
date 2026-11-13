use crate::{Scene, SceneItem};
use serde::Serialize;

#[derive(Serialize)]
pub struct Line {
    pub x0: f64,
    pub y0: f64,
    pub x1: f64,
    pub y1: f64,
    pub label: Option<String>,
    pub dashed: bool,
}

pub const PROPERTY: &str = "figDevMeasurements";

pub fn edges([x, y, w, h]: [f64; 4]) -> [f64; 4] {
    [x, y, x + w, y + h]
}
pub fn union(a: [f64; 4], b: [f64; 4]) -> [f64; 4] {
    [
        a[0].min(b[0]),
        a[1].min(b[1]),
        a[2].max(b[2]),
        a[3].max(b[3]),
    ]
}
pub fn mid(a: f64, b: f64) -> f64 {
    (a + b) / 2.
}
pub fn overlap(a: f64, b: f64, c: f64, d: f64) -> Option<f64> {
    (a.max(c) <= b.min(d)).then(|| mid(a.max(c), b.min(d)))
}
pub fn line(out: &mut Vec<Line>, a: (f64, f64), b: (f64, f64), dashed: bool) {
    let distance = (b.0 - a.0).hypot(b.1 - a.1);
    if distance > 1e-6 && distance.is_finite() {
        out.push(Line {
            x0: a.0,
            y0: a.1,
            x1: b.0,
            y1: b.1,
            label: (!dashed).then(|| ((distance * 100.).round() / 100.).to_string()),
            dashed,
        });
    }
}
pub fn between(a: [f64; 4], b: [f64; 4]) -> Vec<Line> {
    let mut out = Vec::new();
    let contains = |a: [f64; 4], b: [f64; 4]| {
        a[0] <= b[0] + 1e-6 && a[1] <= b[1] + 1e-6 && a[2] >= b[2] - 1e-6 && a[3] >= b[3] - 1e-6
    };
    if contains(a, b) || contains(b, a) {
        let (inner, outer) = if contains(b, a) { (a, b) } else { (b, a) };
        let [l, t, r, d] = inner;
        let x = mid(l, r);
        let y = mid(t, d);
        for (a, b) in [
            ((outer[0], y), (l, y)),
            ((r, y), (outer[2], y)),
            ((x, outer[1]), (x, t)),
            ((x, d), (x, outer[3])),
        ] {
            line(&mut out, a, b, false);
        }
        return out;
    }
    let ox = overlap(a[0], a[2], b[0], b[2]);
    let oy = overlap(a[1], a[3], b[1], b[3]);
    if a[0] < b[2]
        && b[0] < a[2]
        && a[1] < b[3]
        && b[1] < a[3]
        && let (Some(x), Some(y)) = (ox, oy)
    {
        for (p, q) in [
            ((a[0], y), (b[0], y)),
            ((a[2], y), (b[2], y)),
            ((x, a[1]), (x, b[1])),
            ((x, a[3]), (x, b[3])),
        ] {
            line(&mut out, p, q, false);
        }
        return out;
    }
    for axis in [0, 1] {
        let orth = 1 - axis;
        let (lo, hi) = (axis, axis + 2);
        let gap = if b[lo] >= a[hi] {
            Some((a[hi], b[lo]))
        } else if b[hi] <= a[lo] {
            Some((a[lo], b[hi]))
        } else {
            None
        };
        if let Some((from, to)) = gap {
            let o = if axis == 0 { oy } else { ox };
            let orth_value = o.unwrap_or(mid(a[orth], a[orth + 2]));
            let pt = |along, across| {
                if axis == 0 {
                    (along, across)
                } else {
                    (across, along)
                }
            };
            line(&mut out, pt(from, orth_value), pt(to, orth_value), false);
            if o.is_none() {
                line(
                    &mut out,
                    pt(to, orth_value),
                    pt(to, orth_value.clamp(b[orth], b[orth + 2])),
                    true,
                );
            }
        }
    }
    out
}

pub fn anchored(
    scene: &Scene,
    from: &SceneItem,
    to: Option<&str>,
    side: Option<&str>,
) -> Vec<Line> {
    if let Some(side) = side {
        let (w, h) = (from.width, from.height);
        let (a, b) = match side {
            "top" => ((0., 0.), (w, 0.)),
            "right" => ((w, 0.), (w, h)),
            "bottom" => ((0., h), (w, h)),
            "left" => ((0., 0.), (0., h)),
            _ => return vec![],
        };
        let mut lines = Vec::new();
        line(
            &mut lines,
            from.world.point(a.0, a.1),
            from.world.point(b.0, b.1),
            false,
        );
        return lines;
    }
    let target = match to {
        Some(id) => scene.item(id),
        None => from
            .parent
            .filter(|index| *index != scene.root)
            .map(|index| &scene.items[index]),
    };
    target
        .map(|to| between(edges(from.bounds), edges(to.bounds)))
        .unwrap_or_default()
}
