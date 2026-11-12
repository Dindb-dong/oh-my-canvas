use super::*;

pub(crate) struct CanvasComments {
    pub(crate) visible: bool,
    pub(crate) tool: bool,
    pub(crate) selected: Option<String>,
    cache: RefCell<CommentCache>,
}

impl Default for CanvasComments {
    fn default() -> Self {
        Self {
            visible: true,
            tool: false,
            selected: None,
            cache: RefCell::new(CommentCache::default()),
        }
    }
}

#[derive(Default)]
struct CommentCache {
    key: Option<(String, String, u64, String)>,
    entries: BTreeMap<String, Value>,
    scene_generation: Option<u64>,
    points: Vec<CommentPin>,
}

pub(crate) struct CommentPin {
    pub(crate) id: String,
    pub(crate) number: usize,
    pub(crate) x: f64,
    pub(crate) y: f64,
}

impl App {
    pub(super) fn toggle_comments(&mut self, value: Option<bool>) -> Value {
        self.comments.visible = value.unwrap_or(!self.comments.visible);
        if !self.comments.visible {
            self.comments.selected = None;
        }
        json!({"on":self.comments.visible})
    }

    pub(super) fn enable_comment_tool(&mut self) -> Result<Value, String> {
        if self.document().is_none()
            || self.editing.is_some()
            || self.version_preview_active()
            || self.prototype_frame.is_some()
            || self.library_open
        {
            return Err("Open an editable canvas before adding a comment.".into());
        }
        self.action(Action::Tool(Tool::Select));
        self.comments.visible = true;
        self.comments.tool = true;
        self.comments.selected = None;
        Ok(json!({"tool":"comment"}))
    }

