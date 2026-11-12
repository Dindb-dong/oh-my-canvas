use crate::scene_cache::{SceneCacheKey, matching_surface};
use omc_render::{MovePaintPlan, RenderError, ResourceProvider};
use omc_scene::Scene;
use skia_safe::{Canvas, Color, IRect, Image};
use std::collections::BTreeMap;

const MAX_RETAINED_BYTES: u64 = 64 * 1024 * 1024;

#[derive(Default)]
pub struct MoveCache {
    entry: Option<Entry>,
}

struct Entry {
    key: SceneCacheKey,
    moving_ids: Vec<String>,
    gpu: bool,
    preview: Option<Preview>,
}

struct Preview {
    plan: MovePaintPlan,
    stationary: Vec<Image>,
}

impl MoveCache {
    pub fn clear(&mut self) {
        self.entry = None;
    }

    /// The caller has already applied the world transform and viewport clip.
    pub fn paint(
        &mut self,
        canvas: &Canvas,
        key: SceneCacheKey,
        scene: &Scene,
        resources: &dyn ResourceProvider,
        translations: &BTreeMap<String, (f64, f64)>,
    ) -> Option<Result<(), RenderError>> {
        let bounds = canvas.device_clip_bounds()?;
        let gpu = canvas.recording_context().is_some();
        if !self.entry.as_ref().is_some_and(|entry| {
            entry.key == key && entry.gpu == gpu && entry.moving_ids.iter().eq(translations.keys())
        }) {
            self.clear();
            self.entry = Some(Entry {
                key,
                moving_ids: translations.keys().cloned().collect(),
                gpu,
                preview: Preview::new(canvas, bounds, scene, resources, translations),
            });
        }
        let preview = self.entry.as_ref()?.preview.as_ref()?;
        Some(preview.paint(canvas, bounds, scene, resources, translations))
    }
}

impl Preview {
    fn new(
        canvas: &Canvas,
        bounds: IRect,
        scene: &Scene,
        resources: &dyn ResourceProvider,
        translations: &BTreeMap<String, (f64, f64)>,
    ) -> Option<Self> {
        let plan = MovePaintPlan::new(scene, translations)?;
        let (width, height) = (bounds.width(), bounds.height());
        let runs = plan.passes().filter(|(_, moving)| !moving).count() as u64;
        let bytes = u64::try_from(width).ok()? * u64::try_from(height).ok()? * 4 * runs;
        if bytes > MAX_RETAINED_BYTES {
            return None;
        }

        let transform = canvas.local_to_device_as_3x3();
        let mut stationary = Vec::new();
        for (index, moving) in plan.passes() {
            if moving {
                continue;
            }
            let mut surface = matching_surface(canvas, width, height)?;
            let offscreen = surface.canvas();
            offscreen.clear(Color::TRANSPARENT);
            offscreen.translate((-bounds.left as f32, -bounds.top as f32));
            offscreen.concat(&transform);
            plan.paint(index, offscreen, scene, resources, translations)
                .ok()?;
            stationary.push(surface.image_snapshot());
        }
        Some(Self { plan, stationary })
    }

