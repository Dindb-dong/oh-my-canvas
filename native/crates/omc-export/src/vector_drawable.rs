//! Translate Skia's vector output to Android's Vector Drawable primitives.
use super::ExportError;
use omc_scene::Affine;
use omc_style::parse_color;
use roxmltree::{Document, Node};
use skia_safe::{Matrix, Paint, Path, PathEffect, Rect, paint};
use std::{collections::BTreeSet, fmt::Write};

pub(super) fn convert(
    svg: &[u8],
    width: f64,
    height: f64,
    mode: &str,
) -> Result<(Vec<u8>, Vec<String>), ExportError> {
    let xml = std::str::from_utf8(svg).map_err(|error| ExportError::Invalid(error.to_string()))?;
    let source = Document::parse(xml).map_err(|error| ExportError::Invalid(error.to_string()))?;
    let mut writer = Drawable {
        xml: format!(
            "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n<vector xmlns:android=\"http://schemas.android.com/apk/res/android\" xmlns:aapt=\"http://schemas.android.com/aapt\" android:width=\"{width}dp\" android:height=\"{height}dp\" android:viewportWidth=\"{width}\" android:viewportHeight=\"{height}\">\n"
        ),
        warnings: BTreeSet::new(),
        mode,
        paths: 0,
    };
    writer.node(source.root_element(), Affine::IDENTITY, 1., 0);
    if writer.paths == 0 {
        writer.warn("nothing in it could be drawn: the drawable is empty");
    }
    writer.xml.push_str("</vector>\n");
    Ok((
        writer.xml.into_bytes(),
        writer.warnings.into_iter().map(str::to_owned).collect(),
    ))
}

struct Drawable<'a> {
    xml: String,
    warnings: BTreeSet<&'static str>,
    mode: &'a str,
    paths: usize,
}

