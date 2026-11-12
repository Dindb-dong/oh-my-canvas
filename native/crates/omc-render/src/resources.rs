use super::*;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

thread_local! {
    static RASTER_PROFILE: std::cell::Cell<omc_style::ColorProfile> =
        const { std::cell::Cell::new(omc_style::ColorProfile::Srgb) };
}

pub(super) fn with_raster_profile<T>(
    profile: omc_style::ColorProfile,
    render: impl FnOnce() -> T,
) -> T {
    struct Reset(omc_style::ColorProfile);
    impl Drop for Reset {
        fn drop(&mut self) {
            RASTER_PROFILE.set(self.0);
        }
    }
    let _scope = Reset(RASTER_PROFILE.replace(profile));
    render()
}

pub(super) fn image_data(
    hash: &str,
    resources: &dyn ResourceProvider,
) -> Result<(Data, u32, u32, usize), RenderError> {
    let bytes = resources
        .get(hash)
        .map_err(RenderError::ResourceUnavailable)?;
    if bytes.is_empty() || bytes.len() > 64 * 1024 * 1024 {
        return Err(RenderError::ResourceLimit(
            "encoded image must be 1 byte..64 MiB".into(),
        ));
    }
    let actual: String = Sha256::digest(&bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    if actual != hash {
        return Err(RenderError::ResourceUnavailable(format!(
            "image checksum mismatch: {hash}"
        )));
    }
    let data = Data::new_copy(&bytes);
    let codec = skia_safe::Codec::from_data(data.clone()).ok_or_else(|| {
        RenderError::ResourceUnavailable(format!("invalid image encoding: {hash}"))
    })?;
    // Codec construction reads headers. The pixel decode is not attempted before this check.
    let dimensions = codec.dimensions();
    let pixels = (dimensions.width as i64)
        .checked_mul(dimensions.height as i64)
        .ok_or_else(|| RenderError::ResourceLimit("decoded image size overflow".into()))?;
    if dimensions.width <= 0
        || dimensions.height <= 0
        || dimensions.width > 32768
        || dimensions.height > 32768
        || pixels > 64 * 1024 * 1024
    {
        return Err(RenderError::ResourceLimit(
            "decoded image dimensions exceed 32768 per axis or 64 million pixels".into(),
        ));
    }
    Ok((
        data,
        dimensions.width as u32,
        dimensions.height as u32,
        bytes.len(),
    ))
}
pub(super) fn load_image(
    hash: &str,
    resources: &dyn ResourceProvider,
) -> Result<Image, RenderError> {
    let (data, _, _, _) = image_data(hash, resources)?;
    let image = Image::from_encoded(data).ok_or_else(|| {
        RenderError::ResourceUnavailable(format!("native image decode failed: {hash}"))
    })?;
    if RASTER_PROFILE.get() == omc_style::ColorProfile::DisplayP3 {
        // An untagged working surface treats source samples as already in its profile.
        // Normalize embedded raster assets before compositing into it.
        let image = if image.color_space().is_none() {
            image.reinterpret_color_space(ColorSpace::new_srgb())
                .ok_or_else(|| RenderError::Backend("Image source profile tagging failed".into()))?
        } else {
            image
        };
        return image
            .make_color_space(None, display_p3_space()?, Default::default())
            .ok_or_else(|| {
                RenderError::Backend("Image asset color profile conversion failed".into())
            });
    }
    Ok(image)
}

/// Conservative reservation includes compositing/filter surfaces and every image occurrence.
/// The full-surface fallback can reject work that a later qualified tiled planner will fit.
pub(super) fn reserve(
    scene: &Scene,
    options: &RenderOptions,
    resources: &dyn ResourceProvider,
) -> Result<BTreeMap<String, Vec<u8>>, RenderError> {
    let (width, height, bytes) = dimensions(scene, options)?;
    let mut peak = bytes.saturating_mul(2);
    let mut ancestry = vec![0usize; scene.items.len()];
    let mut image_bytes = 0usize;
    let mut cached = BTreeMap::new();
    for (index, item) in scene.items.iter().enumerate() {
        if item.hidden {
            continue;
        }
        let mut own = 0usize;
        if item.style.number("opacity", 1.) < 1.
            || item
                .style
                .get("mix-blend-mode")
                .is_some_and(|v| v != "normal")
            || item
                .properties
                .get("blendMode")
                .and_then(Value::as_str)
                .is_some_and(|v| !matches!(v, "normal" | "pass-through"))
        {
            own = own.saturating_add(bytes);
        }
        if item.properties.get("isMaskGroup") == Some(&Value::Bool(true))
            || item.properties.contains_key("maskMode")
            || item.properties.contains_key("maskType")
        {
            own = own.saturating_add(bytes.saturating_mul(2));
        }
        let sigma = item
            .style
            .get("filter")
            .and_then(|s| s.strip_prefix("blur("))
            .and_then(|s| s.strip_suffix(')'))
            .and_then(|s| resolve_length(s, LengthContext::default()))
            .unwrap_or(0.);
        let shadow = item
            .properties
            .get("shadows")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .map(|v| {
                v.get("blur")
                    .or_else(|| v.get("radius"))
                    .and_then(Value::as_f64)
                    .unwrap_or(0.)
                    + v.get("spread").and_then(Value::as_f64).unwrap_or(0.).abs() / 3.
            })
            .fold(0., f64::max);
        if sigma > 0. || shadow > 0. {
            let a = item.world.0;
            let scale = a[0].hypot(a[1]).max(a[2].hypot(a[3]));
            let halo = (sigma.max(shadow) * options.scale * scale * 3.).ceil();
            if !halo.is_finite() || halo > 32768. {
                return Err(RenderError::ResourceLimit(
                    "filter halo exceeds native reservation limits".into(),
                ));
            }
            let expanded = (width as usize)
                .saturating_add(halo as usize * 2)
                .saturating_mul((height as usize).saturating_add(halo as usize * 2))
                .saturating_mul(12);
            own = own.saturating_add(expanded);
        }
        ancestry[index] = own.saturating_add(item.parent.map_or(0, |p| ancestry[p]));
        peak = peak.max(ancestry[index].saturating_add(bytes.saturating_mul(2)));
        let mut hashes = Vec::new();
        if item.kind == NodeKind::Image {
            if let Some(hash) = super::image_hash(item) {
                hashes.push(hash);
            }
        }
        for stack in ["fills", "strokes"] {
            for paint in item
                .properties
                .get(stack)
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                if let Some(hash) = paint
                    .get("image")
                    .and_then(|v| v.get("hash"))
                    .or_else(|| paint.get("assetHash"))
                    .and_then(Value::as_str)
                {
                    hashes.push(hash);
                }
            }
        }
        for hash in hashes {
            match image_data(hash, resources) {
                Ok((data, w, h, encoded)) => {
                    let decoded_bytes = if scene.color_profile == omc_style::ColorProfile::DisplayP3 {
                        12
                    } else {
                        8
                    };
                    image_bytes = image_bytes
                        .saturating_add(encoded.saturating_mul(3))
                        .saturating_add(
                            (w as usize).saturating_mul(h as usize).saturating_mul(decoded_bytes),
                        );
                    if peak.saturating_add(image_bytes) > options.max_surface_bytes {
                        return Err(RenderError::ResourceLimit("compositing, encoded resources and decoded pixels exceed the render reservation".into()));
                    }
                    cached
                        .entry(hash.to_owned())
                        .or_insert_with(|| data.as_bytes().to_vec());
                }
                Err(error) => {
                    if scene.strict || matches!(error, RenderError::ResourceLimit(_)) {
                        return Err(error);
                    }
                }
            }
        }
    }
    if peak.saturating_add(image_bytes) > options.max_surface_bytes {
        return Err(RenderError::ResourceLimit(format!(
            "complete render requires at least {} reserved bytes",
            peak.saturating_add(image_bytes)
        )));
    }
    Ok(cached)
}
