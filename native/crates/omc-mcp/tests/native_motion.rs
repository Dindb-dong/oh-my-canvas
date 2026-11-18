use base64::Engine;
use omc_mcp::ToolRouter;
use omc_workspace::Workspace;
use serde_json::{Value, json};
use skia_safe::{Color, Data, Image};
use std::sync::Arc;

#[test]
fn motion_keyframes_render_and_survive_reopen() {
    let directory = tempfile::tempdir().unwrap();
    let workspace = Workspace::open(directory.path(), None).unwrap();
    let router = Arc::new(ToolRouter::new(workspace.clone()));
    let registration = workspace.session_open(None).unwrap();
    let session = registration["sessionId"].as_str().unwrap();
    let call = |tool, args| router.call(session, tool, args, Value::Null).unwrap();
    let document = call("create_document", json!({"title":"Motion fixture"}));
    let id = document["documentId"].as_str().unwrap();
    let make = |kind, width, height, parent: Option<&str>| {
        let mut args = json!({"documentId":id,"type":kind,"width":width,"height":height});
        if let Some(parent) = parent {
            args["parentId"] = parent.into();
        }
        let properties = if parent.is_some() {
            json!({"fills":[{"type":"solid","color":"#ff0000"}]})
        } else {
            json!({"fills":[{"type":"solid","color":"#ffffff"}]})
        };
        args["properties"] = properties;
        call("create_shape", args)["rawIds"][0]
            .as_str()
            .unwrap()
            .to_owned()
    };
    let frame = make("frame", 96, 32, None);
    let layer = make("rect", 12, 12, Some(&frame));
    let motion = |args| router.call(session, "native_motion", args, Value::Null);
    let track = json!({"version":"1","action":"set_track","documentId":id,"nodeId":layer,
        "property":"translateX","keyframes":[{"timeMs":0,"value":0,"easing":"easeIn"},{"timeMs":1000,"value":64}]});
    let committed = router
        .call(
            session,
            "native_motion",
            track.clone(),
            json!({"oh-my-canvas/idempotency-key":"motion-ease-fixture"}),
        )
        .unwrap();
    let replay = router
        .call(
            session,
            "native_motion",
            track,
            json!({"oh-my-canvas/idempotency-key":"motion-ease-fixture"}),
        )
        .unwrap();
    assert_eq!(committed["revision"], replay["revision"]);
    let sample = |time| {
        motion(
            json!({"version":"1","action":"sample","documentId":id,"frameId":frame,"timeMs":time}),
        )
        .unwrap()
    };
    for (time, x) in [(0, 0), (500, 16), (1000, 64)] {
        let rendered = sample(time);
        assert_eq!(
            rendered["revision"]["sequence"],
            committed["revision"].as_u64().unwrap().to_string()
        );
        assert_eq!(
            rendered["values"][&layer]["translateX"].as_f64(),
            Some(f64::from(x))
        );
        assert_eq!(rendered["width"], 96);
        assert_eq!(rendered["height"], 32);
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(rendered["base64"].as_str().unwrap())
            .unwrap();
        let image = Image::from_encoded(Data::new_copy(&bytes))
            .unwrap()
            .make_raster_image(None, None)
            .unwrap();
        let pixmap = image.peek_pixels().unwrap();
        assert_eq!(pixmap.get_color((x + 5, 5)), Color::RED);
        assert_eq!(pixmap.get_color((90, 5)), Color::WHITE);
        if x > 0 {
            assert_eq!(pixmap.get_color((5, 5)), Color::WHITE);
        }
    }
    assert!(
        motion(
            json!({"version":"1","action":"set_track","documentId":id,"nodeId":layer,
        "property":"opacity","keyframes":[{"timeMs":100,"value":1},{"timeMs":100,"value":0}]})
        )
        .is_err()
    );
    assert!(
        motion(
            json!({"version":"1","action":"remove_track","documentId":id,"nodeId":layer,
        "revision":0,"property":"translateX"})
        )
        .is_err()
    );
    let inspected =
        motion(json!({"version":"1","action":"inspect","documentId":id,"nodeId":layer})).unwrap();
    assert_eq!(inspected["tracks"]["translateX"][0]["easing"], "easeIn");
    assert_eq!(inspected["tracks"].as_object().unwrap().len(), 1);
    call("save_document", json!({"id":id}));
    router.end_session(session);
    workspace.session_close(session).unwrap();
    let registration = workspace.session_open(None).unwrap();
    let session = registration["sessionId"].as_str().unwrap();
    router
        .call(session, "open_document", json!({"id":id}), Value::Null)
        .unwrap();
    let motion = |args| {
        router
            .call(session, "native_motion", args, Value::Null)
            .unwrap()
    };
    let inspected =
        motion(json!({"version":"1","action":"inspect","documentId":id,"nodeId":layer}));
    assert_eq!(inspected["tracks"]["translateX"][1]["value"], 64.);
    let rendered = motion(
        json!({"version":"1","action":"sample","documentId":id,"frameId":frame,"timeMs":500}),
    );
    assert_eq!(rendered["values"][&layer]["translateX"], 16.);
    let removed = motion(
        json!({"version":"1","action":"remove_track","documentId":id,"nodeId":layer,"property":"translateX"}),
    );
    assert_eq!(removed["tracks"], json!({}));
    router
        .call(session, "undo", json!({"documentId":id}), Value::Null)
        .unwrap();
    let inspected =
        motion(json!({"version":"1","action":"inspect","documentId":id,"nodeId":layer}));
    assert_eq!(inspected["tracks"]["translateX"][1]["value"], 64.);

    let capabilities = motion(json!({"version":"1","action":"capabilities"}));
    if capabilities["mp4"]["available"] == true {
        use std::{
            path::PathBuf,
            process::{Command, Stdio},
        };
        let output = directory.path().join("motion.mp4");
        let video = motion(
            json!({"version":"1","action":"export_video","documentId":id,"frameId":frame,
            "durationMs":1000,"fps":4,"filePath":output}),
        );
        assert_eq!(
            video["mimeType"].as_str().unwrap_or("video/mp4"),
            "video/mp4"
        );
        assert_eq!(video["frameCount"], 4);
        assert_eq!(video["durationMs"], 1000.);
        assert_eq!(video["revision"], inspected["revision"]);
        let decoder = std::env::var_os("OMC_MOTION_FFMPEG")
            .map(PathBuf::from)
            .or_else(|| {
                [
                    "/opt/homebrew/bin/ffmpeg",
                    "/usr/bin/ffmpeg",
                    "/usr/local/bin/ffmpeg",
                ]
                .into_iter()
                .map(PathBuf::from)
                .find(|path| path.is_file())
            })
            .unwrap();
        let pixels = Command::new(decoder)
            .args(["-hide_banner", "-loglevel", "error", "-i"])
            .arg(output)
            .args(["-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"])
            .stdin(Stdio::null())
            .output()
            .unwrap();
        assert!(pixels.status.success());
        let stride = 96 * 32 * 3;
        assert_eq!(pixels.stdout.len(), 4 * stride);
        let color = |frame: usize, x: usize| {
            let i = frame * stride + (5 * 96 + x) * 3;
            &pixels.stdout[i..i + 3]
        };
        assert!(color(0, 5)[0] > 190 && color(0, 5)[1] < 70);
        assert!(color(3, 41)[0] > 190 && color(3, 41)[1] < 70);
        assert!(color(3, 5).iter().all(|channel| *channel > 200));
    }
}
