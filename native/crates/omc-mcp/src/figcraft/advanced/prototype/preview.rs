use super::*;
use omc_style::prototype::{Environment, Kind, Literal, Modes, Overrides, SETTINGS};

const MAX_PENDING: usize = 256;
const MAX_ACTIONS: usize = 4096;

struct Pending {
    at: u64,
    source: String,
    actions: Vec<Value>,
}

struct Playback<'a> {
    document: &'a DocumentSnapshot,
    root: &'a str,
    at: u64,
    frame: String,
    overlay: Option<String>,
    history: Vec<String>,
    variables: Overrides,
    modes: Modes,
    variants: BTreeMap<String, String>,
    scroll: Option<Value>,
    requested_urls: Vec<String>,
    pending: Vec<Pending>,
    actions: usize,
}

pub(super) fn preview(
    router: &ToolRouter,
    session: &str,
    snapshot: &DocumentSnapshot,
    page_id: &str,
    page_root: &str,
    frame: &str,
    args: &Value,
) -> Result<Properties> {
    let mut state = Playback {
        document: snapshot,
        root: page_root,
        at: 0,
        frame: frame.into(),
        overlay: None,
        history: Vec::new(),
        variables: Overrides::new(),
        modes: Modes::new(),
        variants: BTreeMap::new(),
        scroll: None,
        requested_urls: Vec::new(),
        pending: Vec::new(),
        actions: 0,
    };
    state.enter(frame)?;
    let mut steps = Vec::new();
    if let Some(events) = args["events"].as_array() {
        for event in events {
            let at = event["atMs"]
                .as_u64()
                .ok_or_else(|| EngineError::invalid("Playback events require atMs"))?;
            state.advance(at)?;
            if let Some(trigger) = event["trigger"].as_str() {
                let source = router.resolve(session, &snapshot.id, string(event, "sourceId")?)?;
                state.dispatch(&source, trigger, event["key"].as_str())?;
            } else if event.get("sourceId").is_some() || event.get("key").is_some() {
                return Err(EngineError::invalid("An input event requires a trigger"));
            }
            steps.push(state.readback());
        }
    }
    state.advance(args["untilMs"].as_u64().unwrap_or(state.at))?;
    let mut result = properties(&state.readback())?;
    result.insert("steps".into(), json!(steps));
    if args["render"] == true {
        let document = state.render_document();
        let scene = paths::scene(&document, page_id)?;
        let resources = router.resources()?;
        let render = |id: &str| rendered_frame(&scene, id, &resources);
        let frame = render(&state.frame)?;
        let overlay = state.overlay.as_deref().map(render).transpose()?;
        let store = |mut output: FrameImage| -> Result<Value> {
            output.properties["resultId"] = json!(router.extensions.put_result(
                session,
                output.image,
                "image/png".into(),
            )?);
            Ok(output.properties)
        };
        result.insert("frameImage".into(), store(frame)?);
        if let Some(image) = overlay {
            result.insert("overlayImage".into(), store(image)?);
        }
    }
    Ok(result)
}

