use omc_mcp::ToolRouter;
use omc_workspace::Workspace;
use serde_json::{Value, json};
use std::sync::Arc;

#[test]
fn native_handoff_returns_scoped_code_and_persists_mapping_and_review_links() {
    let profile = tempfile::tempdir().unwrap();
    let workspace = Workspace::open(profile.path(), None).unwrap();
    let router = Arc::new(ToolRouter::new(workspace.clone()));
    let session = || {
        workspace.session_open(None).unwrap()["sessionId"]
            .as_str()
            .unwrap()
            .to_owned()
    };
    let first = session();
    let invoke =
        |session: &str, tool: &str, args| router.call(session, tool, args, Value::Null).unwrap();
    let opened = invoke(
        &first,
        "create_document",
        json!({"title":"Native handoff fixture"}),
    );
    let document = &opened["documentId"];
    let create = |kind, properties: Value, parent: Option<&Value>| {
        let mut args = json!({"documentId":document,"type":kind,"width":160,"height":40,"properties":properties});
        if let Some(parent) = parent {
            args["parentId"] = parent.clone();
        }
        invoke(&first, "create_shape", args)["rawIds"][0].clone()
    };
    let source = create("frame", json!({"name":"Button source"}), None);
    create(
        "text",
        json!({"name":"Label","text":"Default caption"}),
        Some(&source),
    );
    create("text", json!({"text":"Nonselected sibling content"}), None);
    invoke(
        &first,
        "native_tokens",
        json!({"version":"1","documentId":document,"action":"create",
        "name":"outside-only-token","type":"color","value":"#134567"}),
    );
    let component = |action, mut args: Value| {
        args["documentId"] = document.clone();
        args["action"] = json!(action);
        invoke(&first, "component", args)
    };
    let created = component("create", json!({"id":source,"name":"Button"}));
    let main = created["rawIds"][0].clone();
    let label = &created["rawIds"][1];
    let prop = component(
        "bind",
        json!({"id":main,"layer":label,"name":"Label","propertyType":"text"}),
    );
    let instance = component("instance", json!({"source":main}))["rawSelection"][0].clone();
    component(
        "set_property",
        json!({"id":instance,"property":prop["property"]["id"],"value":"Override & ready"}),
    );

    let call = |session: &str, action: &str, mut args: Value| {
        args["version"] = json!("1");
        args["documentId"] = document.clone();
        args["action"] = json!(action);
        if args.get("nodeId").is_none() {
            args["nodeId"] = instance.clone();
        }
        invoke(session, "native_handoff", args)
    };
    let before = call(
        &first,
        "inspect",
        json!({"language":"html","styleKeys":["width"]}),
    );
    let rendered = before["code"]["code"].as_str().unwrap();
    assert!(rendered.contains("Override &amp; ready"), "{rendered}");
    assert!(!rendered.contains("Nonselected sibling content"));
    assert!(!rendered.contains("outside-only-token"));
    assert_eq!(before["nodeId"], instance);
    assert_eq!(before["componentId"], main);
    assert_eq!(before["code"]["sourceId"], instance);
    assert_eq!(before["computedStyle"].as_object().unwrap().len(), 1);
    assert_eq!(before["bounds"][2].as_f64(), Some(160.0));

    let hint = call(
        &first,
        "add_annotation",
        json!({"label":"Check label spacing","properties":["width"],"category":"development"}),
    );
    assert_eq!(hint["receipt"]["status"], "durable");
    call(
        &first,
        "edit_annotation",
        json!({"index":hint["index"],"label":"Ready for review"}),
    );
    let resource = call(
        &first,
        "add_resource",
        json!({"nodeId":main,"url":"https://example.com/spec","name":"Button spec"}),
    );
    assert_eq!(resource["receipt"]["status"], "durable");
    let mapping = call(
        &first,
        "set_mapping",
        json!({"nodeId":main,"language":"react","importPath":"@ui/button",
        "name":"Button","template":"<Button label={Label} />"}),
    );
    assert_eq!(mapping["receipt"]["status"], "durable");

    invoke(&first, "save_document", json!({"id":document}));
    let reader = session();
    invoke(&reader, "open_document", json!({"id":document}));
    let reviewed = call(&reader, "inspect", json!({"language":"react"}));
    let code = &reviewed["code"];
    assert_eq!(code["connected"], true);
    assert_eq!(code["sourceId"], main);
    let snippet = code["code"].as_str().unwrap();
    assert!(snippet.contains("@ui/button"));
    assert!(
        snippet.contains("<Button label=\"Override &amp; ready\" />"),
        "{snippet}"
    );
    assert!(!snippet.contains("Nonselected sibling content"));
    assert_eq!(reviewed["annotations"][0]["label"], "Ready for review");
    assert_eq!(reviewed["resources"][0]["sourceId"], main);

    let other = invoke(&reader, "create_document", json!({"title":"Other file"}));
    let invalid = router.call(&reader, "native_handoff",
        json!({"version":"1","action":"inspect","documentId":other["documentId"],"nodeId":instance}), Value::Null);
    assert_eq!(invalid.unwrap_err().code, "invalid_argument");
    call(
        &first,
        "remove_mapping",
        json!({"nodeId":main,"language":"react"}),
    );
    call(
        &first,
        "remove_resource",
        json!({"nodeId":main,"index":resource["index"]}),
    );
    let removed = call(&reader, "inspect", json!({"language":"react"}));
    assert_eq!(removed["code"]["connected"], false);
    assert_eq!(removed["resources"], json!([]));
}
