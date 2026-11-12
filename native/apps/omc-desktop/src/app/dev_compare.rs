use super::*;
use base64::Engine;
use skia_safe::{Data, Image};

pub(crate) struct DevComparison {
    pub result: Value,
    pub rows: Vec<String>,
    pub scroll: usize,
    pub images: [Option<Image>; 2],
}

impl App {
    pub(crate) fn dev_comparison(&self) -> Option<&DevComparison> {
        self.dev_comparison.as_ref()
    }

    pub(crate) fn dev_compare_rect(&self) -> Rect {
        let viewport = self.canvas_rect();
        let width = (viewport.width - 24.).clamp(120., 480.);
        let height = (viewport.height - 76.).clamp(144., 470.);
        Rect::new(
            viewport.x + ((viewport.width - width) * 0.5).max(0.),
            viewport.y + 18.,
            width,
            height,
        )
    }

    pub(crate) fn dev_compare_image_height(&self) -> f64 {
        self.dev_comparison
            .as_ref()
            .filter(|panel| panel.images.iter().any(Option::is_some))
            .map_or(0., |_| {
                (self.dev_compare_rect().height - 115.).clamp(0., 128.)
            })
    }

    pub(crate) fn dev_compare_close_rect(&self) -> Rect {
        let area = self.dev_compare_rect();
        Rect::new(area.x + area.width - 39., area.y + 9., 28., 28.)
    }

    pub(super) fn open_dev_comparison(&mut self, args: &Value) -> Result<Value, String> {
        if self.version_preview_active() || self.prototype_frame.is_some() || self.editing.is_some()
        {
            return Err("Close the active preview or edit before opening the comparison.".into());
        }
        let result = args["comparison"].clone();
        let changes = result["changes"]
            .as_array()
            .ok_or("Expected comparison results.")?;
        let mut rows = Vec::new();
        for change in changes {
            let prefix = match change["change"].as_str() {
                Some("added") => "+",
                Some("removed") => "−",
                _ => "•",
            };
            let indent = change["depth"].as_u64().unwrap_or(0).min(4) as usize;
            let name = change["name"]
                .as_str()
                .filter(|name| !name.is_empty())
                .or_else(|| change["type"].as_str())
                .unwrap_or("Layer");
            rows.push(format!("{}{prefix} {name}", "  ".repeat(indent)));
            for property in change["properties"].as_array().into_iter().flatten() {
                rows.push(format!(
                    "{}{}  {} → {}",
                    "  ".repeat(indent + 1),
                    property["property"].as_str().unwrap_or("Property"),
                    describe(&property["before"]),
                    describe(&property["after"])
                ));
            }
        }
        if rows.is_empty() {
            rows.push(if result["snapshot"] == true {
                "No property or layer changes.".into()
            } else {
                "No comparison snapshot for this layer.".into()
            });
        }
        if result["truncated"] == true {
            rows.push("Additional changes exceed the comparison limit.".into());
        }
        let images = ["before", "after"].map(|key| {
            let encoded = args["images"][key].as_str()?;
            let data = base64::engine::general_purpose::STANDARD
                .decode(encoded)
                .ok()?;
            Image::from_encoded(Data::new_copy(&data))
        });
        self.popup = None;
        self.dev_comparison = Some(DevComparison {
            result,
            rows,
            scroll: 0,
            images,
        });
        Ok(json!({"shown":true}))
    }

    pub(super) fn close_dev_comparison(&mut self) {
        self.dev_comparison = None;
    }

    pub(super) fn scroll_dev_comparison(&mut self, dy: f64) -> bool {
        if !self
            .dev_compare_rect()
            .contains(self.cursor.0, self.cursor.1)
            || !dy.is_finite()
        {
            return false;
        }
        let visible = ((self.dev_compare_rect().height - self.dev_compare_image_height() - 80.)
            / 22.)
            .floor()
            .max(1.) as usize;
        let Some(comparison) = &mut self.dev_comparison else {
            return false;
        };
        let steps = (dy.abs() / 22.).ceil().clamp(1., 10.) as usize;
        comparison.scroll = if dy > 0. {
            comparison.scroll.saturating_sub(steps)
        } else if dy < 0. {
            (comparison.scroll + steps).min(comparison.rows.len().saturating_sub(visible))
        } else {
            comparison.scroll
        };
        true
    }
}

fn describe(value: &Value) -> String {
    if value.is_null() {
        return "—".into();
    }
    let serialized = value.to_string();
    let string = value.as_str().unwrap_or(&serialized);
    let mut chars = string
        .chars()
        .map(|ch| if ch.is_control() { ' ' } else { ch });
    let mut display = chars.by_ref().take(40).collect::<String>();
    if chars.next().is_some() {
        display.push('…');
    }
    display
}
