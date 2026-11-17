use objc2::{
    MainThreadMarker,
    rc::{Retained, autoreleasepool},
    runtime::ProtocolObject,
};
use objc2_app_kit::NSView;
use objc2_core_foundation::{CGRect, CGSize};
use objc2_metal::{
    MTLCommandBuffer, MTLCommandQueue, MTLCreateSystemDefaultDevice, MTLDevice, MTLDrawable,
    MTLPixelFormat,
};
use objc2_quartz_core::{CAMetalDrawable, CAMetalLayer, CATransaction};
use skia_safe::{Canvas, ColorType, gpu};
use std::{
    sync::mpsc,
    thread,
    time::{Duration, Instant},
};
use winit::{
    dpi::PhysicalSize,
    raw_window_handle::{HasWindowHandle, RawWindowHandle},
    window::Window,
};

type Drawable = Retained<ProtocolObject<dyn CAMetalDrawable>>;

struct DrawableSource(Retained<CAMetalLayer>);

// Apple's custom Metal view calls nextDrawable on a render thread. Layer geometry
// stays on the main thread and only changes between requests.
unsafe impl Send for DrawableSource {}

impl DrawableSource {
    fn acquire(&self, trace: bool) -> Option<ReadyDrawable> {
        autoreleasepool(|_| {
            let start = trace.then(Instant::now);
            self.0.nextDrawable().map(|drawable| ReadyDrawable {
                drawable,
                wait: start.map(|start| start.elapsed()),
            })
        })
    }
}

pub(crate) struct ReadyDrawable {
    drawable: Drawable,
    wait: Option<Duration>,
}

// Only ownership crosses threads. The worker relinquishes the retained drawable
// before the main thread renders to its texture and schedules presentation.
unsafe impl Send for ReadyDrawable {}

enum DrawableRequest<T> {
    Idle,
    Waiting,
    RetryAt(Instant),
    Ready(T),
}

impl<T> DrawableRequest<T> {
    fn complete(&mut self, drawable: Option<T>, visible: bool, now: Instant) {
        *self = match drawable {
            _ if !visible => Self::Idle,
            Some(drawable) => Self::Ready(drawable),
            // An unavailable layer can return immediately. Pace retries even during input.
            None => Self::RetryAt(now + Duration::from_millis(50)),
        };
    }

    fn deferred(&self, now: Instant) -> bool {
        matches!(self, Self::Waiting) || matches!(self, Self::RetryAt(at) if now < *at)
    }

    fn retry_due(&self, now: Instant) -> bool {
        matches!(self, Self::RetryAt(at) if now >= *at)
    }

    fn discard(&mut self) {
        if !matches!(self, Self::Waiting) {
            *self = Self::Idle;
        }
    }

    fn take_ready(&mut self) -> Option<T> {
        match std::mem::replace(self, Self::Idle) {
            Self::Ready(drawable) => Some(drawable),
            _ => None,
        }
    }

    fn request(&mut self, sender: &mpsc::SyncSender<()>) -> Result<(), String> {
        sender
            .try_send(())
            .map_err(|error| format!("Could not request a Metal drawable: {error}"))?;
        *self = Self::Waiting;
        Ok(())
    }
}

pub struct MetalPresenter {
    context: gpu::DirectContext,
    queue: Retained<ProtocolObject<dyn MTLCommandQueue>>,
    layer: Retained<CAMetalLayer>,
    dimensions: Option<(PhysicalSize<u32>, f64)>,
    trace_phases: bool,
    request_drawable: mpsc::SyncSender<()>,
    drawable: DrawableRequest<ReadyDrawable>,
}

fn new_context(
    device: &ProtocolObject<dyn MTLDevice>,
) -> Result<
    (
        gpu::DirectContext,
        Retained<ProtocolObject<dyn MTLCommandQueue>>,
    ),
    String,
> {
    let queue = device
        .newCommandQueue()
        .ok_or("Could not create a Metal command queue.")?;
    // Skia retains the device and queue. Rendering and presentation share this same queue.
    let backend = unsafe {
        gpu::mtl::BackendContext::new(
            std::ptr::from_ref(device).cast(),
            Retained::as_ptr(&queue).cast(),
        )
    };
    let context = gpu::direct_contexts::make_metal(&backend, None)
        .ok_or("Could not initialize Skia's Metal backend.")?;
    Ok((context, queue))
}

