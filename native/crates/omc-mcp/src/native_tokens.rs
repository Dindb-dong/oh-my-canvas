use super::{DocumentSnapshot, EngineError, Result, ToolRouter, Value, json, string};

impl ToolRouter {
    pub(crate) fn inspect_native_token(
        &self,
        session: &str,
        document: &str,
        snapshot: &DocumentSnapshot,
        args: &Value,
    ) -> Result<Value> {
        let id = string(args, "id")?;
        let node = args["nodeId"]
            .as_str()
            .map(|node_id| {
                let raw = self.resolve(session, document, node_id)?;
                snapshot
                    .nodes
                    .get(&raw)
                    .ok_or_else(|| EngineError::invalid("layer not found in this document"))
            })
            .transpose()?;
        let context = omc_style::ReferenceContext::new(snapshot);
        let source = context
            .token_source(id, node)
            .ok_or_else(|| EngineError::invalid("token not found in this document"))?;
        let (effective, diagnostics) = match context.resolve_value(&json!({"$token":id}), node) {
            Ok(value) => (value, json!([])),
            Err(reason) => (
                Value::Null,
                json!([{"code":"unresolved_reference","message":reason}]),
            ),
        };
        Ok(json!({
            "revision": snapshot.revision(),
            "nodeId": node.map(|node| &node.id),
            "token": source.token,
            "mode": source.mode,
            "authoredValue": source.value,
            "effectiveValue": effective,
            "diagnostics": diagnostics
        }))
    }
}
