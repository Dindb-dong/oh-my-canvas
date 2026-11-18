mod video;

use super::*;
use omc_render::{PROCEDURAL_SHADER_PROPERTY, ProceduralShader};
use omc_scene::{Affine, Scene};
use omc_style::Diagnostic;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use skia_safe::{Color, EncodedImageFormat, Matrix, Surface, surfaces};

const TRACKS: &str = "motionTracks";
const MAX_TIME_MS: u32 = 120_000;
const MAX_KEYFRAMES: usize = 128;
const MAX_ACTIVE_TRACKS: usize = 1024;

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "camelCase")]
enum Property {
    TranslateX,
    TranslateY,
    Rotation,
    Opacity,
}
#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
enum Easing {
    #[default]
    Linear,
    EaseIn,
    EaseOut,
    EaseInOut,
    Step,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Keyframe {
    time_ms: u32,
    value: f64,
    #[serde(default)]
    easing: Easing,
}
type Tracks = BTreeMap<Property, Vec<Keyframe>>;

pub(crate) fn definition() -> Value {
    json!({
        "name": "native_motion",
        "description": "Edit persisted layer motion tracks, inspect keyframes, render a PNG at a selected time, edit a procedural stripe overlay, or encode a short MP4 with an available local FFmpeg encoder. Translation uses parent-space pixels; rotation uses degrees relative to the authored pose. Opacity is absolute. Easing belongs to the interval after its keyframe.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "version": {"type":"string","enum":["1"]},
                "action": {"type":"string","enum":["capabilities","inspect","set_track","remove_track","set_shader","clear_shader","sample","export_video"]},
                "documentId": {"type":"string"},
                "nodeId": {"type":"string"},
                "frameId": {"type":"string"},
                "property": {"type":"string","enum":["translateX","translateY","rotation","opacity"]},
                "timeMs": {"type":"number","minimum":0,"maximum":MAX_TIME_MS},
                "startMs": {"type":"integer","minimum":0,"maximum":MAX_TIME_MS},
                "durationMs": {"type":"integer","minimum":100,"maximum":video::MAX_DURATION_MS},
                "fps": {"type":"integer","minimum":1,"maximum":video::MAX_FPS},
                "filePath": {"type":"string","minLength":1,"maxLength":4096},
                "overwrite": {"type":"boolean"},
                "shader": {"type":"object","properties":{
                    "kind":{"type":"string","enum":["stripes"]},
                    "colors":{"type":"array","minItems":2,"maxItems":2,"items":{"type":"string","minLength":1,"maxLength":64}},
                    "periodPx":{"type":"number","minimum":2,"maximum":4096},
                    "angleDeg":{"type":"number","minimum":-360,"maximum":360},
                    "phasePx":{"type":"number","minimum":-4096,"maximum":4096},
                    "speedPxPerSecond":{"type":"number","minimum":-2048,"maximum":2048}
                },"required":["kind","colors","periodPx"],"additionalProperties":false},
                "revision": {"type":"integer","minimum":0},
                "keyframes": {"type":"array","minItems":1,"maxItems":MAX_KEYFRAMES,"items":{
                    "type":"object",
                    "properties":{
                        "timeMs":{"type":"integer","minimum":0,"maximum":MAX_TIME_MS},
                        "value":{"type":"number"},
                        "easing":{"type":"string","enum":["linear","easeIn","easeOut","easeInOut","step"]}
                    },
                    "required":["timeMs","value"],
                    "additionalProperties":false
                }}
            },
            "required":["version","action"],
            "anyOf":[
                {"type":"object","properties":{"action":{"enum":["capabilities"]}}},
                {"type":"object","properties":{"action":{"enum":["inspect"]}},"required":["documentId","nodeId"]},
                {"type":"object","properties":{"action":{"enum":["set_track"]}},"required":["documentId","nodeId","property","keyframes"]},
                {"type":"object","properties":{"action":{"enum":["remove_track"]}},"required":["documentId","nodeId","property"]},
                {"type":"object","properties":{"action":{"enum":["set_shader"]}},"required":["documentId","nodeId","shader"]},
                {"type":"object","properties":{"action":{"enum":["clear_shader"]}},"required":["documentId","nodeId"]},
                {"type":"object","properties":{"action":{"enum":["sample"]}},"required":["documentId","frameId","timeMs"]},
                {"type":"object","properties":{"action":{"enum":["export_video"]}},"required":["documentId","frameId","durationMs"]}
            ],
            "additionalProperties":false
        }
    })
}

