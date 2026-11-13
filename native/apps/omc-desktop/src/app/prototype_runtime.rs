use super::*;
use omc_scene::Affine;
use omc_style::prototype::{Environment, INTERACTIONS, Kind, Literal, Modes, Overrides, SETTINGS};

#[derive(Default)]
pub(crate) struct Playback {
    variables: Overrides,
    modes: Modes,
    variants: BTreeMap<String, String>,
    history: Vec<(String, Camera)>,
    pub(crate) overlay: Option<Overlay>,
    pub(crate) options: Value,
    pub(crate) background: Option<String>,
    pub(crate) hotspot: Option<Instant>,
    pub(crate) motion: Option<Motion>,
    hover: Option<String>,
    pressed: Option<(String, (f64, f64))>,
    dragged: bool,
    queued: Vec<Pending>,
}

pub(crate) struct Overlay {
    pub(crate) id: String,
    pub(crate) rect: Rect,
    pub(crate) tint: Option<String>,
    close_outside: bool,
}

pub(crate) struct Motion {
    pub(crate) frame: String,
    pub(crate) camera: Camera,
    pub(crate) kind: String,
    pub(crate) direction: String,
    start: Instant,
    duration: Duration,
    easing: Value,
    matches: Vec<MotionPair>,
    drag: Option<DragMotion>,
}

struct DragMotion {
    from: (f64, f64),
    direction: (f64, f64),
    distance: f64,
    progress: f64,
}

fn direction_axis(direction: &str) -> Option<(f64, f64)> {
    match direction {
        "left" => Some((-1., 0.)),
        "right" => Some((1., 0.)),
        "top" => Some((0., -1.)),
        "bottom" => Some((0., 1.)),
        _ => None,
    }
}

struct MotionPair {
    from: String,
    to: String,
    from_transform: Affine,
    to_transform: Affine,
    size: Option<([f64; 2], [f64; 2])>,
}

fn motion_pairs(scene: &Scene, from: &str, to: &str) -> Vec<MotionPair> {
    let Some(from) = scene.item(from) else {
        return Vec::new();
    };
    let Some(to) = scene.item(to) else {
        return Vec::new();
    };
    let mut pending = vec![(from, to)];
    let mut matches = Vec::new();
    while let Some((left, right)) = pending.pop() {
        let mut children: BTreeMap<&str, Vec<usize>> = BTreeMap::new();
        for child in &right.children {
            let item = &scene.items[*child];
            if !item.hidden
                && let Some(name) = item.properties.get("name").and_then(Value::as_str)
            {
                children.entry(name).or_default().push(*child);
            }
        }
        for child in &left.children {
            let item = &scene.items[*child];
            let Some(name) = item
                .properties
                .get("name")
                .and_then(Value::as_str)
                .filter(|_| !item.hidden)
            else {
                continue;
            };
            let Some(candidates) = children.get_mut(name) else {
                continue;
            };
            let Some(position) = candidates
                .iter()
                .position(|index| scene.items[*index].kind == item.kind)
            else {
                continue;
            };
            let target = &scene.items[candidates.remove(position)];
            let size = (item.children.is_empty()
                && target.children.is_empty()
                && [item.width, item.height, target.width, target.height]
                    .iter()
                    .all(|size| *size > 0.))
            .then_some(([item.width, item.height], [target.width, target.height]));
            matches.push(MotionPair {
                from: item.id.clone(),
                to: target.id.clone(),
                from_transform: item.local,
                to_transform: target.local,
                size,
            });
            if matches.len() >= 1024 {
                return matches;
            }
            pending.push((item, target));
        }
    }
    matches
}

impl Motion {
    fn follow_drag(&mut self, point: (f64, f64)) -> bool {
        let Some(drag) = &mut self.drag else {
            return false;
        };
        let dx = point.0 - drag.from.0;
        let dy = point.1 - drag.from.1;
        drag.progress =
            ((dx * drag.direction.0 + dy * drag.direction.1) / drag.distance).clamp(0., 1.);
        true
    }

    pub(crate) fn matched(&self) -> usize {
        self.matches.len()
    }

