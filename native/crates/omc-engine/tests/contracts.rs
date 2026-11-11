use omc_engine::{Command, CommandEnvelope, DocumentEngine, Preconditions, RequestContext};
use omc_model::{DocumentContent, Node, NodeKind, Properties};
use serde_json::{Value, json};

fn context(author: &str) -> RequestContext {
    RequestContext {
        author_id: author.into(),
        session_id: format!("session-{author}"),
    }
}
fn command(engine: &DocumentEngine, command: Command) -> CommandEnvelope {
    CommandEnvelope::new(
        engine.metadata().unwrap().id,
        engine.revision().epoch,
        command,
    )
}
fn content() -> (DocumentContent, String, String) {
    let mut content = DocumentContent::empty("Tests");
    let root = content.pages[0].root_node_id.clone();
    let mut rect = Node::new(NodeKind::Rect);
    rect.parent_id = Some(root.clone());
    rect.properties.insert("x".into(), 0.into());
    let rect_id = rect.id.clone();
    content.nodes.insert(rect.id.clone(), rect);
    let mut text = Node::new(NodeKind::Text);
    text.parent_id = Some(root);
    text.properties.insert("text".into(), "abc😀".into());
    let text_id = text.id.clone();
    content.nodes.insert(text.id.clone(), text);
    (content, rect_id, text_id)
}
fn set(id: &str, key: &str, value: Value) -> Command {
    Command::NodeSet {
        node_id: id.into(),
        properties: [(key.into(), value)].into(),
    }
}

#[test]
fn durable_receipt_replays_after_restart_and_epoch_checks_precede_replay() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("document.sqlite");
    let (content, id, _) = content();
    let mut engine = DocumentEngine::create_from_content(&path, content).unwrap();
    let mut envelope = command(&engine, set(&id, "x", 5.into()));
    let author = context("agent-a");
    let first = engine.execute(&author, &envelope).unwrap();
    assert_eq!(first.status, "durable");
    drop(engine);
    let mut engine = DocumentEngine::open(&path).unwrap();
    envelope.request_id = "retry-after-lost-response".into();
    let replay = engine.execute(&author, &envelope).unwrap();
    assert!(replay.replayed);
    assert_eq!(replay.transaction_id, first.transaction_id);
    assert_eq!(engine.revision().sequence, 1);
    let mut changed = envelope.clone();
    changed.command = set(&id, "x", 6.into());
    assert_eq!(
        engine.execute(&author, &changed).unwrap_err().code,
        "idempotency_conflict"
    );
    envelope.target_epoch = uuid::Uuid::new_v4().to_string();
    assert_eq!(
        engine.execute(&author, &envelope).unwrap_err().code,
        "epoch_mismatch"
    );
    assert_eq!(engine.node(&id).unwrap().unwrap().properties["x"], 5);
    assert_eq!(engine.sqlite_info().unwrap()["synchronous"], "full");
}

#[test]
fn batch_uses_overlay_and_late_failure_is_atomic() {
    let directory = tempfile::tempdir().unwrap();
    let mut engine = DocumentEngine::create(directory.path().join("d.sqlite"), "test").unwrap();
    let root = engine.context().unwrap().pages[0].root_node_id.clone();
    let mut node = Node::new(NodeKind::Rect);
    node.parent_id = Some(root);
    let bad = command(
        &engine,
        Command::Batch {
            commands: vec![
                Command::NodeCreate { node: node.clone() },
                set("node_00000000000000000000000000000000", "x", 3.into()),
            ],
        },
    );
    assert!(engine.execute(&context("a"), &bad).is_err());
    assert!(engine.node(&node.id).unwrap().is_none());
    assert_eq!(engine.revision().sequence, 0);
    let good = command(
        &engine,
        Command::Batch {
            commands: vec![
                Command::NodeCreate { node: node.clone() },
                set(&node.id, "x", 9.into()),
            ],
        },
    );
    engine.execute(&context("a"), &good).unwrap();
    assert_eq!(engine.revision().sequence, 1);
    assert_eq!(engine.node(&node.id).unwrap().unwrap().properties["x"], 9);
}

