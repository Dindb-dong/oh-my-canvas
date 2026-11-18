use omc_mcp::ToolRouter;
use omc_workspace::Workspace;
use serde_json::{Value, json};
use std::sync::Arc;

#[test]
fn native_slots_render_replacement_and_restore_default_after_reopen() {
    let profile = tempfile::tempdir().unwrap();
    let workspace = Workspace::open(profile.path(), None).unwrap();
    let router = Arc::new(ToolRouter::new(workspace.clone()));
    let session = workspace.session_open(None).unwrap();
    let session = session["sessionId"].as_str().unwrap();
    let call = |session, tool, args| router.call(session, tool, args, Value::Null).unwrap();
    let document = call(session, "create_document", json!({"title":"Native slots"}));
    let document = document["documentId"].as_str().unwrap();
    let component = |action, mut args: Value| {
        args["action"] = json!(action);
        args["documentId"] = json!(document);
        call(session, "component", args)
    };
    let frame = |parent| {
        let mut args = json!({"documentId":document,"type":"frame","width":160,"height":64});
        if let Some(parent) = parent {
            args["parentId"] = parent;
        }
        call(session, "create_shape", args)["rawIds"][0].clone()
    };
    let label = |parent: &Value, title| {
        call(
            session,
            "create_shape",
            json!({"documentId":document,"type":"text","parentId":parent,"properties":{"text":title}}),
        );
    };
    let card = component("create", json!({"id":frame(None),"name":"Card"}));
    let card = &card["rawIds"][0];
    let slot_frame = frame(Some(card.clone()));
    label(&slot_frame, "DEFAULT ICON");
    let glyph_frame = frame(None);
    label(&glyph_frame, "REPLACEMENT ICON");
    let glyph = component("create", json!({"id":glyph_frame,"name":"Glyph"}));
    let glyph = &glyph["rawIds"][0];
    let slot = component(
        "slot_create",
        json!({"id":slot_frame,"name":"Leading","preferred":[glyph]}),
    );
    let definition = component("slot_list", json!({"id":card}));
    assert_eq!(definition["slots"][0]["id"], slot["property"]);
    assert_eq!(definition["slots"][0]["preferred"][0], *glyph);

    let instance = component("instance", json!({"source":card}));
    let instance = &instance["rawIds"][0];
    let lists = component("slot_list", json!({"id":instance}));
    let projected = &lists["slots"][0]["id"];
    let content = |session| {
        call(
            session,
            "export_selection",
            json!({"documentId":document,"ids":[instance],"format":"svg"}),
        )["content"]
            .as_str()
            .unwrap()
            .to_owned()
    };
    assert_eq!(lists["slots"][0]["property"], slot["property"]);
    assert!(content(session).contains("DEFAULT ICON"));
    let cycle = router.call(
        session, "component",
        json!({"documentId":document,"action":"slot_insert","id":instance,"slot":"Leading","source":card,"replace":true}),
        Value::Null,
    ).unwrap_err();
    assert!(cycle.message.contains("cycle"));
    assert!(content(session).contains("DEFAULT ICON"));
    let replacement = component(
        "slot_insert",
        json!({"id":instance,"slot":slot["property"],"source":glyph,"replace":true}),
    );
    assert_eq!(replacement["slot"], *projected);
    let after = content(session);
    assert!(after.contains("REPLACEMENT ICON"));
    assert!(!after.contains("DEFAULT ICON"));
    call(session, "save_document", json!({"id":document}));
    let reopened = workspace.session_open(None).unwrap();
    let reopened = reopened["sessionId"].as_str().unwrap();
    call(reopened, "open_document", json!({"id":document}));
    assert_eq!(content(reopened), after);
    let reset = call(
        reopened,
        "component",
        json!({"documentId":document,"action":"slot_reset","id":projected}),
    );
    assert_eq!(reset["changed"], true);
    assert!(content(reopened).contains("DEFAULT ICON"));
    component("slot_remove", json!({"id":slot_frame}));
    assert_eq!(
        component("slot_list", json!({"id":card}))["slots"],
        json!([])
    );
}
