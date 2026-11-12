use super::*;

pub(super) fn shader(
    source: &Value,
    item: &SceneItem,
    resources: &dyn ResourceProvider,
) -> Result<Shader, RenderError> {
    let hash = source["assetHash"]
        .as_str()
        .or_else(|| source["image"]["hash"].as_str())
        .ok_or_else(|| RenderError::ResourceUnavailable("image paint has no asset".into()))?;
    let image = resources::load_image(hash, resources)?;
    let (w, h) = (f64::from(image.width()), f64::from(image.height()));
    let (sx, sy) = (item.width / w, item.height / h);
    let crop = crop_rect(&source["crop"], item);
    let (x, y, tx, ty, tile) = match source["mode"].as_str().unwrap_or("fill") {
        "fit" => {
            let z = sx.min(sy);
            (
                z,
                z,
                (item.width - w * z) / 2.,
                (item.height - h * z) / 2.,
                skia_safe::TileMode::Decal,
            )
        }
        "crop" if crop.is_some() => {
            let [x, y, width, height] = crop.unwrap();
            let tile = match source["cropSampling"].as_str() {
                Some("repeat") => skia_safe::TileMode::Repeat,
                Some("decal") => skia_safe::TileMode::Decal,
                _ => skia_safe::TileMode::Clamp,
            };
            (width / w, height / h, x, y, tile)
        }
        "fill" | "crop" => {
            let z = sx.max(sy);
            (
                z,
                z,
                (item.width - w * z) / 2.,
                (item.height - h * z) / 2.,
                skia_safe::TileMode::Clamp,
            )
        }
        "stretch" => (sx, sy, 0., 0., skia_safe::TileMode::Clamp),
        "tile" => (1., 1., 0., 0., skia_safe::TileMode::Repeat),
        mode => return Err(RenderError::Unsupported(format!("image paint mode {mode}"))),
    };
    let matrix = skia_matrix(Affine([x, 0., 0., y, tx, ty]));
    image
        .to_shader(
            (tile, tile),
            skia_safe::SamplingOptions::new(
                skia_safe::FilterMode::Linear,
                skia_safe::MipmapMode::None,
            ),
            &matrix,
        )
        .ok_or_else(|| RenderError::Unsupported("image paint shader".into()))
}

pub(super) fn crop_rect(source: &Value, item: &SceneItem) -> Option<[f64; 4]> {
    let fields = source.as_array()?;
    let [x, y, width, height] = fields.as_slice() else {
        return None;
    };
    let [x, y, width, height] = [x.as_f64()?, y.as_f64()?, width.as_f64()?, height.as_f64()?];
    (width > 0. && height > 0.).then_some([
        x * item.width,
        y * item.height,
        width * item.width,
        height * item.height,
    ])
}

pub(super) fn filters(paint: &mut Paint, source: &Value) {
    if !source.is_object() {
        return;
    }
    let value = |key| source[key].as_f64().unwrap_or(0.).clamp(-1., 1.) as f32;
    let contrast = (1. + value("contrast") * 0.85) * 2f32.powf(value("exposure"));
    let saturation = 1. + value("saturation");
    let temperature = value("temperature") * 0.12;
    let tint = value("tint") * 0.08;
    let highlights = value("highlights") * 0.25;
    let shadows = value("shadows") * 0.25;
    let slope = contrast + highlights - shadows;
    let offset = (1. - contrast) * 0.5 + shadows;
    let mut matrix = [0.; 20];
    let luma = [0.2126, 0.7152, 0.0722];
    let tone = [temperature + tint, -tint, -temperature + tint];
    for row in 0..3 {
        for col in 0..3 {
            matrix[row * 5 + col] =
                slope * ((1. - saturation) * luma[col] + if row == col { saturation } else { 0. });
        }
        matrix[row * 5 + 4] = offset + tone[row];
    }
    matrix[18] = 1.;
    paint.set_color_filter(skia_safe::color_filters::matrix_row_major(&matrix, None));
}
