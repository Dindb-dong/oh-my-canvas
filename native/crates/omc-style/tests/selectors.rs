use omc_model::{DocumentContent, DocumentSnapshot, Node, NodeKind};
use omc_style::compute_styles;
use serde_json::json;

fn document(css: &str) -> DocumentSnapshot {
    let content = DocumentContent::empty("Selector regression");
    DocumentSnapshot {
        id: "doc_00000000000000000000000000000001".into(),
        title: content.title,
        epoch: "test".into(),
        sequence: 0,
        pages: content.pages,
        nodes: content.nodes,
        metadata: [("css".into(), json!(css))].into(),
    }
}

#[test]
fn quoted_attribute_values_do_not_inflate_specificity() {
    let mut snapshot = document(
        r##"
            #chosen { height: 30px; }
            [data-note="ready#tag.thing:next"] { width: 10px; height: 10px; }
            [data-label='one ] > [ "two"'] { left: 11px; }
            .card { width: 20px; }
        "##,
    );
    let mut node = Node::new(NodeKind::Rect);
    node.parent_id = Some(snapshot.pages[0].root_node_id.clone());
    node.properties.extend([
        ("class".into(), json!("card")),
        ("htmlId".into(), json!("chosen")),
        (
            "attributes".into(),
            json!({
                "data-note": "ready#tag.thing:next",
                "data-label": "one ] > [ \"two\"",
            }),
        ),
    ]);
    let id = node.id.clone();
    snapshot.nodes.insert(id.clone(), node);

    let styles = compute_styles(&snapshot, (800., 600.));
    let style = &styles[&id];
    assert_eq!(style.get("height"), Some("30px"));
    assert_eq!(style.get("width"), Some("20px"));
    assert_eq!(style.get("left"), Some("11px"));
    assert!(style.diagnostics.is_empty());
}

#[test]
fn nth_child_uses_ranked_siblings_and_rejects_invalid_formulas() {
    let mut snapshot = document(
        r"
            div > li:nth-child(2n + 1) { width: 17px; }
            li:nth-child(-2n+5) { height: 19px; }
            li:nth-child(-n+3) { left: 11px; }
            li:nth-child(0n+4) { top: 12px; }
            li:nth-child(+N - 2) { margin-left: 2px; }
            li:first-child { padding-top: 3px; }
            li:last-child { padding-bottom: 4px; }
            li:nth-child(-1), li:nth-child(0) { color: red; }
            li:nth-child(2 n+1), li:nth-child(n 1), li:nth-child(n+-1),
            li:nth-child(2147483648n), li:nth-child(n + 2147483648),
            div >> li, li > { opacity: 0; }
        ",
    );
    let parent = snapshot.pages[0].root_node_id.clone();
    let mut ids = Vec::new();
    for rank in (1u32..=6).rev() {
        let mut node = Node::new(NodeKind::Rect);
        node.id = format!("node_{rank:032x}");
        node.parent_id = Some(parent.clone());
        node.rank = format!("{:032x}", rank.div_ceil(2));
        node.properties.insert("tag".into(), json!("li"));
        ids.push((rank, node.id.clone()));
        snapshot.nodes.insert(node.id.clone(), node);
    }

    let styles = compute_styles(&snapshot, (800., 600.));
    for (index, id) in ids {
        let style = &styles[&id];
        assert_eq!(style.get("width"), (index % 2 == 1).then_some("17px"));
        assert_eq!(style.get("height"), (index % 2 == 1).then_some("19px"));
        assert_eq!(style.get("left"), (index <= 3).then_some("11px"));
        assert_eq!(style.get("top"), (index == 4).then_some("12px"));
        assert_eq!(style.get("margin-left"), Some("2px"));
        assert_eq!(style.get("padding-top"), (index == 1).then_some("3px"));
        assert_eq!(style.get("padding-bottom"), (index == 6).then_some("4px"));
        assert_eq!(style.get("color"), None);
        assert_eq!(style.get("opacity"), None);
        assert_eq!(
            style
                .diagnostics
                .iter()
                .filter(|diagnostic| diagnostic.property.as_deref() == Some("selector"))
                .count(),
            7,
        );
    }
}
