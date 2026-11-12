//! Native controls use the same shaping and caret geometry as document text.
//! Cache only bounded visible text; document authority stays in the service.
use crate::{
    app::{App, EditTarget},
    geometry::Rect,
    text::EditBuffer,
};
use omc_style::ComputedStyle;
use omc_text::{TextLayout, shape};
use skia_safe::{Canvas, Color, Paint, Rect as SkRect};
use std::{cell::RefCell, collections::VecDeque, rc::Rc};

struct Entry {
    key: (String, u32, u32, u64),
    layout: Rc<TextLayout>,
}
thread_local! {static CACHE:RefCell<VecDeque<Entry>>=const{RefCell::new(VecDeque::new())};}

pub fn layout(body: &str, size: f32, color: Color, width: f64) -> Option<Rc<TextLayout>> {
    if body.len() > 16 * 1024 {
        return None;
    }
    let key = (
        body.to_string(),
        size.to_bits(),
        u32::from_be_bytes([color.a(), color.r(), color.g(), color.b()]),
        width.to_bits(),
    );
    CACHE.with(|cache| {
        let mut cache = cache.borrow_mut();
        if let Some(index) = cache.iter().position(|entry| entry.key == key) {
            let entry = cache.remove(index)?;
            let result = entry.layout.clone();
            cache.push_front(entry);
            return Some(result);
        }
        let mut style = ComputedStyle::default();
        style
            .values
            .insert("font-family".into(), "sans-serif".into());
        style.values.insert("font-size".into(), format!("{size}px"));
        style.values.insert(
            "color".into(),
            format!(
                "#{:02x}{:02x}{:02x}{:02x}",
                color.r(),
                color.g(),
                color.b(),
                color.a()
            ),
        );
        let shaped = Rc::new(shape(body, &style, width).ok()?);
        cache.push_front(Entry {
            key,
            layout: shaped.clone(),
        });
        while cache.len() > 128
            || cache.iter().map(|entry| entry.key.0.len()).sum::<usize>() > 256 * 1024
        {
            cache.pop_back();
        }
        Some(shaped)
    })
}

pub fn editor_rect(app: &App) -> Option<Rect> {
    let edit = app.editing.as_ref()?;
    if matches!(edit.target, EditTarget::LibraryDescription) {
        return app
            .controls
            .iter()
            .find(|control| matches!(control.action, crate::app::Action::EditLibraryDescription))
            .map(|control| {
                Rect::new(
                    control.rect.x + 9.,
                    control.rect.y + 7.,
                    control.rect.width - 18.,
                    control.rect.height - 14.,
                )
            });
    }
    if let EditTarget::Property { property, .. } = &edit.target {
        return app
            .controls
            .iter()
            .find(|c| matches!(&c.action,crate::app::Action::Field(p) if p==property))
            .map(|c| {
                Rect::new(
                    c.rect.x + 8.,
                    c.rect.y + 4.,
                    c.rect.width - 16.,
                    c.rect.height - 8.,
                )
            });
    }
    let viewport = app.canvas_rect();
    Some(Rect::new(
        viewport.x + 37.,
        viewport.y + viewport.height - 87.,
        (viewport.width - 74.).max(80.),
        48.,
    ))
}

pub struct Prepared {
    layout: Rc<TextLayout>,
    origin: (f64, f64),
    base_units: usize,
    caret_units: usize,
    selection: (usize, usize),
    composing: bool,
}

impl Prepared {
    pub fn caret(&self) -> Option<Rect> {
        let [x, y, w, h] = self.layout.caret_rect(self.caret_units)?;
        Some(Rect::new(self.origin.0 + x, self.origin.1 + y, w, h))
    }
    pub fn offset(&self, x: f64, y: f64) -> usize {
        self.base_units
            + self
                .layout
                .caret_offset(x - self.origin.0, y - self.origin.1)
    }
    pub fn paint(&self, canvas: &Canvas, area: Rect) {
        let saved = canvas.save();
        canvas.clip_rect(
            SkRect::from_xywh(
                area.x as f32,
                area.y as f32,
                area.width as f32,
                area.height as f32,
            ),
            None,
            true,
        );
        let mut paint = Paint::default();
        paint.set_color(Color::from_argb(75, 97, 81, 215));
        for [x, y, w, h] in self
            .layout
            .selection_rects(self.selection.0, self.selection.1)
        {
            let (y, h) = if self.composing {
                (y + h - 1., 1.5)
            } else {
                (y, h)
            };
            canvas.draw_rect(
                SkRect::from_xywh(
                    (self.origin.0 + x) as f32,
                    (self.origin.1 + y) as f32,
                    w as f32,
                    h as f32,
                ),
                &paint,
            );
        }
        self.layout.paint(canvas, self.origin.0, self.origin.1);
        if let Some(caret) = self.caret() {
            paint.set_color(Color::from_rgb(97, 81, 215));
            canvas.draw_rect(
                SkRect::from_xywh(
                    caret.x as f32,
                    caret.y as f32,
                    1.5,
                    caret.height.max(12.) as f32,
                ),
                &paint,
            );
        }
        canvas.restore_to_count(saved);
    }
}