impl Drawable<'_> {
    fn warn(&mut self, warning: &'static str) {
        if self.mode != "ignore" {
            self.warnings.insert(warning);
        }
    }

    fn node(&mut self, node: Node<'_, '_>, transform: Affine, alpha: f64, depth: usize) {
        if depth >= 64 || self.paths >= 20_000 {
            self.warn("the drawable's complexity limit was reached");
            return;
        }
        if !node.is_element() || node.attribute("display") == Some("none") {
            return;
        }
        let transform = transform.multiply(svg_transform(node.attribute("transform")));
        let opacity = attr(node, "opacity", 1.).clamp(0., 1.);
        let mut alpha = alpha * opacity;
        if alpha <= 0. {
            return;
        }
        let tag = node.tag_name().name();
        let is_group = matches!(tag, "svg" | "g" | "symbol");
        if is_group && opacity < 1. && node.children().filter(Node::is_element).take(2).count() > 1
        {
            self.warn("layer opacity cannot combine overlapping shapes exactly");
            if self.mode == "exact" {
                return;
            }
        }
        if node.attribute("filter").is_some() {
            self.warn("filter effects were left out");
        }
        if node.attribute("mask").is_some() {
            self.warn("alpha and luminance masks were left out");
            if self.mode == "exact" {
                return;
            }
        }
        if let Some(mask) = node
            .attribute("style")
            .filter(|style| style.contains("mix-blend-mode"))
        {
            if !mask.contains("mix-blend-mode:normal") {
                self.warn("blend modes were drawn as normal");
                if self.mode == "exact" {
                    return;
                }
            }
        }
        let mut clipped = false;
        if let Some(clip) = reference(node, node.attribute("clip-path")) {
            let mut combined = Path::new();
            for child in clip.children().filter(Node::is_element) {
                if let Some(path) = shape(child) {
                    combined.add_path_matrix(
                        &path,
                        &matrix(transform.multiply(svg_transform(child.attribute("transform")))),
                        None,
                    );
                }
            }
            if !combined.is_empty() {
                self.xml.push_str("<group>\n");
                let _ = writeln!(
                    self.xml,
                    "<clip-path android:pathData=\"{}\" />",
                    combined.to_svg()
                );
                clipped = true;
            } else {
                self.warn("unsupported clip outline was left out");
                if self.mode == "exact" {
                    return;
                }
            }
        }
        match tag {
            "defs" | "clipPath" | "linearGradient" | "radialGradient" | "mask" => {}
            "svg" | "g" | "symbol" => {
                for child in node.children().filter(Node::is_element) {
                    self.node(child, transform, alpha, depth + 1);
                }
            }
            "use" => {
                let href = node
                    .attribute(("http://www.w3.org/1999/xlink", "href"))
                    .or_else(|| node.attribute("href"));
                if let Some(target) = reference(node, href) {
                    self.node(
                        target,
                        transform.multiply(Affine::translation(
                            attr(node, "x", 0.),
                            attr(node, "y", 0.),
                        )),
                        alpha,
                        depth + 1,
                    );
                }
            }
            "image" => self.warn("image fills were left out"),
            "text" => self.warn("text without vector outlines was left out"),
            _ => {
                if let Some(path) = shape(node) {
                    let fill = inherited(node, "fill").unwrap_or("black");
                    let fill_opacity = inherited(node, "fill-opacity")
                        .and_then(parse_number)
                        .unwrap_or(1.);
                    let even_odd = inherited(node, "fill-rule") == Some("evenodd");
                    self.path(&path, node, transform, fill, alpha * fill_opacity, even_odd);
                    if let Some(stroke) =
                        inherited(node, "stroke").filter(|stroke| *stroke != "none")
                    {
                        if let Some(outline) = stroke_outline(node, &path) {
                            alpha *= inherited(node, "stroke-opacity")
                                .and_then(parse_number)
                                .unwrap_or(1.);
                            self.path(&outline, node, transform, stroke, alpha, false);
                        }
                    }
                }
            }
        }
        if clipped {
            self.xml.push_str("</group>\n");
        }
    }

    fn path(
        &mut self,
        path: &Path,
        node: Node<'_, '_>,
        transform: Affine,
        fill: &str,
        opacity: f64,
        even_odd: bool,
    ) {
        if opacity <= 0. || fill == "none" || path.is_empty() {
            return;
        }
        let bounds = *path.bounds();
        let mut path = path.clone();
        path.transform(&matrix(transform));
        if !path.is_finite()
            || path
                .bounds()
                .left
                .abs()
                .max(path.bounds().right.abs())
                .max(path.bounds().top.abs())
                .max(path.bounds().bottom.abs())
                > 1e7
        {
            self.warn("shapes with coordinates beyond ±10,000,000 were left out");
            return;
        }
        let rule = if even_odd {
            " android:fillType=\"evenOdd\""
        } else {
            ""
        };
        let path = format!("<path android:pathData=\"{}\"{rule}", path.to_svg());
        if let Some(color) = parse_color(fill) {
            let color = hex_color(color, opacity);
            let _ = writeln!(self.xml, "{path} android:fillColor=\"{color}\" />");
            self.paths += 1;
        } else if let Some(source) = reference(node, Some(fill)) {
            if let Some(gradient) = gradient(source, transform, bounds, opacity, self.mode) {
                let _ = writeln!(
                    self.xml,
                    "{path}>\n<aapt:attr name=\"android:fillColor\">\n{gradient}</aapt:attr>\n</path>"
                );
                self.paths += 1;
            } else {
                self.warn("unsupported gradients were left out");
            }
        }
    }
}

fn shape(node: Node<'_, '_>) -> Option<Path> {
    let mut path = Path::new();
    let x = attr(node, "x", 0.);
    let y = attr(node, "y", 0.);
    match node.tag_name().name() {
        "path" => return Path::from_svg(node.attribute("d")?),
        "rect" => {
            let rect = Rect::from_xywh(
                x as f32,
                y as f32,
                attr(node, "width", 0.) as f32,
                attr(node, "height", 0.) as f32,
            );
            let rx = attr(node, "rx", attr(node, "ry", 0.)) as f32;
            let ry = attr(node, "ry", f64::from(rx)) as f32;
            path.add_round_rect(rect, (rx, ry), None);
        }
        "circle" | "ellipse" => {
            let rx = attr(node, "rx", attr(node, "r", 0.)) as f32;
            let ry = attr(node, "ry", f64::from(rx)) as f32;
            let cx = attr(node, "cx", 0.) as f32;
            let cy = attr(node, "cy", 0.) as f32;
            path.add_oval(Rect::from_xywh(cx - rx, cy - ry, 2. * rx, 2. * ry), None);
        }
        "line" => {
            path.move_to((attr(node, "x1", 0.) as f32, attr(node, "y1", 0.) as f32))
                .line_to((attr(node, "x2", 0.) as f32, attr(node, "y2", 0.) as f32));
        }
        "polygon" | "polyline" => {
            let points = numbers(node.attribute("points")?);
            let mut points = points.chunks_exact(2);
            let first = points.next()?;
            path.move_to((first[0] as f32, first[1] as f32));
            for p in points {
                path.line_to((p[0] as f32, p[1] as f32));
            }
            if node.has_tag_name("polygon") {
                path.close();
            }
        }
        _ => return None,
    }
    Some(path)
}

