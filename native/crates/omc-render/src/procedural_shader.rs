use super::*;

pub const PROCEDURAL_SHADER_PROPERTY: &str = "proceduralShader";

#[derive(Debug, Deserialize, Serialize)]
#[serde(
    deny_unknown_fields,
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ProceduralShader {
    Stripes {
        colors: [String; 2],
        period_px: f64,
        #[serde(default)]
        angle_deg: f64,
        #[serde(default)]
        phase_px: f64,
        #[serde(default)]
        speed_px_per_second: f64,
    },
}

impl ProceduralShader {
    pub fn parse(value: &Value) -> Result<Self, String> {
        let shader: Self =
            serde_json::from_value(value.clone()).map_err(|error| error.to_string())?;
        let Self::Stripes {
            colors,
            period_px,
            angle_deg,
            phase_px,
            speed_px_per_second,
        } = &shader;
        if !(2. ..=4096.).contains(period_px)
            || !(-360. ..=360.).contains(angle_deg)
            || !(-4096. ..=4096.).contains(phase_px)
            || !(-2048. ..=2048.).contains(speed_px_per_second)
            || !colors
                .iter()
                .all(|color| color.len() <= 64 && parse_color(color).is_some())
        {
            return Err("invalid stripe colors, period, angle, phase or speed".into());
        }
        Ok(shader)
    }

    pub fn supports(kind: NodeKind) -> bool {
        matches!(
            kind,
            NodeKind::Frame
                | NodeKind::Rect
                | NodeKind::Ellipse
                | NodeKind::Path
                | NodeKind::Component
                | NodeKind::Instance
        )
    }

    pub(super) fn shader(&self, time_ms: f64) -> Option<Shader> {
        let Self::Stripes {
            colors,
            period_px,
            angle_deg,
            phase_px,
            speed_px_per_second,
        } = self;
        let a = to_sk_color(parse_color(&colors[0])?);
        let b = to_sk_color(parse_color(&colors[1])?);
        let phase = (phase_px + speed_px_per_second * time_ms / 1000.).rem_euclid(*period_px);
        let (sin, cos) = angle_deg.to_radians().sin_cos();
        let location = |distance: f64| ((distance * cos) as f32, (distance * sin) as f32);
        Shader::linear_gradient(
            (location(phase), location(phase + period_px)),
            [a, a, b, b].as_slice(),
            [0., 0.5, 0.5, 1.].as_slice(),
            TileMode::Repeat,
            None,
            None,
        )
    }
}
