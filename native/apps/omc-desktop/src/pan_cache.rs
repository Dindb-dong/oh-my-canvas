use crate::geometry::{Camera, Rect};
use omc_render::paint_scene_preview;
use omc_scene::Scene;
use skia_safe::{Canvas, Color, Image, Rect as SkRect, gpu, surfaces};
use std::{
    collections::BTreeMap,
    sync::{
        Arc,
        mpsc::{self, Receiver, SyncSender, TryRecvError},
    },
    thread,
};

const MAX_RASTER_BYTES: u64 = 24 * 1024 * 1024;
const MAX_MARGIN: i32 = 128;
const MAX_TEXTURE_SIDE: i32 = 16_384;
const MAX_TRANSLATION: f64 = 16_777_216.;

#[derive(Clone, Copy, PartialEq, Eq)]
struct ViewKey {
    generation: u64,
    viewport: [u64; 4],
    scale: u64,
    zoom: u64,
    background: Color,
}

#[derive(Clone, Copy)]
struct View {
    key: ViewKey,
    origin: (i32, i32),
    size: (i32, i32),
    pan: (i32, i32),
    margin: i32,
}

impl View {
    fn new(
        generation: u64,
        viewport: Rect,
        scale: f64,
        camera: Camera,
        background: Color,
    ) -> Option<Self> {
        if !scale.is_finite() || scale <= 0. || !camera.zoom.is_finite() || camera.zoom <= 0. {
            return None;
        }
        let zoom = camera.zoom * scale;
        if !(zoom as f32).is_finite() || zoom as f32 <= 0. {
            return None;
        }
        let logical = [viewport.x, viewport.y, viewport.width, viewport.height];
        if !logical.iter().all(|&value| (value as f32).is_finite())
            || viewport.width <= 0.
            || viewport.height <= 0.
        {
            return None;
        }
        let [x, y, w, h] = logical.map(|value| value as f32);
        let rect = SkRect::from_xywh(x, y, w, h);
        let scale32 = scale as f32;
        let edges =
            [rect.left, rect.top, rect.right, rect.bottom].map(|edge| f64::from(edge * scale32));
        if !edges
            .iter()
            .all(|edge| (0. ..=MAX_TRANSLATION).contains(edge))
        {
            return None;
        }
        let (left, top) = (edges[0].floor() as i32, edges[1].floor() as i32);
        let size = (edges[2].ceil() as i32 - left, edges[3].ceil() as i32 - top);
        if !within_budget(size, 0) {
            return None;
        }
        let pan = [camera.x * scale, camera.y * scale];
        if !pan
            .iter()
            .all(|value| (-MAX_TRANSLATION..=MAX_TRANSLATION).contains(value))
        {
            return None;
        }
        let margin = overscan_margin(size);
        Some(Self {
            key: ViewKey {
                generation,
                viewport: logical.map(f64::to_bits),
                scale: scale.to_bits(),
                zoom: camera.zoom.to_bits(),
                background,
            },
            origin: (left, top),
            size,
            pan: (pan[0].round() as i32, pan[1].round() as i32),
            margin,
        })
    }

    fn distance(self, other: Self) -> i32 {
        let (dx, dy) = self.shift(other);
        dx.abs().max(dy.abs())
    }

    fn shift(self, other: Self) -> (i32, i32) {
        (self.pan.0 - other.pan.0, self.pan.1 - other.pan.1)
    }

    // Adapted from FigCraft v0.17.0's cached_render_covers. Snapped device pixels
    // and a symmetric margin reduce the two bounds checks to a distance test.
    fn cached_render_covers(self, cached: Self) -> bool {
        let guard = (cached.margin / 2).min(96);
        self.key == cached.key && self.distance(cached) <= cached.margin - guard
    }

    fn blit_origin(self, cached: Self) -> Option<(f32, f32)> {
        if self.key != cached.key {
            return None;
        }
        let (dx, dy) = self.shift(cached);
        if dx.abs() >= self.size.0 + cached.margin || dy.abs() >= self.size.1 + cached.margin {
            return None;
        }
        Some((
            (self.origin.0 + dx - cached.margin) as f32,
            (self.origin.1 + dy - cached.margin) as f32,
        ))
    }
}

// Adapted from FigCraft v0.17.0's overscan_margin with OMC's tighter byte budget.
fn overscan_margin(size: (i32, i32)) -> i32 {
    let (width, height) = size;
    let mut margin = (width.min(height) / 8)
        .min(MAX_MARGIN)
        .min((MAX_TEXTURE_SIDE - width.max(height)).max(0) / 2);
    while margin > 0 && !within_budget(size, margin) {
        margin /= 2;
    }
    margin
}

fn within_budget((width, height): (i32, i32), margin: i32) -> bool {
    width > 0
        && height > 0
        && width + 2 * margin <= MAX_TEXTURE_SIDE
        && height + 2 * margin <= MAX_TEXTURE_SIDE
        && (width as u64 + 2 * margin as u64) * (height as u64 + 2 * margin as u64)
            <= MAX_RASTER_BYTES / 4
}

