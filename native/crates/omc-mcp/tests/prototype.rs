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
