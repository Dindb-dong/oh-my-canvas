use super::*;
use std::{
    io::{self, Read, Write},
    path::PathBuf,
    process::{Command as ProcessCommand, Stdio},
    sync::OnceLock,
    thread,
    time::{Duration, Instant},
};

const MAX_FRAME_COUNT: usize = 300;
const FRAME_BYTE_BUDGET: usize = 128 * 1024 * 1024;
const OUTPUT_BYTE_BUDGET: usize = 32 * 1024 * 1024;
pub(super) const MAX_DURATION_MS: u32 = 30_000;
pub(super) const MAX_FPS: u32 = 60;

pub(super) fn available() -> bool {
    encoder().is_some()
}

fn encoder() -> Option<&'static std::path::Path> {
    static ENCODER: OnceLock<Option<PathBuf>> = OnceLock::new();
    ENCODER
        .get_or_init(|| {
            let path = if let Some(configured) = std::env::var_os("OMC_MOTION_FFMPEG") {
                PathBuf::from(configured)
            } else {
                [
                    "/opt/homebrew/bin/ffmpeg",
                    "/usr/bin/ffmpeg",
                    "/usr/local/bin/ffmpeg",
                ]
                .into_iter()
                .map(PathBuf::from)
                .find(|path| path.is_file())?
            };
            if !path.is_absolute() || !path.is_file() {
                return None;
            }
            let output = execute(
                &path,
                &["-hide_banner", "-encoders"],
                &[],
                256 * 1024,
                Duration::from_secs(3),
            )
            .ok()?;
            String::from_utf8_lossy(&output)
                .lines()
                .any(|line| line.split_whitespace().nth(1) == Some("libx264"))
                .then_some(path)
        })
        .as_deref()
}