#[test]
fn undo_retracts_only_own_assignments_and_redo_has_new_identity() {
    let directory = tempfile::tempdir().unwrap();
    let (content, id, _) = content();
    let mut engine =
        DocumentEngine::create_from_content(directory.path().join("d.sqlite"), content).unwrap();
    engine
        .execute(&context("a"), &command(&engine, set(&id, "x", 1.into())))
        .unwrap();
    engine
        .execute(&context("b"), &command(&engine, set(&id, "x", 2.into())))
        .unwrap();
    engine
        .execute(&context("a"), &command(&engine, Command::Undo))
        .unwrap();
    assert_eq!(engine.node(&id).unwrap().unwrap().properties["x"], 2);
    engine
        .execute(&context("a"), &command(&engine, Command::Redo))
        .unwrap();
    assert_eq!(engine.node(&id).unwrap().unwrap().properties["x"], 1);
    assert_eq!(engine.export_transactions(0).unwrap().len(), 4);
}

#[test]
fn stale_field_dependency_rejects_but_unrelated_edit_does_not() {
    let directory = tempfile::tempdir().unwrap();
    let (content, id, _) = content();
    let mut engine =
        DocumentEngine::create_from_content(directory.path().join("d.sqlite"), content).unwrap();
    let mut pending = command(&engine, set(&id, "x", 4.into()));
    pending.preconditions = Preconditions::Dependencies {
        fields: vec![omc_protocol::FieldPrecondition {
            entity_id: id.clone(),
            field: "x".into(),
            version: engine.field_version(&id, "x").unwrap(),
        }],
    };
    engine
        .execute(
            &context("b"),
            &command(&engine, set(&id, "fill", "blue".into())),
        )
        .unwrap();
    engine.execute(&context("a"), &pending).unwrap();
    pending.idempotency_key = uuid::Uuid::new_v4().to_string();
    assert_eq!(
        engine.execute(&context("a"), &pending).unwrap_err().code,
        "conflict"
    );
}

#[test]
fn pagination_keeps_a_revision_after_mutation() {
    let directory = tempfile::tempdir().unwrap();
    let (content, id, _) = content();
    let mut engine =
        DocumentEngine::create_from_content(directory.path().join("d.sqlite"), content).unwrap();
    let revision = engine.revision();
    let first = engine.query_nodes_at(&revision, None, 1).unwrap();
    assert!(first.next_after.is_some());
    engine
        .execute(&context("a"), &command(&engine, set(&id, "x", 99.into())))
        .unwrap();
    let old = engine.snapshot_at(revision.sequence).unwrap();
    assert_eq!(old.nodes[&id].properties["x"], 0);
    assert_eq!(engine.snapshot().unwrap().nodes[&id].properties["x"], 99);
    let second = engine
        .query_nodes_at(&revision, first.next_after.as_deref(), 5)
        .unwrap();
    assert_eq!(second.revision, revision);
    assert_eq!(second.nodes.len(), 2);
}

#[test]
fn four_independent_replicas_converge_under_reordered_duplicate_transactions() {
    let directory = tempfile::tempdir().unwrap();
    let (content, id, text) = content();
    let seed =
        DocumentEngine::create_from_content(directory.path().join("seed.sqlite"), content).unwrap();
    let package = seed.replica_package().unwrap();
    let mut engines: Vec<_> = (0..4)
        .map(|i| {
            DocumentEngine::fork_replica(
                directory.path().join(format!("r{i}.sqlite")),
                package.clone(),
            )
            .unwrap()
        })
        .collect();
    let mut transactions = Vec::new();
    for (i, engine) in engines.iter_mut().enumerate() {
        let author = context(&format!("author-{i}"));
        engine
            .execute(
                &author,
                &command(engine, set(&id, &format!("custom{i}"), (i as u64).into())),
            )
            .unwrap();
        engine
            .execute(
                &author,
                &command(
                    engine,
                    Command::TextInsert {
                        node_id: text.clone(),
                        offset: 3,
                        text: char::from(b'A' + i as u8).to_string(),
                        attributes: Properties::new(),
                    },
                ),
            )
            .unwrap();
        transactions.extend(engine.export_transactions(0).unwrap());
    }
    for engine in &mut engines {
        for tx in transactions.iter().rev().chain(transactions.iter()) {
            engine.receive_transaction(tx.clone()).unwrap();
        }
    }
    let expected = engines[0].snapshot().unwrap().content();
    for engine in &engines {
        assert_eq!(engine.snapshot().unwrap().content(), expected);
        assert_eq!(engine.frontiers().unwrap().len(), 4);
    }
    for i in 0..4 {
        assert_eq!(
            expected.nodes[&id].properties[&format!("custom{i}")],
            i as u64
        );
    }
    assert_eq!(
        expected.nodes[&text]
            .string("text")
            .unwrap()
            .chars()
            .count(),
        8
    );
}

