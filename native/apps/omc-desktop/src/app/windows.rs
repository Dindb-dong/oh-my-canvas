use super::*;
use crate::WindowProxy;
use std::time::{SystemTime, UNIX_EPOCH};
use winit::event_loop::EventLoopProxy;

enum OpenDocument {
    Create,
    Path(String),
    Transfer {
        window: u64,
        id: String,
        cameras: BTreeMap<(String, String), Camera>,
        page: Option<String>,
        selection: BTreeSet<String>,
    },
}

enum Progress {
    Connected,
    Opened(String),
    Closed(String),
    Failed {
        tab: Option<String>,
        message: String,
    },
}

impl Progress {
    fn from_response(response: &Response) -> Option<Self> {
        match response {
            Response::Connected => Some(Self::Connected),
            Response::Snapshot {
                document,
                activate: true,
                ..
            } => Some(Self::Opened(document.id.clone())),
            Response::Closed { id } => Some(Self::Closed(id.clone())),
            Response::TabError { id, message } => Some(Self::Failed {
                tab: Some(id.clone()),
                message: message.clone(),
            }),
            Response::Error { message, .. } => Some(Self::Failed {
                tab: None,
                message: message.clone(),
            }),
            _ => None,
        }
    }
}

struct Opening {
    id: u64,
    source: OpenDocument,
    reply: automation::Reply,
    deadline: Instant,
    opened: Option<String>,
}

pub(crate) struct DesktopWindows {
    windows: BTreeMap<u64, App>,
    active: u64,
    next: u64,
    main_parked: bool,
    quitting: bool,
    opening: Option<Opening>,
}

impl DesktopWindows {
    pub(crate) fn new(
        profile: PathBuf,
        proxy: EventLoopProxy<Event>,
        smoke: Option<Duration>,
        screenshot: Option<PathBuf>,
        smoke_size: Option<(u32, u32)>,
        background: bool,
    ) -> Self {
        let main = App::new(
            profile,
            WindowProxy { id: 1, raw: proxy },
            smoke,
            screenshot,
            smoke_size,
            background,
        );
        Self {
            windows: BTreeMap::from([(1, main)]),
            active: 1,
            next: 2,
            main_parked: false,
            quitting: false,
            opening: None,
        }
    }

    pub(crate) fn join_launch_invite(&mut self, link: &str) {
        if let Some(app) = self.windows.get_mut(&1) {
            app.join_launch_invite(link);
        }
    }

    pub(crate) fn smoke_failed(&self) -> bool {
        self.windows[&1].smoke_failed
    }

    fn visible_app(&self, id: u64) -> Option<&App> {
        self.windows
            .get(&id)
            .filter(|app| !app.closing && !(id == 1 && self.main_parked))
    }

    fn choose_active(&mut self) {
        self.active = self
            .windows
            .keys()
            .rev()
            .copied()
            .find(|&id| self.visible_app(id).is_some())
            .unwrap_or(1);
    }

    fn start_window(
        &mut self,
        event_loop: &ActiveEventLoop,
        job: &automation::Job,
        reply: automation::Reply,
    ) {
        let error = |message: &str| {
            let _ = reply.try_send(Err(message.into()));
        };
        if self.opening.is_some() || self.windows.len() >= 16 {
            error("Finish opening the previous window or close an existing window.");
            return;
        }
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default();
        if now.as_millis() >= u128::from(job.expires) {
            error("The window request expired before it could run.");
            return;
        }
        let Some(active) = self.visible_app(self.active) else {
            error("No native window is available.");
            return;
        };
        let source = if let Some(index) = job.arguments["index"].as_u64() {
            if active.pending || active.editing.is_some() || active.drag.is_some() {
                error("Finish the current edit before moving its document.");
                return;
            }
            let Some(id) = usize::try_from(index)
                .ok()
                .and_then(|index| active.tabs.get(index))
                .cloned()
            else {
                error("The tab index is outside the open documents.");
                return;
            };
            let selected = active.active.as_ref() == Some(&id);
            OpenDocument::Transfer {
                window: self.active,
                cameras: active
                    .cameras
                    .iter()
                    .filter(|((doc, _), _)| doc == &id)
                    .map(|(key, value)| (key.clone(), *value))
                    .collect(),
                page: selected.then(|| active.page.clone()).flatten(),
                selection: if selected {
                    active.selected.clone()
                } else {
                    BTreeSet::new()
                },
                id,
            }
        } else if let Some(path) = job.arguments["path"].as_str() {
            OpenDocument::Path(path.into())
        } else {
            OpenDocument::Create
        };
        let id = self.next;
        let mut child = App::new(
            active.profile.clone(),
            WindowProxy {
                id,
                raw: active.proxy.raw.clone(),
            },
            None,
            None,
            active.smoke_size,
            active.background,
        );
        // Refreshing the library must not race opening the requested document.
        child.plugin_bridge = Some(self.windows[&1].bridge.clone());
        child.library_open = true;
        child.resumed(event_loop);
        if child.window.is_none() {
            child.shutdown();
            error("The desktop could not create a native window.");
            return;
        }
        self.next += 1;
        self.windows.insert(id, child);
        self.opening = Some(Opening {
            id,
            source,
            reply,
            deadline: Instant::now() + Duration::from_secs(6),
            opened: None,
        });
    }

