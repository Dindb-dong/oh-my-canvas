use super::*;
use omc_model::NodeKind;
use omc_scene::{Scene, SceneItem, build_scene};
use std::collections::BTreeMap;

#[derive(Clone, Copy, PartialEq, Eq)]
enum Platform {
    Swift,
    Compose,
    Ark,
    Flutter,
}

pub fn inspect_platform(
    snapshot: &DocumentSnapshot,
    id: &str,
    language: &str,
    name: &str,
    parameters: &BTreeMap<String, String>,
) -> Result<String, ExportError> {
    let platform = match language {
        "swiftui" => Platform::Swift,
        "compose" => Platform::Compose,
        "arkui" => Platform::Ark,
        "flutter" => Platform::Flutter,
        _ => return Err(ExportError::Invalid("unknown native code language".into())),
    };
    let scene = build_scene(
        snapshot,
        &SceneOptions {
            page_id: Some(id.into()),
            ..SceneOptions::default()
        },
    )
    .map_err(|error| ExportError::Invalid(error.to_string()))?;
    let mut writer = Writer {
        platform,
        scene: &scene,
        parameters,
        fields: BTreeMap::new(),
    };
    let body = writer.node(scene.root, true)?;
    Ok(writer.wrap(name, &body))
}

struct Writer<'a> {
    platform: Platform,
    scene: &'a Scene,
    parameters: &'a BTreeMap<String, String>,
    fields: BTreeMap<String, (bool, String)>,
}

