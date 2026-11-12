use super::*;
use skia_safe::{
    ClipOp, PathEffect,
    paint::{Cap, Join},
};

pub(super) fn stack(
    canvas: &Canvas,
    scene: &Scene,
    item: &SceneItem,
    path: &Path,
    key: &str,
    diagnostics: &mut Vec<Diagnostic>,
) -> Result<bool, RenderError> {
    let Some(paints) = item.properties.get(key).and_then(Value::as_array) else {
        return Ok(false);
    };
    if paints.len() > 128 {
        return Err(RenderError::ResourceLimit(
            "paint stack exceeds 128 entries".into(),
        ));
    }
    for source in paints.iter().filter(|p| {
        p.get("visible") != Some(&Value::Bool(false)) && p.get("hidden") != Some(&Value::Bool(true))
    }) {
        let mut paint = match make_paint(source, item) {
            Ok(paint) => paint,
            Err(error) => {
                diagnose(scene, item, key, &error.to_string(), diagnostics)?;
                continue;
            }
        };
        if key == "strokes" {
            let (alignment, doubled) = configure_stroke(source, &mut paint)?;
            if !doubled && alignment != "center" {
                diagnose(scene, item, "stroke.alignment", alignment, diagnostics)?;
            }
            for name in ["startCap", "endCap", "sides"] {
                if let Some(value) = source.get(name) {
                    diagnose(
                        scene,
                        item,
                        &format!("stroke.{name}"),
                        &value.to_string(),
                        diagnostics,
                    )?;
                }
            }
            let saved = canvas.save();
            if doubled {
                canvas.clip_path(
                    path,
                    if matches!(alignment, "inside" | "inner") {
                        ClipOp::Intersect
                    } else {
                        ClipOp::Difference
                    },
                    true,
                );
            }
            canvas.draw_path(path, &paint);
            canvas.restore_to_count(saved);
        } else {
            canvas.draw_path(path, &paint);
        }
    }
    Ok(true)
}

fn configure_stroke<'a>(
    source: &'a Value,
    paint: &mut Paint,
) -> Result<(&'a str, bool), RenderError> {
    let width = number(source, "width", number(source, "thickness", 1.));
    if !(0. ..=10000.).contains(&width) {
        return Err(RenderError::ResourceLimit(
            "stroke width must be 0..10000".into(),
        ));
    }
    let alignment = source
        .get("align")
        .or_else(|| source.get("alignment"))
        .and_then(Value::as_str)
        .unwrap_or("center");
    let doubled = matches!(alignment, "inside" | "inner" | "outside" | "outer");
    paint
        .set_style(Style::Stroke)
        .set_stroke_width((width * if doubled { 2. } else { 1. }) as f32);
    paint.set_stroke_cap(
        match source
            .get("cap")
            .or_else(|| source.get("lineCap"))
            .and_then(Value::as_str)
        {
            Some("round") => Cap::Round,
            Some("square") => Cap::Square,
            _ => Cap::Butt,
        },
    );
    paint.set_stroke_join(
        match source
            .get("join")
            .or_else(|| source.get("lineJoin"))
            .and_then(Value::as_str)
        {
            Some("round") => Join::Round,
            Some("bevel") => Join::Bevel,
            _ => Join::Miter,
        },
    );
    paint.set_stroke_miter(number(source, "miterLimit", 4.) as f32);
    let dash = source
        .get("dash")
        .or_else(|| source.get("dashes"))
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .map(|v| v.as_f64().unwrap_or(f64::NAN) as f32)
                .collect::<Vec<_>>()
        })
        .or_else(|| match source.get("style").and_then(Value::as_str) {
            Some("dotted") => Some(vec![width as f32, width as f32]),
            Some("dashed") => Some(vec![width as f32 * 3., width as f32 * 2.]),
            _ => None,
        });
    if let Some(mut dash) = dash.filter(|d| !d.is_empty()) {
        if dash.len() % 2 != 0 {
            dash.extend(dash.clone());
        }
        if dash.len() > 128 || dash.iter().any(|v| !v.is_finite() || *v <= 0.) {
            return Err(RenderError::Unsupported(
                "dash intervals must be positive, finite and bounded".into(),
            ));
        }
        paint.set_path_effect(PathEffect::dash(
            &dash,
            number(source, "dashOffset", 0.) as f32,
        ));
    }
    Ok((alignment, doubled))
}