#[test]
fn stable_composition_selection_preserves_foreign_insert() {
    let directory = tempfile::tempdir().unwrap();
    let (content, _, text) = content();
    let mut a =
        DocumentEngine::create_from_content(directory.path().join("a.sqlite"), content).unwrap();
    let mut b = DocumentEngine::fork_replica(
        directory.path().join("b.sqlite"),
        a.replica_package().unwrap(),
    )
    .unwrap();
    let selection = a.text_selection(&text, 0, 3).unwrap();
    b.execute(
        &context("b"),
        &command(
            &b,
            Command::TextInsert {
                node_id: text.clone(),
                offset: 1,
                text: "X".into(),
                attributes: Properties::new(),
            },
        ),
    )
    .unwrap();
    for transaction in b.export_transactions(0).unwrap() {
        a.receive_transaction(transaction).unwrap();
    }
    a.execute(
        &context("a"),
        &command(
            &a,
            Command::TextSplice {
                selection,
                text: "한".into(),
                attributes: Properties::new(),
            },
        ),
    )
    .unwrap();
    let actual = a.node(&text).unwrap().unwrap().properties["text"]
        .as_str()
        .unwrap()
        .to_string();
    assert!(actual.contains('X'));
    assert!(actual.contains('한'));
    assert!(actual.contains('😀'));
    assert!(!actual.contains('a'));
    a.execute(&context("a"), &command(&a, Command::Undo))
        .unwrap();
    assert_eq!(a.node(&text).unwrap().unwrap().properties["text"], "aXbc😀");
}

#[test]
fn utf16_boundary_and_destructive_replace_require_intent() {
    let directory = tempfile::tempdir().unwrap();
    let (content, _, text) = content();
    let mut engine =
        DocumentEngine::create_from_content(directory.path().join("d.sqlite"), content).unwrap();
    let bad = command(
        &engine,
        Command::TextDelete {
            node_id: text.clone(),
            start: 4,
            end: 5,
        },
    );
    assert_eq!(
        engine.execute(&context("a"), &bad).unwrap_err().code,
        "invalid_argument"
    );
    let mut replace = command(
        &engine,
        Command::TextReplace {
            node_id: text.clone(),
            text: "new".into(),
        },
    );
    assert!(engine.execute(&context("a"), &replace).is_err());
    replace.preconditions = Preconditions::Revision {
        revision: engine.revision(),
    };
    engine.execute(&context("a"), &replace).unwrap();
    assert_eq!(
        engine.node(&text).unwrap().unwrap().properties["text"],
        "new"
    );
}

#[test]
fn fragment_staging_survives_restart_without_partial_publication() {
    let directory = tempfile::tempdir().unwrap();
    let (content, id, _) = content();
    let mut a =
        DocumentEngine::create_from_content(directory.path().join("a.sqlite"), content).unwrap();
    let bpath = directory.path().join("b.sqlite");
    let mut b = DocumentEngine::fork_replica(&bpath, a.replica_package().unwrap()).unwrap();
    a.execute(
        &context("a"),
        &command(&a, set(&id, "notes", Value::String("z".repeat(600_000)))),
    )
    .unwrap();
    let transaction = a.export_transactions(0).unwrap().remove(0);
    let (header, fragments) = omc_sync::split_transaction(&transaction).unwrap();
    assert!(fragments.len() > 2);
    b.receive_fragment(header.clone(), 2, fragments[2].clone())
        .unwrap();
    b.receive_fragment(header.clone(), 0, fragments[0].clone())
        .unwrap();
    assert_eq!(b.revision().sequence, 0);
    drop(b);
    let mut b = DocumentEngine::open(&bpath).unwrap();
    let result = b.receive_fragment(header, 1, fragments[1].clone()).unwrap();
    assert_eq!(result.status, "applied");
    assert_eq!(
        b.node(&id).unwrap().unwrap().properties["notes"]
            .as_str()
            .unwrap()
            .len(),
        600_000
    );
}