impl Writer<'_> {
    fn node(&mut self, index: usize, root: bool) -> Result<String, ExportError> {
        let item = &self.scene.items[index];
        let mut children = item.children.clone();
        let visible = self.binding(item, "visible", false);
        if item.hidden && visible.is_none() {
            return Ok(String::new());
        }
        let mut views = Vec::new();
        for index in children.drain(..) {
            let view = self.node(index, false)?;
            if !view.is_empty() {
                views.push(view);
            }
        }
        let width = number(item.width);
        let height = number(item.height);
        let x = number(if root { 0. } else { item.local.0[4] });
        let y = number(if root { 0. } else { item.local.0[5] });
        let bg = color(item.style.color("background-color"), self.platform);
        let fg = color(
            item.style
                .color("color")
                .or_else(|| omc_style::parse_color("black")),
            self.platform,
        );
        let size = number(
            item.style
                .get("font-size")
                .and_then(|value| value.trim_end_matches("px").parse().ok())
                .unwrap_or(16.),
        );
        let rounding = number(
            item.style
                .get("border-top-left-radius")
                .or_else(|| item.style.get("border-radius"))
                .and_then(|value| value.trim_end_matches("px").parse().ok())
                .unwrap_or(0.),
        );
        if item.kind == NodeKind::Text {
            let characters = self.binding(item, "characters", true).unwrap_or_else(|| {
                quote(
                    item.properties
                        .get("text")
                        .and_then(Value::as_str)
                        .unwrap_or_default(),
                    self.platform,
                )
            });
            let view = match self.platform {
                Platform::Swift => {
                    format!("Text({characters}).font(.system(size: {size})).foregroundStyle({fg})")
                }
                Platform::Compose => {
                    format!("Text(text = {characters}, fontSize = {size}.sp, color = {fg})")
                }
                Platform::Ark => format!("Text({characters}).fontSize({size}).fontColor({fg})"),
                Platform::Flutter => {
                    format!("Text({characters}, style: TextStyle(fontSize: {size}, color: {fg}))")
                }
            };
            views.insert(0, view);
        } else if item.kind == NodeKind::Image {
            let hash = item
                .properties
                .get("assetHash")
                .or_else(|| item.properties.get("imageHash"))
                .and_then(Value::as_str)
                .filter(|hash| {
                    hash.len() == 64 && hash.bytes().all(|byte| byte.is_ascii_hexdigit())
                })
                .ok_or_else(|| ExportError::Resource(format!("missing image {}", item.id)))?;
            let path = quote(&format!("assets/{hash}"), self.platform);
            views.insert(0, match self.platform {
                Platform::Swift => format!("Image({path}).resizable().frame(width: {width}, height: {height})"),
                Platform::Compose => format!("Image(bitmap = ImageBitmap.imageResource(R.drawable.image_{hash}), contentDescription = null, modifier = Modifier.requiredSize({width}.dp, {height}.dp))"),
                Platform::Ark => format!("Image({path}).width({width}).height({height})"),
                Platform::Flutter => format!("Image.asset({path}, width: {width}, height: {height})"),
            });
        }
        let rotation = number(item.local.0[1].atan2(item.local.0[0]).to_degrees());
        let opacity = number(item.style.number("opacity", 1.).clamp(0., 1.));
        let ellipse = item.kind == NodeKind::Ellipse;
        let swift_shape = if ellipse {
            "Ellipse()".to_owned()
        } else {
            format!("RoundedRectangle(cornerRadius: {rounding})")
        };
        let kotlin_shape = if ellipse {
            "CircleShape".to_owned()
        } else {
            format!("RoundedCornerShape({rounding}.dp)")
        };
        let clip = item.clip || ellipse;
        Ok(match self.platform {
            Platform::Swift => {
                let clipping = if clip {
                    format!(".clipShape({swift_shape})")
                } else {
                    String::new()
                };
                let mut view = format!(
                    "ZStack(alignment: .topLeading) {{\n{}\n}}\n.frame(width: {width}, height: {height}, alignment: .topLeading).background({swift_shape}.fill({bg})){clipping}.opacity({opacity}).rotationEffect(.degrees({rotation}), anchor: .topLeading).offset(x: {x}, y: {y})",
                    indent(&views.join("\n"))
                );
                if let Some(visible) = visible {
                    view = format!("if {visible} {{\n{}\n}}", indent(&view));
                }
                view
            }
            Platform::Compose => {
                let clipping = if clip {
                    format!(".clip({kotlin_shape})")
                } else {
                    String::new()
                };
                let mut view = format!(
                    "Box(modifier = Modifier.offset({x}.dp, {y}.dp).requiredSize({width}.dp, {height}.dp).graphicsLayer(alpha = {opacity}f, rotationZ = {rotation}f, transformOrigin = TransformOrigin(0f, 0f)){clipping}.background({bg}, {kotlin_shape})) {{\n{}\n}}",
                    indent(&views.join("\n"))
                );
                if let Some(visible) = visible {
                    view = format!("if ({visible}) {{\n{}\n}}", indent(&view));
                }
                view
            }
            Platform::Ark => {
                let clipping = if clip { ".clip(true)" } else { "" };
                let mut view = format!(
                    "Stack({{ alignContent: Alignment.TopStart }}) {{\n{}\n}}\n.width({width}).height({height}).position({{ x: {x}, y: {y} }}).backgroundColor({bg}).borderRadius({rounding}).opacity({opacity}).rotate({{ angle: {rotation}, centerX: 0, centerY: 0 }}){clipping}",
                    indent(&views.join("\n"))
                );
                if let Some(visible) = visible {
                    view = format!("if ({visible}) {{\n{}\n}}", indent(&view));
                }
                view
            }
            Platform::Flutter => {
                let shape = if ellipse {
                    "shape: BoxShape.circle".to_owned()
                } else {
                    format!("borderRadius: BorderRadius.circular({rounding})")
                };
                let clip = if clip { "Clip.antiAlias" } else { "Clip.none" };
                let visible = visible.map_or(String::new(), |value| format!("if ({value}) "));
                let body = format!(
                    "Transform.rotate(angle: {rotation} * 0.017453292519943295, alignment: Alignment.topLeft, child: Opacity(opacity: {opacity}, child: Container(width: {width}, height: {height}, clipBehavior: {clip}, decoration: BoxDecoration(color: {bg}, {shape}), child: Stack(clipBehavior: Clip.none, children: [\n{}\n]))))",
                    indent(&views.join(",\n"))
                );
                if root {
                    body
                } else {
                    format!("{visible}Positioned(left: {x}, top: {y}, child: {body})")
                }
            }
        })
    }

    fn binding(&mut self, item: &SceneItem, kind: &str, text: bool) -> Option<String> {
        let id = item
            .properties
            .get("componentPropertyRefs")?
            .get(kind)?
            .as_str()?;
        let name = self.parameters.get(id)?.as_str();
        let name = platform_property(name);
        let fallback = if text {
            quote(
                item.properties
                    .get("text")
                    .and_then(Value::as_str)
                    .unwrap_or_default(),
                self.platform,
            )
        } else {
            (!item.hidden).to_string()
        };
        self.fields.insert(name.clone(), (text, fallback));
        Some(if self.platform == Platform::Ark {
            format!("this.{name}")
        } else {
            name
        })
    }

    fn wrap(&self, name: &str, body: &str) -> String {
        let body = indent(&indent(body));
        let fields = |format: fn(&str, bool, &str) -> String, separator: &str| {
            self.fields
                .iter()
                .map(|(name, (text, value))| format(name, *text, value))
                .collect::<Vec<_>>()
                .join(separator)
        };
        match self.platform {
            Platform::Swift => {
                let fields = fields(
                    |n, t, v| format!("    var {n}: {} = {v}\n", if t { "String" } else { "Bool" }),
                    "",
                );
                format!(
                    "import SwiftUI\n\nstruct {name}: View {{\n{fields}    var body: some View {{\n{body}\n    }}\n}}"
                )
            }
            Platform::Compose => {
                let fields = fields(
                    |n, t, v| format!("{n}: {} = {v}", if t { "String" } else { "Boolean" }),
                    ", ",
                );
                format!(
                    "import androidx.compose.foundation.*\nimport androidx.compose.foundation.layout.*\nimport androidx.compose.foundation.shape.*\nimport androidx.compose.material3.Text\nimport androidx.compose.runtime.Composable\nimport androidx.compose.ui.Modifier\nimport androidx.compose.ui.draw.clip\nimport androidx.compose.ui.graphics.*\nimport androidx.compose.ui.res.imageResource\nimport androidx.compose.ui.unit.*\n\n@Composable\nfun {name}({fields}) {{\n{}\n}}",
                    indent(&body)
                )
            }
            Platform::Ark => {
                let fields = fields(
                    |n, t, v| {
                        format!(
                            "  @Prop {n}: {} = {v}\n",
                            if t { "string" } else { "boolean" }
                        )
                    },
                    "",
                );
                format!("@Component\nstruct {name} {{\n{fields}  build() {{\n{body}\n  }}\n}}")
            }
            Platform::Flutter => {
                let args = fields(|n, _, v| format!(", this.{n} = {v}"), "");
                let fields = fields(
                    |n, t, _| format!("  final {} {n};\n", if t { "String" } else { "bool" }),
                    "",
                );
                format!(
                    "import 'package:flutter/material.dart';\n\nclass {name} extends StatelessWidget {{\n  const {name}({{super.key{args}}});\n{fields}\n  @override\n  Widget build(BuildContext context) {{\n{}\n  }}\n}}",
                    indent(&format!("return {};", &body.trim_start()))
                )
            }
        }
    }
}