impl ToolRouter {
    pub(crate) fn native_motion(&self, session: &str, args: &Value, meta: &Value) -> Result<Value> {
        let action = string(args, "action")?;
        if action == "capabilities" {
            let available = video::available();
            return Ok(
                json!({"ok":true,"png":true,"proceduralShaders":["stripes"],"mp4":{
                    "available":available,"encoder":available.then_some("libx264"),
                    "reason":(!available).then_some("Local FFmpeg with libx264 was not found")
                }}),
            );
        }
        let id = native_id(string(args, "documentId")?)?;
        self.workspace.document_path(&id)?;
        if self.state(session, &id).is_err() {
            self.context(session, &id)?;
        }
        let edit = matches!(
            action,
            "set_track" | "remove_track" | "set_shader" | "clear_shader"
        );
        if edit && let Some(result) = self.replay(session, &id, meta)? {
            return Ok(result);
        }
        let snapshot = self.workspace.snapshot(&id)?;
        if let Some(expected) = args["revision"].as_u64()
            && expected != snapshot.sequence
        {
            return Err(EngineError::new(
                "conflict",
                "motion target revision changed",
            ));
        }
        if matches!(action, "sample" | "export_video") {
            let frame = self.resolve(session, &id, string(args, "frameId")?)?;
            if action == "export_video" {
                return video::export_video(self, session, &snapshot, &frame, args);
            }
            let time_ms = args["timeMs"]
                .as_f64()
                .ok_or_else(|| EngineError::invalid("sample time required"))?;
            let mut prepared = Prepared::new(&snapshot, &frame)?;
            let (mut surface, diagnostics, sampled) =
                prepared.paint(time_ms, &self.resources()?, Color::TRANSPARENT)?;
            let bytes = surface
                .image_snapshot()
                .encode(None, EncodedImageFormat::PNG, 100)
                .ok_or_else(|| EngineError::new("internal_error", "motion PNG encoding failed"))?
                .as_bytes()
                .to_vec();
            let mut result = self.deliver_export(
                session,
                args,
                export(&snapshot, bytes, "png", "image/png", diagnostics),
            )?;
            result["mimeType"] = json!("image/png");
            result["frameId"] = json!(frame);
            result["timeMs"] = json!(time_ms);
            result["width"] = json!(prepared.width);
            result["height"] = json!(prepared.height);
            result["values"] = json!(sampled);
            return Ok(result);
        }

        let node_id = self.resolve(session, &id, string(args, "nodeId")?)?;
        let node = snapshot
            .nodes
            .get(&node_id)
            .filter(|node| node.parent_id.is_some())
            .ok_or_else(|| {
                EngineError::invalid("motion layer must be an authored layer in this document")
            })?;
        let mut tracks = read_tracks(node)?;
        if !edit {
            return Ok(
                json!({"ok":true,"nodeId":node_id,"tracks":tracks,"shader":node.properties.get(PROCEDURAL_SHADER_PROPERTY),"revision":snapshot.revision()}),
            );
        }
        let mut current = Some(node);
        while let Some(parent) = current {
            if parent.properties.get("locked") == Some(&Value::Bool(true)) {
                return Err(EngineError::invalid("motion layer is locked"));
            }
            current = parent
                .parent_id
                .as_ref()
                .and_then(|id| snapshot.nodes.get(id));
        }
        if matches!(action, "set_shader" | "clear_shader") {
            let (command, shader) = if action == "set_shader" {
                if !ProceduralShader::supports(node.kind) {
                    return Err(EngineError::invalid(
                        "procedural shader requires a fillable shape",
                    ));
                }
                let shader =
                    ProceduralShader::parse(&args["shader"]).map_err(EngineError::invalid)?;
                let value = json!(shader);
                (
                    Command::NodeSet {
                        node_id: node_id.clone(),
                        properties: Properties::from([(
                            PROCEDURAL_SHADER_PROPERTY.into(),
                            value.clone(),
                        )]),
                    },
                    value,
                )
            } else {
                if !node.properties.contains_key(PROCEDURAL_SHADER_PROPERTY) {
                    return Err(EngineError::invalid("layer has no procedural shader"));
                }
                (
                    Command::NodeUnset {
                        node_id: node_id.clone(),
                        properties: vec![PROCEDURAL_SHADER_PROPERTY.into()],
                    },
                    Value::Null,
                )
            };
            return self.submit_with_output(
                session,
                &id,
                command,
                meta,
                Some(snapshot.sequence),
                Properties::from([("nodeId".into(), json!(node_id)), ("shader".into(), shader)]),
            );
        }
        let property: Property = decode(&args["property"])?;
        let command = if action == "set_track" {
            let keyframes: Vec<Keyframe> = decode(&args["keyframes"])?;
            validate_track(property, &keyframes)?;
            tracks.insert(property, keyframes);
            Command::NodeSet {
                node_id: node_id.clone(),
                properties: Properties::from([(TRACKS.into(), json!(tracks))]),
            }
        } else {
            if tracks.remove(&property).is_none() {
                return Err(EngineError::invalid("motion track does not exist"));
            }
            if tracks.is_empty() {
                Command::NodeUnset {
                    node_id: node_id.clone(),
                    properties: vec![TRACKS.into()],
                }
            } else {
                Command::NodeSet {
                    node_id: node_id.clone(),
                    properties: Properties::from([(TRACKS.into(), json!(tracks))]),
                }
            }
        };
        self.submit_with_output(
            session,
            &id,
            command,
            meta,
            Some(snapshot.sequence),
            Properties::from([
                ("nodeId".into(), json!(node_id)),
                ("tracks".into(), json!(tracks)),
            ]),
        )
    }
}

