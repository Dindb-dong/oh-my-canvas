use omc_model::{Node, NodeKind, Properties};
use omc_sync::{Action, NodeState, Operation, Stamp};

fn op(replica: u128, counter: u64, lamport: u64, action: Action) -> Operation {
    let stamp = Stamp {
        lamport,
        replica_id: uuid::Uuid::from_u128(replica).to_string(),
        counter,
    };
    Operation {
        id: stamp.operation_id(),
        author_id: format!("author-{replica}"),
        stamp,
        action,
    }
}
fn run(text: &str, mode: u8) {
    let mut node = Node::new(NodeKind::Text);
    node.id = "node_11111111111141118111111111111111".into();
    node.properties.insert("text".into(), text.into());
    let base = NodeState::seeded(node.clone());
    let view = base.text_view().unwrap();
    let selection = view
        .selection(&node.id, 0, text.encode_utf16().count() as u32)
        .unwrap();
    let first = view.items[0].id.clone();
    let insert = |replica, value: &str, after: Option<String>| {
        op(
            replica,
            1,
            1,
            Action::TextInsert {
                node_id: node.id.clone(),
                after,
                text: value.into(),
                attributes: Properties::new(),
            },
        )
    };
    match mode {
        0 => {
            let a = insert(1, "A", None);
            let b = insert(2, "B", None);
            for events in [[a.clone(), b.clone()], [b, a]] {
                let mut state = base.clone();
                for event in events {
                    state.apply(event).unwrap();
                }
                assert_eq!(state.text_view().unwrap().text, format!("BA{text}"));
            }
        }
        1 => {
            let a = op(
                1,
                1,
                1,
                Action::TextDelete {
                    node_id: node.id.clone(),
                    items: selection.observed_items,
                },
            );
            let b = insert(2, "X", Some(first));
            for events in [[a.clone(), b.clone()], [b, a]] {
                let mut state = base.clone();
                for event in events {
                    state.apply(event).unwrap();
                }
                assert_eq!(state.text_view().unwrap().text, "X");
            }
        }
        2 => {
            let a = op(
                1,
                1,
                1,
                Action::TextMark {
                    node_id: node.id.clone(),
                    items: selection.observed_items.clone(),
                    attributes: [("bold".into(), true.into()), ("fill".into(), "red".into())]
                        .into(),
                },
            );
            let b = op(
                2,
                1,
                1,
                Action::TextMark {
                    node_id: node.id.clone(),
                    items: selection.observed_items,
                    attributes: [
                        ("italic".into(), true.into()),
                        ("fill".into(), "blue".into()),
                    ]
                    .into(),
                },
            );
            for events in [[a.clone(), b.clone()], [b, a]] {
                let mut state = base.clone();
                for event in events {
                    state.apply(event).unwrap();
                }
                let view = state.text_view().unwrap();
                assert_eq!(view.text, text);
                for item in view.items {
                    assert_eq!(item.attributes["bold"], true);
                    assert_eq!(item.attributes["italic"], true);
                    assert_eq!(item.attributes["fill"], "blue");
                }
            }
        }
        3 => {
            let a = op(
                1,
                1,
                1,
                Action::TextDelete {
                    node_id: node.id.clone(),
                    items: selection.observed_items,
                },
            );
            let b = insert(2, "X", Some(first));
            let undo = op(
                1,
                2,
                2,
                Action::Retract {
                    entity_id: node.id.clone(),
                    operation_id: a.id.clone(),
                },
            );
            let first = text.chars().next().unwrap();
            let expected = format!("{first}X{}", text.chars().skip(1).collect::<String>());
            for events in [
                [a.clone(), b.clone(), undo.clone()],
                [b.clone(), a.clone(), undo.clone()],
                [a, undo, b],
            ] {
                let mut state = base.clone();
                for event in events {
                    state.apply(event).unwrap();
                }
                assert_eq!(state.text_view().unwrap().text, expected);
            }
        }
        _ => unreachable!(),
    }
}

macro_rules! case {
    ($name:ident,$text:expr,$mode:expr) => {
        #[test]
        fn $name() {
            run($text, $mode)
        }
    };
}
case!(ascii_same_gap, "ab", 0);
case!(ascii_observed_delete, "ab", 1);
case!(ascii_marks, "ab", 2);
case!(ascii_delete_undo, "ab", 3);
case!(emoji_same_gap, "a😀b", 0);
case!(emoji_observed_delete, "a😀b", 1);
case!(emoji_marks, "a😀b", 2);
case!(emoji_delete_undo, "a😀b", 3);
case!(hangul_same_gap, "한글", 0);
case!(hangul_observed_delete, "한글", 1);
case!(hangul_marks, "한글", 2);
case!(hangul_delete_undo, "한글", 3);
case!(combining_same_gap, "e\u{301}x", 0);
case!(combining_observed_delete, "e\u{301}x", 1);
case!(combining_marks, "e\u{301}x", 2);
case!(combining_delete_undo, "e\u{301}x", 3);
case!(zwj_same_gap, "👩\u{200d}💻x", 0);
case!(zwj_observed_delete, "👩\u{200d}💻x", 1);
case!(zwj_marks, "👩\u{200d}💻x", 2);
case!(zwj_delete_undo, "👩\u{200d}💻x", 3);
case!(bidi_paragraph_same_gap, "אב\ncd", 0);
case!(bidi_paragraph_observed_delete, "אב\ncd", 1);
case!(bidi_paragraph_marks, "אב\ncd", 2);
case!(bidi_paragraph_delete_undo, "אב\ncd", 3);