pub fn stroke_outlines(item: &SceneItem) -> Result<Vec<(Path, Value)>, RenderError> {
    let path = shape_path(item)?;
    let mut outlines = Vec::new();
    let strokes = item.properties.get("strokes").and_then(Value::as_array);
    if let Some(strokes) = strokes {
        if strokes.len() > 128 {
            return Err(RenderError::ResourceLimit(
                "paint stack exceeds 128 entries".into(),
            ));
        }
        for source in strokes.iter().filter(|p| {
            p.get("visible") != Some(&Value::Bool(false))
                && p.get("hidden") != Some(&Value::Bool(true))
        }) {
            let mut paint = make_paint(source, item)?;
            if paint.shader().is_some()
                || ["startCap", "endCap", "sides"]
                    .iter()
                    .any(|key| source.get(key).is_some())
            {
                return Err(RenderError::Unsupported(
                    "stroke outline requires solid paint and uniform caps and sides".into(),
                ));
            }
            let (alignment, _) = configure_stroke(source, &mut paint)?;
            if !matches!(
                alignment,
                "center" | "inside" | "inner" | "outside" | "outer"
            ) {
                return Err(RenderError::Unsupported(format!(
                    "stroke alignment {alignment}"
                )));
            }
            let mut fill = source.clone();
            if fill.get("color").is_none() {
                fill = serde_json::json!({"type":"solid","color":source,"opacity":source.get("opacity").and_then(Value::as_f64).unwrap_or(1.)});
            }
            push_outline(&mut outlines, &path, &paint, alignment, fill)?;
        }
    } else if let Some(color) = item.style.get("border-color") {
        let mut paint = Paint::default();
        let fill = serde_json::json!({"type":"solid","color":color});
        let stroke = serde_json::json!({
            "width":item.style.get("border-width").and_then(|v| resolve_length(v, LengthContext::default())).unwrap_or(1.)
        });
        configure_stroke(&stroke, &mut paint)?;
        push_outline(&mut outlines, &path, &paint, "center", fill)?;
    }
    if outlines.is_empty() {
        return Err(RenderError::Unsupported(
            "layer has no convertible stroke".into(),
        ));
    }
    Ok(outlines)
}

fn push_outline(
    outlines: &mut Vec<(Path, Value)>,
    path: &Path,
    paint: &Paint,
    alignment: &str,
    fill: Value,
) -> Result<(), RenderError> {
    let mut outline = Path::new();
    if !skia_safe::path_utils::fill_path_with_paint(path, paint, &mut outline, None, None) {
        return Err(RenderError::Unsupported(
            "hairline stroke has no fill outline".into(),
        ));
    }
    if alignment != "center" {
        let op = if matches!(alignment, "inside" | "inner") {
            skia_safe::PathOp::Intersect
        } else {
            skia_safe::PathOp::Difference
        };
        outline = outline.op(path, op).ok_or_else(|| {
            RenderError::Unsupported("stroke alignment could not be outlined".into())
        })?;
    }
    if !outline.is_finite() || outline.count_verbs() > 10_000 {
        return Err(RenderError::ResourceLimit(
            "stroke outline exceeds 10000 path verbs".into(),
        ));
    }
    if !outline.is_empty() {
        outlines.push((outline, fill));
    }
    Ok(())
}

