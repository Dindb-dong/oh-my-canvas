mod diff;
pub(super) mod edit;

use super::*;
use omc_workspace::catalog_branches::Branch;
use sha2::{Digest, Sha256};
use std::sync::Mutex;

pub(super) const COMMANDS: &[(&str, &str, bool, &str)] = &[
    ("branch.create", "Create branch", false, "name?"),
    ("branch.list", "List branches", false, ""),
    ("branch.open", "Open branch", false, "id"),
    ("branch.review", "Review branch", false, "id?"),
    (
        "branch.updateFromMain",
        "Update from main",
        false,
        "id?, resolutions?",
    ),
    ("branch.merge", "Merge branch", false, "id?, resolutions?"),
    ("branch.archive", "Archive branch", false, "id?"),
];

// Branch operations span two document databases and the catalog. Serialize these
// operations locally while ordinary edits remain revision-checked in the engine.
static BRANCH_OPERATIONS: Mutex<()> = Mutex::new(());

impl ToolRouter {
    pub(super) fn fig_branch_command(
        &self,
        session: &str,
        snapshot: &DocumentSnapshot,
        command: &str,
        params: &Value,
    ) -> Result<Value> {
        let id = json!({"type":"string","minLength":1,"maxLength":64});
        let mut contract = match command {
            "branch.create" => {
                json!({"properties":{"name":{"type":"string","minLength":1,"maxLength":240}}})
            }
            "branch.list" => json!({}),
            "branch.open" => json!({"properties":{"id":id},"required":["id"]}),
            "branch.merge" | "branch.updateFromMain" => json!({
                "properties":{"id":id,"resolutions":{"type":"object","additionalProperties":{"enum":["main","branch"]}}}
            }),
            _ => json!({"properties":{"id":id}}),
        };
        contract["type"] = json!("object");
        contract["additionalProperties"] = json!(false);
        schema::check(&contract, params, "params")?;
        let _operation = BRANCH_OPERATIONS.lock().unwrap();
        let identity = self.workspace.session(session)?;
        let (current, main, branches, owner) = {
            let catalog = self.workspace.catalog.lock().unwrap();
            let owner = if identity.retry_scope == "durable_principal" {
                identity.author
            } else {
                format!("local-profile:{}", catalog.epoch)
            };
            let current = catalog.branch_for_document(&snapshot.id, &owner)?;
            let main = current
                .as_ref()
                .map_or(&snapshot.id, |branch| &branch.main)
                .clone();
            let branches = catalog.branches(&main, &owner)?;
            (current, main, branches, owner)
        };
        if command == "branch.list" {
            let all = self.fig_tabs.lock().unwrap();
            let tabs = all.get(session);
            let list = branches
                .iter()
                .map(|branch| {
                    let mut entry = json!(branch);
                    if let Some(index) =
                        tabs.and_then(|tabs| tabs.iter().position(|id| *id == branch.document))
                    {
                        entry["index"] = json!(index);
                    }
                    entry
                })
                .collect::<Vec<_>>();
            return Ok(json!(list));
        }
        if command == "branch.create" {
            if current.is_some() {
                return Err(EngineError::invalid(
                    "open the main file before creating a branch",
                ));
            }
            let name = params["name"].as_str().unwrap_or("Branch");
            let base = branch_content(snapshot);
            self.workspace
                .catalog
                .lock()
                .unwrap()
                .check_branch_capacity(&main, &base)?;
            let mut content = base.clone();
            content.title = name.into();
            let created = self.workspace.create(session, name, Some(content))?;
            let branch = self.workspace.catalog.lock().unwrap().create_branch(
                &main,
                &created.id,
                &owner,
                name,
                &base,
            );
            let branch = match branch {
                Ok(branch) => branch,
                Err(error) => {
                    self.workspace.bind(session, &main)?;
                    self.workspace.release(session, &created.id)?;
                    return Err(error.detail(json!({"unlinkedDocument":external_id(&created.id)})));
                }
            };
            self.branch_tab(session, &main)?;
            let index = self.branch_tab(session, &created.id)?;
            return Ok(json!({"id":branch.id,"name":branch.name,"index":index}));
        }
        let branch = params["id"]
            .as_str()
            .map_or(current.as_ref(), |id| {
                branches.iter().find(|branch| branch.id == id)
            })
            .ok_or_else(|| EngineError::new("not_found", "branch was not found in this file"))?;
        match command {
            "branch.open" => Ok(json!({"index":self.branch_tab(session, &branch.document)?})),
            "branch.archive" => {
                if branch.state == "active" {
                    self.workspace
                        .catalog
                        .lock()
                        .unwrap()
                        .advance_branch(branch, "archived", None)?;
                }
                self.close_branch_tab(session, branch)?;
                Ok(json!({"archived":true}))
            }
            "branch.review" | "branch.updateFromMain" | "branch.merge" => {
                self.review_or_apply_branch(session, branch, command, params)
            }
            _ => Err(EngineError::invalid("unknown branch command")),
        }
    }

    fn branch_tab(&self, session: &str, document: &str) -> Result<usize> {
        self.workspace.bind(session, document)?;
        self.fig_record_tab(session, json!({"id":external_id(document)}))?;
        let tabs = self.fig_tabs.lock().unwrap();
        Ok(tabs[session].iter().position(|id| id == document).unwrap())
    }