fn export(
    snapshot: &DocumentSnapshot,
    bytes: Vec<u8>,
    extension: &str,
    media_type: &str,
    diagnostics: Vec<Diagnostic>,
) -> omc_export::ExportArtifact {
    omc_export::ExportArtifact {
        sha256: hex::encode(Sha256::digest(&bytes)),
        bytes,
        extension: extension.into(),
        media_type: media_type.into(),
        diagnostics,
        epoch: snapshot.epoch.clone(),
        sequence: snapshot.sequence,
    }
}

fn decode<T: serde::de::DeserializeOwned>(value: &Value) -> Result<T> {
    serde_json::from_value(value.clone())
        .map_err(|e| EngineError::invalid(format!("Invalid motion data: {e}")))
}

fn read_tracks(node: &Node) -> Result<Tracks> {
    let Some(stored) = node.properties.get(TRACKS) else {
        return Ok(Tracks::new());
    };
    let tracks: Tracks = decode(stored)?;
    for (&property, keyframes) in &tracks {
        validate_track(property, keyframes)?;
    }
    Ok(tracks)
}

fn validate_track(property: Property, keyframes: &[Keyframe]) -> Result<()> {
    if !(1..=MAX_KEYFRAMES).contains(&keyframes.len())
        || keyframes
            .windows(2)
            .any(|pair| pair[0].time_ms >= pair[1].time_ms)
        || keyframes.iter().any(|frame| {
            frame.time_ms > MAX_TIME_MS
                || !match property {
                    Property::TranslateX | Property::TranslateY => {
                        (-100_000. ..=100_000.).contains(&frame.value)
                    }
                    Property::Rotation => (-36_000. ..=36_000.).contains(&frame.value),
                    Property::Opacity => (0. ..=1.).contains(&frame.value),
                }
        })
    {
        return Err(EngineError::invalid(
            "motion keyframes require increasing unique times and bounded property values",
        ));
    }
    Ok(())
}

fn sample(keyframes: &[Keyframe], time_ms: f64) -> f64 {
    let next = keyframes.partition_point(|frame| f64::from(frame.time_ms) <= time_ms);
    match next {
        0 => keyframes[0].value,
        n if n == keyframes.len() => keyframes[n - 1].value,
        n => {
            let (a, b) = (&keyframes[n - 1], &keyframes[n]);
            let t = (time_ms - f64::from(a.time_ms)) / f64::from(b.time_ms - a.time_ms);
            let t = match a.easing {
                Easing::Linear => t,
                Easing::EaseIn => t * t,
                Easing::EaseOut => t * (2. - t),
                Easing::EaseInOut => t * t * (3. - 2. * t),
                Easing::Step => 0.,
            };
            a.value + (b.value - a.value) * t
        }
    }
}

struct Prepared {
    scene: Scene,
    frame: String,
    camera: Affine,
    width: i32,
    height: i32,
    tracks: Vec<(usize, Tracks)>,
}

