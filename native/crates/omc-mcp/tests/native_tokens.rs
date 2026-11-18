use omc_mcp::ToolRouter;
use omc_workspace::Workspace;
use serde_json::{Value, json};
use std::sync::Arc;

#[test]
fn native_token_inspection_follows_authored_aliases_and_persisted_modes() {
    let directory = tempfile::tempdir().unwrap();
    let workspace = Workspace::open(directory.path(), None).unwrap();
    let router = Arc::new(ToolRouter::new(workspace.clone()));
    let open_session = || {
        workspace.session_open(None).unwrap()["sessionId"]
            .as_str()
            .unwrap()
            .to_owned()
    };
    let session = open_session();
    let call = |session: &str, name: &str, args: Value| {
        router.call(session, name, args, Value::Null).unwrap()
    };
    let document = call(&session, "create_document", json!({"title":"Token modes"}));
    let document = document["documentId"].as_str().unwrap();
    let token = |session: &str, mut args: Value| {
        args["version"] = json!("1");
        args["documentId"] = json!(document);
        call(session, "native_tokens", args)
    };
    let light = token(
        &session,
        json!({"action":"create","name":"light","type":"color","value":"#ffffff"}),
    );
    let dark = token(
        &session,
        json!({"action":"create","name":"dark","type":"color","value":"#000000"}),
    );
    let alias = token(
        &session,
        json!({"action":"create","name":"surface","type":"color","modes":{"light":{"$token":light["id"]},"dark":{"$token":dark["id"]}},"activeMode":"light"}),
    );
    let node = call(
        &session,
        "create_shape",
        json!({"documentId":document,"type":"rect"}),
    );
    let inspect = |session: &str| {
        token(
            session,
            json!({"action":"inspect","id":alias["id"],"nodeId":node["rawIds"][0]}),
        )
    };

    token(
        &session,
        json!({"action":"bind","id":alias["id"],"nodeId":node["rawIds"][0],"property":"fill"}),
    );
    let before = inspect(&session);
    assert_eq!(before["mode"], "light");
    assert_eq!(before["authoredValue"], json!({"$token":light["id"]}));
    assert_eq!(before["effectiveValue"], "#ffffff");
    assert_eq!(before["diagnostics"], json!([]));

    token(
        &session,
        json!({"action":"mode","id":alias["id"],"activeMode":"dark"}),
    );
    let reopened = open_session();
    call(&reopened, "open_document", json!({"id":document}));
    let after = inspect(&reopened);
    assert_eq!(after["token"]["id"], alias["id"]);
    assert_eq!(after["mode"], "dark");
    assert_eq!(after["authoredValue"], json!({"$token":dark["id"]}));
    assert_eq!(after["effectiveValue"], "#000000");
    assert_eq!(after["diagnostics"], json!([]));
    let snapshot = workspace
        .snapshot(&format!("doc_{}", document.replace('-', "")))
        .unwrap();
    let node = &snapshot.nodes[node["rawIds"][0].as_str().unwrap()];
    assert_eq!(after["revision"], json!(snapshot.revision()));
    assert_eq!(node.properties["fill"], json!({"$token":alias["id"]}));
    assert_eq!(
        omc_style::ReferenceContext::new(&snapshot)
            .properties(node)
            .0["fill"],
        after["effectiveValue"]
    );

    token(&reopened, json!({"action":"delete","id":dark["id"]}));
    let dangling = inspect(&reopened);
    assert_eq!(dangling["authoredValue"], after["authoredValue"]);
    assert_eq!(dangling["effectiveValue"], Value::Null);
    assert_eq!(dangling["diagnostics"][0]["code"], "unresolved_reference");
}

#[test]
fn native_collection_modes_scope_to_the_requested_frame_and_inherit_on_clear() {
    let directory = tempfile::tempdir().unwrap();
    let workspace = Workspace::open(directory.path(), None).unwrap();
    let router = Arc::new(ToolRouter::new(workspace.clone()));
    let session = workspace.session_open(None).unwrap();
    let session = session["sessionId"].as_str().unwrap();
    let call = |name: &str, args: Value| router.call(session, name, args, Value::Null);
    let document = call("create_document", json!({"title":"Scoped palette"})).unwrap();
    let document = document["documentId"].as_str().unwrap();
    let native = format!("doc_{}", document.replace('-', ""));
    router
        .fig_bind_collaboration_tab(session, document)
        .unwrap();
    let command = |command: &str, params: Value| {
        router
            .call_figcraft(
                session,
                "run_command",
                json!({"command":command,"params":params}),
            )
            .unwrap()
    };
    let collection = command(
        "variable.createCollection",
        json!({"name":"Palette","modes":["Light","Dark"]}),
    );
    let base = command(
        "variable.create",
        json!({"collection":collection["id"],"type":"color","name":"base","values":{"Light":"#ffffff","Dark":"#000000"}}),
    );
    let alias = command(
        "variable.create",
        json!({"collection":collection["id"],"type":"color","name":"surface","value":{"alias":base["id"]}}),
    );

    let tokens = |mut args: Value| {
        args["version"] = json!("1");
        args["documentId"] = json!(document);
        call("native_tokens", args)
    };
    let palette = tokens(json!({"action":"list_collections"})).unwrap();
    assert_eq!(palette["items"][0]["id"], collection["id"]);
    let light = &palette["items"][0]["modes"][0]["id"];
    let dark = &palette["items"][0]["modes"][1]["id"];
    let frame = call(
        "create_shape",
        json!({"documentId":document,"type":"frame"}),
    )
    .unwrap();
    let frame = &frame["rawIds"][0];
    let rect = |parent: &Value| {
        call(
            "create_shape",
            json!({"documentId":document,"type":"rect","parentId":parent}),
        )
        .unwrap()["rawIds"][0]
            .clone()
    };
    let root = json!(workspace.snapshot(&native).unwrap().pages[0].root_node_id);
    let inside = rect(frame);
    let outside = rect(&root);
    for node in [&inside, &outside] {
        tokens(json!({"action":"bind","id":alias["id"],"nodeId":node,"property":"fill"})).unwrap();
    }
    let scoped = |node: &Value, mode: &Value| {
        tokens(json!({"action":"set_scope_mode","id":collection["id"],"nodeId":node,"mode":mode}))
    };
    let inspect =
        |node: &Value| tokens(json!({"action":"inspect","id":alias["id"],"nodeId":node})).unwrap();
    let page = scoped(&root, dark).unwrap();
    assert_eq!(page["mode"], *dark);
    assert_eq!(inspect(&inside)["effectiveValue"], "#000000");
    scoped(frame, light).unwrap();
    let local = inspect(&inside);
    assert_eq!(local["effectiveValue"], "#ffffff");
    assert_eq!(local["mode"], *light);
    assert_eq!(local["authoredValue"], json!({"$token":base["id"]}));
    assert_eq!(inspect(&outside)["effectiveValue"], "#000000");

    assert!(scoped(&inside, light).is_err());
    assert!(scoped(frame, &json!("unknown")).is_err());
    assert_eq!(inspect(&inside)["revision"], local["revision"]);
    let cleared = scoped(frame, &Value::Null).unwrap();
    assert_eq!(cleared["mode"], Value::Null);
    assert_eq!(inspect(&inside)["effectiveValue"], "#000000");
    call("undo", json!({"documentId":document})).unwrap();
    assert_eq!(inspect(&inside)["effectiveValue"], "#ffffff");
}