    pub(crate) fn layer_poses(&self, progress: f64) -> [BTreeMap<String, Affine>; 2] {
        let mut poses = [BTreeMap::new(), BTreeMap::new()];
        let lerp = |from: f64, to: f64| from + (to - from) * progress;
        for pair in &self.matches {
            let a = pair.from_transform.0;
            let b = pair.to_transform.0;
            let from_angle = a[1].atan2(a[0]);
            let to_angle = b[1].atan2(b[0]);
            let delta = (to_angle - from_angle + std::f64::consts::PI)
                .rem_euclid(std::f64::consts::TAU)
                - std::f64::consts::PI;
            let rotate = |angle: f64| {
                let (sin, cos) = angle.sin_cos();
                Affine([cos, sin, -sin, cos, 0., 0.])
            };
            let a = rotate(-from_angle)
                .multiply(Affine([a[0], a[1], a[2], a[3], 0., 0.]))
                .0;
            let b = rotate(-to_angle)
                .multiply(Affine([b[0], b[1], b[2], b[3], 0., 0.]))
                .0;
            let matrix = Affine::translation(
                lerp(pair.from_transform.0[4], pair.to_transform.0[4]),
                lerp(pair.from_transform.0[5], pair.to_transform.0[5]),
            )
            .multiply(rotate(from_angle + delta * progress))
            .multiply(Affine([
                lerp(a[0], b[0]),
                lerp(a[1], b[1]),
                lerp(a[2], b[2]),
                lerp(a[3], b[3]),
                0.,
                0.,
            ]));
            let resize = |side: usize| {
                let Some((from, to)) = pair.size else {
                    return matrix;
                };
                let current = if side == 0 { from } else { to };
                let x = (lerp(from[0], to[0]) / current[0]).clamp(0.001, 1000.);
                let y = (lerp(from[1], to[1]) / current[1]).clamp(0.001, 1000.);
                matrix.multiply(Affine([x, 0., 0., y, 0., 0.]))
            };
            poses[0].insert(pair.from.clone(), resize(0));
            poses[1].insert(pair.to.clone(), resize(1));
        }
        poses
    }

    pub(crate) fn progress(&self) -> f64 {
        let t = self.drag.as_ref().map_or_else(
            || (self.start.elapsed().as_secs_f64() / self.duration.as_secs_f64()).clamp(0., 1.),
            |drag| drag.progress,
        );
        if t >= 1. {
            return 1.;
        }
        let cubic = |x1: f64, y1: f64, x2: f64, y2: f64| {
            let coord = |t: f64, a: f64, b: f64| {
                3. * (1. - t).powi(2) * t * a + 3. * (1. - t) * t * t * b + t.powi(3)
            };
            let (mut low, mut high) = (0., 1.);
            for _ in 0..20 {
                let middle = (low + high) / 2.;
                if coord(middle, x1, x2) < t {
                    low = middle;
                } else {
                    high = middle;
                }
            }
            coord((low + high) / 2., y1, y2)
        };
        let spring = |mass: f64, stiffness: f64, damping: f64| {
            let time = t * self.duration.as_secs_f64();
            let decay = damping / (2. * mass);
            let frequency = (stiffness / mass - decay.powi(2)).max(0.).sqrt();
            let tail = if frequency > 0.0001 {
                (frequency * time).cos() + decay / frequency * (frequency * time).sin()
            } else {
                1. + decay * time
            };
            let progress = 1. - (-decay * time).exp() * tail;
            if progress.is_finite() {
                progress.clamp(-1., 2.)
            } else {
                t
            }
        };
        match self.easing.as_str() {
            Some("linear") => t,
            Some("easeIn") => cubic(0.42, 0., 1., 1.),
            Some("easeOut") => cubic(0., 0., 0.58, 1.),
            Some("easeInBack") => cubic(0.36, 0., 0.66, -0.56),
            Some("easeOutBack") => cubic(0.34, 1.56, 0.64, 1.),
            Some("easeInOutBack") => cubic(0.68, -0.6, 0.32, 1.6),
            Some("gentle") => spring(1., 100., 15.),
            Some("quick") => spring(1., 300., 20.),
            Some("bouncy") => spring(1., 600., 15.),
            Some("slow") => spring(1., 80., 20.),
            _ => {
                if let Some(curve) = self.easing.get("customBezier") {
                    cubic(
                        curve["x1"].as_f64().unwrap_or(0.42),
                        curve["y1"].as_f64().unwrap_or(0.),
                        curve["x2"].as_f64().unwrap_or(0.58),
                        curve["y2"].as_f64().unwrap_or(1.),
                    )
                } else if let Some(curve) = self.easing.get("customSpring") {
                    spring(
                        curve["mass"].as_f64().unwrap_or(1.).max(0.001),
                        curve["stiffness"].as_f64().unwrap_or(100.).max(0.001),
                        curve["damping"].as_f64().unwrap_or(15.).max(0.001),
                    )
                } else {
                    cubic(0.42, 0., 0.58, 1.)
                }
            }
        }
    }
}

