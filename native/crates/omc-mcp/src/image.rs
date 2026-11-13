use super::{Command, EngineError, Result, ToolRouter, Value, json, properties, string};
use omc_assets::AssetStore;
use omc_model::{DocumentSnapshot, Node, NodeKind};
use sha2::{Digest, Sha256};
use skia_safe::{AlphaType, Codec, ColorSpace, ColorType, Data, FilterMode, ImageInfo, Pixmap};
use std::io::{Cursor, Read};
use std::path::PathBuf;
use std::sync::Mutex;
use tract_onnx::prelude::*;

const SIDE: usize = 320;
const MAX_BYTES: usize = 16 * 1024 * 1024;
const MODEL_BYTES: usize = 4_574_861;
const MODEL_SHA256: &str = "309c8469258dda742793dce0ebea8e6dd393174f89934733ecc8b14c76f4ddd8";

static INFERENCE: Mutex<()> = Mutex::new(());

impl ToolRouter {
    pub(super) fn image_operation(
        &self,
        session: &str,
        document: &str,
        args: &Value,
        meta: &Value,
    ) -> Result<Value> {
        let node_id = self.resolve(session, document, string(args, "id")?)?;
        let alias = self.alias(session, document, &node_id);
        let response = |mut result: Value| {
            result["id"] = json!(alias);
            result["rawId"] = json!(node_id);
            result
        };
        if let Some(result) = self.replay(session, document, meta)? {
            return Ok(response(result));
        }

        let snapshot = self.workspace.snapshot(document)?;
        if args["revision"].as_u64() != Some(snapshot.sequence) {
            return Err(EngineError::new(
                "stale_revision",
                "document changed; refresh the revision before editing the image",
            ));
        }
        let node = snapshot
            .nodes
            .get(&node_id)
            .filter(|node| node.kind == NodeKind::Image)
            .ok_or_else(|| EngineError::invalid("choose a raster image layer"))?;
        check_editable(&snapshot, node, &self.state(session, document)?.root)?;
        let current_hash = image_hash(node)
            .ok_or_else(|| EngineError::invalid("image layer needs an immutable raster asset"))?;
        let original = node.properties.get("originalImage");
        let assets = AssetStore::open(&self.workspace.profile)?;
        let command = if args["action"] == "restore" {
            let Some(original) = original else {
                return Ok(response(json!({
                    "ok": true, "revision": snapshot.sequence, "changed": false
                })));
            };
            let hash = original
                .get("assetHash")
                .and_then(Value::as_str)
                .ok_or_else(|| EngineError::invalid("original image asset is unavailable"))?;
            assets.read(hash)?;
            Command::Batch {
                commands: vec![
                    Command::NodeSet {
                        node_id: node_id.clone(),
                        properties: properties(&json!({"assetHash":hash}))?,
                    },
                    Command::NodeUnset {
                        node_id: node_id.clone(),
                        properties: vec!["originalImage".into()],
                    },
                ],
            }
        } else {
            let _inference = INFERENCE.try_lock().map_err(|_| {
                EngineError::new("busy", "local background removal is already running")
            })?;
            let model = verified_model()?;
            let png = remove_background(&assets.read(current_hash)?, &model)?;
            self.workspace.session(session)?;
            let removed = assets.ingest(&png, "image/png")?;
            let original = original
                .cloned()
                .unwrap_or_else(|| json!({"assetHash":current_hash}));
            Command::NodeSet {
                node_id: node_id.clone(),
                properties: properties(
                    &json!({"assetHash":removed.hash,"originalImage":original}),
                )?,
            }
        };

        let result = self.submit(session, document, command, meta, Some(snapshot.sequence))?;
        Ok(response(result))
    }
}

fn image_hash(node: &Node) -> Option<&str> {
    node.string("assetHash")
        .or_else(|| node.string("imageHash"))
        .or_else(|| node.properties.get("image")?.get("hash")?.as_str())
}

fn check_editable(snapshot: &DocumentSnapshot, node: &Node, page_root: &str) -> Result<()> {
    let mut current = node;
    for _ in 0..snapshot.nodes.len() {
        if current.properties.get("locked") == Some(&Value::Bool(true))
            || current.properties.get("hidden") == Some(&Value::Bool(true))
            || current.properties.get("visible") == Some(&Value::Bool(false))
        {
            return Err(EngineError::invalid(
                "image or its ancestor is locked or hidden",
            ));
        }
        if current.id == page_root {
            return Ok(());
        }
        current = current
            .parent_id
            .as_ref()
            .and_then(|id| snapshot.nodes.get(id))
            .ok_or_else(|| EngineError::invalid("image is outside the selected page"))?;
    }
    Err(EngineError::invalid("image ancestry contains a cycle"))
}

fn model_path() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("OMC_BACKGROUND_MODEL") {
        return Some(path.into());
    }
    let exe = std::env::current_exe().ok()?;
    let directory = exe.parent()?;
    [
        directory.join("background-removal/u2netp.onnx"),
        directory.join("../Resources/background-removal/u2netp.onnx"),
    ]
    .into_iter()
    .find(|path| path.is_file())
}

fn verified_model() -> Result<Vec<u8>> {
    let missing = || {
        EngineError::new(
            "background_model_unavailable",
            "install the pinned U²-Netp model in the application resources or set OMC_BACKGROUND_MODEL",
        )
    };
    let path = model_path()
        .filter(|path| path.is_file())
        .ok_or_else(missing)?;
    let file = std::fs::File::open(path).map_err(|_| missing())?;
    let mut bytes = Vec::with_capacity(MODEL_BYTES);
    file.take(MODEL_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| missing())?;
    if bytes.len() != MODEL_BYTES || hex::encode(Sha256::digest(&bytes)) != MODEL_SHA256 {
        return Err(EngineError::new(
            "background_model_unavailable",
            "local U²-Netp model failed checksum verification",
        ));
    }
    Ok(bytes)
}

