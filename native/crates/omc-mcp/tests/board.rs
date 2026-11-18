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

#[test]
fn native_board_tables_preserve_editable_cells_and_render_after_reopen() {
    let directory = tempfile::tempdir().unwrap();
    let workspace = Workspace::open(directory.path(), None).unwrap();
    let router = Arc::new(ToolRouter::new(workspace.clone()));
    let session = workspace.session_open(None).unwrap()["sessionId"]
        .as_str()
        .unwrap()
        .to_owned();
    let call =
        |session: &str, tool: &str, args| router.call(session, tool, args, Value::Null).unwrap();
    let document = call(
        &session,
        "create_document",
        json!({"title":"Editable board table"}),
    );
    let id = &document["documentId"];
    let board = |session: &str, mut args: Value| {
        args["documentId"] = id.clone();
        call(session, "board", args)
    };
    let created = board(
        &session,
        json!({"action":"create_table","rows":8,"columns":8,"x":20,"y":20,
               "cells":[["Heading"],["Original"]]}),
    );
    let table = &created["id"];
    let old_cell = &created["cells"][1][0];
    assert_eq!(created["rawIds"][0], *table);
    assert!(created["rawIds"].as_array().unwrap().len() > 100);
    let inserted = board(
        &session,
        json!({"action":"edit_table","id":table,"operation":"add_column","index":0}),
    );
    assert_eq!(inserted["cells"][1][1], *old_cell);
    let updated = board(
        &session,
        json!({"action":"set_table_cell","id":table,"row":1,"column":1,"text":"Editable table cell"}),
    );
    assert_eq!(updated["cells"][1][1], *old_cell);
    let removed = board(
        &session,
        json!({"action":"edit_table","id":table,"operation":"remove_column","index":0}),
    );
    assert_eq!(removed["cells"][1][0], *old_cell);

    let reader = workspace.session_open(None).unwrap()["sessionId"]
        .as_str()
        .unwrap()
        .to_owned();
    call(&reader, "open_document", json!({"id":id}));
    let read = board(&reader, json!({"action":"inspect_table","id":table}));
    assert_eq!(read["rows"], 8);
    assert_eq!(read["columns"], 8);
    assert_eq!(read["cells"][1][0], *old_cell);
    let svg = call(
        &reader,
        "export_selection",
        json!({"documentId":id,"format":"svg","ids":[table]}),
    );
    assert!(
        svg["content"]
            .as_str()
            .unwrap()
            .contains("Editable table cell")
    );
}

#[test]
fn native_board_mind_map_reflows_topics_and_bound_edges_after_reopen() {
    let directory = tempfile::tempdir().unwrap();
    let workspace = Workspace::open(directory.path(), None).unwrap();
    let router = Arc::new(ToolRouter::new(workspace.clone()));
    let session = workspace.session_open(None).unwrap()["sessionId"]
        .as_str()
        .unwrap()
        .to_owned();
    let call =
        |session: &str, tool: &str, args| router.call(session, tool, args, Value::Null).unwrap();
    let document = call(
        &session,
        "create_document",
        json!({"title":"Editable mind map"}),
    );
    let id = &document["documentId"];
    let board = |session: &str, mut args: Value| {
        args["documentId"] = id.clone();
        call(session, "board", args)
    };

    let created = board(
        &session,
        json!({"action":"create_mind_map","name":"Launch","x":32,"y":56,"topics":[
            {"key":"root","text":"Launch"},
            {"key":"one","parent":"root","text":"Research"},
            {"key":"two","parent":"root","text":"Design"},
            {"key":"child","parent":"one","text":"Interview"}
        ]}),
    );
    let map = &created["id"];
    let root = &created["topics"][0]["id"];
    let first = &created["topics"][1];
    let second = &created["topics"][2];
    let edge = &first["connectorId"];
    assert_eq!(created["rawIds"][0], *map);
    assert_eq!(first["parentId"], *root);
    let bounds = |topic: &Value| {
        call(
            &session,
            "measure",
            json!({"documentId":id,"from":root,"to":topic}),
        )["to"]["bounds"]
            .clone()
    };
    let initial_first = bounds(&first["id"]);
    let initial_second = bounds(&second["id"]);
    assert_eq!(initial_first["x"], initial_second["x"]);
    assert!(initial_first["y"].as_f64().unwrap() < initial_second["y"].as_f64().unwrap());

    let renamed = board(
        &session,
        json!({"action":"rename_mind_topic","id":map,"targetId":first["id"],
               "text":format!("Interview outline {}", "topic details ".repeat(25))}),
    );
    assert_eq!(renamed["topics"][1]["textId"], first["textId"]);
    assert_eq!(renamed["topics"][1]["connectorId"], *edge);
    assert!(bounds(&second["id"])["y"].as_f64().unwrap() > initial_second["y"].as_f64().unwrap());

    let added = board(
        &session,
        json!({"action":"add_mind_topic","id":map,"parentId":root,"text":"Delivery"}),
    );
    let delivery = added["topics"].as_array().unwrap().last().unwrap();
    assert_eq!(delivery["parentId"], *root);
    let before = bounds(&delivery["id"]);
    call(
        &session,
        "edit_shapes",
        json!({"documentId":id,"action":"translate","ids":[map],"dx":55,"dy":70}),
    );
    assert_eq!(
        bounds(&delivery["id"])["x"].as_f64().unwrap(),
        before["x"].as_f64().unwrap() + 55.
    );
    let export = |session, target: &Value| {
        call(
            session,
            "export_selection",
            json!({"documentId":id,"format":"svg","ids":[target]}),
        )["content"]
            .as_str()
            .unwrap()
            .to_owned()
    };
    let svg = export(&session, map);
    assert!(svg.contains("Interview outline"));
    assert!(svg.contains("Delivery"));
    assert!(export(&session, edge).contains("<path"));

    let reader = workspace.session_open(None).unwrap()["sessionId"]
        .as_str()
        .unwrap()
        .to_owned();
    call(&reader, "open_document", json!({"id":id}));
    let read = board(&reader, json!({"action":"inspect_mind_map","id":map}));
    assert_eq!(read["topics"], added["topics"]);
    assert_eq!(export(&reader, map), svg);
    let pruned = board(
        &reader,
        json!({"action":"remove_mind_topic","id":map,"targetId":first["id"]}),
    );
    assert_eq!(pruned["topics"].as_array().unwrap().len(), 3);
    assert!(!export(&reader, map).contains("Interview"));
}