struct Pending {
    at: Instant,
    frame: String,
    source: String,
    actions: Vec<Value>,
    motion: Value,
    link_notice: bool,
}

impl App {
    pub(super) fn reset_prototype(&mut self, options: Value) {
        self.prototype_playback = Playback {
            options,
            ..Playback::default()
        };
    }

    pub(crate) fn prototype_settings(&self) -> Option<&Value> {
        self.document()?
            .nodes
            .get(&self.current_root()?)?
            .properties
            .get(SETTINGS)
    }

    pub(super) fn prototype_scene_copy(
        &self,
        document: &DocumentSnapshot,
    ) -> Option<Arc<DocumentSnapshot>> {
        let frame = self.prototype_frame.as_ref()?;
        let state = &self.prototype_playback;
        let size = self
            .prototype_settings()
            .filter(|settings| settings["responsive"] == true)
            .map(|settings| {
                let rect = self.canvas_rect();
                let width = settings["screen"]["width"].as_f64().unwrap_or(rect.width);
                let height = settings["screen"]["height"].as_f64().unwrap_or(rect.height);
                (width, height)
            });
        if size.is_none()
            && state.variables.is_empty()
            && state.modes.is_empty()
            && state.variants.is_empty()
        {
            return None;
        }
        let mut copy = document.clone();
        if let Some((width, height)) = size
            && let Some(frame) = copy.nodes.get_mut(frame)
        {
            frame.properties.insert("width".into(), json!(width));
            frame.properties.insert("height".into(), json!(height));
        }
        for (id, value) in &state.variables {
            let prefix = format!("tokens/{id}/");
            copy.metadata
                .insert(format!("{prefix}value"), value.clone());
            if let Some(modes) = copy
                .metadata
                .get_mut(&format!("{prefix}modes"))
                .and_then(Value::as_object_mut)
            {
                for mode in modes.values_mut() {
                    *mode = value.clone();
                }
            }
        }
        if !state.modes.is_empty() {
            for node in copy.nodes.values_mut() {
                let entry = node
                    .properties
                    .entry("figcraftVariableModes".into())
                    .or_insert_with(|| json!({}));
                if let Some(map) = entry.as_object_mut() {
                    map.extend(
                        state
                            .modes
                            .iter()
                            .map(|(key, value)| (key.clone(), json!(value))),
                    );
                }
            }
        }
        for (id, variant) in &state.variants {
            if let Some(instance) = copy.nodes.get_mut(id) {
                instance
                    .properties
                    .insert("componentId".into(), json!(variant));
            }
        }
        Some(Arc::new(copy))
    }

    pub(super) fn prototype_click(&mut self, x: f64, y: f64) {
        let Some(frame) = self.prototype_frame.clone() else {
            return;
        };
        self.prototype_playback.hotspot = None;
        self.prototype_playback.pressed = None;
        self.prototype_playback.dragged = false;
        if let Some(overlay) = self.prototype_playback.overlay.as_ref()
            && !overlay.rect.contains(x, y)
        {
            if overlay.close_outside {
                self.prototype_playback.overlay = None;
            }
            return;
        }
        let target = self.prototype_hit(x, y);
        let Some(source) = target else {
            return;
        };
        self.prototype_playback.pressed = Some((source.clone(), (x, y)));
        if !self.prototype_dispatch(&source, &["mouseDown"], false) {
            self.prototype_dispatch(&source, &["onPress"], false);
        }
        if self.prototype_frame.as_ref() != Some(&frame) {
            self.prototype_playback.pressed = None;
        }
    }