    fn finish_window(&mut self, result: Result<String, String>) {
        let Some(opening) = self.opening.take() else {
            return;
        };
        let result = match result {
            Ok(document) => {
                self.active = opening.id;
                Ok(json!({"ok":true,"window":opening.id,"documentId":document}))
            }
            Err(error) => {
                if let Some(app) = self.windows.get_mut(&opening.id) {
                    if let Some(window) = &app.window {
                        window.set_visible(false);
                    }
                    app.shutdown();
                }
                self.choose_active();
                Err(error)
            }
        };
        let _ = opening.reply.try_send(result);
    }

    fn window_progress(&mut self, id: u64, event: Progress) {
        let Some(opening) = &mut self.opening else {
            return;
        };
        if id == opening.id && opening.opened.is_none() {
            match event {
                Progress::Connected => {
                    let request = match &opening.source {
                        OpenDocument::Create => Request::Create {
                            title: "Untitled design".into(),
                        },
                        OpenDocument::Path(path) => Request::OpenPath { path: path.clone() },
                        OpenDocument::Transfer { id, .. } => Request::Open { id: id.clone() },
                    };
                    self.windows.get_mut(&id).unwrap().send(request);
                }
                Progress::Opened(document_id) => {
                    if let OpenDocument::Transfer {
                        window,
                        id: tab,
                        cameras,
                        page,
                        selection,
                    } = &opening.source
                    {
                        let child = self.windows.get_mut(&id).unwrap();
                        child.cameras.extend(cameras.clone());
                        if let Some(page) = page.as_ref() {
                            child.page = Some(page.clone());
                            child.camera = child
                                .cameras
                                .get(&(tab.clone(), page.clone()))
                                .copied()
                                .unwrap_or_default();
                            child.selected = selection.clone();
                            child.schedule_scene();
                        }
                        let source = self.windows.get_mut(window).unwrap();
                        if source.pending || source.editing.is_some() || source.drag.is_some() {
                            self.finish_window(Err(
                                "The source document is busy. Finish the edit before moving it."
                                    .into(),
                            ));
                            return;
                        }
                        opening.opened = Some(document_id);
                        if let Err(error) = source.bridge.send(Request::Close { id: tab.clone() }) {
                            self.finish_window(Err(error));
                        }
                    } else {
                        self.finish_window(Ok(document_id));
                    }
                }
                Progress::Failed { message, .. } => {
                    self.finish_window(Err(message));
                }
                _ => {}
            }
        } else if let OpenDocument::Transfer {
            window, id: tab, ..
        } = &opening.source
            && id == *window
            && let Some(opened) = &opening.opened
        {
            match event {
                Progress::Closed(id) if &id == tab => {
                    let document = opened.clone();
                    self.finish_window(Ok(document));
                }
                Progress::Failed {
                    tab: Some(id),
                    message,
                } if &id == tab => self.finish_window(Err(message)),
                _ => {}
            }
        }
    }

    fn automation(
        &mut self,
        event_loop: &ActiveEventLoop,
        job: automation::Job,
        reply: automation::Reply,
    ) {
        if job.method == "window.new" {
            self.start_window(event_loop, &job, reply);
            return;
        }
        let preferred = if job.method == "screenshot" {
            job.arguments["window"].as_u64()
        } else if job.method == "window.focus" {
            job.arguments["id"].as_u64()
        } else {
            let document = job.arguments["document"]
                .as_str()
                .or(job.arguments["documentId"].as_str());
            let normalized = document
                .and_then(|id| Uuid::parse_str(id).ok())
                .map(|id| format!("doc_{}", id.simple()));
            let document = normalized.as_deref().or(document);
            document.and_then(|document| {
                self.visible_app(self.active)
                    .filter(|app| app.active.as_deref() == Some(document))
                    .map(|_| self.active)
                    .or_else(|| {
                        self.windows
                            .iter()
                            .find(|&(&id, app)| {
                                self.visible_app(id).is_some()
                                    && app.active.as_deref() == Some(document)
                            })
                            .map(|(&id, _)| id)
                    })
                    .or_else(|| {
                        if job.method == "workspace" {
                            self.windows
                                .iter()
                                .find(|&(&id, app)| {
                                    self.visible_app(id).is_some()
                                        && app.tabs.iter().any(|tab| tab == document)
                                })
                                .map(|(&id, _)| id)
                        } else {
                            None
                        }
                    })
            })
        }
        .unwrap_or(self.active);
        if self.visible_app(preferred).is_none() {
            let _ = reply.try_send(Err("No native window with that ID.".into()));
            return;
        }
        if job.method == "inspect_ui"
            || job.method == "workspace" && job.arguments["action"] == "state"
        {
            let mut state = self.windows[&preferred].inspect_automation();
            if self.windows.len() > 1 || self.main_parked {
                state["windows"] = json!(
                    self.windows
                        .keys()
                        .copied()
                        .filter_map(|id| {
                            self.visible_app(id)
                                .map(|app| app.inspect_automation()["windows"][0].clone())
                        })
                        .collect::<Vec<_>>()
                );
            }
            let _ = reply.try_send(Ok(state));
            return;
        }
        self.windows
            .get_mut(&preferred)
            .unwrap()
            .handle_automation(job, reply);
    }

