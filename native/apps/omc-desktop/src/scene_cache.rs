use crate::geometry::{Camera, Rect};
use skia_safe::{Bitmap, Canvas, Color, Image, ImageInfo, Rect as SkRect, Surface, images};

const MAX_RETAINED_BYTES: u64 = 32 * 1024 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SceneCacheKey {
    generation: u64,
    viewport: [u64; 4],
    scale: u64,
    camera: [u64; 3],
    origin: (i32, i32),
    size: (i32, i32),
}

impl SceneCacheKey {
    pub fn new(generation: u64, viewport: Rect, scale: f64, camera: Camera) -> Option<Self> {
        let viewport = [viewport.x, viewport.y, viewport.width, viewport.height];
        let camera = [camera.x, camera.y, camera.zoom];
        if scale <= 0.
            || camera[2] <= 0.
            || ![scale]
                .into_iter()
                .chain(viewport)
                .chain(camera)
                .all(|value| (value as f32).is_finite())
        {
            return None;
        }
        let [x, y, w, h] = viewport.map(|value| value as f32);
        let bounds = SkRect::from_xywh(x, y, w, h);
        // Keep the direct painter for viewports whose physical boundaries need subpixel clipping.
        let physical =
            [bounds.left, bounds.top, bounds.right, bounds.bottom].map(|edge| edge * scale as f32);
        if physical.iter().any(|&edge| {
            !edge.is_finite() || edge.fract() != 0. || !(0. ..i32::MAX as f32).contains(&edge)
        }) {
            return None;
        }
        let [left, top, right, bottom] = physical.map(|edge| edge as i32);
        let size = (right - left, bottom - top);
        if size.0 <= 0
            || size.1 <= 0
            || u64::try_from(size.0).ok()? * u64::try_from(size.1).ok()? > MAX_RETAINED_BYTES / 4
        {
            return None;
        }
        Some(Self {
            generation,
            viewport: viewport.map(f64::to_bits),
            scale: scale.to_bits(),
            camera: camera.map(f64::to_bits),
            origin: (left, top),
            size,
        })
    }
}

pub(crate) fn matching_surface(canvas: &Canvas, width: i32, height: i32) -> Option<Surface> {
    let info = ImageInfo::new_n32_premul((width, height), None);
    if canvas.recording_context().is_some() {
        canvas.new_surface(&info, None)
    } else {
        skia_safe::surfaces::raster_n32_premul((width, height))
    }
}

#[derive(Default)]
pub struct SceneCache {
    entry: Option<(SceneCacheKey, Color, Image)>,
}

impl SceneCache {
    pub fn clear(&mut self) {
        self.entry = None;
    }

    /// Shift the last exact frame while the first overscan render is still in flight.
    pub fn pan_preview(&self, canvas: &Canvas, key: SceneCacheKey, background: Color) -> bool {
        let Some((old, color, image)) = &self.entry else {
            return false;
        };
        if old.generation != key.generation
            || old.viewport != key.viewport
            || old.scale != key.scale
            || old.camera[2] != key.camera[2]
            || *color != background
        {
            return false;
        }
        let scale = f64::from_bits(key.scale);
        let dx = ((f64::from_bits(key.camera[0]) - f64::from_bits(old.camera[0])) * scale).round();
        let dy = ((f64::from_bits(key.camera[1]) - f64::from_bits(old.camera[1])) * scale).round();
        if dx.abs() >= f64::from(key.size.0) || dy.abs() >= f64::from(key.size.1) {
            return false;
        }
        let saved = canvas.save();
        canvas.reset_matrix();
        canvas.draw_image(
            image,
            (
                (f64::from(key.origin.0) + dx) as f32,
                (f64::from(key.origin.1) + dy) as f32,
            ),
            None,
        );
        canvas.restore_to_count(saved);
        true
    }