    pub(super) fn prototype_move(&mut self, x: f64, y: f64) {
        if self
            .prototype_playback
            .motion
            .as_mut()
            .is_some_and(|motion| motion.follow_drag((x, y)))
        {
            return;
        }
        let next = self.prototype_hit(x, y);
        if let Some((source, from)) = self.prototype_playback.pressed.clone()
            && !self.prototype_playback.dragged
            && (from.0 - x).hypot(from.1 - y) > 6.
        {
            self.prototype_playback.dragged = true;
            let delta = (x - from.0, y - from.1);
            let started = Instant::now();
            if self.prototype_dispatch_filtered(&source, &["onDrag"], true, |entry| {
                match entry["transition"]["direction"]
                    .as_str()
                    .and_then(direction_axis)
                {
                    Some((ax, ay)) => {
                        let forward = delta.0 * ax + delta.1 * ay;
                        forward > 0. && forward >= (delta.0 * ay + delta.1 * ax).abs()
                    }
                    None => true,
                }
            }) {
                self.prototype_playback.pressed = None;
                let viewport = self.canvas_rect();
                if let Some(motion) = self.prototype_playback.motion.as_mut()
                    && motion.start >= started
                {
                    let dominant = if delta.0.abs() >= delta.1.abs() {
                        (delta.0.signum(), 0.)
                    } else {
                        (0., delta.1.signum())
                    };
                    let direction = match motion.kind.as_str() {
                        "moveIn" | "moveOut" | "push" | "slideIn" | "slideOut" => {
                            direction_axis(&motion.direction).unwrap_or(dominant)
                        }
                        _ => dominant,
                    };
                    let distance = if direction.0 != 0. {
                        viewport.width
                    } else {
                        viewport.height
                    };
                    motion.drag = Some(DragMotion {
                        from,
                        direction,
                        distance: distance.max(1.),
                        progress: 0.,
                    });
                    motion.follow_drag((x, y));
                }
                return;
            }
        }
        if self.prototype_playback.hover == next {
            return;
        }
        if let Some(old) = self.prototype_playback.hover.take() {
            self.prototype_dispatch(&old, &["mouseLeave"], true);
        }
        if let Some(source) = &next {
            self.prototype_dispatch(source, &["mouseEnter", "onHover"], true);
        }
        self.prototype_playback.hover = next;
    }

    pub(super) fn prototype_up(&mut self) {
        self.release_prototype_drag();
        let dragged = std::mem::take(&mut self.prototype_playback.dragged);
        if self.prototype_playback.pressed.take().is_none() {
            return;
        }
        let Some(source) = self.prototype_hit(self.cursor.0, self.cursor.1) else {
            return;
        };
        if !self.prototype_dispatch(&source, &["mouseUp"], false)
            && !dragged
            && !self.prototype_dispatch(&source, &["onClick"], false)
            && self.prototype_playback.options["hotspotHints"] != false
        {
            self.prototype_playback.hotspot = Some(Instant::now());
        }
    }

    fn release_prototype_drag(&mut self) {
        if let Some(motion) = self.prototype_playback.motion.as_mut()
            && let Some(drag) = motion.drag.take()
        {
            let elapsed = motion.duration.mul_f64(drag.progress);
            let now = Instant::now();
            motion.start = now.checked_sub(elapsed).unwrap_or(now);
        }
    }

    pub(super) fn cancel_prototype_pointer(&mut self) {
        self.release_prototype_drag();
        self.prototype_playback.pressed = None;
        self.prototype_playback.dragged = false;
    }

    pub(crate) fn prototype_inspected_layer(&self) -> Option<&str> {
        self.prototype_playback.hover.as_deref()
    }

    fn prototype_hit(&self, x: f64, y: f64) -> Option<String> {
        let frame = self.prototype_frame.as_deref()?;
        let scene = self.scene.as_ref()?;
        let canvas = self.canvas_rect();
        if !canvas.contains(x, y) {
            return None;
        }
        let (frame, world) = if let Some(overlay) = self.prototype_playback.overlay.as_ref() {
            if !overlay.rect.contains(x, y) {
                return None;
            }
            let [ox, oy, _, _] = scene.item(&overlay.id)?.bounds;
            (
                overlay.id.as_str(),
                (
                    ox + (x - overlay.rect.x) / self.camera.zoom,
                    oy + (y - overlay.rect.y) / self.camera.zoom,
                ),
            )
        } else {
            (frame, self.world(x, y))
        };
        crate::prototype::hit_layer(scene, frame, world.0, world.1).map(str::to_owned)
    }