struct Job {
    epoch: u64,
    view: View,
    scene: Arc<Scene>,
    resources: Arc<BTreeMap<String, Vec<u8>>>,
}

fn render(job: &Job) -> Option<Image> {
    let view = job.view;
    let (width, height) = view.size;
    let margin = view.margin;
    let mut surface = surfaces::raster_n32_premul((width + margin * 2, height + margin * 2))?;
    let canvas = surface.canvas();
    canvas.clear(view.key.background);
    let scale = f64::from_bits(view.key.scale) as f32;
    let zoom = f64::from_bits(view.key.zoom) as f32;
    let x = f64::from_bits(view.key.viewport[0]) as f32 * scale - view.origin.0 as f32;
    let y = f64::from_bits(view.key.viewport[1]) as f32 * scale - view.origin.1 as f32;
    canvas.translate((
        (margin + view.pan.0) as f32 + x,
        (margin + view.pan.1) as f32 + y,
    ));
    canvas.scale((scale * zoom, scale * zoom));
    paint_scene_preview(canvas, &job.scene, job.resources.as_ref(), &BTreeMap::new()).ok()?;
    Some(surface.image_snapshot())
}

struct Finished {
    epoch: u64,
    view: View,
    image: Option<Image>,
}

pub struct PanCache {
    submit: SyncSender<Job>,
    receive: Receiver<Finished>,
    pending: bool,
    epoch: u64,
    cached: Option<(View, Image)>,
    failed: Option<ViewKey>,
}

impl PanCache {
    pub fn new(wake: impl Fn() + Send + 'static) -> Self {
        let (submit, jobs) = mpsc::sync_channel::<Job>(1);
        let (complete, receive) = mpsc::sync_channel(1);
        let _ = thread::Builder::new()
            .name("canvas-pan-raster".into())
            .spawn(move || {
                while let Ok(job) = jobs.recv() {
                    let image = render(&job);
                    if complete
                        .send(Finished {
                            epoch: job.epoch,
                            view: job.view,
                            image,
                        })
                        .is_err()
                    {
                        break;
                    }
                    wake();
                }
            });
        Self {
            submit,
            receive,
            pending: false,
            epoch: 0,
            cached: None,
            failed: None,
        }
    }

    pub fn clear(&mut self) {
        self.epoch = self.epoch.wrapping_add(1);
        self.cached = None;
        self.failed = None;
    }

