use super::*;

impl ToolRouter {
    pub fn legacy_view_arguments(&self, session: &str, args: &Value) -> Result<Value> {
        schema::validate("view", args)?;
        let document = native_id(string(args, "documentId")?)?;
        let document = self.workspace.target(session, Some(&document))?;
        let snapshot = self.workspace.snapshot(&document)?;
        if !self
            .state(session, &document)
            .is_ok_and(|state| state.epoch == snapshot.epoch)
        {
            self.context_from(session, &snapshot)?;
        }
        let state = self.state(session, &document)?;
        let mut result = args.clone();
        result["documentId"] = json!(document);
        result["pageId"] = json!(state.page_id);
        result["epoch"] = json!(snapshot.epoch);
        if let Some(ids) = args["ids"].as_array() {
            let raw = ids
                .iter()
                .map(|id| self.resolve(session, &document, id.as_str().unwrap()))
                .collect::<Result<Vec<_>>>()?;
            result["ids"] = json!(raw);
        }
        Ok(result)
    }

    pub fn legacy_view_response(
        &self,
        session: &str,
        request: &Value,
        response: Value,
    ) -> Result<Value> {
        let document = string(request, "documentId")?;
        let mut states = self.states.lock().unwrap();
        let state = states
            .get_mut(&(session.into(), document.into()))
            .filter(|state| state.page_id == request["pageId"] && state.epoch == request["epoch"])
            .ok_or_else(|| {
                EngineError::new(
                    "stale_revision",
                    "The requested view changed before desktop readback",
                )
            })?;
        let mut view = response["view"].clone();
        let raw = view["selection"]
            .as_array()
            .ok_or_else(|| EngineError::invalid("Invalid desktop selection"))?;
        let selection = raw
            .iter()
            .map(|id| {
                let id = id
                    .as_str()
                    .ok_or_else(|| EngineError::invalid("Invalid desktop selection"))?;
                Ok(state.legacy_alias(id))
            })
            .collect::<Result<Vec<_>>>()?;
        view["selection"] = json!(selection);
        for field in ["viewport", "selection", "tool", "flags"] {
            state.view[field] = view[field].clone();
        }
        Ok(legacy_view_output(view, response["revision"].clone()))
    }
}

impl ViewState {
    pub(super) fn legacy_alias(&mut self, raw: &str) -> String {
        if raw == self.root {
            return "root".into();
        }
        if let Some((alias, _)) = self.aliases.iter().find(|(_, id)| *id == raw) {
            return alias.clone();
        }
        self.next_alias += 1;
        let alias = format!("n{}", self.next_alias);
        self.aliases.insert(alias.clone(), raw.into());
        alias
    }
}

pub(super) fn legacy_view_output(view: Value, revision: Value) -> Value {
    json!({"ok":true,"revision":revision,"view":view,
        "viewport":view["viewport"],"selection":view["selection"],"tool":view["tool"],"flags":view["flags"]})
}
