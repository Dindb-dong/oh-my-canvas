use super::*;
use serde::{Deserialize, Serialize};
use std::io::Write;

pub const PROFILE_NAME_LIMIT: usize = 64;

#[derive(Clone, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ProfilePreferences {
    pub auto_save: bool,
    pub language: String,
    pub user_name: String,
    pub invite_links: Option<bool>,
    pub publish_server: String,
}

impl Default for ProfilePreferences {
    fn default() -> Self {
        Self {
            auto_save: false,
            language: "ko".into(),
            user_name: String::new(),
            invite_links: None,
            publish_server: Self::DEFAULT_PUBLISH_SERVER.into(),
        }
    }
}

impl ProfilePreferences {
    /// The built-in endpoint in the pinned FigCraft v0.17.0 release.
    pub const DEFAULT_PUBLISH_SERVER: &str = "wss://collab.craftapps.dev/";

    pub(super) fn read(profile: &Path) -> Self {
        std::fs::read(profile.join("native-v1/profile-preferences.json"))
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default()
    }

    fn write(&self, profile: &Path) -> Result<()> {
        let directory = profile.join("native-v1");
        let mut file = tempfile::NamedTempFile::new_in(&directory).map_err(io_error)?;
        serde_json::to_writer(file.as_file_mut(), self).map_err(json_error)?;
        file.flush().map_err(io_error)?;
        file.as_file().sync_all().map_err(io_error)?;
        file.persist(directory.join("profile-preferences.json"))
            .map_err(|error| io_error(error.error))?;
        Ok(())
    }
}

impl Workspace {
    pub fn preferences(&self) -> ProfilePreferences {
        self.preferences.lock().unwrap().clone()
    }

    pub fn update_preference(
        &self,
        change: impl FnOnce(&mut ProfilePreferences) -> Value,
    ) -> Result<Value> {
        let mut preferences = self.preferences.lock().unwrap();
        let mut next = preferences.clone();
        let result = change(&mut next);
        next.write(&self.profile)?;
        if !next.auto_save {
            self.pending_checkpoints.lock().unwrap().clear();
        }
        *preferences = next;
        Ok(result)
    }

    pub fn schedule_automatic_checkpoint(&self, id: &str) {
        if self.preferences.lock().unwrap().auto_save {
            self.pending_checkpoints
                .lock()
                .unwrap()
                .insert(id.to_owned());
        }
    }

    pub fn automatic_checkpoint(&self) {
        let id = {
            let preferences = self.preferences.lock().unwrap();
            if !preferences.auto_save {
                return;
            }
            self.pending_checkpoints.lock().unwrap().pop_first()
        };
        if let Some(id) = id
            && let Err(error) = self.checkpoint(&id)
            && error.retryable
        {
            self.schedule_automatic_checkpoint(&id);
        }
    }
}
