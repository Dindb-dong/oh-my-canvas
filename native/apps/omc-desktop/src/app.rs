pub(crate) mod automation;

use crate::{
    Event,
    client::{Bridge, DocumentEntry, Request, Response},
    geometry::{Camera, Rect},
    pan_cache::PanCache,
    scene_cache::SceneCache,
    text::EditBuffer,
};
use omc_model::{DocumentSnapshot, Node, NodeKind};
use omc_scene::{Scene, SceneOptions, build_scene};
use serde_json::{Value, json};
use std::{
    cell::RefCell,
    collections::{BTreeMap, BTreeSet},
    path::PathBuf,
    rc::Rc,
    sync::{
        Arc,
        mpsc::{self, SyncSender},
    },
    thread,
    time::{Duration, Instant},
};
use uuid::Uuid;
use winit::{
    application::ApplicationHandler,
    dpi::{LogicalPosition, LogicalSize},
    event::{ElementState, Ime, MouseButton, MouseScrollDelta, TouchPhase, WindowEvent},
    event_loop::{ActiveEventLoop, ControlFlow, EventLoopProxy},
    keyboard::{Key, ModifiersState, NamedKey},
    window::{CursorIcon, Window, WindowId},
};

pub const HEADER: f64 = crate::tab_strip::HEIGHT;
pub const LEFT: f64 = crate::figcraft_chrome::RAIL_WIDTH + crate::figcraft_chrome::SIDEBAR_WIDTH;
pub const RIGHT: f64 = crate::figcraft_chrome::INSPECTOR_WIDTH;
pub const FOOTER: f64 = 20.;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ScrollTarget {
    Layers,
    Canvas,
    Inspector,
    Outside,
}

fn scroll_target_at(canvas: Rect, inspector_visible: bool, cursor: (f64, f64)) -> ScrollTarget {
    let (x, y) = cursor;
    if y < canvas.y || y >= canvas.y + canvas.height {
        ScrollTarget::Outside
    } else if canvas.contains(x, y) {
        ScrollTarget::Canvas
    } else if x < canvas.x {
        ScrollTarget::Layers
    } else if inspector_visible {
        ScrollTarget::Inspector
    } else {
        ScrollTarget::Outside
    }
}

