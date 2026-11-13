use flate2::{Compression, write::ZlibEncoder};
use omc_render::{RenderError, ResourceProvider};
use omc_scene::Scene;
use omc_style::Diagnostic;
use serde::{Deserialize, Serialize};
use skia_safe::{AlphaType, ColorSpace, ColorType, ImageInfo, Paint, Rect, surfaces};
use std::io::Write;

#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct PdfPrintOptions {
    pub bleed: f64,
    pub crop_marks: bool,
    pub bleed_marks: bool,
    pub cmyk: bool,
}

struct Sheet {
    width: f64,
    height: f64,
    margin: f64,
    bleed: f64,
    marks: Vec<[(f64, f64); 2]>,
}

impl Sheet {
    fn new(scene: &Scene, options: PdfPrintOptions) -> Result<Self, RenderError> {
        if !(0. ..=144.).contains(&options.bleed)
            || !(0.01..=1e6).contains(&scene.width)
            || !(0.01..=1e6).contains(&scene.height)
        {
            return Err(RenderError::InvalidDimensions);
        }
        let bleed = options.bleed;
        let mark_bleed = options.bleed_marks && bleed > 0.;
        let margin = if options.crop_marks || mark_bleed {
            bleed + 24.
        } else {
            bleed
        };
        let width = scene.width + 2. * margin;
        let height = scene.height + 2. * margin;
        let mut marks = Vec::new();
        for offset in [
            options.crop_marks.then_some(0.),
            mark_bleed.then_some(bleed),
        ]
        .into_iter()
        .flatten()
        {
            for (x, sx) in [(margin, -1.), (width - margin, 1.)] {
                for (y, sy) in [(margin, -1.), (height - margin, 1.)] {
                    let (near, far) = (bleed + 3., bleed + 21.);
                    marks.push([
                        (x + sx * near, y + sy * offset),
                        (x + sx * far, y + sy * offset),
                    ]);
                    marks.push([
                        (x + sx * offset, y + sy * near),
                        (x + sx * offset, y + sy * far),
                    ]);
                }
            }
        }
        Ok(Self {
            width,
            height,
            margin,
            bleed,
            marks,
        })
    }

    fn boxes(&self) -> String {
        let m = self.margin;
        let b = m - self.bleed;
        let (w, h) = (self.width, self.height);
        format!(
            "/TrimBox [{m} {m} {} {}]\n/BleedBox [{b} {b} {} {}]\n",
            w - m,
            h - m,
            w - b,
            h - b
        )
    }
}

pub(super) fn export(
    scene: &Scene,
    resources: &dyn ResourceProvider,
    options: PdfPrintOptions,
    max_bytes: usize,
) -> Result<(Vec<u8>, Vec<Diagnostic>), RenderError> {
    let sheet = Sheet::new(scene, options)?;
    if options.cmyk {
        return cmyk_pdf(scene, resources, &sheet, max_bytes);
    }
    let mut bytes = Vec::new();
    let diagnostics;
    {
        let document = skia_safe::pdf::new_document(&mut bytes, None);
        let mut page = document.begin_page((sheet.width as f32, sheet.height as f32), None);
        let canvas = page.canvas();
        let m = (sheet.margin - sheet.bleed) as f32;
        let saved = canvas.save();
        canvas.clip_rect(
            Rect::from_ltrb(m, m, sheet.width as f32 - m, sheet.height as f32 - m),
            None,
            None,
        );
        canvas.translate((sheet.margin as f32, sheet.margin as f32));
        diagnostics = omc_render::paint_scene(canvas, scene, resources)?;
        canvas.restore_to_count(saved);
        let mut paint = Paint::default();
        paint.set_stroke_width(0.25);
        for [(ax, ay), (bx, by)] in &sheet.marks {
            canvas.draw_line((*ax as f32, *ay as f32), (*bx as f32, *by as f32), &paint);
        }
        page.end_page().close();
    }
    Ok((with_print_boxes(&bytes, &sheet.boxes())?, diagnostics))
}

