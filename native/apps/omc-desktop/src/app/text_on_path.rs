use super::*;
use skia_safe::{Path, PathMeasure};

struct Hit<'a> {
    item: &'a omc_scene::SceneItem,
    node: &'a Node,
    path: Path,
    start: f64,
}

impl App {
    fn text_path_hit(&self, point: (f64, f64)) -> Option<Hit<'_>> {
        let scene = self.scene.as_ref()?;
        let document = self.document()?;
        let tolerance = 6. / self.camera.zoom.max(0.01);
        for (index, item) in scene.items.iter().enumerate().rev() {
            let [x, y, width, height] = item.bounds;
            if index == scene.root
                || !self.focus_includes_item(scene, index)
                || item.hidden
                || item.locked
                || !item.children.is_empty()
                || point.0 < x - tolerance
                || point.0 > x + width + tolerance
                || point.1 < y - tolerance
                || point.1 > y + height + tolerance
                || !matches!(
                    item.kind,
                    NodeKind::Rect
                        | NodeKind::Ellipse
                        | NodeKind::Line
                        | NodeKind::Path
                        | NodeKind::Frame
                )
            {
                continue;
            }
            let Some(node) = document
                .nodes
                .get(&item.id)
                .filter(|node| node.parent_id.is_some())
            else {
                continue;
            };
            let mut ancestor = item.parent;
            let mut usable = true;
            while let Some(index) = ancestor {
                let parent = &scene.items[index];
                if parent.hidden
                    || parent.locked
                    || parent.boolean_operation().is_some()
                    || parent.clip && !parent.contains(point.0, point.1)
                {
                    usable = false;
                    break;
                }
                ancestor = parent.parent;
            }
            if !usable {
                continue;
            }
            let Some(path) =
                omc_scene::shape_path(item).filter(|path| path.count_verbs() <= 20_000)
            else {
                continue;
            };
            if let Some(start) = nearest_point(&path, item.world, point, tolerance) {
                return Some(Hit {
                    item,
                    node,
                    path,
                    start,
                });
            }
        }
        None
    }

    pub(super) fn over_text_path(&self, point: (f64, f64)) -> bool {
        self.text_path_hit(point).is_some()
    }

    pub(super) fn begin_path_text(&mut self, point: (f64, f64)) {
        let Some(hit) = self.text_path_hit(point) else {
            return;
        };
        let Some(document) = self.document() else {
            return;
        };
        let mut node = Node::new(NodeKind::Text);
        node.parent_id = hit.node.parent_id.clone();
        node.rank.clone_from(&hit.node.rank);
        if let Some(defaults) = &self.automation.default_text {
            node.properties.extend(defaults.clone());
        }
        node.properties
            .entry("fill".into())
            .or_insert(json!("#1F2937"));
        node.properties
            .entry("fontSize".into())
            .or_insert(json!(24.));
        for key in [
            "rotation",
            "transform",
            "flipX",
            "flipY",
            "constraints",
            "absolute",
            "sizingH",
            "sizingV",
            "gridColumn",
            "gridRow",
            "gridColumnSpan",
            "gridRowSpan",
            "gridAlignH",
            "gridAlignV",
        ] {
            if let Some(value) = hit.node.properties.get(key) {
                node.properties.insert(key.into(), value.clone());
            }
        }
        node.properties.extend([
            ("name".into(), json!("Text")),
            ("text".into(), json!("")),
            ("x".into(), json!(hit.node.number("x", hit.item.local.0[4]))),
            ("y".into(), json!(hit.node.number("y", hit.item.local.0[5]))),
            ("width".into(), json!(hit.item.width)),
            ("height".into(), json!(hit.item.height)),
            (
                "textPath".into(),
                json!({"path":hit.path.to_svg(),"start":hit.start,"flip":false}),
            ),
        ]);
        let has_paint = hit
            .item
            .properties
            .get("fills")
            .and_then(Value::as_array)
            .is_some_and(|fills| {
                fills
                    .iter()
                    .any(|fill| fill["visible"] != false && fill["hidden"] != true)
            });
        if has_paint {
            if let Some(fills) = hit.item.properties.get("fills") {
                node.properties.insert("fills".into(), fills.clone());
            }
        }
        if let Some(fill) = hit
            .item
            .properties
            .get("fill")
            .and_then(Value::as_str)
            .filter(|fill| omc_style::parse_color(fill).is_some_and(|color| color.a > 0.))
        {
            node.properties.insert("fill".into(), json!(fill));
            if !has_paint {
                node.properties.remove("fills");
            }
        }
        for key in ["effects", "shadows", "blur", "blurHidden", "backgroundBlur"] {
            if let Some(value) = hit.item.properties.get(key) {
                node.properties.insert(key.into(), value.clone());
            }
        }
        let selection = BTreeSet::from([node.id.clone()]);
        self.editing = Some(Editing {
            target: EditTarget::TextOnPath {
                source_id: hit.node.id.clone(),
                draft: Box::new(node),
                previous_selection: self.selected.clone(),
            },
            buffer: EditBuffer::new(String::new(), false),
            id: document.id.clone(),
            epoch: document.epoch.clone(),
            sequence: document.sequence,
        });
        self.selected = selection;
        if !self.automation.view.prefs.keep_tool {
            self.tool = Tool::Select;
        }
        self.refresh_path_text_scene();
    }

    pub(super) fn path_text_preview(
        &self,
        document: &DocumentSnapshot,
    ) -> Option<Arc<DocumentSnapshot>> {
        let edit = self.editing.as_ref()?;
        if edit.id != document.id
            || edit.epoch != document.epoch
            || edit.sequence != document.sequence
        {
            return None;
        }
        let EditTarget::TextOnPath {
            source_id, draft, ..
        } = &edit.target
        else {
            return None;
        };
        let mut snapshot = document.clone();
        snapshot.nodes.remove(source_id)?;
        let mut node = draft.as_ref().clone();
        node.properties
            .insert("text".into(), json!(edit.buffer.display_text()));
        snapshot.nodes.insert(node.id.clone(), node);
        Some(Arc::new(snapshot))
    }

    pub(crate) fn refresh_path_text_scene(&mut self) {
        if self
            .editing
            .as_ref()
            .is_some_and(|edit| matches!(edit.target, EditTarget::TextOnPath { .. }))
        {
            self.invalidate_path_text_scene();
        }
    }

    pub(super) fn invalidate_path_text_scene(&mut self) {
        self.automation.preview_generation = self.automation.preview_generation.wrapping_add(1);
        self.schedule_scene();
    }

    pub(super) fn discard_path_text_preview(&mut self, target: &EditTarget) {
        if let EditTarget::TextOnPath {
            previous_selection, ..
        } = target
        {
            self.selected.clone_from(previous_selection);
            self.invalidate_path_text_scene();
        }
    }
}

