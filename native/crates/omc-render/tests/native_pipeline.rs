use omc_model::{DocumentContent, DocumentSnapshot, Node, NodeKind};
use omc_render::{EmptyResources, RenderOptions, render_rgba};
use omc_scene::{SceneOptions, build_scene};
use serde_json::json;

fn document() -> (DocumentSnapshot, String) {
    let c = DocumentContent::empty("pixels");
    let root = c.pages[0].root_node_id.clone();
    (
        DocumentSnapshot {
            id: "d".into(),
            title: c.title,
            epoch: "e".into(),
            sequence: 0,
            pages: c.pages,
            nodes: c.nodes,
            metadata: c.metadata,
        },
        root,
    )
}
fn pixels(snapshot: &DocumentSnapshot) -> Vec<u8> {
    let scene = build_scene(
        snapshot,
        &SceneOptions {
            width: 128.,
            height: 96.,
            strict: true,
            ..Default::default()
        },
    )
    .unwrap();
    render_rgba(&scene, &RenderOptions::default(), &EmptyResources)
        .unwrap()
        .pixels
}
fn at(image: &[u8], x: usize, y: usize) -> &[u8] {
    &image[(y * 128 + x) * 4..(y * 128 + x) * 4 + 4]
}

#[test]
fn linked_style_updates_pixels_and_local_override_is_independent() {
    let (mut s, root) = document();
    s.metadata
        .insert("tokens/accent/name".into(), json!("accent"));
    s.metadata
        .insert("tokens/accent/value".into(), json!("red"));
    s.metadata.insert(
        "styles/brand/value".into(),
        json!([{"color":{"$token":"accent"}}]),
    );
    let mut n = Node::new(NodeKind::Rect);
    n.parent_id = Some(root);
    n.properties.extend([
        ("x".into(), json!(10)),
        ("y".into(), json!(10)),
        ("width".into(), json!(40)),
        ("height".into(), json!(40)),
        ("fillStyleId".into(), json!("brand")),
    ]);
    let id = n.id.clone();
    s.nodes.insert(id.clone(), n);
    assert_eq!(at(&pixels(&s), 20, 20), [255, 0, 0, 255]);
    s.metadata
        .insert("tokens/accent/value".into(), json!("blue"));
    assert_eq!(at(&pixels(&s), 20, 20), [0, 0, 255, 255]);
    s.nodes
        .get_mut(&id)
        .unwrap()
        .properties
        .insert("fill".into(), json!("lime"));
    assert_eq!(at(&pixels(&s), 20, 20), [0, 255, 0, 255]);
}

#[test]
fn alpha_mask_paints_complete_child_group() {
    let (mut s, root) = document();
    let mut group = Node::new(NodeKind::Group);
    group.parent_id = Some(root);
    group.properties.extend([
        ("x".into(), json!(0)),
        ("y".into(), json!(0)),
        ("width".into(), json!(60)),
        ("height".into(), json!(60)),
        ("maskMode".into(), json!("alpha")),
    ]);
    let mut mask = Node::new(NodeKind::Ellipse);
    mask.parent_id = Some(group.id.clone());
    mask.rank = "00000000000000000000000000000001".into();
    mask.properties.extend([
        ("x".into(), json!(10)),
        ("y".into(), json!(10)),
        ("width".into(), json!(40)),
        ("height".into(), json!(40)),
        ("fill".into(), json!("white")),
        ("opacity".into(), json!(0.5)),
    ]);
    let mut content = Node::new(NodeKind::Rect);
    content.parent_id = Some(group.id.clone());
    content.rank = "00000000000000000000000000000002".into();
    content.properties.extend([
        ("x".into(), json!(0)),
        ("y".into(), json!(0)),
        ("width".into(), json!(60)),
        ("height".into(), json!(60)),
        ("fill".into(), json!("blue")),
    ]);
    let group_id = group.id.clone();
    let mask_id = mask.id.clone();
    for node in [group, mask, content] {
        s.nodes.insert(node.id.clone(), node);
    }
    let image = pixels(&s);
    assert_eq!(at(&image, 0, 0)[3], 0);
    assert_eq!(&at(&image, 30, 30)[..3], &[0, 0, 255]);
    assert!((at(&image, 30, 30)[3] as i32 - 128).abs() <= 1);

    s.nodes
        .get_mut(&group_id)
        .unwrap()
        .properties
        .insert("maskId".into(), json!(mask_id));
    s.nodes.get_mut(&mask_id).unwrap().rank = "00000000000000000000000000000003".into();
    let explicit = pixels(&s);
    assert_eq!(at(&explicit, 0, 0), at(&image, 0, 0));
    assert_eq!(at(&explicit, 30, 30), at(&image, 30, 30));

    // A stale or foreign reference must not turn another child into the mask.
    s.nodes
        .get_mut(&group_id)
        .unwrap()
        .properties
        .insert("maskId".into(), json!("missing"));
    for strict in [false, true] {
        let scene = build_scene(
            &s,
            &SceneOptions {
                width: 128.,
                height: 96.,
                strict,
                ..Default::default()
            },
        )
        .unwrap();
        let result = render_rgba(&scene, &RenderOptions::default(), &EmptyResources);
        if strict {
            assert!(matches!(result, Err(error) if error.to_string().contains("maskId")));
        } else {
            let preview = result.unwrap();
            assert_eq!(at(&preview.pixels, 30, 30)[3], 0);
            assert!(
                preview
                    .diagnostics
                    .iter()
                    .any(|d| d.property.as_deref() == Some("maskId"))
            );
        }
    }
}