#[test]
fn concurrent_cycles_have_identical_recovery_projection() {
    let directory = tempfile::tempdir().unwrap();
    let (mut content, a_id, _) = content();
    let root = content.pages[0].root_node_id.clone();
    let mut bnode = Node::new(NodeKind::Group);
    bnode.parent_id = Some(root);
    let b_id = bnode.id.clone();
    content.nodes.insert(b_id.clone(), bnode);
    let mut a =
        DocumentEngine::create_from_content(directory.path().join("a.sqlite"), content).unwrap();
    let mut b = DocumentEngine::fork_replica(
        directory.path().join("b.sqlite"),
        a.replica_package().unwrap(),
    )
    .unwrap();
    a.execute(
        &context("a"),
        &command(
            &a,
            Command::NodeMove {
                node_id: a_id.clone(),
                parent_id: Some(b_id.clone()),
                rank: omc_model::initial_rank(),
            },
        ),
    )
    .unwrap();
    b.execute(
        &context("b"),
        &command(
            &b,
            Command::NodeMove {
                node_id: b_id,
                parent_id: Some(a_id),
                rank: omc_model::initial_rank(),
            },
        ),
    )
    .unwrap();
    let a_tx = a.export_transactions(0).unwrap();
    let b_tx = b.export_transactions(0).unwrap();
    for tx in b_tx {
        a.receive_transaction(tx).unwrap();
    }
    for tx in a_tx {
        b.receive_transaction(tx).unwrap();
    }
    assert_eq!(
        a.snapshot().unwrap().content(),
        b.snapshot().unwrap().content()
    );
    assert_eq!(
        a.snapshot().unwrap().metadata["containmentDiagnostics"]["code"],
        "containment_repaired"
    );
}

#[test]
fn two_deletes_and_one_undo_do_not_resurrect_foreign_tombstone() {
    let directory = tempfile::tempdir().unwrap();
    let (content, id, _) = content();
    let mut a =
        DocumentEngine::create_from_content(directory.path().join("a.sqlite"), content).unwrap();
    let mut b = DocumentEngine::fork_replica(
        directory.path().join("b.sqlite"),
        a.replica_package().unwrap(),
    )
    .unwrap();
    for (engine, author) in [(&mut a, "a"), (&mut b, "b")] {
        engine
            .execute(
                &context(author),
                &command(
                    engine,
                    Command::NodeDelete {
                        node_ids: vec![id.clone()],
                    },
                ),
            )
            .unwrap();
    }
    let a_tx = a.export_transactions(0).unwrap();
    let b_tx = b.export_transactions(0).unwrap();
    for tx in b_tx {
        a.receive_transaction(tx).unwrap();
    }
    for tx in a_tx {
        b.receive_transaction(tx).unwrap();
    }
    a.execute(&context("a"), &command(&a, Command::Undo))
        .unwrap();
    assert!(a.node(&id).unwrap().is_none());
    for tx in a.export_transactions(2).unwrap() {
        b.receive_transaction(tx).unwrap();
    }
    assert!(b.node(&id).unwrap().is_none());
}

#[test]
fn retraction_cannot_impersonate_another_author() {
    let directory = tempfile::tempdir().unwrap();
    let (content, id, _) = content();
    let mut a =
        DocumentEngine::create_from_content(directory.path().join("a.sqlite"), content).unwrap();
    a.execute(&context("a"), &command(&a, set(&id, "x", 1.into())))
        .unwrap();
    let package = a.replica_package().unwrap();
    let mut b =
        DocumentEngine::fork_replica(directory.path().join("b.sqlite"), package.clone()).unwrap();
    let mut forged = package.transactions[0].clone();
    forged.transaction_id = uuid::Uuid::new_v4().to_string();
    forged.replica_id = b.metadata().unwrap().replica_id;
    forged.dependencies = a.frontiers().unwrap();
    forged.dependencies.insert(forged.replica_id.clone(), 0);
    forged.counter = 1;
    forged.lamport = 2;
    forged.author_id = "b".into();
    let stamp = omc_sync::Stamp {
        lamport: 2,
        replica_id: forged.replica_id.clone(),
        counter: 1,
    };
    forged.operations = vec![omc_sync::Operation {
        id: stamp.operation_id(),
        stamp,
        author_id: "b".into(),
        action: omc_sync::Action::Retract {
            entity_id: id.clone(),
            operation_id: package.transactions[0].operations[0].id.clone(),
        },
    }];
    assert_eq!(
        a.receive_transaction(forged).unwrap_err().code,
        "authentication_failed"
    );
    assert_eq!(a.node(&id).unwrap().unwrap().properties["x"], 1);
    // The other replica remains independently editable after a rejected attack on A.
    b.execute(
        &context("b"),
        &command(&b, set(&id, "fill", json!("green"))),
    )
    .unwrap();
    // Rejected remote input cannot poison subsequent unrelated local or peer work.
    a.execute(&context("a"), &command(&a, set(&id, "fill", json!("blue"))))
        .unwrap();
}