pub fn platform_property(name: &str) -> String {
    // Prefix generated parameters to avoid framework keywords.
    let identifier = name
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '_' {
                ch
            } else {
                '_'
            }
        })
        .collect::<String>();
    format!("property_{identifier}")
}

fn number(value: f64) -> String {
    format!("{:.4}", if value.abs() < 0.00005 { 0. } else { value })
        .trim_end_matches('0')
        .trim_end_matches('.')
        .to_owned()
}

fn color(value: Option<omc_style::Color>, platform: Platform) -> String {
    let value = value.unwrap_or(omc_style::Color::TRANSPARENT);
    let hex = value.hex();
    let argb = format!("{}{}", &hex[7..9], &hex[1..7]);
    match platform {
        Platform::Swift => format!(
            "Color(red: {}, green: {}, blue: {}, opacity: {})",
            number(value.r.into()),
            number(value.g.into()),
            number(value.b.into()),
            number(value.a.into())
        ),
        Platform::Compose | Platform::Flutter => format!("Color(0x{argb})"),
        Platform::Ark => format!("\"#{argb}\""),
    }
}

fn quote(value: &str, platform: Platform) -> String {
    let quoted = serde_json::to_string(value).expect("string is serializable");
    if matches!(platform, Platform::Compose | Platform::Flutter) {
        quoted.replace('$', "\\$")
    } else {
        quoted
    }
}

fn indent(value: &str) -> String {
    value
        .lines()
        .map(|line| format!("  {line}"))
        .collect::<Vec<_>>()
        .join("\n")
}
