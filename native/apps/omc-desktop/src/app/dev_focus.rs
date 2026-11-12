use super::*;

pub(super) struct DevFocus {
    layer: String,
    page: String,
    restore_page: Option<String>,
    restore_camera: Camera,
    restore_inspector: Inspector,
    restore_selection: BTreeSet<String>,
    fitted: bool,
}

impl App {
    pub(crate) fn dev_focus_active(&self) -> bool {
        self.dev_focus.is_some()
    }

    pub(crate) fn dev_focus_title(&self) -> Option<String> {
        let focus = self.dev_focus.as_ref()?;
        self.document()?.nodes.get(&focus.layer).map(node_name)
    }

    pub(super) fn escape_dev_focus(&mut self) {
        if let Some(focused) = &self.dev_focus
            && self.selected.iter().any(|id| id != &focused.layer)
        {
            self.selected = BTreeSet::from([focused.layer.clone()]);
            return;
        }
        self.exit_dev_focus(true);
    }

    pub(crate) fn focused_scene_index(&self, scene: &Scene) -> Option<usize> {
        let focused = self.dev_focus.as_ref()?;
        if self.page.as_ref() != Some(&focused.page) {
            return None;
        }
        scene
            .items
            .iter()
            .position(|item| item.id == focused.layer && !item.hidden)
    }

    pub(crate) fn focus_includes_item(&self, scene: &Scene, mut index: usize) -> bool {
        let Some(focused) = &self.dev_focus else {
            return true;
        };
        loop {
            let item = &scene.items[index];
            if item.id == focused.layer {
                return true;
            }
            let Some(parent) = item.parent else {
                return false;
            };
            index = parent;
        }
    }

    pub(super) fn fit_dev_focus(&mut self) {
        if self.dev_focus.as_ref().is_none_or(|focus| focus.fitted) {
            return;
        }
        let Some(bounds) = self.scene.as_ref().and_then(|scene| {
            self.focused_scene_index(scene)
                .map(|index| scene.items[index].bounds)
        }) else {
            return;
        };
        let viewport = self.canvas_rect();
        self.camera.fit(bounds, viewport.width, viewport.height);
        self.camera.y += 28.;
        self.pan_view = false;
        if let Some(focus) = &mut self.dev_focus {
            focus.fitted = true;
        }
    }

    pub(super) fn exit_dev_focus(&mut self, restore_page: bool) {
        let Some(focus) = self.dev_focus.take() else {
            return;
        };
        if self.page != focus.restore_page {
            self.camera = self
                .active
                .as_ref()
                .zip(self.page.as_ref())
                .and_then(|(document, page)| self.cameras.get(&(document.clone(), page.clone())))
                .copied()
                .unwrap_or_default();
        }
        if restore_page
            && self.page != focus.restore_page
            && let Some(page) = focus.restore_page.clone()
        {
            self.choose_page(page);
        }
        self.inspector = focus.restore_inspector;
        if self.page == focus.restore_page {
            self.camera = focus.restore_camera;
            self.selected = focus.restore_selection;
        }
        self.inspector_scroll = 0.;
        self.pan_view = false;
    }

    pub(super) fn automation_dev_focus(&mut self, args: &Value) -> Result<Value, String> {
        if self.editing.is_some() || self.prototype_frame.is_some() || self.version_preview_active()
        {
            return Err("Finish editing or previewing before entering Focus view.".into());
        }
        let document = self
            .document()
            .ok_or("Open a document before entering Focus view.")?;
        let is_section = |node: &Node| {
            node.string("primitive") == Some("section")
                || node.properties.get("isSection").and_then(Value::as_bool) == Some(true)
        };
        let mut children = BTreeMap::<&str, Vec<&Node>>::new();
        for node in document.nodes.values() {
            if let Some(parent) = node.parent_id.as_deref() {
                children.entry(parent).or_default().push(node);
            }
        }
        for siblings in children.values_mut() {
            siblings.sort_by(|a, b| (&a.rank, &a.id).cmp(&(&b.rank, &b.id)));
        }
        let mut candidates = Vec::new();
        for page in &document.pages {
            let mut stack = children
                .get(page.root_node_id.as_str())
                .into_iter()
                .flatten()
                .rev()
                .copied()
                .collect::<Vec<_>>();
            while let Some(node) = stack.pop() {
                if node.properties.get("hidden").and_then(Value::as_bool) == Some(true)
                    || node.properties.get("visible").and_then(Value::as_bool) == Some(false)
                {
                    continue;
                }
                let top_level = node.parent_id.as_deref().is_some_and(|parent| {
                    parent == page.root_node_id
                        || document.nodes.get(parent).is_some_and(is_section)
                });
                if is_section(node)
                    || top_level && matches!(node.kind, NodeKind::Frame | NodeKind::Component)
                {
                    candidates.push((page, node));
                }
                stack.extend(
                    children
                        .get(node.id.as_str())
                        .into_iter()
                        .flatten()
                        .rev()
                        .copied(),
                );
            }
        }
        let ready = candidates
            .iter()
            .copied()
            .filter(|(_, node)| node.string("devStatus") == Some("readyForDev"))
            .collect::<Vec<_>>();
        let direction = args["direction"].as_str();
        let current = self
            .dev_focus
            .as_ref()
            .map(|focus| focus.layer.as_str())
            .or_else(|| self.selected.first().map(String::as_str));
        let target = if let Some(direction) = direction {
            if ready.is_empty() {
                return Err(
                    "No top-level frame or section is marked ready for development.".into(),
                );
            }
            let previous = direction == "previous";
            let index = current.and_then(|id| ready.iter().position(|(_, node)| node.id == id));
            let last = ready.len() - 1;
            let next = index.map_or(if previous { last } else { 0 }, |index| {
                (index + if previous { last } else { 1 }) % ready.len()
            });
            Some(ready[next])
        } else {
            let candidate = |id: &str| candidates.iter().copied().find(|(_, node)| node.id == id);
            if let Some(id) = args["layer"].as_str() {
                candidate(id)
            } else {
                self.selected
                    .iter()
                    .find_map(|id| candidate(id))
                    .or_else(|| args["fallbackLayer"].as_str().and_then(candidate))
            }
        };
        let (page, node) = target.ok_or("Choose a visible top-level frame or section.")?;
        let id = node.id.clone();
        let page_id = page.id.clone();
        let index = ready.iter().position(|(_, candidate)| candidate.id == id);
        let result = json!({
            "documentId": document.id, "pageId": page_id,
            "devFocusLayer": id, "devFocusPageRoot": page.root_node_id,
            "name": node_name(node), "index": index, "count": ready.len(), "selection": [id]
        });
        let mut focus = self.dev_focus.take().unwrap_or_else(|| DevFocus {
            layer: id.clone(),
            page: page_id.clone(),
            restore_page: self.page.clone(),
            restore_camera: self.camera,
            restore_inspector: self.inspector,
            restore_selection: self.selected.clone(),
            fitted: false,
        });
        focus.layer.clone_from(&id);
        focus.page.clone_from(&page_id);
        focus.fitted = false;
        self.dev_focus = Some(focus);
        if self.page.as_ref() != Some(&page_id) {
            self.choose_page(page_id);
        }
        self.inspector = Inspector::Inspect;
        self.inspector_scroll = 0.;
        self.selected = BTreeSet::from([id]);
        self.fit_dev_focus();
        Ok(result)
    }
}
