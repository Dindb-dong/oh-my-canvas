use super::*;
use winit::window::Fullscreen;

impl App {
    pub(in crate::app) fn finish_workspace_tab(
        &mut self,
        id: &str,
        open: Option<bool>,
        error: Option<&str>,
    ) {
        if self
            .automation
            .workspace_tab
            .as_ref()
            .is_some_and(|(expected_id, expected_open, _)| {
                expected_id == id && open.is_none_or(|open| open == *expected_open)
            })
        {
            let (_, _, reply) = self.automation.workspace_tab.take().unwrap();
            let result = error.map_or_else(
                || Ok(self.inspect_automation()),
                |error| Err(error.to_string()),
            );
            let _ = reply.try_send(result);
        }
    }

    pub(super) fn handle_workspace_automation(&mut self, args: &Value, reply: Reply) {
        let action = args["action"].as_str().unwrap_or_default();
        if matches!(action, "focus" | "close") {
            let result = (|| {
                if self.editing.is_some() {
                    return Err("Finish the current edit before changing tabs.".into());
                }
                let document = args["documentId"]
                    .as_str()
                    .and_then(|id| Uuid::parse_str(id).ok())
                    .ok_or("A valid document ID is required.")?;
                let id = format!("doc_{}", document.simple());
                let open = action == "focus";
                let tab_present = self.tabs.contains(&id);
                if open && tab_present {
                    self.switch(id);
                } else if open || tab_present {
                    self.bridge.send(if open {
                        Request::Open { id: id.clone() }
                    } else {
                        Request::Close { id: id.clone() }
                    })?;
                    return Ok(Some((id, open)));
                }
                Ok(None)
            })();
            match result {
                Ok(Some((id, open))) => self.automation.workspace_tab = Some((id, open, reply)),
                Ok(None) => {
                    let _ = reply.try_send(Ok(self.inspect_automation()));
                }
                Err(error) => {
                    let _ = reply.try_send(Err(error));
                }
            }
            return;
        }
        let result = self.automation_workspace(args);
        let _ = reply.try_send(result);
    }

    fn automation_workspace(&mut self, args: &Value) -> Result<Value, String> {
        match args["action"].as_str() {
            Some("window") => {
                if args["devTools"] == true {
                    return Err("The native editor has no browser Developer Tools.".into());
                }
                if self.background
                    && (args["hideOthers"].is_boolean()
                        || args["fullscreen"] == true
                        || args["visible"] == true)
                {
                    return Err("Background automation cannot change window visibility or focus.".into());
                }
                let window = self.window.as_ref().ok_or("No native window.")?;
                if let Some(hide) = args["hideOthers"].as_bool() {
                    set_other_apps_hidden(hide)?;
                }
                if let Some(fullscreen) = args["fullscreen"].as_bool() {
                    window.set_fullscreen(fullscreen.then_some(Fullscreen::Borderless(None)));
                }
                if let Some(visible) = args["visible"].as_bool() {
                    window.set_visible(visible);
                }
                Ok(
                    json!({"ok":true,"fullscreen":args["fullscreen"].as_bool().unwrap_or_else(||window.fullscreen().is_some()),
                    "visible":window.is_visible().unwrap_or(!self.occluded),"devTools":false}),
                )
            }
            Some("quit") => {
                self.commit_edit();
                if self.pending || self.editing.is_some() {
                    return Err("Finish saving the current edit before quitting.".into());
                }
                // The bridge closes the editor after the service acknowledges this result.
                Ok(json!({"ok":true,"quitting":true}))
            }
            Some("sample_color") if self.background => {
                Err("Background automation cannot sample the screen.".into())
            }
            Some("sample_color") => sample_color(self, args),
            Some("state") => Ok(self.inspect_automation()),
            Some("show_library") => {
                if self.editing.is_some() {
                    return Err("Finish the current edit before opening the library.".into());
                }
                self.action(Action::Library);
                Ok(self.inspect_automation())
            }
            _ => Err("Unknown native workspace command.".into()),
        }
    }
}

pub(crate) fn open_url(args: &Value) -> Result<Value, String> {
    let input = args["url"]
        .as_str()
        .filter(|url| {
            !url.chars().any(|c| c.is_control() || c.is_whitespace()) && !url.contains('\\')
        })
        .ok_or("A valid link URL is required.")?;
    let url = reqwest::Url::parse(input).map_err(|_| "The link URL is invalid.")?;
    match url.scheme() {
        "http" | "https"
            if url.host_str().is_some()
                && url.username().is_empty()
                && url.password().is_none() => {}
        "mailto" if !url.path().is_empty() => {}
        _ => return Err("Only web and mail links can open from the native canvas.".into()),
    }
    #[cfg(target_os = "macos")]
    let mut opener = std::process::Command::new("/usr/bin/open");
    #[cfg(target_os = "windows")]
    let mut opener = {
        let mut command = std::process::Command::new("rundll32.exe");
        command.arg("url.dll,FileProtocolHandler");
        command
    };
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let mut opener = std::process::Command::new("xdg-open");
    let mut child = opener
        .arg(url.as_str())
        .spawn()
        .map_err(|error| error.to_string())?;
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(json!({"opened":true}))
}