fn stroke_outline(node: Node<'_, '_>, path: &Path) -> Option<Path> {
    let mut paint = Paint::default();
    let number = |key, default| {
        inherited(node, key)
            .and_then(parse_number)
            .unwrap_or(default) as f32
    };
    paint
        .set_style(paint::Style::Stroke)
        .set_stroke_width(number("stroke-width", 1.))
        .set_stroke_miter(number("stroke-miterlimit", 4.))
        .set_stroke_cap(match inherited(node, "stroke-linecap") {
            Some("round") => paint::Cap::Round,
            Some("square") => paint::Cap::Square,
            _ => paint::Cap::Butt,
        })
        .set_stroke_join(match inherited(node, "stroke-linejoin") {
            Some("round") => paint::Join::Round,
            Some("bevel") => paint::Join::Bevel,
            _ => paint::Join::Miter,
        });
    if let Some(values) = inherited(node, "stroke-dasharray").filter(|values| *values != "none") {
        let mut values = numbers(values)
            .into_iter()
            .map(|value| value as f32)
            .collect::<Vec<_>>();
        if values.len() % 2 != 0 {
            values.extend_from_within(..);
        }
        paint.set_path_effect(PathEffect::dash(&values, number("stroke-dashoffset", 0.)));
    }
    let mut outline = Path::new();
    skia_safe::path_utils::fill_path_with_paint(path, &paint, &mut outline, None, None)
        .then_some(outline)
}

fn gradient(
    node: Node<'_, '_>,
    world: Affine,
    bounds: Rect,
    alpha: f64,
    mode: &str,
) -> Option<String> {
    let user_space = node.attribute("gradientUnits") == Some("userSpaceOnUse");
    let local = svg_transform(node.attribute("gradientTransform"));
    let transform = if user_space {
        world.multiply(local)
    } else {
        world
            .multiply(Affine([
                bounds.width() as f64,
                0.,
                0.,
                bounds.height() as f64,
                bounds.left as f64,
                bounds.top as f64,
            ]))
            .multiply(local)
    };
    let coord = |key, default| node.attribute(key).and_then(parse_ratio).unwrap_or(default);
    let tile = match node.attribute("spreadMethod") {
        Some("repeat") => "repeat",
        Some("reflect") => "mirror",
        _ => "clamp",
    };
    let mut xml = if node.has_tag_name("linearGradient") {
        let (x1, y1) = transform.point(coord("x1", 0.), coord("y1", 0.));
        let (x2, y2) = transform.point(coord("x2", 1.), coord("y2", 0.));
        format!(
            "<gradient android:type=\"linear\" android:startX=\"{x1}\" android:startY=\"{y1}\" android:endX=\"{x2}\" android:endY=\"{y2}\" android:tileMode=\"{tile}\">\n"
        )
    } else if node.has_tag_name("radialGradient") {
        let (x, y) = transform.point(coord("cx", 0.5), coord("cy", 0.5));
        let [a, b, c, d, _, _] = transform.0;
        let (rx, ry) = (a.hypot(b), c.hypot(d));
        if mode == "exact" && ((rx - ry).abs() > 1e-5 || (a * c + b * d).abs() > 1e-5) {
            return None;
        }
        let radius = (rx * ry).sqrt() * coord("r", 0.5);
        format!(
            "<gradient android:type=\"radial\" android:centerX=\"{x}\" android:centerY=\"{y}\" android:gradientRadius=\"{radius}\" android:tileMode=\"{tile}\">\n"
        )
    } else {
        return None;
    };
    let mut count = 0;
    for stop in node.children().filter(|stop| stop.has_tag_name("stop")) {
        let color = parse_color(stop.attribute("stop-color").unwrap_or("black"))?;
        let opacity = attr(stop, "stop-opacity", 1.) * alpha;
        let color = hex_color(color, opacity);
        let offset = stop
            .attribute("offset")
            .and_then(parse_ratio)
            .unwrap_or(0.)
            .clamp(0., 1.);
        let _ = writeln!(
            xml,
            "<item android:color=\"{color}\" android:offset=\"{offset}\" />"
        );
        count += 1;
    }
    xml.push_str("</gradient>\n");
    (count >= 2).then_some(xml)
}