pub(super) fn export_video(
    router: &ToolRouter,
    session: &str,
    snapshot: &DocumentSnapshot,
    frame: &str,
    args: &Value,
) -> Result<Value> {
    let encoder = encoder().ok_or_else(|| EngineError::new(
        "unsupported_feature", "motion MP4 requires local FFmpeg with libx264; set OMC_MOTION_FFMPEG to its absolute path",
    ))?;
    let number = |field: &str, fallback: u32| {
        args[field]
            .as_u64()
            .map(|value| value as u32)
            .unwrap_or(fallback)
    };
    let (start, duration, fps) = (
        number("startMs", 0),
        number("durationMs", 0),
        number("fps", 24),
    );
    if !(100..=MAX_DURATION_MS).contains(&duration)
        || !(1..=MAX_FPS).contains(&fps)
        || start
            .checked_add(duration)
            .is_none_or(|end| end > MAX_TIME_MS)
    {
        return Err(EngineError::invalid(
            "motion video duration, start or frame rate is outside the supported range",
        ));
    }
    let count = (duration * fps).div_ceil(1000) as usize;
    if !(2..=MAX_FRAME_COUNT).contains(&count) {
        return Err(EngineError::new(
            "resource_limit",
            "motion video requires 2–300 frames",
        ));
    }
    let mut prepared = Prepared::new(snapshot, frame)?;
    let (width, height) = (prepared.width as usize, prepared.height as usize);
    let bytes_per_frame = width * height * 4;
    let video_bytes = count * bytes_per_frame;
    if video_bytes > FRAME_BYTE_BUDGET {
        return Err(EngineError::new(
            "resource_limit",
            "motion render exceeds the decoded frame budget; use a smaller frame, duration or frame rate",
        ));
    }
    let resources = router.resources()?;
    let mut frames = vec![0; video_bytes];
    let mut diagnostics = Vec::new();
    let info = skia_safe::ImageInfo::new(
        (prepared.width, prepared.height),
        skia_safe::ColorType::RGBA8888,
        skia_safe::AlphaType::Opaque,
        None,
    );
    let render_deadline = Instant::now() + Duration::from_secs(25);
    for (index, data) in frames.chunks_exact_mut(bytes_per_frame).enumerate() {
        if Instant::now() >= render_deadline {
            return Err(EngineError::new(
                "resource_limit",
                "motion render timed out",
            ));
        }
        let time_ms = f64::from(start) + index as f64 * 1000. / f64::from(fps);
        let (mut surface, warnings, _) = prepared.paint(time_ms, &resources, Color::WHITE)?;
        if !surface.read_pixels(&info, data, width * 4, (0, 0)) {
            return Err(EngineError::new(
                "internal_error",
                "motion frame readback failed",
            ));
        }
        for warning in warnings {
            if !diagnostics.contains(&warning) {
                diagnostics.push(warning);
            }
        }
    }
    let dimensions = format!("{width}x{height}");
    let frame_rate = fps.to_string();
    let bytes = execute(
        encoder,
        &[
            "-hide_banner",
            "-loglevel",
            "error",
            "-nostdin",
            "-f",
            "rawvideo",
            "-pixel_format",
            "rgba",
            "-video_size",
            &dimensions,
            "-framerate",
            &frame_rate,
            "-i",
            "pipe:0",
            "-an",
            "-sn",
            "-dn",
            "-filter_threads",
            "1",
            "-threads",
            "1",
            "-vf",
            "pad=ceil(iw/2)*2:ceil(ih/2)*2:color=white",
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-pix_fmt",
            "yuv420p",
            "-movflags",
            "frag_keyframe+empty_moov+default_base_moof",
            "-f",
            "mp4",
            "pipe:1",
        ],
        &frames,
        OUTPUT_BYTE_BUDGET,
        Duration::from_secs(20),
    )
    .map_err(|e| {
        EngineError::new(
            "internal_error",
            format!("motion video encoding failed: {e}"),
        )
    })?;
    if bytes.get(4..8) != Some(b"ftyp") {
        return Err(EngineError::new(
            "internal_error",
            "motion video encoder returned invalid MP4",
        ));
    }
    let mut result = router.deliver_export(
        session,
        args,
        export(snapshot, bytes, "mp4", "video/mp4", diagnostics),
    )?;
    result["mimeType"] = json!("video/mp4");
    result["frameId"] = json!(frame);
    result["fps"] = json!(fps);
    result["frameCount"] = json!(count);
    result["durationMs"] = json!(count as f64 * 1000. / f64::from(fps));
    result["width"] = json!(width.next_multiple_of(2));
    result["height"] = json!(height.next_multiple_of(2));
    Ok(result)
}

fn execute(
    executable: &std::path::Path,
    args: &[&str],
    input: &[u8],
    limit: usize,
    timeout: Duration,
) -> io::Result<Vec<u8>> {
    let mut child = ProcessCommand::new(executable)
        .args(args)
        .env_clear()
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()?;
    let mut stdin = child.stdin.take().expect("piped child input");
    let mut stdout = child
        .stdout
        .take()
        .expect("piped child output")
        .take(limit as u64 + 1);
    thread::scope(|scope| {
        let write = scope.spawn(move || stdin.write_all(input));
        let read = scope.spawn(move || {
            let mut output = Vec::new();
            stdout.read_to_end(&mut output)?;
            Ok::<_, io::Error>(output)
        });
        let deadline = Instant::now() + timeout;
        let status = loop {
            match child.try_wait() {
                Ok(Some(status)) => break Ok(status),
                Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(10)),
                result => {
                    let _ = child.kill();
                    let _ = child.wait();
                    break Err(result.err().unwrap_or_else(|| {
                        io::Error::new(io::ErrorKind::TimedOut, "FFmpeg timed out")
                    }));
                }
            }
        };
        let output = read.join().expect("read worker completed")?;
        if output.len() > limit {
            return Err(io::Error::other("FFmpeg output exceeds the byte limit"));
        }
        if !status?.success() {
            return Err(io::Error::other("FFmpeg exited unsuccessfully"));
        }
        write.join().expect("write worker completed")?;
        Ok(output)
    })
}
