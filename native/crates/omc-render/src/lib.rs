//! Browser-free CPU Skia rendering shared by desktop, screenshots and PDF exports.
mod paints;
mod resources;

use omc_model::NodeKind;
use omc_scene::{Scene, SceneItem};
use omc_style::{Color, Diagnostic, LengthContext, parse_color, resolve_length};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use skia_safe::{
    AlphaType, BlendMode, Canvas, Color4f, ColorSpace, ColorType, Data, EncodedImageFormat, Image,
    ImageInfo, Matrix, Paint, Path, RRect, Rect, Shader, Surface, TileMode, canvas::SaveLayerRec,
    paint::Style,
};

#[derive(Debug, thiserror::Error)]
pub enum RenderError {
    #[error("render resource limit: {0}")]
    ResourceLimit(String),
    #[error("invalid render dimensions or scale")]
    InvalidDimensions,
    #[error("native renderer failed: {0}")]
    Backend(String),
    #[error("resource unavailable: {0}")]
    ResourceUnavailable(String),
    #[error("unsupported rendering feature: {0}")]
    Unsupported(String),
}
/// Resource capabilities contain immutable verified content identities, never arbitrary paths or URLs.
pub trait ResourceProvider {
    fn get(&self, hash: &str) -> Result<Vec<u8>, String>;
}
pub struct EmptyResources;
impl ResourceProvider for EmptyResources {
    fn get(&self, hash: &str) -> Result<Vec<u8>, String> {
        Err(format!("No resource provider for {hash}"))
    }
}
impl ResourceProvider for std::collections::BTreeMap<String, Vec<u8>> {
    fn get(&self, hash: &str) -> Result<Vec<u8>, String> {
        self.get(hash)
            .cloned()
            .ok_or_else(|| format!("Missing resource {hash}"))
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderOptions {
    pub scale: f64,
    pub background: Option<[f32; 4]>,
    pub max_surface_bytes: usize,
}
impl Default for RenderOptions {
    fn default() -> Self {
        Self {
            scale: 1.,
            background: None,
            max_surface_bytes: 256 * 1024 * 1024,
        }
    }
}
pub struct RenderedImage {
    pub width: u32,
    pub height: u32,
    pub pixels: Vec<u8>,
    pub diagnostics: Vec<Diagnostic>,
}
#[derive(Clone, Copy, Debug)]
pub enum RasterFormat {
    Png,
    Jpeg,
    Webp,
}

fn surface(
    scene: &Scene,
    options: &RenderOptions,
    resources: &dyn ResourceProvider,
) -> Result<(Surface, Vec<Diagnostic>), RenderError> {
    let (width, height, bytes) = dimensions(scene, options)?;
    // One backing surface plus the caller-visible RGBA readback must fit the reservation.
    if bytes
        .checked_mul(2)
        .is_none_or(|size| size > options.max_surface_bytes)
    {
        return Err(RenderError::ResourceLimit(format!(
            "RGBA surface and readback require {} bytes",
            bytes.saturating_mul(2)
        )));
    }
    let cached_resources = resources::reserve(scene, options, resources)?;
    let info = ImageInfo::new(
        (width as i32, height as i32),
        ColorType::RGBA8888,
        AlphaType::Premul,
        ColorSpace::new_srgb(),
    );
    let mut surface = skia_safe::surfaces::raster(&info, None, None)
        .ok_or_else(|| RenderError::Backend("CPU surface allocation failed".into()))?;
    let canvas = surface.canvas();
    canvas.clear(
        options
            .background
            .map(|v| Color4f::new(v[0], v[1], v[2], v[3]))
            .unwrap_or(Color4f::new(0., 0., 0., 0.)),
    );
    canvas.scale((options.scale as f32, options.scale as f32));
    let diagnostics = paint_scene(canvas, scene, &cached_resources)?;
    Ok((surface, diagnostics))
}

fn dimensions(scene: &Scene, options: &RenderOptions) -> Result<(u32, u32, usize), RenderError> {
    if !options.scale.is_finite()
        || options.scale <= 0.
        || options.scale > 64.
        || !scene.width.is_finite()
        || !scene.height.is_finite()
    {
        return Err(RenderError::InvalidDimensions);
    }
    let width = (scene.width * options.scale).ceil();
    let height = (scene.height * options.scale).ceil();
    if width < 1. || height < 1. || width > 32768. || height > 32768. {
        return Err(RenderError::ResourceLimit(
            "single surface dimension must be 1..32768 pixels".into(),
        ));
    }
    let (width, height) = (width as u32, height as u32);
    let bytes = (width as usize)
        .checked_mul(height as usize)
        .and_then(|n| n.checked_mul(4))
        .ok_or(RenderError::InvalidDimensions)?;
    Ok((width, height, bytes))
}

pub fn render_rgba(
    scene: &Scene,
    options: &RenderOptions,
    resources: &dyn ResourceProvider,
) -> Result<RenderedImage, RenderError> {
    let (mut surface, diagnostics) = surface(scene, options, resources)?;
    let (width, height, bytes) = dimensions(scene, options)?;
    let mut pixels = vec![0; bytes];
    let info = ImageInfo::new(
        (width as i32, height as i32),
        ColorType::RGBA8888,
        AlphaType::Unpremul,
        ColorSpace::new_srgb(),
    );
    if !surface.read_pixels(&info, &mut pixels, width as usize * 4, (0, 0)) {
        return Err(RenderError::Backend("RGBA readback failed".into()));
    }
    Ok(RenderedImage {
        width,
        height,
        pixels,
        diagnostics,
    })
}

pub fn render_encoded(
    scene: &Scene,
    options: &RenderOptions,
    resources: &dyn ResourceProvider,
    format: RasterFormat,
    quality: u32,
) -> Result<Vec<u8>, RenderError> {
    render_encoded_with_diagnostics(scene, options, resources, format, quality)
        .map(|(bytes, _)| bytes)
}
pub fn render_encoded_with_diagnostics(
    scene: &Scene,
    options: &RenderOptions,
    resources: &dyn ResourceProvider,
    format: RasterFormat,
    quality: u32,
) -> Result<(Vec<u8>, Vec<Diagnostic>), RenderError> {
    if quality > 100 {
        return Err(RenderError::Unsupported("quality must be 0..100".into()));
    }
    let (mut surface, diagnostics) = surface(scene, options, resources)?;
    let image = surface.image_snapshot();
    let format = match format {
        RasterFormat::Png => EncodedImageFormat::PNG,
        RasterFormat::Jpeg => EncodedImageFormat::JPEG,
        RasterFormat::Webp => EncodedImageFormat::WEBP,
    };
    let bytes = image
        .encode(None, format, quality)
        .map(|data| data.as_bytes().to_vec())
        .ok_or_else(|| RenderError::Backend("image encoder failed".into()))?;
    Ok((bytes, diagnostics))
}
pub fn render_png(
    scene: &Scene,
    options: &RenderOptions,
    resources: &dyn ResourceProvider,
) -> Result<Vec<u8>, RenderError> {
    render_encoded(scene, options, resources, RasterFormat::Png, 100)
}

pub fn render_pdf(scene: &Scene, resources: &dyn ResourceProvider) -> Result<Vec<u8>, RenderError> {
    render_pdf_with_diagnostics(scene, resources).map(|(bytes, _)| bytes)
}
pub fn render_pdf_with_diagnostics(
    scene: &Scene,
    resources: &dyn ResourceProvider,
) -> Result<(Vec<u8>, Vec<Diagnostic>), RenderError> {
    if scene.width <= 0.
        || scene.height <= 0.
        || scene.width > 1_000_000.
        || scene.height > 1_000_000.
    {
        return Err(RenderError::InvalidDimensions);
    }
    let mut bytes = Vec::new();
    let diagnostics;
    {
        let document = skia_safe::pdf::new_document(&mut bytes, None);
        let mut page = document.begin_page((scene.width as f32, scene.height as f32), None);
        diagnostics = paint_scene(page.canvas(), scene, resources)?;
        page.end_page().close();
    }
    if !bytes.starts_with(b"%PDF-") {
        return Err(RenderError::Backend("PDF encoding failed".into()));
    }
    Ok((bytes, diagnostics))
}

/// Draws into the caller's canvas without changing its camera, clip or save stack.
pub fn paint_scene(
    canvas: &Canvas,
    scene: &Scene,
    resources: &dyn ResourceProvider,
) -> Result<Vec<Diagnostic>, RenderError> {
    paint_scene_preview(canvas, scene, resources, &std::collections::BTreeMap::new())
}

/// Non-authoritative gesture preview. Offscreen/export callers use paint_scene
/// without overrides, so editor overlays never change the committed output.
pub fn paint_scene_preview(
    canvas: &Canvas,
    scene: &Scene,
    resources: &dyn ResourceProvider,
    translations: &std::collections::BTreeMap<String, (f64, f64)>,
) -> Result<Vec<Diagnostic>, RenderError> {
    if translations
        .values()
        .any(|(x, y)| !x.is_finite() || !y.is_finite())
    {
        return Err(RenderError::InvalidDimensions);
    }
    let mut diagnostics = scene.diagnostics.clone();
    if !scene.items.is_empty() {
        paint_item(
            canvas,
            scene,
            scene.root,
            resources,
            &mut diagnostics,
            translations,
        )?;
    }
    Ok(diagnostics)
}

fn paint_item(
    canvas: &Canvas,
    scene: &Scene,
    index: usize,
    resources: &dyn ResourceProvider,
    diagnostics: &mut Vec<Diagnostic>,
    translations: &std::collections::BTreeMap<String, (f64, f64)>,
) -> Result<(), RenderError> {
    let item = &scene.items[index];
    if item.hidden {
        return Ok(());
    }
    let saved = canvas.save();
    let result = (|| {
        if let Some((x, y)) = translations.get(&item.id) {
            canvas.translate((*x as f32, *y as f32));
        }
        let a = item.local.0;
        canvas.concat(&Matrix::new_all(
            a[0] as f32,
            a[2] as f32,
            a[4] as f32,
            a[1] as f32,
            a[3] as f32,
            a[5] as f32,
            0.,
            0.,
            1.,
        ));
        let opacity = item.style.number("opacity", 1.).clamp(0., 1.) as f32;
        let blend = blend_mode(
            item.style
                .get("mix-blend-mode")
                .or_else(|| item.properties.get("blendMode").and_then(Value::as_str))
                .unwrap_or("normal"),
        )?;
        let mut layer = Paint::default();
        layer.set_alpha_f(opacity);
        layer.set_blend_mode(blend);
        if let Some(filter) = item.style.get("filter") {
            if filter != "none" {
                if let Some(value) = filter
                    .strip_prefix("blur(")
                    .and_then(|v| v.strip_suffix(')'))
                    .and_then(|v| resolve_length(v, LengthContext::default()))
                {
                    if !(0. ..=256.).contains(&value) {
                        return Err(RenderError::ResourceLimit(
                            "blur sigma must be 0..256".into(),
                        ));
                    }
                    layer.set_image_filter(skia_safe::image_filters::blur(
                        (value as f32, value as f32),
                        TileMode::Decal,
                        None,
                        None,
                    ));
                } else {
                    diagnose(scene, item, "filter", filter, diagnostics)?;
                }
            }
        }
        let grouped = opacity < 1. || blend != BlendMode::SrcOver || layer.image_filter().is_some();
        if grouped {
            canvas.save_layer(&SaveLayerRec::default().paint(&layer));
        }
        for key in ["shader", "effect", "shaderEffect"] {
            if let Some(value) = item.properties.get(key) {
                diagnose(
                    scene,
                    item,
                    key,
                    &format!("Native shader registry port is pending: {value}"),
                    diagnostics,
                )?;
            }
        }
        let shape = shape_path(item)?;
        paints::shadows(canvas, scene, item, &shape, diagnostics)?;
        let mut fill = Paint::default();
        fill.set_anti_alias(true);
        let has_fills = if item.kind == NodeKind::Text {
            if let Some(fills) = item.properties.get("fills").and_then(Value::as_array) {
                if fills.len() > 1
                    || fills
                        .iter()
                        .any(|p| p.get("gradient").is_some() || p.get("image").is_some())
                {
                    diagnose(
                        scene,
                        item,
                        "text.fills",
                        "Multiple/gradient text paints require glyph-mask painting",
                        diagnostics,
                    )?;
                }
            }
            false
        } else {
            paints::stack(canvas, scene, item, &shape, "fills", diagnostics)?
        };
        if let Some(background) = item
            .style
            .get("background-color")
            .or_else(|| item.style.get("background"))
            .filter(|v| *v != "none" && !has_fills)
        {
            if let Some(color) = parse_color(background) {
                fill.set_color4f(Color4f::new(color.r, color.g, color.b, color.a), None);
                canvas.draw_path(&shape, &fill);
            } else if background.starts_with("linear-gradient(")
                || background.starts_with("radial-gradient(")
            {
                if let Some(shader) = gradient(background, item.width, item.height) {
                    fill.set_shader(shader);
                    canvas.draw_path(&shape, &fill);
                } else {
                    diagnose(scene, item, "background", background, diagnostics)?;
                }
            } else {
                diagnose(scene, item, "background-color", background, diagnostics)?;
            }
        }
        if let Some(background) = item.style.get("background-image") {
            if let Some(shader) = gradient(background, item.width, item.height) {
                fill.set_shader(shader);
                canvas.draw_path(&shape, &fill);
            } else if background != "none" {
                diagnose(scene, item, "background-image", background, diagnostics)?;
            }
        }
        if item.kind == NodeKind::Image {
            draw_image(canvas, item, resources, scene.strict, diagnostics)?;
        }
        if let Some(text) = &item.text {
            text.paint(canvas, item.text_offset.0, item.text_offset.1);
        }
        let has_strokes = paints::stack(canvas, scene, item, &shape, "strokes", diagnostics)?;
        if let Some(stroke) = item.style.color("border-color").filter(|_| !has_strokes) {
            let width = item
                .style
                .get("border-width")
                .and_then(|v| resolve_length(v, LengthContext::default()))
                .unwrap_or(1.);
            if width > 0. {
                let mut paint = Paint::default();
                paint
                    .set_anti_alias(true)
                    .set_style(Style::Stroke)
                    .set_stroke_width(width as f32)
                    .set_color4f(Color4f::new(stroke.r, stroke.g, stroke.b, stroke.a), None);
                canvas.draw_path(&shape, &paint);
            }
        }
        if item.clip {
            canvas.clip_path(&shape, None, true);
        }
        let mask_mode = if item.properties.get("isMaskGroup") == Some(&Value::Bool(false)) {
            None
        } else {
            item.properties
                .get("maskType")
                .or_else(|| item.properties.get("maskMode"))
                .and_then(Value::as_str)
                .or_else(|| {
                    item.properties
                        .get("mask")
                        .and_then(|m| m.get("mode"))
                        .and_then(Value::as_str)
                })
                .or_else(|| {
                    (item.properties.get("isMaskGroup") == Some(&Value::Bool(true)))
                        .then_some("alpha")
                })
        };
        let mask = match (mask_mode, item.properties.get("maskId")) {
            (Some(_), Some(id)) => {
                let mask = item
                    .children
                    .iter()
                    .copied()
                    .find(|child| id.as_str() == Some(scene.items[*child].id.as_str()));
                if mask.is_none() {
                    diagnose(
                        scene,
                        item,
                        "maskId",
                        "Mask must be a direct child",
                        diagnostics,
                    )?;
                }
                mask
            }
            (Some(_), None) => item.children.first().copied(),
            (None, _) => None,
        };
        if let (Some(mode), Some(mask)) = (mask_mode, mask) {
            let content = item.children.iter().copied().filter(|child| *child != mask);
            match mode {
                "alpha" | "luminance" => {
                    canvas.save_layer(&SaveLayerRec::default());
                    for child in content {
                        paint_item(canvas, scene, child, resources, diagnostics, translations)?;
                    }
                    let mut mask_paint = Paint::default();
                    mask_paint.set_blend_mode(BlendMode::DstIn);
                    if mode == "luminance" {
                        mask_paint.set_color_filter(skia_safe::ColorFilter::luma());
                    }
                    canvas.save_layer(&SaveLayerRec::default().paint(&mask_paint));
                    paint_item(canvas, scene, mask, resources, diagnostics, translations)?;
                    canvas.restore();
                    canvas.restore();
                }
                "vector" => {
                    let mut path = shape_path(&scene.items[mask])?;
                    let a = scene.items[mask].local.0;
                    path.transform(&Matrix::new_all(
                        a[0] as f32,
                        a[2] as f32,
                        a[4] as f32,
                        a[1] as f32,
                        a[3] as f32,
                        a[5] as f32,
                        0.,
                        0.,
                        1.,
                    ));
                    if !scene.items[mask].children.is_empty() {
                        diagnose(
                            scene,
                            item,
                            "vector-mask",
                            "Nested vector mask coverage is not implemented",
                            diagnostics,
                        )?;
                    }
                    canvas.clip_path(&path, None, true);
                    for child in content {
                        paint_item(canvas, scene, child, resources, diagnostics, translations)?;
                    }
                }
                other => {
                    diagnose(scene, item, "maskMode", other, diagnostics)?;
                    for child in &item.children {
                        paint_item(canvas, scene, *child, resources, diagnostics, translations)?;
                    }
                }
            }
        } else if mask_mode.is_none() {
            for child in &item.children {
                paint_item(canvas, scene, *child, resources, diagnostics, translations)?;
            }
        }
        if grouped {
            canvas.restore();
        }
        Ok(())
    })();
    canvas.restore_to_count(saved);
    result
}

fn shape_path(item: &SceneItem) -> Result<Path, RenderError> {
    let mut path = Path::new();
    let rect = Rect::from_xywh(0., 0., item.width as f32, item.height as f32);
    match item.kind {
        NodeKind::Ellipse => {
            path.add_oval(rect, None);
        }
        NodeKind::Line => {
            path.move_to((0., 0.))
                .line_to((item.width as f32, item.height as f32));
        }
        NodeKind::Path => {
            let svg = item
                .properties
                .get("path")
                .and_then(Value::as_str)
                .unwrap_or("");
            path = Path::from_svg(svg).ok_or_else(|| {
                RenderError::Unsupported(format!("invalid SVG path for {}", item.id))
            })?;
            if item.properties.get("fillRule").and_then(Value::as_str) == Some("evenodd") {
                path.set_fill_type(skia_safe::PathFillType::EvenOdd);
            }
        }
        _ => {
            let radius = item
                .style
                .get("border-radius")
                .and_then(|v| {
                    resolve_length(
                        v,
                        LengthContext {
                            percent_basis: item.width.min(item.height),
                            ..Default::default()
                        },
                    )
                })
                .unwrap_or(0.)
                .max(0.)
                .min(item.width.min(item.height) / 2.) as f32;
            path.add_rrect(RRect::new_rect_xy(rect, radius, radius), None);
        }
    }
    Ok(path)
}

fn draw_image(
    canvas: &Canvas,
    item: &SceneItem,
    resources: &dyn ResourceProvider,
    strict: bool,
    diagnostics: &mut Vec<Diagnostic>,
) -> Result<(), RenderError> {
    let hash = image_hash(item);
    let loaded = (|| {
        let hash = hash.ok_or_else(|| {
            RenderError::ResourceUnavailable("image has no verified asset hash".into())
        })?;
        resources::load_image(hash, resources)
    })();
    match loaded {
        Ok(image) => {
            let mut dst = Rect::from_xywh(0., 0., item.width as f32, item.height as f32);
            let mut src = Rect::from_wh(image.width() as f32, image.height() as f32);
            match item
                .style
                .get("object-fit")
                .or_else(|| item.properties.get("imageFit").and_then(Value::as_str))
                .unwrap_or("cover")
            {
                "contain" => {
                    let scale = (item.width / image.width() as f64)
                        .min(item.height / image.height() as f64);
                    let (w, h) = (image.width() as f64 * scale, image.height() as f64 * scale);
                    dst = Rect::from_xywh(
                        ((item.width - w) / 2.) as f32,
                        ((item.height - h) / 2.) as f32,
                        w as f32,
                        h as f32,
                    );
                }
                "cover" => {
                    let target = item.width / item.height;
                    let source = image.width() as f64 / image.height() as f64;
                    if source > target {
                        let w = image.height() as f64 * target;
                        src = Rect::from_xywh(
                            ((image.width() as f64 - w) / 2.) as f32,
                            0.,
                            w as f32,
                            image.height() as f32,
                        );
                    } else {
                        let h = image.width() as f64 / target;
                        src = Rect::from_xywh(
                            0.,
                            ((image.height() as f64 - h) / 2.) as f32,
                            image.width() as f32,
                            h as f32,
                        );
                    }
                }
                "fill" => (),
                value => return Err(RenderError::Unsupported(format!("image fit {value}"))),
            }
            let saved = canvas.save();
            canvas.clip_path(&shape_path(item)?, None, true);
            canvas.draw_image_rect(
                &image,
                Some((&src, skia_safe::canvas::SrcRectConstraint::Strict)),
                dst,
                &Paint::default(),
            );
            canvas.restore_to_count(saved);
            Ok(())
        }
        Err(error) => {
            if strict || matches!(error, RenderError::ResourceLimit(_)) {
                return Err(error);
            }
            diagnostics.push(Diagnostic {
                code: "resource_unavailable".into(),
                severity: "error".into(),
                node_id: Some(item.id.clone()),
                property: Some("image".into()),
                original: hash.unwrap_or("").into(),
                action: error.to_string(),
                fidelity_lost: true,
            });
            Ok(())
        }
    }
}
fn image_hash(item: &SceneItem) -> Option<&str> {
    item.properties
        .get("assetHash")
        .or_else(|| item.properties.get("imageHash"))
        .and_then(Value::as_str)
        .or_else(|| {
            item.properties
                .get("image")
                .and_then(|v| v.get("hash"))
                .and_then(Value::as_str)
        })
}

fn diagnose(
    scene: &Scene,
    item: &SceneItem,
    property: &str,
    value: &str,
    diagnostics: &mut Vec<Diagnostic>,
) -> Result<(), RenderError> {
    if scene.strict {
        return Err(RenderError::Unsupported(format!(
            "{} {property}: {value}",
            item.id
        )));
    }
    diagnostics.push(Diagnostic::unsupported(
        Some(&item.id),
        Some(property),
        value,
    ));
    Ok(())
}

fn blend_mode(value: &str) -> Result<BlendMode, RenderError> {
    Ok(match value {
        "normal" | "pass-through" => BlendMode::SrcOver,
        "multiply" => BlendMode::Multiply,
        "screen" => BlendMode::Screen,
        "overlay" => BlendMode::Overlay,
        "darken" => BlendMode::Darken,
        "lighten" => BlendMode::Lighten,
        "color-dodge" => BlendMode::ColorDodge,
        "color-burn" => BlendMode::ColorBurn,
        "hard-light" => BlendMode::HardLight,
        "soft-light" => BlendMode::SoftLight,
        "difference" => BlendMode::Difference,
        "exclusion" => BlendMode::Exclusion,
        "hue" => BlendMode::Hue,
        "saturation" => BlendMode::Saturation,
        "color" => BlendMode::Color,
        "luminosity" => BlendMode::Luminosity,
        _ => return Err(RenderError::Unsupported(format!("blend mode {value}"))),
    })
}

fn gradient(value: &str, width: f64, height: f64) -> Option<Shader> {
    let radial = value.starts_with("radial-gradient(");
    let body = value
        .strip_prefix(if radial {
            "radial-gradient("
        } else {
            "linear-gradient("
        })?
        .strip_suffix(')')?;
    let mut entries = Vec::new();
    let mut start = 0;
    let mut depth = 0;
    for (i, c) in body.char_indices() {
        match c {
            '(' => depth += 1,
            ')' => depth -= 1,
            ',' if depth == 0 => {
                entries.push(body[start..i].trim());
                start = i + 1;
            }
            _ => (),
        }
    }
    entries.push(body[start..].trim());
    let mut angle = 180f64;
    if !radial {
        if let Some(value) = entries[0]
            .strip_suffix("deg")
            .and_then(|v| v.parse::<f64>().ok())
        {
            angle = value;
            entries.remove(0);
        } else if entries[0].starts_with("to ") {
            angle = match entries.remove(0) {
                "to right" => 90.,
                "to left" => 270.,
                "to top" => 0.,
                "to bottom" => 180.,
                _ => return None,
            };
        }
    }
    let mut colors = Vec::new();
    let mut positions = Vec::new();
    for (i, entry) in entries.iter().enumerate() {
        let (color, pos) = if let Some((left, right)) = entry.rsplit_once(' ') {
            if let Some(pos) = right.strip_suffix('%').and_then(|v| v.parse::<f32>().ok()) {
                (parse_color(left)?, pos / 100.)
            } else {
                (parse_color(entry)?, i as f32 / (entries.len() - 1) as f32)
            }
        } else {
            (parse_color(entry)?, i as f32 / (entries.len() - 1) as f32)
        };
        colors.push(to_sk_color(color));
        positions.push(pos);
    }
    if colors.len() < 2 || positions.windows(2).any(|p| p[0] > p[1]) {
        return None;
    }
    if radial {
        Shader::radial_gradient(
            ((width / 2.) as f32, (height / 2.) as f32),
            (width.max(height) / 2.) as f32,
            colors.as_slice(),
            positions.as_slice(),
            TileMode::Clamp,
            None,
            None,
        )
    } else {
        let angle = angle.to_radians();
        let (dx, dy) = (angle.sin(), -angle.cos());
        let extent = (width * dx.abs() + height * dy.abs()) / 2.;
        let (cx, cy) = (width / 2., height / 2.);
        Shader::linear_gradient(
            (
                ((cx - dx * extent) as f32, (cy - dy * extent) as f32),
                ((cx + dx * extent) as f32, (cy + dy * extent) as f32),
            ),
            colors.as_slice(),
            positions.as_slice(),
            TileMode::Clamp,
            None,
            None,
        )
    }
}
fn to_sk_color(color: Color) -> skia_safe::Color {
    Color4f::new(color.r, color.g, color.b, color.a).to_color()
}

#[cfg(test)]
mod tests {
    use super::*;
    use omc_model::{DocumentContent, DocumentSnapshot, Node};
    use omc_scene::{SceneOptions, build_scene};
    use serde_json::json;
    fn fixture() -> Scene {
        let mut content = DocumentContent::empty("native pixels");
        let root = content.pages[0].root_node_id.clone();
        content.nodes.get_mut(&root).unwrap().properties.extend([
            ("width".into(), json!(64)),
            ("height".into(), json!(64)),
            ("fill".into(), json!("white")),
        ]);
        let mut node = Node::new(NodeKind::Rect);
        node.parent_id = Some(root);
        node.properties.extend([
            ("x".into(), json!(8)),
            ("y".into(), json!(8)),
            ("width".into(), json!(24)),
            ("height".into(), json!(24)),
            ("fill".into(), json!("#ff0000")),
        ]);
        content.nodes.insert(node.id.clone(), node);
        let snapshot = DocumentSnapshot {
            id: "test".into(),
            title: content.title,
            epoch: "test".into(),
            sequence: 1,
            pages: content.pages,
            nodes: content.nodes,
            metadata: content.metadata,
        };
        build_scene(
            &snapshot,
            &SceneOptions {
                width: 64.,
                height: 64.,
                ..Default::default()
            },
        )
        .unwrap()
    }
    #[test]
    fn native_pixels_png_pdf_and_budget() {
        let scene = fixture();
        let rgba = render_rgba(&scene, &RenderOptions::default(), &EmptyResources).unwrap();
        assert_eq!(
            &rgba.pixels[(16 * 64 + 16) * 4..(16 * 64 + 16) * 4 + 4],
            &[255, 0, 0, 255]
        );
        let png = render_png(&scene, &RenderOptions::default(), &EmptyResources).unwrap();
        assert!(png.starts_with(b"\x89PNG\r\n\x1a\n"));
        assert_eq!(
            png,
            render_png(&scene, &RenderOptions::default(), &EmptyResources).unwrap()
        );
        assert!(
            render_pdf(&scene, &EmptyResources)
                .unwrap()
                .starts_with(b"%PDF-")
        );
        assert!(
            render_rgba(
                &scene,
                &RenderOptions {
                    max_surface_bytes: 1,
                    ..Default::default()
                },
                &EmptyResources
            )
            .is_err()
        );
    }
}
