//! Real process termination at the SQL publication boundary, enabled only in a test build.
#![cfg(feature = "fault-injection")]
use omc_engine::{Command, CommandEnvelope, DocumentEngine, RequestContext};
use std::{
    process::{Command as Process, Stdio},
    time::{Duration, Instant},
};

#[test]
#[ignore = "invoked only by the parent fault-injection harness"]
fn crash_child() {
    let path = std::env::var("OMC_TEST_DATABASE").unwrap();
    let envelope: CommandEnvelope = serde_json::from_slice(
        &std::fs::read(std::env::var("OMC_TEST_ENVELOPE").unwrap()).unwrap(),
    )
    .unwrap();
    let mut engine = DocumentEngine::open(path).unwrap();
    engine
        .execute(
            &RequestContext {
                author_id: "fault-author".into(),
                session_id: "fault-session".into(),
            },
            &envelope,
        )
        .unwrap();
    panic!("fault boundary was not reached");
}

#[test]
fn two_hundred_kills_preserve_durable_receipts_and_never_publish_candidates() {
    let directory = tempfile::tempdir().unwrap();
    let points = [
        "before_transaction",
        "after_operations",
        "before_receipt",
        "before_commit",
        "after_commit",
    ];
    for trial in 0..200 {
        let point = points[trial % points.len()];
        let case = directory.path().join(format!("case-{trial}"));
        std::fs::create_dir(&case).unwrap();
        let path = case.join("document.sqlite");
        let engine = DocumentEngine::create(&path, "Original").unwrap();
        let envelope = CommandEnvelope::new(
            engine.metadata().unwrap().id,
            engine.revision().epoch,
            Command::DocumentRename {
                title: format!("committed-{trial}"),
            },
        );
        let input = case.join("envelope.json");
        std::fs::write(&input, serde_json::to_vec(&envelope).unwrap()).unwrap();
        drop(engine);
        let ready = case.join("ready");
        let mut child = Process::new(std::env::current_exe().unwrap())
            .args(["--ignored", "--exact", "crash_child", "--nocapture"])
            .env("OMC_TEST_DATABASE", &path)
            .env("OMC_TEST_ENVELOPE", &input)
            .env("OMC_TEST_FAULT_POINT", point)
            .env("OMC_TEST_FAULT_READY", &ready)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let started = Instant::now();
        while !ready.exists() {
            if let Some(status) = child.try_wait().unwrap() {
                panic!("child exited before {point}: {status}")
            }
            if started.elapsed() > Duration::from_secs(10) {
                child.kill().unwrap();
                child.wait().unwrap();
                panic!("fault boundary timeout: {point}")
            }
            std::thread::sleep(Duration::from_millis(2));
        }
        child.kill().unwrap();
        child.wait().unwrap();
        let mut recovered = DocumentEngine::open(&path).unwrap();
        let committed = point == "after_commit";
        assert_eq!(
            recovered.revision().sequence,
            u64::from(committed),
            "trial {trial}, {point}"
        );
        assert_eq!(
            recovered.metadata().unwrap().title,
            if committed {
                format!("committed-{trial}")
            } else {
                "Original".into()
            }
        );
        let result = recovered
            .execute(
                &RequestContext {
                    author_id: "fault-author".into(),
                    session_id: "resumed-session".into(),
                },
                &envelope,
            )
            .unwrap();
        assert_eq!(result.replayed, committed);
        assert_eq!(recovered.revision().sequence, 1);
        recovered.checkpoint().unwrap();
        drop(recovered);
        assert_eq!(
            DocumentEngine::open(&path)
                .unwrap()
                .metadata()
                .unwrap()
                .title,
            format!("committed-{trial}")
        );
    }
}