    /// The destination is device-scaled and clipped to the freshly painted workspace.
    /// Paint selection and other live overlays only after this call.
    /// The document painter receives the same world transform as the direct path.
    /// A successful paint remains visible if copying the pixels for reuse fails.
    pub fn paint<E>(
        &mut self,
        canvas: &Canvas,
        key: SceneCacheKey,
        background: Color,
        draw: impl FnOnce(&Canvas) -> Result<(), E>,
    ) -> Result<(), E> {
        if let Some((_, _, image)) = self
            .entry
            .as_ref()
            .filter(|(old_key, color, _)| *old_key == key && *color == background)
        {
            let saved = canvas.save();
            canvas.reset_matrix();
            canvas.draw_image(image, (key.origin.0 as f32, key.origin.1 as f32), None);
            canvas.restore_to_count(saved);
            return Ok(());
        }

        self.clear();
        let [x, y, _, _] = key.viewport.map(|bits| f64::from_bits(bits) as f32);
        let [camera_x, camera_y, zoom] = key.camera.map(|bits| f64::from_bits(bits) as f32);
        let gpu = canvas.recording_context().is_some();
        if gpu && let Some(mut surface) = matching_surface(canvas, key.size.0, key.size.1) {
            let retained = surface.canvas();
            retained.clear(background);
            let scale = f64::from_bits(key.scale) as f32;
            retained.scale((scale, scale));
            retained.translate((camera_x, camera_y));
            retained.scale((zoom, zoom));
            draw(retained)?;
            let image = surface.image_snapshot();
            debug_assert!(image.is_texture_backed());
            let saved = canvas.save();
            canvas.reset_matrix();
            canvas.draw_image(&image, (key.origin.0 as f32, key.origin.1 as f32), None);
            canvas.restore_to_count(saved);
            self.entry = Some((key, background, image));
            return Ok(());
        }
        let saved = canvas.save();
        canvas.translate((x, y));
        canvas.translate((camera_x, camera_y));
        canvas.scale((zoom, zoom));
        let result = draw(canvas);
        canvas.restore_to_count(saved);
        if !gpu && result.is_ok() {
            let info = canvas.image_info();
            if key.origin.0 + key.size.0 <= info.width()
                && key.origin.1 + key.size.1 <= info.height()
            {
                // Copy the directly painted pixels so antialiasing keeps its original device origin.
                let mut bitmap = Bitmap::new();
                let info = ImageInfo::new_n32_premul(key.size, None);
                if bitmap.try_alloc_pixels_info(&info, None)
                    && canvas.read_pixels_to_bitmap(&mut bitmap, key.origin)
                {
                    bitmap.set_immutable();
                    self.entry =
                        images::raster_from_bitmap(&bitmap).map(|image| (key, background, image));
                }
            }
        }
        result
    }

    #[cfg(all(test, target_os = "macos"))]
    pub(crate) fn is_texture_backed(&self) -> bool {
        self.entry
            .as_ref()
            .is_some_and(|(_, _, image)| image.is_texture_backed())
    }

