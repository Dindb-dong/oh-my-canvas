use serde_json::Value;
use skia_safe::{Matrix, Path, PathMeasure, Point, Rect};

pub(super) fn outline(
    path: &Path,
    width: f32,
    profile: Option<&Value>,
    brush: Option<&Value>,
) -> Option<Path> {
    let points = profile
        .and_then(Value::as_array)
        .map_or_else(Vec::new, |points| {
            points
                .iter()
                .take(64)
                .filter_map(|point| {
                    let at = point.get(0)?.as_f64()? as f32;
                    let left = point.get(1)?.as_f64()? as f32;
                    let right = point
                        .get(2)
                        .and_then(Value::as_f64)
                        .map_or(left, |value| value as f32);
                    Some([at, left, right])
                })
                .collect()
        });
    let preset = brush.and_then(|brush| brush["preset"].as_str());
    if points.is_empty() && preset.is_none() {
        return None;
    }
    let sides = |t| [interpolate(&points, t, 1), interpolate(&points, t, 2)];
    let mut result = Path::new();
    let mut measure = PathMeasure::new(path, false, Some(2.));
    let mut contour = 0_u64;
    let mut stamps = 0_u64;
    loop {
        let length = measure.length();
        if length > 0. && width > 0. {
            if let Some(stamp) = preset.and_then(stamp_shape) {
                let brush = brush.unwrap();
                let read = |key: &str, default: f32| {
                    brush[key].as_f64().map_or(default, |value| value as f32)
                };
                let step = (read("spacing", 1.5).clamp(0.1, 100.) * width)
                    .max(length / 512.)
                    .max(1e-3);
                let seed = brush["seed"].as_u64().unwrap_or(0);
                let mut distance = step / 2.;
                while distance < length && stamps < 4096 {
                    if let Some((position, tangent)) = measure.pos_tan(distance) {
                        let random = |channel| jitter(seed, stamps, channel);
                        let [left, right] = sides(distance / length);
                        let scale = width * (left + right) / 2.
                            * (1. + read("sizeJitter", 0.).clamp(0., 1.) * random(0)).max(0.05);
                        let angle = tangent.y.atan2(tangent.x)
                            + read("rotationJitter", 0.).clamp(0., 1.)
                                * std::f32::consts::PI
                                * random(1);
                        let offset = read("scatter", 0.).clamp(0., 4.) * width * random(2);
                        let (sin, cos) = angle.sin_cos();
                        let matrix = Matrix::new_all(
                            scale * cos,
                            -scale * sin,
                            position.x - tangent.y * offset,
                            scale * sin,
                            scale * cos,
                            position.y + tangent.x * offset,
                            0.,
                            0.,
                            1.,
                        );
                        result.add_path_matrix(&stamp, &matrix, None);
                    }
                    distance += step;
                    stamps += 1;
                }
            } else {
                let steps = ((length / 2.).ceil() as usize).clamp(32, 256);
                let bands = if preset == Some("bristle") { 4 } else { 1 };
                let closed = measure.is_closed() && preset.is_none();
                for band in 0..bands {
                    let mut left = Vec::new();
                    let mut right = Vec::new();
                    for index in 0..=steps {
                        let t = index as f32 / steps as f32;
                        let Some((position, tangent)) = measure.pos_tan(length * t) else {
                            continue;
                        };
                        let [l, r] = sides(t);
                        let (lo, hi) = edges(preset, t, band);
                        let at = |offset| {
                            Point::new(
                                position.x - tangent.y * offset,
                                position.y + tangent.x * offset,
                            )
                        };
                        left.push(at(width * l * lo));
                        right.push(at(width * r * hi));
                    }
                    if closed {
                        contour_points(&mut result, left.into_iter());
                        contour_points(&mut result, right.into_iter().rev());
                    } else {
                        contour_points(
                            &mut result,
                            left.into_iter().chain(right.into_iter().rev()),
                        );
                    }
                }
            }
        }
        contour += 1;
        if contour >= 64 || !measure.next_contour() {
            break;
        }
    }
    Some(result)
}

