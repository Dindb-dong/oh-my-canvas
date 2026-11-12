//! Browser-free Skia rendering shared by desktop, screenshots and PDF exports.
mod image_paint;
mod paints;
mod pattern;
mod variable_stroke;
mod vector_point_stroke;
pub use paints::stroke_outlines;
mod resources;

use omc_model::NodeKind;
use omc_scene::{Affine, Scene, SceneItem};
use omc_style::{Color, Diagnostic, LengthContext, parse_color, resolve_length};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use skia_safe::{
    AlphaType, BlendMode, Canvas, Color4f, ColorSpace, ColorType, Data, EncodedImageFormat, Image,
    ImageInfo, Matrix, Paint, Path, Rect, Shader, Surface, TileMode, canvas::SaveLayerRec,
    paint::Style,
};
use std::collections::{BTreeMap, BTreeSet};

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
        (scene.color_profile == omc_style::ColorProfile::Srgb).then(ColorSpace::new_srgb),
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
    let diagnostics = resources::with_raster_profile(scene.color_profile, || {
        paint_scene(canvas, scene, &cached_resources)
    })?;
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
    let row_bytes = width as usize * 4;
    let read = if scene.color_profile == omc_style::ColorProfile::Srgb {
        surface.read_pixels(&info, &mut pixels, row_bytes, (0, 0))
    } else {
        snapshot_with_color_profile(&mut surface, scene.color_profile)?.read_pixels(
            &info,
            &mut pixels,
            row_bytes,
            (0, 0),
            skia_safe::image::CachingHint::Disallow,
        )
    };
    if !read {
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
    render_encoded_with_profile(scene, options, resources, format, quality, false)
}