#[cfg(target_os = "macos")]
fn set_other_apps_hidden(hide: bool) -> Result<(), String> {
    use objc2::MainThreadMarker;
    use objc2_app_kit::NSApplication;
    let main = MainThreadMarker::new().ok_or("Window operation requires the app thread.")?;
    let application = NSApplication::sharedApplication(main);
    if hide {
        application.hideOtherApplications(None);
    } else {
        application.unhideAllApplications(None);
    }
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn set_other_apps_hidden(_: bool) -> Result<(), String> {
    Err("Hiding other applications is available on macOS.".into())
}

#[cfg(target_os = "macos")]
fn sample_color(app: &App, args: &Value) -> Result<Value, String> {
    use objc2_core_foundation::CGRect;
    use skia_safe::{AlphaType, Color, ColorSpace, ColorType, Data, Image, ImageInfo, surfaces};
    use winit::platform::macos::MonitorHandleExtMacOS;

    #[link(name = "CoreGraphics", kind = "framework")]
    unsafe extern "C" {
        fn CGDisplayBounds(display: u32) -> CGRect;
        fn CGPreflightScreenCaptureAccess() -> bool;
    }
    let x = args["x"]
        .as_f64()
        .filter(|x| x.is_finite())
        .ok_or("A finite screen x coordinate is required.")?;
    let y = args["y"]
        .as_f64()
        .filter(|y| y.is_finite())
        .ok_or("A finite screen y coordinate is required.")?;
    let requested = args["displayId"].as_str();
    let window = app.window.as_ref().ok_or("No native window.")?;
    let display = window
        .available_monitors()
        .find(|monitor| {
            let id = monitor.native_id();
            if requested.is_some_and(|requested| requested != id.to_string()) {
                return false;
            }
            // Winit supplies active CoreGraphics display IDs.
            let bounds = unsafe { CGDisplayBounds(id) };
            x >= bounds.origin.x
                && y >= bounds.origin.y
                && x < bounds.origin.x + bounds.size.width
                && y < bounds.origin.y + bounds.size.height
        })
        .ok_or("The coordinates are outside the requested display.")?;
    // Check the existing macOS permission without opening a system prompt.
    if !unsafe { CGPreflightScreenCaptureAccess() } {
        return Err(
            "Screen color sampling requires Screen Recording permission in macOS System Settings."
                .into(),
        );
    }

    let directory = tempfile::tempdir().map_err(|error| error.to_string())?;
    let path = directory.path().join("pixel.png");
    let region = format!("{},{},1,1", x.floor(), y.floor());
    let status = std::process::Command::new("/usr/sbin/screencapture")
        .args(["-x", "-R", &region])
        .arg(&path)
        .status()
        .map_err(|error| error.to_string())?;
    if !status.success() {
        return Err("The operating system did not provide this screen pixel.".into());
    }
    let encoded = std::fs::read(path).map_err(|error| error.to_string())?;
    let image = Image::from_encoded(Data::new_copy(&encoded))
        .ok_or("The screen pixel could not be decoded.")?;
    let info = ImageInfo::new(
        (1, 1),
        ColorType::RGBA8888,
        AlphaType::Premul,
        Some(ColorSpace::new_srgb()),
    );
    let mut sample = surfaces::raster(&info, None, None)
        .ok_or("The screen pixel surface could not be created.")?;
    sample.canvas().clear(Color::TRANSPARENT);
    sample.canvas().draw_image(&image, (0., 0.), None);
    let color = sample
        .peek_pixels()
        .ok_or("The screen pixel could not be read.")?
        .get_color((0, 0));
    if color.a() != 255 {
        return Err("The operating system did not provide an opaque screen pixel.".into());
    }
    let rgba = [color.r(), color.g(), color.b(), color.a()];
    let [r, g, b, _] = rgba;
    Ok(
        json!({"ok":true,"displayId":display.native_id().to_string(),"x":x,"y":y,"rgba":rgba,"color":format!("#{r:02x}{g:02x}{b:02x}")}),
    )
}

#[cfg(not(target_os = "macos"))]
fn sample_color(_: &App, _: &Value) -> Result<Value, String> {
    Err("Screen color sampling is available on macOS.".into())
}