fn rgba_info(width: i32, height: i32) -> ImageInfo {
    ImageInfo::new(
        (width, height),
        ColorType::RGBA8888,
        AlphaType::Unpremul,
        ColorSpace::new_srgb(),
    )
}

fn remove_background(encoded: &[u8], model: &[u8]) -> Result<Vec<u8>> {
    if encoded.len() > MAX_BYTES {
        return Err(EngineError::new(
            "resource_limit",
            "background removal supports raster images up to 16 MiB",
        ));
    }
    let mut codec = Codec::from_data(Data::new_copy(encoded))
        .ok_or_else(|| EngineError::invalid("unsupported raster image encoding"))?;
    let dimensions = codec.dimensions();
    let (width, height) = (dimensions.width, dimensions.height);
    if width <= 0 || height <= 0 || i64::from(width) * i64::from(height) > 16_000_000 {
        return Err(EngineError::new(
            "resource_limit",
            "background removal supports raster images up to 16 megapixels",
        ));
    }

    let info = rgba_info(width, height);
    let row_bytes = info.min_row_bytes();
    let mut pixels = vec![0; info.compute_byte_size(row_bytes)];
    if codec.get_pixels_with_options(&info, &mut pixels, row_bytes, None)
        != skia_safe::codec::Result::Success
    {
        return Err(EngineError::invalid("could not decode the raster image"));
    }

    let small_info = rgba_info(SIDE as i32, SIDE as i32);
    let mut small = vec![0; SIDE * SIDE * 4];
    let source = Pixmap::new(&info, &mut pixels, row_bytes).unwrap();
    let mut scaled = Pixmap::new(&small_info, &mut small, SIDE * 4).unwrap();
    if !source.scale_pixels(&mut scaled, FilterMode::Linear) {
        return Err(EngineError::invalid(
            "could not resize the raster image for inference",
        ));
    }
    drop(scaled);
    drop(source);

    let maximum = f32::from(
        small
            .chunks_exact(4)
            .flat_map(|p| p[..3].iter().copied())
            .max()
            .unwrap_or(0)
            .max(1),
    );
    let means = [0.485, 0.456, 0.406];
    let deviations = [0.229, 0.224, 0.225];
    let tensor: Vec<f32> = (0..3)
        .flat_map(|channel| {
            small.chunks_exact(4).map(move |p| {
                (f32::from(p[channel]) / maximum - means[channel]) / deviations[channel]
            })
        })
        .collect();
    let mask = infer(model, &tensor)
        .map_err(|error| EngineError::new("background_inference_failed", error.to_string()))?;
    let mut mask = normalized_mask(&mask)?;
    let mask_info = ImageInfo::new(
        (SIDE as i32, SIDE as i32),
        ColorType::Alpha8,
        AlphaType::Premul,
        None,
    );
    let mask = Pixmap::new(&mask_info, &mut mask, SIDE).unwrap();
    let alpha_info = ImageInfo::new((width, height), ColorType::Alpha8, AlphaType::Premul, None);
    let mut alpha = vec![0; width as usize * height as usize];
    let mut alpha_pixmap = Pixmap::new(&alpha_info, &mut alpha, width as usize).unwrap();
    if !mask.scale_pixels(&mut alpha_pixmap, FilterMode::Linear) {
        return Err(EngineError::invalid("could not resize the inferred mask"));
    }
    drop(alpha_pixmap);
    for (pixel, coverage) in pixels.chunks_exact_mut(4).zip(alpha) {
        pixel[3] = ((u16::from(pixel[3]) * u16::from(coverage) + 127) / 255) as u8;
    }

    let result = Pixmap::new(&info, &mut pixels, row_bytes).unwrap();
    let png = skia_safe::png_encoder::encode_pixmap(&result, &Default::default())
        .ok_or_else(|| EngineError::invalid("could not encode the transparent PNG"))?;
    if png.len() > MAX_BYTES {
        return Err(EngineError::new(
            "resource_limit",
            "the transparent PNG exceeds 16 MiB",
        ));
    }
    Ok(png.as_bytes().to_vec())
}

fn infer(model: &[u8], tensor: &[f32]) -> TractResult<Vec<f32>> {
    let model = tract_onnx::onnx()
        .model_for_read(&mut Cursor::new(model))?
        .with_input_fact(0, f32::fact([1, 3, SIDE, SIDE]).into())?
        .into_optimized()?
        .into_runnable()?;
    let input = Tensor::from_shape(&[1, 3, SIDE, SIDE], tensor)?;
    let result = model.run(tvec!(input.into()))?;
    Ok(result[0]
        .to_plain_array_view::<f32>()?
        .iter()
        .copied()
        .collect())
}

fn normalized_mask(mask: &[f32]) -> Result<Vec<u8>> {
    if mask.len() != SIDE * SIDE || mask.iter().any(|value| !value.is_finite()) {
        return Err(EngineError::invalid(
            "background removal returned an invalid mask",
        ));
    }
    let minimum = mask.iter().copied().fold(f32::INFINITY, f32::min);
    let maximum = mask.iter().copied().fold(f32::NEG_INFINITY, f32::max);
    if maximum - minimum < 1e-5 {
        return Err(EngineError::invalid(
            "no distinct foreground subject was found",
        ));
    }
    Ok(mask
        .iter()
        .map(|value| (255. * (value - minimum) / (maximum - minimum)).round() as u8)
        .collect())
}
