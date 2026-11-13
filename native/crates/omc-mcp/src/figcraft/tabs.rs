use super::*;

pub(super) const COMMANDS: &[(&str, &str, bool, &str)] = &[
    ("doc.switch", "Switch document", false, "index"),
    ("doc.nextTab", "Next tab", false, ""),
    ("doc.previousTab", "Previous tab", false, ""),
    ("file.moveTab", "Move tab", false, "from, to"),
    ("file.close", "Close tab", false, "index?, force?"),
];

impl ToolRouter {
    pub(crate) fn fig_record_tab(&self, session: &str, result: Value) -> Result<Value> {
        if let Some(document) = result["id"].as_str().or(result["document"].as_str()) {
            let id = native_id(document)?;
            let mut all = self.fig_tabs.lock().unwrap();
            let tabs = all.entry(session.into()).or_default();
            if !tabs.contains(&id) {
                tabs.push(id);
            }
        }
        Ok(result)
    }

    pub(super) fn fig_tabs_command(
        &self,
        session: &str,
        name: &str,
        params: &Value,
    ) -> Result<Value> {
        let schema = match name {
            "doc.switch" => {
                json!({"properties":{"index":{"type":"integer","minimum":0}},"required":["index"]})
            }
            "file.moveTab" => {
                json!({"properties":{"from":{"type":"integer","minimum":0},"to":{"type":"integer","minimum":0}},"required":["from","to"]})
            }
            "file.close" => {
                json!({"properties":{"index":{"type":"integer","minimum":0},"force":{"type":"boolean"}}})
            }
            _ => json!({}),
        };
        let mut schema = schema;
        schema["type"] = json!("object");
        schema["additionalProperties"] = json!(false);
        schema::check(&schema, params, "params")?;
        let mut all = self.fig_tabs.lock().unwrap();
        let tabs = all.entry(session.to_owned()).or_default();
        let current = self.workspace.session(session)?.binding;
        let current_index = current
            .as_ref()
            .and_then(|id| tabs.iter().position(|tab| tab == id));
        let index =
            |field: &str| -> Option<usize> { usize::try_from(params[field].as_u64()?).ok() };
        let invalid = || EngineError::invalid("tab index is outside the open documents");
        match name {
            "doc.list" => {
                let listing = self.workspace.list(false)?;
                let entries = listing["documents"].as_array().unwrap();
                Ok(json!(
                    tabs.iter()
                        .enumerate()
                        .filter_map(|(index, id)| {
                            let item = entries.iter().find(|item| item["id"] == *id)?;
                            Some(json!({"id":external_id(id),"name":item["title"],"index":index}))
                        })
                        .collect::<Vec<_>>()
                ))
            }
            "file.moveTab" => {
                let from = index("from")
                    .filter(|i| *i < tabs.len())
                    .ok_or_else(invalid)?;
                let to = index("to")
                    .filter(|i| *i < tabs.len())
                    .ok_or_else(invalid)?;
                let id = tabs.remove(from);
                tabs.insert(to, id);
                Ok(json!({"ok":true}))
            }
            "file.close" => {
                let index = index("index").or(current_index).ok_or_else(invalid)?;
                let document = tabs.get(index).ok_or_else(invalid)?.clone();
                let snapshot = self.workspace.context(&document)?;
                let dirty = self.state(session, &document)?.fig_saved_revision
                    != Some(snapshot.revision.sequence);
                if dirty && params["force"] != true {
                    return Err(EngineError::new("conflict", "document has unsaved changes"));
                }
                self.workspace.release(session, &document)?;
                tabs.remove(index);
                self.states
                    .lock()
                    .unwrap()
                    .remove(&(session.into(), document));
                if current_index == Some(index)
                    && let Some(next) = tabs.get(index.min(tabs.len().saturating_sub(1)))
                {
                    self.workspace.bind(session, next)?;
                }
                Ok(json!({"ok":true}))
            }
            _ => {
                if tabs.is_empty() {
                    return Err(invalid());
                }
                let index = match name {
                    "doc.switch" => index("index").ok_or_else(invalid)?,
                    "doc.nextTab" => current_index.map_or(0, |i| (i + 1) % tabs.len()),
                    "doc.previousTab" => {
                        current_index.map_or(tabs.len() - 1, |i| (i + tabs.len() - 1) % tabs.len())
                    }
                    _ => return Err(EngineError::invalid("unknown tab command")),
                };
                let document = tabs.get(index).ok_or_else(invalid)?;
                let title = self.workspace.context(document)?.title;
                self.workspace.bind(session, document)?;
                Ok(json!({"id":external_id(document),"name":title,"index":index}))
            }
        }
    }
}