pub fn prepare(buffer: &EditBuffer, area: Rect, size: f32) -> Option<Prepared> {
    let display = buffer.display_text();
    let range = buffer.selection();
    let composing = !buffer.preedit.is_empty();
    let caret = if composing {
        let offset = buffer
            .preedit_selection
            .map_or(buffer.preedit.len(), |(_, end)| {
                end.min(buffer.preedit.len())
            });
        let mut offset = offset;
        while !buffer.preedit.is_char_boundary(offset) {
            offset -= 1;
        }
        range.start + offset
    } else {
        buffer.caret
    };
    // Only shape a context window in a control. The document canvas still paints
    // the complete source paragraph. Keep the caret visible without blocking on
    // megabytes of private preview text during every pointer event.
    let mut start = caret.saturating_sub(4096);
    while !display.is_char_boundary(start) {
        start += 1;
    }
    let mut end = (start + 8192).min(display.len());
    while !display.is_char_boundary(end) {
        end -= 1;
    }
    let base_units = display[..start].encode_utf16().count();
    let caret_units = display[start..caret].encode_utf16().count();
    let selection = if composing {
        range.start..range.start + buffer.preedit.len()
    } else {
        range
    };
    let begin = selection.start.max(start).min(end);
    let finish = selection.end.max(start).min(end);
    let selection = (
        display[start..begin].encode_utf16().count(),
        display[start..finish].encode_utf16().count(),
    );
    let layout = layout(
        &display[start..end],
        size,
        crate::theme::color(Color::from_rgb(32, 38, 50)),
        area.width.max(1.),
    )?;
    let vertical = layout
        .caret_rect(caret_units)
        .map_or(0., |r| (r[1] + r[3] - area.height).max(0.));
    Some(Prepared {
        layout,
        origin: (area.x, area.y - vertical),
        base_units,
        caret_units,
        selection,
        composing,
    })
}

pub fn pointer(app: &mut App, x: f64, y: f64, extend: bool) -> bool {
    let Some(area) = editor_rect(app) else {
        return false;
    };
    if !extend && !area.contains(x, y) {
        return false;
    }
    let Some(edit) = &mut app.editing else {
        return false;
    };
    if edit.buffer.composing {
        return true;
    }
    let size = if matches!(edit.target, EditTarget::Property { .. }) {
        13.
    } else {
        18.
    };
    if let Some(prepared) = prepare(&edit.buffer, area, size) {
        let offset = prepared.offset(x, y);
        if let Some(byte) = omc_text::utf16_to_byte(&edit.buffer.text, offset) {
            edit.buffer.caret = byte;
            if !extend {
                edit.buffer.anchor = byte;
            }
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn empty_editor_exposes_caret() {
        let b = EditBuffer::new(String::new(), false);
        let prepared = prepare(&b, Rect::new(10., 20., 200., 40.), 18.).unwrap();
        let caret = prepared.caret().unwrap();
        assert!(caret.height > 0.);
        assert_eq!(prepared.offset(10., 20.), 0);
    }
    #[test]
    fn context_window_retains_utf16_offsets() {
        let b = EditBuffer::new("한😀".repeat(2000), false);
        let prepared = prepare(&b, Rect::new(0., 0., 200., 40.), 18.).unwrap();
        let caret = prepared.caret().unwrap();
        assert!(caret.y + caret.height <= 40.01);
        assert_eq!(prepared.base_units + prepared.caret_units, b.utf16_caret());
    }
}
