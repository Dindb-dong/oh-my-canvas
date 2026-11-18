use omc_mcp::ToolRouter;
use omc_workspace::Workspace;
use serde_json::{Value, json};
use std::sync::Arc;

#[test]
fn native_board_sticky_and_connector_stay_editable_after_reopen() {
    let directory = tempfile::tempdir().unwrap();
    let workspace = Workspace::open(directory.path(), None).unwrap();
    let router = Arc::new(ToolRouter::new(workspace.clone()));
    let open_session = || {
        workspace.session_open(None).unwrap()["sessionId"]
            .as_str()
            .unwrap()
            .to_owned()
    };
    let call =
        |session: &str, tool: &str, args| router.call(session, tool, args, Value::Null).unwrap();
    let session = open_session();
    let created = call(&session, "create_document", json!({"title":"Native board"}));
    let document = created["documentId"].as_str().unwrap();
    let first = call(
        &session,
        "board",
        json!({"documentId":document,"action":"create_sticky","text":"Author","author":"Ada","x":50,"y":40}),
    );
    let second = call(
        &session,
        "board",
        json!({"documentId":document,"action":"create_sticky","text":"Next","x":410,"y":40}),
    );
    let third = call(
        &session,
        "board",
        json!({"documentId":document,"action":"create_sticky","text":"Alternate","x":600,"y":170}),
    );
    let connector = call(
        &session,
        "board",
        json!({"documentId":document,"action":"connect","fromId":first["id"],"toId":second["id"],
               "fromSide":"right","toSide":"left","style":"straight","label":"Next step"}),
    );

    let svg = |session: &str| {
        let response = call(
            session,
            "export_selection",
            json!({"documentId":document,"format":"svg","ids":[connector["id"]]}),
        );
        response["content"].as_str().unwrap().to_owned()
    };
    let route = svg(&session);
    assert!(route.contains("<path"));
    assert!(route.contains("Next step"));
    call(
        &session,
        "edit_shapes",
        json!({"documentId":document,"ids":[second["id"]],"action":"translate","dx":0,"dy":220}),
    );
    let moved = svg(&session);
    assert_ne!(route, moved, "routing follows a moved endpoint");

    let updated_text = "새 디자인".repeat(300);
    let update = call(
        &session,
        "board",
        json!({"documentId":document,"action":"update_sticky","id":first["id"],
               "text":updated_text,"color":"#89ccff"}),
    );
    assert_eq!(update["textId"], first["textId"]);
    let stretched = svg(&session);
    assert_ne!(moved, stretched, "sticky growth reroutes the line");
    call(
        &session,
        "board",
        json!({"documentId":document,"action":"reattach","id":connector["id"],
               "targetId":third["id"],"end":"to","side":"left"}),
    );
    let reattached = svg(&session);
    assert_ne!(stretched, reattached);

    let foreign = call(&session, "create_document", json!({"title":"Other board"}));
    let foreign_sticky = call(
        &session,
        "board",
        json!({"documentId":foreign["documentId"],"action":"create_sticky"}),
    );
    assert!(
        router
            .call(
                &session,
                "board",
                json!({"documentId":document,"action":"reattach","id":connector["id"],
                       "targetId":foreign_sticky["id"],"end":"to"}),
                Value::Null,
            )
            .is_err()
    );
    let other_session = open_session();
    call(&other_session, "open_document", json!({"id":document}));
    assert_eq!(reattached, svg(&other_session));

    let native_id = format!("doc_{}", document.replace('-', ""));
    let snapshot = workspace.snapshot(&native_id).unwrap();
    let note = &snapshot.nodes[first["id"].as_str().unwrap()];
    let label = &snapshot.nodes[first["textId"].as_str().unwrap()];
    let route = &snapshot.nodes[connector["id"].as_str().unwrap()];
    assert_eq!(note.properties["fill"], "#89ccff");
    assert!(note.number("height", 0.) > 200.);
    assert_eq!(label.properties["text"], updated_text);
    assert_eq!(
        route.properties["boardConnector"]["from"]["layer"],
        first["id"]
    );
    assert_eq!(
        route.properties["boardConnector"]["to"]["layer"],
        third["id"]
    );
}
