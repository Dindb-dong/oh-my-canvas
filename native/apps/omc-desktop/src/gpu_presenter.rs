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
use winit::{
    dpi::PhysicalSize,
    raw_window_handle::{HasWindowHandle, RawWindowHandle},
    window::Window,
};

pub struct MetalPresenter {
    context: gpu::DirectContext,
    queue: Retained<ProtocolObject<dyn MTLCommandQueue>>,
    layer: Retained<CAMetalLayer>,
    dimensions: Option<(PhysicalSize<u32>, f64)>,
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
    pub fn new(window: &Window) -> Result<Self, String> {
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
        root.addSublayer(&layer);
        Ok(Self {
            context,
            queue,
            layer,
            dimensions: None,
        })
    }

    pub fn present(
        &mut self,
        window: &Window,
        size: PhysicalSize<u32>,
        scale: f64,
        draw: impl FnOnce(&Canvas) -> Result<(), String>,
    ) -> Result<bool, String> {
        if self.dimensions != Some((size, scale)) {
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
        autoreleasepool(|_| {
            let Some(drawable) = self.layer.nextDrawable() else {
                return Ok(false);
            };
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
            draw(surface.canvas())?;
            self.context.flush_and_submit_surface(&mut surface, None);

            let command = self
                .queue
                .commandBuffer()
                .ok_or("Could not allocate a Metal presentation command buffer.")?;
            let drawable: &ProtocolObject<dyn MTLDrawable> = ProtocolObject::from_ref(&*drawable);
            window.pre_present_notify();
            command.presentDrawable(drawable);
            command.commit();
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
