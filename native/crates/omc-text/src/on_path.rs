use super::*;
use skia_safe::{Paint, PathMeasure, Point, RSXform, Vector};

pub fn shape_on_path(
    source: &str,
    runs: Option<&serde_json::Value>,
    style: &ComputedStyle,
    path: &Path,
    start: f64,
    flip: bool,
) -> Result<TextLayout, TextError> {
    let mut measure = PathMeasure::new(path, false, None);
    let length = measure.length();
    if length <= 0. || !length.is_finite() {
        return Err(TextError::InvalidWidth);
    }
    let closed = measure.is_closed()
        || measure
            .pos_tan(0.)
            .zip(measure.pos_tan(length))
            .is_some_and(|((a, _), (b, _))| (a - b).length() < 0.001);
    let mut style = style.clone();
    let alignment = style.values.insert("text-align".into(), "left".into());
    style.values.remove("omc-max-lines");
    style.values.remove("omc-wrap-style");
    let layout_width = 1_000_000.;
    let mut layout = shape_runs(source, runs, &style, layout_width)?;
    let (mut shaped, _, font_size, _, _) = paragraph(source, runs, &style, layout_width)?;
    let shift = match alignment.as_deref() {
        Some("center") => layout.intrinsic_width * 0.5,
        Some("right" | "end") => layout.intrinsic_width,
        _ => 0.,
    };
    let baseline = layout.alphabetic_baseline as f32;
    let origin = start.clamp(0., 1.) as f32 * length - shift as f32;
    let mut place = |x: f32, y: f32| -> Option<(Point, Vector)> {
        let mut distance = origin + x;
        if closed {
            distance = distance.rem_euclid(length);
        } else if !(0. ..=length).contains(&distance) {
            return None;
        }
        if flip {
            distance = length - distance;
        }
        let (point, mut tangent) = measure.pos_tan(distance)?;
        if flip {
            tangent = -tangent;
        }
        let below = Vector::new(-tangent.y, tangent.x) * (y - baseline);
        Some((point + below, tangent))
    };

    let mut bounds = path.compute_tight_bounds();
    bounds.outset((
        font_size as f32 * 2.,
        layout.height as f32 + font_size as f32,
    ));
    let mut recorder = PictureRecorder::new();
    let canvas = recorder.begin_recording(bounds, true);
    let mut paint = Paint::default();
    paint.set_anti_alias(true);
    if let Some(color) = style.color("color") {
        paint.set_color4f(Color4f::new(color.r, color.g, color.b, color.a), None);
    }
    let mut outline = Path::new();
    let mut can_outline = true;
    shaped.visit(|_, info| {
        let Some(info) = info else {
            return;
        };
        let font = info.font();
        let glyphs = info.glyphs();
        let mut advances = vec![0.; glyphs.len()];
        font.get_widths(glyphs, &mut advances);
        for ((&glyph, position), advance) in glyphs.iter().zip(info.positions()).zip(advances) {
            let x = info.origin().x + position.x + advance * 0.5;
            let y = info.origin().y + position.y;
            let Some((point, tangent)) = place(x, y) else {
                continue;
            };
            let glyph_origin = point - tangent * (advance * 0.5);
            let transform = RSXform::new(tangent.x, tangent.y, glyph_origin);
            canvas.draw_glyphs_at(&[glyph], &[transform][..], (0., 0.), font, &paint);
            if can_outline {
                if let Some(mut contour) = font.get_path(glyph) {
                    if outline.count_verbs() + contour.count_verbs() <= 10000 {
                        contour.transform(&skia_safe::Matrix::new_all(
                            tangent.x,
                            -tangent.y,
                            glyph_origin.x,
                            tangent.y,
                            tangent.x,
                            glyph_origin.y,
                            0.,
                            0.,
                            1.,
                        ));
                        outline.add_path(&contour, (0., 0.), None);
                    } else {
                        can_outline = false;
                    }
                } else {
                    let mut bounds = [Rect::default(); 1];
                    font.get_bounds(&[glyph], &mut bounds, None);
                    can_outline = bounds[0].is_empty();
                }
            }
        }
    });
    layout.picture = recorder
        .finish_recording_as_picture(None)
        .ok_or(TextError::Recording)?;
    layout.path_outline = (can_outline && !outline.is_empty()).then(|| outline.to_svg());
    layout.width = f64::from(length);

    layout.selection_boxes.retain_mut(|selection| {
        let [x, y, w, h] = selection.rect;
        let Some((point, tangent)) = place((x + w * 0.5) as f32, (y + h * 0.5) as f32) else {
            return false;
        };
        let width = tangent.x.abs() as f64 * w + tangent.y.abs() as f64 * h;
        let height = tangent.y.abs() as f64 * w + tangent.x.abs() as f64 * h;
        selection.rect = [
            f64::from(point.x) - width * 0.5,
            f64::from(point.y) - height * 0.5,
            width,
            height,
        ];
        true
    });
    layout.carets.retain_mut(|caret| {
        let center = (caret.top + caret.bottom) * 0.5;
        let Some((point, tangent)) = place(caret.x as f32, center as f32) else {
            return false;
        };
        let h = ((caret.bottom - caret.top) * f64::from(tangent.x.abs())).max(1.);
        caret.x = f64::from(point.x);
        caret.top = f64::from(point.y) - h * 0.5;
        caret.bottom = f64::from(point.y) + h * 0.5;
        true
    });
    Ok(layout)
}