    fn prototype_dispatch(&mut self, source: &str, triggers: &[&str], force_notice: bool) -> bool {
        self.prototype_dispatch_filtered(source, triggers, force_notice, |_| true)
    }

    fn prototype_dispatch_filtered(
        &mut self,
        source: &str,
        triggers: &[&str],
        force_notice: bool,
        accepts: impl Fn(&Value) -> bool,
    ) -> bool {
        let Some(document) = self.document() else {
            return false;
        };
        let Some(frame) = self.prototype_frame.clone() else {
            return false;
        };
        let limit = self
            .prototype_playback
            .overlay
            .as_ref()
            .map_or(frame.as_str(), |overlay| overlay.id.as_str());
        let mut source = Some(source);
        let mut matched = Vec::new();
        while let Some(id) = source {
            let Some(node) = document.nodes.get(id) else {
                break;
            };
            if let Some(items) = node.properties.get(INTERACTIONS).and_then(Value::as_array) {
                for entry in items {
                    if entry["trigger"]["type"]
                        .as_str()
                        .is_some_and(|kind| triggers.contains(&kind))
                        && accepts(entry)
                        && let Some(actions) = entry["actions"].as_array()
                    {
                        matched.push((
                            node.id.clone(),
                            entry["delay_ms"].as_u64().unwrap_or(0),
                            actions.clone(),
                            motion_fields(entry),
                        ));
                    }
                }
            } else if triggers.contains(&"onClick")
                && let Some(target) = node.string(omc_style::prototype::CLICK)
            {
                matched.push((
                    node.id.clone(),
                    0,
                    vec![json!({"type":"navigate","dest":target})],
                    Value::Null,
                ));
            }
            if !matched.is_empty() || id == limit {
                break;
            }
            source = node.parent_id.as_deref();
        }
        let triggered = !matched.is_empty();
        for (source, delay, actions, motion) in matched {
            if delay > 0 {
                self.prototype_playback.queued.push(Pending {
                    at: Instant::now() + Duration::from_millis(delay.min(600_000)),
                    frame: frame.clone(),
                    source,
                    actions,
                    motion,
                    link_notice: true,
                });
            } else {
                self.prototype_run(&source, &actions, force_notice, &motion, 0);
            }
        }
        triggered
    }

    pub(super) fn prototype_key(&mut self, key: &Key) -> bool {
        let name = match key {
            Key::Character(text) => text.to_uppercase(),
            Key::Named(NamedKey::Space) => "Space".into(),
            Key::Named(key) => format!("{key:?}"),
            _ => return false,
        };
        let mut parts = Vec::new();
        for (on, name) in [
            (self.modifiers.control_key(), "Ctrl"),
            (self.modifiers.alt_key(), "Alt"),
            (self.modifiers.shift_key(), "Shift"),
            (self.modifiers.super_key(), "Meta"),
        ] {
            if on {
                parts.push(name);
            }
        }
        parts.push(&name);
        let joined = parts.join("+");
        let Some(frame) = self.prototype_frame.clone() else {
            return false;
        };
        let scene_frame = self
            .prototype_playback
            .overlay
            .as_ref()
            .map_or(frame.as_str(), |overlay| overlay.id.as_str());
        let found = self.prototype_frame_actions(scene_frame, |trigger| {
            trigger["type"] == "keyPress"
                && trigger["key"].as_str().is_some_and(|key| {
                    let normalize = |key: &str| {
                        let mut keys = key
                            .split('+')
                            .map(|part| match part.trim().to_ascii_lowercase().as_str() {
                                "control" => "ctrl".into(),
                                "option" => "alt".into(),
                                "command" | "cmd" | "super" => "meta".into(),
                                text => text.into(),
                            })
                            .collect::<Vec<String>>();
                        keys.sort_unstable();
                        keys
                    };
                    normalize(key) == normalize(&joined)
                })
        });
        for (source, item) in &found {
            if let Some(actions) = item["actions"].as_array() {
                self.prototype_run(source, actions, false, item, 0);
            }
        }
        !found.is_empty()
    }

