use omc_mcp::ToolRouter;
use omc_workspace::Workspace;
use serde_json::{Value, json};
use std::sync::Arc;

fn invoke(router: &Arc<ToolRouter>, session: &str, name: &str, args: Value) -> Value {
    router.call(session, name, args, Value::Null).unwrap()
}
fn setup() -> (
    tempfile::TempDir,
    Arc<Workspace>,
    Arc<ToolRouter>,
    String,
    String,
) {
    let dir = tempfile::tempdir().unwrap();
    let workspace = Workspace::open(dir.path(), None).unwrap();
    let session = workspace.session_open(None).unwrap()["sessionId"]
        .as_str()
        .unwrap()
        .to_owned();
    let router = Arc::new(ToolRouter::new(workspace.clone()));
    let created = invoke(
        &router,
        &session,
        "create_document",
        json!({"title":"Adapter contracts"}),
    );
    let id = created["documentId"].as_str().unwrap().to_owned();
    (dir, workspace, router, session, id)
}

#[test]
fn authored_masks_keep_world_geometry_and_render_the_selected_source() {
    for (mode, alpha) in [("alpha", 128), ("luminance", 64), ("vector", 255)] {
        let (_dir, workspace, router, session, id) = setup();
        let content = invoke(
            &router,
            &session,
            "create_shape",
            json!({
                "documentId":id,"type":"rect","x":10,"y":10,"width":60,"height":60,
                "properties":{"fills":[{"type":"solid","color":"#0000ff"}]}
            }),
        )["rawIds"][0]
            .as_str()
            .unwrap()
            .to_owned();
        let mask = invoke(
            &router,
            &session,
            "create_shape",
            json!({
                "documentId":id,"type":"ellipse","x":30,"y":20,"width":20,"height":20,
                "properties":{"opacity":0.5,"fills":[{"type":"solid","color":"#808080"}]}
            }),
        )["rawIds"][0]
            .as_str()
            .unwrap()
            .to_owned();
        let native = format!("doc_{}", id.replace('-', ""));
        let before = workspace.snapshot(&native).unwrap();
        for args in [
            json!({"ids":[content,content],"maskId":content}),
            json!({"ids":[content,mask],"maskId":"root"}),
            json!({"ids":[content,mask],"mode":"front"}),
        ] {
            let mut args = args;
            args["documentId"] = json!(id);
            args["action"] = json!("mask");
            assert!(
                router
                    .call(&session, "edit_shapes", args, Value::Null)
                    .is_err()
            );
        }
        assert_eq!(
            workspace.snapshot(&native).unwrap().sequence,
            before.sequence
        );
        let group = invoke(
            &router,
            &session,
            "edit_shapes",
            json!({
                "documentId":id,"action":"mask","ids":[content,mask],"maskId":mask,"mode":mode
            }),
        );
        assert_eq!(group["receipt"]["status"], "durable");
        let group = group["rawIds"][0].as_str().unwrap();
        let snapshot = workspace.snapshot(&native).unwrap();
        assert_eq!(snapshot.nodes[group].properties["maskId"], mask);
        assert_eq!(snapshot.nodes[&content].parent_id.as_deref(), Some(group));
        assert!(snapshot.nodes[&content].rank < snapshot.nodes[&mask].rank);

        let options = omc_scene::SceneOptions {
            width: 128.,
            height: 96.,
            strict: true,
            ..Default::default()
        };
        let original = omc_scene::build_scene(&before, &options).unwrap();
        let scene = omc_scene::build_scene(&snapshot, &options).unwrap();
        for layer in [&content, &mask] {
            assert_eq!(scene.bounds(layer), original.bounds(layer));
        }
        let rendered =
            omc_render::render_rgba(&scene, &Default::default(), &omc_render::EmptyResources)
                .unwrap();
        assert_eq!(rendered.pixels[(12 * 128 + 12) * 4 + 3], 0, "{mode}");
        let pixel = &rendered.pixels[(30 * 128 + 40) * 4..][..4];
        assert_eq!(&pixel[..3], &[0, 0, 255], "{mode}");
        assert!(
            (i32::from(pixel[3]) - alpha).abs() <= 1,
            "{mode}: {pixel:?}"
        );
    }
}

