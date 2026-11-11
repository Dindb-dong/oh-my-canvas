use base64::Engine;
use omc_export::{ExportOptions, export, export_html, export_native, export_react};
use omc_model::{DocumentContent, DocumentSnapshot, Node, NodeKind};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

fn snapshot() -> DocumentSnapshot {
    let content = DocumentContent::empty("Semantic export");
    DocumentSnapshot {
        id: omc_model::new_id("doc"),
        title: content.title,
        epoch: "epoch".into(),
        sequence: 3,
        pages: content.pages,
        nodes: content.nodes,
        metadata: content.metadata,
    }
}
fn hash(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

#[test]
fn code_preserves_token_style_links_and_rich_run_appearance() {
    let mut snapshot = snapshot();
    snapshot.metadata.extend([
        ("tokens/brand/name".into(), json!("brand")),
        ("tokens/brand/value".into(), json!("#ff0000")),
        ("styles/accent/type".into(), json!("fill")),
        (
            "styles/accent/value".into(),
            json!([{"color":{"$token":"brand"}}]),
        ),
    ]);
    let mut node = Node::new(NodeKind::Text);
    node.parent_id = Some(snapshot.pages[0].root_node_id.clone());
    node.properties.extend([
        ("text".into(), json!("AB")),
        ("fillStyleId".into(), json!("accent")),
        (
            "textRuns".into(),
            json!([
                {"text":"A", "attributes":{"fontSize":28,"underline":true,"strikethrough":true}},
                {"text":"B", "attributes":{"fontSize":14,"fill":"#0000ff"}}
            ]),
        ),
    ]);
    snapshot.nodes.insert(node.id.clone(), node);
    let (html, diagnostics) = export_html(&snapshot, None).unwrap();
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    assert!(html.contains("--brand:#ff0000"));
    assert!(html.contains("--omc-style-accent-fill:var(--brand)"));
    assert!(html.contains("color:var(--omc-style-accent-fill)"));
    assert!(
        !html.contains("border-color"),
        "a fill reference must not create a stroke"
    );
    assert!(html.contains("font-size:28px"));
    assert!(html.contains("text-decoration:underline line-through"));
    assert!(html.contains("font-size:14px"));
    let (jsx, _) = export_react(&snapshot, None, false).unwrap();
    assert!(jsx.contains("\"fontSize\":\"28px\""));
    assert!(jsx.contains("{\"A\"}"));
}

#[test]
fn code_exports_linear_box_fills_with_authored_stop_positions() {
    let mut snapshot = snapshot();
    snapshot.metadata.extend([
        ("styles/accent/type".into(), json!("fill")),
        (
            "styles/accent/value".into(),
            json!([{
                "type": "linear",
                "gradient": {
                    "start": {"x": 0.75, "y": 0.5},
                    "end": {"x": 0.25, "y": 0.5},
                    "stops": [
                        {"offset": 0, "color": "rgba(255,0,0,1)"},
                        {"position": 0.5, "color": "blue"},
                        {"offset": 1, "color": "#fff"}
                    ]
                }
            }]),
        ),
    ]);
    let mut node = Node::new(NodeKind::Rect);
    node.parent_id = Some(snapshot.pages[0].root_node_id.clone());
    node.properties.extend([
        ("fillStyleId".into(), json!("accent")),
        ("htmlId".into(), json!("swatch")),
        ("width".into(), json!(32)),
        ("height".into(), json!(8)),
    ]);
    let swatch = node.id.clone();
    snapshot.nodes.insert(node.id.clone(), node);

    let expected = "linear-gradient(to left, #ff0000ff 25%, #0000ffff 50%, #ffffffff 75%)";
    let (html, diagnostics) = export_html(&snapshot, None).unwrap();
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    assert!(html.contains(&format!(
        "background-image:{expected};background-origin:border-box"
    )));
    let (jsx, diagnostics) = export_react(&snapshot, None, false).unwrap();
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    assert!(jsx.contains(&format!("\"backgroundImage\":\"{expected}\"")));
    let (tailwind, diagnostics) = export_react(&snapshot, None, true).unwrap();
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    assert!(tailwind.contains(&format!(
        "[background-image:{}]",
        expected.replace(' ', "_")
    )));

    let imported = omc_import::import_bytes("html", html.as_bytes(), &Default::default()).unwrap();
    let imported_swatch = &imported.source_map["html:#swatch"];
    let imported_snapshot = DocumentSnapshot {
        pages: imported.content.pages,
        nodes: imported.content.nodes,
        metadata: imported.content.metadata,
        ..snapshot.clone()
    };
    let sample = |snapshot: &DocumentSnapshot, id: &str| {
        let scene = omc_scene::build_scene(
            snapshot,
            &omc_scene::SceneOptions {
                width: 64.,
                height: 32.,
                strict: true,
                ..Default::default()
            },
        )
        .unwrap();
        let image =
            omc_render::render_rgba(&scene, &Default::default(), &omc_render::EmptyResources)
                .unwrap();
        let [x, y, _, _] = scene.bounds(id).unwrap();
        [2, 9, 16, 23, 30].map(|offset| {
            let at = ((y as usize + 2) * image.width as usize + x as usize + offset) * 4;
            <[u8; 4]>::try_from(&image.pixels[at..at + 4]).unwrap()
        })
    };
    let native_pixels = sample(&snapshot, &swatch);
    let imported_pixels = sample(&imported_snapshot, imported_swatch);
    assert_eq!(imported_pixels, native_pixels);
    assert_eq!(imported_pixels[0], [255, 255, 255, 255]);
    assert_eq!(imported_pixels[4], [255, 0, 0, 255]);
}

#[test]
fn unsupported_linear_fills_keep_loss_diagnostics_and_exclude_invalid_css() {
    for (end, color) in [
        (json!({"x": 1, "y": 1}), "red"),
        (json!({"x": 1, "y": 0.5}), "rgba(255,0,0,0.5)"),
        (
            json!({"x": 1, "y": 0.5}),
            "red);background-image:url(https://example.test/unsafe)",
        ),
    ] {
        let mut snapshot = snapshot();
        let mut node = Node::new(NodeKind::Rect);
        node.parent_id = Some(snapshot.pages[0].root_node_id.clone());
        node.properties.insert(
            "fills".into(),
            json!([{
                "type": "linear",
                "gradient": {"end": end, "stops": [
                    {"offset": 0, "color": color}, {"offset": 1, "color": "#fff"}
                ]}
            }]),
        );
        let id = node.id.clone();
        snapshot.nodes.insert(id.clone(), node);
        let (html, diagnostics) = export_html(&snapshot, None).unwrap();
        assert!(diagnostics.iter().any(|d| d.node_id.as_deref() == Some(&id)
            && d.property.as_deref() == Some("fills")
            && d.fidelity_lost));
        assert!(!html.contains("background-image:"));
        assert!(!html.contains("example.test"));
    }
}

#[test]
fn single_source_artifact_embeds_verified_images() {
    let mut snapshot = snapshot();
    let bytes = base64::engine::general_purpose::STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==").unwrap();
    let hash = hash(&bytes);
    let mut image = Node::new(NodeKind::Image);
    image.parent_id = Some(snapshot.pages[0].root_node_id.clone());
    image.properties.insert("assetHash".into(), json!(hash));
    snapshot.nodes.insert(image.id.clone(), image);
    let resources = BTreeMap::from([(hash, bytes)]);
    let artifact = export(
        &snapshot,
        &ExportOptions {
            format: "html".into(),
            ..Default::default()
        },
        &resources,
    )
    .unwrap();
    let html = String::from_utf8(artifact.bytes).unwrap();
    assert!(html.contains("src=\"data:image/png;base64,"));
    assert!(!html.contains("src=\"assets/"));
    assert!(artifact.diagnostics.is_empty());
    assert!(
        export(
            &snapshot,
            &ExportOptions {
                format: "html".into(),
                ..Default::default()
            },
            &omc_render::EmptyResources
        )
        .is_err()
    );
}

#[test]
fn portable_font_resources_roundtrip_and_content_tampering_is_rejected() {
    let mut snapshot = snapshot();
    let bytes = include_bytes!("../../../../fixtures/fonts/fonts/a57a52adcb86d6ba.woff").to_vec();
    let hash = hash(&bytes);
    snapshot.metadata.insert(
        "assets/font/faces".into(),
        json!([{ "hash": hash, "family":"Portable test", "weight":400, "style":"normal" }]),
    );
    let resources = BTreeMap::from([(hash.clone(), bytes.clone())]);
    let package = export_native(&snapshot, &resources).unwrap();
    let imported = omc_import::import_bytes("omc", &package, &Default::default()).unwrap();
    assert_eq!(imported.resources.len(), 1);
    assert_eq!(imported.resources[0].hash, hash);
    assert_eq!(imported.resources[0].bytes, bytes);
    assert_eq!(imported.resources[0].media_type, "font/woff");
    let mut tampered: serde_json::Value = serde_json::from_slice(&package).unwrap();
    tampered["content"]["title"] = json!("Tampered");
    let error = omc_import::import_bytes(
        "omc",
        &serde_json::to_vec(&tampered).unwrap(),
        &Default::default(),
    )
    .unwrap_err();
    assert!(error.to_string().contains("checksum"), "{error}");
}
