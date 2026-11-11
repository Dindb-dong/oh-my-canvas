//! Native paragraph shaping and its shared measurement, drawing and caret maps.
use omc_style::{ComputedStyle, Diagnostic, LengthContext, resolve_length};
use skia_safe::{
    Canvas, Color4f, FontMgr, FontStyle, Picture, PictureRecorder, Rect, font_style,
    textlayout::{
        FontCollection, Paragraph, ParagraphBuilder, ParagraphStyle, RectHeightStyle,
        RectWidthStyle, TextAlign, TextDirection, TextStyle,
    },
};
use unicode_segmentation::UnicodeSegmentation;

#[derive(Debug, thiserror::Error)]
pub enum TextError {
    #[error("invalid styled text: {0}")]
    InvalidRuns(String),
    #[error("text layout width must be finite and nonnegative")]
    InvalidWidth,
    #[error("text exceeds the 4 MiB native paragraph limit")]
    ResourceLimit,
    #[error("native text recording failed")]
    Recording,
}

struct SelectionBox {
    start: usize,
    end: usize,
    rect: [f64; 4],
}
struct CaretStop {
    offset: usize,
    x: f64,
    top: f64,
    bottom: f64,
}

pub struct TextLayout {
    // SkParagraph has mutable shaping caches and cannot cross a thread boundary.
    // Its immutable display list and extracted geometry safely can.
    picture: Picture,
    selection_boxes: Vec<SelectionBox>,
    carets: Vec<CaretStop>,
    pub width: f64,
    pub height: f64,
    pub alphabetic_baseline: f64,
    pub intrinsic_width: f64,
    pub utf16_len: usize,
    pub grapheme_offsets: Vec<usize>,
    pub diagnostics: Vec<Diagnostic>,
}

impl TextLayout {
    pub fn paint(&self, canvas: &Canvas, x: f64, y: f64) {
        let saved = canvas.save();
        canvas.translate((x as f32, y as f32));
        canvas.draw_picture(&self.picture, None, None);
        canvas.restore_to_count(saved);
    }
    pub fn caret_offset(&self, x: f64, y: f64) -> usize {
        if !x.is_finite() || !y.is_finite() {
            return 0;
        }
        self.carets
            .iter()
            .min_by(|a, b| {
                let distance = |stop: &CaretStop| {
                    let vertical = if y < stop.top {
                        stop.top - y
                    } else if y > stop.bottom {
                        y - stop.bottom
                    } else {
                        0.
                    };
                    (vertical, (stop.x - x).abs())
                };
                let a = distance(a);
                let b = distance(b);
                a.0.total_cmp(&b.0).then(a.1.total_cmp(&b.1))
            })
            .map_or(0, |stop| stop.offset)
    }
    pub fn caret_rect(&self, offset: usize) -> Option<[f64; 4]> {
        let offset = offset.min(self.utf16_len);
        self.carets
            .iter()
            .min_by_key(|stop| stop.offset.abs_diff(offset))
            .map(|stop| [stop.x, stop.top, 1., (stop.bottom - stop.top).max(1.)])
    }
    /// Half-open UTF-16 geometry from the painted paragraph, snapped outwards to graphemes.
    pub fn selection_rects(&self, start: usize, end: usize) -> Vec<[f64; 4]> {
        if start >= end || end > self.utf16_len {
            return Vec::new();
        }
        let mut rectangles: Vec<_> = self
            .selection_boxes
            .iter()
            .filter(|b| b.start < end && b.end > start)
            .map(|b| b.rect)
            .collect();
        rectangles.sort_by(|a, b| a[1].total_cmp(&b[1]).then(a[0].total_cmp(&b[0])));
        let mut result: Vec<[f64; 4]> = Vec::new();
        for rect in rectangles {
            if let Some(last) = result.last_mut() {
                if (last[1] - rect[1]).abs() < 0.01
                    && (last[3] - rect[3]).abs() < 0.01
                    && rect[0] <= last[0] + last[2] + 0.01
                {
                    last[2] = (last[0] + last[2]).max(rect[0] + rect[2]) - last[0];
                    continue;
                }
            }
            result.push(rect);
        }
        result
    }
}

pub fn shape(text: &str, style: &ComputedStyle, width: f64) -> Result<TextLayout, TextError> {
    shape_runs(text, None, style, width)
}