    fn prototype_frame_actions(
        &self,
        frame: &str,
        filter: impl Fn(&Value) -> bool,
    ) -> Vec<(String, Value)> {
        let Some(scene) = self.scene.as_ref() else {
            return Vec::new();
        };
        let Some(document) = self.document() else {
            return Vec::new();
        };
        let Some(index) = scene.items.iter().position(|item| item.id == frame) else {
            return Vec::new();
        };
        let mut pending = vec![index];
        let mut results = Vec::new();
        while let Some(index) = pending.pop() {
            let item = &scene.items[index];
            if item.hidden {
                continue;
            }
            if let Some(interactions) = document
                .nodes
                .get(&item.id)
                .and_then(|node| node.properties.get(INTERACTIONS))
                .and_then(Value::as_array)
            {
                results.extend(
                    interactions
                        .iter()
                        .filter(|item| filter(&item["trigger"]))
                        .map(|entry| (item.id.clone(), entry.clone())),
                );
            }
            pending.extend(item.children.iter().rev().copied());
            if results.len() >= 256 {
                break;
            }
        }
        results
    }

    pub(super) fn prototype_enter(&mut self, id: &str) {
        let now = Instant::now();
        self.prototype_playback.background = self
            .prototype_settings()
            .and_then(|settings| settings["background"].as_str())
            .map(str::to_owned);
        self.prototype_playback.queued = self
            .prototype_frame_actions(id, |trigger| trigger["type"] == "afterDelay")
            .into_iter()
            .filter_map(|(source, item)| {
                Some(Pending {
                    at: now + Duration::from_millis(item["trigger"]["ms"].as_u64()?.min(600_000)),
                    frame: id.into(),
                    source,
                    actions: item["actions"].as_array()?.clone(),
                    motion: motion_fields(&item),
                    link_notice: true,
                })
            })
            .collect();
        self.prototype_playback.hover = None;
        self.prototype_playback.pressed = None;
        self.refresh_prototype_scene();
    }

    pub(super) fn refresh_prototype_scene(&mut self) {
        self.automation.preview_generation = self.automation.preview_generation.wrapping_add(1);
        self.schedule_scene();
    }

    pub(super) fn prototype_tick(&mut self) -> Option<Instant> {
        let now = Instant::now();
        let Some(frame) = self.prototype_frame.clone() else {
            return None;
        };
        let mut ready = Vec::new();
        self.prototype_playback.queued.retain(|event| {
            if event.at > now {
                return true;
            }
            if event.frame == frame {
                ready.push((
                    event.source.clone(),
                    event.actions.clone(),
                    event.motion.clone(),
                    event.link_notice,
                ));
            }
            false
        });
        for (source, actions, motion, notice) in ready {
            if self.prototype_frame.as_ref() != Some(&frame) {
                break;
            }
            self.prototype_run(&source, &actions, notice, &motion, 0);
            self.redraw();
        }
        let hotspot = self
            .prototype_playback
            .hotspot
            .map(|at| at + Duration::from_millis(700));
        if hotspot.is_some_and(|at| at <= now) {
            self.prototype_playback.hotspot = None;
            self.redraw();
        }
        let animating = self
            .prototype_playback
            .motion
            .as_ref()
            .filter(|motion| motion.drag.is_none());
        let motion = animating.and_then(|motion| {
            let end = motion.start + motion.duration;
            (end > now).then(|| (now + Duration::from_millis(16)).min(end))
        });
        if animating.is_some() {
            if motion.is_none() {
                self.prototype_playback.motion = None;
            }
            self.redraw();
        }
        self.prototype_playback
            .queued
            .iter()
            .map(|event| event.at)
            .chain(hotspot.filter(|at| *at > now))
            .chain(motion)
            .min()
    }

    fn prototype_eval(&self, expr: &Value, source: &str) -> Option<Literal> {
        let mut environment = Environment::new(self.document()?);
        environment.set_overrides(
            self.prototype_playback.variables.clone(),
            self.prototype_playback.modes.clone(),
        );
        let expr = environment.expression(expr).ok()?;
        environment.evaluate(&expr, Some(source)).ok()
    }

