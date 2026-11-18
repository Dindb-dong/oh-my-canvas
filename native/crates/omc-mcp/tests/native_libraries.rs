use omc_mcp::ToolRouter;
use omc_workspace::Workspace;
use serde_json::{Value, json};
use std::sync::Arc;

#[test]
fn local_library_publication_and_refresh_preserve_existing_instance_identity() {
    let profile = tempfile::tempdir().unwrap();
    let workspace = Workspace::open(profile.path(), None).unwrap();
    let router = Arc::new(ToolRouter::new(workspace.clone()));
    let session = workspace.session_open(None).unwrap();
    let session = session["sessionId"].as_str().unwrap();
    let call = |session, tool, args| router.call(session, tool, args, Value::Null).unwrap();
    let source = call(
        session,
        "create_document",
        json!({"title":"Component source"}),
    );
    let source = &source["documentId"];
    let frame = call(
        session,
        "create_shape",
        json!({"documentId":source,"type":"frame","width":200,"height":60}),
    );
    let component = call(
        session,
        "component",
        json!({"documentId":source,"action":"create","id":frame["rawIds"][0],"name":"Button"}),
    );
    let component = &component["rawIds"][0];
    let text = call(
        session,
        "create_shape",
        json!({"documentId":source,"type":"text","parentId":component,"width":190,"height":24,"properties":{"text":"ORIGINAL LABEL"}}),
    );
    let text = &text["rawIds"][0];
    let publication = call(
        session,
        "libraries",
        json!({"documentId":source,"action":"publish","description":"Design system"}),
    );
    let publication = &publication["publication"];
    assert_eq!(publication["version"], 1);
    assert_eq!(publication["assets"]["components"][0]["id"], *component);
    assert_eq!(
        call(
            session,
            "libraries",
            json!({"documentId":source,"action":"publication"})
        )["publication"],
        *publication
    );

    let consumer = call(session, "create_document", json!({"title":"Consumer"}));
    let consumer = &consumer["documentId"];
    let link = call(
        session,
        "libraries",
        json!({"documentId":consumer,"action":"link_source","sourceDocumentId":source,"expectedVersion":1}),
    );
    let library = &link["id"];
    assert_eq!(link["installedVersion"], 1);
    let instance = call(
        session,
        "libraries",
        json!({"documentId":consumer,"action":"insert","id":library,"componentId":component}),
    );
    let instance = &instance["rawIds"][0];
    call(
        session,
        "edit_shapes",
        json!({"documentId":consumer,"action":"patch","ids":[instance],"properties":{"width":193}}),
    );
    let render = |session| {
        call(
            session,
            "export_selection",
            json!({"documentId":consumer,"ids":[instance],"format":"svg"}),
        )["content"]
            .as_str()
            .unwrap()
            .to_owned()
    };
    let first = render(session);
    assert!(first.contains("ORIGINAL LABEL"));
    let current = |session| {
        call(
            session,
            "libraries",
            json!({"documentId":consumer,"action":"check_updates","id":library}),
        )
    };
    assert_eq!(current(session)["updateAvailable"], false);

    call(
        session,
        "edit_text",
        json!({"documentId":source,"action":"replace","id":text,"text":"REFRESHED LABEL"}),
    );
    let next = call(
        session,
        "libraries",
        json!({"documentId":source,"action":"publish"}),
    );
    assert_eq!(next["publication"]["id"], publication["id"]);
    assert_eq!(next["publication"]["version"], 2);
    assert_eq!(current(session)["installedVersion"], 1);
    assert_eq!(current(session)["availableVersion"], 2);
    assert_eq!(current(session)["updateAvailable"], true);
    assert_eq!(render(session), first);
    let stale = router
        .call(
            session,
            "libraries",
            json!({"documentId":consumer,"action":"refresh","id":library,"expectedVersion":1}),
            Value::Null,
        )
        .unwrap_err();
    assert!(stale.message.contains("version changed"));
    assert_eq!(render(session), first);
    let refresh = call(
        session,
        "libraries",
        json!({"documentId":consumer,"action":"refresh","id":library,"expectedVersion":2}),
    );
    assert_eq!(refresh["installedVersion"], 2);
    assert_eq!(refresh["id"], *library);
    assert_eq!(current(session)["updateAvailable"], false);
    let updated = render(session);
    assert!(updated.contains("REFRESHED LABEL"));
    assert!(!updated.contains("ORIGINAL LABEL"));
    let native = format!("doc_{}", consumer.as_str().unwrap().replace('-', ""));
    let snapshot = workspace.snapshot(&native).unwrap();
    let root = &snapshot.nodes[instance.as_str().unwrap()];
    assert_eq!(root.number("width", 0.0), 193.0);
    let linked = call(
        session,
        "libraries",
        json!({"documentId":consumer,"action":"get","id":library}),
    );
    assert_eq!(
        root.string("componentId"),
        linked["library"]["componentMap"][component.as_str().unwrap()].as_str()
    );
    call(session, "save_document", json!({"id":consumer}));
    let reopened = workspace.session_open(None).unwrap();
    let reopened = reopened["sessionId"].as_str().unwrap();
    call(reopened, "open_document", json!({"id":consumer}));
    assert_eq!(render(reopened), updated);
    assert_eq!(current(reopened)["installedVersion"], 2);
}