/// Append a replacement Page object with the print boxes and a new xref subsection. This
/// keeps Skia's original vector drawing, compressed streams, and byte offsets intact.
fn with_print_boxes(bytes: &[u8], boxes: &str) -> Result<Vec<u8>, RenderError> {
    fn update(bytes: &[u8], boxes: &str) -> Option<Vec<u8>> {
        let start = bytes
            .windows(9)
            .rposition(|window| window == b"startxref")?;
        let xref = std::str::from_utf8(bytes.get(start + 9..)?)
            .ok()?
            .split_whitespace()
            .next()?
            .parse::<usize>()
            .ok()?;
        let trailer = std::str::from_utf8(bytes.get(xref..start)?).ok()?;
        let (table, trailer) = trailer.split_once("trailer")?;
        let root = trailer
            .split("/Root")
            .nth(1)?
            .split_whitespace()
            .take(3)
            .collect::<Vec<_>>();
        if root.len() != 3 || root[2] != "R" {
            return None;
        }
        let mut lines = table.lines();
        if lines.next()? != "xref" || !lines.next()?.starts_with("0 ") {
            return None;
        }
        let mut page = None;
        let mut size = 0;
        for (object, line) in lines.enumerate() {
            size = object + 1;
            let mut parts = line.split_whitespace();
            let Some(offset) = parts.next().and_then(|offset| offset.parse::<usize>().ok()) else {
                continue;
            };
            if offset == 0 || parts.next()? != "00000" || parts.next()? != "n" {
                continue;
            }
            let prefix = format!("{object} 0 obj\n<</Type /Page\n");
            if bytes.get(offset..)?.starts_with(prefix.as_bytes()) {
                let rest = bytes.get(offset + prefix.len()..xref)?;
                let end = rest.windows(6).position(|window| window == b"endobj")?;
                page = Some((object, prefix, &rest[..end]));
            }
        }
        let (object, prefix, rest) = page?;
        let mut result = bytes.to_vec();
        let offset = result.len();
        result.extend(prefix.as_bytes());
        result.extend(boxes.as_bytes());
        result.extend(rest);
        result.extend(b"endobj\n");
        let next_xref = result.len();
        write!(result,"xref\n{object} 1\n{offset:010} 00000 n \ntrailer\n<< /Size {size} /Root {} {} R /Prev {xref} >>\nstartxref\n{next_xref}\n%%EOF\n",root[0],root[1]).ok()?;
        Some(result)
    }
    update(bytes, boxes)
        .ok_or_else(|| RenderError::Backend("could not add PDF trim and bleed boxes".into()))
}