fn make_paint(source: &Value, item: &SceneItem) -> Result<Paint, RenderError> {
    let mut paint = Paint::default();
    paint.set_anti_alias(true);
    let kind = source
        .get("type")
        .and_then(Value::as_str)
        .or_else(|| {
            source
                .get("gradient")
                .and_then(|g| g.get("type"))
                .and_then(Value::as_str)
        })
        .unwrap_or(if source.get("image").is_some() {
            "image"
        } else {
            "solid"
        });
    if matches!(kind, "solid" | "color") {
        let color = source.get("color").unwrap_or(source);
        let color = paint_color(color)
            .ok_or_else(|| RenderError::Unsupported(format!("paint color {color}")))?;
        paint.set_color4f(Color4f::new(color.r, color.g, color.b, color.a), None);
    } else if matches!(
        kind,
        "linear" | "linear-gradient" | "radial" | "radial-gradient" | "angular" | "conic"
    ) {
        paint.set_shader(
            native_gradient(source, item, kind)
                .ok_or_else(|| RenderError::Unsupported(format!("{kind} gradient")))?,
        );
    } else {
        return Err(RenderError::Unsupported(format!("paint type {kind}")));
    }
    let opacity = number(source, "opacity", 1.);
    if !(0. ..=1.).contains(&opacity) {
        return Err(RenderError::Unsupported(
            "paint opacity must be 0..1".into(),
        ));
    }
    paint.set_alpha_f(paint.alpha_f() * opacity as f32);
    if let Some(blend) = source.get("blendMode").and_then(Value::as_str) {
        paint.set_blend_mode(blend_mode(blend)?);
    }
    Ok(paint)
}

pub(super) fn paint_color(value: &Value) -> Option<Color> {
    if let Some(s) = value.as_str() {
        return parse_color(s);
    }
    let channels = if value.get("r").is_some() {
        ["r", "g", "b", "a"]
    } else {
        ["red", "green", "blue", "alpha"]
    };
    Some(Color {
        r: value.get(channels[0])?.as_f64()? as f32,
        g: value.get(channels[1])?.as_f64()? as f32,
        b: value.get(channels[2])?.as_f64()? as f32,
        a: value.get(channels[3]).and_then(Value::as_f64).unwrap_or(1.) as f32,
    })
}

fn native_gradient(source: &Value, item: &SceneItem, kind: &str) -> Option<Shader> {
    let gradient = source.get("gradient").unwrap_or(source);
    let stops = gradient
        .get("stops")
        .or_else(|| source.get("stops"))?
        .as_array()?;
    if stops.len() < 2 || stops.len() > 128 {
        return None;
    }
    let mut colors = Vec::new();
    let mut positions = Vec::new();
    for stop in stops {
        let mut color = paint_color(stop.get("color")?)?;
        color.a *= number(stop, "opacity", 1.) as f32;
        colors.push(to_sk_color(color));
        let position = stop
            .get("offset")
            .or_else(|| stop.get("position"))?
            .as_f64()? as f32;
        if !position.is_finite() {
            return None;
        }
        positions.push(position);
    }
    if positions.windows(2).any(|p| p[0] > p[1]) {
        return None;
    }
    let coordinate = |key: &str, axis: &str, default: f64| {
        gradient
            .get(key)
            .and_then(|v| v.get(axis))
            .and_then(Value::as_f64)
            .unwrap_or(default)
    };
    let start = (
        coordinate("start", "x", number(gradient, "x1", 0.)) * item.width,
        coordinate("start", "y", number(gradient, "y1", 0.5)) * item.height,
    );
    let end = (
        coordinate("end", "x", number(gradient, "x2", 1.)) * item.width,
        coordinate("end", "y", number(gradient, "y2", 0.5)) * item.height,
    );
    if matches!(kind, "linear" | "linear-gradient") {
        return Shader::linear_gradient(
            (
                (start.0 as f32, start.1 as f32),
                (end.0 as f32, end.1 as f32),
            ),
            colors.as_slice(),
            positions.as_slice(),
            TileMode::Clamp,
            None,
            None,
        );
    }
    if matches!(kind, "angular" | "conic") {
        let angle = number(
            gradient,
            "angle",
            (end.1 - start.1).atan2(end.0 - start.0).to_degrees(),
        );
        return Shader::sweep_gradient(
            (start.0 as f32, start.1 as f32),
            colors.as_slice(),
            positions.as_slice(),
            TileMode::Clamp,
            Some((angle as f32, angle as f32 + 360.)),
            None,
            None,
        );
    }
    let center = (
        coordinate("center", "x", start.0 / item.width) * item.width,
        coordinate("center", "y", start.1 / item.height) * item.height,
    );
    let radius = number(gradient, "radius", (end.0 - start.0).hypot(end.1 - start.1));
    let aspect = number(gradient, "aspect", 1.);
    if radius <= 0. || aspect <= 0. || !radius.is_finite() {
        return None;
    }
    let angle = (end.1 - start.1).atan2(end.0 - start.0);
    let matrix = omc_scene::Affine::translation(center.0, center.1).multiply(omc_scene::Affine([
        angle.cos(),
        angle.sin(),
        -angle.sin() * aspect,
        angle.cos() * aspect,
        0.,
        0.,
    ]));
    let a = matrix.0;
    let matrix = Matrix::new_all(
        a[0] as f32,
        a[2] as f32,
        a[4] as f32,
        a[1] as f32,
        a[3] as f32,
        a[5] as f32,
        0.,
        0.,
        1.,
    );
    Shader::radial_gradient(
        (0., 0.),
        radius as f32,
        colors.as_slice(),
        positions.as_slice(),
        TileMode::Clamp,
        None,
        Some(&matrix),
    )
}

