use crate::{
    Event,
    client::{Bridge, DocumentEntry, Request, Response},
    geometry::{Camera, Rect},
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
    event::{ElementState, Ime, MouseButton, MouseScrollDelta, WindowEvent},
    event_loop::{ActiveEventLoop, ControlFlow, EventLoopProxy},
    keyboard::{Key, ModifiersState, NamedKey},
    window::{Window, WindowId},
};

pub const HEADER: f64 = 52.0;
pub const LEFT: f64 = 228.0;
pub const RIGHT: f64 = 240.0;
pub const FOOTER: f64 = 30.0;

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
            Self::Pan => "Pan",
        }
    }
}
#[derive(Clone, Debug)]
pub enum Action {
    New,
    Import,
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
    Page(String),
    Field(String),
    RenameDocument,
    Refresh,
    SelectAll,
    Delete,
    Inspector(Inspector),
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
    Text,
    Assets,
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

pub struct LayerRow {
    pub id: String,
    pub name: String,
    pub depth: usize,
    pub has_children: bool,
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
    let mut stack: Vec<(&Node, usize)> = children
        .get(root.as_str())
        .into_iter()
        .flatten()
        .rev()
        .map(|node| (*node, 0))
        .collect();
    let mut seen = BTreeSet::new();
    while let Some((node, depth)) = stack.pop() {
        if !seen.insert(node.id.clone()) {
            continue;
        }
        let kids = children.get(node.id.as_str());
        result.push(LayerRow {
            id: node.id.clone(),
            name: node_name(node),
            depth,
            has_children: kids.is_some_and(|k| !k.is_empty()),
        });
        if let Some(kids) = kids {
            stack.extend(kids.iter().rev().map(|child| (*child, depth + 1)));
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
    pub window: Option<Rc<Window>>,
    pub surface: Option<softbuffer::Surface<Rc<Window>, Rc<Window>>>,
    pub access: Option<accesskit_winit::Adapter>,
    pub proxy: EventLoopProxy<Event>,
    pub bridge: Bridge,
    scene_sender: SyncSender<SceneRequest>,
    scene_pending: bool,
    pub documents: Vec<DocumentEntry>,
    pub tabs: Vec<String>,
    pub snapshots: BTreeMap<String, Arc<DocumentSnapshot>>,
    pub active: Option<String>,
    pub page: Option<String>,
    pub scene: Option<Scene>,
    pub scene_generation: u64,
    pub scene_cache: RefCell<SceneCache>,
    pub resources: BTreeMap<String, Vec<u8>>,
    pub camera: Camera,
    pub cameras: BTreeMap<(String, String), Camera>,
    pub selected: BTreeSet<String>,
    pub tool: Tool,
    pub cursor: (f64, f64),
    pub drag: Option<Drag>,
    pub editing: Option<Editing>,
    ime_selection: Option<Value>,
    ime_capture_pending: bool,
    ime_commit: Option<String>,
    text_splice_inflight: bool,
    pub recovery_text: Option<String>,
    pub controls: Vec<Control>,
    pub focus: u64,
    pub modifiers: ModifiersState,
    pub space_pan: bool,
    pub pending: bool,
    pub status: String,
    pub error: Option<String>,
    pub width: f64,
    pub height: f64,
    pub layer_scroll: usize,
    pub inspector: Inspector,
    pub inspector_scroll: usize,
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
        let bridge = Bridge::start(profile, proxy.clone());
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
                let layers = layer_index(&request.document, request.page.as_deref());
                let result = build_scene(&request.document, &options).map_err(|e| e.to_string());
                let mut resources = BTreeMap::new();
                let mut resource_errors = vec![];
                let mut reserved = 0usize;
                if let Ok(scene) = &result {
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
        Self {
            window: None,
            surface: None,
            access: None,
            proxy,
            bridge,
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
            resources: BTreeMap::new(),
            camera: Camera::default(),
            cameras: BTreeMap::new(),
            selected: BTreeSet::new(),
            tool: Tool::Select,
            cursor: (0., 0.),
            drag: None,
            editing: None,
            ime_selection: None,
            ime_capture_pending: false,
            ime_commit: None,
            text_splice_inflight: false,
            recovery_text: None,
            controls: vec![],
            focus: 1,
            modifiers: ModifiersState::empty(),
            space_pan: false,
            pending: false,
            status: "Connecting to your documents…".into(),
            error: None,
            width: 1440.,
            height: 900.,
            layer_scroll: 0,
            inspector: Inspector::Design,
            inspector_scroll: 0,
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
            screenshot,
            clipboard: arboard::Clipboard::new().ok(),
        }
    }
    pub fn drag_translations(&self) -> BTreeMap<String, (f64, f64)> {
        let Some(Drag::Move {
            positions, delta, ..
        }) = &self.drag
        else {
            return BTreeMap::new();
        };
        positions
            .iter()
            .filter_map(|(id, _, _)| {
                let doc = self.document()?;
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
                    *delta
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
        self.width >= 960.
    }
    pub fn canvas_rect(&self) -> Rect {
        let right = if self.inspector_visible() { RIGHT } else { 0. };
        Rect::new(
            LEFT,
            HEADER,
            (self.width - LEFT - right).max(1.),
            (self.height - HEADER - FOOTER).max(1.),
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
    pub fn action(&mut self, action: Action) {
        if self.closing {
            return;
        }
        if (self.pending || self.editing.is_some())
            && matches!(
                action,
                Action::Reorder(_)
                    | Action::ToggleProperty(_)
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
            Action::Inspector(tab) => {
                self.commit_edit();
                self.inspector = tab;
                self.inspector_scroll = 0;
            }
            Action::Reorder(forward) => {
                if let (Some(doc), Some(node)) = (self.document(), self.node()) {
                    let plan = crate::commands::reorder(doc, &node.id, forward);
                    self.apply_plan(plan, "order");
                }
            }
            Action::ToggleProperty(property) => {
                if let Some(node) = self.node() {
                    let value = node.properties.get(&property) != Some(&json!(true));
                    let command =
                        json!({"type":"node.set","nodeId":node.id,"properties":{property:value}});
                    self.mutate(command, "property");
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
                self.tool = tool;
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
                if !self.modifiers.shift_key() {
                    self.selected.clear();
                }
                self.selected.insert(id);
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
                self.schedule_scene();
            }
            Action::Field(property) => self.begin_property(property),
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
                let value = if matches!(
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
                            self.error = Some("Enter a finite number for this property.".into());
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
                    json!({"type":"node.set","nodeId":node_id,"properties":{property:value}})
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
    fn pointer_down(&mut self, button: MouseButton) {
        let (x, y) = self.cursor;
        if button == MouseButton::Left {
            if crate::text_ui::editor_rect(self).is_some_and(|area| area.contains(x, y)) {
                crate::text_ui::pointer(self, x, y, self.modifiers.shift_key());
                self.drag = Some(Drag::TextSelection);
                return;
            }
            if let Some(control) = self
                .controls
                .iter()
                .rev()
                .find(|c| c.rect.contains(x, y))
                .cloned()
            {
                self.focus = control.id;
                self.action(control.action);
                return;
            }
        }
        if crate::paint::palette_rect(self).is_some_and(|area| area.contains(x, y)) {
            return;
        }
        if !self.canvas_rect().contains(x, y) {
            self.commit_edit();
            return;
        }
        let world = self.world(x, y);
        if button == MouseButton::Middle || self.space_pan || self.tool == Tool::Pan {
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
        if self.pending {
            return;
        }
        if self.tool == Tool::Select && self.selected.len() == 1 && self.begin_resize(world) {
            return;
        }
        if self.tool != Tool::Select {
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
    fn begin_resize(&mut self, world: (f64, f64)) -> bool {
        let (Some(scene), Some(node)) = (&self.scene, self.node()) else {
            return false;
        };
        let Some(item) = scene.item(&node.id) else {
            return false;
        };
        let [a, b, c, d, _, _] = item.world.0;
        if b.abs() > 1e-8 || c.abs() > 1e-8 || a <= 0. || d <= 0. || item.locked {
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
                    let commands:Vec<_>=positions.into_iter().filter(|(id,_,_)|{
          // Moving both a selected parent and its child must not double the child's displacement.
          let Some(doc)=self.document()else{return false;};let mut parent=doc.nodes.get(id).and_then(|n|n.parent_id.as_ref());while let Some(p)=parent{if self.selected.contains(p){return false;}parent=doc.nodes.get(p).and_then(|n|n.parent_id.as_ref());}true
        }).map(|(id,x,y)|{
          let inverse=self.scene.as_ref().and_then(|scene|scene.item(&id).and_then(|item|item.parent.map(|p|scene.items[p].world))).and_then(|world|world.inverse());
          let delta=if let Some(inverse)=inverse{let p=inverse.point(delta.0,delta.1);let zero=inverse.point(0.,0.);(p.0-zero.0,p.1-zero.1)}else{delta};
          json!({"type":"node.set","nodeId":id,"properties":{"x":x+delta.0,"y":y+delta.1}})
        }).collect();
                    self.mutate(json!({"type":"batch","commands":commands}), "drag");
                }
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
    fn keyboard(&mut self, event: &winit::event::KeyEvent) {
        let down = event.state == ElementState::Pressed;
        if event.logical_key == Key::Named(NamedKey::Space) && self.editing.is_none() {
            self.space_pan = down;
        }
        if !down {
            return;
        }
        let command = self.modifiers.control_key() || self.modifiers.super_key();
        if let Some(edit) = &mut self.editing {
            match &event.logical_key {
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
                        && let Some(text) = &event.text
                        && !text.chars().any(|c| c.is_control())
                    {
                        edit.buffer.insert(text);
                    }
                }
            }
            return;
        }
        if command {
            if let Key::Character(key) = &event.logical_key {
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
                    "x" => self.copy_selection(true),
                    "v" => self.paste(),
                    "0" => self.action(Action::Fit),
                    _ => {}
                }
            }
            return;
        }
        match &event.logical_key {
            Key::Named(NamedKey::Escape) => {
                self.drag = None;
                self.selected.clear();
                self.tool = Tool::Select;
            }
            Key::Named(NamedKey::Delete) | Key::Named(NamedKey::Backspace) => {
                self.action(Action::Delete)
            }
            Key::Named(NamedKey::Tab) => {
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
                    self.focus = self.controls[(current + delta) % self.controls.len()].id;
                }
            }
            Key::Named(NamedKey::Enter) => {
                if let Some(c) = self.controls.iter().find(|c| c.id == self.focus).cloned() {
                    self.action(c.action);
                }
            }
            Key::Character(key) => match key.to_lowercase().as_str() {
                "v" => self.tool = Tool::Select,
                "f" => self.tool = Tool::Frame,
                "r" => self.tool = Tool::Rect,
                "o" => self.tool = Tool::Ellipse,
                "t" => self.tool = Tool::Text,
                "h" => self.tool = Tool::Pan,
                "1" => self.camera = Camera::default(),
                _ => {}
            },
            _ => {}
        }
    }
    fn handle_response(&mut self, response: Response) {
        match response {
            Response::Connected => {
                self.status = "Ready".into();
                self.send(Request::Refresh);
            }
            Response::Documents(documents) => {
                self.documents = documents;
                if self.active.is_none()
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
                if self.active.is_none() || activate {
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
                }
                self.error = Some(message);
            }
            Response::Shutdown => {
                self.closing = true;
            }
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
        let window = match event_loop.create_window(attrs) {
            Ok(w) => Rc::new(w),
            Err(e) => {
                eprintln!("Native window failed: {e}");
                self.smoke_failed = true;
                event_loop.exit();
                return;
            }
        };
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
                            self.scene_generation = self.scene_generation.wrapping_add(1);
                            self.scene = Some(scene);
                            self.resources = reply.resources;
                            if let Some(error) = reply.resource_errors.first() {
                                self.error = Some(error.clone());
                            }
                            self.layers = reply.layers;
                            self.refresh_visible_layers();
                        }
                        Err(error) => self.error = Some(error),
                    }
                } else {
                    self.schedule_scene();
                }
                self.redraw();
            }
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
        let is_redraw = matches!(event, WindowEvent::RedrawRequested);
        match event {
            WindowEvent::CloseRequested => self.shutdown(),
            WindowEvent::Resized(size) => {
                let scale = window.scale_factor();
                self.width = size.width as f64 / scale;
                self.height = size.height as f64 / scale;
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
                self.pointer_move(position.x / scale, position.y / scale);
            }
            WindowEvent::MouseInput { state, button, .. } => {
                if state == ElementState::Pressed {
                    self.pointer_down(button);
                } else {
                    self.pointer_up();
                }
            }
            WindowEvent::MouseWheel { delta, .. } => {
                let (dx, dy) = match delta {
                    MouseScrollDelta::LineDelta(x, y) => (x as f64 * 30., y as f64 * 30.),
                    MouseScrollDelta::PixelDelta(p) => {
                        (p.x / window.scale_factor(), p.y / window.scale_factor())
                    }
                };
                if self.cursor.0 < LEFT {
                    if dy < 0. {
                        self.layer_scroll = self.layer_scroll.saturating_add(3);
                    } else {
                        self.layer_scroll = self.layer_scroll.saturating_sub(3);
                    }
                } else if self.inspector_visible() && self.cursor.0 >= self.width - RIGHT {
                    if dy < 0. {
                        self.inspector_scroll = (self.inspector_scroll + 1).min(200);
                    } else {
                        self.inspector_scroll = self.inspector_scroll.saturating_sub(1);
                    }
                } else if self.modifiers.control_key() || self.modifiers.super_key() {
                    let r = self.canvas_rect();
                    self.camera.zoom_at(
                        (-dy * 0.005).exp(),
                        self.cursor.0 - r.x,
                        self.cursor.1 - r.y,
                    );
                } else {
                    self.camera.x += dx;
                    self.camera.y += dy;
                }
            }
            WindowEvent::KeyboardInput { event, .. } => self.keyboard(&event),
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
                self.drag = None;
                self.space_pan = false;
            }
            WindowEvent::RedrawRequested => {
                if let Err(error) = crate::paint::draw(self) {
                    eprintln!("Native presentation failed: {error}");
                    self.error = Some(error);
                    self.smoke_failed = true;
                }
                let update = crate::accessibility::tree(self);
                if let Some(access) = &mut self.access {
                    access.update_if_active(|| update);
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
        if !is_redraw {
            self.redraw();
        }
    }
    fn about_to_wait(&mut self, event_loop: &ActiveEventLoop) {
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