pub fn render_encoded_with_profile(
    scene: &Scene,
    options: &RenderOptions,
    resources: &dyn ResourceProvider,
    format: RasterFormat,
    quality: u32,
    display_p3: bool,
) -> Result<(Vec<u8>, Vec<Diagnostic>), RenderError> {
    if quality > 100 {
        return Err(RenderError::Unsupported("quality must be 0..100".into()));
    }
    let (mut surface, diagnostics) = surface(scene, options, resources)?;
    let mut image = snapshot_with_color_profile(&mut surface, scene.color_profile)?;
    let source_is_p3 = scene.color_profile == omc_style::ColorProfile::DisplayP3;
    if display_p3 != source_is_p3 {
        let color_space = if display_p3 {
            display_p3_space()?
        } else {
            ColorSpace::new_srgb()
        };
        image = image
            .make_color_space(None, color_space, Default::default())
            .ok_or_else(|| RenderError::Backend("Image color profile conversion failed".into()))?;
    }
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

fn display_p3_space() -> Result<ColorSpace, RenderError> {
    ColorSpace::new_cicp(
        skia_safe::named_primaries::CicpId::SMPTE_EG_432_1,
        skia_safe::named_transfer_fn::CicpId::SRGB,
    )
    .ok_or_else(|| RenderError::Backend("Display P3 color profile is unavailable".into()))
}

fn snapshot_with_color_profile(
    surface: &mut Surface,
    profile: omc_style::ColorProfile,
) -> Result<Image, RenderError> {
    let image = surface.image_snapshot();
    if profile == omc_style::ColorProfile::DisplayP3 {
        image
            .reinterpret_color_space(display_p3_space()?)
            .ok_or_else(|| RenderError::Backend("Display P3 raster tagging failed".into()))
    } else {
        Ok(image)
    }
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
    paint_scene_preview(canvas, scene, resources, &BTreeMap::new())
}

/// Paints the requested subtree roots in document coordinates.
pub fn paint_scene_layers(
    canvas: &Canvas,
    scene: &Scene,
    layers: &[usize],
    resources: &dyn ResourceProvider,
) -> Result<Vec<Diagnostic>, RenderError> {
    let mut diagnostics = scene.diagnostics.clone();
    let preview = BTreeMap::new();
    for &index in layers {
        let item = scene
            .items
            .get(index)
            .ok_or_else(|| RenderError::Backend("Requested layer is unavailable".into()))?;
        let saved = canvas.save();
        if let Some(parent) = item.parent {
            canvas.concat(&skia_matrix(scene.items[parent].world));
        }
        let result = paint_item(
            canvas,
            scene,
            index,
            resources,
            &mut diagnostics,
            &preview,
            None,
            0,
            None,
            None,
        );
        canvas.restore_to_count(saved);
        result?;
    }
    Ok(diagnostics)
}

/// Paints one prototype frame in scene coordinates, clipped to its own bounds.
pub fn paint_scene_frame(
    canvas: &Canvas,
    scene: &Scene,
    frame_id: &str,
    resources: &dyn ResourceProvider,
) -> Result<Vec<Diagnostic>, RenderError> {
    paint_scene_frame_pose(canvas, scene, frame_id, resources, &BTreeMap::new())
}

/// Paints a prototype frame using temporary local transforms for matched layers.
pub fn paint_scene_frame_pose(
    canvas: &Canvas,
    scene: &Scene,
    frame_id: &str,
    resources: &dyn ResourceProvider,
    poses: &BTreeMap<String, Affine>,
) -> Result<Vec<Diagnostic>, RenderError> {
    let index = scene
        .items
        .iter()
        .position(|item| item.id == frame_id && item.kind == NodeKind::Frame)
        .ok_or_else(|| RenderError::Backend("Prototype frame is unavailable".into()))?;
    let item = &scene.items[index];
    let mut clip = Path::rect(Rect::from_wh(item.width as f32, item.height as f32), None);
    clip.transform(&skia_matrix(item.world));
    let saved = canvas.save();
    canvas.clip_path(&clip, None, true);
    if let Some(parent) = item.parent {
        canvas.concat(&skia_matrix(scene.items[parent].world));
    }
    let mut diagnostics = scene.diagnostics.clone();
    let result = paint_item(
        canvas,
        scene,
        index,
        resources,
        &mut diagnostics,
        &BTreeMap::new(),
        None,
        0,
        None,
        (!poses.is_empty()).then_some(poses),
    );
    canvas.restore_to_count(saved);
    result.map(|()| diagnostics)
}

fn skia_matrix(affine: Affine) -> Matrix {
    let [a, b, c, d, x, y] = affine.0.map(|value| value as f32);
    Matrix::new_all(a, c, x, b, d, y, 0., 0., 1.)
}

/// Paints with the scene's working channels on an untagged canvas so a proof shader
/// can inspect the composited Display P3 samples before gamut conversion.
pub fn paint_scene_proof_source(
    canvas: &Canvas,
    scene: &Scene,
    resources: &dyn ResourceProvider,
    translations: &BTreeMap<String, (f64, f64)>,
    focused: Option<usize>,
) -> Result<Vec<Diagnostic>, RenderError> {
    resources::with_raster_profile(scene.color_profile, || match focused {
        Some(index) => paint_scene_layers(canvas, scene, &[index], resources),
        None => paint_scene_preview(canvas, scene, resources, translations),
    })
}

/// Non-authoritative gesture preview. Offscreen/export callers use paint_scene
/// without overrides, so editor overlays never change the committed output.
pub fn paint_scene_preview(
    canvas: &Canvas,
    scene: &Scene,
    resources: &dyn ResourceProvider,
    translations: &BTreeMap<String, (f64, f64)>,
) -> Result<Vec<Diagnostic>, RenderError> {
    paint_scene_editor(canvas, scene, resources, translations, None)
}

#[derive(Clone, Copy)]
pub struct SelectionOutline<'a> {
    pub ids: &'a BTreeSet<String>,
    pub color: skia_safe::Color,
    pub object_bounds: bool,
}

pub fn paint_scene_editor(
    canvas: &Canvas,
    scene: &Scene,
    resources: &dyn ResourceProvider,
    translations: &BTreeMap<String, (f64, f64)>,
    outline: Option<SelectionOutline<'_>>,
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
            None,
            0,
            outline,
            None,
        )?;
    }
    Ok(diagnostics)
}

/// Splits the painter's order into stationary and moving runs. The desktop
/// caches stationary runs independently so moving layers retain their z-order.
pub struct MovePaintPlan {
    spans: Vec<(usize, usize)>,
    moving: Vec<bool>,
}

impl MovePaintPlan {
    pub fn new(scene: &Scene, translations: &BTreeMap<String, (f64, f64)>) -> Option<Self> {
        if translations.is_empty() || scene.items.is_empty() {
            return None;
        }
        let mut plan = Self {
            spans: vec![(0, 0); scene.items.len()],
            moving: Vec::new(),
        };
        plan.assign(scene, scene.root, translations, false)?;
        plan.moving.contains(&true).then_some(plan)
    }