impl Playback<'_> {
    fn readback(&self) -> Value {
        json!({
            "atMs":self.at,"frameId":self.frame,"overlayId":self.overlay,"history":self.history,
            "variables":self.variables,"modes":self.modes,"variants":self.variants,
            "scrollTarget":self.scroll,"requestedUrls":self.requested_urls,
            "pending":self.pending.len(),"documentRevision":self.document.revision()
        })
    }

    fn enter(&mut self, frame: &str) -> Result<()> {
        if !super::native::visible_frame(self.document, self.root, frame) {
            return Err(EngineError::invalid(
                "Choose a visible prototype frame on the selected page",
            ));
        }
        self.frame = frame.into();
        self.overlay = None;
        self.scroll = None;
        self.pending.clear();
        let mut layers = vec![&self.document.nodes[frame]];
        while let Some(node) = layers.pop() {
            if super::native::hidden(node) {
                continue;
            }
            for interaction in super::super::prototype_actions::stored(node) {
                if interaction["trigger"]["type"] == "afterDelay"
                    && let Some(delay) = interaction["trigger"]["ms"].as_u64()
                    && let Some(actions) = interaction["actions"].as_array()
                {
                    self.schedule(&node.id, delay, actions.clone())?;
                }
            }
            layers.extend(children(self.document, &node.id).into_iter().rev());
        }
        Ok(())
    }

    fn schedule(&mut self, source: &str, delay: u64, actions: Vec<Value>) -> Result<()> {
        if self.pending.len() >= MAX_PENDING {
            return Err(EngineError::new(
                "resource_limit",
                "Too many pending prototype events",
            ));
        }
        self.pending.push(Pending {
            at: self.at + delay.min(600_000),
            source: source.into(),
            actions,
        });
        Ok(())
    }

    fn advance(&mut self, at: u64) -> Result<()> {
        if at < self.at || at > 600_000 {
            return Err(EngineError::invalid(
                "Playback times must be ordered and at most 600000 ms",
            ));
        }
        while let Some((next, _)) = self
            .pending
            .iter()
            .enumerate()
            .filter(|(_, event)| event.at <= at)
            .min_by_key(|(_, event)| event.at)
        {
            let event = self.pending.remove(next);
            self.at = event.at;
            self.run(&event.source, &event.actions, 0)?;
        }
        self.at = at;
        Ok(())
    }

    fn dispatch(&mut self, source: &str, trigger: &str, key: Option<&str>) -> Result<()> {
        if trigger == "keyPress" && key.is_none() {
            return Err(EngineError::invalid("keyPress needs a key"));
        }
        let active = self.overlay.as_deref().unwrap_or(&self.frame);
        let mut node = self
            .document
            .nodes
            .get(source)
            .ok_or_else(|| EngineError::invalid("Playback source is missing"))?;
        let mut nearest = None;
        loop {
            if super::native::hidden(node) {
                return Err(EngineError::invalid("Playback source is hidden"));
            }
            if nearest.is_none() {
                let entries = super::super::prototype_actions::stored(node)
                    .into_iter()
                    .filter(|item| {
                        item["trigger"]["type"] == trigger
                            && (trigger != "keyPress" || item["trigger"]["key"].as_str() == key)
                    })
                    .collect::<Vec<_>>();
                if !entries.is_empty() {
                    nearest = Some((node.id.clone(), entries));
                }
            }
            if node.id == active {
                break;
            }
            node = node
                .parent_id
                .as_ref()
                .and_then(|id| self.document.nodes.get(id))
                .ok_or_else(|| {
                    EngineError::invalid("Playback source is outside the active frame or overlay")
                })?;
        }
        if let Some((source, entries)) = nearest {
            for entry in entries {
                if let Some(actions) = entry["actions"].as_array() {
                    let delay = entry["delay_ms"].as_u64().unwrap_or(0);
                    if delay == 0 {
                        self.run(&source, actions, 0)?;
                    } else {
                        self.schedule(&source, delay, actions.clone())?;
                    }
                }
            }
        }
        Ok(())
    }

    fn evaluate(&self, expr: &Value, source: &str) -> Result<Literal> {
        let mut env = Environment::new(self.document);
        env.set_overrides(self.variables.clone(), self.modes.clone());
        let expr = env.expression(expr).map_err(EngineError::invalid)?;
        env.evaluate(&expr, Some(source))
            .map_err(EngineError::invalid)
    }

    fn run(&mut self, source: &str, actions: &[Value], depth: usize) -> Result<()> {
        if depth > 10 || self.actions + actions.len() > MAX_ACTIONS {
            return Err(EngineError::new(
                "resource_limit",
                "Prototype playback action limit reached",
            ));
        }
        self.actions += actions.len();
        for action in actions {
            let dest = || string(action, "dest");
            match action["type"].as_str() {
                Some("navigate") => {
                    let dest = dest()?;
                    if dest != self.frame {
                        let previous = self.frame.clone();
                        self.enter(dest)?;
                        self.history.push(previous);
                    }
                }
                Some("back") => {
                    if self.overlay.take().is_none()
                        && let Some(frame) = self.history.pop()
                    {
                        self.enter(&frame)?;
                    }
                }
                Some("openOverlay" | "swapOverlay") => {
                    let dest = dest()?;
                    if !super::native::visible_frame(self.document, self.root, dest) {
                        return Err(EngineError::invalid("Overlay destination is unavailable"));
                    }
                    self.overlay = Some(dest.into());
                }
                Some("closeOverlay") => self.overlay = None,
                Some("scrollTo") => {
                    self.scroll = Some(json!({"id":dest()?,"offset":action["offset"]}));
                }
                Some("openUrl") => self.requested_urls.push(string(action, "url")?.into()),
                Some("setVariable") => {
                    let id = string(action, "variable")?;
                    let value = self.evaluate(&action["expr"], source)?;
                    let kind = Environment::new(self.document)
                        .variable(id)
                        .map(|(_, kind)| kind);
                    self.variables.insert(
                        id.into(),
                        if kind == Some(Kind::String) {
                            json!(value.text())
                        } else {
                            value.json()
                        },
                    );
                }
                Some("setVariableMode") => {
                    self.modes.insert(
                        string(action, "collection")?.into(),
                        string(action, "mode")?.into(),
                    );
                }
                Some("changeTo") => {
                    let mut node = self.document.nodes.get(source);
                    while let Some(layer) = node {
                        if layer.kind == NodeKind::Instance {
                            self.variants.insert(layer.id.clone(), dest()?.into());
                            break;
                        }
                        node = layer
                            .parent_id
                            .as_ref()
                            .and_then(|id| self.document.nodes.get(id));
                    }
                }
                Some("conditional") => {
                    if let Some(blocks) = action["blocks"].as_array() {
                        for block in blocks {
                            if block["condition"].is_null()
                                || self.evaluate(&block["condition"], source)?
                                    == Literal::Boolean(true)
                            {
                                if let Some(actions) = block["actions"].as_array() {
                                    self.run(source, actions, depth + 1)?;
                                }
                                break;
                            }
                        }
                    }
                }
                _ => {
                    return Err(EngineError::invalid(
                        "Unsupported prototype action in playback",
                    ));
                }
            }
        }
        Ok(())
    }

    fn render_document(&self) -> DocumentSnapshot {
        let mut document = self.document.clone();
        let settings = document.nodes[self.root]
            .properties
            .get(SETTINGS)
            .cloned()
            .unwrap_or_default();
        if settings["responsive"] == true {
            let frame = document.nodes.get_mut(&self.frame).unwrap();
            for key in ["width", "height"] {
                if let Some(value) = settings["screen"].get(key) {
                    frame.properties.insert(key.into(), value.clone());
                }
            }
        }
        for (id, value) in &self.variables {
            let key = format!("tokens/{id}/");
            document
                .metadata
                .insert(format!("{key}value"), value.clone());
            if let Some(modes) = document
                .metadata
                .get_mut(&format!("{key}modes"))
                .and_then(Value::as_object_mut)
            {
                for mode in modes.values_mut() {
                    *mode = value.clone();
                }
            }
        }
        for node in document.nodes.values_mut() {
            if !self.modes.is_empty()
                && let Some(values) = node
                    .properties
                    .entry("figcraftVariableModes".into())
                    .or_insert_with(|| json!({}))
                    .as_object_mut()
            {
                values.extend(
                    self.modes
                        .iter()
                        .map(|(key, value)| (key.clone(), json!(value))),
                );
            }
            if let Some(variant) = self.variants.get(&node.id) {
                node.properties.insert("componentId".into(), json!(variant));
            }
        }
        document
    }
}

