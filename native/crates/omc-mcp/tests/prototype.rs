use omc_mcp::ToolRouter;
use omc_workspace::Workspace;
use serde_json::{Value, json};
use std::sync::Arc;

#[test]
fn native_prototype_starts_and_navigation_survive_reopen() {
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
    let call =
        |session: &str, tool: &str, args| router.call(session, tool, args, Value::Null).unwrap();
    let created = call(&session, "create_document", json!({"title":"Prototype"}));
    let document = created["documentId"].as_str().unwrap();
    let frame = |name| {
        call(
            &session,
            "create_board",
            json!({"documentId":document,"name":name,"width":320,"height":240}),
        )["rawIds"][0]
            .clone()
    };
    let home = frame("Home");
    let details = frame("Details");
    let receipt = frame("Receipt");
    let button = call(
        &session,
        "create_shape",
        json!({"documentId":document,"type":"rect","parentId":home,"width":80,"height":40,"properties":{"name":"Open"}}),
    )["rawIds"][0]
        .clone();
    let prototype = |session: &str, args| call(session, "prototype", args);
    prototype(
        &session,
        json!({"documentId":document,"action":"set_flow","frameId":home,"name":"Main",
               "description":"Open the details"}),
    );
    prototype(
        &session,
        json!({"documentId":document,"action":"set_navigation","sourceId":button,"destinationId":details}),
    );
    assert!(
        router
            .call(
                &session,
                "prototype",
                json!({"documentId":document,"action":"set_navigation","sourceId":button,"destinationId":home}),
                Value::Null,
            )
            .is_err()
    );
    let reader = open_session();
    call(&reader, "open_document", json!({"id":document}));
    let inspect = || {
        prototype(
            &reader,
            json!({"documentId":document,"action":"inspect","sourceId":button}),
        )
    };
    let initial = inspect();
    assert_eq!(
        initial["flows"],
        json!([{"start":home,"name":"Main","description":"Open the details"}])
    );
    assert_eq!(initial["interactions"][0]["trigger"]["type"], "onClick");
    assert_eq!(initial["interactions"][0]["actions"][0]["dest"], details);
    assert_eq!(initial["invalidStarts"], json!([]));

    let compatible = router
        .call_figcraft(&reader, "inspect_document", json!({"depth":3}))
        .unwrap();
    let layer = |name| {
        compatible["layers"]
            .as_array()
            .unwrap()
            .iter()
            .find(|node| node["name"] == name)
            .unwrap()
    };
    let alias = &layer("Home")["children"][0]["id"];
    assert_eq!(
        layer("Home")["children"][0]["interactions"][0]["actions"][0]["dest"],
        layer("Details")["id"]
    );
    let legacy_add = |trigger| {
        router
            .call_figcraft(
                &reader,
                "run_command",
                json!({"command":"proto.interaction.add","params":{
                    "id":alias,"trigger":trigger,"action":{"type":"closeOverlay"}
                }}),
            )
            .unwrap()
    };
    legacy_add("onHover");
    prototype(
        &session,
        json!({"documentId":document,"action":"set_navigation","sourceId":button,"destinationId":receipt}),
    );
    let combined = inspect();
    assert_eq!(combined["interactions"][0]["actions"][0]["dest"], receipt);
    assert_eq!(combined["interactions"][1]["trigger"]["type"], "onHover");
    prototype(
        &session,
        json!({"documentId":document,"action":"remove_navigation","sourceId":button}),
    );
    assert_eq!(
        inspect()["interactions"],
        json!([combined["interactions"][1]])
    );
    legacy_add("onClick");
    let before = inspect();
    assert!(
        router
            .call(
                &session,
                "prototype",
                json!({"documentId":document,"action":"set_navigation","sourceId":button,"destinationId":details}),
                Value::Null,
            )
            .is_err()
    );
    assert_eq!(inspect(), before);
    prototype(
        &session,
        json!({"documentId":document,"action":"remove_flow","frameId":home}),
    );
    assert_eq!(inspect()["flows"], json!([]));
}