impl Prepared {
    fn new(snapshot: &DocumentSnapshot, frame: &str) -> Result<Self> {
        let page = figcraft_catalog::node_page(snapshot, frame)
            .filter(|page| page.root_node_id != frame)
            .ok_or_else(|| EngineError::invalid("motion frame is not in this document"))?;
        let scene = paths::scene(snapshot, &page.id)?;
        let frame_index = scene
            .items
            .iter()
            .position(|item| item.id == frame && item.kind == omc_model::NodeKind::Frame)
            .ok_or_else(|| EngineError::invalid("motion needs an authored frame"))?;
        let item = &scene.items[frame_index];
        if std::iter::successors(Some(item), |item| {
            item.parent.map(|index| &scene.items[index])
        })
        .any(|item| item.hidden)
        {
            return Err(EngineError::invalid("motion frame is hidden"));
        }
        let [width, height] = [item.width.ceil(), item.height.ceil()];
        if !(1. ..=4096.).contains(&width)
            || !(1. ..=4096.).contains(&height)
            || width * height > 8_000_000.
        {
            return Err(EngineError::new(
                "resource_limit",
                "motion frame exceeds the render surface budget",
            ));
        }
        let camera = item
            .world
            .inverse()
            .ok_or_else(|| EngineError::invalid("motion frame transform is singular"))?;
        let mut pending = vec![frame_index];
        let mut tracks = Vec::new();
        let mut track_count = 0;
        while let Some(index) = pending.pop() {
            let child = &scene.items[index];
            if child.hidden {
                continue;
            }
            if let Some(node) = snapshot.nodes.get(&child.id)
                && node.properties.contains_key(TRACKS)
            {
                let set = read_tracks(node)?;
                track_count += set.len();
                if track_count > MAX_ACTIVE_TRACKS {
                    return Err(EngineError::new(
                        "resource_limit",
                        "motion frame exceeds the active track limit",
                    ));
                }
                if !set.is_empty() {
                    tracks.push((index, set));
                }
            }
            pending.extend(&child.children);
        }
        Ok(Self {
            scene,
            frame: frame.into(),
            camera,
            width: width as i32,
            height: height as i32,
            tracks,
        })
    }

    fn paint(
        &mut self,
        time_ms: f64,
        resources: &dyn omc_render::ResourceProvider,
        background: Color,
    ) -> Result<(Surface, Vec<Diagnostic>, Value)> {
        self.scene.time_ms = time_ms;
        let mut poses = BTreeMap::new();
        let mut sampled = serde_json::Map::new();
        for (index, tracks) in &self.tracks {
            let item = &mut self.scene.items[*index];
            let values: BTreeMap<_, _> = tracks
                .iter()
                .map(|(&property, keyframes)| (property, sample(keyframes, time_ms)))
                .collect();
            let val = |key| values.get(&key).copied().unwrap_or(0.);
            let mut local =
                Affine::translation(val(Property::TranslateX), val(Property::TranslateY))
                    .multiply(item.local);
            let angle = val(Property::Rotation).to_radians();
            if angle != 0. {
                let (sin, cos) = angle.sin_cos();
                let (x, y) = (item.width / 2., item.height / 2.);
                local = local
                    .multiply(Affine::translation(x, y))
                    .multiply(Affine([cos, sin, -sin, cos, 0., 0.]))
                    .multiply(Affine::translation(-x, -y));
            }
            if local != item.local {
                poses.insert(item.id.clone(), local);
            }
            if let Some(opacity) = values.get(&Property::Opacity) {
                item.style
                    .values
                    .insert("opacity".into(), opacity.to_string());
            }
            sampled.insert(item.id.clone(), json!(values));
        }
        let mut surface = surfaces::raster_n32_premul((self.width, self.height))
            .ok_or_else(|| EngineError::new("resource_limit", "motion frame allocation failed"))?;
        let canvas = surface.canvas();
        canvas.clear(background);
        let [a, b, c, d, x, y] = self.camera.0.map(|value| value as f32);
        canvas.concat(&Matrix::new_all(a, c, x, b, d, y, 0., 0., 1.));
        let diagnostics =
            omc_render::paint_scene_frame_pose(canvas, &self.scene, &self.frame, resources, &poses)
                .map_err(|error| EngineError::invalid(error.to_string()))?;
        Ok((surface, diagnostics, Value::Object(sampled)))
    }
}