#[test]
fn linked_style_apply_update_and_detach_keep_correct_authored_state() {
    let (_dir, workspace, router, session, id) = setup();
    let node = invoke(
        &router,
        &session,
        "create_shape",
        json!({"documentId":id,"type":"rect","properties":{"fills":[{"color":"#ff0000"}]}}),
    );
    let raw = node["rawIds"][0].as_str().unwrap();
    let style = invoke(
        &router,
        &session,
        "styles",
        json!({"documentId":id,"action":"create","name":"Brand","type":"paint","value":[{"color":"#0000ff"}]}),
    );
    let style_id = style["id"].as_str().unwrap();
    invoke(
        &router,
        &session,
        "styles",
        json!({"documentId":id,"action":"apply","id":style_id,"ids":[raw]}),
    );
    let native = format!("doc_{}", id.replace('-', ""));
    let snapshot = workspace.snapshot(&native).unwrap();
    assert!(!snapshot.nodes[raw].properties.contains_key("fills"));
    assert!(!snapshot.nodes[raw].properties.contains_key("fill"));
    invoke(
        &router,
        &session,
        "styles",
        json!({"documentId":id,"action":"update","id":style_id,"patch":{"value":[{"color":"#00ff00"}]}}),
    );
    let snapshot = workspace.snapshot(&native).unwrap();
    let effective = omc_style::ReferenceContext::new(&snapshot)
        .properties(&snapshot.nodes[raw])
        .0;
    assert_eq!(effective["fill"], "#00ff00");
    invoke(
        &router,
        &session,
        "styles",
        json!({"documentId":id,"action":"detach","ids":[raw],"kind":"fill"}),
    );
    invoke(
        &router,
        &session,
        "styles",
        json!({"documentId":id,"action":"update","id":style_id,"patch":{"value":[{"color":"#ffffff"}]}}),
    );
    let snapshot = workspace.snapshot(&native).unwrap();
    let effective = omc_style::ReferenceContext::new(&snapshot)
        .properties(&snapshot.nodes[raw])
        .0;
    assert_eq!(effective["fill"], "#00ff00");
    assert!(!snapshot.nodes[raw].properties.contains_key("fillStyleId"));
}

#[test]
fn library_update_keeps_definition_identity_and_instance_override() {
    let (_dir, workspace, router, session, id) = setup();
    let source = |color: &str| json!({"id":"kit","name":"Offline library","version":color,"components":{"button":{"id":"button","mainId":"main","name":"Button"}},"objects":{"main":{"id":"main","type":"frame","width":100,"height":40,"fillStyleId":"brand","fills":[{"color":"#ff0000"}]},"label":{"id":"label","type":"text","parentId":"main","width":70,"height":25,"text":"Label"}},"styles":{"brand":{"id":"brand","name":"Brand","type":"paint","paints":[{"color":color}]}}});
    let library = invoke(
        &router,
        &session,
        "libraries",
        json!({"documentId":id,"action":"add","snapshot":source("#ff0000")}),
    );
    let library_id = library["id"].as_str().unwrap();
    let instance = invoke(
        &router,
        &session,
        "libraries",
        json!({"documentId":id,"action":"insert","id":library_id,"componentId":"button","x":20,"y":50}),
    );
    let raw = instance["rawIds"][0].as_str().unwrap();
    let native = format!("doc_{}", id.replace('-', ""));
    let snapshot = workspace.snapshot(&native).unwrap();
    let definition = snapshot.nodes[raw].properties["componentId"].clone();
    invoke(
        &router,
        &session,
        "edit_shapes",
        json!({"documentId":id,"action":"patch","ids":[raw],"properties":{"width":137}}),
    );
    invoke(
        &router,
        &session,
        "libraries",
        json!({"documentId":id,"action":"update","id":library_id,"snapshot":source("#0000ff")}),
    );
    let snapshot = workspace.snapshot(&native).unwrap();
    assert_eq!(snapshot.nodes[raw].properties["componentId"], definition);
    let projected = omc_scene::resolve_components(&snapshot, None);
    let effective = omc_style::ReferenceContext::new(&projected.snapshot)
        .properties(&projected.snapshot.nodes[raw])
        .0;
    assert_eq!(effective["fill"], "#0000ff");
    assert_eq!(effective["width"], 137);
    let mut changed = source("#0000ff");
    changed["objects"]["label"]["text"] = "New 😀 label".into();
    changed["objects"]["label"]["textRuns"] = json!([
        {"text":"New 😀", "attributes":{"fontWeight":700}},
        {"text":" label", "attributes":{}}
    ]);
    invoke(
        &router,
        &session,
        "libraries",
        json!({"documentId":id,"action":"update","id":library_id,"snapshot":changed}),
    );
    let snapshot = workspace.snapshot(&native).unwrap();
    let label = snapshot
        .nodes
        .values()
        .find(|n| n.string("sourceNodeId") == Some("label"))
        .unwrap();
    assert_eq!(label.string("text"), Some("New 😀 label"));
    assert_eq!(
        label.properties["textRuns"][0]["attributes"]["fontWeight"],
        700
    );
    invoke(
        &router,
        &session,
        "component",
        json!({"documentId":id,"action":"detach","id":raw}),
    );
    let snapshot = workspace.snapshot(&native).unwrap();
    assert!(!snapshot.nodes[raw].properties.contains_key("componentId"));
    assert!(
        snapshot
            .nodes
            .values()
            .any(|node| node.parent_id.as_deref() == Some(raw))
    );
}