fn nearest_point(
    path: &Path,
    world: omc_scene::Affine,
    click: (f64, f64),
    tolerance: f64,
) -> Option<f64> {
    let mut measure = PathMeasure::new(path, false, None);
    let length = f64::from(measure.length());
    if !length.is_finite() || length <= 0. {
        return None;
    }
    let scale = world.0[0]
        .hypot(world.0[1])
        .max(world.0[2].hypot(world.0[3]));
    let steps = (length * scale / tolerance).ceil().clamp(16., 1024.) as usize;
    let at = |measure: &mut PathMeasure, t: f64| {
        let (position, _) = measure.pos_tan((length * t) as f32)?;
        Some(world.point(f64::from(position.x), f64::from(position.y)))
    };
    let mut previous = at(&mut measure, 0.)?;
    let mut closest = (f64::INFINITY, 0.);
    for index in 1..=steps {
        let fraction = index as f64 / steps as f64;
        let next = at(&mut measure, fraction)?;
        let delta = (next.0 - previous.0, next.1 - previous.1);
        let length_squared = delta.0 * delta.0 + delta.1 * delta.1;
        if length_squared > 0. {
            let along = (((click.0 - previous.0) * delta.0 + (click.1 - previous.1) * delta.1)
                / length_squared)
                .clamp(0., 1.);
            let distance = (click.0 - previous.0 - delta.0 * along)
                .hypot(click.1 - previous.1 - delta.1 * along);
            if distance < closest.0 {
                closest = (distance, (index as f64 - 1. + along) / steps as f64);
            }
        }
        previous = next;
    }
    (closest.0 <= tolerance).then_some(closest.1)
}