    fn try_shutdown(&mut self) {
        if self.windows.len() == 1 {
            self.windows.get_mut(&1).unwrap().shutdown();
            return;
        }
        for (&id, app) in &mut self.windows {
            if id != 1 && !app.pending {
                app.shutdown();
            }
        }
    }

    fn close_main(&mut self) {
        let main = self.windows.get_mut(&1).unwrap();
        if main.editing.is_some() {
            main.commit_edit();
        }
        if main.pending {
            main.error = Some("Wait for the edit to finish before closing the window.".into());
            return;
        }
        for id in main.tabs.clone() {
            main.send(Request::Close { id });
        }
        if let Some(window) = &main.window {
            window.set_visible(false);
        }
        self.main_parked = true;
        self.choose_active();
    }
}

impl ApplicationHandler<Event> for DesktopWindows {
    fn resumed(&mut self, event_loop: &ActiveEventLoop) {
        self.windows.get_mut(&1).unwrap().resumed(event_loop);
    }

    fn user_event(&mut self, event_loop: &ActiveEventLoop, event: Event) {
        match event {
            Event::WindowScoped(_, event) if matches!(&*event, Event::AutomationQuit) => {
                self.quitting = true;
                self.try_shutdown();
            }
            Event::WindowScoped(_, event) if matches!(&*event, Event::Automation(..)) => {
                let Event::Automation(job, reply) = *event else {
                    unreachable!()
                };
                self.automation(event_loop, job, reply);
            }
            Event::WindowScoped(id, event) => {
                if id != 1 && matches!(&*event, Event::Service(Response::Shutdown)) {
                    self.windows.remove(&id);
                    if self.active == id {
                        self.choose_active();
                    }
                    if self.windows.len() == 1 && self.main_parked {
                        self.quitting = true;
                    }
                    if self.quitting {
                        self.try_shutdown();
                    }
                    return;
                }
                if let Some(app) = self.windows.get_mut(&id) {
                    let progress = match &*event {
                        Event::Service(response) if self.opening.is_some() => {
                            Progress::from_response(response)
                        }
                        _ => None,
                    };
                    app.user_event(event_loop, *event);
                    if let Some(response) = progress {
                        self.window_progress(id, response);
                    }
                }
            }
            Event::Accessibility(event) => {
                if let Some(app) = self.windows.values_mut().find(|app| {
                    app.window
                        .as_ref()
                        .is_some_and(|window| window.id() == event.window_id)
                }) {
                    app.user_event(event_loop, Event::Accessibility(event));
                }
            }
            _ => {}
        }
    }

    fn window_event(&mut self, event_loop: &ActiveEventLoop, window: WindowId, event: WindowEvent) {
        let Some((&id, _)) = self.windows.iter().find(|(_, app)| {
            app.window
                .as_ref()
                .is_some_and(|candidate| candidate.id() == window)
        }) else {
            return;
        };
        if matches!(event, WindowEvent::Focused(true)) && self.visible_app(id).is_some() {
            self.active = id;
        }
        if matches!(event, WindowEvent::CloseRequested)
            && self.opening.as_ref().is_some_and(|opening| {
                opening.id == id || matches!(&opening.source, OpenDocument::Transfer { window, .. } if *window == id)
            })
        {
            return;
        }
        if id == 1 && self.main_parked {
            return;
        }
        if id == 1 && self.windows.len() > 1 && matches!(event, WindowEvent::CloseRequested) {
            self.close_main();
            return;
        }
        self.windows
            .get_mut(&id)
            .unwrap()
            .window_event(event_loop, window, event);
    }

    fn about_to_wait(&mut self, event_loop: &ActiveEventLoop) {
        if self.quitting {
            self.try_shutdown();
        }
        if self
            .opening
            .as_ref()
            .is_some_and(|opening| opening.opened.is_none() && Instant::now() >= opening.deadline)
        {
            self.finish_window(Err(
                "Timed out opening the document in its new window.".into()
            ));
        }
        // Let the active window set the animation deadline last.
        for (&id, app) in &mut self.windows {
            if id != self.active && !(id == 1 && self.main_parked) {
                app.about_to_wait(event_loop);
            }
        }
        if let Some(app) = self.windows.get_mut(&self.active) {
            app.about_to_wait(event_loop);
        }
    }
}