    fn prototype_run(
        &mut self,
        source: &str,
        actions: &[Value],
        notice: bool,
        motion: &Value,
        depth: usize,
    ) {
        if depth > 10 {
            return;
        }
        for action in actions.iter().take(64) {
            match action["type"].as_str() {
                Some("navigate") => {
                    let Some(dest) = action["dest"].as_str() else {
                        continue;
                    };
                    let Some(current) = self.prototype_frame.clone() else {
                        return;
                    };
                    let camera = self.camera;
                    let before = self
                        .scene
                        .as_ref()
                        .and_then(|scene| scene.item(&current))
                        .map(|item| item.bounds);
                    if dest != current && self.show_prototype_frame(dest.into()) {
                        self.start_motion(&current, camera, motion);
                        self.prototype_playback.history.push((current, camera));
                        self.prototype_playback.overlay = None;
                        if action["preserve_scroll"] == true
                            && let (Some([x, y, _, _]), Some(item)) = (
                                before,
                                self.scene.as_ref().and_then(|scene| scene.item(dest)),
                            )
                        {
                            self.camera = Camera {
                                x: camera.x + (x - item.bounds[0]) * camera.zoom,
                                y: camera.y + (y - item.bounds[1]) * camera.zoom,
                                ..camera
                            };
                        }
                    }
                }
                Some("back") => {
                    let before = self.prototype_frame.clone();
                    let prior_camera = self.camera;
                    if self.prototype_playback.overlay.take().is_none()
                        && let Some((frame, camera)) = self.prototype_playback.history.pop()
                        && self.show_prototype_frame(frame)
                    {
                        self.camera = camera;
                        if let Some(frame) = before {
                            self.start_motion(&frame, prior_camera, motion);
                        }
                    }
                }
                Some("scrollTo") => {
                    let Some(item) = action["dest"]
                        .as_str()
                        .and_then(|id| self.scene.as_ref()?.item(id))
                    else {
                        continue;
                    };
                    let x = action["offset"][0].as_f64().unwrap_or(0.);
                    let y = action["offset"][1].as_f64().unwrap_or(0.);
                    self.camera.x = (x - item.bounds[0]) * self.camera.zoom;
                    self.camera.y = (y - item.bounds[1]) * self.camera.zoom;
                }
                Some("openOverlay" | "swapOverlay") => self.open_prototype_overlay(source, action),
                Some("closeOverlay") => {
                    self.prototype_playback.overlay = None;
                }
                Some("openUrl") => {
                    if self.background {
                        self.error = Some(
                            "External links are unavailable in a background automation window."
                                .into(),
                        );
                        continue;
                    }
                    let Some(url) = action["url"].as_str() else {
                        continue;
                    };
                    if (notice || self.prototype_playback.options["linkNotice"] != false)
                        && rfd::MessageDialog::new()
                            .set_title("Open link?")
                            .set_description(format!("This link leaves the prototype.\n{url}"))
                            .set_buttons(rfd::MessageButtons::OkCancel)
                            .show()
                            != rfd::MessageDialogResult::Ok
                    {
                        continue;
                    }
                    if let Err(error) = automation::workspace::open_url(&json!({"url":url})) {
                        self.error = Some(error);
                    }
                }
                Some("setVariable") => {
                    let Some(id) = action["variable"].as_str() else {
                        continue;
                    };
                    if let Some(value) = self.prototype_eval(&action["expr"], source) {
                        let string = self.document().is_some_and(|document| {
                            Environment::new(document)
                                .variable(id)
                                .is_some_and(|(_, kind)| kind == Kind::String)
                        });
                        self.prototype_playback.variables.insert(
                            id.into(),
                            if string {
                                json!(value.text())
                            } else {
                                value.json()
                            },
                        );
                        self.refresh_prototype_scene();
                    }
                }
                Some("setVariableMode") => {
                    if let (Some(collection), Some(mode)) =
                        (action["collection"].as_str(), action["mode"].as_str())
                    {
                        self.prototype_playback
                            .modes
                            .insert(collection.into(), mode.into());
                        self.refresh_prototype_scene();
                    }
                }
                Some("changeTo") => {
                    if let Some(dest) = action["dest"].as_str()
                        && let Some(instance) = self.document().and_then(|document| {
                            crate::prototype::ancestor_instance(document, source)
                        })
                    {
                        self.prototype_playback
                            .variants
                            .insert(instance, dest.into());
                        self.refresh_prototype_scene();
                    }
                }
                Some("conditional") => {
                    if let Some(blocks) = action["blocks"].as_array()
                        && let Some(block) = blocks.iter().find(|block| {
                            block["condition"].is_null()
                                || self.prototype_eval(&block["condition"], source)
                                    == Some(Literal::Boolean(true))
                        })
                        && let Some(actions) = block["actions"].as_array()
                    {
                        self.prototype_run(source, actions, notice, motion, depth + 1);
                    }
                }
                _ => {}
            }
        }
    }