#[test]
fn rich_run_marks_change_real_glyph_colors_and_metrics() {
    let (mut s, root) = document();
    let mut n = Node::new(NodeKind::Text);
    n.parent_id = Some(root);
    n.properties.extend([("x".into(),json!(4)),("y".into(),json!(4)),("width".into(),json!(124)),("fontSize".into(),json!(24)),("text".into(),json!("MM")),("textRuns".into(),json!([{"text":"M","attributes":{"color":"red","fontSize":48}},{"text":"M","attributes":{"color":"blue","underline":true}}]))]);
    let id = n.id.clone();
    s.nodes.insert(id.clone(), n);
    let scene = build_scene(
        &s,
        &SceneOptions {
            width: 128.,
            height: 96.,
            strict: true,
            ..Default::default()
        },
    )
    .unwrap();
    let text = scene.item(&id).unwrap().text.as_ref().unwrap();
    assert!(text.height > 40.);
    let image = render_rgba(&scene, &RenderOptions::default(), &EmptyResources).unwrap();
    assert!(
        image
            .pixels
            .chunks_exact(4)
            .any(|p| p[0] > 200 && p[1] < 20 && p[2] < 20 && p[3] > 200)
    );
    assert!(
        image
            .pixels
            .chunks_exact(4)
            .any(|p| p[2] > 200 && p[1] < 20 && p[0] < 20 && p[3] > 200)
    );
}

#[test]
fn solid_text_paint_uses_its_own_alpha_and_vertical_alignment() {
    let (mut snapshot, root) = document();
    let mut text = Node::new(NodeKind::Text);
    text.parent_id = Some(root);
    text.properties.extend([
        ("text".into(), json!("Test")),
        ("fontSize".into(), json!(18)),
        ("width".into(), json!(80)),
        ("height".into(), json!(80)),
        (
            "fills".into(),
            json!([{"type":"solid","color":"#312E81","opacity":0.5}]),
        ),
        ("textVerticalAlign".into(), json!("bottom")),
    ]);
    let id = text.id.clone();
    snapshot.nodes.insert(id.clone(), text);
    let rgba = pixels(&snapshot);
    let drawn: Vec<_> = rgba
        .chunks_exact(4)
        .enumerate()
        .filter(|(_, p)| p[3] > 0)
        .collect();
    assert!(!drawn.is_empty());
    assert!(drawn.iter().all(|(index, _)| index / 128 > 45));
    assert!(drawn.iter().all(|(_, pixel)| pixel[3] <= 128));
    snapshot.nodes.get_mut(&id).unwrap().properties.insert(
        "fills".into(),
        json!([{"type":"solid","color":"#312E81","visible":false}]),
    );
    assert!(pixels(&snapshot).chunks_exact(4).all(|pixel| pixel[3] == 0));
}