    #[cfg(test)]
    fn retained_bytes(&self) -> u64 {
        self.entry.as_ref().map_or(0, |(_, _, image)| {
            image.width() as u64 * image.height() as u64 * 4
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use omc_model::{DocumentContent, DocumentSnapshot, Node, NodeKind};
    use omc_render::{EmptyResources, paint_scene};
    use omc_scene::{Scene, SceneOptions, build_scene};
    use serde_json::json;
    use skia_safe::{AlphaType, ColorType, Paint, Surface, surfaces};
    use std::{cell::Cell, time::Instant};

    const VIEWPORT: Rect = Rect {
        x: 29.,
        y: 17.,
        width: 320.,
        height: 210.,
    };
    const CAMERA: Camera = Camera {
        x: 15.75,
        y: -11.25,
        zoom: 1.15,
    };
    const BACKGROUND: Color = Color::from_rgb(245, 245, 245);

    fn scene(count: usize) -> Scene {
        let mut content = DocumentContent::empty("Retained canvas");
        let root = content.pages[0].root_node_id.clone();
        let mut group = Node::new(NodeKind::Group);
        group.parent_id = Some(root);
        group.properties.extend([
            ("x".into(), json!(2.25)),
            ("y".into(), json!(16)),
            ("width".into(), json!(250)),
            ("height".into(), json!(150)),
            ("opacity".into(), json!(0.85)),
            ("blendMode".into(), json!("multiply")),
        ]);
        let parent = group.id.clone();
        content.nodes.insert(parent.clone(), group);
        for i in 0..count {
            let kind = match i {
                0 => NodeKind::Text,
                i if i % 2 == 0 => NodeKind::Rect,
                _ => NodeKind::Ellipse,
            };
            let mut node = Node::new(kind);
            node.parent_id = Some(parent.clone());
            node.rank = format!("{:032x}", i + 1);
            node.properties.extend([
                ("x".into(), json!(i % 12 * 18)),
                ("y".into(), json!(i / 12 % 10 * 14)),
                ("width".into(), json!(if i == 0 { 120 } else { 22 })),
                ("height".into(), json!(21)),
                (
                    "fill".into(),
                    json!(if i % 2 == 0 { "#3266ad" } else { "#efbd51" }),
                ),
                ("opacity".into(), json!(0.72)),
            ]);
            if i == 0 {
                node.properties.insert("text".into(), json!("한글 Canvas"));
                node.properties.insert("fontSize".into(), json!(16));
            }
            content.nodes.insert(node.id.clone(), node);
        }
        let document = DocumentSnapshot {
            id: "cache-document".into(),
            title: content.title,
            epoch: "cache-epoch".into(),
            sequence: 1,
            pages: content.pages,
            nodes: content.nodes,
            metadata: content.metadata,
        };
        let scene = build_scene(
            &document,
            &SceneOptions {
                width: VIEWPORT.width,
                height: VIEWPORT.height,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(scene.items.len(), count + 2);
        assert!(scene.items.iter().any(|item| item.text.is_some()));
        scene
    }

    fn frame(
        scene: &Scene,
        cache: Option<&mut SceneCache>,
        scale: f64,
        overlay_x: f32,
        scene_paints: &Cell<usize>,
    ) -> Surface {
        let size = ((360. * scale) as i32, (240. * scale) as i32);
        let mut surface = surfaces::raster_n32_premul(size).unwrap();
        let canvas = surface.canvas();
        canvas.clear(Color::WHITE);
        canvas.scale((scale as f32, scale as f32));
        let viewport = SkRect::from_xywh(
            VIEWPORT.x as f32,
            VIEWPORT.y as f32,
            VIEWPORT.width as f32,
            VIEWPORT.height as f32,
        );
        let mut paint = Paint::default();
        paint.set_color(BACKGROUND);
        canvas.draw_rect(viewport, &paint);
        let saved = canvas.save();
        canvas.clip_rect(viewport, None, Some(false));
        let draw = |canvas: &Canvas| {
            scene_paints.set(scene_paints.get() + 1);
            paint_scene(canvas, scene, &EmptyResources).map(|_| ())
        };
        if let Some(cache) = cache {
            let key = SceneCacheKey::new(1, VIEWPORT, scale, CAMERA).unwrap();
            cache.paint(canvas, key, BACKGROUND, draw).unwrap();
        } else {
            canvas.translate((VIEWPORT.x as f32, VIEWPORT.y as f32));
            canvas.translate((CAMERA.x as f32, CAMERA.y as f32));
            canvas.scale((CAMERA.zoom as f32, CAMERA.zoom as f32));
            draw(canvas).unwrap();
        }
        canvas.restore_to_count(saved);
        paint.set_color(Color::BLUE);
        canvas.draw_rect(SkRect::from_xywh(overlay_x, 37., 4., 21.), &paint);
        surface
    }

    fn rgba(surface: &mut Surface) -> Vec<u8> {
        let (w, h) = (surface.width(), surface.height());
        let info = ImageInfo::new((w, h), ColorType::RGBA8888, AlphaType::Premul, None);
        let mut pixels = vec![0; w as usize * h as usize * 4];
        assert!(surface.read_pixels(&info, &mut pixels, w as usize * 4, (0, 0)));
        pixels
    }

    #[test]
    fn retained_scene_matches_direct_pixels_and_repaints_overlay_at_each_scale() {
        let scene = scene(56);
        for scale in [1., 2.] {
            let count = Cell::new(0);
            let mut cache = SceneCache::default();
            let direct = rgba(&mut frame(&scene, None, scale, 53., &count));
            let cold = rgba(&mut frame(&scene, Some(&mut cache), scale, 53., &count));
            assert!(direct == cold, "cold cache pixel mismatch at scale {scale}");
            let current = rgba(&mut frame(&scene, Some(&mut cache), scale, 79., &count));
            assert!(cold != current, "overlay must update on a cache hit");
            assert_eq!(count.get(), 2, "hit must skip document painting");
            let direct = rgba(&mut frame(&scene, None, scale, 79., &count));
            assert!(
                direct == current,
                "warm cache pixel mismatch at scale {scale}"
            );
            assert_eq!(
                cache.retained_bytes(),
                (VIEWPORT.width * VIEWPORT.height * scale * scale) as u64 * 4
            );
        }
    }

    #[test]
    fn first_pan_reuses_only_a_matching_visible_frame() {
        let mut cache = SceneCache::default();
        let count = Cell::new(0);
        let scene = scene(1);
        let mut surface = frame(&scene, Some(&mut cache), 2., 53., &count);
        let canvas = surface.canvas();
        canvas.save();
        canvas.scale((2., 2.));
        canvas.clip_rect(SkRect::from_xywh(29., 17., 320., 210.), None, Some(false));
        let shifted = Camera {
            x: CAMERA.x + 32.,
            ..CAMERA
        };
        let key =
            |generation, camera| SceneCacheKey::new(generation, VIEWPORT, 2., camera).unwrap();
        assert!(cache.pan_preview(canvas, key(1, shifted), BACKGROUND));
        assert!(!cache.pan_preview(canvas, key(2, shifted), BACKGROUND));
        assert!(!cache.pan_preview(
            canvas,
            key(
                1,
                Camera {
                    zoom: 2.,
                    ..shifted
                }
            ),
            BACKGROUND
        ));
        assert!(!cache.pan_preview(canvas, key(1, Camera { x: 400., ..shifted }), BACKGROUND));
        assert_eq!(count.get(), 1);
        canvas.restore();
    }

    #[test]
    fn exact_key_covers_scene_viewport_camera_and_scale() {
        let key = |generation, viewport, scale, camera| {
            SceneCacheKey::new(generation, viewport, scale, camera).unwrap()
        };
        let original = key(1, VIEWPORT, 1., CAMERA);
        assert_ne!(original, key(2, VIEWPORT, 1., CAMERA));
        assert_ne!(original, key(1, VIEWPORT, 2., CAMERA));
        assert_ne!(
            original,
            key(
                1,
                Rect {
                    width: 310.,
                    ..VIEWPORT
                },
                1.,
                CAMERA
            )
        );
        assert_ne!(original, key(1, Rect { y: 18., ..VIEWPORT }, 1., CAMERA));
        assert_ne!(original, key(1, VIEWPORT, 1., Camera { x: 16., ..CAMERA }));
        assert_ne!(original, key(1, VIEWPORT, 1., Camera { y: -11., ..CAMERA }));
        assert_ne!(
            original,
            key(1, VIEWPORT, 1., Camera { zoom: 1., ..CAMERA })
        );
        for rect in [
            Rect {
                width: 0.,
                ..VIEWPORT
            },
            Rect {
                x: 29.25,
                ..VIEWPORT
            },
            Rect {
                width: 1e10,
                ..VIEWPORT
            },
            Rect {
                width: 4096.,
                height: 4096.,
                ..VIEWPORT
            },
        ] {
            assert!(SceneCacheKey::new(1, rect, 1., CAMERA).is_none());
        }
    }

    #[test]
    fn failed_draw_drops_the_previous_entry_and_leaves_no_partial_hit() {
        let mut surface = surfaces::raster_n32_premul((360, 240)).unwrap();
        let canvas = surface.canvas();
        let mut cache = SceneCache::default();
        let first = SceneCacheKey::new(1, VIEWPORT, 1., CAMERA).unwrap();
        let next = SceneCacheKey::new(2, VIEWPORT, 1., CAMERA).unwrap();
        assert_eq!(
            cache.paint(canvas, first, BACKGROUND, |_| Ok::<_, ()>(())),
            Ok(())
        );
        assert!(cache.retained_bytes() > 0);
        assert_eq!(
            cache.paint(canvas, next, BACKGROUND, |_| Err("render failed")),
            Err("render failed")
        );
        assert_eq!(cache.retained_bytes(), 0);
        let mut repainted = false;
        cache
            .paint(canvas, next, BACKGROUND, |_| {
                repainted = true;
                Ok::<_, ()>(())
            })
            .unwrap();
        assert!(repainted);
        cache.clear();
        assert_eq!(cache.retained_bytes(), 0);
    }

    #[test]
    fn uncapturable_viewport_keeps_the_direct_paint_and_retries_next_frame() {
        let mut surface = surfaces::raster_n32_premul((80, 60)).unwrap();
        let canvas = surface.canvas();
        let mut cache = SceneCache::default();
        let key = SceneCacheKey::new(1, VIEWPORT, 1., CAMERA).unwrap();
        let paints = Cell::new(0);
        for _ in 0..2 {
            assert_eq!(
                cache.paint(canvas, key, BACKGROUND, |_| {
                    paints.set(paints.get() + 1);
                    Ok::<_, ()>(())
                }),
                Ok(())
            );
        }
        assert_eq!(paints.get(), 2);
        assert_eq!(cache.retained_bytes(), 0);
    }

    #[test]
    #[ignore = "explicit panning viewport measurement"]
    fn measure_pan_redraw() {
        use crate::pan_cache::PanCache;
        use std::{
            collections::BTreeMap,
            sync::{Arc, mpsc},
            time::Duration,
        };

        let scene = Arc::new(scene(640));
        let resources = Arc::new(BTreeMap::new());
        let (wake, ready) = mpsc::channel();
        let mut pan = PanCache::new(move || {
            let _ = wake.send(());
        });
        let mut surface = surfaces::raster_n32_premul((720, 480)).unwrap();
        let canvas = surface.canvas();
        canvas.scale((2., 2.));
        canvas.clip_rect(SkRect::from_xywh(29., 17., 320., 210.), None, Some(false));
        let cold = Instant::now();
        assert!(!pan.paint(
            canvas, 1, VIEWPORT, 2., CAMERA, &scene, &resources, BACKGROUND, false
        ));
        ready.recv_timeout(Duration::from_secs(5)).unwrap();
        eprintln!(
            "initial overscan ready: {:.3} ms",
            cold.elapsed().as_secs_f64() * 1e3
        );
        for use_preview in [false, true] {
            let mut samples = [0.; 30];
            let mut paints = 0;
            for (step, sample) in samples.iter_mut().enumerate() {
                let camera = Camera {
                    x: CAMERA.x + step as f64 * 6.,
                    ..CAMERA
                };
                let start = Instant::now();
                canvas.clear(BACKGROUND);
                if !use_preview
                    || !pan.paint(
                        canvas, 1, VIEWPORT, 2., camera, &scene, &resources, BACKGROUND, true,
                    )
                {
                    paints += 1;
                    let saved = canvas.save();
                    canvas.translate((VIEWPORT.x as f32, VIEWPORT.y as f32));
                    canvas.translate((camera.x as f32, camera.y as f32));
                    canvas.scale((camera.zoom as f32, camera.zoom as f32));
                    paint_scene(canvas, &scene, resources.as_ref()).unwrap();
                    canvas.restore_to_count(saved);
                }
                *sample = start.elapsed().as_secs_f64() * 1e3;
                if use_preview {
                    std::thread::sleep(Duration::from_millis(16));
                }
            }
            samples.sort_by(f64::total_cmp);
            eprintln!(
                "{}: median {:.3} ms, p95 {:.3} ms, {paints} synchronous scene paints over 30 frames",
                if use_preview {
                    "pan preview"
                } else {
                    "direct pan"
                },
                (samples[14] + samples[15]) / 2.,
                samples[28]
            );
            assert_eq!(paints, if use_preview { 0 } else { 30 });
        }
    }

    #[test]
    #[ignore = "explicit stationary viewport measurement"]
    fn measure_stationary_viewport() {
        let scene = scene(640);
        let paints = Cell::new(0);
        let mut cache = SceneCache::default();
        let scale = 2.;
        for _ in 0..5 {
            std::hint::black_box(frame(&scene, None, scale, 50., &paints));
        }
        let start = Instant::now();
        std::hint::black_box(frame(&scene, Some(&mut cache), scale, 50., &paints));
        eprintln!(
            "cold retained: {:.3} ms",
            start.elapsed().as_secs_f64() * 1e3
        );
        for mode in ["direct", "retained"] {
            paints.set(0);
            let mut samples = Vec::with_capacity(30);
            for i in 0..30 {
                let start = Instant::now();
                let retained = (mode == "retained").then_some(&mut cache);
                std::hint::black_box(frame(&scene, retained, scale, 50. + i as f32, &paints));
                samples.push(start.elapsed().as_secs_f64() * 1e3);
            }
            samples.sort_by(f64::total_cmp);
            eprintln!(
                "{mode}: 30 draws, median {:.3} ms, p95 {:.3} ms, {} scene paints, {} retained bytes",
                (samples[14] + samples[15]) / 2.,
                samples[28],
                paints.get(),
                if mode == "retained" {
                    cache.retained_bytes()
                } else {
                    0
                },
            );
            assert_eq!(paints.get(), if mode == "retained" { 0 } else { 30 });
        }
    }
}