pub fn shape_runs(
    text: &str,
    runs: Option<&serde_json::Value>,
    style: &ComputedStyle,
    width: f64,
) -> Result<TextLayout, TextError> {
    let (paragraph, diagnostics, font_size) = paragraph(text, runs, style, width)?;
    let mut grapheme_offsets = Vec::new();
    let mut offset = 0;
    for grapheme in text.graphemes(true) {
        grapheme_offsets.push(offset);
        offset += grapheme.encode_utf16().count();
    }
    grapheme_offsets.push(offset);
    let mut selection_boxes = Vec::new();
    let mut carets = Vec::new();
    for range in grapheme_offsets.windows(2) {
        for text_box in paragraph.get_rects_for_range(
            range[0]..range[1],
            RectHeightStyle::Tight,
            RectWidthStyle::Tight,
        ) {
            let r = text_box.rect;
            let rect = [
                r.left as f64,
                r.top as f64,
                r.width() as f64,
                r.height() as f64,
            ];
            selection_boxes.push(SelectionBox {
                start: range[0],
                end: range[1],
                rect,
            });
            let (before, after) = if text_box.direct == TextDirection::RTL {
                (r.right, r.left)
            } else {
                (r.left, r.right)
            };
            carets.push(CaretStop {
                offset: range[0],
                x: before as f64,
                top: r.top as f64,
                bottom: r.bottom as f64,
            });
            carets.push(CaretStop {
                offset: range[1],
                x: after as f64,
                top: r.top as f64,
                bottom: r.bottom as f64,
            });
        }
    }
    // Empty lines have no glyph boxes. Preserve their native paragraph caret mapping.
    for line in paragraph.get_line_metrics() {
        let y = line.baseline - line.ascent / 2.;
        for x in [line.left, line.left + line.width] {
            let raw = paragraph
                .get_glyph_position_at_coordinate((x as f32, y as f32))
                .position as usize;
            let boundary = grapheme_offsets
                .iter()
                .copied()
                .min_by_key(|p| p.abs_diff(raw))
                .unwrap_or(0);
            carets.push(CaretStop {
                offset: boundary,
                x,
                top: line.baseline - line.ascent,
                bottom: line.baseline + line.descent,
            });
        }
    }
    let height = paragraph.height() as f64;
    let alphabetic_baseline = paragraph.alphabetic_baseline() as f64;
    let intrinsic_width = paragraph.max_intrinsic_width() as f64;
    if carets.is_empty() {
        carets.push(CaretStop {
            offset: 0,
            x: 0.,
            top: 0.,
            bottom: height.max(font_size),
        });
    }
    let mut recorder = PictureRecorder::new();
    let canvas = recorder.begin_recording(
        Rect::from_xywh(
            -font_size as f32,
            -font_size as f32,
            (width.max(intrinsic_width) + font_size * 2.) as f32,
            (height + font_size * 2.) as f32,
        ),
        true,
    );
    paragraph.paint(canvas, (0., 0.));
    let picture = recorder
        .finish_recording_as_picture(None)
        .ok_or(TextError::Recording)?;
    Ok(TextLayout {
        width,
        height,
        alphabetic_baseline,
        intrinsic_width,
        utf16_len: offset,
        grapheme_offsets,
        diagnostics,
        picture,
        selection_boxes,
        carets,
    })
}

