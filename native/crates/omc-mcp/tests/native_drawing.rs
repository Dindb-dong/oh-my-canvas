use omc_mcp::ToolRouter;
use omc_workspace::Workspace;
use serde_json::{Value, json};
use std::sync::Arc;

#[test]
fn native_text_path_keeps_editable_text_and_source_and_restores_placement() {
    let directory = tempfile::tempdir().unwrap();
    let workspace = Workspace::open(directory.path(), None).unwrap();
    let router = Arc::new(ToolRouter::new(workspace.clone()));
    let open = || {
        workspace.session_open(None).unwrap()["sessionId"]
            .as_str()
            .unwrap()
            .to_owned()
    };
    let edit_session = open();
    let call = |session: &str, tool: &str, params: Value| {
        router.call(session, tool, params, Value::Null).unwrap()
    };
    let created = call(
        &edit_session,
        "create_document",
        json!({"title":"Text and curve"}),
    );
    let document = &created["documentId"];
    let shape = |params: Value| call(&edit_session, "create_shape", params)["rawIds"][0].clone();
    let text = shape(json!({
        "documentId":document,"type":"text","x":12,"y":24,"width":140,"height":35,
        "properties":{"text":"Curved design","fontSize":18}
    }));
    let ellipse = shape(json!({
        "documentId":document,"type":"ellipse","x":420,"y":180,"width":220,"height":140
    }));
    let tree = |session: &str, id: &Value| {
        call(
            session,
            "get_tree",
            json!({"documentId":document,"id":id,"detail":"detailed"}),
        )
    };
    let screenshot = |session: &str| {
        call(
            session,
            "screenshot",
            json!({"documentId":document,"id":text,"mode":"overview"}),
        )["base64"]
            .as_str()
            .unwrap()
            .to_owned()
    };
    let original = tree(&edit_session, &text)["tree"]["properties"].clone();
    let ordinary_pixels = screenshot(&edit_session);
    let source = tree(&edit_session, &ellipse);
    call(
        &edit_session,
        "edit_text",
        json!({"documentId":document,"action":"path_attach","id":text,"pathId":ellipse,"start":0.1}),
    );
    let attached = tree(&edit_session, &text);
    assert_eq!(
        attached["tree"]["properties"]["textPath"]["sourceId"],
        ellipse
    );
    assert!(attached["diagnostics"][0]["bounds"]["x"].as_f64().unwrap() > 370.);
    assert_eq!(source["tree"], tree(&edit_session, &ellipse)["tree"]);
    let first_curve = screenshot(&edit_session);
    assert_ne!(first_curve, ordinary_pixels);

    call(
        &edit_session,
        "edit_text",
        json!({"documentId":document,"action":"path_options","id":text,"start":0.4,"flip":true}),
    );
    let moved_curve = screenshot(&edit_session);
    assert_ne!(first_curve, moved_curve);
    let reopen = open();
    call(&reopen, "open_document", json!({"id":document}));
    assert_eq!(moved_curve, screenshot(&reopen));
    call(
        &edit_session,
        "edit_text",
        json!({"documentId":document,"action":"path_detach","id":text}),
    );
    assert_eq!(tree(&reopen, &text)["tree"]["properties"], original);
    assert_eq!(ordinary_pixels, screenshot(&reopen));

    let foreign = call(
        &reopen,
        "create_document",
        json!({"title":"Separate document"}),
    );
    let foreign_path = call(
        &reopen,
        "create_shape",
        json!({"documentId":foreign["documentId"],"type":"ellipse","width":200,"height":100}),
    )["rawIds"][0]
        .clone();
    let rejected = router.call(
        &edit_session,
        "edit_text",
        json!({"documentId":document,"action":"path_attach","id":text,"pathId":foreign_path}),
        Value::Null,
    );
    assert!(rejected.is_err());
    assert_eq!(tree(&edit_session, &text)["tree"]["properties"], original);
}

#[test]
fn native_shape_builder_previews_and_edits_the_selected_regions() {
    let directory = tempfile::tempdir().unwrap();
    let workspace = Workspace::open(directory.path(), None).unwrap();
    let router = Arc::new(ToolRouter::new(workspace.clone()));
    let registration = workspace.session_open(None).unwrap();
    let session = registration["sessionId"].as_str().unwrap();
    let call = |tool: &str, params: Value| router.call(session, tool, params, Value::Null).unwrap();
    let doc = call("create_document", json!({"title":"Shape builder"}));
    let document = &doc["documentId"];
    let rect = |x| {
        call(
            "create_shape",
            json!({"documentId":document,"type":"rect","x":x,"y":50,"width":80,"height":50,
                "properties":{"fills":[{"type":"solid","color":"#223355"}]}}),
        )["rawIds"][0]
            .clone()
    };
    let left = rect(40);
    let right = rect(80);
    let ids = json!([left, right]);
    let preview = || {
        call(
            "shape_builder",
            json!({"documentId":document,"ids":ids,"action":"regions"}),
        )
    };
    let first = preview();
    assert_eq!(first["regions"].as_array().unwrap().len(), 3);
    let overlap = |output: &Value| {
        let common = output["regions"]
            .as_array()
            .unwrap()
            .iter()
            .find(|region| region["sources"].as_array().unwrap().len() == 2)
            .unwrap();
        assert_eq!(common["bounds"], json!([80., 50., 40., 50.]));
        common["index"].clone()
    };
    let merge = |preview: &Value| {
        router.call(
            session,
            "shape_builder",
            json!({"documentId":document,"ids":ids,"action":"merge",
                "regions":[overlap(preview)],"revision":preview["revision"]}),
            Value::Null,
        )
    };
    call(
        "edit_shapes",
        json!({"documentId":document,"ids":[left],"action":"patch","properties":{"name":"Left"}}),
    );
    assert_eq!(merge(&first).unwrap_err().code, "stale_revision");
    let merged = merge(&preview()).unwrap();
    assert_eq!(merged["receipt"]["status"], "durable");
    let inspect = |id: &Value| {
        call(
            "get_tree",
            json!({"documentId":document,"id":id,"detail":"detailed"}),
        )["tree"]
            .clone()
    };
    assert_eq!(inspect(&left)["properties"]["visible"], false);
    let path = inspect(&merged["id"]);
    assert_eq!(path["kind"], "path");
    assert!(
        path["properties"]["path"]
            .as_str()
            .unwrap()
            .starts_with('M')
    );
    let removed = call(
        "shape_builder",
        json!({"documentId":document,"ids":[merged["id"]],"action":"remove","points":[[100,70]]}),
    );
    assert_eq!(removed["removed"], json!([merged["id"]]));
    call("undo", json!({"documentId":document}));
    assert_eq!(inspect(&merged["id"])["properties"], path["properties"]);
}
