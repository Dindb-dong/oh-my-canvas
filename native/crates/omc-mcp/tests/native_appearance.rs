use base64::Engine;
use omc_mcp::ToolRouter;
use omc_workspace::Workspace;
use serde_json::{Value, json};

#[test]
fn indexed_appearance_edits_preserve_siblings_and_render_in_order() {
    let dir = tempfile::tempdir().unwrap();
    let workspace = Workspace::open(dir.path(), None).unwrap();
    let session = workspace.session_open(None).unwrap()["sessionId"]
        .as_str()
        .unwrap()
        .to_owned();
    let router = ToolRouter::new(workspace.clone());
    let call = |name: &str, args: Value| router.call(&session, name, args, Value::Null);
    let document = call("create_document", json!({"title":"Appearance test"})).unwrap();
    let document = document["documentId"].as_str().unwrap();
    let shape = |properties: Value| {
        call(
            "create_shape",
            json!({"documentId":document,"type":"rect","width":40,"height":40,"properties":properties}),
        )
        .unwrap()["rawIds"][0]
            .as_str()
            .unwrap()
            .to_owned()
    };
    let (red, blue, green) = (
        json!({"type":"solid","color":"#FF0000"}),
        json!({"type":"solid","color":"#0000FF"}),
        json!({"type":"solid","color":"#00FF00"}),
    );
    let front = shape(json!({"fills":[red,blue],"stroke":"#111111","strokeWidth":3}));
    let empty = shape(json!({}));
    let edit = |ids: Value, appearance: Value| {
        call(
            "edit_shapes",
            json!({"documentId":document,"action":"appearance","ids":ids,"appearance":appearance}),
        )
    };
    let read = || {
        call(
            "get_tree",
            json!({"documentId":document,"detail":"detailed","id":front}),
        )
        .unwrap()
    };
    assert!(
        edit(
            json!([front, empty]),
            json!({"stack":"fills","operation":"remove","index":1}),
        )
        .is_err()
    );
    assert_eq!(read()["tree"]["properties"]["fills"], json!([red, blue]));
    edit(
        json!([front]),
        json!({"stack":"fills","operation":"insert","index":2,"entry":green}),
    )
    .unwrap();
    edit(
        json!([front]),
        json!({"stack":"fills","operation":"move","index":2,"to":0}),
    )
    .unwrap();
    assert_eq!(
        read()["tree"]["properties"]["fills"],
        json!([green, red, blue])
    );
    let screenshot = call(
        "screenshot",
        json!({"documentId":document,"id":front,"mode":"overview"}),
    )
    .unwrap();
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(screenshot["base64"].as_str().unwrap())
        .unwrap();
    let image = skia_safe::Image::from_encoded(skia_safe::Data::new_copy(&bytes))
        .unwrap()
        .make_raster_image(None, None)
        .unwrap();
    assert_eq!(
        image.peek_pixels().unwrap().get_color((15, 15)),
        skia_safe::Color::BLUE
    );

    edit(
        json!([front]),
        json!({"stack":"strokes","operation":"replace","index":0,"entry":{"type":"solid","color":"#FFFFFF"}}),
    )
    .unwrap();
    edit(
        json!([front]),
        json!({"stack":"effects","operation":"insert","index":0,"entry":{"type":"layerBlur","radius":4}}),
    )
    .unwrap();
    assert_eq!(read()["tree"]["properties"]["blur"], 4.);
    edit(
        json!([front]),
        json!({"stack":"effects","operation":"remove","index":0}),
    )
    .unwrap();

    call("save_document", json!({"id":document})).unwrap();
    workspace.session_close(&session).unwrap();
    let second = workspace.session_open(None).unwrap();
    let second = second["sessionId"].as_str().unwrap();
    router
        .call(second, "open_document", json!({"id":document}), Value::Null)
        .unwrap();
    let actual = router
        .call(
            second,
            "get_tree",
            json!({"documentId":document,"detail":"detailed","id":front}),
            Value::Null,
        )
        .unwrap();
    let properties = &actual["tree"]["properties"];
    assert_eq!(properties["fills"], json!([green, red, blue]));
    assert_eq!(
        properties["strokes"],
        json!([{"type":"solid","color":"#FFFFFF","width":3}])
    );
    assert_eq!(properties["effects"], json!([]));
    assert_eq!(properties["blur"], 0.);
}