    fn close_branch_tab(&self, session: &str, branch: &Branch) -> Result<()> {
        if self.workspace.session(session)?.binding.as_deref() == Some(&branch.document) {
            self.branch_tab(session, &branch.main)?;
        }
        self.workspace.release(session, &branch.document)?;
        if let Some(tabs) = self.fig_tabs.lock().unwrap().get_mut(session) {
            tabs.retain(|id| *id != branch.document);
        }
        self.states
            .lock()
            .unwrap()
            .remove(&(session.into(), branch.document.clone()));
        Ok(())
    }

    fn review_or_apply_branch(
        &self,
        session: &str,
        branch: &Branch,
        command: &str,
        params: &Value,
    ) -> Result<Value> {
        let base = self.workspace.catalog.lock().unwrap().branch_base(branch)?;
        let main = self.workspace.snapshot(&branch.main)?;
        let fork = self.workspace.snapshot(&branch.document)?;
        let main_content = branch_content(&main);
        let mut fork_content = branch_content(&fork);
        // Branch names label the separate file and do not rename the main file.
        fork_content.title = base.title.clone();
        let resolutions = params["resolutions"]
            .as_object()
            .cloned()
            .unwrap_or_default();
        let review = diff::review(&base, &fork_content, &main_content, &resolutions)?;
        if command == "branch.review" {
            return Ok(json!({
                "id":branch.id,"name":branch.name,"state":branch.state,
                "branch":diff::changes(&base, &fork_content),"main":diff::changes(&base, &main_content),
                "conflicts":review.conflicts
            }));
        }
        if branch.state != "active" {
            return Err(EngineError::new(
                "conflict",
                "only active branches can be updated or merged",
            ));
        }
        let merging = command == "branch.merge";
        let action = if merging { "merged" } else { "updated" };
        let unresolved = review
            .conflicts
            .iter()
            .filter(|conflict| !resolutions.contains_key(conflict["key"].as_str().unwrap()))
            .cloned()
            .collect::<Vec<_>>();
        if !unresolved.is_empty() {
            return Ok(json!({(action):false,"changes":0,"conflicts":unresolved}));
        }
        let mut merged = review.content;
        let target = if merging { &main } else { &fork };
        merged.title = if merging {
            main.title.clone()
        } else {
            fork.title.clone()
        };
        merged.metadata.extend(
            target
                .metadata
                .iter()
                .filter(|(key, _)| key.starts_with("comments/"))
                .map(|(key, value)| (key.clone(), value.clone())),
        );
        merged
            .validate()
            .map_err(|error| EngineError::new("conflict", error))?;
        let commands = edit::commands(&target.content(), &merged)?;
        let changes = commands.len();
        if changes > 100 {
            return Err(EngineError::new(
                "resource_limit",
                "branch changes exceed one 100-operation commit",
            ));
        }
        let version = if merging {
            None
        } else {
            merged
                .metadata
                .retain(|key, _| !key.starts_with("comments/"));
            let bytes = serde_json::to_vec(&merged)
                .map_err(|error| EngineError::new("storage_unavailable", error.to_string()))?;
            if bytes.len() > 16 * 1024 * 1024
                || serde_json::to_vec(&main_content)
                    .map_err(|error| EngineError::new("storage_unavailable", error.to_string()))?
                    .len()
                    > 16 * 1024 * 1024
            {
                return Err(EngineError::new(
                    "resource_limit",
                    "updated branch exceeds 16 MiB",
                ));
            }
            let digest = hex::encode(Sha256::digest(&bytes));
            Some((bytes, digest))
        };
        let source = if merging { &fork } else { &main };
        if self.workspace.context(&source.id)?.revision != source.revision() {
            return Err(EngineError::new(
                "conflict",
                "source document changed during branch review",
            ));
        }
        if merging && changes > 0 {
            self.submit(
                session,
                &target.id,
                Command::Batch { commands },
                &Value::Null,
                Some(target.sequence),
            )?;
        } else if !merging {
            self.workspace.execute_branch_rebase(
                session,
                &target.id,
                &target.revision(),
                commands,
            )?;
        }
        let mut result = json!({(action):true,"changes":changes,"conflicts":review.conflicts});
        let mut catalog = self.workspace.catalog.lock().unwrap();
        if merging {
            catalog.advance_branch(branch, "merged", None)?;
            drop(catalog);
            self.close_branch_tab(session, branch)?;
            result["index"] = json!(self.branch_tab(session, &branch.main)?);
        } else if let Some((bytes, digest)) = version {
            catalog.advance_branch(branch, "active", Some(&main_content))?;
            catalog
                .save_version(&target.id, "Update from main", "", &bytes, &digest, true)
                .map_err(|error| error.detail(json!({"updated":true,"changes":changes})))?;
        }
        Ok(result)
    }
}

fn branch_content(snapshot: &DocumentSnapshot) -> DocumentContent {
    let mut content = snapshot.content();
    content
        .metadata
        .retain(|key, _| !key.starts_with("comments/"));
    content
}
