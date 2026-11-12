//! Native paragraph shaping and its shared measurement, drawing and caret maps.
mod on_path;
mod profile_fonts;
pub use on_path::shape_on_path;
pub use profile_fonts::{
    font_face_count, profile_font_downloads_allowed, profile_font_generation, profile_font_manager,
    set_profile_font_downloads,
};

use omc_style::{ComputedStyle, Diagnostic, LengthContext, resolve_length};
use skia_safe::{
    Canvas, Color4f, FontMgr, FontStyle, Path, Picture, PictureRecorder, Rect, font_style,
    textlayout::{
        FontCollection, Paragraph, ParagraphBuilder, ParagraphStyle, PlaceholderAlignment,
        PlaceholderStyle, RectHeightStyle, RectWidthStyle, TextAlign, TextBaseline, TextDirection,
        TextStyle,
    },
};
use unicode_segmentation::UnicodeSegmentation;

pub const INTER_REGULAR: &[u8] = include_bytes!("../fonts/Inter-Regular.ttf");

pub fn bundled_font_manager() -> FontMgr {
    thread_local! {
        static BUNDLED: FontMgr = {
            let system = FontMgr::default();
            let mut fonts = skia_safe::textlayout::TypefaceFontProvider::new();
            for bytes in [
                INTER_REGULAR,
                include_bytes!("../fonts/Inter-Italic.ttf"),
                include_bytes!("../fonts/Inter-SemiBold.ttf"),
                include_bytes!("../fonts/Inter-Bold.ttf"),
            ] {
                if let Some(face) = system.new_from_data(bytes, None) {
                    fonts.register_typeface(face, None);
                }
            }
            FontMgr::from(fonts)
        };
    }
    BUNDLED.with(Clone::clone)
}

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
    #[error("text contains glyphs without vector outlines or exceeds the path complexity limit")]
    Outline,
}

thread_local! {
    static SESSION_FONTS: std::cell::RefCell<Option<FontMgr>> = const { std::cell::RefCell::new(None) };
}

pub struct FontScope {
    previous: Option<FontMgr>,
    thread: std::marker::PhantomData<std::rc::Rc<()>>,
}

impl Drop for FontScope {
    fn drop(&mut self) {
        SESSION_FONTS.with(|current| {
            current.replace(self.previous.take());
        });
    }
}

pub fn font_scope(manager: Option<FontMgr>) -> FontScope {
    let previous = SESSION_FONTS.with(|current| current.replace(manager));
    FontScope {
        previous,
        thread: std::marker::PhantomData,
    }
}

pub fn session_fonts() -> Option<FontMgr> {
    SESSION_FONTS.with(|current| current.borrow().clone())
}

fn matching_face(manager: &FontMgr, family: &str, style: FontStyle) -> Option<skia_safe::Typeface> {
    session_fonts()
        .and_then(|loaded| loaded.match_family_style(family, style))
        .or_else(|| bundled_font_manager().match_family_style(family, style))
        .or_else(|| manager.match_family_style(family, style))
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
    path_outline: Option<String>,
    selection_boxes: Vec<SelectionBox>,
    carets: Vec<CaretStop>,
    pub width: f64,
    pub height: f64,
    pub alphabetic_baseline: f64,
    pub intrinsic_width: f64,
    pub line_count: usize,
    pub truncated: bool,
    pub utf16_len: usize,
    pub grapheme_offsets: Vec<usize>,
    pub diagnostics: Vec<Diagnostic>,
}

