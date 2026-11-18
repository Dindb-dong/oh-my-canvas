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

pub(crate) fn is_definition_action(snapshot: &DocumentSnapshot, args: &Value) -> bool {
    match args["action"].as_str() {
        Some(
            "create_collection" | "rename_collection" | "add_mode" | "rename_mode" | "move_mode"
            | "remove_mode" | "extend_collection" | "delete_collection" | "set_value"
            | "reset_override" | "unbind",
        ) => true,
        Some("create") => args.get("collectionId").is_some(),
        Some("bind" | "update" | "delete") => {
            let tokens = resources::catalogs(&snapshot.metadata, "tokens");
            let token = args["id"].as_str().and_then(|id| tokens.get(id));
            if args["action"] == "bind" {
                token.is_some_and(|token| {
                    matches!(
                        token["type"].as_str(),
                        Some("color" | "number" | "string" | "boolean")
                    )
                })
            } else {
                args["patch"].get("collectionId").is_some()
                    || token.is_some_and(|token| {
                        token["collectionId"].is_string() || token["libraryId"].is_string()
                    })
            }
        }
        _ => false,
    }
}

impl ToolRouter {
    pub(crate) fn native_token_definition(
        &self,
        session: &str,
        document: &str,
        snapshot: &DocumentSnapshot,
        args: &Value,
        meta: &Value,
    ) -> Result<Value> {
        use crate::figcraft_catalog::{variable_definition, variable_ops};
        use omc_protocol::Command;

        let action = string(args, "action")?;
        let collections = resources::catalogs(&snapshot.metadata, "figcraftCollections");
        let tokens = resources::catalogs(&snapshot.metadata, "tokens");
        let mut commands = Vec::new();
        let result = if matches!(action, "bind" | "unbind") {
            let node = self.resolve(session, document, string(args, "nodeId")?)?;
            let mut current = snapshot.nodes.get(&node);
            if current.is_none() {
                return Err(EngineError::invalid("layer not found in this document"));
            }
            while let Some(layer) = current {
                if layer.properties.get("locked") == Some(&Value::Bool(true))
                    || layer.properties.get("hidden") == Some(&Value::Bool(true))
                    || layer.properties.get("visible") == Some(&Value::Bool(false))
                {
                    return Err(EngineError::invalid(
                        "layer or ancestor is locked or hidden",
                    ));
                }
                current = layer
                    .parent_id
                    .as_ref()
                    .and_then(|parent| snapshot.nodes.get(parent));
            }
            let variable = if action == "bind" {
                Some(&args["id"])
            } else {
                Some(&Value::Null)
            };
            variable_definition::bind(
                snapshot,
                &tokens,
                string(args, "property")?,
                variable,
                vec![node],
                &mut commands,
            )?;
            json!({})
        } else {
            let mut params = args.clone();
            let shared = match action {
                "create_collection" => {
                    if let Some(modes) = args.get("modeNames") {
                        params["modes"] = modes.clone();
                    }
                    "createCollection"
                }
                "create" => {
                    params["collection"] = json!(string(args, "collectionId")?);
                    if let Some(modes) = args.get("modes") {
                        params["values"] = modes.clone();
                    }
                    "create"
                }
                "rename_collection" | "add_mode" | "rename_mode" | "move_mode" | "remove_mode"
                | "extend_collection" | "delete_collection" => {
                    params["collection"] = json!(string(args, "id")?);
                    match action {
                        "rename_collection" => "renameCollection",
                        "add_mode" => {
                            if let Some(from) = args.get("fromMode") {
                                params["from"] = from.clone();
                            }
                            "addMode"
                        }
                        "rename_mode" => "renameMode",
                        "move_mode" => {
                            params["to"] = args["index"].clone();
                            "moveMode"
                        }
                        "remove_mode" => "removeMode",
                        "extend_collection" => "extendCollection",
                        _ => "deleteCollection",
                    }
                }
                "set_value" | "reset_override" | "update" | "delete" => {
                    let id = string(args, "id")?;
                    if action == "update" {
                        let patch = args["patch"].as_object().ok_or_else(|| {
                            EngineError::invalid("token metadata patch must be an object")
                        })?;
                        if patch.keys().any(|key| {
                            !matches!(
                                key.as_str(),
                                "name"
                                    | "description"
                                    | "scopes"
                                    | "hiddenFromPublishing"
                                    | "codeSyntax"
                            )
                        }) {
                            return Err(EngineError::invalid(
                                "token definitions keep their type and collection; use set_value to edit a mode",
                            ));
                        }
                        params = args["patch"].clone();
                    }
                    params["variable"] = json!(id);
                    match action {
                        "set_value" => "set",
                        "reset_override" => "resetOverride",
                        action => action,
                    }
                }
                _ => return Err(EngineError::invalid("unknown token definition action")),
            };
            variable_definition::plan(
                snapshot,
                &collections,
                &tokens,
                shared,
                &params,
                &mut commands,
            )?
        };
        if commands.is_empty() {
            return Ok(json!({"ok":true,"revision":snapshot.sequence}));
        }
        variable_ops::sync_extensions(snapshot, &mut commands)?;
        let command = if commands.len() == 1 {
            commands.pop().unwrap()
        } else {
            Command::Batch { commands }
        };
        self.submit_with_output(
            session,
            document,
            command,
            meta,
            Some(snapshot.sequence),
            super::properties(&result)?,
        )
    }
}