#[test]
fn token_modes_update_styles_without_replacing_reference() {
    let (_dir, workspace, router, session, id) = setup();
    let token = invoke(
        &router,
        &session,
        "native_tokens",
        json!({"version":"1","documentId":id,"action":"create","name":"brand","value":"#ff0000","modes":{"dark":"#0000ff"}}),
    );
    let node = invoke(
        &router,
        &session,
        "create_shape",
        json!({"documentId":id,"type":"rect"}),
    );
    let raw = node["rawIds"][0].as_str().unwrap();
    invoke(
        &router,
        &session,
        "native_tokens",
        json!({"version":"1","documentId":id,"action":"bind","id":token["id"],"nodeId":raw,"property":"fill"}),
    );
    invoke(
        &router,
        &session,
        "native_tokens",
        json!({"version":"1","documentId":id,"action":"mode","id":token["id"],"activeMode":"dark"}),
    );
    let snapshot = workspace
        .snapshot(&format!("doc_{}", id.replace('-', "")))
        .unwrap();
    let effective = omc_style::ReferenceContext::new(&snapshot)
        .properties(&snapshot.nodes[raw])
        .0;
    assert_eq!(effective["fill"], "#0000ff");
    assert_eq!(
        snapshot.nodes[raw].properties["fill"]["$token"],
        token["id"]
    );
}

#[test]
fn nested_batch_validation_is_atomic_and_text_reads_its_previous_step() {
    let (_dir, workspace, router, session, id) = setup();
    let node = invoke(
        &router,
        &session,
        "create_shape",
        json!({"documentId":id,"type":"text","properties":{"text":"A😀B"}}),
    );
    let raw = node["rawIds"][0].as_str().unwrap();
    invoke(
        &router,
        &session,
        "batch",
        json!({"documentId":id,"ops":[{"tool":"edit_text","args":{"id":raw,"action":"replace","range":{"start":1,"end":3},"text":"XY"}},{"tool":"edit_text","args":{"id":raw,"action":"find_replace","find":"XY","replace":"한"}}]}),
    );
    let native = format!("doc_{}", id.replace('-', ""));
    assert_eq!(
        workspace.snapshot(&native).unwrap().nodes[raw].properties["text"],
        "A한B"
    );
    assert!(router.call(&session,"batch",json!({"documentId":id,"ops":[{"tool":"update","args":{"id":raw,"text":"bad"}},{"tool":"create_shape","args":{"type":"bogus"}}]}),Value::Null).is_err());
    assert_eq!(
        workspace.snapshot(&native).unwrap().nodes[raw].properties["text"],
        "A한B"
    );
}

#[test]
fn find_replace_keeps_unaffected_runs_and_reads_prior_batch_marks() {
    let (_dir, workspace, router, session, id) = setup();
    let node = invoke(
        &router,
        &session,
        "create_shape",
        json!({"documentId":id,"type":"text","properties":{"text":"Cat cat scatter 🧑‍💻 CAT"}}),
    );
    let raw = node["rawIds"][0].as_str().unwrap();
    invoke(
        &router,
        &session,
        "batch",
        json!({"documentId":id,"ops":[
            {"tool":"edit_text","args":{"id":raw,"action":"range_style","range":{"start":0,"end":3},"style":{"fontWeight":700}}},
            {"tool":"edit_text","args":{"id":raw,"action":"find_replace","find":"cat","replace":"dog","wholeWord":true,"caseSensitive":false}}
        ]}),
    );
    let snapshot = workspace
        .snapshot(&format!("doc_{}", id.replace('-', "")))
        .unwrap();
    assert_eq!(
        snapshot.nodes[raw].string("text"),
        Some("dog dog scatter 🧑‍💻 dog")
    );
    assert_eq!(snapshot.nodes[raw].properties["textRuns"][0]["text"], "dog");
    assert_eq!(
        snapshot.nodes[raw].properties["textRuns"][0]["attributes"]["fontWeight"],
        700
    );
    invoke(
        &router,
        &session,
        "edit_shapes",
        json!({"documentId":id,"action":"patch","ids":[raw],"properties":{"width":null,"text":"Restored"}}),
    );
    let snapshot = workspace
        .snapshot(&format!("doc_{}", id.replace('-', "")))
        .unwrap();
    assert_eq!(snapshot.nodes[raw].string("text"), Some("Restored"));
    assert!(!snapshot.nodes[raw].properties.contains_key("width"));
}
