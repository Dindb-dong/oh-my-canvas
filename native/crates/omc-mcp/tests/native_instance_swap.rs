use omc_mcp::ToolRouter;
use omc_workspace::Workspace;
use serde_json::{Value, json};
use std::sync::Arc;

#[test]
fn swaps_rendered_definitions_and_preserves_matching_typed_overrides() {
    let profile = tempfile::tempdir().unwrap();
    let workspace = Workspace::open(profile.path(), None).unwrap();
    let router = Arc::new(ToolRouter::new(workspace.clone()));
    let session = workspace.session_open(None).unwrap();
    let session = session["sessionId"].as_str().unwrap();
    let call = |tool, args| router.call(session, tool, args, Value::Null).unwrap();
    let document = call("create_document", json!({"title":"Native swapping"}));
    let document = &document["documentId"];
    let component = |action, mut args: Value| {
        args["documentId"] = document.clone();
        args["action"] = json!(action);
        call("component", args)
    };
    let create = |name, badge, with_property| {
        let frame = call(
            "create_shape",
            json!({"documentId":document,"type":"frame","width":240,"height":80}),
        );
        let definition = component("create", json!({"id":frame["rawIds"][0],"name":name}));
        let definition = definition["rawIds"][0].clone();
        call(
            "create_shape",
            json!({"documentId":document,"parentId":definition,"type":"text","y":30,"width":230,"height":24,"properties":{"text":badge}}),
        );
        let mut property = Value::Null;
        if with_property {
            let label = call(
                "create_shape",
                json!({"documentId":document,"parentId":definition,"type":"text","width":230,"height":24,"properties":{"text":"DEFAULT LABEL"}}),
            );
            property = component(
                "bind",
                json!({"id":definition,"layer":label["rawIds"][0],"name":"Label","propertyType":"text"}),
            )["property"]["id"].clone();
            assert!(property.is_string());
        }
        (definition, property)
    };
    let (original, property) = create("Original", "ORIGINAL BADGE", true);
    let (replacement, new_property) = create("Replacement", "REPLACEMENT BADGE", true);
    assert_ne!(property, new_property);
    let (incompatible, _) = create("Incompatible", "INCOMPATIBLE BADGE", false);
    let instance = component("instance", json!({"source":original}));
    let instance = &instance["rawIds"][0];
    component(
        "set_property",
        json!({"id":instance,"property":property,"value":"CUSTOM LABEL"}),
    );
    let render = || {
        call(
            "export_selection",
            json!({"documentId":document,"ids":[instance],"format":"svg"}),
        )["content"]
            .as_str()
            .unwrap()
            .to_owned()
    };
    let first = render();
    assert!(first.contains("ORIGINAL BADGE"));
    assert!(first.contains("CUSTOM LABEL"));
    let reject = |id, source| {
        router
            .call(
                session,
                "component",
                json!({"documentId":document,"action":"swap","id":id,"source":source}),
                Value::Null,
            )
            .unwrap_err()
    };
    assert_eq!(reject(instance, &incompatible).code, "conflict");
    assert_eq!(render(), first);
    component("swap", json!({"id":instance,"source":replacement}));
    let second = render();
    assert!(second.contains("REPLACEMENT BADGE"));
    assert!(second.contains("CUSTOM LABEL"));
    assert!(!second.contains("ORIGINAL BADGE"));
    let native = format!("doc_{}", document.as_str().unwrap().replace('-', ""));
    let snapshot = workspace.snapshot(&native).unwrap();
    let stored = &snapshot.nodes[instance.as_str().unwrap()];
    assert_eq!(stored.string("componentId"), replacement.as_str());
    assert_eq!(
        stored.properties["componentProperties"][new_property.as_str().unwrap()],
        "CUSTOM LABEL"
    );

    let nested = component("instance", json!({"source":incompatible,"parent":original}));
    let nested = &nested["rawIds"][0];
    assert!(reject(nested, &original).message.contains("cycle"));
    assert_eq!(render(), second);
}
