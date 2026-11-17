use super::*;
use crate::client::{HomeListing, PreviewKey};
use std::collections::VecDeque;

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub enum HomeView {
    #[default]
    Recents,
    Folders,
    Folder(String),
    Trash,
    Starred,
}

#[derive(Clone, Debug)]
pub enum HomeAction {
    View(HomeView),
    Search,
    NewFolder,
    CommitFolder,
    Star(String),
    Menu(String),
    Move(String),
    MoveTo(String, Option<String>),
    Trash(String),
    Restore(String),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum HomeMenu {
    Actions(String),
    Move(String),
}

type Preview = (PreviewKey, Option<skia_safe::Image>);

#[derive(Default)]
pub(super) struct HomePreviewCache {
    pending: Option<PreviewKey>,
    items: VecDeque<Preview>,
}

impl App {
    pub fn home_documents(&self) -> Vec<&DocumentEntry> {
        let query = self.home_query().trim().to_lowercase();
        let mut documents: Vec<_> = self
            .documents
            .iter()
            .filter(|doc| match &self.home_view {
                HomeView::Trash => doc.trashed,
                HomeView::Recents => !doc.trashed && !doc.archived,
                HomeView::Starred => !doc.trashed && !doc.archived && doc.starred,
                HomeView::Folder(id) => {
                    !doc.trashed && !doc.archived && doc.folder_id.as_ref() == Some(id)
                }
                HomeView::Folders => false,
            })
            .filter(|doc| query.is_empty() || doc.title.to_lowercase().contains(&query))
            .collect();
        documents.sort_by(|left, right| {
            right
                .updated_at_ms
                .cmp(&left.updated_at_ms)
                .then_with(|| left.title.cmp(&right.title))
                .then_with(|| left.id.cmp(&right.id))
        });
        documents
    }

    pub fn home_query(&self) -> &str {
        self.editing
            .as_ref()
            .filter(|edit| matches!(edit.target, EditTarget::HomeSearch))
            .map_or(&self.home_search, |edit| &edit.buffer.text)
    }

    pub fn home_editing_text(&self) -> Option<&str> {
        self.editing
            .as_ref()
            .filter(|edit| edit.target.is_home())
            .map(|edit| edit.buffer.text.as_str())
    }

    pub fn home_folder_draft(&self) -> bool {
        self.editing
            .as_ref()
            .is_some_and(|edit| matches!(edit.target, EditTarget::HomeFolder))
    }

    pub fn home_thumbnail(&self, document: &DocumentEntry) -> Option<&skia_safe::Image> {
        self.home_previews
            .items
            .iter()
            .find(|(key, _)| document.matches_preview(key))
            .and_then(|(_, image)| image.as_ref())
    }

    pub(super) fn set_home_listing(&mut self, listing: HomeListing) {
        self.documents = listing.documents;
        self.home_folders = listing.folders;
        self.home_workspace_epoch = listing.workspace_epoch;
        self.home_previews
            .items
            .retain(|(key, _)| self.documents.iter().any(|doc| doc.matches_preview(key)));
        if let HomeView::Folder(id) = &self.home_view
            && !self.home_folders.iter().any(|folder| &folder.id == id)
        {
            self.home_view = HomeView::Folders;
        }
        self.library_scroll = self
            .library_scroll
            .min(crate::paint::library_grid(self).max_scroll);
    }

    pub(super) fn queue_home_preview(&mut self) {
        if !self.shows_library()
            || matches!(self.home_view, HomeView::Folders | HomeView::Trash)
            || self.closing
            || self.home_previews.pending.is_some()
        {
            return;
        }
        let grid = crate::paint::library_grid(self);
        let visible = grid.visible_range(self.library_scroll);
        let selected = self
            .home_documents()
            .into_iter()
            .skip(visible.start)
            .take(visible.len())
            .find(|doc| {
                !doc.epoch.is_empty()
                    && !self
                        .home_previews
                        .items
                        .iter()
                        .any(|(key, _)| doc.matches_preview(key))
            })
            .map(DocumentEntry::preview_key);
        if let Some(key) = selected
            && self.bridge.request_preview(key.clone())
        {
            self.home_previews.pending = Some(key);
        }
    }