    fn comment_catalog(&self) -> Option<std::cell::Ref<'_, BTreeMap<String, Value>>> {
        let snapshot = self.document()?;
        let page = self.page.as_ref()?;
        let key = (&snapshot.id, &snapshot.epoch, snapshot.sequence, page);
        let mut cache = self.comments.cache.borrow_mut();
        if cache
            .key
            .as_ref()
            .map(|(id, epoch, sequence, page)| (id, epoch, *sequence, page))
            != Some(key)
        {
            cache.entries = omc_style::catalog_entities(snapshot, "comments");
            cache.entries.retain(|_, entry| entry["pageId"] == *page);
            cache.scene_generation = None;
            cache.key = Some((
                snapshot.id.clone(),
                snapshot.epoch.clone(),
                snapshot.sequence,
                page.clone(),
            ));
        }
        drop(cache);
        Some(std::cell::Ref::map(self.comments.cache.borrow(), |cache| {
            &cache.entries
        }))
    }

    pub(crate) fn comment_pins(&self) -> Vec<CommentPin> {
        if !self.comments.visible
            || self.version_preview_active()
            || self.prototype_frame.is_some()
            || self.library_open
        {
            return Vec::new();
        }
        if self.comment_catalog().is_none() {
            return Vec::new();
        }
        let mut cache = self.comments.cache.borrow_mut();
        if cache.scene_generation != Some(self.scene_generation) {
            let mut roots = cache
                .entries
                .values()
                .filter(|entry| entry["threadId"].is_null() && entry["resolved"] != true)
                .collect::<Vec<_>>();
            roots.sort_by(|a, b| {
                a["createdAt"]
                    .as_u64()
                    .cmp(&b["createdAt"].as_u64())
                    .then(a["id"].as_str().cmp(&b["id"].as_str()))
            });
            let scene = self.scene.as_ref();
            cache.points = roots
                .into_iter()
                .take(1000)
                .enumerate()
                .filter_map(|(index, entry)| {
                    let (x, y) = entry["nodeId"]
                        .as_str()
                        .and_then(|id| scene.and_then(|scene| scene.item(id)))
                        .and_then(|item| {
                            Some(
                                item.world
                                    .point(entry["localX"].as_f64()?, entry["localY"].as_f64()?),
                            )
                        })
                        .or_else(|| Some((entry["x"].as_f64()?, entry["y"].as_f64()?)))?;
                    Some(CommentPin {
                        id: entry["id"].as_str()?.to_owned(),
                        number: index + 1,
                        x,
                        y,
                    })
                })
                .collect();
            cache.scene_generation = Some(self.scene_generation);
        }
        let viewport = self.canvas_rect();
        cache
            .points
            .iter()
            .filter_map(|pin| {
                let x = viewport.x + self.camera.x + pin.x * self.camera.zoom;
                let y = viewport.y + self.camera.y + pin.y * self.camera.zoom;
                viewport.contains(x, y).then(|| CommentPin {
                    id: pin.id.clone(),
                    number: pin.number,
                    x,
                    y,
                })
            })
            .collect()
    }

    pub(crate) fn comment_thread(&self) -> Option<Vec<(String, String)>> {
        let selected = self.comments.selected.as_ref()?;
        let catalog = self.comment_catalog()?;
        let root = catalog.get(selected)?;
        let mut replies = catalog
            .values()
            .filter(|entry| entry["threadId"] == *selected)
            .collect::<Vec<_>>();
        replies.sort_by_key(|entry| {
            (
                entry["replyOrder"].as_u64().unwrap_or_default(),
                entry["id"].as_str(),
            )
        });
        Some(
            std::iter::once(root)
                .chain(replies)
                .take(6)
                .map(|entry| {
                    (
                        entry["authorName"]
                            .as_str()
                            .or_else(|| entry["authorId"].as_str())
                            .unwrap_or("Comment")
                            .to_owned(),
                        entry["body"].as_str().unwrap_or_default().to_owned(),
                    )
                })
                .collect(),
        )
    }

    pub(super) fn comment_pointer(&mut self, x: f64, y: f64) -> bool {
        if let Some(pin) = self
            .comment_pins()
            .into_iter()
            .rev()
            .find(|pin| (x - pin.x).hypot(y - pin.y) <= 14.)
        {
            self.comments.selected = Some(pin.id);
            return true;
        }
        self.comments.selected = None;
        if !self.comments.tool || self.editing.is_some() || !self.canvas_rect().contains(x, y) {
            return false;
        }
        let Some(doc) = self.document() else {
            return false;
        };
        let Some(page) = self.page.clone() else {
            return false;
        };
        let (x, y) = self.world(x, y);
        let anchor = self
            .scene
            .as_ref()
            .and_then(|scene| {
                scene.items.iter().rev().find(|item| {
                    !item.hidden
                        && matches!(
                            item.kind,
                            NodeKind::Frame | NodeKind::Component | NodeKind::Instance
                        )
                        && item.parent.is_some()
                        && doc.nodes.contains_key(&item.id)
                        && item.contains(x, y)
                })
            })
            .and_then(|item| {
                let (x, y) = item.world.inverse()?.point(x, y);
                Some((item.id.clone(), x, y))
            });
        self.editing = Some(Editing {
            target: EditTarget::CanvasComment {
                page,
                point: (x, y),
                anchor,
            },
            buffer: EditBuffer::new(String::new(), false),
            id: doc.id.clone(),
            epoch: doc.epoch.clone(),
            sequence: doc.sequence,
        });
        true
    }

    pub(super) fn comment_command(
        &self,
        page: &str,
        point: (f64, f64),
        anchor: Option<&(String, f64, f64)>,
        body: &str,
    ) -> Result<Value, String> {
        let body = body.trim();
        if body.is_empty() || body.len() > 16384 {
            return Err("Comment text requires 1–16384 bytes.".into());
        }
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        let mut properties = json!({"pageId":page,"x":point.0,"y":point.1,
            "body":body,"createdAt":now,"resolved":false});
        if let Some((id, x, y)) = anchor {
            properties["nodeId"] = json!(id);
            properties["localX"] = json!(x);
            properties["localY"] = json!(y);
        }
        if let Some(name) = self.collaboration["name"]
            .as_str()
            .filter(|name| !name.is_empty())
        {
            properties["authorName"] = json!(name);
        }
        Ok(json!({"type":"catalog.set","namespace":"comments",
            "entityId":omc_model::new_id("comment"),"properties":properties}))
    }

    pub(super) fn reveal_comment(&mut self, args: &Value) -> Result<Value, String> {
        if self.editing.is_some() || self.version_preview_active() || self.prototype_frame.is_some()
        {
            return Err("Close the active preview or edit before opening a comment.".into());
        }
        let page = args["page"].as_str().ok_or("Comment page is missing.")?;
        if !self
            .document()
            .is_some_and(|doc| doc.pages.iter().any(|item| item.id == page))
        {
            return Err("Comment page is missing.".into());
        }
        let changed_page = self.page.as_deref() != Some(page);
        if changed_page {
            self.choose_page(page.into());
        }
        self.comments.visible = true;
        if let Some(id) = args["thread"].as_str() {
            self.comments.selected = Some(id.into());
        }
        if (changed_page || args["keep"] != true)
            && let (Some(x), Some(y), Some(zoom)) = (
                args["center"][0].as_f64(),
                args["center"][1].as_f64(),
                args["zoom"].as_f64(),
            )
            && x.is_finite()
            && y.is_finite()
            && zoom.is_finite()
        {
            let viewport = self.canvas_rect();
            let zoom = zoom.clamp(0.05, 16.0);
            self.camera = Camera {
                x: viewport.width * 0.5 - x * zoom,
                y: viewport.height * 0.5 - y * zoom,
                zoom,
            };
        }
        Ok(json!({"zoom":self.camera.zoom}))
    }

    pub(super) fn escape_comments(&mut self) -> bool {
        let selected = self.comments.selected.take().is_some();
        let tool = std::mem::take(&mut self.comments.tool);
        selected || tool
    }
}
