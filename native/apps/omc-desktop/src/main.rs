mod accessibility;
mod app;
mod client;
mod commands;
mod figcraft_chrome;
mod geometry;
#[cfg(target_os = "macos")]
mod gpu_presenter;
mod inspector;
mod move_cache;
mod paint;
mod pan_cache;
mod prototype;
mod scene_cache;
mod tab_strip;
mod text;
mod text_ui;

use std::{path::PathBuf, time::Duration};
use winit::event_loop::EventLoop;

pub enum Event {
    Service(client::Response),
    Scene(app::SceneReply),
    PanRasterReady,
    Accessibility(accesskit_winit::Event),
}
impl From<accesskit_winit::Event> for Event {
    fn from(value: accesskit_winit::Event) -> Self {
        Self::Accessibility(value)
    }
}

fn profile_default() -> PathBuf {
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    if cfg!(windows) {
        std::env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .unwrap_or(home)
            .join("OhMyCanvas")
    } else if cfg!(target_os = "macos") {
        home.join("Library/Application Support/OhMyCanvas")
    } else {
        std::env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".local/share"))
            .join("oh-my-canvas")
    }
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut profile = profile_default();
    let mut smoke = None;
    let mut screenshot = None;
    let mut smoke_size = None;
    let mut args = std::env::args().skip(1);
    while let Some(argument) = args.next() {
        match argument.as_str() {
            "--profile" => {
                profile = PathBuf::from(args.next().ok_or("--profile requires a directory")?)
            }
            "--smoke-exit-ms" => {
                smoke = Some(Duration::from_millis(
                    args.next()
                        .ok_or("--smoke-exit-ms requires milliseconds")?
                        .parse()?,
                ))
            }
            "--smoke-size" => {
                let size = args.next().ok_or("--smoke-size requires WIDTHxHEIGHT")?;
                let (width, height) = size
                    .split_once('x')
                    .ok_or("--smoke-size requires WIDTHxHEIGHT")?;
                let (width, height) = (width.parse::<u32>()?, height.parse::<u32>()?);
                if !(760..=3840).contains(&width) || !(520..=2160).contains(&height) {
                    return Err("--smoke-size must be between 760x520 and 3840x2160".into());
                }
                smoke_size = Some((width, height));
            }
            "--screenshot" => {
                screenshot = Some(PathBuf::from(
                    args.next().ok_or("--screenshot requires a PNG path")?,
                ))
            }
            "--help" | "-h" => {
                println!(
                    "Oh My Canvas native preview\n\nomc-desktop [--profile DIRECTORY]\n  --smoke-exit-ms N  Exit after N milliseconds for native window smoke checks.\n  --smoke-size WxH   Set the logical window size for an explicit smoke run.\n  --screenshot PATH Save one rendered window PNG for an explicit smoke run.\n\nStarts or connects to omc-service for the same profile. No browser runtime is used."
                );
                return Ok(());
            }
            _ => return Err(format!("Unknown argument: {argument}").into()),
        }
    }
    if (screenshot.is_some() || smoke_size.is_some()) && smoke.is_none() {
        return Err("--screenshot and --smoke-size require --smoke-exit-ms".into());
    }
    let event_loop = EventLoop::<Event>::with_user_event().build()?;
    let mut app = app::App::new(
        profile,
        event_loop.create_proxy(),
        smoke,
        screenshot,
        smoke_size,
    );
    event_loop.run_app(&mut app)?;
    if app.smoke_failed {
        return Err("The native desktop smoke run failed; inspect its stderr output.".into());
    }
    Ok(())
}