    pub(super) fn finish_home_preview(&mut self, key: PreviewKey, image: Option<skia_safe::Image>) {
        if self.home_previews.pending.as_ref() != Some(&key) {
            return;
        }
        self.home_previews.pending = None;
        if self.documents.iter().any(|doc| doc.matches_preview(&key)) {
            if self.home_previews.items.len() >= 32 {
                // Keep cards in the viewport resident while reclaiming the oldest other preview.
                let grid = crate::paint::library_grid(self);
                let range = grid.visible_range(self.library_scroll);
                let visible = self
                    .home_documents()
                    .into_iter()
                    .skip(range.start)
                    .take(range.len())
                    .collect::<Vec<_>>();
                let oldest = self
                    .home_previews
                    .items
                    .iter()
                    .position(|(key, _)| !visible.iter().any(|doc| doc.matches_preview(key)))
                    .unwrap_or(0);
                self.home_previews.items.remove(oldest);
            }
            self.home_previews.items.push_back((key, image));
        }
        self.queue_home_preview();
    }

    pub(super) fn finish_home_input(&mut self, edit: Editing) {
        match edit.target {
            EditTarget::HomeSearch => {
                self.home_search = edit.buffer.text;
                self.library_scroll = 0.;
            }
            EditTarget::HomeFolder => {
                let title = edit.buffer.text.trim();
                if title.is_empty() || title.len() > 240 || title.chars().any(char::is_control) {
                    self.error = Some("Enter a folder name of up to 240 bytes.".into());
                    self.editing = Some(edit);
                    return;
                }
                let parent = match &self.home_view {
                    HomeView::Folder(id) => Some(id.as_str()),
                    _ => None,
                };
                self.organize_home(
                    json!({"action":"create_folder","title":title,"parentId":parent}),
                );
            }
            _ => unreachable!(),
        }
    }

    fn organize_home(&mut self, mut args: Value) {
        if self.home_workspace_epoch.is_empty() || self.home_mutating {
            return;
        }
        args["targetEpoch"] = json!(self.home_workspace_epoch);
        self.error = None;
        match self.bridge.send(Request::OrganizeHome(args)) {
            Ok(()) => self.home_mutating = true,
            Err(error) => self.error = Some(error),
        }
    }

    pub(super) fn home_action(&mut self, action: HomeAction) {
        match action {
            HomeAction::Search | HomeAction::NewFolder => {
                let search = matches!(action, HomeAction::Search);
                let value = if search {
                    self.home_search.clone()
                } else {
                    String::new()
                };
                self.home_menu = None;
                self.editing = Some(Editing {
                    target: if search {
                        EditTarget::HomeSearch
                    } else {
                        EditTarget::HomeFolder
                    },
                    buffer: EditBuffer::new(value, search),
                    id: String::new(),
                    epoch: String::new(),
                    sequence: 0,
                });
                self.error = None;
            }
            HomeAction::CommitFolder => self.commit_edit(),
            HomeAction::View(view) => {
                self.home_view = view;
                self.library_scroll = 0.;
                self.home_menu = None;
                self.error = None;
            }
            HomeAction::Menu(id) => {
                let menu = HomeMenu::Actions(id);
                self.home_menu = (self.home_menu.as_ref() != Some(&menu)).then_some(menu);
            }
            HomeAction::Move(id) => {
                self.home_menu = Some(HomeMenu::Move(id));
                self.home_menu_scroll = 0.;
            }
            HomeAction::Star(id) => {
                self.home_menu = None;
                if let Some(doc) = self.documents.iter().find(|doc| doc.id == id) {
                    self.organize_home(
                        json!({"action":"set_starred","documentId":id,"starred":!doc.starred}),
                    );
                }
            }
            HomeAction::MoveTo(id, folder) => {
                self.home_menu = None;
                self.organize_home(
                    json!({"action":"move_document","documentId":id,"folderId":folder}),
                );
            }
            HomeAction::Trash(id) => {
                self.home_menu = None;
                if self.tabs.contains(&id) {
                    self.error = Some("Close the canvas tab before moving it to Trash.".into());
                } else if let Some(doc) = self.documents.iter().find(|doc| doc.id == id) {
                    self.organize_home(json!({"action":"trash_document","documentId":id,"expectedTitle":doc.title}));
                }
            }
            HomeAction::Restore(id) => {
                self.home_menu = None;
                self.organize_home(json!({"action":"restore_trash","documentId":id}));
            }
        }
        self.queue_home_preview();
    }

    pub(super) fn home_action_available(&self, action: &HomeAction) -> bool {
        self.shows_library()
            && (!matches!(
                action,
                HomeAction::NewFolder
                    | HomeAction::CommitFolder
                    | HomeAction::Star(_)
                    | HomeAction::MoveTo(_, _)
                    | HomeAction::Trash(_)
                    | HomeAction::Restore(_)
            ) || !self.home_mutating && !self.home_workspace_epoch.is_empty())
    }
}

impl DocumentEntry {
    fn matches_preview(&self, key: &PreviewKey) -> bool {
        self.id == key.document_id && self.epoch == key.epoch && self.sequence == key.sequence
    }
}