    /// Destination is already clipped to the workspace. Prewarming submits work without blitting.
    #[allow(clippy::too_many_arguments)]
    pub fn paint(
        &mut self,
        canvas: &Canvas,
        generation: u64,
        viewport: Rect,
        scale: f64,
        camera: Camera,
        scene: &Arc<Scene>,
        resources: &Arc<BTreeMap<String, Vec<u8>>>,
        background: Color,
        show: bool,
    ) -> bool {
        let Some(view) = View::new(generation, viewport, scale, camera, background) else {
            self.cached = None;
            return false;
        };
        if self
            .cached
            .as_ref()
            .is_some_and(|(old, _)| old.key != view.key)
        {
            self.cached = None;
        }
        match self.receive.try_recv() {
            Ok(finished) => {
                self.pending = false;
                if finished.epoch == self.epoch && finished.view.key == view.key {
                    if let Some(image) = finished.image {
                        if self.cached.as_ref().is_none_or(|(old, _)| {
                            view.distance(finished.view) <= view.distance(*old)
                        }) {
                            let texture = canvas.direct_context().and_then(|mut context| {
                                gpu::images::texture_from_image(
                                    &mut context,
                                    &image,
                                    gpu::Mipmapped::No,
                                    gpu::Budgeted::Yes,
                                )
                            });
                            self.cached = Some((finished.view, texture.unwrap_or(image)));
                        }
                    } else {
                        self.failed = Some(view.key);
                    }
                }
            }
            Err(TryRecvError::Disconnected) => {
                self.pending = false;
                self.failed = Some(view.key);
            }
            Err(TryRecvError::Empty) => {}
        }
        if !self.pending
            && self.failed != Some(view.key)
            && self
                .cached
                .as_ref()
                .is_none_or(|(old, _)| !view.cached_render_covers(*old))
        {
            self.pending = self
                .submit
                .try_send(Job {
                    epoch: self.epoch,
                    view,
                    scene: Arc::clone(scene),
                    resources: Arc::clone(resources),
                })
                .is_ok();
        }
        if show
            && let Some((old, image)) = &self.cached
            && let Some(origin) = view.blit_origin(*old)
        {
            let saved = canvas.save();
            canvas.reset_matrix();
            canvas.draw_image(image, origin, None);
            canvas.restore_to_count(saved);
            return true;
        }
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use omc_model::{DocumentContent, DocumentSnapshot, Node, NodeKind};
    use omc_scene::{SceneOptions, build_scene};
    use serde_json::json;
    use skia_safe::{AlphaType, ColorType, ImageInfo};
    use std::time::Duration;

    const VIEWPORT: Rect = Rect {
        x: 20.,
        y: 10.,
        width: 120.,
        height: 80.,
    };
    const CAMERA: Camera = Camera {
        x: 0.,
        y: 0.,
        zoom: 1.,
    };

    #[test]
    fn pan_reuses_only_matching_pixels_and_caps_overscan() {
        let initial = View::new(1, VIEWPORT, 2., CAMERA, Color::WHITE).unwrap();
        let view = |generation, scale, camera| {
            View::new(generation, VIEWPORT, scale, camera, Color::WHITE).unwrap()
        };
        assert_eq!(initial.margin, 20);
        assert_eq!(
            view(
                1,
                2.,
                Camera {
                    x: 7.3,
                    y: -4.,
                    ..CAMERA
                }
            )
            .blit_origin(initial),
            Some((35., -8.))
        );
        assert_eq!(view(2, 2., CAMERA).blit_origin(initial), None);
        assert_eq!(view(1, 1., CAMERA).blit_origin(initial), None);
        assert_eq!(
            view(1, 2., Camera { zoom: 2., ..CAMERA }).blit_origin(initial),
            None
        );
        assert_eq!(
            view(1, 2., Camera { x: 140., ..CAMERA }).blit_origin(initial),
            None
        );
        let compact_margin =
            View::new(1, Rect::new(0., 0., 2800., 2100.), 1., CAMERA, Color::WHITE).unwrap();
        assert!(compact_margin.margin < MAX_MARGIN);
        assert!(within_budget(compact_margin.size, compact_margin.margin));
        assert!(View::new(1, Rect::new(0., 0., 3500., 2200.), 1., CAMERA, Color::WHITE,).is_none());
        assert!(View::new(1, VIEWPORT, f64::NAN, CAMERA, Color::WHITE).is_none());
    }

    #[test]
    fn pan_refills_before_the_retained_texture_edge() {
        let viewport = Rect::new(0., 0., 1000., 800.);
        let view =
            |x, y| View::new(1, viewport, 1., Camera { x, y, ..CAMERA }, Color::WHITE).unwrap();
        let initial = view(0., 0.);
        assert_eq!(initial.margin, 100);
        for (x, y) in [(50., 0.), (0., -50.)] {
            assert!(view(x, y).cached_render_covers(initial));
        }
        for (x, y) in [(51., 0.), (0., -51.)] {
            assert!(!view(x, y).cached_render_covers(initial));
            assert!(view(x, y).blit_origin(initial).is_some());
        }
        let slender = (390, 844);
        let margin = overscan_margin(slender);
        let retained = (slender.0 + margin * 2) * (slender.1 + margin * 2);
        assert!(retained * 5 <= slender.0 * slender.1 * 8);
        assert_eq!(overscan_margin((MAX_TEXTURE_SIDE - 16, 256)), 8);
        assert!(!within_budget((MAX_TEXTURE_SIDE + 1, 1), 0));
    }

    #[test]
    fn background_result_shifts_scene_only_and_cannot_survive_clear() {
        let mut content = DocumentContent::empty("Pan preview");
        let mut rect = Node::new(NodeKind::Rect);
        rect.parent_id = Some(content.pages[0].root_node_id.clone());
        rect.properties.extend([
            ("x".into(), json!(8)),
            ("y".into(), json!(10)),
            ("width".into(), json!(12)),
            ("height".into(), json!(14)),
            ("fill".into(), json!("red")),
        ]);
        content.nodes.insert(rect.id.clone(), rect);
        let document = DocumentSnapshot {
            id: "pan-preview".into(),
            title: content.title,
            epoch: "pan-preview".into(),
            sequence: 0,
            pages: content.pages,
            nodes: content.nodes,
            metadata: content.metadata,
        };
        let scene = Arc::new(build_scene(&document, &SceneOptions::default()).unwrap());
        let resources = Arc::new(BTreeMap::new());
        let (wake, ready) = mpsc::channel();
        let mut cache = PanCache::new(move || {
            let _ = wake.send(());
        });
        let mut surface = surfaces::raster_n32_premul((160, 120)).unwrap();
        let canvas = surface.canvas();
        canvas.clear(Color::WHITE);
        canvas.clip_rect(SkRect::from_xywh(20., 10., 120., 80.), None, Some(false));
        let paint = |cache: &mut PanCache, generation, camera, show| {
            cache.paint(
                canvas,
                generation,
                VIEWPORT,
                1.,
                camera,
                &scene,
                &resources,
                Color::WHITE,
                show,
            )
        };
        assert!(!paint(&mut cache, 1, CAMERA, false));
        ready.recv_timeout(Duration::from_secs(5)).unwrap();
        let shifted = Camera {
            x: 5.,
            y: 3.,
            ..CAMERA
        };
        assert!(paint(&mut cache, 1, shifted, true));
        let info = ImageInfo::new((1, 1), ColorType::RGBA8888, AlphaType::Premul, None);
        let mut pixel = [0; 4];
        assert!(canvas.read_pixels(&info, &mut pixel, 4, (35, 25)));
        assert_eq!(pixel, [255, 0, 0, 255]);
        assert!(!paint(&mut cache, 2, CAMERA, true));
        ready.recv_timeout(Duration::from_secs(5)).unwrap();
        cache.clear();
        assert!(!paint(&mut cache, 2, CAMERA, true));
    }
}
