use super::{App, Node, NodeKind};
use crate::paint::{LAYER_ROW_STEP, layer_viewport};
use std::{
    collections::BTreeMap,
    time::{Duration, Instant},
};

const FRAME_TIME: Duration = Duration::from_millis(16);
const SCROLL_TIME: Duration = Duration::from_millis(220);

pub(super) struct LayerScrollAnimation {
    from: f64,
    to: f64,
    started: Instant,
    next_frame: Instant,
}

impl LayerScrollAnimation {
    fn offset(&self, now: Instant) -> f64 {
        let t =
            (now.duration_since(self.started).as_secs_f64() / SCROLL_TIME.as_secs_f64()).min(1.);
        self.to + (self.from - self.to) * (1. - t).powi(3)
    }
}

fn reveal_path<'a>(nodes: &'a BTreeMap<String, Node>, root: &str, selected: &str) -> Vec<&'a str> {
    let mut path = Vec::new();
    let mut id = selected;
    for _ in 0..=nodes.len() {
        if id == root {
            return path;
        }
        let Some(node) = nodes.get(id) else {
            return Vec::new();
        };
        if node.kind == NodeKind::Frame {
            path.clear();
        }
        path.push(node.id.as_str());
        let Some(parent) = node.parent_id.as_deref() else {
            return Vec::new();
        };
        id = parent;
    }
    Vec::new()
}

fn reveal_offset(offset: f64, viewport_height: f64, index: usize) -> f64 {
    let top = index as f64 * LAYER_ROW_STEP;
    let minimum = top + LAYER_ROW_STEP - viewport_height;
    offset.clamp(minimum.min(top), top)
}

impl App {
    fn layer_scroll_max(&self) -> f64 {
        (self.visible_layers.len() as f64 * LAYER_ROW_STEP - layer_viewport(self).height).max(0.)
    }

    pub(super) fn clamp_layer_scroll(&mut self) {
        let max = self.layer_scroll_max();
        self.layer_scroll = self.layer_scroll.min(max);
        if let Some(animation) = &mut self.layer_scroll_animation {
            animation.from = animation.from.min(max);
            animation.to = animation.to.min(max);
        }
    }

    pub(super) fn reset_layer_scroll(&mut self) {
        self.layer_scroll = 0.;
        self.layer_scroll_animation = None;
    }

    fn animate_layer_scroll(&mut self, to: f64) {
        let to = to.clamp(0., self.layer_scroll_max());
        if self.reduce_motion() || to == self.layer_scroll {
            self.layer_scroll = to;
            self.layer_scroll_animation = None;
        } else {
            let started = Instant::now();
            self.layer_scroll_animation = Some(LayerScrollAnimation {
                from: self.layer_scroll,
                to,
                started,
                next_frame: started + FRAME_TIME,
            });
        }
    }

    pub(super) fn scroll_layers(&mut self, delta: f64, precise: bool) -> bool {
        let offset = self.layer_scroll;
        if precise {
            self.layer_scroll_animation = None;
            self.layer_scroll = (offset + delta).clamp(0., self.layer_scroll_max());
            return self.layer_scroll != offset;
        }
        let target = self
            .layer_scroll_animation
            .as_ref()
            .map_or(offset, |a| a.to);
        self.animate_layer_scroll(target + delta);
        self.layer_scroll != offset || self.layer_scroll_animation.is_some()
    }

    pub(super) fn reveal_canvas_layer(&mut self, selected: &str) {
        let Some((doc, root)) = self.document().zip(self.current_root()) else {
            return;
        };
        let path = reveal_path(&doc.nodes, &root, selected);
        let Some((target, ancestors)) = path.split_first() else {
            return;
        };
        let target = (*target).to_owned();
        let collapsed: Vec<_> = ancestors
            .iter()
            .filter(|id| self.collapsed.contains(**id))
            .map(|id| (*id).to_owned())
            .collect();
        if !collapsed.is_empty() {
            for id in collapsed {
                self.collapsed.remove(&id);
            }
            self.refresh_visible_layers();
        }
        if let Some(index) = self
            .visible_layers
            .iter()
            .position(|&index| self.layers[index].id == target)
        {
            let height = layer_viewport(self).height;
            if height > 0. {
                self.animate_layer_scroll(reveal_offset(self.layer_scroll, height, index));
            }
        }
    }

    pub(super) fn tick_layer_scroll(&mut self) -> Option<Instant> {
        let animation = self.layer_scroll_animation.as_mut()?;
        let now = Instant::now();
        if now < animation.next_frame {
            return Some(animation.next_frame);
        }
        self.layer_scroll = animation.offset(now);
        let next = if now.duration_since(animation.started) < SCROLL_TIME {
            animation.next_frame = (now + FRAME_TIME).min(animation.started + SCROLL_TIME);
            Some(animation.next_frame)
        } else {
            self.layer_scroll_animation = None;
            None
        };
        self.redraw();
        next
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reveal_uses_the_outermost_frame_and_keeps_its_own_collapse_state() {
        let nodes = [
            ("group", "root", NodeKind::Group),
            ("outer", "group", NodeKind::Frame),
            ("inner", "outer", NodeKind::Frame),
            ("child", "inner", NodeKind::Rect),
            ("solo", "group", NodeKind::Rect),
            ("loose", "root", NodeKind::Rect),
        ]
        .into_iter()
        .map(|(id, parent, kind)| {
            let mut node = Node::new(kind);
            node.id = id.into();
            node.parent_id = Some(parent.into());
            (id.into(), node)
        })
        .collect();
        assert_eq!(reveal_path(&nodes, "root", "child"), ["outer", "group"]);
        assert_eq!(reveal_path(&nodes, "root", "outer"), ["outer", "group"]);
        assert_eq!(reveal_path(&nodes, "root", "solo"), ["solo", "group"]);
        assert_eq!(reveal_path(&nodes, "root", "loose"), ["loose"]);
        assert!(reveal_path(&nodes, "different-page", "child").is_empty());
    }

    #[test]
    fn reveal_preserves_visible_rows_and_eases_to_offscreen_rows() {
        assert_eq!(reveal_offset(19.5, 150., 2), 19.5);
        assert_eq!(reveal_offset(19.5, 150., 7), 146.);
        assert_eq!(reveal_offset(19.5, 150., 0), 0.);
        let started = Instant::now();
        let animation = LayerScrollAnimation {
            from: 19.5,
            to: 146.,
            started,
            next_frame: started,
        };
        assert_eq!(animation.offset(started), 19.5);
        let middle = animation.offset(started + SCROLL_TIME / 2);
        assert!(middle > 19.5 && middle < 146.);
        assert_eq!(animation.offset(started + SCROLL_TIME), 146.);
    }
}