    fn start_motion(&mut self, frame: &str, camera: Camera, interaction: &Value) {
        let kind = interaction["transition"]["type"]
            .as_str()
            .unwrap_or("instant");
        let duration = interaction["duration_ms"]
            .as_u64()
            .unwrap_or(300)
            .min(600_000);
        self.prototype_playback.motion = if kind == "instant" || duration == 0 {
            None
        } else {
            Some(Motion {
                frame: frame.into(),
                camera,
                kind: kind.into(),
                direction: interaction["transition"]["direction"]
                    .as_str()
                    .unwrap_or("left")
                    .into(),
                start: Instant::now(),
                duration: Duration::from_millis(duration),
                easing: interaction["easing"].clone(),
                drag: None,
                matches: if kind == "smartAnimate" {
                    self.scene
                        .as_ref()
                        .zip(self.prototype_frame.as_deref())
                        .map_or_else(Vec::new, |(scene, to)| motion_pairs(scene, frame, to))
                } else {
                    Vec::new()
                },
            })
        };
    }

    fn open_prototype_overlay(&mut self, source: &str, action: &Value) {
        let Some(scene) = self.scene.as_ref() else {
            return;
        };
        let Some(id) = action["dest"].as_str() else {
            return;
        };
        let Some(item) = scene.item(id).filter(|item| !item.hidden) else {
            return;
        };
        let width = item.bounds[2] * self.camera.zoom;
        let height = item.bounds[3] * self.camera.zoom;
        let canvas = self.canvas_rect();
        let anchor = action["anchor"].as_str().unwrap_or("screen");
        let area = if anchor != "screen" {
            scene
                .item(source)
                .map(|item| {
                    let [x, y, w, h] = item.bounds;
                    Rect::new(
                        canvas.x + self.camera.x + x * self.camera.zoom,
                        canvas.y + self.camera.y + y * self.camera.zoom,
                        w * self.camera.zoom,
                        h * self.camera.zoom,
                    )
                })
                .unwrap_or(canvas)
        } else {
            canvas
        };
        let position = action["position"].as_str().unwrap_or("center");
        let mut x = if position.ends_with("Left") {
            area.x
        } else if position.ends_with("Right") {
            area.x + area.width - width
        } else {
            area.x + (area.width - width) / 2.
        };
        let mut y = if position.starts_with("top") {
            area.y
                - if anchor == "triggerOutside" {
                    height
                } else {
                    0.
                }
        } else if position.starts_with("bottom") {
            area.y + area.height
                - if anchor == "triggerOutside" {
                    0.
                } else {
                    height
                }
        } else {
            area.y + (area.height - height) / 2.
        };
        if position == "manual" {
            x = area.x + action["offset"][0].as_f64().unwrap_or(0.) * self.camera.zoom;
            y = area.y
                + action["offset"][1]
                    .as_f64()
                    .map_or(area.height, |offset| offset * self.camera.zoom);
        }
        if action["type"] == "swapOverlay"
            && let Some(existing) = &self.prototype_playback.overlay
        {
            x = existing.rect.x;
            y = existing.rect.y;
        }
        self.prototype_playback.overlay = Some(Overlay {
            id: id.into(),
            rect: Rect::new(x, y, width, height),
            tint: action["background"].as_str().map(str::to_owned),
            close_outside: action["close_on_outside"] != false,
        });
    }
}

fn motion_fields(interaction: &Value) -> Value {
    json!({"transition":interaction["transition"],"duration_ms":interaction["duration_ms"],"easing":interaction["easing"]})
}