fn scroll_delta(delta: MouseScrollDelta, scale: f64, shift: bool) -> (f64, f64) {
    match delta {
        MouseScrollDelta::LineDelta(x, y) if shift && x == 0. => (f64::from(y) * 30., 0.),
        MouseScrollDelta::LineDelta(x, y) => (f64::from(x) * 30., f64::from(y) * 30.),
        MouseScrollDelta::PixelDelta(p) => (p.x / scale, p.y / scale),
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Tool {
    Select,
    Frame,
    Rect,
    Ellipse,
    Text,
    Pan,
}
impl Tool {
    pub fn label(self) -> &'static str {
        match self {
            Self::Select => "Select",
            Self::Frame => "Frame",
            Self::Rect => "Rectangle",
            Self::Ellipse => "Ellipse",
            Self::Text => "Text",
            Self::Pan => "Pan canvas (H)",
        }
    }
}
#[derive(Clone, Debug)]
pub enum Action {
    New,
    Files,
    Mcp,
    CopyMcpConfiguration,
    Collaborate,
    Collaboration(&'static str),
    Library,
    TabOverflow,
    ToolMenu(crate::figcraft_chrome::DockGroup),
    Import,
    ImportHtml,
    Export,
    Open(String),
    Close(String),
    Tool(Tool),
    Undo,
    Redo,
    Save,
    Fit,
    Layer(String),
    ToggleLayer(String),
    LayerVisibility(String),
    LayerLock(String),
    Page(String),
    Field(String),
    RenameDocument,
    Refresh,
    SelectAll,
    Delete,
    Inspector(Inspector),
    InspectorZoom,
    InspectorLayerMenu,
    InspectorIcon(&'static str, crate::inspector_design::Command),
    InspectorChoice(&'static str, crate::inspector_design::Command),
    ZoomPercent(f64),
    CopyInspectorCss,
    PrototypeTarget(Option<String>),
    PrototypePreview,
    PrototypeExit,
    Reorder(bool),
    ToggleProperty(String),
    Group(bool),
    Ungroup,
    Instance,
    Detach,
    NewPage,
    RenamePage,
    CreateCatalog(String),
    ApplyCatalog {
        namespace: String,
        id: String,
    },
    EditCatalog {
        namespace: String,
        id: String,
        property: String,
    },
}
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Inspector {
    Design,
    Prototype,
    Inspect,
    Assets,
    Tokens,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Popup {
    Files,
    Mcp,
    Collaboration,
    Tabs,
    InspectorZoom,
    InspectorLayer,
    InspectorBlend,
    Tools(crate::figcraft_chrome::DockGroup),
}
#[derive(Clone, Debug)]
pub struct Control {
    pub id: u64,
    pub rect: Rect,
    pub label: String,
    pub action: Action,
    pub selected: bool,
    pub field_value: Option<String>,
}
#[derive(Clone)]
pub enum EditTarget {
    Property {
        node_id: String,
        property: String,
    },
    Text {
        node_id: String,
    },
    Title,
    Page {
        page_id: String,
    },
    Catalog {
        namespace: String,
        id: String,
        property: String,
    },
}
#[derive(Clone)]
pub struct Editing {
    pub target: EditTarget,
    pub buffer: EditBuffer,
    pub id: String,
    pub epoch: String,
    pub sequence: u64,
}
#[derive(Clone)]
pub enum Drag {
    TextSelection,
    Resize {
        id: String,
        origin: (f64, f64),
        inverse: omc_scene::Affine,
        original: [f64; 4],
        preview: [f64; 4],
        west: bool,
        north: bool,
    },
    Pan {
        origin: (f64, f64),
        camera: Camera,
    },
    Move {
        origin: (f64, f64),
        positions: Vec<(String, f64, f64)>,
        delta: (f64, f64),
    },
    Draw {
        origin: (f64, f64),
        end: (f64, f64),
        tool: Tool,
    },
    Marquee {
        origin: (f64, f64),
        end: (f64, f64),
    },
}

struct PendingMove {
    sequence: u64,
    translations: BTreeMap<String, (f64, f64)>,
    delta: (f64, f64),
}

pub struct LayerRow {
    pub id: String,
    pub name: String,
    pub depth: usize,
    pub has_children: bool,
    pub auto_layout: bool,
    pub dimmed: bool,
    pub locked_above: bool,
}
pub struct SceneReply {
    id: String,
    epoch: String,
    sequence: u64,
    page: Option<String>,
    result: Result<Scene, String>,
    layers: Vec<LayerRow>,
    resources: BTreeMap<String, Vec<u8>>,
    resource_errors: Vec<String>,
}
fn layer_index(document: &DocumentSnapshot, page: Option<&str>) -> Vec<LayerRow> {
    let Some(root) = document
        .pages
        .iter()
        .find(|p| Some(p.id.as_str()) == page)
        .or_else(|| document.pages.first())
        .map(|p| p.root_node_id.clone())
    else {
        return vec![];
    };
    let mut children: BTreeMap<&str, Vec<&Node>> = BTreeMap::new();
    for node in document.nodes.values() {
        if let Some(parent) = &node.parent_id {
            children.entry(parent).or_default().push(node);
        }
    }
    for list in children.values_mut() {
        list.sort_by(|a, b| a.rank.cmp(&b.rank).then(a.id.cmp(&b.id)));
    }
    let mut result = vec![];
    let mut stack: Vec<(&Node, usize, bool, bool)> = children
        .get(root.as_str())
        .into_iter()
        .flatten()
        .rev()
        .map(|node| (*node, 0, false, false))
        .collect();
    let mut seen = BTreeSet::new();
    while let Some((node, depth, hidden_above, locked_above)) = stack.pop() {
        if !seen.insert(node.id.clone()) {
            continue;
        }
        let kids = children.get(node.id.as_str());
        let dimmed = hidden_above || crate::commands::layer_hidden(node);
        let locked = locked_above || crate::commands::layer_locked(node);
        result.push(LayerRow {
            id: node.id.clone(),
            name: node_name(node),
            depth,
            has_children: kids.is_some_and(|k| !k.is_empty()),
            auto_layout: false,
            dimmed,
            locked_above,
        });
        if let Some(kids) = kids {
            stack.extend(
                kids.iter()
                    .rev()
                    .map(|child| (*child, depth + 1, dimmed, locked)),
            );
        }
    }
    result
}
struct SceneRequest {
    document: Arc<DocumentSnapshot>,
    page: Option<String>,
    width: f64,
    height: f64,
}

pub struct App {
    pub surface: Option<softbuffer::Surface<Rc<Window>, Rc<Window>>>,
    pub access: Option<accesskit_winit::Adapter>,
    pub proxy: EventLoopProxy<Event>,
    pub bridge: Bridge,
    profile: PathBuf,
    pub service_connected: bool,
    automation: automation::State,
    pub collaboration_document: Option<String>,
    pub collaboration: Value,
    pub collaboration_pending: bool,
    last_presence: Instant,
    scene_sender: SyncSender<SceneRequest>,
    scene_pending: bool,
    pub documents: Vec<DocumentEntry>,
    pub tabs: Vec<String>,
    pub snapshots: BTreeMap<String, Arc<DocumentSnapshot>>,
    pub active: Option<String>,
    pub page: Option<String>,
    pub scene: Option<Arc<Scene>>,
    pub scene_generation: u64,
    pub scene_cache: RefCell<SceneCache>,
    pub pan_cache: RefCell<PanCache>,
    pub move_cache: RefCell<crate::move_cache::MoveCache>,
    #[cfg(target_os = "macos")]
    pub gpu_presenter: Option<crate::gpu_presenter::MetalPresenter>,
    pub window: Option<Rc<Window>>,
    occluded: bool,
    pan_view: bool,
    scroll_target: Option<ScrollTarget>,
    pub resources: Arc<BTreeMap<String, Vec<u8>>>,
    pub camera: Camera,
    pub cameras: BTreeMap<(String, String), Camera>,
    pub selected: BTreeSet<String>,
    pub tool: Tool,
    pub cursor: (f64, f64),
    cursor_icon: CursorIcon,
    pub drag: Option<Drag>,
    drag_button: Option<MouseButton>,
    pending_move: Option<PendingMove>,
    pub editing: Option<Editing>,
    ime_selection: Option<Value>,
    ime_capture_pending: bool,
    ime_commit: Option<String>,
    text_splice_inflight: bool,
    pub recovery_text: Option<String>,
    pub controls: Vec<Control>,
    pub focus: u64,
    pub keyboard_focus_visible: bool,
    pub popup: Option<Popup>,
    pub library_open: bool,
    pub modifiers: ModifiersState,
    pub space_pan: bool,
    pub pending: bool,
    pub status: String,
    pub error: Option<String>,
    pub width: f64,
    pub height: f64,
    pub layer_scroll: usize,
    pub inspector: Inspector,
    pub inspector_scroll: f64,
    pub prototype_frame: Option<String>,
    editor_camera: Option<Camera>,
    pub layers: Vec<LayerRow>,
    pub visible_layers: Vec<usize>,
    pub collapsed: BTreeSet<String>,
    pub last_click: Option<(Instant, (f64, f64))>,
    last_poll: Instant,
    poll_pending: bool,
    pub closing: bool,
    close_started: Option<Instant>,
    start: Instant,
    smoke: Option<Duration>,
    smoke_size: Option<(u32, u32)>,
    pub smoke_failed: bool,
    pub presented: bool,
    trace_frames: bool,
    input_frame: Option<(&'static str, Instant)>,
    screenshot: Option<PathBuf>,
    pub clipboard: Option<arboard::Clipboard>,
}

impl App {
    pub fn new(
        profile: PathBuf,
        proxy: EventLoopProxy<Event>,
        smoke: Option<Duration>,
        screenshot: Option<PathBuf>,
        smoke_size: Option<(u32, u32)>,
    ) -> Self {
        let resource_profile = profile.clone();
        let bridge = Bridge::start(profile.clone(), proxy.clone());
        let (scene_sender, receiver) = mpsc::sync_channel::<SceneRequest>(1);
        let scene_proxy = proxy.clone();
        thread::spawn(move || {
            let store = omc_assets::AssetStore::open(&resource_profile);
            while let Ok(request) = receiver.recv() {
                let options = SceneOptions {
                    page_id: request.page.clone(),
                    width: request.width,
                    height: request.height,
                    time_ms: 0.0,
                    strict: false,
                };
                let mut layers = layer_index(&request.document, request.page.as_deref());
                let result = build_scene(&request.document, &options).map_err(|e| e.to_string());
                let mut resources = BTreeMap::new();
                let mut resource_errors = vec![];
                let mut reserved = 0usize;
                if let Ok(scene) = &result {
                    let automatic: BTreeSet<_> = scene
                        .items
                        .iter()
                        .filter(|item| {
                            matches!(
                                item.style.get("display"),
                                Some("flex" | "inline-flex" | "grid")
                            )
                        })
                        .map(|item| item.id.as_str())
                        .collect();
                    for layer in &mut layers {
                        layer.auto_layout = automatic.contains(layer.id.as_str());
                    }
                    for item in &scene.items {
                        let hash = item
                            .properties
                            .get("assetHash")
                            .or_else(|| item.properties.get("imageHash"))
                            .and_then(Value::as_str)
                            .or_else(|| {
                                item.properties
                                    .get("image")
                                    .and_then(|v| v.get("hash"))
                                    .and_then(Value::as_str)
                            });
                        if let Some(hash) = hash {
                            if resources.contains_key(hash) {
                                continue;
                            }
                            if reserved + 64 * 1024 * 1024 > 256 * 1024 * 1024 {
                                resource_errors.push("Image cache is full; some images are unavailable until other resources are released.".into());
                                break;
                            }
                            match &store {
                                Ok(store) => match store.read(hash) {
                                    Ok(bytes) => {
                                        reserved += bytes.len();
                                        resources.insert(hash.to_string(), bytes);
                                    }
                                    Err(error) => resource_errors.push(error.to_string()),
                                },
                                Err(error) => resource_errors.push(error.to_string()),
                            }
                        }
                    }
                }

                if scene_proxy
                    .send_event(Event::Scene(SceneReply {
                        id: request.document.id.clone(),
                        epoch: request.document.epoch.clone(),
                        sequence: request.document.sequence,
                        page: request.page,
                        result,
                        layers,
                        resources,
                        resource_errors,
                    }))
                    .is_err()
                {
                    break;
                }
            }
        });
        let pan_proxy = proxy.clone();
        let pan_cache = PanCache::new(move || {
            let _ = pan_proxy.send_event(Event::PanRasterReady);
        });
        Self {
            window: None,
            occluded: false,
            surface: None,
            #[cfg(target_os = "macos")]
            gpu_presenter: None,
            access: None,
            proxy,
            bridge,
            profile,
            service_connected: false,
            automation: automation::State::default(),
            collaboration_document: None,
            collaboration: Value::Null,
            collaboration_pending: false,
            last_presence: Instant::now(),
            scene_sender,
            scene_pending: false,
            documents: vec![],
            tabs: vec![],
            snapshots: BTreeMap::new(),
            active: None,
            page: None,
            scene: None,
            scene_generation: 0,
            scene_cache: RefCell::default(),
            pan_cache: RefCell::new(pan_cache),
            move_cache: RefCell::default(),
            pan_view: false,
            scroll_target: None,
            resources: Arc::default(),
            camera: Camera::default(),
            cameras: BTreeMap::new(),
            selected: BTreeSet::new(),
            tool: Tool::Select,
            cursor: (0., 0.),
            cursor_icon: CursorIcon::Default,
            drag: None,
            drag_button: None,
            pending_move: None,
            editing: None,
            ime_selection: None,
            ime_capture_pending: false,
            ime_commit: None,
            text_splice_inflight: false,
            recovery_text: None,
            controls: vec![],
            focus: 1,
            keyboard_focus_visible: false,
            popup: None,
            library_open: false,
            modifiers: ModifiersState::empty(),
            space_pan: false,
            pending: false,
            status: "Connecting to your documents…".into(),
            error: None,
            width: 1440.,
            height: 900.,
            layer_scroll: 0,
            inspector: Inspector::Design,
            prototype_frame: None,
            editor_camera: None,
            inspector_scroll: 0.,
            layers: vec![],
            visible_layers: vec![],
            collapsed: BTreeSet::new(),
            last_click: None,
            last_poll: Instant::now(),
            poll_pending: false,
            closing: false,
            close_started: None,
            start: Instant::now(),
            smoke,
            smoke_size,
            smoke_failed: false,
            presented: false,
            trace_frames: std::env::var_os("OMC_NATIVE_FRAME_TRACE").is_some(),
            input_frame: None,
            screenshot,
            clipboard: arboard::Clipboard::new().ok(),
        }
    }
    fn collaboration_request(&mut self, action: &'static str, args: Value) {
        match self.bridge.send(Request::Collaboration { action, args }) {
            Ok(()) => {
                self.collaboration_pending = true;
                self.error = None;
            }
            Err(error) => self.error = Some(error),
        }
    }

    pub fn mcp_configuration(&self) -> Result<String, String> {
        let cli = std::env::current_exe()
            .map_err(|e| e.to_string())?
            .with_file_name(if cfg!(windows) {
                "omc-cli.exe"
            } else {
                "omc-cli"
            });
        if !cli.is_file() {
            return Err("The MCP CLI is missing from this build.".into());
        }
        let profile = std::path::absolute(&self.profile).map_err(|e| e.to_string())?;
        let cli = cli
            .to_str()
            .ok_or("The MCP executable path is not valid Unicode.")?;
        let profile = profile
            .to_str()
            .ok_or("The MCP profile path is not valid Unicode.")?;
        serde_json::to_string_pretty(&json!({
            "mcpServers": {
                "oh-my-canvas": {
                    "command": cli,
                    "args": ["--profile", profile]
                },
                "oh-my-canvas-figcraft": {
                    "command": cli,
                    "args": ["--profile", profile, "--dialect", "figcraft"]
                }
            }
        }))
        .map_err(|e| e.to_string())
    }

    pub fn drag_translations(&self) -> BTreeMap<String, (f64, f64)> {
        if let Some(Drag::Move {
            positions, delta, ..
        }) = &self.drag
        {
            self.move_translations(positions, *delta)
        } else {
            self.pending_move
                .as_ref()
                .map(|preview| preview.translations.clone())
                .unwrap_or_default()
        }
    }
    pub fn move_delta(&self) -> Option<(f64, f64)> {
        if let Some(Drag::Move { delta, .. }) = &self.drag {
            Some(*delta)
        } else {
            self.pending_move.as_ref().map(|preview| preview.delta)
        }
    }
    fn move_translations(
        &self,
        positions: &[(String, f64, f64)],
        delta: (f64, f64),
    ) -> BTreeMap<String, (f64, f64)> {
        positions
            .iter()
            .filter_map(|(id, _, _)| {
                let doc = self.document()?;
                if self.scene.as_ref()?.item(id)?.locked {
                    return None;
                }
                let mut parent = doc.nodes.get(id).and_then(|n| n.parent_id.as_ref());
                while let Some(p) = parent {
                    if self.selected.contains(p) {
                        return None;
                    }
                    parent = doc.nodes.get(p).and_then(|n| n.parent_id.as_ref());
                }
                let inverse = self
                    .scene
                    .as_ref()
                    .and_then(|scene| {
                        scene
                            .item(id)
                            .and_then(|item| item.parent.map(|p| scene.items[p].world))
                    })
                    .and_then(|world| world.inverse());
                let local = if let Some(inverse) = inverse {
                    let p = inverse.point(delta.0, delta.1);
                    let zero = inverse.point(0., 0.);
                    (p.0 - zero.0, p.1 - zero.1)
                } else {
                    delta
                };
                Some((id.clone(), local))
            })
            .collect()
    }
    pub fn document(&self) -> Option<&DocumentSnapshot> {
        self.active
            .as_ref()
            .and_then(|id| self.snapshots.get(id))
            .map(Arc::as_ref)
    }
    pub fn node(&self) -> Option<&Node> {
        let id = self.selected.iter().next()?;
        self.document()?.nodes.get(id)
    }
    pub fn inspector_visible(&self) -> bool {
        self.width >= 960. || self.inspector != Inspector::Design
    }
    pub fn uses_pan_raster(&self) -> bool {
        self.pan_view
    }
    pub fn canvas_rect(&self) -> Rect {
        let right = if self.inspector_visible() { RIGHT } else { 0. };
        Rect::new(
            LEFT,
            HEADER,
            (self.width - LEFT - right).max(1.),
            (self.height - HEADER).max(1.),
        )
    }
    pub fn world(&self, x: f64, y: f64) -> (f64, f64) {
        let r = self.canvas_rect();
        self.camera.world(x - r.x, y - r.y)
    }
    pub fn send(&mut self, request: Request) {
        if let Err(error) = self.bridge.send(request) {
            self.error = Some(error);
            self.pending = false;
        }
    }
    fn redraw(&self) {
        if let Some(window) = &self.window {
            window.request_redraw();
        }
    }
    fn trace_input(&mut self, kind: &'static str) {
        if self.trace_frames && self.input_frame.is_none() {
            self.input_frame = Some((kind, Instant::now()));
        }
    }
    fn schedule_scene(&mut self) {
        if self.scene_pending {
            return;
        }
        let Some(document) = self
            .active
            .as_ref()
            .and_then(|id| self.snapshots.get(id))
            .cloned()
        else {
            return;
        };
        let r = self.canvas_rect();
        if self
            .scene_sender
            .try_send(SceneRequest {
                document,
                page: self.page.clone(),
                width: r.width,
                height: r.height,
            })
            .is_ok()
        {
            self.scene_pending = true;
        }
    }
    fn mutate(&mut self, command: Value, group: &str) {
        if self.inspector == Inspector::Inspect || self.prototype_frame.is_some() {
            return;
        }
        if self.pending {
            self.error = Some("Wait for the pending edit to finish.".into());
            return;
        }
        let Some(doc) = self.document() else {
            return;
        };
        let request = Request::Command {
            id: doc.id.clone(),
            epoch: doc.epoch.clone(),
            sequence: doc.sequence,
            command,
            undo_group: format!("{group}_{}", Uuid::new_v4()),
        };
        self.pending = true;
        self.status = "Saving…".into();
        self.error = None;
        self.send(request);
    }
    fn switch(&mut self, id: String) {
        if self.pending || self.editing.is_some() {
            self.error = Some("Finish the current edit before switching documents.".into());
            return;
        }
        self.remember_camera();
        self.pending_move = None;
        self.move_cache.get_mut().clear();
        self.library_open = false;
        self.active = Some(id.clone());
        self.selected.clear();
        self.page = self
            .snapshots
            .get(&id)
            .and_then(|d| d.pages.first())
            .map(|p| p.id.clone());
        self.camera = self
            .cameras
            .get(&(id, self.page.clone().unwrap_or_default()))
            .copied()
            .unwrap_or_default();
        self.scene = None;
        self.scene_cache.get_mut().clear();
        self.pan_cache.get_mut().clear();
        self.pan_view = false;
        self.schedule_scene();
    }
    pub fn refresh_visible_layers(&mut self) {
        let mut skip_depth = None;
        self.visible_layers.clear();
        for (index, row) in self.layers.iter().enumerate() {
            if skip_depth.is_some_and(|depth| row.depth > depth) {
                continue;
            }
            skip_depth = None;
            self.visible_layers.push(index);
            if self.collapsed.contains(&row.id) {
                skip_depth = Some(row.depth);
            }
        }
        self.layer_scroll = self
            .layer_scroll
            .min(self.visible_layers.len().saturating_sub(1));
    }
    fn remember_camera(&mut self) {
        if let Some(id) = &self.active {
            self.cameras.insert(
                (id.clone(), self.page.clone().unwrap_or_default()),
                self.camera,
            );
        }
    }
    pub fn action_available(&self, action: &Action) -> bool {
        if self.closing
            || matches!(action, Action::Collaboration(_)) && self.collaboration_pending
            || matches!(action, Action::Collaboration(action) if *action != "join")
                && self.collaboration_document.is_none()
            || matches!(
                action,
                Action::InspectorIcon(_, crate::inspector_design::Command::Disabled)
                    | Action::InspectorChoice(_, crate::inspector_design::Command::Disabled)
            )
        {
            return false;
        }
        if self.prototype_frame.is_some() {
            return matches!(action, Action::PrototypeExit);
        }
        !(self.inspector == Inspector::Inspect
            && matches!(
                action,
                Action::Field(_)
                    | Action::RenamePage
                    | Action::RenameDocument
                    | Action::Delete
                    | Action::Undo
                    | Action::Redo
                    | Action::Reorder(_)
                    | Action::ToggleProperty(_)
                    | Action::LayerVisibility(_)
                    | Action::LayerLock(_)
                    | Action::PrototypeTarget(_)
                    | Action::Group(_)
                    | Action::Ungroup
                    | Action::Instance
                    | Action::Detach
                    | Action::NewPage
                    | Action::CreateCatalog(_)
                    | Action::ApplyCatalog { .. }
                    | Action::EditCatalog { .. }
            ))
    }
    pub fn action(&mut self, action: Action) {
        if !self.action_available(&action) {
            return;
        }
        let previous_popup = self.popup.take();
        if (self.pending || self.editing.is_some())
            && matches!(
                action,
                Action::Reorder(_)
                    | Action::ToggleProperty(_)
                    | Action::LayerVisibility(_)
                    | Action::LayerLock(_)
                    | Action::PrototypeTarget(_)
                    | Action::Group(_)
                    | Action::Ungroup
                    | Action::Instance
                    | Action::Detach
                    | Action::NewPage
                    | Action::CreateCatalog(_)
                    | Action::ApplyCatalog { .. }
                    | Action::EditCatalog { .. }
            )
        {
            self.error = Some("Finish the current edit before changing this selection.".into());
            return;
        }
        match action {
            Action::Collaborate => {
                if previous_popup != Some(Popup::Collaboration) {
                    self.popup = Some(Popup::Collaboration);
                    self.collaboration_document = self.active.clone();
                    self.collaboration = Value::Null;
                    if self.collaboration_document.is_some() && !self.collaboration_pending {
                        self.collaboration_request(
                            "status",
                            json!({"documentId":self.collaboration_document}),
                        );
                    }
                }
            }
            Action::Collaboration(action) => {
                self.popup = previous_popup;
                let args = if action == "join" {
                    let link = self
                        .clipboard
                        .as_mut()
                        .and_then(|clip| clip.get_text().ok());
                    match link {
                        Some(link) if !link.trim().is_empty() => {
                            json!({"invite":link.trim(),"name":"Guest"})
                        }
                        _ => {
                            self.error = Some("Copy a native OMC invitation first.".into());
                            return;
                        }
                    }
                } else {
                    json!({"documentId":self.collaboration_document,"name":"Host"})
                };
                self.collaboration_request(action, args);
            }
            Action::Mcp => {
                self.popup = (previous_popup != Some(Popup::Mcp)).then_some(Popup::Mcp);
            }
            Action::CopyMcpConfiguration => {
                self.popup = previous_popup;
                match self.mcp_configuration().and_then(|config| {
                    self.clipboard
                        .as_mut()
                        .ok_or("The system clipboard is unavailable.".to_string())?
                        .set_text(config)
                        .map_err(|error| error.to_string())
                }) {
                    Ok(()) => {
                        self.error = None;
                        self.status = "MCP configuration copied.".into();
                    }
                    Err(error) => self.error = Some(error),
                }
            }
            Action::Files => {
                if matches!(self.inspector, Inspector::Assets | Inspector::Tokens) {
                    self.inspector = Inspector::Design;
                    self.inspector_scroll = 0.;
                } else {
                    self.popup = (previous_popup != Some(Popup::Files)).then_some(Popup::Files);
                }
            }
            Action::Library => {
                if self.pending || self.editing.is_some() {
                    self.error = Some("Finish the current edit before opening the library.".into());
                    return;
                }
                self.remember_camera();
                self.library_open = true;
                self.active = None;
                self.page = None;
                self.scene = None;
                self.selected.clear();
                self.scene_cache.get_mut().clear();
                self.pan_cache.get_mut().clear();
                self.move_cache.get_mut().clear();
                self.pending_move = None;
            }
            Action::TabOverflow => {
                self.popup = (previous_popup != Some(Popup::Tabs)).then_some(Popup::Tabs);
            }
            Action::ToolMenu(group) => {
                let popup = Popup::Tools(group);
                self.popup = (previous_popup != Some(popup)).then_some(popup);
            }
            Action::Inspector(tab) => {
                self.commit_edit();
                if self.editing.is_none() {
                    self.inspector = tab;
                    self.inspector_scroll = 0.;
                }
            }
            Action::InspectorIcon(_, command) | Action::InspectorChoice(_, command) => {
                use crate::inspector_design::Command;
                match command {
                    Command::Disabled => {}
                    Command::Catalog(tab) => self.action(Action::Inspector(tab)),
                    Command::Export => self.action(Action::Export),
                    Command::Edit("blendMode") => {
                        self.popup = (previous_popup != Some(Popup::InspectorBlend))
                            .then_some(Popup::InspectorBlend);
                    }
                    Command::Edit(key) => self.begin_property(key.into()),
                    Command::Component => self.action(Action::Group(true)),
                    Command::Toggle(key) => self.action(Action::ToggleProperty(key.into())),
                    _ if self.editing.is_none() && self.selected.len() == 1 => {
                        if let Some(mutation) = crate::inspector_design::mutation(self, command) {
                            self.mutate(mutation, "inspector");
                        }
                    }
                    _ => {}
                }
            }
            Action::InspectorLayerMenu => {
                self.popup = (previous_popup != Some(Popup::InspectorLayer))
                    .then_some(Popup::InspectorLayer);
            }
            Action::InspectorZoom => {
                self.popup =
                    (previous_popup != Some(Popup::InspectorZoom)).then_some(Popup::InspectorZoom);
            }
            Action::ZoomPercent(zoom) => {
                let rect = self.canvas_rect();
                self.camera
                    .zoom_at(zoom / self.camera.zoom, rect.width * 0.5, rect.height * 0.5);
                self.remember_camera();
            }
            Action::CopyInspectorCss => {
                if let Some(css) = crate::inspector::css_for_selection(self) {
                    match self.clipboard.as_mut().map(|clip| clip.set_text(css)) {
                        Some(Ok(())) => self.status = "CSS copied".into(),
                        Some(Err(error)) => {
                            self.error = Some(format!("Clipboard unavailable: {error}"))
                        }
                        None => self.error = Some("The system clipboard is unavailable.".into()),
                    }
                }
            }
            Action::PrototypeTarget(target) => {
                if let (Some(doc), Some(page), Some(node)) =
                    (self.document(), self.page.as_deref(), self.node())
                    && self.selected.len() == 1
                {
                    let command =
                        crate::prototype::set_target(doc, page, &node.id, target.as_deref());
                    self.apply_plan(command, "prototype");
                }
            }
            Action::PrototypePreview => {
                if !self.pending
                    && self.editing.is_none()
                    && let (Some(doc), Some(page)) = (self.document(), self.page.as_deref())
                    && let Some(frame) = crate::prototype::preview_frame(
                        doc,
                        page,
                        self.node()
                            .filter(|_| self.selected.len() == 1)
                            .map(|n| n.id.as_str()),
                    )
                {
                    let id = frame.id.clone();
                    let editor_camera = self.camera;
                    if self.show_prototype_frame(id) {
                        self.editor_camera = Some(editor_camera);
                    }
                }
            }
            Action::PrototypeExit => {
                self.prototype_frame = None;
                if let Some(camera) = self.editor_camera.take() {
                    self.camera = camera;
                }
            }
            Action::Reorder(forward) => {
                if let (Some(doc), Some(node)) = (self.document(), self.node()) {
                    let plan = crate::commands::reorder(doc, &node.id, forward);
                    self.apply_plan(plan, "order");
                }
            }
            Action::ToggleProperty(property) => {
                if let Some(node) = self.node() {
                    let id = node.id.clone();
                    match property.as_str() {
                        "hidden" | "visible" => self.action(Action::LayerVisibility(id)),
                        "locked" => self.action(Action::LayerLock(id)),
                        _ => {
                            let value = node.properties.get(&property) != Some(&json!(true));
                            self.mutate(json!({"type":"node.set","nodeId":id,"properties":{property:value}}), "property");
                        }
                    }
                }
            }
            Action::Group(component) => {
                if let Some(doc) = self.document() {
                    match crate::commands::wrap(doc, &self.selected, component) {
                        Ok((command, id)) => {
                            self.mutate(command, "group");
                            self.selected = BTreeSet::from([id]);
                        }
                        Err(error) => self.error = Some(error),
                    }
                }
            }
            Action::Ungroup => {
                if let (Some(doc), Some(node)) = (self.document(), self.node()) {
                    let plan = crate::commands::ungroup(doc, &node.id);
                    self.apply_plan(plan, "ungroup");
                }
            }
            Action::Instance => {
                if let (Some(doc), Some(node)) = (self.document(), self.node()) {
                    match crate::commands::instance(doc, &node.id) {
                        Ok((command, id)) => {
                            self.mutate(command, "instance");
                            self.selected = BTreeSet::from([id]);
                        }
                        Err(error) => self.error = Some(error),
                    }
                }
            }
            Action::Detach => {
                if let (Some(doc), Some(node)) = (self.document(), self.node()) {
                    let plan = crate::commands::detach(doc, &node.id);
                    self.apply_plan(plan, "detach");
                }
            }
            Action::NewPage => {
                if let Some(doc) = self.document() {
                    let command = crate::commands::new_page(doc);
                    self.mutate(command, "page");
                }
            }
            Action::RenamePage => {
                if let Some(doc) = self.document()
                    && let Some(page) = doc.pages.iter().find(|p| Some(&p.id) == self.page.as_ref())
                {
                    self.editing = Some(Editing {
                        target: EditTarget::Page {
                            page_id: page.id.clone(),
                        },
                        buffer: EditBuffer::new(page.title.clone(), true),
                        id: doc.id.clone(),
                        epoch: doc.epoch.clone(),
                        sequence: doc.sequence,
                    });
                }
            }
            Action::CreateCatalog(namespace) => {
                if let Some(doc) = self.document() {
                    let value = self
                        .node()
                        .and_then(|n| {
                            self.scene
                                .as_ref()
                                .and_then(|scene| scene.item(&n.id))
                                .and_then(|item| item.properties.get("fill"))
                                .or_else(|| n.properties.get("fill"))
                        })
                        .cloned()
                        .unwrap_or(json!("#6151d7"));
                    let count = omc_style::catalog_entities(doc, &namespace).len();
                    let command = crate::commands::create_catalog(&namespace, value, count);
                    self.mutate(command, "catalog");
                }
            }
            Action::ApplyCatalog { namespace, id } => {
                if let Some(node) = self.node() {
                    let command = if namespace == "tokens" {
                        json!({"type":"batch","commands":[{"type":"node.unset","nodeId":node.id,"properties":["fills","fillStyleId"]},{"type":"node.set","nodeId":node.id,"properties":{"fill":{"$token":id}}}]})
                    } else {
                        json!({"type":"batch","commands":[{"type":"node.unset","nodeId":node.id,"properties":["fill","fills"]},{"type":"node.set","nodeId":node.id,"properties":{"fillStyleId":id}}]})
                    };
                    self.mutate(command, "link-style");
                }
            }
            Action::EditCatalog {
                namespace,
                id,
                property,
            } => {
                if let Some(doc) = self.document() {
                    let entities = omc_style::catalog_entities(doc, &namespace);
                    if let Some(entity) = entities.get(&id) {
                        let value = entity
                            .get(&property)
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_string();
                        self.editing = Some(Editing {
                            target: EditTarget::Catalog {
                                namespace,
                                id,
                                property,
                            },
                            buffer: EditBuffer::new(value, true),
                            id: doc.id.clone(),
                            epoch: doc.epoch.clone(),
                            sequence: doc.sequence,
                        });
                    }
                }
            }
            Action::ImportHtml => {
                if self.inspector == Inspector::Inspect {
                    self.inspector = Inspector::Design;
                }
                if self.pending || self.editing.is_some() {
                    self.error = Some("Finish the current edit before importing HTML.".into());
                    return;
                }
                let html = match self.clipboard.as_mut().map(|clip| clip.get_text()) {
                    Some(Ok(html)) if !html.trim().is_empty() => html,
                    _ => {
                        self.error = Some("Copy HTML markup, then choose Paste HTML.".into());
                        return;
                    }
                };
                self.pending = true;
                self.error = None;
                self.status = "Importing editable layers…".into();
                self.send(Request::ImportHtml { html });
            }
            Action::Import | Action::Export => {
                if self.pending || self.editing.is_some() {
                    self.error =
                        Some("Finish the current edit before importing or exporting.".into());
                    return;
                }
                let request = if matches!(action, Action::Import) {
                    Request::Import
                } else {
                    let Some(doc) = self.document() else {
                        return;
                    };
                    Request::Export {
                        id: doc.id.clone(),
                        page: self.page.clone(),
                        title: doc.title.clone(),
                    }
                };
                self.pending = true;
                self.status = "Choosing a file…".into();
                self.send(request);
            }
            Action::New => {
                if !self.pending && self.editing.is_none() {
                    self.send(Request::Create {
                        title: "Untitled design".into(),
                    });
                }
            }
            Action::Open(id) => {
                if self.pending || self.editing.is_some() {
                    self.error =
                        Some("Finish the current edit before opening another document.".into());
                    return;
                }
                if self.tabs.contains(&id) {
                    self.switch(id);
                } else {
                    self.send(Request::Open { id });
                }
            }
            Action::Close(id) => {
                if self.pending || self.editing.is_some() {
                    self.error = Some("Finish the current edit before closing this tab.".into());
                } else {
                    self.send(Request::Close { id });
                }
            }
            Action::Refresh => self.send(Request::Refresh),
            Action::Tool(tool) => {
                self.commit_edit();
                if self.editing.is_none() {
                    if self.inspector == Inspector::Inspect
                        && !matches!(tool, Tool::Select | Tool::Pan)
                    {
                        self.inspector = Inspector::Design;
                        self.inspector_scroll = 0.;
                    }
                    self.tool = tool;
                }
            }
            Action::Undo | Action::Redo => {
                if self.editing.is_some() {
                    self.error = Some("Finish or cancel text editing before Undo.".into());
                    return;
                }
                if let Some(doc) = self.document() {
                    let req = Request::Undo {
                        id: doc.id.clone(),
                        epoch: doc.epoch.clone(),
                        redo: matches!(action, Action::Redo),
                    };
                    if !self.pending {
                        self.pending = true;
                        self.error = None;
                        self.send(req);
                    }
                }
            }
            Action::Save => {
                self.commit_edit();
                if let Some(id) = &self.active {
                    self.send(Request::Save { id: id.clone() });
                }
            }
            Action::Fit => {
                self.pan_view = false;
                if let Some(scene) = &self.scene {
                    let mut bounds: Option<[f64; 4]> = None;
                    for item in &scene.items {
                        let b = item.bounds;
                        bounds = Some(match bounds {
                            None => b,
                            Some(a) => {
                                let x = a[0].min(b[0]);
                                let y = a[1].min(b[1]);
                                [
                                    x,
                                    y,
                                    (a[0] + a[2]).max(b[0] + b[2]) - x,
                                    (a[1] + a[3]).max(b[1] + b[3]) - y,
                                ]
                            }
                        });
                    }
                    if let Some(b) = bounds {
                        let r = self.canvas_rect();
                        self.camera.fit(b, r.width, r.height);
                    }
                }
            }
            Action::Layer(id) => {
                self.commit_edit();
                if !self.selected.contains(&id) {
                    self.inspector_scroll = 0.;
                }
                if !self.modifiers.shift_key() {
                    self.selected.clear();
                }
                self.selected.insert(id);
            }
            Action::LayerVisibility(id) => {
                if let Some(doc) = self.document() {
                    let plan = crate::commands::toggle_layer_visibility(doc, &id);
                    self.apply_plan(plan, "visibility");
                }
            }
            Action::LayerLock(id) => {
                if let Some(doc) = self.document() {
                    let plan = crate::commands::toggle_layer_lock(doc, &id);
                    self.apply_plan(plan, "lock");
                }
            }
            Action::ToggleLayer(id) => {
                if !self.collapsed.remove(&id) {
                    self.collapsed.insert(id);
                }
                self.refresh_visible_layers();
            }
            Action::Page(id) => {
                if self.pending || self.editing.is_some() {
                    return;
                }
                self.remember_camera();
                self.page = Some(id.clone());
                self.selected.clear();
                self.camera = self
                    .cameras
                    .get(&(self.active.clone().unwrap_or_default(), id))
                    .copied()
                    .unwrap_or_default();
                self.scene = None;
                self.scene_cache.get_mut().clear();
                self.pan_cache.get_mut().clear();
                self.pan_view = false;
                self.schedule_scene();
            }
            Action::Field(property) => {
                if property == "name" && previous_popup == Some(Popup::InspectorLayer) {
                    self.popup = previous_popup;
                }
                self.begin_property(property);
            }
            Action::RenameDocument => {
                if let Some(doc) = self.document() {
                    self.editing = Some(Editing {
                        target: EditTarget::Title,
                        buffer: EditBuffer::new(doc.title.clone(), true),
                        id: doc.id.clone(),
                        epoch: doc.epoch.clone(),
                        sequence: doc.sequence,
                    });
                }
            }
            Action::SelectAll => {
                self.selected = self
                    .scene
                    .as_ref()
                    .map(|scene| {
                        scene
                            .items
                            .iter()
                            .enumerate()
                            .filter(|(index, n)| *index != scene.root && !n.hidden && !n.locked)
                            .map(|(_, n)| n.id.clone())
                            .collect()
                    })
                    .unwrap_or_default();
            }
            Action::Delete => {
                let ids: Vec<_> = self.selected.iter().cloned().collect();
                if !ids.is_empty() {
                    self.mutate(json!({"type":"node.delete","nodeIds":ids}), "delete");
                }
            }
        }
        self.redraw();
    }
    fn apply_plan(&mut self, plan: Result<Value, String>, group: &str) {
        match plan {
            Ok(command) => self.mutate(command, group),
            Err(error) => self.error = Some(error),
        }
    }
    fn begin_property(&mut self, property: String) {
        self.commit_edit();
        if self.pending {
            return;
        }
        if let (Some(doc), Some(node)) = (self.document(), self.node()) {
            let value = self
                .controls
                .iter()
                .find(|c| matches!(&c.action,Action::Field(p) if p==&property))
                .and_then(|c| c.field_value.clone())
                .unwrap_or_else(|| {
                    node.properties
                        .get(&property)
                        .map(|v| {
                            v.as_str()
                                .map(str::to_string)
                                .unwrap_or_else(|| v.to_string())
                        })
                        .unwrap_or_default()
                });
            self.editing = Some(Editing {
                target: EditTarget::Property {
                    node_id: node.id.clone(),
                    property,
                },
                buffer: EditBuffer::new(value, true),
                id: doc.id.clone(),
                epoch: doc.epoch.clone(),
                sequence: doc.sequence,
            });
        }
    }
    fn begin_text(&mut self, id: String) {
        if self.pending {
            return;
        }
        if let Some(doc) = self.document()
            && let Some(node) = doc.nodes.get(&id)
            && node.kind == NodeKind::Text
        {
            let value = node
                .properties
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            self.editing = Some(Editing {
                target: EditTarget::Text { node_id: id },
                buffer: EditBuffer::new(value, false),
                id: doc.id.clone(),
                epoch: doc.epoch.clone(),
                sequence: doc.sequence,
            });
        }
    }
    fn capture_ime_selection(&mut self) {
        if self.ime_capture_pending || self.ime_selection.is_some() || self.pending {
            return;
        }
        let Some(edit) = &self.editing else {
            return;
        };
        let EditTarget::Text { node_id } = &edit.target else {
            return;
        };
        if edit.buffer.original != edit.buffer.text {
            return;
        }
        let range = edit.buffer.selection();
        let start = edit.buffer.text[..range.start].encode_utf16().count() as u32;
        let end = edit.buffer.text[..range.end].encode_utf16().count() as u32;
        let request = Request::CaptureText {
            id: edit.id.clone(),
            node_id: node_id.clone(),
            epoch: edit.epoch.clone(),
            sequence: edit.sequence,
            start,
            end,
        };
        self.ime_capture_pending = true;
        self.send(request);
    }
    fn flush_ime_commit(&mut self) {
        if self.pending
            || self.ime_selection.is_none()
            || self.ime_commit.is_none()
            || self.editing.is_none()
        {
            return;
        }
        let (Some(selection), Some(text), Some(edit)) = (
            self.ime_selection.take(),
            self.ime_commit.take(),
            self.editing.as_ref(),
        ) else {
            return;
        };
        self.recovery_text = Some(edit.buffer.text.clone());
        let request = Request::Splice {
            id: edit.id.clone(),
            epoch: edit.epoch.clone(),
            selection,
            text,
        };
        self.pending = true;
        self.text_splice_inflight = true;
        self.status = "Saving…".into();
        self.send(request);
    }
    fn commit_edit(&mut self) {
        let Some(edit) = self.editing.take() else {
            return;
        };
        if edit.buffer.composing {
            self.editing = Some(edit);
            self.error = Some("Finish the current input composition first.".into());
            return;
        }
        if edit.buffer.text == edit.buffer.original {
            return;
        }
        if self.pending {
            self.editing = Some(edit);
            return;
        }
        let command = match &edit.target {
            EditTarget::Page { page_id } => {
                json!({"type":"page.rename","pageId":page_id,"title":edit.buffer.text})
            }
            EditTarget::Catalog {
                namespace,
                id,
                property,
            } => {
                if property == "value" && omc_style::parse_color(&edit.buffer.text).is_none() {
                    self.error = Some("Enter a color such as #6151d7 or rgba(97,81,215,1).".into());
                    self.editing = Some(edit);
                    return;
                }
                json!({"type":"catalog.set","namespace":namespace,"entityId":id,"properties":{property:edit.buffer.text}})
            }
            EditTarget::Title => json!({"type":"document.rename","title":edit.buffer.text}),
            EditTarget::Property { node_id, property } => {
                if let Some(plan) = self
                    .document()
                    .and_then(|doc| doc.nodes.get(node_id))
                    .and_then(|node| {
                        crate::inspector_design::paint_command(
                            node,
                            self.scene.as_ref().and_then(|scene| scene.item(node_id)),
                            property,
                            &edit.buffer.text,
                        )
                    })
                {
                    match plan {
                        Ok(command) => command,
                        Err(error) => {
                            self.error = Some(error);
                            self.editing = Some(edit);
                            return;
                        }
                    }
                } else {
                    let value = if property == "opacity" {
                        match crate::inspector_design::percent(&edit.buffer.text) {
                            Ok(value) => json!(value),
                            Err(error) => {
                                self.error = Some(error);
                                self.editing = Some(edit);
                                return;
                            }
                        }
                    } else if matches!(
                        property.as_str(),
                        "x" | "y"
                            | "width"
                            | "height"
                            | "fontSize"
                            | "opacity"
                            | "rotation"
                            | "strokeWidth"
                            | "cornerRadius"
                            | "fontWeight"
                            | "lineHeight"
                            | "letterSpacing"
                    ) {
                        match edit.buffer.text.parse::<f64>() {
                            Ok(n) if n.is_finite() => json!(n),
                            _ => {
                                self.error =
                                    Some("Enter a finite number for this property.".into());
                                self.editing = Some(edit);
                                return;
                            }
                        }
                    } else {
                        json!(edit.buffer.text)
                    };
                    if property == "fill" || property == "stroke" {
                        json!({"type":"batch","commands":[{"type":"node.unset","nodeId":node_id,"properties":[if property=="fill"{"fills"}else{"strokes"}]},{"type":"node.set","nodeId":node_id,"properties":{property:value}}]})
                    } else {
                        let mut properties = json!({property:value});
                        if matches!(property.as_str(), "width" | "height")
                            && let Some(node) =
                                self.document().and_then(|doc| doc.nodes.get(node_id))
                            && node.properties.get("inspectorAspectRatio")
                                == Some(&Value::Bool(true))
                            && let Some(item) =
                                self.scene.as_ref().and_then(|scene| scene.item(node_id))
                        {
                            let (other, before, other_before) = if property == "width" {
                                ("height", item.width, item.height)
                            } else {
                                ("width", item.height, item.width)
                            };
                            if before > 0.
                                && let Some(value) = value.as_f64()
                            {
                                properties[other] = json!(value * other_before / before);
                            }
                        }
                        json!({"type":"node.set","nodeId":node_id,"properties":properties})
                    }
                }
            }
            EditTarget::Text { node_id } => {
                let (start, end, replacement) = edit.buffer.replacement();
                let mut commands = vec![];
                if end > start {
                    commands.push(
                        json!({"type":"text.delete","nodeId":node_id,"start":start,"end":end}),
                    );
                }
                if !replacement.is_empty() {
                    commands.push(json!({"type":"text.insert","nodeId":node_id,"offset":start,"text":replacement,"attributes":{}}));
                }
                json!({"type":"batch","commands":commands})
            }
        };
        self.recovery_text = Some(edit.buffer.text.clone());
        self.pending = true;
        self.status = "Saving…".into();
        self.send(Request::Command {
            id: edit.id,
            epoch: edit.epoch,
            sequence: edit.sequence,
            command,
            undo_group: format!("text_{}", Uuid::new_v4()),
        });
    }
    fn copy_selection(&mut self, cut: bool) {
        if let Some(edit) = &mut self.editing {
            if let Some(clip) = &mut self.clipboard {
                let text = edit.buffer.selected_text().to_string();
                if let Err(e) = clip.set_text(text) {
                    self.error = Some(format!("Clipboard unavailable: {e}"));
                    return;
                }
                if cut {
                    edit.buffer.insert("");
                }
            }
            return;
        }
        if let Some(doc) = self.document() {
            let nodes: Vec<Node> = self
                .selected
                .iter()
                .filter_map(|id| doc.nodes.get(id).cloned())
                .collect();
            if let Some(clip) = &mut self.clipboard {
                match clip.set_text(json!({"format":"omc.clipboard/1","nodes":nodes}).to_string()) {
                    Ok(()) => {
                        if cut {
                            self.action(Action::Delete);
                        }
                    }
                    Err(e) => self.error = Some(format!("Clipboard unavailable: {e}")),
                }
            }
        }
    }
    fn paste(&mut self) {
        let Some(clip) = &mut self.clipboard else {
            self.error = Some("The system clipboard is unavailable.".into());
            return;
        };
        let text = match clip.get_text() {
            Ok(text) => text,
            Err(e) => {
                self.error = Some(format!("Clipboard unavailable: {e}"));
                return;
            }
        };
        if text.len() > 1024 * 1024 {
            self.error = Some("Clipboard text exceeds the one MiB input limit.".into());
            return;
        }
        if let Some(edit) = &mut self.editing {
            edit.buffer.insert(&text);
            return;
        }
        if let Ok(value) = serde_json::from_str::<Value>(&text)
            && value.get("format").and_then(Value::as_str) == Some("omc.clipboard/1")
            && let Ok(nodes) = serde_json::from_value::<Vec<Node>>(
                value.get("nodes").cloned().unwrap_or(Value::Null),
            )
        {
            if nodes.len() > 100 {
                self.error =
                    Some("Copy at most 100 selected nodes in one clipboard transaction.".into());
                return;
            }
            let ids: BTreeMap<String, String> = nodes
                .iter()
                .map(|n| (n.id.clone(), format!("node_{}", Uuid::new_v4().simple())))
                .collect();
            let parent = self.current_root();
            let mut commands = vec![];
            for mut node in nodes {
                node.id = ids[&node.id].clone();
                node.parent_id = node
                    .parent_id
                    .as_ref()
                    .and_then(|id| ids.get(id))
                    .cloned()
                    .or_else(|| parent.clone());
                node.home_shard = format!("shard_{}", Uuid::new_v4().simple());
                for key in ["x", "y"] {
                    let n = node
                        .properties
                        .get(key)
                        .and_then(Value::as_f64)
                        .unwrap_or(0.);
                    node.properties.insert(key.into(), json!(n + 24.));
                }
                commands.push(json!({"type":"node.create","node":node}));
            }
            self.mutate(json!({"type":"batch","commands":commands}), "paste");
            return;
        }
        self.create_node(Tool::Text, (60., 60.), (340., 140.), Some(text));
    }
    fn current_root(&self) -> Option<String> {
        let doc = self.document()?;
        doc.pages
            .iter()
            .find(|p| Some(&p.id) == self.page.as_ref())
            .or_else(|| doc.pages.first())
            .map(|p| p.root_node_id.clone())
    }
    fn create_node(
        &mut self,
        tool: Tool,
        origin: (f64, f64),
        end: (f64, f64),
        text: Option<String>,
    ) {
        let Some(parent) = self.current_root() else {
            return;
        };
        let id = format!("node_{}", Uuid::new_v4().simple());
        let kind = match tool {
            Tool::Frame => "frame",
            Tool::Rect => "rect",
            Tool::Ellipse => "ellipse",
            Tool::Text => "text",
            _ => return,
        };
        let width = (end.0 - origin.0)
            .abs()
            .max(if tool == Tool::Text { 200. } else { 2. });
        let height = (end.1 - origin.1)
            .abs()
            .max(if tool == Tool::Text { 48. } else { 2. });
        let mut props = json!({"name":tool.label(),"x":origin.0.min(end.0),"y":origin.1.min(end.1),"width":width,"height":height,"fill":if tool==Tool::Text{"#1F2937"}else if tool==Tool::Frame{"#FFFFFF"}else{"#A8B5F7"}});
        if tool == Tool::Text {
            props["text"] = json!(text.unwrap_or_else(|| "Type something".into()));
            props["fontSize"] = json!(24.);
        }
        let Some(doc) = self.document() else {
            return;
        };
        let (mut commands, rank) = match crate::commands::append_rank(doc, &parent) {
            Ok(v) => v,
            Err(error) => {
                self.error = Some(error);
                return;
            }
        };
        let node = json!({"id":id,"kind":kind,"parentId":parent,"rank":rank,"homeShard":format!("shard_{}",Uuid::new_v4().simple()),"properties":props});
        commands.push(json!({"type":"node.create","node":node}));
        self.selected.clear();
        self.selected.insert(id);
        self.mutate(json!({"type":"batch","commands":commands}), "draw");
        self.tool = Tool::Select;
    }
    fn show_prototype_frame(&mut self, id: String) -> bool {
        let Some(frame) = self
            .scene
            .as_ref()
            .and_then(|scene| scene.item(&id))
            .filter(|frame| !frame.hidden)
        else {
            self.error = Some("Wait for the preview frame to render.".into());
            return false;
        };
        let rect = self.canvas_rect();
        self.camera.fit(frame.bounds, rect.width, rect.height);
        self.prototype_frame = Some(id);
        true
    }

    fn pointer_down(&mut self, button: MouseButton, canvas_only: bool) {
        let (x, y) = self.cursor;
        if button == MouseButton::Left {
            self.keyboard_focus_visible = false;
            if crate::text_ui::editor_rect(self).is_some_and(|area| area.contains(x, y)) {
                crate::text_ui::pointer(self, x, y, self.modifiers.shift_key());
                self.drag = Some(Drag::TextSelection);
                return;
            }
            if !canvas_only
                && let Some(control) = self
                    .controls
                    .iter()
                    .rev()
                    .find(|c| self.action_available(&c.action) && c.rect.contains(x, y))
                    .cloned()
            {
                self.focus = control.id;
                self.action(control.action);
                return;
            }
            if let Some(frame) = self.prototype_frame.as_deref() {
                if self.canvas_rect().contains(x, y)
                    && let (Some(doc), Some(page), Some(scene)) =
                        (self.document(), self.page.as_deref(), self.scene.as_deref())
                {
                    let world = self.world(x, y);
                    let target =
                        crate::prototype::hit_target(doc, page, scene, frame, world.0, world.1)
                            .map(|node| node.id.clone());
                    if let Some(target) = target {
                        self.show_prototype_frame(target);
                    }
                }
                return;
            }
            self.popup = None;
            if !canvas_only && y < HEADER {
                if let Some(window) = &self.window {
                    let _ = window.drag_window();
                }
                return;
            }
        }
        if self.prototype_frame.is_some()
            || !canvas_only
                && crate::paint::palette_rect(self).is_some_and(|area| area.contains(x, y))
        {
            return;
        }
        if !canvas_only && !self.canvas_rect().contains(x, y) {
            self.commit_edit();
            return;
        }
        let world = self.world(x, y);
        if matches!(
            button,
            MouseButton::Middle | MouseButton::Back | MouseButton::Forward
        ) || button == MouseButton::Left && (self.space_pan || self.tool == Tool::Pan)
        {
            self.drag = Some(Drag::Pan {
                origin: (x, y),
                camera: self.camera,
            });
            return;
        }
        if button != MouseButton::Left {
            return;
        }
        self.commit_edit();
        if self.pending || self.pending_move.is_some() {
            return;
        }
        let inspect = self.inspector == Inspector::Inspect;
        if !inspect
            && self.tool == Tool::Select
            && self.selected.len() == 1
            && self.begin_resize(world)
        {
            return;
        }
        if !inspect && self.tool != Tool::Select {
            self.drag = Some(Drag::Draw {
                origin: world,
                end: world,
                tool: self.tool,
            });
            return;
        }
        let hit = self
            .scene
            .as_ref()
            .and_then(|s| s.hit_test(world.0, world.1))
            .map(|n| {
                n.properties
                    .get("instanceId")
                    .and_then(Value::as_str)
                    .unwrap_or(&n.id)
                    .to_string()
            })
            .filter(|id| Some(id) != self.current_root().as_ref());
        if inspect {
            if !self.modifiers.shift_key() {
                self.selected.clear();
            }
            if let Some(id) = hit {
                self.selected.insert(id);
            }
            self.inspector_scroll = 0.;
            return;
        }
        let double = self.last_click.is_some_and(|(at, pos)| {
            at.elapsed() < Duration::from_millis(400)
                && (pos.0 - x).abs() < 5.
                && (pos.1 - y).abs() < 5.
        });
        self.last_click = Some((Instant::now(), (x, y)));
        if let Some(id) = hit {
            if double {
                self.selected.clear();
                self.selected.insert(id.clone());
                self.begin_text(id);
                return;
            }
            if !self.modifiers.shift_key() && !self.selected.contains(&id) {
                self.selected.clear();
            }
            self.selected.insert(id);
            if let Some(doc) = self.document() {
                let positions = self
                    .selected
                    .iter()
                    .filter(|id| self.layer_transformable(id))
                    .filter_map(|id| {
                        doc.nodes
                            .get(id)
                            .map(|n| (id.clone(), number(n, "x", 0.), number(n, "y", 0.)))
                    })
                    .collect();
                self.drag = Some(Drag::Move {
                    origin: world,
                    positions,
                    delta: (0., 0.),
                });
            }
        } else {
            if !self.modifiers.shift_key() {
                self.selected.clear();
            }
            self.drag = Some(Drag::Marquee {
                origin: world,
                end: world,
            });
        }
    }
    pub fn layer_transformable(&self, id: &str) -> bool {
        let Some(scene) = &self.scene else {
            return false;
        };
        let Some(mut item) = scene.item(id) else {
            return false;
        };
        loop {
            if item.hidden || item.locked {
                return false;
            }
            let Some(parent) = item.parent else {
                return true;
            };
            item = &scene.items[parent];
        }
    }
    fn begin_resize(&mut self, world: (f64, f64)) -> bool {
        let (Some(scene), Some(node)) = (&self.scene, self.node()) else {
            return false;
        };
        let Some(item) = scene.item(&node.id) else {
            return false;
        };
        let [a, b, c, d, _, _] = item.world.0;
        if b.abs() > 1e-8
            || c.abs() > 1e-8
            || a <= 0.
            || d <= 0.
            || !self.layer_transformable(&node.id)
        {
            return false;
        }
        let [left, top, width, height] = item.bounds;
        for (cx, cy, west, north) in [
            (left, top, true, true),
            (left + width, top, false, true),
            (left, top + height, true, false),
            (left + width, top + height, false, false),
        ] {
            if (world.0 - cx).abs() < 7. / self.camera.zoom
                && (world.1 - cy).abs() < 7. / self.camera.zoom
            {
                let inverse = item
                    .parent
                    .map(|p| scene.items[p].world)
                    .unwrap_or(omc_scene::Affine::IDENTITY)
                    .inverse()
                    .unwrap_or(omc_scene::Affine::IDENTITY);
                let original = [
                    number(node, "x", 0.),
                    number(node, "y", 0.),
                    item.width,
                    item.height,
                ];
                self.drag = Some(Drag::Resize {
                    id: node.id.clone(),
                    origin: world,
                    inverse,
                    original,
                    preview: original,
                    west,
                    north,
                });
                return true;
            }
        }
        false
    }
    fn pointer_move(&mut self, x: f64, y: f64) {
        self.cursor = (x, y);
        if matches!(self.drag, Some(Drag::TextSelection)) {
            crate::text_ui::pointer(self, x, y, true);
            return;
        }
        let world = self.world(x, y);
        if let Some(drag) = &mut self.drag {
            match drag {
                Drag::TextSelection => {}
                Drag::Resize {
                    origin,
                    inverse,
                    original,
                    preview,
                    west,
                    north,
                    ..
                } => {
                    let p = inverse.point(world.0, world.1);
                    let from = inverse.point(origin.0, origin.1);
                    *preview = crate::geometry::resize(
                        *original,
                        (p.0 - from.0, p.1 - from.1),
                        *west,
                        *north,
                        self.modifiers.shift_key(),
                    );
                }
                Drag::Pan { origin, camera } => {
                    self.camera.x = camera.x + x - origin.0;
                    self.camera.y = camera.y + y - origin.1;
                    self.pan_view = true;
                }
                Drag::Move { origin, delta, .. } => {
                    *delta = (world.0 - origin.0, world.1 - origin.1)
                }
                Drag::Draw { end, .. } | Drag::Marquee { end, .. } => *end = world,
            }
        }
    }
    fn pointer_up(&mut self) {
        let Some(drag) = self.drag.take() else {
            return;
        };
        match drag {
            Drag::TextSelection => {}
            Drag::Resize {
                id,
                original,
                preview,
                ..
            } => {
                if original != preview {
                    self.mutate(json!({"type":"node.set","nodeId":id,"properties":{"x":preview[0],"y":preview[1],"width":preview[2],"height":preview[3]}}),"resize");
                }
            }
            Drag::Pan { .. } => self.remember_camera(),
            Drag::Draw { origin, end, tool } => {
                if (origin.0 - end.0).abs() + (origin.1 - end.1).abs() > 3. {
                    self.create_node(tool, origin, end, None);
                }
            }
            Drag::Move {
                positions, delta, ..
            } => {
                if delta.0.abs() + delta.1.abs() > 0.1 {
                    let translations = self.move_translations(&positions, delta);
                    let commands: Vec<_> = positions.into_iter().filter_map(|(id, x, y)| {
                        let (dx, dy) = translations.get(&id)?;
                        Some(json!({"type":"node.set","nodeId":id,"properties":{"x":x+dx,"y":y+dy}}))
                    }).collect();
                    if !commands.is_empty()
                        && !self.pending
                        && let Some(sequence) = self.document().map(|doc| doc.sequence)
                    {
                        self.mutate(json!({"type":"batch","commands":commands}), "drag");
                        if self.pending {
                            self.pending_move = Some(PendingMove {
                                sequence,
                                translations,
                                delta,
                            });
                            return;
                        }
                    }
                }
                self.move_cache.get_mut().clear();
            }
            Drag::Marquee { origin, end } => {
                let (x0, y0, x1, y1) = (
                    origin.0.min(end.0),
                    origin.1.min(end.1),
                    origin.0.max(end.0),
                    origin.1.max(end.1),
                );
                if let Some(scene) = &self.scene {
                    for item in &scene.items {
                        let [x, y, w, h] = item.bounds;
                        if x >= x0 && y >= y0 && x + w <= x1 && y + h <= y1 {
                            self.selected.insert(item.id.clone());
                        }
                    }
                }
            }
        }
    }

    fn wheel(&mut self, delta: MouseScrollDelta, scale: f64, phase: TouchPhase) -> bool {
        let (dx, dy) = scroll_delta(delta, scale, self.modifiers.shift_key());
        if self.prototype_frame.is_some()
            && self.canvas_rect().contains(self.cursor.0, self.cursor.1)
        {
            return false;
        }
        let canvas = self.canvas_rect();
        let under_cursor = scroll_target_at(canvas, self.inspector_visible(), self.cursor);
        let target = if matches!(delta, MouseScrollDelta::PixelDelta(_)) {
            if phase == TouchPhase::Started || self.scroll_target.is_none() {
                self.scroll_target = Some(under_cursor);
            }
            let target = self.scroll_target.unwrap_or(under_cursor);
            if matches!(phase, TouchPhase::Ended | TouchPhase::Cancelled) {
                self.scroll_target = None;
            }
            target
        } else {
            self.scroll_target = None;
            under_cursor
        };
        if !dx.is_finite() || !dy.is_finite() || (dx == 0. && dy == 0.) {
            return false;
        }
        match target {
            ScrollTarget::Layers if dy != 0. => {
                let max_scroll = self.visible_layers.len().saturating_sub(1);
                self.layer_scroll = if dy < 0. {
                    (self.layer_scroll + 3).min(max_scroll)
                } else {
                    self.layer_scroll.saturating_sub(3)
                };
            }
            ScrollTarget::Inspector if dy != 0. => {
                let max = crate::inspector::max_scroll(self);
                let current = self.inspector_scroll.min(max);
                let next = (current - dy).clamp(0., max);
                self.inspector_scroll = next;
                return next != current;
            }
            ScrollTarget::Canvas if self.drag.is_none() => {
                if self.modifiers.control_key() || self.modifiers.super_key() {
                    self.pan_view = false;
                    self.camera.zoom_at(
                        (dy * 0.005).exp(),
                        self.cursor.0 - canvas.x,
                        self.cursor.1 - canvas.y,
                    );
                } else {
                    self.camera.x += dx;
                    self.camera.y += dy;
                    self.pan_view = true;
                }
                self.remember_camera();
            }
            _ => return false,
        }
        true
    }
    fn keyboard(&mut self, event: &winit::event::KeyEvent) {
        self.key_input(
            &event.logical_key,
            event.text.as_deref(),
            event.state == ElementState::Pressed,
        );
    }

    fn key_input(&mut self, key: &Key, text: Option<&str>, down: bool) {
        if *key == Key::Named(NamedKey::Space) && self.editing.is_none() {
            self.space_pan = down;
        }
        if !down {
            return;
        }
        let command = self.modifiers.control_key() || self.modifiers.super_key();
        if self.prototype_frame.is_some() {
            match *key {
                Key::Named(NamedKey::Escape) => {
                    self.action(Action::PrototypeExit);
                    return;
                }
                Key::Named(NamedKey::Tab) if !command => {
                    if let Some(exit) = self
                        .controls
                        .iter()
                        .find(|control| matches!(control.action, Action::PrototypeExit))
                    {
                        self.focus = exit.id;
                        self.keyboard_focus_visible = true;
                    }
                    return;
                }
                Key::Named(NamedKey::Enter) if !command => {}
                _ => return,
            }
        }
        if let Some(edit) = &mut self.editing {
            match key {
                Key::Named(NamedKey::Escape) => {
                    self.editing = None;
                    return;
                }
                Key::Named(NamedKey::Enter) if !edit.buffer.composing => {
                    if self.modifiers.shift_key() && matches!(edit.target, EditTarget::Text { .. })
                    {
                        edit.buffer.insert("\n");
                    } else {
                        self.commit_edit();
                    }
                    return;
                }
                Key::Named(NamedKey::Backspace) if !edit.buffer.composing => {
                    edit.buffer.backspace()
                }
                Key::Named(NamedKey::Delete) if !edit.buffer.composing => edit.buffer.delete(),
                Key::Named(NamedKey::ArrowLeft) => {
                    edit.buffer.move_left(self.modifiers.shift_key())
                }
                Key::Named(NamedKey::ArrowRight) => {
                    edit.buffer.move_right(self.modifiers.shift_key())
                }
                Key::Named(NamedKey::Home) => {
                    edit.buffer.caret = 0;
                    if !self.modifiers.shift_key() {
                        edit.buffer.anchor = 0;
                    }
                }
                Key::Named(NamedKey::End) => {
                    edit.buffer.caret = edit.buffer.text.len();
                    if !self.modifiers.shift_key() {
                        edit.buffer.anchor = edit.buffer.caret;
                    }
                }
                Key::Character(key) if command => match key.to_lowercase().as_str() {
                    "a" => edit.buffer.select_all(),
                    "c" => self.copy_selection(false),
                    "x" => self.copy_selection(true),
                    "v" => self.paste(),
                    _ => {}
                },
                _ => {
                    if !command
                        && !edit.buffer.composing
                        && let Some(text) = text
                        && !text.chars().any(|c| c.is_control())
                    {
                        edit.buffer.insert(text);
                    }
                }
            }
            return;
        }
        if self.modifiers.control_key()
            && *key == Key::Named(NamedKey::Tab)
            && !self.tabs.is_empty()
        {
            let offset = if self.modifiers.shift_key() {
                self.tabs.len() - 1
            } else {
                1
            };
            let index = self
                .tabs
                .iter()
                .position(|id| Some(id) == self.active.as_ref())
                .map_or(0, |index| (index + offset) % self.tabs.len());
            self.action(Action::Open(self.tabs[index].clone()));
            return;
        }
        if command {
            if let Key::Character(key) = key {
                match key.to_lowercase().as_str() {
                    "n" => self.action(Action::New),
                    "s" => self.action(Action::Save),
                    "z" => self.action(if self.modifiers.shift_key() {
                        Action::Redo
                    } else {
                        Action::Undo
                    }),
                    "y" => self.action(Action::Redo),
                    "a" => self.action(Action::SelectAll),
                    "c" => self.copy_selection(false),
                    "x" if self.inspector != Inspector::Inspect => self.copy_selection(true),
                    "v" if self.inspector == Inspector::Inspect => {}
                    "v" if self.modifiers.shift_key() => self.action(Action::ImportHtml),
                    "v" => self.paste(),
                    "0" => self.action(Action::Fit),
                    _ => {}
                }
            }
            return;
        }
        match key {
            Key::Named(NamedKey::Escape) => {
                self.popup = None;
                self.drag = None;
                self.drag_button = None;
                self.move_cache.get_mut().clear();
                self.selected.clear();
                self.tool = Tool::Select;
            }
            Key::Named(NamedKey::Delete) | Key::Named(NamedKey::Backspace) => {
                self.action(Action::Delete)
            }
            Key::Named(
                arrow @ (NamedKey::ArrowLeft
                | NamedKey::ArrowRight
                | NamedKey::ArrowUp
                | NamedKey::ArrowDown),
            ) => {
                let step = if self.modifiers.shift_key() { 10. } else { 1. };
                let delta = match arrow {
                    NamedKey::ArrowLeft => (-step, 0.),
                    NamedKey::ArrowRight => (step, 0.),
                    NamedKey::ArrowUp => (0., -step),
                    _ => (0., step),
                };
                if self.selected.is_empty() {
                    self.camera.x -= delta.0 * 20.;
                    self.camera.y -= delta.1 * 20.;
                    self.pan_view = true;
                    self.remember_camera();
                } else {
                    self.nudge_selection(delta);
                }
            }
            Key::Named(NamedKey::Tab) => {
                self.keyboard_focus_visible = true;
                let current = self
                    .controls
                    .iter()
                    .position(|c| c.id == self.focus)
                    .unwrap_or(0);
                if !self.controls.is_empty() {
                    let delta = if self.modifiers.shift_key() {
                        self.controls.len() - 1
                    } else {
                        1
                    };
                    let mut index = (current + delta) % self.controls.len();
                    for _ in 0..self.controls.len() {
                        let control = &self.controls[index];
                        if self.action_available(&control.action) {
                            self.focus = control.id;
                            break;
                        }
                        index = (index + delta) % self.controls.len();
                    }
                }
            }
            Key::Named(NamedKey::Enter) => {
                if let Some(c) = self.controls.iter().find(|c| c.id == self.focus).cloned() {
                    self.action(c.action);
                }
            }
            Key::Character(key) => match key.to_lowercase().as_str() {
                "v" => self.action(Action::Tool(Tool::Select)),
                "f" => self.action(Action::Tool(Tool::Frame)),
                "r" => self.action(Action::Tool(Tool::Rect)),
                "o" => self.action(Action::Tool(Tool::Ellipse)),
                "t" => self.action(Action::Tool(Tool::Text)),
                "h" => self.action(Action::Tool(Tool::Pan)),
                "1" => self.camera = Camera::default(),
                _ => {}
            },
            _ => {}
        }
    }
    fn nudge_selection(&mut self, delta: (f64, f64)) {
        let Some(doc) = self.document() else {
            return;
        };
        let positions: Vec<_> = self
            .selected
            .iter()
            .filter(|id| self.layer_transformable(id) && Some(*id) != self.current_root().as_ref())
            .filter_map(|id| {
                doc.nodes
                    .get(id)
                    .map(|node| (id.clone(), number(node, "x", 0.), number(node, "y", 0.)))
            })
            .collect();
        let translations = self.move_translations(&positions, delta);
        let commands: Vec<_> = positions
            .into_iter()
            .filter_map(|(id, x, y)| {
                let (dx, dy) = translations.get(&id)?;
                Some(json!({"type":"node.set","nodeId":id,"properties":{"x":x+dx,"y":y+dy}}))
            })
            .collect();
        if !commands.is_empty() {
            self.mutate(json!({"type":"batch","commands":commands}), "nudge");
        }
    }

    fn handle_response(&mut self, response: Response) {
        let automation_edit = self.automation.waiting.is_some();
        let automation_error = match &response {
            Response::Error {
                message,
                mutation: true,
            } if automation_edit => Some(message.clone()),
            _ => None,
        };
        match response {
            Response::Collaboration { action, result } => {
                if action != "cursor" {
                    self.collaboration_pending = false;
                }
                match result {
                    Ok((state, document)) => {
                        if action != "join"
                            && state["documentId"]
                                .as_str()
                                .and_then(|id| uuid::Uuid::parse_str(id).ok())
                                .map(|id| format!("doc_{}", id.simple()))
                                != self.collaboration_document
                        {
                            return;
                        }
                        if let Some(document) = document {
                            self.collaboration_document = Some(document.id.clone());
                            self.handle_response(Response::Snapshot {
                                document,
                                mutation: false,
                                activate: true,
                            });
                        }
                        if action == "invite" {
                            let copied = state["invite"].as_str().and_then(|link| {
                                self.clipboard.as_mut().map(|clip| clip.set_text(link))
                            });
                            match copied {
                                Some(Ok(())) => {
                                    self.status =
                                        "Invitation copied. Anyone with it can edit.".into()
                                }
                                _ => self.error = Some("Could not copy the invitation.".into()),
                            }
                        } else {
                            self.collaboration = state;
                        }
                    }
                    Err(error) if action != "cursor" => self.error = Some(error),
                    Err(_) => {}
                }
            }
            Response::Connected => {
                self.service_connected = true;
                self.error = None;
                self.status = "Ready".into();
                self.send(Request::Refresh);
            }
            Response::Documents(documents) => {
                self.documents = documents;
                if self.active.is_none()
                    && !self.library_open
                    && let Some(doc) = self.documents.iter().find(|d| !d.archived)
                {
                    self.send(Request::Open { id: doc.id.clone() });
                }
            }
            Response::Snapshot {
                document,
                mutation,
                activate,
            } => {
                self.poll_pending = false;
                if mutation {
                    self.pending = false;
                    self.recovery_text = None;
                    self.status = "Saved".into();
                    if self.text_splice_inflight {
                        self.text_splice_inflight = false;
                        if let Some(edit) = &mut self.editing
                            && let EditTarget::Text { node_id } = &edit.target
                            && let Some(node) = document.nodes.get(node_id)
                        {
                            let text = node
                                .properties
                                .get("text")
                                .and_then(Value::as_str)
                                .unwrap_or("")
                                .to_string();
                            edit.buffer = EditBuffer::new(text, false);
                            edit.epoch = document.epoch.clone();
                            edit.sequence = document.sequence;
                        }
                    }
                }
                let id = document.id.clone();
                let changed = self.snapshots.get(&id).is_none_or(|old| {
                    old.sequence != document.sequence || old.epoch != document.epoch
                });
                if !self.tabs.contains(&id) {
                    self.tabs.push(id.clone());
                }
                if let Some(entry) = self.documents.iter_mut().find(|d| d.id == id) {
                    entry.title = document.title.clone();
                } else {
                    self.documents.push(DocumentEntry {
                        id: id.clone(),
                        title: document.title.clone(),
                        archived: false,
                    });
                }
                self.snapshots.insert(id.clone(), Arc::new(document));
                if (self.active.is_none() && !self.library_open) || activate {
                    self.switch(id.clone());
                }
                if self.active.as_ref() == Some(&id) && changed {
                    self.schedule_scene();
                }
            }
            Response::TextAnchors {
                id,
                node_id,
                selection,
            } => {
                self.ime_capture_pending = false;
                if self.editing.as_ref().is_some_and(|edit|edit.id==id&&matches!(&edit.target,EditTarget::Text{node_id:target} if target==&node_id)){
          self.ime_selection=Some(selection);if self.ime_commit.is_some(){self.flush_ime_commit();}
        }
            }
            Response::Saved { id } => {
                if self.active.as_ref() == Some(&id) {
                    self.status = "Saved".into();
                }
            }
            Response::Closed { id } => {
                self.tabs.retain(|tab| tab != &id);
                self.snapshots.remove(&id);
                if self.active.as_ref() == Some(&id) {
                    self.active = None;
                    self.scene = None;
                    self.scene_cache.get_mut().clear();
                    self.pan_cache.get_mut().clear();
                    self.pan_view = false;
                    if let Some(id) = self.tabs.last().cloned() {
                        self.switch(id);
                    }
                }
            }
            Response::FileOperation { message } => {
                self.pending = false;
                self.status = message;
            }
            Response::Error { message, mutation } => {
                self.poll_pending = false;
                self.ime_capture_pending = false;
                self.ime_selection = None;
                self.ime_commit = None;
                if mutation {
                    self.pending = false;
                    self.text_splice_inflight = false;
                    self.status = "Edit not saved".into();
                    self.pending_move = None;
                    self.move_cache.get_mut().clear();
                }
                self.error = Some(message);
            }
            Response::Shutdown => {
                self.closing = true;
            }
        }
        if automation_edit && !self.pending {
            self.finish_automation(automation_error);
        }
        self.redraw();
    }
    fn shutdown(&mut self) {
        if self.closing {
            return;
        }
        if self.editing.is_some() {
            self.commit_edit();
        }
        if self.pending {
            self.error = Some(
                "Your edit is still saving. Close the window again after it completes.".into(),
            );
            return;
        }
        self.closing = true;
        self.close_started = Some(Instant::now());
        self.status = "Closing documents…".into();
        self.send(Request::Shutdown);
    }
}

pub fn number(node: &Node, key: &str, fallback: f64) -> f64 {
    node.properties
        .get(key)
        .and_then(Value::as_f64)
        .unwrap_or(fallback)
}
pub fn node_name(node: &Node) -> String {
    node.properties
        .get("name")
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| format!("{:?}", node.kind))
}

impl ApplicationHandler<Event> for App {
    fn resumed(&mut self, event_loop: &ActiveEventLoop) {
        if self.window.is_some() {
            return;
        }
        let monitor = event_loop
            .primary_monitor()
            .or_else(|| event_loop.available_monitors().next());
        let size = monitor
            .map(|monitor| {
                let scale = monitor.scale_factor();
                let size = monitor.size();
                (
                    (size.width as f64 / scale - 40.).clamp(760., 1440.),
                    (size.height as f64 / scale - 64.).clamp(520., 900.),
                )
            })
            .unwrap_or((1440., 900.));
        let size = self.smoke_size.map_or(size, |(width, height)| {
            (f64::from(width), f64::from(height))
        });
        let attrs = Window::default_attributes()
            .with_title("Oh My Canvas — native preview")
            .with_visible(false)
            .with_inner_size(LogicalSize::new(size.0, size.1))
            .with_min_inner_size(LogicalSize::new(760., 520.));
        #[cfg(target_os = "macos")]
        let attrs = {
            use winit::platform::macos::WindowAttributesExtMacOS;
            attrs
                .with_titlebar_transparent(true)
                .with_title_hidden(true)
                .with_fullsize_content_view(true)
        };
        let window = match event_loop.create_window(attrs) {
            Ok(w) => Rc::new(w),
            Err(e) => {
                eprintln!("Native window failed: {e}");
                self.smoke_failed = true;
                event_loop.exit();
                return;
            }
        };
        #[cfg(target_os = "macos")]
        let use_gpu = match crate::gpu_presenter::MetalPresenter::new(&window) {
            Ok(presenter) => {
                self.gpu_presenter = Some(presenter);
                window.set_title("Oh My Canvas — Metal preview");
                eprintln!("Native presentation: Metal");
                true
            }
            Err(error) => {
                eprintln!("Metal unavailable, using software presentation: {error}");
                false
            }
        };
        #[cfg(not(target_os = "macos"))]
        let use_gpu = false;
        if !use_gpu {
            let context = match softbuffer::Context::new(window.clone()) {
                Ok(c) => c,
                Err(e) => {
                    eprintln!("Native surface context failed: {e}");
                    self.smoke_failed = true;
                    event_loop.exit();
                    return;
                }
            };
            self.surface = match softbuffer::Surface::new(&context, window.clone()) {
                Ok(s) => Some(s),
                Err(e) => {
                    eprintln!("Native surface failed: {e}");
                    self.smoke_failed = true;
                    event_loop.exit();
                    return;
                }
            };
        }
        self.access = Some(accesskit_winit::Adapter::with_event_loop_proxy(
            event_loop,
            &window,
            self.proxy.clone(),
        ));
        window.set_ime_allowed(false);
        window.set_visible(true);
        window.request_redraw();
        self.window = Some(window);
    }
    fn user_event(&mut self, event_loop: &ActiveEventLoop, event: Event) {
        match event {
            Event::Service(Response::Shutdown) => event_loop.exit(),
            Event::Service(response) => self.handle_response(response),
            Event::Automation(job, reply) => self.handle_automation(job, reply),
            Event::Scene(reply) => {
                self.scene_pending = false;
                if self.active.as_ref() == Some(&reply.id)
                    && self.page == reply.page
                    && self
                        .document()
                        .is_some_and(|d| d.epoch == reply.epoch && d.sequence == reply.sequence)
                {
                    match reply.result {
                        Ok(scene) => {
                            self.scene_cache.get_mut().clear();
                            self.pan_cache.get_mut().clear();
                            self.move_cache.get_mut().clear();
                            if self
                                .pending_move
                                .as_ref()
                                .is_some_and(|preview| preview.sequence != reply.sequence)
                            {
                                self.pending_move = None;
                            }
                            self.pan_view = false;
                            self.scene_generation = self.scene_generation.wrapping_add(1);
                            self.scene = Some(Arc::new(scene));
                            if let Some(id) = self.prototype_frame.clone()
                                && !self.show_prototype_frame(id)
                            {
                                self.action(Action::PrototypeExit);
                            }
                            self.resources = Arc::new(reply.resources);
                            if let Some(error) = reply.resource_errors.first() {
                                self.error = Some(error.clone());
                            }
                            self.layers = reply.layers;
                            self.refresh_visible_layers();
                        }
                        Err(error) => {
                            self.pending_move = None;
                            self.move_cache.get_mut().clear();
                            self.error = Some(error);
                        }
                    }
                } else {
                    self.schedule_scene();
                }
                self.redraw();
                self.resume_automation();
            }
            Event::PanRasterReady => self.redraw(),
            Event::Accessibility(event) => crate::accessibility::handle(self, event),
        }
    }
    fn window_event(
        &mut self,
        event_loop: &ActiveEventLoop,
        window_id: WindowId,
        event: WindowEvent,
    ) {
        let Some(window) = self.window.as_ref().cloned() else {
            return;
        };
        if window.id() != window_id {
            return;
        }
        if let Some(access) = &mut self.access {
            access.process_event(&window, &event);
        }
        let mut needs_redraw = !matches!(event, WindowEvent::RedrawRequested);
        match event {
            WindowEvent::CloseRequested => self.shutdown(),
            WindowEvent::Occluded(occluded) => {
                self.occluded = occluded;
                needs_redraw = !occluded;
                if occluded {
                    self.input_frame = None;
                }
            }
            WindowEvent::Resized(size) => {
                let scale = window.scale_factor();
                self.width = size.width as f64 / scale;
                self.height = size.height as f64 / scale;
                if let Some(id) = self.prototype_frame.clone() {
                    self.show_prototype_frame(id);
                }
                self.schedule_scene();
            }
            WindowEvent::ScaleFactorChanged { .. } => {
                let size = window.inner_size();
                let scale = window.scale_factor();
                self.width = size.width as f64 / scale;
                self.height = size.height as f64 / scale;
            }
            WindowEvent::ModifiersChanged(modifiers) => self.modifiers = modifiers.state(),
            WindowEvent::CursorMoved { position, .. } => {
                let scale = window.scale_factor();
                let previous = self.cursor;
                if self.automation.gesture.is_none() {
                    self.pointer_move(position.x / scale, position.y / scale);
                }
                match self.drag {
                    Some(Drag::Pan { .. }) => self.trace_input("pan-drag"),
                    Some(Drag::Move { .. }) => self.trace_input("layer-drag"),
                    _ => {}
                }
                needs_redraw = self.drag.is_some()
                    || self.controls.iter().any(|control| {
                        control.rect.contains(previous.0, previous.1)
                            != control.rect.contains(self.cursor.0, self.cursor.1)
                    });
            }
            WindowEvent::CursorLeft { .. } if self.drag.is_none() => {
                self.cursor = (-1., -1.);
            }
            WindowEvent::MouseInput { state, button, .. } => {
                if state == ElementState::Pressed {
                    self.cancel_automation_gesture();
                    if self.drag_button.is_none() {
                        self.pointer_down(button, false);
                        if self.drag.is_some() {
                            self.drag_button = Some(button);
                        }
                    }
                } else if self.drag_button == Some(button) {
                    self.drag_button = None;
                    self.pointer_up();
                }
            }
            WindowEvent::MouseWheel { delta, phase, .. } => {
                needs_redraw = self.wheel(delta, window.scale_factor(), phase);
                if needs_redraw && self.canvas_rect().contains(self.cursor.0, self.cursor.1) {
                    self.trace_input(if matches!(delta, MouseScrollDelta::PixelDelta(_)) {
                        "precise-scroll"
                    } else {
                        "wheel"
                    });
                }
            }
            WindowEvent::PinchGesture { delta, .. } => {
                let r = self.canvas_rect();
                needs_redraw = delta.is_finite()
                    && delta != 0.
                    && self.prototype_frame.is_none()
                    && self.drag.is_none()
                    && r.contains(self.cursor.0, self.cursor.1);
                if needs_redraw {
                    self.pan_view = false;
                    self.camera.zoom_at(
                        (1. + delta).max(0.01),
                        self.cursor.0 - r.x,
                        self.cursor.1 - r.y,
                    );
                    self.remember_camera();
                    self.trace_input("pinch");
                }
            }
            WindowEvent::KeyboardInput { event, .. } => {
                if event.state == ElementState::Pressed {
                    self.cancel_automation_gesture();
                }
                self.keyboard(&event);
            }
            WindowEvent::Ime(Ime::Preedit(text, range)) => {
                if !text.is_empty() {
                    self.capture_ime_selection();
                }
                if let Some(edit) = &mut self.editing {
                    edit.buffer.set_preedit(text, range);
                }
            }
            WindowEvent::Ime(Ime::Commit(text)) => {
                if let Some(edit) = &mut self.editing {
                    edit.buffer.commit_ime(&text);
                }
                if self.ime_selection.is_some() || self.ime_capture_pending {
                    self.ime_commit = Some(text);
                    if self.ime_selection.is_some() {
                        self.flush_ime_commit();
                    }
                }
            }
            WindowEvent::Ime(Ime::Disabled) => {
                if let Some(edit) = &mut self.editing {
                    edit.buffer.set_preedit(String::new(), None);
                }
            }
            WindowEvent::Focused(false) => {
                self.cancel_automation_gesture();
                self.drag = None;
                self.drag_button = None;
                self.scroll_target = None;
                self.move_cache.get_mut().clear();
                self.space_pan = false;
            }
            WindowEvent::RedrawRequested if !self.occluded => {
                let trace = self.input_frame.take();
                let draw_start = Instant::now();
                match crate::paint::draw(self) {
                    Ok(true) => {
                        self.presented = true;
                        self.automation.last_frame =
                            Some(draw_start.elapsed().as_secs_f64() * 1000.);
                        self.automation.frames_drawn =
                            self.automation.frames_drawn.saturating_add(1);
                        if let Some((kind, start)) = trace {
                            eprintln!(
                                "Native frame {kind} input_to_submit_ms={:.3} draw_ms={:.3} camera={:.2},{:.2},{:.3}",
                                start.elapsed().as_secs_f64() * 1000.,
                                draw_start.elapsed().as_secs_f64() * 1000.,
                                self.camera.x,
                                self.camera.y,
                                self.camera.zoom,
                            );
                        }
                    }
                    Ok(false) => {}
                    Err(error) => {
                        eprintln!("Native presentation failed: {error}");
                        self.error = Some(error);
                        self.smoke_failed = true;
                    }
                }
                if let Some(mut access) = self.access.take() {
                    access.update_if_active(|| crate::accessibility::tree(self));
                    self.access = Some(access);
                }
                window.set_ime_allowed(self.editing.is_some());
                if let (Some(edit), Some(area)) = (&self.editing, crate::text_ui::editor_rect(self))
                {
                    let size = if matches!(edit.target, EditTarget::Property { .. }) {
                        13.
                    } else {
                        18.
                    };
                    if let Some(caret) =
                        crate::text_ui::prepare(&edit.buffer, area, size).and_then(|p| p.caret())
                    {
                        window.set_ime_cursor_area(
                            LogicalPosition::new(
                                caret.x,
                                caret.y.clamp(area.y, area.y + area.height),
                            ),
                            LogicalSize::new(2., caret.height),
                        );
                    }
                }
            }
            _ => {}
        }
        if self.closing
            && self
                .close_started
                .is_some_and(|at| at.elapsed() > Duration::from_secs(5))
        {
            event_loop.exit();
        }
        if matches!(self.drag, Some(Drag::Pan { .. }))
            || self.tool == Tool::Pan
            || self.space_pan
            || self.cursor_icon != CursorIcon::Default
        {
            let cursor = if matches!(self.drag, Some(Drag::Pan { .. })) {
                CursorIcon::Grabbing
            } else if (self.tool == Tool::Pan || self.space_pan)
                && self.canvas_rect().contains(self.cursor.0, self.cursor.1)
                && !self
                    .controls
                    .iter()
                    .any(|control| control.rect.contains(self.cursor.0, self.cursor.1))
                && !crate::paint::palette_rect(self)
                    .is_some_and(|area| area.contains(self.cursor.0, self.cursor.1))
            {
                CursorIcon::Grab
            } else {
                CursorIcon::Default
            };
            if cursor != self.cursor_icon {
                window.set_cursor(cursor);
                self.cursor_icon = cursor;
            }
        }
        if needs_redraw {
            self.redraw();
        }
    }
    fn about_to_wait(&mut self, event_loop: &ActiveEventLoop) {
        self.expire_automation_gesture();
        if self
            .smoke
            .is_some_and(|duration| self.start.elapsed() >= duration)
        {
            if !self.presented {
                self.smoke_failed = true;
            }
            if let Some(path) = self.screenshot.take()
                && let Err(e) = crate::paint::screenshot(self, &path)
            {
                eprintln!("Native smoke screenshot failed: {e}");
                self.smoke_failed = true;
            }
            self.shutdown();
            if !self.pending {
                event_loop.exit();
            }
            return;
        }
        if self.closing {
            if self
                .close_started
                .is_some_and(|at| at.elapsed() > Duration::from_secs(5))
            {
                event_loop.exit();
            }
            event_loop.set_control_flow(ControlFlow::WaitUntil(
                Instant::now() + Duration::from_millis(100),
            ));
            return;
        }
        if !self.collaboration_pending
            && !self.pending
            && self.last_presence.elapsed() >= Duration::from_millis(500)
            && matches!(
                self.collaboration["mode"].as_str(),
                Some("hosting" | "connected" | "reconnecting")
            )
            && let Some(id) = self.collaboration_document.as_ref()
        {
            self.last_presence = Instant::now();
            let cursor = if self.active.as_ref() == Some(id)
                && self
                    .window
                    .as_ref()
                    .is_some_and(|window| window.has_focus())
                && self.canvas_rect().contains(self.cursor.0, self.cursor.1)
                && let Some(page) = self.page.as_ref()
            {
                let (x, y) = self.world(self.cursor.0, self.cursor.1);
                json!({"x":x,"y":y,"page":page,"selection":self.selected.iter().take(16).collect::<Vec<_>>()})
            } else {
                Value::Null
            };
            let _ = self.bridge.send(Request::Collaboration {
                action: "cursor",
                args: json!({"documentId":id,"cursor":cursor}),
            });
        }
        if !self.poll_pending
            && !self.pending
            && self.drag.is_none()
            && self.last_poll.elapsed() > Duration::from_millis(750)
            && let Some(id) = &self.active
        {
            self.poll_pending = true;
            self.last_poll = Instant::now();
            self.send(Request::Snapshot { id: id.clone() });
        }
        event_loop.set_control_flow(ControlFlow::WaitUntil(
            Instant::now() + Duration::from_millis(100),
        ));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use winit::dpi::PhysicalPosition;

    #[test]
    fn precise_scroll_keeps_both_fractional_axes_at_retina_scale() {
        let delta = MouseScrollDelta::PixelDelta(PhysicalPosition::new(0.5, -7.5));
        assert_eq!(scroll_delta(delta, 2., false), (0.25, -3.75));
        assert_eq!(scroll_delta(delta, 2., true), (0.25, -3.75));
        assert_eq!(
            scroll_delta(MouseScrollDelta::LineDelta(0., 2.), 2., true),
            (60., 0.)
        );
    }

    #[test]
    fn scroll_routing_respects_the_canvas_chrome_and_sidebar_boundaries() {
        let canvas = Rect::new(222., 48., 478., 568.);
        assert_eq!(
            scroll_target_at(canvas, true, (222., 48.)),
            ScrollTarget::Canvas
        );
        assert_eq!(
            scroll_target_at(canvas, true, (221., 48.)),
            ScrollTarget::Layers
        );
        assert_eq!(
            scroll_target_at(canvas, true, (700., 48.)),
            ScrollTarget::Inspector
        );
        assert_eq!(
            scroll_target_at(canvas, false, (700., 48.)),
            ScrollTarget::Outside
        );
        assert_eq!(
            scroll_target_at(canvas, true, (400., 47.)),
            ScrollTarget::Outside
        );
        assert_eq!(
            scroll_target_at(canvas, true, (400., 616.)),
            ScrollTarget::Outside
        );
    }
}
