use base64::Engine;
use omc_import::{ImportOptions, import_bytes};
use omc_model::NodeKind;
#[test]
fn schema_generated_fig_is_decoded_by_native_rust() {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(include_str!("fixtures/editable-fig.base64").trim())
        .unwrap();
    let imported = import_bytes("fig", &bytes, &ImportOptions::default()).unwrap();
    assert_eq!(imported.content.pages.len(), 1);
    assert_eq!(imported.content.nodes.len(), 3);
    assert!(
        imported
            .content
            .nodes
            .values()
            .any(|node| node.kind == NodeKind::Text && node.properties["text"] == "Native 😀 한글")
    );
    let rectangle = &imported.content.nodes[&imported.source_map["fig:1:2"]];
    assert_eq!(rectangle.kind, NodeKind::Rect);
    assert_eq!(rectangle.properties["transform"][4], 8.0);
    assert!(imported.diagnostics.is_empty());
    assert!(import_bytes("fig", &bytes[..bytes.len() - 1], &ImportOptions::default()).is_err());
}