    fn assign(
        &mut self,
        scene: &Scene,
        index: usize,
        translations: &BTreeMap<String, (f64, f64)>,
        inherited_motion: bool,
    ) -> Option<()> {
        let item = &scene.items[index];
        if item.hidden {
            let current = self.moving.len().saturating_sub(1);
            self.spans[index] = (current, current);
            return Some(());
        }
        let moving = inherited_motion || translations.contains_key(&item.id);
        if self.moving.last() != Some(&moving) {
            // shortcut: unusually fragmented selections use the direct painter to bound retained layers.
            if self.moving.len() == 12 {
                return None;
            }
            self.moving.push(moving);
        }
        let first = self.moving.len() - 1;
        for &child in &item.children {
            self.assign(scene, child, translations, moving)?;
        }
        let last = self.moving.len() - 1;
        let uses_backdrop = |blend: &str| !matches!(blend, "normal" | "pass-through");
        if item
            .style
            .get("mix-blend-mode")
            .or_else(|| item.properties.get("blendMode").and_then(Value::as_str))
            .is_some_and(uses_backdrop)
            || ["fills", "strokes"].iter().any(|key| {
                item.properties
                    .get(*key)
                    .and_then(Value::as_array)
                    .is_some_and(|paints| {
                        paints.iter().any(|paint| {
                            paint
                                .get("blendMode")
                                .and_then(Value::as_str)
                                .is_some_and(uses_backdrop)
                        })
                    })
            })
        {
            return None;
        }
        if first != last
            && (item.style.number("opacity", 1.) < 1.
                || item
                    .style
                    .get("filter")
                    .is_some_and(|filter| filter != "none")
                || ["maskType", "maskMode", "mask", "isMaskGroup"]
                    .iter()
                    .any(|key| item.properties.contains_key(*key)))
        {
            return None;
        }
        self.spans[index] = (first, last);
        Some(())
    }

    pub fn passes(&self) -> impl Iterator<Item = (usize, bool)> + '_ {
        self.moving.iter().copied().enumerate()
    }

    pub fn paint(
        &self,
        pass: usize,
        canvas: &Canvas,
        scene: &Scene,
        resources: &dyn ResourceProvider,
        translations: &BTreeMap<String, (f64, f64)>,
    ) -> Result<(), RenderError> {
        paint_item(
            canvas,
            scene,
            scene.root,
            resources,
            &mut Vec::new(),
            translations,
            Some((self, pass)),
            0,
            None,
            None,
        )
    }
}

