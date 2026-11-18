use super::*;
use omc_model::{Node, NodeKind};
use serde_json::json;

const MAX_CAPTURE_NODES: usize = 4_000;
const MAX_CAPTURE_BYTES: usize = 12 * 1024 * 1024;
const MAX_DIMENSION: f64 = 16_384.;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Capture {
    version: u8,
    width: f64,
    height: f64,
    layers: Vec<Layer>,
    #[serde(default)]
    warnings: Vec<CaptureWarning>,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "kebab-case")]
enum CaptureWarning {
    ClippedTextOmitted,
    CssEffectsApproximated,
    EmbeddedContentOmitted,
    FormValuesOmitted,
    GeneratedContentOmitted,
    ImageFitApproximated,
    ImageSourceOmitted,
    OneAxisClippingApproximated,
    PrivateSubtreeOmitted,
    ShadowContentOmitted,
    SvgFeatureOmitted,
    TextStyleApproximated,
    WrappedTextApproximated,
}

impl CaptureWarning {
    fn diagnostic(&self) -> Diagnostic {
        let (code, action, fidelity_lost) = match self {
            Self::ClippedTextOmitted => (
                "clipped_text_omitted",
                "Omitted text that extended outside the visible scrollport",
                true,
            ),
            Self::CssEffectsApproximated => (
                "css_effects_approximated",
                "Retained the box and supported paint properties",
                true,
            ),
            Self::EmbeddedContentOmitted => (
                "embedded_content_omitted",
                "Omitted embedded documents and executable media",
                true,
            ),
            Self::FormValuesOmitted => (
                "form_values_omitted",
                "Retained control geometry and excluded form values",
                false,
            ),
            Self::GeneratedContentOmitted => (
                "generated_content_omitted",
                "Omitted CSS-generated content",
                true,
            ),
            Self::ImageFitApproximated => (
                "image_fit_approximated",
                "Retained the image in its captured bounds",
                true,
            ),
            Self::ImageSourceOmitted => (
                "image_source_omitted",
                "Retained the image box without fetching its source",
                true,
            ),
            Self::OneAxisClippingApproximated => (
                "one_axis_clipping_approximated",
                "Clipped both axes of the captured container",
                true,
            ),
            Self::PrivateSubtreeOmitted => (
                "private_subtree_omitted",
                "Excluded a private or editable DOM subtree",
                false,
            ),
            Self::ShadowContentOmitted => {
                ("shadow_content_omitted", "Omitted shadow DOM content", true)
            }
            Self::SvgFeatureOmitted => (
                "svg_feature_omitted",
                "Retained supported vector geometry",
                true,
            ),
            Self::TextStyleApproximated => (
                "text_style_approximated",
                "Retained editable text with supported typography",
                true,
            ),
            Self::WrappedTextApproximated => (
                "wrapped_text_approximated",
                "Retained editable text with native wrapping",
                true,
            ),
        };
        Diagnostic {
            code: code.into(),
            severity: "warning".into(),
            node_id: None,
            property: None,
            original: "rendered web selection".into(),
            action: action.into(),
            fidelity_lost,
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum Kind {
    Frame,
    Text,
    Image,
    Vector,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Layer {
    kind: Kind,
    name: String,
    parent: Option<usize>,
    bounds: [f64; 4],
    fill: Option<String>,
    opacity: Option<f64>,
    clip: Option<bool>,
    radius: Option<f64>,
    border: Option<f64>,
    stroke: Option<String>,
    text: Option<String>,
    color: Option<String>,
    font_size: Option<f64>,
    font_family: Option<String>,
    font_weight: Option<u16>,
    font_style: Option<String>,
    line_height: Option<f64>,
    letter_spacing: Option<f64>,
    source: Option<String>,
    svg: Option<String>,
}

pub(super) fn import_web_capture(
    bytes: &[u8],
    options: &ImportOptions,
) -> Result<ImportResult, ImportError> {
    if bytes.len() > MAX_CAPTURE_BYTES {
        return Err(ImportError::ResourceLimit("web capture byte limit".into()));
    }
    let capture: Capture = serde_json::from_slice(bytes)
        .map_err(|error| ImportError::Invalid(format!("web capture schema: {error}")))?;
    let limit = options.max_nodes.min(MAX_CAPTURE_NODES);
    if capture.layers.len() > limit || capture.warnings.len() > 32 {
        return Err(ImportError::ResourceLimit(
            "web capture layer or warning limit".into(),
        ));
    }
    if capture.version != 1
        || !size(capture.width)
        || !size(capture.height)
        || capture.layers.is_empty()
    {
        return Err(ImportError::Invalid(
            "invalid web capture version, viewport or layers".into(),
        ));
    }

    let mut result = ImportResult {
        content: DocumentContent::empty("Web capture"),
        resources: Vec::new(),
        diagnostics: capture
            .warnings
            .iter()
            .map(CaptureWarning::diagnostic)
            .collect(),
        source_map: BTreeMap::new(),
    };
    let page = result.content.pages[0].root_node_id.clone();
    let mut viewport = Node::new(NodeKind::Frame);
    viewport.parent_id = Some(page);
    viewport.properties.extend([
        ("name".into(), json!("Captured viewport")),
        ("width".into(), json!(capture.width)),
        ("height".into(), json!(capture.height)),
        ("clipContent".into(), json!(true)),
    ]);
    let viewport_id = viewport.id.clone();
    result.content.nodes.insert(viewport_id.clone(), viewport);
    let mut containers: Vec<Option<String>> = Vec::with_capacity(capture.layers.len());
    let mut images = BTreeMap::new();

    for (index, layer) in capture.layers.into_iter().enumerate() {
        let parent = match layer.parent {
            None => &viewport_id,
            Some(parent) => containers
                .get(parent)
                .and_then(Option::as_ref)
                .ok_or_else(|| {
                    ImportError::Invalid("web capture parent must be an earlier frame".into())
                })?,
        };
        let [x, y, width, height] = layer.bounds;
        if ![x, y].iter().all(|n| n.abs() <= 1_000_000.)
            || !(0. ..=1_000_000.).contains(&width)
            || !(0. ..=1_000_000.).contains(&height)
            || layer.name.is_empty()
            || layer.name.len() > 256
        {
            return Err(ImportError::Invalid(
                "invalid web capture layer geometry or name".into(),
            ));
        }
        let mut node = Node::new(match layer.kind {
            Kind::Frame | Kind::Vector => NodeKind::Frame,
            Kind::Text => NodeKind::Text,
            Kind::Image => NodeKind::Image,
        });
        node.parent_id = Some(parent.clone());
        node.rank = rank(index);
        node.properties.extend([
            ("name".into(), json!(layer.name)),
            ("x".into(), json!(x)),
            ("y".into(), json!(y)),
            ("width".into(), json!(width)),
            ("height".into(), json!(height)),
        ]);
        if let Some(opacity) = layer.opacity {
            bounded(opacity, 0., 1.)?;
            node.properties.insert("opacity".into(), json!(opacity));
        }

        match layer.kind {
            Kind::Frame => {
                node.properties
                    .insert("clipContent".into(), json!(layer.clip.unwrap_or(false)));
                add_paint(
                    &mut node,
                    "fill",
                    layer.fill.as_deref(),
                    &mut result.diagnostics,
                )?;
                add_paint(
                    &mut node,
                    "stroke",
                    layer.stroke.as_deref(),
                    &mut result.diagnostics,
                )?;
                if let Some(radius) = layer.radius {
                    bounded(radius, 0., MAX_DIMENSION)?;
                    node.properties.insert("cornerRadius".into(), json!(radius));
                }
                if let Some(border) = layer.border {
                    bounded(border, 0., MAX_DIMENSION)?;
                    node.properties.insert("strokeWidth".into(), json!(border));
                    node.properties
                        .insert("strokeAlignment".into(), json!("inside"));
                }
            }
            Kind::Text => {
                let text = layer
                    .text
                    .filter(|text| !text.is_empty() && text.len() <= 65_536)
                    .ok_or_else(|| {
                        ImportError::Invalid("web capture text is missing or too long".into())
                    })?;
                let family = layer
                    .font_family
                    .filter(|family| {
                        !family.is_empty()
                            && family.len() <= 256
                            && !family.chars().any(char::is_control)
                    })
                    .ok_or_else(|| {
                        ImportError::Invalid("invalid web capture font family".into())
                    })?;
                let weight = layer
                    .font_weight
                    .filter(|weight| (1..=1000).contains(weight))
                    .ok_or_else(|| {
                        ImportError::Invalid("invalid web capture font weight".into())
                    })?;
                let style = layer
                    .font_style
                    .filter(|style| matches!(style.as_str(), "normal" | "italic"))
                    .ok_or_else(|| ImportError::Invalid("invalid web capture font style".into()))?;
                let font_size = bounded(layer.font_size.unwrap_or_default(), 0.1, 4096.)?;
                let line_height =
                    bounded(layer.line_height.unwrap_or(font_size), 0.1, MAX_DIMENSION)?;
                let spacing = bounded(layer.letter_spacing.unwrap_or_default(), -4096., 4096.)?;
                node.properties.extend([
                    ("text".into(), json!(text)),
                    ("fontFamily".into(), json!(family)),
                    ("fontSize".into(), json!(font_size)),
                    ("fontWeight".into(), json!(weight)),
                    ("fontStyle".into(), json!(style)),
                    ("lineHeight".into(), json!(line_height)),
                    ("letterSpacing".into(), json!(spacing)),
                ]);
                add_paint(
                    &mut node,
                    "color",
                    layer.color.as_deref(),
                    &mut result.diagnostics,
                )?;
            }
            Kind::Image => {
                let source = layer
                    .source
                    .as_deref()
                    .ok_or_else(|| ImportError::Invalid("missing web capture image".into()))?;
                if !["png", "jpeg", "webp", "gif"]
                    .iter()
                    .any(|mime| source.starts_with(&format!("data:image/{mime};base64,")))
                {
                    return Err(ImportError::Invalid(
                        "web capture images must be inline raster assets".into(),
                    ));
                }
                let image = resource(source)?;
                node.properties
                    .insert("assetHash".into(), json!(image.hash));
                images.entry(image.hash.clone()).or_insert(image);
            }
            Kind::Vector => {
                let svg = layer
                    .svg
                    .as_deref()
                    .ok_or_else(|| ImportError::Invalid("missing web capture vector".into()))?;
                let remaining = limit.saturating_sub(result.content.nodes.len());
                let imported = import_vector(svg, width, height, remaining)?;
                let imported_root = &imported.content.pages[0].root_node_id;
                node.properties.insert("clipContent".into(), json!(true));
                for (id, mut child) in imported.content.nodes {
                    if &id == imported_root {
                        continue;
                    }
                    if child.parent_id.as_deref() == Some(imported_root) {
                        child.parent_id = Some(node.id.clone());
                    }
                    result.content.nodes.insert(id, child);
                }
                result.diagnostics.extend(imported.diagnostics);
            }
        }
        containers.push(matches!(layer.kind, Kind::Frame).then(|| node.id.clone()));
        result.content.nodes.insert(node.id.clone(), node);
        if result.content.nodes.len() > limit {
            return Err(ImportError::ResourceLimit(
                "web capture native node limit".into(),
            ));
        }
    }
    result.resources = images.into_values().collect();
    result
        .content
        .metadata
        .insert("sourceFormat".into(), json!("web-capture"));
    finish(result, options)
}

fn size(number: f64) -> bool {
    number > 0. && number <= MAX_DIMENSION
}

fn bounded(number: f64, minimum: f64, maximum: f64) -> Result<f64, ImportError> {
    (minimum..=maximum)
        .contains(&number)
        .then_some(number)
        .ok_or_else(|| {
            ImportError::Invalid("web capture style is outside its numeric bounds".into())
        })
}

fn add_paint(
    node: &mut Node,
    key: &str,
    input: Option<&str>,
    diagnostics: &mut Vec<Diagnostic>,
) -> Result<(), ImportError> {
    if let Some(value) = input {
        if value.len() > 256 {
            return Err(ImportError::Invalid("web capture paint is too long".into()));
        }
        if let Some(color) = omc_style::parse_color(value) {
            node.properties.insert(key.into(), json!(color.hex()));
        } else {
            diagnostics.push(Diagnostic::unsupported(
                Some(&node.id),
                Some(key),
                "unsupported computed color",
            ));
        }
    }
    Ok(())
}

fn import_vector(
    source: &str,
    width: f64,
    height: f64,
    remaining: usize,
) -> Result<ImportResult, ImportError> {
    if !size(width) || !size(height) || remaining == 0 {
        return Err(ImportError::Invalid(
            "invalid web capture vector dimensions or budget".into(),
        ));
    }
    let svg = roxmltree::Document::parse_with_options(
        source,
        roxmltree::ParsingOptions {
            allow_dtd: false,
            nodes_limit: remaining as u32,
            ..Default::default()
        },
    )
    .map_err(|_| ImportError::Invalid("invalid bounded web capture SVG".into()))?;
    let root = svg.root_element();
    let ns = Some("http://www.w3.org/2000/svg");
    if root.tag_name().name() != "svg"
        || svg
            .descendants()
            .filter(|node| node.is_element())
            .any(|node| {
                let tag = node.tag_name();
                tag.namespace() != ns
                    || (node != root
                        && !matches!(
                            tag.name(),
                            "g" | "rect"
                                | "circle"
                                | "ellipse"
                                | "line"
                                | "path"
                                | "polygon"
                                | "polyline"
                        ))
                    || node.attributes().any(|attribute| {
                        attribute.namespace().is_some()
                            || if node == root {
                                !matches!(attribute.name(), "viewBox" | "preserveAspectRatio")
                            } else {
                                !matches!(
                                    attribute.name(),
                                    "d" | "points"
                                        | "x"
                                        | "y"
                                        | "width"
                                        | "height"
                                        | "rx"
                                        | "ry"
                                        | "r"
                                        | "cx"
                                        | "cy"
                                        | "x1"
                                        | "y1"
                                        | "x2"
                                        | "y2"
                                        | "fill"
                                        | "stroke"
                                        | "stroke-width"
                                        | "fill-rule"
                                        | "opacity"
                                        | "transform"
                                ) || attribute.value().to_ascii_lowercase().contains("url(")
                            }
                    })
            })
    {
        return Err(ImportError::Invalid(
            "web capture SVG requires inert vector elements and attributes".into(),
        ));
    }
    import_svg(
        source,
        &ImportOptions {
            strict: false,
            width,
            height,
            max_nodes: remaining,
            max_input_bytes: MAX_CAPTURE_BYTES,
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    #[test]
    fn imports_editable_geometry_and_rejects_active_sources() {
        let mut capture = json!({
            "version": 1, "width": 352, "height": 196,
            "layers": [
                {"kind":"frame","name":"Clipped region","parent":null,"bounds":[7,9,320,42],"clip":true},
                {"kind":"text","name":"Text","parent":0,"bounds":[5,-2,136,20],"text":"Choose a size",
                  "color":"rgb(18,36,54)","fontFamily":"sans-serif","fontSize":16,"fontWeight":500,"fontStyle":"normal"},
                {"kind":"vector","name":"Icon","parent":0,"bounds":[8,24,24,24],
                 "svg":"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\"><path d=\"M 0 0 L 24 0 L 24 24 Z\" fill=\"#123456\"/></svg>"}
            ],
            "warnings":["form-values-omitted"]
        });
        let import = |capture: &Value| {
            import_web_capture(
                &serde_json::to_vec(capture).unwrap(),
                &ImportOptions::default(),
            )
        };
        let result = import(&capture).unwrap();
        let text = result
            .content
            .nodes
            .values()
            .find(|node| node.kind == NodeKind::Text)
            .unwrap();
        assert_eq!(text.properties["text"], "Choose a size");
        assert_eq!(text.properties["y"], -2.);
        assert_eq!(text.properties["color"], "#122436ff");
        assert_eq!(
            result.content.nodes[text.parent_id.as_ref().unwrap()].properties["clipContent"],
            true
        );
        assert!(
            result
                .content
                .nodes
                .values()
                .any(|node| node.kind == NodeKind::Path)
        );
        assert_eq!(result.diagnostics[0].code, "form_values_omitted");
        assert!(!result.diagnostics[0].fidelity_lost);

        capture["layers"][2]["svg"] = json!(
            "<svg xmlns=\"http://www.w3.org/2000/svg\"><path d=\"M0 0\" onload=\"alert(1)\"/></svg>"
        );
        assert!(matches!(import(&capture), Err(ImportError::Invalid(_))));
        capture["layers"][2] = json!({
            "kind":"image","name":"Image","parent":0,"bounds":[0,0,1,1],
            "source":"https://example.invalid/forbidden"
        });
        assert!(matches!(import(&capture), Err(ImportError::Invalid(_))));
        capture["layers"][2]["parent"] = json!(2);
        assert!(matches!(import(&capture), Err(ImportError::Invalid(_))));
    }
}
