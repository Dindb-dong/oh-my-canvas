//! A coherent native display list and its exact shared hit-test coordinate chain.
mod components;
pub use components::{ComponentProjection, resolve_components};
use omc_model::{DocumentSnapshot, NodeKind};
use omc_style::{ComputedStyle, Diagnostic, LengthContext, resolve_length};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Affine(pub [f64; 6]);
impl Affine {
    pub const IDENTITY: Self = Self([1., 0., 0., 1., 0., 0.]);
    pub fn translation(x: f64, y: f64) -> Self {
        Self([1., 0., 0., 1., x, y])
    }
    pub fn multiply(self, b: Self) -> Self {
        let a = self.0;
        let b = b.0;
        Self([
            a[0] * b[0] + a[2] * b[1],
            a[1] * b[0] + a[3] * b[1],
            a[0] * b[2] + a[2] * b[3],
            a[1] * b[2] + a[3] * b[3],
            a[0] * b[4] + a[2] * b[5] + a[4],
            a[1] * b[4] + a[3] * b[5] + a[5],
        ])
    }
    pub fn point(self, x: f64, y: f64) -> (f64, f64) {
        let a = self.0;
        (a[0] * x + a[2] * y + a[4], a[1] * x + a[3] * y + a[5])
    }
    pub fn inverse(self) -> Option<Self> {
        let a = self.0;
        let d = a[0] * a[3] - a[1] * a[2];
        if !d.is_finite() || d.abs() < 1e-12 {
            return None;
        }
        Some(Self([
            a[3] / d,
            -a[1] / d,
            -a[2] / d,
            a[0] / d,
            (a[2] * a[5] - a[3] * a[4]) / d,
            (a[1] * a[4] - a[0] * a[5]) / d,
        ]))
    }
    pub fn bounds(self, width: f64, height: f64) -> [f64; 4] {
        let p = [
            self.point(0., 0.),
            self.point(width, 0.),
            self.point(width, height),
            self.point(0., height),
        ];
        let minx = p.iter().map(|p| p.0).fold(f64::INFINITY, f64::min);
        let miny = p.iter().map(|p| p.1).fold(f64::INFINITY, f64::min);
        let maxx = p.iter().map(|p| p.0).fold(f64::NEG_INFINITY, f64::max);
        let maxy = p.iter().map(|p| p.1).fold(f64::NEG_INFINITY, f64::max);
        [minx, miny, maxx - minx, maxy - miny]
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SceneOptions {
    pub page_id: Option<String>,
    pub width: f64,
    pub height: f64,
    pub time_ms: f64,
    pub strict: bool,
}
impl Default for SceneOptions {
    fn default() -> Self {
        Self {
            page_id: None,
            width: 1440.,
            height: 900.,
            time_ms: 0.,
            strict: false,
        }
    }
}
#[derive(Debug, thiserror::Error)]
pub enum SceneError {
    #[error(transparent)]
    Layout(#[from] omc_layout::LayoutError),
    #[error("native text: {0}")]
    Text(String),
    #[error("unsupported scene feature: {0}")]
    Unsupported(String),
    #[error("invalid transform for {0}")]
    Transform(String),
}

pub struct SceneItem {
    pub id: String,
    pub kind: NodeKind,
    pub parent: Option<usize>,
    pub children: Vec<usize>,
    pub bounds: [f64; 4],
    pub width: f64,
    pub height: f64,
    pub local: Affine,
    pub world: Affine,
    pub style: ComputedStyle,
    pub properties: BTreeMap<String, Value>,
    pub clip: bool,
    pub hidden: bool,
    pub locked: bool,
    pub text: Option<omc_text::TextLayout>,
    pub text_offset: (f64, f64),
}
pub struct Scene {
    pub items: Vec<SceneItem>,
    pub root: usize,
    pub width: f64,
    pub height: f64,
    pub time_ms: f64,
    pub diagnostics: Vec<Diagnostic>,
    pub epoch: String,
    pub sequence: u64,
    pub strict: bool,
}
impl Scene {
    pub fn item(&self, id: &str) -> Option<&SceneItem> {
        self.items.iter().find(|item| item.id == id)
    }
    pub fn bounds(&self, id: &str) -> Option<[f64; 4]> {
        self.item(id).map(|item| item.bounds)
    }
    pub fn hit_test(&self, x: f64, y: f64) -> Option<&SceneItem> {
        if !x.is_finite() || !y.is_finite() {
            return None;
        }
        for item in self.items.iter().rev() {
            if item.hidden || item.locked || !item.contains(x, y) {
                continue;
            }
            let mut ancestor = item.parent;
            let mut eligible = true;
            while let Some(index) = ancestor {
                let parent = &self.items[index];
                if parent.hidden || parent.locked || (parent.clip && !parent.contains(x, y)) {
                    eligible = false;
                    break;
                }
                ancestor = parent.parent;
            }
            if eligible {
                return Some(item);
            }
        }
        None
    }
}
impl SceneItem {
    pub fn contains(&self, world_x: f64, world_y: f64) -> bool {
        let Some(inverse) = self.world.inverse() else {
            return false;
        };
        let (x, y) = inverse.point(world_x, world_y);
        match self.kind {
            NodeKind::Ellipse => {
                if self.width <= 0. || self.height <= 0. {
                    return false;
                }
                let dx = (x - self.width / 2.) / (self.width / 2.);
                let dy = (y - self.height / 2.) / (self.height / 2.);
                dx * dx + dy * dy <= 1.
            }
            NodeKind::Line => {
                let length = self.width.hypot(self.height);
                if length == 0. {
                    return x.hypot(y) < 4.;
                }
                let projection = (x * self.width + y * self.height) / (length * length);
                let t = projection.clamp(0., 1.);
                (x - t * self.width).hypot(y - t * self.height)
                    <= self.style.number("border-width", 1.).max(8.) / 2.
            }
            NodeKind::Path => self
                .properties
                .get("path")
                .and_then(Value::as_str)
                .and_then(skia_safe::Path::from_svg)
                .is_some_and(|p| p.contains((x as f32, y as f32))),
            _ => {
                if x < 0. || y < 0. || x > self.width || y > self.height {
                    return false;
                }
                let radius = self
                    .style
                    .get("border-radius")
                    .and_then(|v| {
                        resolve_length(
                            v,
                            LengthContext {
                                percent_basis: self.width.min(self.height),
                                ..Default::default()
                            },
                        )
                    })
                    .unwrap_or(0.)
                    .max(0.)
                    .min(self.width.min(self.height) / 2.);
                if radius > 0. {
                    let cx = x.clamp(radius, self.width - radius);
                    let cy = y.clamp(radius, self.height - radius);
                    (x - cx).hypot(y - cy) <= radius
                } else {
                    true
                }
            }
        }
    }
}

pub fn build_scene(
    snapshot: &DocumentSnapshot,
    options: &SceneOptions,
) -> Result<Scene, SceneError> {
    if !options.time_ms.is_finite() {
        return Err(SceneError::Transform("nonfinite time sample".into()));
    }
    let projection = resolve_components(snapshot, options.page_id.as_deref());
    let snapshot = projection.snapshot.as_ref();
    let references = omc_style::ReferenceContext::new(snapshot);
    let mut layout = omc_layout::layout(
        snapshot,
        options.page_id.as_deref(),
        (options.width, options.height),
    )?;
    let mut items: Vec<SceneItem> = Vec::with_capacity(layout.order.len());
    let mut indices = BTreeMap::new();
    let mut diagnostics = layout.diagnostics;
    diagnostics.extend(projection.diagnostics.clone());
    for id in &layout.order {
        let mut node = snapshot.nodes[id].clone();
        node.properties = references.properties(&node).0;
        let b = layout.boxes[id];
        let style = layout.styles.remove(id).unwrap_or_default();
        let parent = node
            .parent_id
            .as_ref()
            .and_then(|p| indices.get(p))
            .copied();
        let base = Affine::translation(b.x, b.y);
        let authored = authored_transform(&node.properties, b.width, b.height, &style)?;
        let local = base.multiply(authored);
        let world = parent
            .map(|i: usize| items[i].world)
            .unwrap_or(Affine::IDENTITY)
            .multiply(local);
        if world.0.iter().any(|x| !x.is_finite()) {
            return Err(SceneError::Transform(id.clone()));
        }
        if world.inverse().is_none() {
            diagnostics.push(Diagnostic {
                code: "noninvertible_transform".into(),
                severity: "warning".into(),
                node_id: Some(id.clone()),
                property: Some("transform".into()),
                original: format!("{:?}", world.0),
                action: "Content cannot be point-selected until its transform is invertible".into(),
                fidelity_lost: false,
            });
        }
        let hidden = node.properties.get("visible") == Some(&Value::Bool(false))
            || style.get("display") == Some("none")
            || style.get("visibility") == Some("hidden");
        let locked = node.properties.get("locked") == Some(&Value::Bool(true));
        let clip = matches!(style.get("overflow"), Some("hidden" | "clip"))
            || node.properties.get("clipContent") == Some(&Value::Bool(true));
        let text = if node.kind == NodeKind::Text {
            let mut text = omc_text::shape_runs(
                node.properties
                    .get("text")
                    .and_then(Value::as_str)
                    .unwrap_or(""),
                node.properties.get("textRuns"),
                &style,
                b.content_width,
            )
            .map_err(|e| SceneError::Text(e.to_string()))?;
            for d in &mut text.diagnostics {
                d.node_id = Some(id.clone());
            }
            diagnostics.extend(text.diagnostics.iter().cloned());
            Some(text)
        } else {
            None
        };
        if node.kind == NodeKind::Instance && node.properties.contains_key("componentId") {
            diagnostics.push(Diagnostic::unsupported(
                Some(id),
                Some("componentId"),
                "Unresolved component instance",
            ));
        }
        let index = items.len();
        if let Some(parent) = parent {
            items[parent].children.push(index);
        }
        indices.insert(id.clone(), index);
        let bounds = if node.kind == NodeKind::Path {
            node.properties
                .get("path")
                .and_then(Value::as_str)
                .and_then(skia_safe::Path::from_svg)
                .map(|path| {
                    let r = path.compute_tight_bounds();
                    world
                        .multiply(Affine::translation(r.left as f64, r.top as f64))
                        .bounds(r.width() as f64, r.height() as f64)
                })
                .unwrap_or_else(|| world.bounds(b.width, b.height))
        } else {
            world.bounds(b.width, b.height)
        };
        items.push(SceneItem {
            id: id.clone(),
            kind: node.kind,
            parent,
            children: Vec::new(),
            bounds,
            width: b.width,
            height: b.height,
            local,
            world,
            style,
            properties: node.properties.clone(),
            clip,
            hidden,
            locked,
            text,
            text_offset: (b.content_x, b.content_y),
        });
    }
    if options.strict && diagnostics.iter().any(|d| d.fidelity_lost) {
        return Err(SceneError::Unsupported(
            diagnostics
                .iter()
                .filter(|d| d.fidelity_lost)
                .map(|d| format!("{}:{}", d.code, d.node_id.as_deref().unwrap_or("document")))
                .collect::<Vec<_>>()
                .join(", "),
        ));
    }
    Ok(Scene {
        root: 0,
        width: options.width,
        height: options.height,
        time_ms: options.time_ms,
        items,
        diagnostics,
        epoch: snapshot.epoch.clone(),
        sequence: snapshot.sequence,
        strict: options.strict,
    })
}

fn authored_transform(
    properties: &BTreeMap<String, Value>,
    width: f64,
    height: f64,
    style: &ComputedStyle,
) -> Result<Affine, SceneError> {
    if let Some(array) = properties.get("transform").and_then(Value::as_array) {
        if array.len() != 6 {
            return Err(SceneError::Transform("matrix needs six values".into()));
        }
        let mut values = [0.; 6];
        for (i, v) in array.iter().enumerate() {
            values[i] = v
                .as_f64()
                .filter(|v| v.is_finite())
                .ok_or_else(|| SceneError::Transform("matrix needs finite numbers".into()))?;
        }
        return Ok(Affine(values));
    }
    let mut result = Affine::IDENTITY;
    let angle = properties
        .get("rotation")
        .and_then(Value::as_f64)
        .unwrap_or(0.)
        .to_radians();
    let sx = if properties.get("flipX") == Some(&Value::Bool(true)) {
        -1.
    } else {
        1.
    };
    let sy = if properties.get("flipY") == Some(&Value::Bool(true)) {
        -1.
    } else {
        1.
    };
    if angle != 0. || sx != 1. || sy != 1. {
        result = Affine::translation(width / 2., height / 2.)
            .multiply(Affine([
                angle.cos() * sx,
                angle.sin() * sx,
                -angle.sin() * sy,
                angle.cos() * sy,
                0.,
                0.,
            ]))
            .multiply(Affine::translation(-width / 2., -height / 2.));
    }
    if let Some(value) = style.get("transform") {
        if value != "none" {
            result = result.multiply(parse_transform(value, width, height)?);
        }
    }
    Ok(result)
}
fn parse_transform(value: &str, width: f64, height: f64) -> Result<Affine, SceneError> {
    let mut remaining = value.trim();
    let mut matrix = Affine::IDENTITY;
    while !remaining.is_empty() {
        let (open, close) = (
            remaining
                .find('(')
                .ok_or_else(|| SceneError::Transform(value.into()))?,
            remaining
                .find(')')
                .ok_or_else(|| SceneError::Transform(value.into()))?,
        );
        let name = remaining[..open].trim();
        let parts: Vec<_> = remaining[open + 1..close]
            .split([',', ' '])
            .filter(|s| !s.is_empty())
            .collect();
        let number = |i: usize, default: f64| -> Result<f64, SceneError> {
            match parts.get(i) {
                Some(s) => s.parse().map_err(|_| SceneError::Transform(value.into())),
                None => Ok(default),
            }
        };
        let length = |i: usize, basis: f64| -> Result<f64, SceneError> {
            parts
                .get(i)
                .and_then(|s| {
                    resolve_length(
                        s,
                        LengthContext {
                            percent_basis: basis,
                            ..Default::default()
                        },
                    )
                })
                .ok_or_else(|| SceneError::Transform(value.into()))
        };
        let next = match name {
            "matrix" if parts.len() == 6 => Affine([
                number(0, 1.)?,
                number(1, 0.)?,
                number(2, 0.)?,
                number(3, 1.)?,
                number(4, 0.)?,
                number(5, 0.)?,
            ]),
            "translate" => Affine::translation(
                length(0, width)?,
                if parts.len() > 1 {
                    length(1, height)?
                } else {
                    0.
                },
            ),
            "translateX" => Affine::translation(length(0, width)?, 0.),
            "translateY" => Affine::translation(0., length(0, height)?),
            "scale" => {
                let x = number(0, 1.)?;
                Affine([x, 0., 0., number(1, x)?, 0., 0.])
            }
            "rotate" => {
                let value = parts
                    .first()
                    .ok_or_else(|| SceneError::Transform(value.into()))?;
                let angle = if let Some(v) = value.strip_suffix("deg") {
                    v.parse::<f64>()
                        .map_err(|_| SceneError::Transform(value.to_string()))?
                        .to_radians()
                } else if let Some(v) = value.strip_suffix("rad") {
                    v.parse::<f64>()
                        .map_err(|_| SceneError::Transform(value.to_string()))?
                } else {
                    return Err(SceneError::Transform(value.to_string()));
                };
                Affine::translation(width / 2., height / 2.)
                    .multiply(Affine([
                        angle.cos(),
                        angle.sin(),
                        -angle.sin(),
                        angle.cos(),
                        0.,
                        0.,
                    ]))
                    .multiply(Affine::translation(-width / 2., -height / 2.))
            }
            _ => return Err(SceneError::Unsupported(format!("transform: {value}"))),
        };
        matrix = matrix.multiply(next);
        remaining = remaining[close + 1..].trim();
    }
    Ok(matrix)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn transform_and_inverse_share_convention() {
        let a = Affine::translation(100., 50.).multiply(Affine([0., 1., -1., 0., 0., 0.]));
        let p = a.point(10., 20.);
        assert_eq!(p, (80., 60.));
        let q = a.inverse().unwrap().point(p.0, p.1);
        assert_eq!(q, (10., 20.));
        assert_eq!(a.bounds(30., 20.), [80., 50., 20., 30.]);
        assert!(Affine([0., 0., 0., 0., 1., 2.]).inverse().is_none());
    }
}