pub(super) fn shadows(
    canvas: &Canvas,
    scene: &Scene,
    item: &SceneItem,
    path: &Path,
    diagnostics: &mut Vec<Diagnostic>,
) -> Result<(), RenderError> {
    let Some(shadows) = item.properties.get("shadows").and_then(Value::as_array) else {
        return Ok(());
    };
    if shadows.len() > 32 {
        return Err(RenderError::ResourceLimit(
            "shadow stack exceeds 32 entries".into(),
        ));
    }
    for shadow in shadows.iter().filter(|s| {
        s.get("hidden") != Some(&Value::Bool(true)) && s.get("visible") != Some(&Value::Bool(false))
    }) {
        let blur = number(shadow, "blur", number(shadow, "radius", 0.));
        let spread = number(shadow, "spread", 0.);
        if !(0. ..=256.).contains(&blur) || spread.abs() > 1024. {
            return Err(RenderError::ResourceLimit(
                "shadow blur/spread range".into(),
            ));
        }
        if shadow.get("style").and_then(Value::as_str) == Some("inner") {
            diagnose(scene, item, "shadow.style", "inner", diagnostics)?;
            continue;
        }
        let color = shadow.get("color").and_then(paint_color).unwrap_or(Color {
            r: 0.,
            g: 0.,
            b: 0.,
            a: 1.,
        });
        let offset = (
            number(
                shadow,
                "offsetX",
                shadow.get("offset").map_or(0., |v| number(v, "x", 0.)),
            ),
            number(
                shadow,
                "offsetY",
                shadow.get("offset").map_or(0., |v| number(v, "y", 0.)),
            ),
        );
        let input = if spread > 0. {
            skia_safe::image_filters::dilate((spread as f32, spread as f32), None, None)
        } else if spread < 0. {
            skia_safe::image_filters::erode((-spread as f32, -spread as f32), None, None)
        } else {
            None
        };
        let mut paint = Paint::default();
        paint.set_anti_alias(true);
        paint.set_color4f(
            Color4f::new(0., 0., 0., number(shadow, "opacity", 1.) as f32),
            None,
        );
        paint.set_image_filter(skia_safe::image_filters::drop_shadow_only(
            (offset.0 as f32, offset.1 as f32),
            (blur as f32, blur as f32),
            Color4f::new(color.r, color.g, color.b, color.a),
            None,
            input,
            None,
        ));
        canvas.draw_path(path, &paint);
    }
    Ok(())
}
fn number(value: &Value, key: &str, default: f64) -> f64 {
    value
        .get(key)
        .and_then(Value::as_f64)
        .filter(|v| v.is_finite())
        .unwrap_or(default)
}