#[test]
fn native_advanced_interactions_persist_and_reject_invalid_destinations() {
    let directory = tempfile::tempdir().unwrap();
    let workspace = Workspace::open(directory.path(), None).unwrap();
    let router = Arc::new(ToolRouter::new(workspace.clone()));
    let new_session = || {
        workspace.session_open(None).unwrap()["sessionId"]
            .as_str()
            .unwrap()
            .to_owned()
    };
    let session = new_session();
    let call =
        |session: &str, tool: &str, args| router.call(session, tool, args, Value::Null).unwrap();
    let document = call(
        &session,
        "create_document",
        json!({"title":"Prototype interactions"}),
    );
    let id = &document["documentId"];
    let frame = |name| {
        call(
            &session,
            "create_board",
            json!({"documentId":id,"name":name,"width":240,"height":160}),
        )["rawIds"][0]
            .clone()
    };
    let home = frame("Home");
    let details = frame("Details");
    let token = call(
        &session,
        "native_tokens",
        json!({
            "version":"1","documentId":id,"action":"create","type":"boolean","name":"Open details","value":false,
        }),
    );
    let variable = &token["id"];
    let interactions = json!([{
        "trigger":"onClick","transition":"dissolve","durationMs":150,"delayMs":20,"actions":[
            {"type":"setVariable","variable":variable,"value":true},
            {"type":"conditional","blocks":[
                {"expression":"true","actions":[{"type":"openOverlay","dest":details,"anchor":"screen"}]},
                {"actions":[{"type":"back"}]}
            ]}
        ]
    }]);
    let set = call(
        &session,
        "prototype",
        json!({
            "documentId":id,"action":"set_interactions","sourceId":home,"interactions":interactions,
        }),
    );
    let stored = &set["interactions"][0];
    assert_eq!(stored["transition"]["type"], "dissolve");
    assert_eq!(stored["duration_ms"], 150);
    assert_eq!(stored["delay_ms"], 20);
    assert_eq!(stored["actions"][0]["variable"], *variable);
    assert_eq!(
        stored["actions"][1]["blocks"][0]["actions"][0]["dest"],
        details
    );
    let foreign = call(
        &session,
        "create_document",
        json!({"title":"Other prototype"}),
    );
    let other = call(
        &session,
        "create_board",
        json!({"documentId":foreign["documentId"],"width":200}),
    )["rawIds"][0]
        .clone();
    assert!(
        router
            .call(
                &session,
                "prototype",
                json!({
                    "documentId":id,"action":"set_interactions","sourceId":home,
                    "interactions":[{"actions":[{"type":"navigate","dest":other}]}]
                }),
                Value::Null
            )
            .is_err()
    );
    let reader = new_session();
    call(&reader, "open_document", json!({"id":id}));
    let read = call(
        &reader,
        "prototype",
        json!({
            "documentId":id,"action":"inspect","sourceId":home
        }),
    );
    assert_eq!(read["interactions"], set["interactions"]);
    let play = |events: Value, until, render| {
        call(
            &reader,
            "prototype",
            json!({
                "documentId":id,"action":"preview_playback","frameId":home,
                "events":events,"untilMs":until,"render":render,
            }),
        )
    };
    let preview = play(
        json!([
            {"atMs":0,"trigger":"onClick","sourceId":home},
            {"atMs":19},
            {"atMs":20}
        ]),
        30,
        true,
    );
    assert!(preview["steps"][1]["overlayId"].is_null());
    assert_eq!(preview["steps"][2]["overlayId"], details);
    assert_eq!(preview["frameId"], home);
    assert_eq!(preview["variables"][variable.as_str().unwrap()], true);
    for kind in ["frameImage", "overlayImage"] {
        let png = call(
            &reader,
            "native_result",
            json!({"version":"1","resultId":preview[kind]["resultId"]}),
        );
        assert_eq!(png["mimeType"], "image/png");
        assert!(png["base64"].as_str().unwrap().starts_with("iVBORw0KGgo"));
    }
    let fresh = play(json!([]), 30, false);
    assert_eq!(fresh["frameId"], home);
    assert!(fresh["overlayId"].is_null());
    assert_eq!(fresh["variables"], json!({}));
    assert_eq!(fresh["documentRevision"], preview["documentRevision"]);
}