impl MetalPresenter {
    pub fn new(window: &Window, proxy: crate::WindowProxy) -> Result<Self, String> {
        MainThreadMarker::new().ok_or("Metal window setup requires the main thread.")?;
        let handle = window.window_handle().map_err(|error| error.to_string())?;
        let RawWindowHandle::AppKit(handle) = handle.as_raw() else {
            return Err("Metal needs an AppKit window.".into());
        };
        // The AppKit window handle borrows a live NSView for the lifetime of this call.
        let view: &NSView = unsafe { handle.ns_view.cast().as_ref() };
        let device = MTLCreateSystemDefaultDevice().ok_or("No Metal device is available.")?;
        let (mut context, queue) = new_context(&device)?;
        context.set_resource_cache_limit(128 * 1024 * 1024);
        view.setWantsLayer(true);
        let root = view
            .layer()
            .ok_or("The AppKit view has no backing layer.")?;
        let layer = CAMetalLayer::new();
        layer.setDevice(Some(&device));
        layer.setPixelFormat(MTLPixelFormat::BGRA8Unorm);
        // Skia may sample the drawable for destination-dependent blends.
        layer.setFramebufferOnly(false);
        layer.setOpaque(true);
        let trace_phases = std::env::var_os("OMC_NATIVE_FRAME_TRACE").is_some();
        let source = DrawableSource(layer.clone());
        let (request_drawable, requests) = mpsc::sync_channel(1);
        thread::Builder::new()
            .name("metal-drawable".into())
            .spawn(move || {
                while requests.recv().is_ok() {
                    let drawable = source.acquire(trace_phases);
                    if proxy
                        .send_event(crate::Event::MetalDrawableReady(drawable))
                        .is_err()
                    {
                        break;
                    }
                }
            })
            .map_err(|error| format!("Could not start the Metal drawable worker: {error}"))?;
        root.addSublayer(&layer);
        Ok(Self {
            context,
            queue,
            layer,
            dimensions: None,
            trace_phases,
            request_drawable,
            drawable: DrawableRequest::Idle,
        })
    }

    pub fn accept_drawable(&mut self, drawable: Option<ReadyDrawable>, visible: bool) {
        self.drawable.complete(drawable, visible, Instant::now());
    }

    pub fn retry_due(&self) -> bool {
        self.drawable.retry_due(Instant::now())
    }

    pub fn discard_drawable(&mut self) {
        self.drawable.discard();
    }

    pub fn present(
        &mut self,
        window: &Window,
        size: PhysicalSize<u32>,
        scale: f64,
        draw: impl FnOnce(&Canvas) -> Result<(), String>,
    ) -> Result<bool, String> {
        if self.drawable.deferred(Instant::now()) {
            return Ok(false);
        }
        if self.dimensions != Some((size, scale)) {
            self.discard_drawable();
            CATransaction::begin();
            CATransaction::setDisableActions(true);
            self.layer.setFrame(CGRect::new(
                Default::default(),
                CGSize::new(
                    f64::from(size.width) / scale,
                    f64::from(size.height) / scale,
                ),
            ));
            self.layer.setContentsScale(scale);
            self.layer
                .setDrawableSize(CGSize::new(f64::from(size.width), f64::from(size.height)));
            CATransaction::commit();
            self.dimensions = Some((size, scale));
        }
        let Some(ReadyDrawable { drawable, wait }) = self.drawable.take_ready() else {
            self.drawable.request(&self.request_drawable)?;
            return Ok(false);
        };
        autoreleasepool(|_| {
            let stamp = || self.trace_phases.then(Instant::now);
            let t1 = stamp();
            let texture = drawable.texture();
            // The retained drawable texture is a valid Metal texture, retained again by Skia.
            let texture_info =
                unsafe { gpu::mtl::TextureInfo::new(Retained::as_ptr(&texture).cast()) };
            let target = gpu::backend_render_targets::make_mtl(
                (size.width as i32, size.height as i32),
                &texture_info,
            );
            let mut surface = gpu::surfaces::wrap_backend_render_target(
                &mut self.context,
                &target,
                gpu::SurfaceOrigin::TopLeft,
                ColorType::BGRA8888,
                None,
                None,
            )
            .ok_or("Could not bind the Metal drawable to Skia.")?;
            let t2 = stamp();
            draw(surface.canvas())?;
            let t3 = stamp();
            self.context.flush_and_submit_surface(&mut surface, None);
            let t4 = stamp();

            let command = self
                .queue
                .commandBuffer()
                .ok_or("Could not allocate a Metal presentation command buffer.")?;
            let drawable: &ProtocolObject<dyn MTLDrawable> = ProtocolObject::from_ref(&*drawable);
            window.pre_present_notify();
            command.presentDrawable(drawable);
            command.commit();
            if let (Some(wait), Some(t1), Some(t2), Some(t3), Some(t4), Some(t5)) =
                (wait, t1, t2, t3, t4, stamp())
            {
                let ms =
                    |a: std::time::Instant, b: std::time::Instant| (b - a).as_secs_f64() * 1000.;
                eprintln!(
                    "Metal phases acquire_ms={:.3} wrap_ms={:.3} paint_ms={:.3} flush_ms={:.3} present_ms={:.3}",
                    wait.as_secs_f64() * 1000.,
                    ms(t1, t2),
                    ms(t2, t3),
                    ms(t3, t4),
                    ms(t4, t5),
                );
            }
            Ok(true)
        })
    }
}