#[derive(Clone, Copy, Debug)]
pub struct TextMeasurement {
    pub width: f64,
    pub height: f64,
    pub baseline: f64,
}
pub fn measure_runs(
    text: &str,
    runs: Option<&serde_json::Value>,
    style: &ComputedStyle,
    width: f64,
) -> Result<TextMeasurement, TextError> {
    let (paragraph, _, _) = paragraph(text, runs, style, width)?;
    Ok(TextMeasurement {
        width: paragraph.max_intrinsic_width() as f64,
        height: paragraph.height() as f64,
        baseline: paragraph.alphabetic_baseline() as f64,
    })
}
fn paragraph(
    text: &str,
    runs: Option<&serde_json::Value>,
    style: &ComputedStyle,
    width: f64,
) -> Result<(Paragraph, Vec<Diagnostic>, f64), TextError> {
    if !width.is_finite() || width < 0. || width > 1_000_000. {
        return Err(TextError::InvalidWidth);
    }
    if text.len() > 4 * 1024 * 1024 {
        return Err(TextError::ResourceLimit);
    }
    let font_manager = FontMgr::default();
    let mut diagnostics = Vec::new();
    let font_size = style
        .get("font-size")
        .and_then(|v| resolve_length(v, LengthContext::default()))
        .unwrap_or(16.);
    let mut collection = FontCollection::new();
    collection.set_default_font_manager(font_manager.clone(), None);
    let text_style = styled_text(style, &font_manager, &mut diagnostics);
    let mut paragraph_style = ParagraphStyle::new();
    paragraph_style.set_text_style(&text_style);
    paragraph_style.set_text_align(match style.get("text-align") {
        Some("center") => TextAlign::Center,
        Some("right") | Some("end") => TextAlign::Right,
        Some("justify") => TextAlign::Justify,
        _ => TextAlign::Left,
    });
    if style.get("direction") == Some("rtl") {
        paragraph_style.set_text_direction(TextDirection::RTL);
    }
    let mut builder = ParagraphBuilder::new(&paragraph_style, collection);
    if let Some(runs) = runs.filter(|v| v.as_array().is_some_and(|a| !a.is_empty())) {
        let runs = runs
            .as_array()
            .ok_or_else(|| TextError::InvalidRuns("runs must be an array".into()))?;
        if runs.len() > 100_000 {
            return Err(TextError::ResourceLimit);
        }
        let mut combined = String::with_capacity(text.len());
        for run in runs {
            let source = run
                .get("text")
                .and_then(serde_json::Value::as_str)
                .ok_or_else(|| TextError::InvalidRuns("run text missing".into()))?;
            combined.push_str(source);
            let mut computed = style.clone();
            if let Some(attributes) = run.get("attributes").and_then(serde_json::Value::as_object) {
                for (key, value) in attributes {
                    let property = match key.as_str() {
                        "fontFamily" => "font-family",
                        "fontSize" => "font-size",
                        "fontWeight" => "font-weight",
                        "fontStyle" => "font-style",
                        "letterSpacing" => "letter-spacing",
                        "wordSpacing" => "word-spacing",
                        "lineHeight" => "line-height",
                        "textDecoration" => "text-decoration",
                        "textDecorationStyle" => "text-decoration-style",
                        "textDecorationThickness" => "text-decoration-thickness",
                        "fill" => "color",
                        "highlight" => "background-color",
                        "bold" => "font-weight",
                        "italic" => "font-style",
                        "underline" => "text-decoration",
                        "strikethrough" => "text-decoration",
                        "link" | "href" => continue,
                        other => other,
                    };
                    let string = match key.as_str() {
                        "bold" => Some(
                            if value.as_bool() == Some(true) {
                                "700"
                            } else {
                                "400"
                            }
                            .into(),
                        ),
                        "italic" => Some(
                            if value.as_bool() == Some(true) {
                                "italic"
                            } else {
                                "normal"
                            }
                            .into(),
                        ),
                        "underline" => Some(
                            if value.as_bool() == Some(true) {
                                "underline"
                            } else {
                                "none"
                            }
                            .into(),
                        ),
                        "strikethrough" => Some(
                            if value.as_bool() == Some(true) {
                                "line-through"
                            } else {
                                "none"
                            }
                            .into(),
                        ),
                        _ => omc_style::css_value(value),
                    };
                    if let Some(value) = string {
                        computed.values.insert(property.into(), value);
                    } else if !value.is_null() {
                        diagnostics.push(Diagnostic::unsupported(
                            None,
                            Some(key),
                            &value.to_string(),
                        ));
                    }
                }
            }
            let run_style = styled_text(&computed, &font_manager, &mut diagnostics);
            builder.push_style(&run_style);
            builder.add_text(source);
            builder.pop();
        }
        if combined != text {
            return Err(TextError::InvalidRuns(
                "run content differs from canonical text".into(),
            ));
        }
    } else {
        builder.add_text(text);
    }
    let mut paragraph = builder.build();
    paragraph.layout(width.max(0.01) as f32);
    Ok((paragraph, diagnostics, font_size))
}
fn styled_text(
    style: &ComputedStyle,
    font_manager: &FontMgr,
    diagnostics: &mut Vec<Diagnostic>,
) -> TextStyle {
    let font_size = style
        .get("font-size")
        .and_then(|v| resolve_length(v, LengthContext::default()))
        .unwrap_or(16.)
        .clamp(1., 4096.);
    let families: Vec<String> = style
        .get("font-family")
        .unwrap_or("sans-serif")
        .split(',')
        .map(|f| f.trim().trim_matches(['\'', '"']).to_owned())
        .collect();
    let weight = match style.get("font-weight").unwrap_or("400") {
        "bold" => 700,
        "normal" => 400,
        value => value.parse::<i32>().unwrap_or(400),
    };
    let slant = if style.get("font-style") == Some("italic") {
        font_style::Slant::Italic
    } else {
        font_style::Slant::Upright
    };
    let font_style = FontStyle::new(
        font_style::Weight::from(weight),
        font_style::Width::NORMAL,
        slant,
    );
    let generic = |f: &str| matches!(f, "sans-serif" | "serif" | "monospace" | "system-ui");
    if families
        .iter()
        .filter(|f| !generic(f))
        .all(|f| font_manager.match_family_style(f, font_style).is_none())
        && !families.iter().all(|f| generic(f))
    {
        diagnostics.push(Diagnostic {
            code: "font_substitution".into(),
            severity: "warning".into(),
            node_id: None,
            property: Some("font-family".into()),
            original: families.join(", "),
            action: "Native font fallback used; visual fidelity is unverified".into(),
            fidelity_lost: true,
        });
    }
    let mut text_style = TextStyle::new();
    text_style
        .set_font_size(font_size as f32)
        .set_font_families(&families)
        .set_font_style(font_style);
    let color = style.color("color").unwrap_or(omc_style::Color {
        r: 0.,
        g: 0.,
        b: 0.,
        a: 1.,
    });
    text_style.set_color(Color4f::new(color.r, color.g, color.b, color.a).to_color());
    let lengths = LengthContext {
        font_size,
        ..Default::default()
    };
    if let Some(spacing) = style
        .get("letter-spacing")
        .and_then(|v| resolve_length(v, lengths))
    {
        text_style.set_letter_spacing(spacing as f32);
    }
    if let Some(value) = style.get("word-spacing")
        && !value.trim().eq_ignore_ascii_case("normal")
    {
        // shortcut: percentage spacing needs the shaped space advance, add it when qualified.
        match resolve_length(value, lengths)
            .filter(|v| !value.contains('%') && v.abs() <= 1_000_000.)
        {
            Some(spacing) => {
                text_style.set_word_spacing(spacing as f32);
            }
            None => diagnostics.push(Diagnostic::unsupported(None, Some("word-spacing"), value)),
        }
    }
    if let Some(line) = style.get("line-height") {
        let ratio = line
            .parse::<f64>()
            .ok()
            .or_else(|| resolve_length(line, lengths).map(|v| v / font_size));
        if let Some(ratio) = ratio.filter(|v| v.is_finite() && *v > 0.) {
            text_style.set_height(ratio as f32);
            text_style.set_height_override(true);
        }
    }

    use skia_safe::textlayout::{TextDecoration, TextDecorationStyle};
    let mut decoration = TextDecoration::NO_DECORATION;
    for value in style
        .get("text-decoration")
        .unwrap_or("none")
        .split_whitespace()
    {
        match value {
            "underline" => decoration |= TextDecoration::UNDERLINE,
            "overline" => decoration |= TextDecoration::OVERLINE,
            "line-through" => decoration |= TextDecoration::LINE_THROUGH,
            "none" => (),
            other => diagnostics.push(Diagnostic::unsupported(
                None,
                Some("text-decoration"),
                other,
            )),
        }
    }
    text_style.set_decoration_type(decoration);
    text_style.set_decoration_style(match style.get("text-decoration-style") {
        Some("double") => TextDecorationStyle::Double,
        Some("dotted") => TextDecorationStyle::Dotted,
        Some("dashed") => TextDecorationStyle::Dashed,
        Some("wavy") => TextDecorationStyle::Wavy,
        _ => TextDecorationStyle::Solid,
    });
    if let Some(value) = style
        .get("text-decoration-thickness")
        .and_then(|v| v.parse::<f32>().ok())
    {
        text_style.set_decoration_thickness_multiplier(value);
    }
    if let Some(color) = style.color("background-color") {
        let mut paint = skia_safe::Paint::default();
        paint.set_color4f(Color4f::new(color.r, color.g, color.b, color.a), None);
        text_style.set_background_paint(&paint);
    }
    text_style
}