fn hex_color(color: omc_style::Color, opacity: f64) -> String {
    let channel = |value: f64| (value.clamp(0., 1.) * 255.).round() as u8;
    format!(
        "#{:02X}{:02X}{:02X}{:02X}",
        channel(f64::from(color.a) * opacity),
        channel(color.r.into()),
        channel(color.g.into()),
        channel(color.b.into())
    )
}

fn inherited<'a>(node: Node<'a, '_>, key: &str) -> Option<&'a str> {
    node.ancestors()
        .find_map(|ancestor| ancestor.attribute(key))
}

fn reference<'a, 'input>(node: Node<'a, 'input>, value: Option<&str>) -> Option<Node<'a, 'input>> {
    let value = value?;
    let id = value
        .strip_prefix("url(#")
        .and_then(|value| value.strip_suffix(')'))
        .or_else(|| value.strip_prefix('#'))?;
    node.document()
        .descendants()
        .find(|candidate| candidate.attribute("id") == Some(id))
}

fn attr(node: Node<'_, '_>, key: &str, default: f64) -> f64 {
    node.attribute(key)
        .and_then(parse_number)
        .unwrap_or(default)
}

fn parse_number(text: &str) -> Option<f64> {
    text.trim()
        .trim_end_matches("px")
        .parse::<f64>()
        .ok()
        .filter(|value| value.is_finite())
}

fn parse_ratio(text: &str) -> Option<f64> {
    match text.strip_suffix('%') {
        Some(percent) => parse_number(percent).map(|value| value / 100.),
        None => parse_number(text),
    }
}

fn numbers(text: &str) -> Vec<f64> {
    text.split(|c: char| c == ',' || c.is_ascii_whitespace())
        .filter_map(parse_number)
        .collect()
}

fn svg_transform(text: Option<&str>) -> Affine {
    let mut matrix = Affine::IDENTITY;
    for operation in text.unwrap_or_default().split(')') {
        let Some((name, args)) = operation
            .trim_start_matches(|c: char| c == ',' || c.is_ascii_whitespace())
            .split_once('(')
        else {
            continue;
        };
        let values = numbers(args);
        let transform = match (name.trim(), values.as_slice()) {
            ("matrix", [a, b, c, d, x, y]) => Affine([*a, *b, *c, *d, *x, *y]),
            ("translate", [x, y]) => Affine::translation(*x, *y),
            ("translate", [x]) => Affine::translation(*x, 0.),
            ("scale", [x, y]) => Affine([*x, 0., 0., *y, 0., 0.]),
            ("scale", [scale]) => Affine([*scale, 0., 0., *scale, 0., 0.]),
            ("rotate", [angle, rest @ ..]) => {
                let (sin, cos) = angle.to_radians().sin_cos();
                let rotation = Affine([cos, sin, -sin, cos, 0., 0.]);
                if let [x, y] = rest {
                    Affine::translation(*x, *y)
                        .multiply(rotation)
                        .multiply(Affine::translation(-x, -y))
                } else {
                    rotation
                }
            }
            ("skewX", [angle]) => Affine([1., 0., angle.to_radians().tan(), 1., 0., 0.]),
            ("skewY", [angle]) => Affine([1., angle.to_radians().tan(), 0., 1., 0., 0.]),
            _ => continue,
        };
        matrix = matrix.multiply(transform);
    }
    matrix
}

fn matrix(transform: Affine) -> Matrix {
    let [a, b, c, d, x, y] = transform.0.map(|value| value as f32);
    Matrix::new_all(a, c, x, b, d, y, 0., 0., 1.)
}