impl Drop for MetalPresenter {
    fn drop(&mut self) {
        self.layer.removeFromSuperlayer();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        geometry::{Camera, Rect},
        scene_cache::{SceneCache, SceneCacheKey},
    };
    use skia_safe::{Color, ImageInfo};
    use std::cell::Cell;

    #[test]
    fn drawable_timeout_retries_a_deferred_frame_and_discards_hidden_work() {
        let mut frame = DrawableRequest::Idle;
        let (sender, worker) = mpsc::sync_channel(1);
        let now = Instant::now();
        let deadline = now + Duration::from_millis(50);

        frame.request(&sender).unwrap();
        assert_eq!(worker.try_recv(), Ok(()));
        assert!(frame.deferred(now)); // A redraw arrives while acquisition is in flight.
        frame.complete(None, true, now); // Inject nextDrawable returning nil.
        assert!(frame.deferred(deadline - Duration::from_millis(1)));
        assert!(!frame.retry_due(now));
        assert!(frame.retry_due(deadline));
        assert!(!frame.deferred(deadline));
        assert_eq!(frame.take_ready(), None);
        frame.request(&sender).unwrap();
        assert_eq!(worker.try_recv(), Ok(()));
        assert!(!frame.retry_due(deadline));
        frame.complete(Some(7), true, deadline);
        assert_eq!(frame.take_ready(), Some(7));

        frame.request(&sender).unwrap();
        assert_eq!(worker.try_recv(), Ok(()));
        frame.discard();
        assert!(frame.deferred(deadline));
        frame.complete(None, false, deadline);
        assert!(!frame.retry_due(deadline + Duration::from_secs(1)));
        frame.complete(None, true, deadline);
        frame.discard();
        assert!(!frame.retry_due(deadline + Duration::from_secs(1)));
    }

    #[test]
    #[ignore = "requires a working Metal device"]
    fn metal_canvas_reuses_a_gpu_backed_scene() {
        let device = MTLCreateSystemDefaultDevice().expect("Metal device");
        let (mut context, _) = new_context(&device).unwrap();
        let mut target = gpu::surfaces::render_target(
            &mut context,
            gpu::Budgeted::Yes,
            &ImageInfo::new_n32_premul((64, 64), None),
            None,
            gpu::SurfaceOrigin::TopLeft,
            None,
            None,
            None,
        )
        .unwrap();
        let mut cache = SceneCache::default();
        let key =
            SceneCacheKey::new(1, Rect::new(4., 4., 48., 48.), 1., Camera::default()).unwrap();
        let paints = Cell::new(0);
        for _ in 0..2 {
            cache
                .paint(target.canvas(), key, Color::WHITE, |_| {
                    paints.set(paints.get() + 1);
                    Ok::<(), ()>(())
                })
                .unwrap();
        }
        assert_eq!(paints.get(), 1);
        assert!(cache.is_texture_backed());
        context.flush_and_submit_surface(&mut target, gpu::SyncCpu::Yes);
    }
}