fn cmyk_pdf(
    scene: &Scene,
    resources: &dyn ResourceProvider,
    sheet: &Sheet,
    max_bytes: usize,
) -> Result<(Vec<u8>, Vec<Diagnostic>), RenderError> {
    let (width, height) = (
        scene.width + 2. * sheet.bleed,
        scene.height + 2. * sheet.bleed,
    );
    let scale = (300. / 72.0_f64)
        .min((max_bytes as f64 / (12. * width * height)).sqrt())
        .min(32768. / width.max(height));
    if scale < 0.5 {
        return Err(RenderError::ResourceLimit(
            "CMYK print page is too large to rasterize".into(),
        ));
    }
    let size = (
        (width * scale).ceil() as i32,
        (height * scale).ceil() as i32,
    );
    let info = ImageInfo::new(
        size,
        ColorType::RGBA8888,
        AlphaType::Opaque,
        ColorSpace::new_srgb(),
    );
    let mut surface = surfaces::raster(&info, None, None)
        .ok_or_else(|| RenderError::Backend("CMYK page allocation failed".into()))?;
    let canvas = surface.canvas();
    canvas.clear(skia_safe::Color::WHITE);
    canvas.scale((size.0 as f32 / width as f32, size.1 as f32 / height as f32));
    canvas.translate((sheet.bleed as f32, sheet.bleed as f32));
    let mut diagnostics = omc_render::paint_scene(canvas, scene, resources)?;
    diagnostics.push(Diagnostic {
        code: "pdf_cmyk_raster".into(),
        severity: "info".into(),
        node_id: None,
        property: Some("cmyk".into()),
        original: "CMYK export".into(),
        action: "Rendered design to a DeviceCMYK bitmap and kept vector printer's marks".into(),
        fidelity_lost: false,
    });
    let mut pixels = vec![0; size.0 as usize * size.1 as usize * 4];
    if !surface.read_pixels(&info, &mut pixels, size.0 as usize * 4, (0, 0)) {
        return Err(RenderError::Backend("CMYK page readback failed".into()));
    }
    for color in pixels.chunks_exact_mut(4) {
        let max = *color[..3].iter().max().unwrap();
        let ink = |channel| {
            if max == 0 {
                0
            } else {
                ((max - channel) as u16 * 255 / max as u16) as u8
            }
        };
        color.copy_from_slice(&[ink(color[0]), ink(color[1]), ink(color[2]), 255 - max]);
    }
    let mut encoder = ZlibEncoder::new(Vec::new(), Compression::fast());
    encoder.write_all(&pixels).map_err(io_error)?;
    let image = encoder.finish().map_err(io_error)?;
    let margin = sheet.margin - sheet.bleed;
    let mut contents = format!("q {width} 0 0 {height} {margin} {margin} cm /Design Do Q\n");
    if !sheet.marks.is_empty() {
        contents.push_str("1 1 1 1 K 0.25 w\n");
        for [(ax, ay), (bx, by)] in &sheet.marks {
            use std::fmt::Write as _;
            let _ = writeln!(
                contents,
                "{ax} {} m {bx} {} l",
                sheet.height - ay,
                sheet.height - by
            );
        }
        contents.push_str("S\n");
    }
    let page = format!(
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {} {}]\n{} /Resources << /XObject << /Design 4 0 R >> >> /Contents 5 0 R >>",
        sheet.width,
        sheet.height,
        sheet.boxes()
    );
    let bitmap = format!(
        "<< /Type /XObject /Subtype /Image /Width {} /Height {} /BitsPerComponent 8 /ColorSpace /DeviceCMYK /Filter /FlateDecode /Length {} >>\nstream\n",
        size.0,
        size.1,
        image.len()
    );
    let mut bytes = b"%PDF-1.7\n%\xE2\xE3\xCF\xD3\n".to_vec();
    let mut xref = Vec::new();
    let mut object = |id, header: &str, payload: Option<&[u8]>| {
        xref.push(bytes.len());
        writeln!(bytes, "{id} 0 obj\n{header}").map_err(io_error)?;
        if let Some(payload) = payload {
            bytes.extend(payload);
            bytes.extend(b"\nendstream\n");
        }
        bytes.extend(b"endobj\n");
        Ok::<_, RenderError>(())
    };
    object(1, "<< /Type /Catalog /Pages 2 0 R >>", None)?;
    object(2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", None)?;
    object(3, &page, None)?;
    object(4, bitmap.trim_end_matches('\n'), Some(&image))?;
    object(
        5,
        &format!("<< /Length {} >>\nstream", contents.len()),
        Some(contents.as_bytes()),
    )?;
    let xref_start = bytes.len();
    bytes.extend(b"xref\n0 6\n0000000000 65535 f \n");
    for offset in xref {
        writeln!(bytes, "{offset:010} 00000 n ").map_err(io_error)?;
    }
    write!(
        bytes,
        "trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n{xref_start}\n%%EOF\n"
    )
    .map_err(io_error)?;
    Ok((bytes, diagnostics))
}

fn io_error(error: std::io::Error) -> RenderError {
    RenderError::Backend(error.to_string())
}
