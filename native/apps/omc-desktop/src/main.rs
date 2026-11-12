mod accessibility;
mod app;
mod client;
mod commands;
mod figcraft_chrome;
mod geometry;
#[cfg(target_os = "macos")]
mod gpu_presenter;
mod inspector;
mod inspector_design;
mod layout_grids;
mod localization;
mod move_cache;
mod paint;
mod pan_cache;
mod prototype;
mod scene_cache;
mod tab_strip;
mod text;
mod text_ui;
mod theme;

use std::{path::PathBuf, time::Duration};
use winit::event_loop::{EventLoop, EventLoopClosed, EventLoopProxy};

pub(crate) enum Event {
    WindowScoped(u64, Box<Event>),
    Service(client::Response),
    Automation(app::automation::Job, app::automation::Reply),
    AutomationQuit,
    Scene(app::SceneReply),
    PanRasterReady,
    Accessibility(accesskit_winit::Event),
}
#[derive(Clone)]
pub(crate) struct WindowProxy {
    id: u64,
    raw: EventLoopProxy<Event>,
}

impl WindowProxy {
    pub(crate) fn send_event(&self, event: Event) -> Result<(), EventLoopClosed<Event>> {
        self.raw
            .send_event(Event::WindowScoped(self.id, Box::new(event)))
    }
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
    let mut background = false;
    let mut explicit_profile = false;
    let mut invite = None;
    let mut args = std::env::args().skip(1);
    while let Some(argument) = args.next() {
        match argument.as_str() {
            "--profile" => {
                profile = PathBuf::from(args.next().ok_or("--profile requires a directory")?);
                explicit_profile = true;
            }
            "--automation-background" => background = true,
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
                    "Oh My Canvas native preview\n\nomc-desktop [--profile DIRECTORY] [NATIVE_INVITATION]\n  --automation-background Keep the window hidden for MCP tests with an explicit profile.\n  --smoke-exit-ms N  Exit after N milliseconds for native window smoke checks.\n  --smoke-size WxH   Set the logical window size for an explicit smoke run.\n  --screenshot PATH Save one rendered window PNG for an explicit smoke run.\n\nStarts or connects to omc-service for the same profile. No browser runtime is used."
                );
                return Ok(());
            }
            _ if argument.starts_with(omc_model::LOCAL_INVITATION_PREFIX) => {
                if invite.is_some() || omc_model::local_invitation_payload(&argument).is_none() {
                    return Err("Expected one valid native OMC invitation link".into());
                }
                invite = Some(argument);
            }
            _ => return Err(format!("Unknown argument: {argument}").into()),
        }
    }
    if (screenshot.is_some() || smoke_size.is_some()) && smoke.is_none() {
        return Err("--screenshot and --smoke-size require --smoke-exit-ms".into());
    }
    if background && !explicit_profile {
        return Err("--automation-background requires an explicit --profile".into());
    }
    let mut builder = EventLoop::<Event>::with_user_event();
    #[cfg(target_os = "macos")]
    if background {
        use winit::platform::macos::{ActivationPolicy, EventLoopBuilderExtMacOS};
        builder
            .with_activation_policy(ActivationPolicy::Accessory)
            .with_activate_ignoring_other_apps(false)
            .with_default_menu(false);
    }
    let event_loop = builder.build()?;
    let mut app = app::windows::DesktopWindows::new(
        profile,
        event_loop.create_proxy(),
        smoke,
        screenshot,
        smoke_size,
        background,
    );
    if let Some(link) = invite {
        app.join_launch_invite(&link);
    }
    event_loop.run_app(&mut app)?;
    if app.smoke_failed() {
        return Err("The native desktop smoke run failed; inspect its stderr output.".into());
    }
    Ok(())
}
