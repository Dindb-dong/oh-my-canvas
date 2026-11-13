use super::*;

const PAGE_SIZE: usize = 6;
const DESCRIPTION_LIMIT: usize = 2000;

impl App {
    pub(crate) fn library_entries(&self) -> Vec<(String, u64)> {
        self.document().map_or_else(Vec::new, |document| {
            let mut entries: Vec<(String, u64)> =
                omc_style::catalog_entities(document, "libraries")
                    .into_values()
                    .filter(|row| row["enabled"] != false)
                    .map(|row| {
                        (
                            row["name"].as_str().unwrap_or("Library").into(),
                            row["version"].as_u64().unwrap_or(1),
                        )
                    })
                    .collect();
            entries.sort_by(|a, b| a.0.cmp(&b.0));
            entries
        })
    }

    pub(crate) fn library_entries_page(&self) -> (Vec<(String, u64)>, usize, usize) {
        let entries = self.library_entries();
        let count = entries.len().div_ceil(PAGE_SIZE).max(1);
        let page = self.automation.library_page.min(count - 1);
        (
            entries
                .into_iter()
                .skip(page * PAGE_SIZE)
                .take(PAGE_SIZE)
                .collect(),
            page,
            count,
        )
    }

    pub(crate) fn library_publication(&self) -> Option<&Value> {
        self.document()?
            .metadata
            .get("figcraftPublishedLibrary")?
            .get("extensions")
    }

    pub(crate) fn library_description(&self) -> &str {
        if let Some(edit) = &self.editing
            && matches!(edit.target, EditTarget::LibraryDescription)
        {
            &edit.buffer.text
        } else {
            &self.automation.library_description
        }
    }

    pub(in crate::app) fn set_library_description(&mut self, value: &str) {
        self.automation.library_description = value.chars().take(DESCRIPTION_LIMIT).collect();
    }

    pub(in crate::app) fn open_library_dialog(
        &mut self,
        panel: UtilityPopup,
    ) -> Result<Value, String> {
        if self.pending
            || self.editing.is_some()
            || self.version_preview_active()
            || self.prototype_frame.is_some()
        {
            return Err("Finish the current edit before opening Libraries.".into());
        }
        let document = self
            .document()
            .ok_or("Open a document before opening Libraries.")?;
        let document_id = document.id.clone();
        if panel == UtilityPopup::PublishLibrary {
            self.automation.library_description = self
                .library_publication()
                .and_then(|publication| publication["description"].as_str())
                .unwrap_or("")
                .into();
        } else {
            self.automation.library_page = 0;
        }
        self.inspector = Inspector::Assets;
        self.popup = Some(Popup::Utility(panel));
        self.focus = crate::paint::POPUP_FIRST;
        self.keyboard_focus_visible = true;
        self.redraw();
        Ok(json!({"open":true,"dialog":format!("{panel:?}"),"documentId":document_id}))
    }

    pub(in crate::app) fn page_library_dialog(&mut self, next: bool) {
        let (_, page, count) = self.library_entries_page();
        self.automation.library_page = if next {
            (page + 1).min(count - 1)
        } else {
            page.saturating_sub(1)
        };
        self.popup = Some(Popup::Utility(UtilityPopup::Libraries));
    }

    pub(in crate::app) fn library_dialog_key(&mut self, key: &Key) -> bool {
        if self.editing.is_some()
            || !matches!(
                self.popup,
                Some(Popup::Utility(
                    UtilityPopup::Libraries | UtilityPopup::PublishLibrary
                ))
            )
        {
            return false;
        }
        match key {
            Key::Named(NamedKey::Escape) => self.popup = None,
            Key::Named(NamedKey::Enter) => {
                if let Some(control) = self.controls.iter().find(|control| {
                    control.id >= crate::paint::POPUP_FIRST && control.id == self.focus
                }) {
                    self.action(control.action.clone());
                }
            }
            Key::Named(NamedKey::Tab) => {
                let controls = self
                    .controls
                    .iter()
                    .filter(|control| {
                        control.id >= crate::paint::POPUP_FIRST
                            && self.action_available(&control.action)
                    })
                    .map(|control| control.id)
                    .collect::<Vec<_>>();
                if !controls.is_empty() {
                    let index = controls
                        .iter()
                        .position(|id| *id == self.focus)
                        .unwrap_or(0);
                    let step = if self.modifiers.shift_key() {
                        controls.len() - 1
                    } else {
                        1
                    };
                    self.focus = controls[(index + step) % controls.len()];
                    self.keyboard_focus_visible = true;
                }
            }
            _ => {}
        }
        self.redraw();
        true
    }

    pub(in crate::app) fn edit_library_description(&mut self) {
        if let Some(document) = self.document() {
            self.editing = Some(Editing {
                target: EditTarget::LibraryDescription,
                buffer: EditBuffer::new(self.automation.library_description.clone(), false),
                id: document.id.clone(),
                epoch: document.epoch.clone(),
                sequence: document.sequence,
            });
        }
        self.popup = Some(Popup::Utility(UtilityPopup::PublishLibrary));
    }

    pub(in crate::app) fn submit_library_publication(&mut self) {
        if self
            .editing
            .as_ref()
            .is_some_and(|edit| matches!(edit.target, EditTarget::LibraryDescription))
        {
            self.commit_edit();
        }
        if self.pending || self.editing.is_some() {
            self.popup = Some(Popup::Utility(UtilityPopup::PublishLibrary));
            return;
        }
        let Some(document) = self.document() else {
            return;
        };
        let request = Request::PublishLibrary {
            id: document.id.clone(),
            revision: document.revision(),
            description: self.automation.library_description.clone(),
        };
        self.pending = true;
        self.status = "Publishing library…".into();
        self.send(request);
    }

    pub(in crate::app) fn library_dialog_state(&self) -> Value {
        let Some(Popup::Utility(panel @ (UtilityPopup::Libraries | UtilityPopup::PublishLibrary))) =
            self.popup
        else {
            return Value::Null;
        };
        let (entries, page, pages) = self.library_entries_page();
        let controls: Vec<_> = self.controls.iter().filter(|item| item.id >= crate::paint::POPUP_FIRST)
            .map(|item| json!({"label":item.label,"rect":[item.rect.x,item.rect.y,item.rect.width,item.rect.height]})).collect();
        json!({"name":format!("{panel:?}"),"entries":entries,"page":page,"pages":pages,
            "description":self.library_description(),"publicationVersion":self.library_publication().and_then(|row| row["version"].as_u64()),"controls":controls})
    }
}
