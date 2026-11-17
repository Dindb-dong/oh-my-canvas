use base64::Engine;
use omc_mcp::ToolRouter;
use omc_workspace::Workspace;
use serde_json::{Value, json};
use std::{
    io::Write,
    path::Path,
    sync::Arc,
    time::{Duration, Instant},
};

fn fixture(path: &Path, valid: bool) {
    let canvas = base64::engine::general_purpose::STANDARD
        .decode(include_str!("../../omc-import/tests/fixtures/editable-fig.base64").trim())
        .unwrap();
    let mut zip = zip::ZipWriter::new(std::fs::File::create(path).unwrap());
    let options =
        zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    zip.start_file("canvas.fig", options).unwrap();
    zip.write_all(if valid { &canvas } else { b"invalid FIG" })
        .unwrap();
    zip.start_file("images/unused", options).unwrap();
    for _ in 0..80 {
        zip.write_all(&[0; 64 * 1024]).unwrap();
    }
    zip.finish().unwrap();
}
fn wait(workspace: &Workspace, session: &str, ticket: &Value) -> Value {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let status = workspace
            .jobs
            .status(session, ticket["jobId"].as_str().unwrap())
            .unwrap();
        if matches!(
            status["state"].as_str(),
            Some("completed" | "failed" | "cancelled")
        ) {
            return status;
        }
        assert!(
            Instant::now() < deadline,
            "FIG job did not terminate: {status}"
        );
        std::thread::sleep(Duration::from_millis(2));
    }
}

#[test]
fn fig_file_jobs_publish_only_valid_candidates_through_both_entry_points() {
    let dir = tempfile::tempdir().unwrap();
    let workspace = Workspace::open(&dir.path().join("profile"), None).unwrap();
    let session = workspace.session_open(None).unwrap()["sessionId"]
        .as_str()
        .unwrap()
        .to_owned();
    let router = Arc::new(ToolRouter::new(workspace.clone()));
    let path = dir.path().join("fixture.fig");
    fixture(&path, true);
    assert!(std::fs::metadata(&path).unwrap().len() > 4 * 1024 * 1024);
    for (index, tool) in ["import_document", "native_job"].into_iter().enumerate() {
        let arguments = json!({"format":"fig","filePath":path,"title":format!("FIG job {index}"),"strict":true});
        let args = if tool == "native_job" {
            json!({"version":"1","action":"submit","kind":"import","arguments":arguments})
        } else {
            arguments
        };
        let ticket = router.call(&session, tool, args, Value::Null).unwrap();
        let status = wait(&workspace, &session, &ticket);
        assert_eq!(status["state"], "completed", "{status}");
        assert_eq!(status["result"]["diagnostics"], json!([]));
        assert_eq!(
            workspace.list(false).unwrap()["documents"]
                .as_array()
                .unwrap()
                .len(),
            index + 1
        );
    }
    fixture(&path, false);
    let ticket = router
        .call(
            &session,
            "import_document",
            json!({"format":"fig","filePath":path}),
            Value::Null,
        )
        .unwrap();
    let status = wait(&workspace, &session, &ticket);
    assert_eq!(status["state"], "failed", "{status}");
    assert_eq!(
        workspace.list(false).unwrap()["documents"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
}