impl TextLayout {
    pub fn path_outline(&self) -> Option<Path> {
        self.path_outline.as_deref().and_then(Path::from_svg)
    }

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
    let (paragraph, diagnostics, font_size, display_offsets, x_offset) =
        paragraph(text, runs, style, width)?;
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
            display_offsets[range[0]]..display_offsets[range[1]],
            RectHeightStyle::Tight,
            RectWidthStyle::Tight,
        ) {
            let r = text_box.rect;
            let rect = [
                r.left as f64 + x_offset,
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
                x: before as f64 + x_offset,
                top: r.top as f64,
                bottom: r.bottom as f64,
            });
            carets.push(CaretStop {
                offset: range[1],
                x: after as f64 + x_offset,
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
                .min_by_key(|&p| display_offsets[p].abs_diff(raw))
                .unwrap_or(0);
            carets.push(CaretStop {
                offset: boundary,
                x: x + x_offset,
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
    paragraph.paint(canvas, (x_offset as f32, 0.));
    let picture = recorder
        .finish_recording_as_picture(None)
        .ok_or(TextError::Recording)?;
    Ok(TextLayout {
        width,
        height,
        alphabetic_baseline,
        intrinsic_width,
        line_count: paragraph.line_number(),
        truncated: paragraph.did_exceed_max_lines(),
        utf16_len: offset,
        grapheme_offsets,
        diagnostics,
        picture,
        path_outline: None,
        selection_boxes,
        carets,
    })
}

#[derive(Clone, Copy, Debug)]
pub struct TextMeasurement {
    pub width: f64,
    pub height: f64,
    pub baseline: f64,
    pub line_count: usize,
    pub orphan: bool,
    pub truncated: bool,
}
pub fn measure_runs(
    text: &str,
    runs: Option<&serde_json::Value>,
    style: &ComputedStyle,
    width: f64,
) -> Result<TextMeasurement, TextError> {
    let (paragraph, _, _, display_offsets, _) = paragraph(text, runs, style, width)?;
    let lines = paragraph.line_number();
    let orphan = last_line_has_orphan(&paragraph, text, &display_offsets);
    Ok(TextMeasurement {
        width: paragraph.max_intrinsic_width() as f64,
        height: paragraph.height() as f64,
        baseline: paragraph.alphabetic_baseline() as f64,
        line_count: lines,
        orphan,
        truncated: paragraph.did_exceed_max_lines(),
    })
}
pub fn outline(
    text: &str,
    runs: Option<&serde_json::Value>,
    style: &ComputedStyle,
    width: f64,
) -> Result<Path, TextError> {
    let (mut paragraph, _, _, _, x_offset) = paragraph(text, runs, style, width)?;
    let mut path = Path::new();
    let mut unsupported = false;
    paragraph.visit(|_, info| {
        let Some(info) = info.filter(|_| !unsupported) else {
            return;
        };
        let origin = info.origin();
        let font = info.font();
        for (&glyph, position) in info.glyphs().iter().zip(info.positions()) {
            if let Some(outline) = font.get_path(glyph) {
                if path.count_verbs() + outline.count_verbs() > 10_000 {
                    unsupported = true;
                    break;
                }
                path.add_path(
                    &outline,
                    (
                        origin.x + position.x + x_offset as f32,
                        origin.y + position.y,
                    ),
                    None,
                );
            } else {
                let mut bounds = [Rect::default()];
                font.get_bounds(&[glyph], &mut bounds, None);
                if !bounds[0].is_empty() {
                    unsupported = true;
                    break;
                }
            }
        }
    });
    if unsupported || path.is_empty() {
        return Err(TextError::Outline);
    }
    Ok(path)
}

fn paragraph(
    text: &str,
    runs: Option<&serde_json::Value>,
    style: &ComputedStyle,
    width: f64,
) -> Result<(Paragraph, Vec<Diagnostic>, f64, Vec<usize>, f64), TextError> {
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
    collection.set_dynamic_font_manager(session_fonts());
    collection.set_asset_font_manager(bundled_font_manager());
    let text_style = styled_text(style, &font_manager, &mut diagnostics);
    let mut paragraph_style = ParagraphStyle::new();
    paragraph_style.set_text_style(&text_style);
    paragraph_style.set_text_align(match style.get("text-align") {
        Some("center") => TextAlign::Center,
        Some("right") | Some("end") => TextAlign::Right,
        Some("justify") => TextAlign::Justify,
        _ => TextAlign::Left,
    });
    let right_to_left = match style.get("direction") {
        Some("rtl") => true,
        Some("auto") => text.chars().find(|ch| ch.is_alphabetic())
            .is_some_and(|ch| matches!(ch as u32,0x0590..=0x08ff|0xfb1d..=0xfdff|0xfe70..=0xfefc|0x1ee00..=0x1eeff)),
        _ => false,
    };
    if right_to_left {
        paragraph_style.set_text_direction(TextDirection::RTL);
    }
    if let Some(lines) = style
        .get("omc-max-lines")
        .and_then(|value| value.parse::<usize>().ok())
        .filter(|lines| *lines > 0)
    {
        paragraph_style.set_max_lines(lines).set_ellipsis("…");
    }
    let mut builder = ParagraphBuilder::new(&paragraph_style, collection);
    let mut display_offsets = vec![0];
    let mut word_start = true;
    let mut paragraph_decorations = ParagraphDecorations::new();
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
                        "textDecorationColor" => "text-decoration-color",
                        "fontFeatures" => "omc-font-features",
                        "fontVariations" => "omc-font-variations",
                        "textCase" => "text-transform",
                        "textListStyle" => "omc-list-style",
                        "textListDepth" => "omc-list-depth",
                        "textParagraphIndent" => "text-indent",
                        "textParagraphSpacing" => "omc-paragraph-spacing",
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
                        "fontFeatures" | "fontVariations" if value.is_object() => {
                            Some(value.to_string())
                        }
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
            paragraph_decorations.append(
                &mut builder,
                source,
                &run_style,
                &computed,
                &font_manager,
                &mut word_start,
                &mut display_offsets,
            );
        }
        if combined != text {
            return Err(TextError::InvalidRuns(
                "run content differs from canonical text".into(),
            ));
        }
    } else {
        paragraph_decorations.append(
            &mut builder,
            text,
            &text_style,
            style,
            &font_manager,
            &mut word_start,
            &mut display_offsets,
        );
    }
    let mut paragraph = builder.build();
    paragraph.layout(width.max(0.01) as f32);
    let wrapped_width = match style.get("omc-wrap-style") {
        Some(mode @ ("balance" | "pretty")) => {
            refine_wrap(&mut paragraph, text, &display_offsets, width, mode)
        }
        _ => width,
    };
    let x_offset = match style.get("text-align") {
        Some("center") => (width - wrapped_width) * 0.5,
        Some("right" | "end") => width - wrapped_width,
        _ => 0.,
    };
    Ok((paragraph, diagnostics, font_size, display_offsets, x_offset))
}

fn last_line_has_orphan(paragraph: &Paragraph, text: &str, display_offsets: &[usize]) -> bool {
    let count = paragraph.line_number();
    count > 1
        && paragraph
            .get_line_metrics_at(count - 1)
            .is_some_and(|line| {
                let y = line.baseline - line.ascent * 0.5;
                let start = [line.left, line.left + line.width]
                    .into_iter()
                    .map(|x| {
                        paragraph
                            .get_glyph_position_at_coordinate((x as f32, y as f32))
                            .position
                            .max(0) as usize
                    })
                    .min()
                    .unwrap_or(0);
                let original = display_offsets.partition_point(|offset| *offset < start);
                utf16_to_byte(text, original)
                    .is_some_and(|byte| text[byte..].unicode_words().take(2).count() == 1)
            })
}

fn refine_wrap(
    paragraph: &mut Paragraph,
    text: &str,
    offsets: &[usize],
    width: f64,
    mode: &str,
) -> f64 {
    let lines = paragraph.line_number();
    if lines < 2
        || lines > 100
        || width > 10000.
        || paragraph.did_exceed_max_lines()
        || !paragraph
            .get_line_metrics()
            .iter()
            .take(lines - 1)
            .any(|line| !line.hard_break)
    {
        return width;
    }
    let mut best = width;
    if mode == "pretty" {
        if last_line_has_orphan(paragraph, text, offsets) {
            for i in 1..=12 {
                let candidate = (width * (1. - f64::from(i) * 0.01)).floor().max(1.);
                paragraph.layout(candidate as f32);
                if paragraph.line_number() != lines || paragraph.did_exceed_max_lines() {
                    break;
                }
                if !last_line_has_orphan(paragraph, text, offsets) {
                    best = candidate;
                    break;
                }
            }
        }
    } else {
        let mut lower = (width / f64::from(lines as u32)).floor().max(1.);
        let mut upper = width;
        while upper - lower > 1. {
            let candidate = ((upper + lower) * 0.5).floor();
            paragraph.layout(candidate as f32);
            if paragraph.line_number() <= lines && !paragraph.did_exceed_max_lines() {
                best = candidate;
                upper = candidate;
            } else {
                lower = candidate + 1.;
            }
        }
    }
    paragraph.layout(best.max(0.01) as f32);
    best
}

struct ParagraphDecorations {
    at_start: bool,
    numbering: [usize; 16],
}

impl ParagraphDecorations {
    fn new() -> Self {
        Self {
            at_start: true,
            numbering: [0; 16],
        }
    }

    fn append(
        &mut self,
        builder: &mut ParagraphBuilder,
        source: &str,
        style: &TextStyle,
        computed: &ComputedStyle,
        fonts: &FontMgr,
        word_start: &mut bool,
        offsets: &mut Vec<usize>,
    ) {
        if computed.get("text-indent").is_none()
            && computed.get("omc-paragraph-spacing").is_none()
            && matches!(computed.get("omc-list-style"), None | Some("none"))
        {
            if self.at_start || source.contains('\n') {
                self.numbering.fill(0);
            }
            if !source.is_empty() {
                self.at_start = source.ends_with('\n');
            }
            append_source(
                builder,
                source,
                style,
                computed.get("text-transform"),
                fonts,
                word_start,
                offsets,
            );
            return;
        }
        for chunk in source.split_inclusive('\n') {
            if self.at_start {
                let list = computed.get("omc-list-style").unwrap_or("none");
                let level = computed
                    .get("omc-list-depth")
                    .and_then(|value| value.parse::<usize>().ok())
                    .unwrap_or(0)
                    .min(15);
                let indent = computed
                    .get("text-indent")
                    .and_then(|value| {
                        resolve_length(
                            value,
                            LengthContext {
                                font_size: f64::from(style.font_size()),
                                ..LengthContext::default()
                            },
                        )
                    })
                    .unwrap_or(0.)
                    .clamp(0., 10000.);
                let list_indent = if list != "none" {
                    level as f32 * style.font_size()
                } else {
                    0.
                };
                if indent > 0. || list_indent > 0. {
                    builder.add_placeholder(&PlaceholderStyle::new(
                        indent as f32 + list_indent,
                        0.,
                        PlaceholderAlignment::Baseline,
                        TextBaseline::Alphabetic,
                        0.,
                    ));
                    *offsets.last_mut().unwrap() += 1;
                }
                let prefix = match list {
                    "bulleted" => {
                        self.numbering.fill(0);
                        Some(if level % 2 == 0 { "•  " } else { "◦  " }.to_owned())
                    }
                    "numbered" => {
                        self.numbering[level] += 1;
                        self.numbering[level + 1..].fill(0);
                        Some(format!("{}.  ", self.numbering[level]))
                    }
                    _ => {
                        self.numbering.fill(0);
                        None
                    }
                };
                if let Some(prefix) = prefix {
                    let mut marker = style.clone();
                    marker
                        .set_decoration_type(skia_safe::textlayout::TextDecoration::NO_DECORATION);
                    builder.push_style(&marker);
                    builder.add_text(&prefix);
                    builder.pop();
                    *offsets.last_mut().unwrap() += prefix.encode_utf16().count();
                }
            }
            self.at_start = chunk.ends_with('\n');
            let paragraph_spacing = computed
                .get("omc-paragraph-spacing")
                .and_then(|value| value.parse::<f32>().ok())
                .unwrap_or(0.)
                .clamp(0., 10000.);
            let case = computed.get("text-transform");
            if self.at_start && paragraph_spacing > 0. {
                append_source(
                    builder,
                    &chunk[..chunk.len() - 1],
                    style,
                    case,
                    fonts,
                    word_start,
                    offsets,
                );
                builder.add_placeholder(&PlaceholderStyle::new(
                    0.,
                    paragraph_spacing + style.font_size() * 0.24,
                    PlaceholderAlignment::BelowBaseline,
                    TextBaseline::Alphabetic,
                    0.,
                ));
                *offsets.last_mut().unwrap() += 1;
                append_source(builder, "\n", style, case, fonts, word_start, offsets);
            } else {
                append_source(builder, chunk, style, case, fonts, word_start, offsets);
            }
        }
    }
}

fn append_source(
    builder: &mut ParagraphBuilder,
    source: &str,
    style: &TextStyle,
    case: Option<&str>,
    fonts: &FontMgr,
    word_start: &mut bool,
    offsets: &mut Vec<usize>,
) {
    let synthetic = case == Some("smallCaps")
        && !style
            .typeface()
            .or_else(|| {
                style
                    .font_families()
                    .iter()
                    .find_map(|family| matching_face(fonts, family, style.font_style()))
            })
            .is_some_and(|face| open_type_features(&face).contains("smcp"));
    if !synthetic {
        builder.push_style(style);
        let display = display_text(source, case, word_start, offsets);
        builder.add_text(&display);
        builder.pop();
        return;
    }
    let mut small = style.clone();
    small.set_font_size(style.font_size() * 0.72);
    let mut start = 0;
    let mut lower = source.chars().next().is_some_and(char::is_lowercase);
    for (at, character) in source
        .char_indices()
        .chain(std::iter::once((source.len(), '\0')))
    {
        let current = character.is_lowercase();
        if at > start && (current != lower || at == source.len()) {
            builder.push_style(if lower { &small } else { style });
            let display = display_text(
                &source[start..at],
                lower.then_some("upper"),
                word_start,
                offsets,
            );
            builder.add_text(&display);
            builder.pop();
            start = at;
        }
        lower = current;
    }
}

pub fn open_type_features(face: &skia_safe::Typeface) -> std::collections::BTreeSet<String> {
    let mut output = std::collections::BTreeSet::new();
    for tag in [b"GSUB", b"GPOS"] {
        let Some(data) = face.copy_table_data(u32::from_be_bytes(*tag)) else {
            continue;
        };
        let bytes = data.as_bytes();
        let read = |offset: usize| -> Option<usize> {
            Some(usize::from(u16::from_be_bytes(
                bytes.get(offset..offset + 2)?.try_into().ok()?,
            )))
        };
        let Some(list) = read(6) else {
            continue;
        };
        let Some(count) = read(list) else {
            continue;
        };
        for i in 0..count {
            let offset = list + 2 + i * 6;
            if let Some(tag) = bytes
                .get(offset..offset + 4)
                .and_then(|tag| std::str::from_utf8(tag).ok())
            {
                output.insert(tag.into());
            }
        }
    }
    output
}

fn display_text(
    source: &str,
    case: Option<&str>,
    word_start: &mut bool,
    offsets: &mut Vec<usize>,
) -> String {
    let mut result = String::with_capacity(source.len());
    let mut display_offset = *offsets.last().unwrap();
    for character in source.chars() {
        let before = result.len();
        match case {
            Some("upper" | "uppercase") => result.extend(character.to_uppercase()),
            Some("lower" | "lowercase") => result.extend(character.to_lowercase()),
            Some("title" | "capitalize") if *word_start && character.is_alphanumeric() => {
                result.extend(character.to_uppercase())
            }
            _ => result.push(character),
        }
        if character.is_alphanumeric() {
            *word_start = false;
        } else if !matches!(character, '\'' | '’') {
            let mut bytes = [0; 5];
            bytes[0] = b'a';
            let len = 1 + character.encode_utf8(&mut bytes[1..]).len();
            if std::str::from_utf8(&bytes[..len]).is_ok_and(|s| s.graphemes(true).count() > 1) {
                *word_start = true;
            }
        }
        if character.len_utf16() == 2 {
            offsets.push(display_offset);
        }
        display_offset += result[before..].encode_utf16().count();
        offsets.push(display_offset);
    }
    result
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
        .all(|f| matching_face(font_manager, f, font_style).is_none())
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
    if style.get("text-transform") == Some("smallCaps") {
        text_style.add_font_feature("smcp", 1);
    }
    if let Some(variations) = style.get("omc-font-variations").and_then(|value| {
        serde_json::from_str::<std::collections::BTreeMap<String, f32>>(value).ok()
    }) {
        use skia_safe::{
            FontArguments,
            font_arguments::{VariationPosition, variation_position::Coordinate},
        };
        let coordinates = variations
            .into_iter()
            .filter_map(|(tag, value)| {
                let tag: [u8; 4] = tag.as_bytes().try_into().ok()?;
                Some(Coordinate {
                    axis: u32::from_be_bytes(tag).into(),
                    value,
                })
            })
            .collect::<Vec<_>>();
        if !coordinates.is_empty() {
            let arguments = FontArguments::new().set_variation_design_position(VariationPosition {
                coordinates: &coordinates,
            });
            text_style.set_font_arguments(&arguments);
        }
    }
    if let Some(features) = style.get("omc-font-features").and_then(|value| {
        serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(value).ok()
    }) {
        for (tag, enabled) in features {
            if tag.len() == 4
                && tag.is_ascii()
                && let Some(enabled) = enabled.as_bool()
            {
                text_style.add_font_feature(tag, i32::from(enabled));
            }
        }
    }
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
    if let Some(color) = style.color("text-decoration-color") {
        text_style
            .set_decoration_color(Color4f::new(color.r, color.g, color.b, color.a).to_color());
    }
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
    fn vector_outline_includes_native_line_layout() {
        let text = "Hello world\n한글";
        let style = ComputedStyle::default();
        let path = outline(text, None, &style, 200.).unwrap();
        let line = outline("Hello world", None, &style, 200.).unwrap();
        assert!(path.count_verbs() > line.count_verbs());
        assert!(path.compute_tight_bounds().bottom > line.compute_tight_bounds().bottom);
    }
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
