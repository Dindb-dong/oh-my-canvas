use super::{
    DocumentSnapshot, EngineError, Properties, Result, ToolRouter, Value, json, resources, string,
};
use crate::figcraft_catalog::{collection_mode, collection_mode_command};

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

    pub(crate) fn native_token_scope(
        &self,
        session: &str,
        document: &str,
        snapshot: &DocumentSnapshot,
        args: &Value,
        meta: &Value,
    ) -> Result<Value> {
        let collections = resources::catalogs(&snapshot.metadata, "figcraftCollections");
        if args["action"] == "list_collections" {
            return Ok(json!({
                "revision": snapshot.revision(),
                "items": collections.values().collect::<Vec<_>>()
            }));
        }
        let collection_id = string(args, "id")?;
        let collection = collections
            .get(collection_id)
            .ok_or_else(|| EngineError::invalid("collection not found in this document"))?;
        let mode = collection_mode(collection, args.get("mode"))?;
        let raw = self.resolve(session, document, string(args, "nodeId")?)?;
        let node = snapshot
            .nodes
            .get(&raw)
            .ok_or_else(|| EngineError::invalid("layer not found in this document"))?;
        let command = collection_mode_command(node, collection_id, mode)?;
        self.submit_with_output(
            session,
            document,
            command,
            meta,
            Some(snapshot.sequence),
            Properties::from([
                ("id".into(), json!(collection_id)),
                ("nodeId".into(), json!(raw)),
                ("mode".into(), json!(mode)),
            ]),
        )
    }
}