pub fn utf16_to_byte(text: &str, index: usize) -> Option<usize> {
    let mut units = 0;
    for (byte, c) in text.char_indices() {
        if units == index {
            return Some(byte);
        }
        units += c.len_utf16();
        if units > index {
            return None;
        }
    }
    (units == index).then_some(text.len())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn surrogate_and_grapheme_boundaries() {
        let text = "A😀e\u{301}한";
        assert_eq!(utf16_to_byte(text, 1), Some(1));
        assert_eq!(utf16_to_byte(text, 2), None);
        assert_eq!(utf16_to_byte(text, 3), Some(5));
        let layout = shape(text, &ComputedStyle::default(), 200.).unwrap();
        assert_eq!(layout.grapheme_offsets, vec![0, 1, 3, 5, 6]);
        assert!(layout.height > 0.);
        assert!(!layout.selection_rects(1, 3).is_empty());
    }
    #[test]
    fn line_metrics_come_from_native_shaping() {
        let style = ComputedStyle::default();
        let wide = shape(
            "The native paragraph wraps at its assigned width.",
            &style,
            1000.,
        )
        .unwrap();
        let narrow = shape(
            "The native paragraph wraps at its assigned width.",
            &style,
            90.,
        )
        .unwrap();
        assert!(narrow.height > wide.height);
    }

    #[test]
    fn word_spacing_changes_measurement_wrapping_and_caret_geometry() {
        let text = "A😀 B";
        let mut style = ComputedStyle::default();
        style.values.insert("font-size".into(), "20".into());
        let plain = shape(text, &style, 200.).unwrap();
        style.values.insert("word-spacing".into(), "0.5em".into());
        let spaced = shape(text, &style, 200.).unwrap();
        assert!((spaced.intrinsic_width - plain.intrinsic_width - 10.).abs() < 0.1);
        assert_eq!(spaced.grapheme_offsets, vec![0, 1, 3, 4, 5]);
        let last_glyph = |layout: &TextLayout| layout.selection_rects(4, 5)[0][0];
        assert!((last_glyph(&spaced) - last_glyph(&plain) - 10.).abs() < 0.1);
        let [x, y, _, height] = spaced.caret_rect(5).unwrap();
        assert_eq!(spaced.caret_offset(x, y + height / 2.), 5);

        let width = (plain.intrinsic_width + spaced.intrinsic_width) / 2.;
        let measured = measure_runs(text, None, &style, width).unwrap();
        assert_eq!(measured.height, shape(text, &style, width).unwrap().height);
        assert!(measured.height > plain.height);
    }

    #[test]
    fn rich_runs_can_set_and_reset_word_spacing() {
        let mut style = ComputedStyle::default();
        let text = "A B\nC D";
        let plain = shape(text, &style, 200.).unwrap();
        style.values.insert("word-spacing".into(), "8px".into());
        let runs = serde_json::json!([
            {"text": "A B\n", "attributes": {"wordSpacing": 12}},
            {"text": "C D", "attributes": {"word-spacing": "normal"}}
        ]);
        let mixed = shape_runs(text, Some(&runs), &style, 200.).unwrap();
        assert!(
            (mixed.selection_rects(2, 3)[0][0] - plain.selection_rects(2, 3)[0][0] - 12.).abs()
                < 0.1
        );
        assert!(
            (mixed.selection_rects(6, 7)[0][0] - plain.selection_rects(6, 7)[0][0]).abs() < 0.1
        );
        assert!(mixed.diagnostics.is_empty());

        for invalid in ["10%", "potato", "1000001px"] {
            style.values.insert("word-spacing".into(), invalid.into());
            let rejected = shape(text, &style, 200.).unwrap();
            assert_eq!(rejected.intrinsic_width, plain.intrinsic_width);
            assert!(
                rejected
                    .diagnostics
                    .iter()
                    .any(
                        |diagnostic| diagnostic.property.as_deref() == Some("word-spacing")
                            && diagnostic.fidelity_lost
                    )
            );
        }
    }
}