#[test]
fn rank_rebalance_does_not_overwrite_a_concurrent_move() {
    let directory = tempfile::tempdir().unwrap();
    let (mut content, id, _) = content();
    let root = content.pages[0].root_node_id.clone();
    let mut destination = Node::new(NodeKind::Group);
    destination.parent_id = Some(root.clone());
    let destination_id = destination.id.clone();
    content.nodes.insert(destination.id.clone(), destination);
    let mut a =
        DocumentEngine::create_from_content(directory.path().join("a.sqlite"), content).unwrap();
    let mut b = DocumentEngine::fork_replica(
        directory.path().join("b.sqlite"),
        a.replica_package().unwrap(),
    )
    .unwrap();
    let old_version = a.field_version(&id, "placement").unwrap();
    a.execute(
        &context("a"),
        &command(&a, Command::NodeRebalance { parent_id: root }),
    )
    .unwrap();
    assert_ne!(a.field_version(&id, "placement").unwrap(), old_version);
    b.execute(
        &context("b"),
        &command(
            &b,
            Command::NodeMove {
                node_id: id.clone(),
                parent_id: Some(destination_id.clone()),
                rank: "00000000000000000000000000000012".into(),
            },
        ),
    )
    .unwrap();
    let a_tx = a.export_transactions(0).unwrap();
    let b_tx = b.export_transactions(0).unwrap();
    for tx in b_tx {
        a.receive_transaction(tx).unwrap();
    }
    for tx in a_tx {
        b.receive_transaction(tx).unwrap();
    }
    assert_eq!(
        a.snapshot().unwrap().content(),
        b.snapshot().unwrap().content()
    );
    let moved = a.node(&id).unwrap().unwrap();
    assert_eq!(moved.parent_id, Some(destination_id));
    assert_eq!(moved.rank, "00000000000000000000000000000012");
}

#[test]
fn redo_creation_preserves_independent_foreign_properties() {
    let directory = tempfile::tempdir().unwrap();
    let mut engine = DocumentEngine::create(directory.path().join("d.sqlite"), "test").unwrap();
    let mut node = Node::new(NodeKind::Rect);
    node.parent_id = Some(engine.context().unwrap().pages[0].root_node_id.clone());
    engine
        .execute(
            &context("a"),
            &command(&engine, Command::NodeCreate { node: node.clone() }),
        )
        .unwrap();
    engine
        .execute(
            &context("b"),
            &command(&engine, set(&node.id, "fill", json!("red"))),
        )
        .unwrap();
    engine
        .execute(&context("a"), &command(&engine, Command::Undo))
        .unwrap();
    assert!(engine.node(&node.id).unwrap().is_none());
    engine
        .execute(&context("a"), &command(&engine, Command::Redo))
        .unwrap();
    assert_eq!(
        engine.node(&node.id).unwrap().unwrap().properties["fill"],
        "red"
    );
}

#[test]
fn comments_have_independent_attributed_history() {
    let directory = tempfile::tempdir().unwrap();
    let (content, id, _) = content();
    let mut engine =
        DocumentEngine::create_from_content(directory.path().join("d.sqlite"), content).unwrap();
    engine
        .execute(&context("a"), &command(&engine, set(&id, "x", 7.into())))
        .unwrap();
    let comment = omc_model::new_id("comment");
    let write = Command::CatalogSet {
        namespace: "comments".into(),
        entity_id: comment.clone(),
        properties: [("body".into(), "hello".into())].into(),
    };
    engine
        .execute(&context("a"), &command(&engine, write))
        .unwrap();
    engine
        .execute(&context("a"), &command(&engine, Command::Undo))
        .unwrap();
    assert_eq!(engine.node(&id).unwrap().unwrap().properties["x"], 0);
    assert_eq!(
        engine.snapshot().unwrap().metadata[&format!("comments/{comment}/body")],
        "hello"
    );
    let impersonation = Command::CatalogSet {
        namespace: "comments".into(),
        entity_id: comment.clone(),
        properties: [("body".into(), "forged".into())].into(),
    };
    assert_eq!(
        engine
            .execute(&context("b"), &command(&engine, impersonation))
            .unwrap_err()
            .code,
        "authentication_failed"
    );
    engine
        .execute(
            &context("a"),
            &command(
                &engine,
                Command::HistoryUndo {
                    channel: omc_engine::HistoryChannel::Comments,
                },
            ),
        )
        .unwrap();
    assert!(
        !engine
            .snapshot()
            .unwrap()
            .metadata
            .contains_key(&format!("comments/{comment}/body"))
    );
    engine
        .execute(
            &context("a"),
            &command(
                &engine,
                Command::HistoryRedo {
                    channel: omc_engine::HistoryChannel::Comments,
                },
            ),
        )
        .unwrap();
    assert_eq!(
        engine.snapshot().unwrap().metadata[&format!("comments/{comment}/body")],
        "hello"
    );
}