    fn paint(
        &self,
        canvas: &Canvas,
        bounds: IRect,
        scene: &Scene,
        resources: &dyn ResourceProvider,
        translations: &BTreeMap<String, (f64, f64)>,
    ) -> Result<(), RenderError> {
        let mut stationary = self.stationary.iter();
        for (index, moving) in self.plan.passes() {
            if moving {
                self.plan
                    .paint(index, canvas, scene, resources, translations)?;
            } else if let Some(image) = stationary.next() {
                let saved = canvas.save();
                canvas.reset_matrix();
                canvas.draw_image(image, (bounds.left as f32, bounds.top as f32), None);
                canvas.restore_to_count(saved);
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::geometry::{Camera, Rect};
    use omc_model::{DocumentContent, DocumentSnapshot, Node, NodeKind};
    use omc_render::{EmptyResources, paint_scene_preview};
    use omc_scene::{SceneOptions, build_scene};
    use serde_json::json;
    use skia_safe::{Rect as SkRect, Surface, surfaces};

    const VIEWPORT: Rect = Rect {
        x: 12.,
        y: 8.,
        width: 128.,
        height: 96.,
    };
    const CAMERA: Camera = Camera {
        x: 0.,
        y: 0.,
        zoom: 1.,
    };

    fn card(masked: bool) -> (Scene, [String; 2]) {
        let mut content = DocumentContent::empty("Card");
        let mut card = Node::new(NodeKind::Frame);
        card.parent_id = Some(content.pages[0].root_node_id.clone());
        card.properties.extend([
            ("x".into(), json!(10)),
            ("y".into(), json!(12)),
            ("width".into(), json!(100)),
            ("height".into(), json!(70)),
            ("fill".into(), json!("#fafafa")),
            ("clipContent".into(), json!(true)),
        ]);
        if masked {
            card.properties.insert("isMaskGroup".into(), json!(true));
        }
        let card_id = card.id.clone();
        content.nodes.insert(card_id.clone(), card);
        let mut selected = Vec::new();
        for (i, color) in ["#ff0000", "#00ff00", "#0000ff", "#ffcc00"]
            .into_iter()
            .enumerate()
        {
            let mut child = Node::new(NodeKind::Rect);
            child.parent_id = Some(card_id.clone());
            child.rank = format!("{:032x}", i + 1);
            child.properties.extend([
                ("x".into(), json!(5 + i * 15)),
                ("y".into(), json!(4 + i * 7)),
                ("width".into(), json!(36)),
                ("height".into(), json!(29)),
                ("fill".into(), json!(color)),
            ]);
            if i % 2 == 0 {
                selected.push(child.id.clone());
            }
            content.nodes.insert(child.id.clone(), child);
        }
        let document = DocumentSnapshot {
            id: "doc".into(),
            title: content.title,
            epoch: "epoch".into(),
            sequence: 1,
            pages: content.pages,
            nodes: content.nodes,
            metadata: content.metadata,
        };
        let scene = build_scene(&document, &SceneOptions::default()).unwrap();
        (scene, selected.try_into().unwrap())
    }

    fn frame(
        scene: &Scene,
        translations: &BTreeMap<String, (f64, f64)>,
        cache: Option<&mut MoveCache>,
        scale: f32,
    ) -> Surface {
        let mut surface = surfaces::raster_n32_premul((320, 240)).unwrap();
        let canvas = surface.canvas();
        canvas.clear(Color::from_rgb(238, 241, 244));
        canvas.scale((scale, scale));
        canvas.clip_rect(SkRect::from_xywh(12., 8., 128., 96.), None, Some(false));
        canvas.translate((VIEWPORT.x as f32, VIEWPORT.y as f32));
        if let Some(cache) = cache {
            let key = SceneCacheKey::new(1, VIEWPORT, scale as f64, CAMERA).unwrap();
            cache
                .paint(canvas, key, scene, &EmptyResources, translations)
                .expect("ordinary clipped card must use the retained move path")
                .unwrap();
        } else {
            paint_scene_preview(canvas, scene, &EmptyResources, translations).unwrap();
        }
        surface
    }

    #[test]
    fn reuses_stationary_layers_in_painter_order_during_clipped_multi_selection() {
        let (scene, selected) = card(false);
        for scale in [1., 2.] {
            let mut cache = MoveCache::default();
            let mut previous_textures = None;
            for delta in [(0., 0.), (25., 6.), (47., 11.), (-20., 8.)] {
                let translations = selected.iter().map(|id| (id.clone(), delta)).collect();
                let mut direct = frame(&scene, &translations, None, scale);
                let mut retained = frame(&scene, &translations, Some(&mut cache), scale);
                assert_eq!(
                    direct.peek_pixels().unwrap().bytes(),
                    retained.peek_pixels().unwrap().bytes(),
                    "different output at scale {scale}, delta {delta:?}"
                );
                let textures: Vec<_> = cache
                    .entry
                    .as_ref()
                    .unwrap()
                    .preview
                    .as_ref()
                    .unwrap()
                    .stationary
                    .iter()
                    .map(Image::unique_id)
                    .collect();
                assert_eq!(textures.len(), 3);
                if let Some(previous_textures) = previous_textures.replace(textures.clone()) {
                    assert_eq!(previous_textures, textures);
                }
            }
        }
    }

    #[test]
    fn moving_content_inside_a_mask_keeps_the_direct_painter() {
        let (scene, selected) = card(true);
        let translations = BTreeMap::from([(selected[0].clone(), (12., 4.))]);
        assert!(MovePaintPlan::new(&scene, &translations).is_none());
    }
}