struct FrameImage {
    image: Vec<u8>,
    properties: Value,
}

fn rendered_frame(
    scene: &omc_scene::Scene,
    id: &str,
    resources: &impl omc_render::ResourceProvider,
) -> Result<FrameImage> {
    let frame = scene
        .item(id)
        .ok_or_else(|| EngineError::invalid("Playback frame is missing from the scene"))?;
    let [x, y, width, height] = frame.bounds;
    let (width, height) = (width.ceil(), height.ceil());
    if !(1. ..=4096.).contains(&width) || !(1. ..=4096.).contains(&height) {
        return Err(EngineError::new(
            "resource_limit",
            "Rendered playback is limited to frames up to 4096 × 4096 pixels",
        ));
    }
    let mut surface = skia_safe::surfaces::raster_n32_premul((width as i32, height as i32))
        .ok_or_else(|| EngineError::invalid("Could not allocate playback image"))?;
    let canvas = surface.canvas();
    canvas.clear(skia_safe::Color::TRANSPARENT);
    canvas.translate((-x as f32, -y as f32));
    let diagnostics = omc_render::paint_scene_frame(canvas, scene, id, resources)
        .map_err(|error| EngineError::invalid(error.to_string()))?;
    let data = surface
        .image_snapshot()
        .encode(None, skia_safe::EncodedImageFormat::PNG, 100)
        .ok_or_else(|| EngineError::invalid("Could not encode playback image"))?;
    Ok(FrameImage {
        image: data.as_bytes().to_vec(),
        properties: json!({
            "id":id,"width":width,"height":height,"diagnostics":diagnostics,
        }),
    })
}
