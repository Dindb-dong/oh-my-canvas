use super::*;
use skia_safe::{FilterMode, PictureRecorder};

pub(super) fn draw(
    canvas: &Canvas,
    scene: &Scene,
    item: &SceneItem,
    path: &Path,
    pattern: &Value,
    resources: &dyn ResourceProvider,
    diagnostics: &mut Vec<Diagnostic>,
    depth: usize,
) -> Result<(), RenderError> {
    let source_id = pattern["source"].as_str().unwrap_or_default();
    let Some((index, source)) = scene
        .items
        .iter()
        .enumerate()
        .find(|(_, item)| item.id == source_id)
    else {
        return diagnose(
            scene,
            item,
            "fill.pattern",
            "pattern source is unavailable",
            diagnostics,
        );
    };
    if depth >= 2 || item.id == source.id {
        return diagnose(
            scene,
            item,
            "fill.pattern",
            "pattern recursion exceeds the render limit",
            diagnostics,
        );
    }
    let Some(inverse) = source.local.inverse() else {
        return diagnose(
            scene,
            item,
            "fill.pattern",
            "pattern source transform is singular",
            diagnostics,
        );
    };
    let read = |key: &str, default: f64| {
        pattern[key]
            .as_f64()
            .filter(|v| v.is_finite())
            .unwrap_or(default)
    };
    let scale = read("scale", 1.).clamp(0.01, 100.);
    let (tile_w, tile_h) = (source.width * scale, source.height * scale);
    if tile_w <= 1e-6 || tile_h <= 1e-6 {
        return Ok(());
    }
    let spacing = |axis| {
        pattern["spacing"]
            .get(axis)
            .and_then(Value::as_f64)
            .unwrap_or(0.)
            .clamp(0., 10_000.)
    };
    let (step_x, step_y) = (tile_w + spacing(0), tile_h + spacing(1));
    let (cell_w, cell_h, tiles) = match pattern["tile"].as_str() {
        Some("horizontalHex") => (
            step_x,
            step_y * 2.,
            vec![(0., 0.), (step_x / 2., step_y), (-step_x / 2., step_y)],
        ),
        Some("verticalHex") => (
            step_x * 2.,
            step_y,
            vec![(0., 0.), (step_x, step_y / 2.), (step_x, -step_y / 2.)],
        ),
        _ => (step_x, step_y, vec![(0., 0.)]),
    };
    let anchor = match pattern["align"].as_str() {
        Some("center") => 0.5,
        Some("end") => 1.,
        _ => 0.,
    };
    let (origin_x, origin_y) = (
        (item.width - tile_w) * anchor,
        (item.height - tile_h) * anchor,
    );
    let tile = Rect::from_wh(cell_w as f32, cell_h as f32);
    let mut recording = PictureRecorder::new();
    let target = recording.begin_recording(tile, false);
    target.clip_rect(tile, None, Some(false));
    for (x, y) in tiles {
        let count = target.save();
        target.translate((x as f32, y as f32));
        target.scale((scale as f32, scale as f32));
        target.concat(&skia_matrix(inverse));
        paint_item(
            target,
            scene,
            index,
            resources,
            diagnostics,
            &BTreeMap::new(),
            None,
            depth + 1,
            None,
            None,
        )?;
        target.restore_to_count(count);
    }
    let Some(picture) = recording.finish_recording_as_picture(Some(&tile)) else {
        return Ok(());
    };
    let mut paint = Paint::default();
    paint.set_alpha_f(read("opacity", 1.).clamp(0., 1.) as f32);
    paint.set_blend_mode(blend_mode(
        pattern["blendMode"].as_str().unwrap_or("normal"),
    )?);
    let bounds = path.compute_tight_bounds();
    let (left, right) = (
        ((f64::from(bounds.left) - origin_x) / cell_w).floor() as i64,
        ((f64::from(bounds.right) - origin_x) / cell_w).ceil() as i64,
    );
    let (top, bottom) = (
        ((f64::from(bounds.top) - origin_y) / cell_h).floor() as i64,
        ((f64::from(bounds.bottom) - origin_y) / cell_h).ceil() as i64,
    );
    if right
        .saturating_sub(left)
        .saturating_mul(bottom.saturating_sub(top))
        <= 4096
    {
        let save = canvas.save();
        canvas.clip_path(path, None, true);
        canvas.save_layer(&SaveLayerRec::default().paint(&paint));
        for row in top..bottom {
            for col in left..right {
                let matrix = Matrix::translate((
                    (origin_x + col as f64 * cell_w) as f32,
                    (origin_y + row as f64 * cell_h) as f32,
                ));
                canvas.draw_picture(&picture, Some(&matrix), None);
            }
        }
        canvas.restore_to_count(save);
    } else {
        let matrix = Matrix::translate((origin_x as f32, origin_y as f32));
        paint.set_shader(picture.to_shader(
            Some((TileMode::Repeat, TileMode::Repeat)),
            FilterMode::Linear,
            Some(&matrix),
            Some(&tile),
        ));
        canvas.draw_path(path, &paint);
    }
    Ok(())
}