fn paint_item(
    canvas: &Canvas,
    scene: &Scene,
    index: usize,
    resources: &dyn ResourceProvider,
    diagnostics: &mut Vec<Diagnostic>,
    translations: &BTreeMap<String, (f64, f64)>,
    pass: Option<(&MovePaintPlan, usize)>,
    pattern_depth: usize,
    outline: Option<SelectionOutline<'_>>,
    poses: Option<&BTreeMap<String, Affine>>,
) -> Result<(), RenderError> {
    let item = &scene.items[index];
    if item.hidden
        || item.is_slice()
        || pattern_depth == 0 && item.properties.get("patternOnly") == Some(&Value::Bool(true))
    {
        return Ok(());
    }
    let own = match pass {
        Some((plan, pass)) => {
            let (first, last) = plan.spans[index];
            if !(first..=last).contains(&pass) {
                return Ok(());
            }
            first == pass
        }
        None => true,
    };
    let saved = canvas.save();
    let result = (|| {
        if let Some((x, y)) = translations.get(&item.id) {
            canvas.translate((*x as f32, *y as f32));
        }
        canvas.concat(&skia_matrix(
            poses
                .and_then(|poses| poses.get(&item.id))
                .copied()
                .unwrap_or(item.local),
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
        let shape = shape_path(item)?;
        let selected_outline = outline.filter(|outline| own && outline.ids.contains(&item.id));
        if own && selected_outline.is_none() {
            paints::backdrop(canvas, item, &shape);
        }
        let grouped = opacity < 1. || blend != BlendMode::SrcOver || layer.image_filter().is_some();
        if grouped {
            canvas.save_layer(&SaveLayerRec::default().paint(&layer));
        }
        if let Some(outline) = selected_outline {
            let mut paint = Paint::default();
            paint
                .set_color(outline.color)
                .set_style(Style::Stroke)
                .set_anti_alias(true);
            let glyphs = item.text_outline().ok();
            canvas.draw_path(glyphs.as_ref().unwrap_or(&shape), &paint);
            if outline.object_bounds
                && let Some(inverse) = item.world.inverse()
            {
                let [x, y, w, h] = item.bounds.map(|coordinate| coordinate as f32);
                let saved = canvas.save();
                canvas.concat(&skia_matrix(inverse));
                canvas.draw_rect(Rect::from_xywh(x, y, w, h), &paint);
                canvas.restore_to_count(saved);
            }
        } else if own {
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
            paints::shadows(canvas, scene, item, &shape, diagnostics, false)?;
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
                paints::stack(
                    canvas,
                    scene,
                    item,
                    &shape,
                    "fills",
                    diagnostics,
                    resources,
                    |paint, diagnostics| {
                        pattern::draw(
                            canvas,
                            scene,
                            item,
                            &shape,
                            paint,
                            resources,
                            diagnostics,
                            pattern_depth,
                        )
                    },
                )?
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
                let paint = item
                    .properties
                    .get("fills")
                    .and_then(Value::as_array)
                    .filter(|fills| fills.len() == 1)
                    .and_then(|fills| fills.first());
                let alpha = paint.map_or(1., |paint| {
                    if paint.get("hidden") == Some(&Value::Bool(true))
                        || paint.get("visible") == Some(&Value::Bool(false))
                    {
                        0.
                    } else {
                        paint
                            .get("opacity")
                            .and_then(Value::as_f64)
                            .unwrap_or(1.)
                            .clamp(0., 1.)
                    }
                });
                if alpha > 0. {
                    if alpha < 1. {
                        canvas.save_layer_alpha_f(None, alpha as f32);
                    }
                    let (x, y) = item.text_origin(text);
                    text.paint(canvas, x, y);
                    if alpha < 1. {
                        canvas.restore();
                    }
                }
            }
            let has_strokes = paints::stack(
                canvas,
                scene,
                item,
                &shape,
                "strokes",
                diagnostics,
                resources,
                |_, diagnostics| {
                    diagnose(
                        scene,
                        item,
                        "stroke.pattern",
                        "pattern strokes are not supported",
                        diagnostics,
                    )
                },
            )?;
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
                    paints::draw_authored_stroke(canvas, item, &shape, &mut paint);
                }
            }
            paints::shadows(canvas, scene, item, &shape, diagnostics, true)?;
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
                        paint_item(
                            canvas,
                            scene,
                            child,
                            resources,
                            diagnostics,
                            translations,
                            pass,
                            pattern_depth,
                            outline,
                            poses,
                        )?;
                    }
                    let mut mask_paint = Paint::default();
                    mask_paint.set_blend_mode(BlendMode::DstIn);
                    if mode == "luminance" {
                        mask_paint.set_color_filter(skia_safe::ColorFilter::luma());
                    }
                    canvas.save_layer(&SaveLayerRec::default().paint(&mask_paint));
                    paint_item(
                        canvas,
                        scene,
                        mask,
                        resources,
                        diagnostics,
                        translations,
                        pass,
                        pattern_depth,
                        None,
                        poses,
                    )?;
                    canvas.restore();
                    canvas.restore();
                }
                "vector" => {
                    let mut path = shape_path(&scene.items[mask])?;
                    let mask = &scene.items[mask];
                    let a = poses
                        .and_then(|poses| poses.get(&mask.id))
                        .copied()
                        .unwrap_or(mask.local)
                        .0;
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
                    if !mask.children.is_empty() {
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
                        paint_item(
                            canvas,
                            scene,
                            child,
                            resources,
                            diagnostics,
                            translations,
                            pass,
                            pattern_depth,
                            outline,
                            poses,
                        )?;
                    }
                }
                other => {
                    diagnose(scene, item, "maskMode", other, diagnostics)?;
                    for child in &item.children {
                        paint_item(
                            canvas,
                            scene,
                            *child,
                            resources,
                            diagnostics,
                            translations,
                            pass,
                            pattern_depth,
                            outline,
                            poses,
                        )?;
                    }
                }
            }
        } else if mask_mode.is_none() && item.boolean_operation().is_none() {
            let mut children = item.children.as_slice();
            if let Some((plan, pass)) = pass {
                // Sibling spans follow painter order. Skip entire stationary subtrees on move.
                let first = children.partition_point(|child| plan.spans[*child].1 < pass);
                let last = children.partition_point(|child| plan.spans[*child].0 <= pass);
                children = &children[first..last];
            }
            for child in children {
                paint_item(
                    canvas,
                    scene,
                    *child,
                    resources,
                    diagnostics,
                    translations,
                    pass,
                    pattern_depth,
                    outline,
                    poses,
                )?;
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

pub fn shape_path_bounds(item: &SceneItem) -> Result<[f64; 4], RenderError> {
    let bounds = shape_path(item)?.compute_tight_bounds();
    Ok([
        bounds.left as f64,
        bounds.top as f64,
        bounds.width() as f64,
        bounds.height() as f64,
    ])
}

fn shape_path(item: &SceneItem) -> Result<Path, RenderError> {
    omc_scene::shape_path(item)
        .ok_or_else(|| RenderError::Unsupported(format!("invalid SVG path for {}", item.id)))
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
            let crop = item
                .properties
                .get("imageCrop")
                .and_then(|value| image_paint::crop_rect(value, item));
            if let Some([x, y, width, height]) = crop {
                dst = Rect::from_xywh(x as f32, y as f32, width as f32, height as f32);
            }
            match item
                .style
                .get("object-fit")
                .or_else(|| item.properties.get("imageFit").and_then(Value::as_str))
                .unwrap_or("cover")
            {
                "tile" if crop.is_some() => {
                    let mut paint = Paint::default();
                    paint.set_shader(image_paint::shader(
                        &serde_json::json!({"assetHash":hash,"mode":"crop","crop":item.properties["imageCrop"],"cropSampling":"repeat"}),
                        item,
                        resources,
                    )?);
                    if let Some(filters) = item.properties.get("imageFilters") {
                        image_paint::filters(&mut paint, filters);
                    }
                    canvas.draw_path(&shape_path(item)?, &paint);
                    return Ok(());
                }
                _ if crop.is_some() => (),
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
                "tile" => {
                    let mut paint = Paint::default();
                    paint.set_shader(image_paint::shader(
                        &serde_json::json!({"assetHash":hash,"mode":"tile"}),
                        item,
                        resources,
                    )?);
                    if let Some(filters) = item.properties.get("imageFilters") {
                        image_paint::filters(&mut paint, filters);
                    }
                    canvas.draw_path(&shape_path(item)?, &paint);
                    return Ok(());
                }
                "fill" => (),
                value => return Err(RenderError::Unsupported(format!("image fit {value}"))),
            }
            let mut paint = Paint::default();
            image_paint::filters(
                &mut paint,
                &item
                    .properties
                    .get("imageFilters")
                    .cloned()
                    .unwrap_or(Value::Null),
            );
            let saved = canvas.save();
            canvas.clip_path(&shape_path(item)?, None, true);
            canvas.draw_image_rect(
                &image,
                Some((&src, skia_safe::canvas::SrcRectConstraint::Strict)),
                dst,
                &paint,
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
    fn prototype_paints_only_the_requested_frame_and_clips_overflow() {
        let mut content = DocumentContent::empty("Prototype pixels");
        let root = content.pages[0].root_node_id.clone();
        let mut frame = Node::new(NodeKind::Frame);
        frame.parent_id = Some(root.clone());
        frame.properties.extend([
            ("x".into(), json!(8)),
            ("y".into(), json!(8)),
            ("width".into(), json!(24)),
            ("height".into(), json!(24)),
            ("fill".into(), json!("blue")),
        ]);
        let frame_id = frame.id.clone();
        content.nodes.insert(frame_id.clone(), frame);
        for (parent, x, fill) in [(&frame_id, 16, "red"), (&root, 28, "green")] {
            let mut node = Node::new(NodeKind::Rect);
            node.parent_id = Some(parent.clone());
            node.properties.extend([
                ("x".into(), json!(x)),
                ("y".into(), json!(8)),
                ("width".into(), json!(32)),
                ("height".into(), json!(24)),
                ("fill".into(), json!(fill)),
            ]);
            content.nodes.insert(node.id.clone(), node);
        }
        let snapshot = DocumentSnapshot {
            id: "test".into(),
            title: content.title,
            epoch: "test".into(),
            sequence: 1,
            pages: content.pages,
            nodes: content.nodes,
            metadata: content.metadata,
        };
        let scene = build_scene(&snapshot, &SceneOptions::default()).unwrap();
        let info = ImageInfo::new((64, 64), ColorType::RGBA8888, AlphaType::Premul, None);
        let mut surface = skia_safe::surfaces::raster(&info, None, None).unwrap();
        let canvas = surface.canvas();
        canvas.clear(skia_safe::Color::TRANSPARENT);
        paint_scene_frame(canvas, &scene, &frame_id, &EmptyResources).unwrap();
        let mut pixels = vec![0; 64 * 64 * 4];
        assert!(surface.read_pixels(&info, &mut pixels, 64 * 4, (0, 0)));
        let pixel = |x: usize| &pixels[(20 * 64 + x) * 4..(20 * 64 + x) * 4 + 4];
        assert_eq!(pixel(12), [0, 0, 255, 255]);
        assert_eq!(pixel(29), [255, 0, 0, 255]);
        assert_eq!(pixel(40), [0, 0, 0, 0]);
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