fn contour_points(result: &mut Path, mut points: impl Iterator<Item = Point>) {
    if let Some(first) = points.next() {
        result.move_to(first);
        for point in points {
            result.line_to(point);
        }
        result.close();
    }
}

fn interpolate(points: &[[f32; 3]], at: f32, side: usize) -> f32 {
    let Some(first) = points.first() else {
        return 1.;
    };
    let segment = points.partition_point(|point| point[0] <= at);
    if segment == 0 {
        return first[side];
    }
    let a = points[segment - 1];
    let Some(b) = points.get(segment).copied() else {
        return a[side];
    };
    let slope = |i: usize| {
        points.get(i + 1).map_or(0., |b| {
            let a = points[i];
            (b[side] - a[side]) / (b[0] - a[0]).max(1e-6)
        })
    };
    let tangent = |i| {
        if i == 0 {
            return slope(0);
        }
        if i + 1 == points.len() {
            return slope(i - 1);
        }
        let (left, right) = (slope(i - 1), slope(i));
        if left * right <= 0. {
            0.
        } else {
            2. * left * right / (left + right)
        }
    };
    let length = (b[0] - a[0]).max(1e-6);
    let u = (at - a[0]) / length;
    let (u2, u3) = (u * u, u * u * u);
    ((2. * u3 - 3. * u2 + 1.) * a[side]
        + (u3 - 2. * u2 + u) * length * tangent(segment - 1)
        + (3. * u2 - 2. * u3) * b[side]
        + (u3 - u2) * length * tangent(segment))
    .max(0.)
}

fn edges(preset: Option<&str>, t: f32, band: usize) -> (f32, f32) {
    let pi = std::f32::consts::PI;
    match preset {
        Some("taper") => {
            let s = 1.5 * t * (1. - t);
            (-s, s)
        }
        Some("ink") => {
            let s = (t / 0.04).min(1.) * ((1. - t) / 0.3).min(1.);
            (
                (-0.5 + 0.04 * (9. * pi * t).sin()) * s,
                (0.45 + 0.04 * (13. * pi * t + 1.).sin()) * s,
            )
        }
        Some("ribbon") => {
            let s = 0.5 * (3. * pi * t).cos();
            (-s, s)
        }
        Some("bristle") => {
            let band = band as f32;
            let y = -0.375 + 0.25 * band;
            let (first, last) = (0.03 * band, 1. - 0.04 * (3. - band));
            let s = 0.09
                * (pi * ((t - first) / (last - first)).clamp(0., 1.))
                    .sin()
                    .max(0.)
                    .sqrt();
            (y - s, y + s)
        }
        _ => (-0.5, 0.5),
    }
}

fn stamp_shape(preset: &str) -> Option<Path> {
    let mut stamp = Path::new();
    match preset {
        "dots" => {
            stamp.add_circle((0., 0.), 0.5, None);
        }
        "confetti" => {
            stamp.add_rect(Rect::from_xywh(-0.3, -0.3, 0.6, 0.6), None);
        }
        "stars" => {
            for i in 0..10 {
                let angle = -std::f32::consts::FRAC_PI_2 + i as f32 * std::f32::consts::TAU / 10.;
                let radius = if i % 2 == 0 { 0.5 } else { 0.2 };
                let point = (angle.cos() * radius, angle.sin() * radius);
                if i == 0 {
                    stamp.move_to(point);
                } else {
                    stamp.line_to(point);
                }
            }
            stamp.close();
        }
        "leaves" => {
            stamp
                .move_to((-0.5, 0.))
                .cubic_to((-0.2, -0.3), (0.2, -0.3), (0.5, 0.))
                .cubic_to((0.2, 0.3), (-0.2, 0.3), (-0.5, 0.))
                .close();
        }
        _ => return None,
    }
    Some(stamp)
}

fn jitter(seed: u64, index: u64, channel: u64) -> f32 {
    let mut z = seed
        ^ index.wrapping_mul(0x9E37_79B9_7F4A_7C15)
        ^ channel.wrapping_mul(0xD1B5_4A32_D192_ED03);
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^= z >> 31;
    (z >> 40) as f32 / (1_u32 << 23) as f32 - 1.
}
