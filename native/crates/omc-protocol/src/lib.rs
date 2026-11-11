//! Native protocol, independent of any transport or mutable document.
use omc_model::{Node, Page, Properties, Revision, TextSelection};
use serde::{
    Deserialize, Deserializer, Serialize,
    de::{MapAccess, SeqAccess, Visitor},
};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::fmt;

pub const ENGINE_PROTOCOL: &str = "omc.engine/1";
pub const SYNC_PROTOCOL: &str = "omc.sync/1";
pub const CRDT_PROFILE: &str = "omc.operations/1";
pub const MAX_REQUEST_BYTES: usize = 1024 * 1024;
pub const MAX_SEMANTIC_BYTES: usize = 4 * 1024 * 1024;
pub const MAX_BATCH_OPERATIONS: usize = 100;
pub const MAX_INLINE_BYTES: usize = 512 * 1024;
pub const MAX_FRAGMENT_BYTES: usize = 256 * 1024;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EngineError {
    pub code: String,
    pub message: String,
    pub retryable: bool,
    #[serde(default)]
    pub details: Value,
}

impl EngineError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        let code = code.into();
        let retryable = matches!(
            code.as_str(),
            "busy"
                | "queue_full"
                | "resource_limit"
                | "storage_unavailable"
                | "dependency_unavailable"
        );
        Self {
            code,
            message: message.into(),
            retryable,
            details: Value::Null,
        }
    }
    pub fn detail(mut self, details: Value) -> Self {
        self.details = details;
        self
    }
    pub fn invalid(message: impl Into<String>) -> Self {
        Self::new("invalid_argument", message)
    }
}

impl fmt::Display for EngineError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}
impl std::error::Error for EngineError {}
pub type Result<T> = std::result::Result<T, EngineError>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LatestBasis {
    Latest,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum HistoryChannel {
    Design,
    Comments,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FieldPrecondition {
    pub entity_id: String,
    pub field: String,
    /// The winning operation ID, or null when the property was absent.
    pub version: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged, deny_unknown_fields)]
pub enum Preconditions {
    Revision { revision: Revision },
    Dependencies { fields: Vec<FieldPrecondition> },
    Latest { basis: LatestBasis },
}
impl Default for Preconditions {
    fn default() -> Self {
        Self::Latest {
            basis: LatestBasis::Latest,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", deny_unknown_fields)]
pub enum Command {
    #[serde(rename = "node.create")]
    NodeCreate { node: Node },
    #[serde(rename = "node.set")]
    NodeSet {
        #[serde(rename = "nodeId")]
        node_id: String,
        properties: Properties,
    },
    #[serde(rename = "node.unset")]
    NodeUnset {
        #[serde(rename = "nodeId")]
        node_id: String,
        properties: Vec<String>,
    },
    #[serde(rename = "node.move")]
    NodeMove {
        #[serde(rename = "nodeId")]
        node_id: String,
        #[serde(rename = "parentId")]
        parent_id: Option<String>,
        rank: String,
    },
    #[serde(rename = "node.delete")]
    NodeDelete {
        #[serde(rename = "nodeIds")]
        node_ids: Vec<String>,
    },
    #[serde(rename = "node.rebalance")]
    NodeRebalance {
        #[serde(rename = "parentId")]
        parent_id: String,
    },
    #[serde(rename = "page.create")]
    PageCreate { page: Page, root: Node },
    #[serde(rename = "page.rename")]
    PageRename {
        #[serde(rename = "pageId")]
        page_id: String,
        title: String,
    },
    #[serde(rename = "page.delete")]
    PageDelete {
        #[serde(rename = "pageId")]
        page_id: String,
    },
    #[serde(rename = "document.rename")]
    DocumentRename { title: String },
    #[serde(rename = "document.metadata")]
    DocumentMetadata { properties: Properties },
    #[serde(rename = "catalog.set")]
    CatalogSet {
        namespace: String,
        #[serde(rename = "entityId")]
        entity_id: String,
        properties: Properties,
    },
    #[serde(rename = "text.insert")]
    TextInsert {
        #[serde(rename = "nodeId")]
        node_id: String,
        offset: u32,
        text: String,
        #[serde(default)]
        attributes: Properties,
    },
    #[serde(rename = "text.delete")]
    TextDelete {
        #[serde(rename = "nodeId")]
        node_id: String,
        start: u32,
        end: u32,
    },
    #[serde(rename = "text.mark")]
    TextMark {
        #[serde(rename = "nodeId")]
        node_id: String,
        start: u32,
        end: u32,
        attributes: Properties,
    },
    #[serde(rename = "text.replace")]
    TextReplace {
        #[serde(rename = "nodeId")]
        node_id: String,
        text: String,
    },
    #[serde(rename = "text.splice")]
    TextSplice {
        selection: TextSelection,
        text: String,
        #[serde(default)]
        attributes: Properties,
    },
    #[serde(rename = "batch")]
    Batch { commands: Vec<Command> },
    #[serde(rename = "undo")]
    Undo,
    #[serde(rename = "redo")]
    Redo,
    #[serde(rename = "history.undo")]
    HistoryUndo { channel: HistoryChannel },
    #[serde(rename = "history.redo")]
    HistoryRedo { channel: HistoryChannel },
}

impl Command {
    pub fn operation_count(&self) -> usize {
        match self {
            Self::Batch { commands } => commands.iter().map(Self::operation_count).sum(),
            _ => 1,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CommandEnvelope {
    pub protocol: String,
    pub request_id: String,
    pub document_id: String,
    pub target_epoch: String,
    pub idempotency_key: String,
    pub preconditions: Preconditions,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub undo_group: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deadline_ms: Option<u64>,
    pub command: Command,
}

impl CommandEnvelope {
    pub fn new(document_id: impl Into<String>, epoch: impl Into<String>, command: Command) -> Self {
        Self {
            protocol: ENGINE_PROTOCOL.into(),
            request_id: uuid::Uuid::new_v4().to_string(),
            document_id: document_id.into(),
            target_epoch: epoch.into(),
            idempotency_key: uuid::Uuid::new_v4().to_string(),
            preconditions: Preconditions::default(),
            undo_group: None,
            deadline_ms: None,
            command,
        }
    }

    pub fn validate(&self) -> Result<()> {
        if self.protocol != ENGINE_PROTOCOL {
            return Err(EngineError::new(
                "protocol_mismatch",
                "unsupported engine protocol",
            ));
        }
        if !omc_model::valid_id(&self.document_id, "doc")
            || uuid::Uuid::parse_str(&self.target_epoch).is_err()
        {
            return Err(EngineError::invalid("invalid document ID or epoch"));
        }
        if self.idempotency_key.is_empty()
            || self.idempotency_key.len() > 256
            || self.request_id.len() > 256
        {
            return Err(EngineError::invalid("invalid request or idempotency key"));
        }
        if self
            .undo_group
            .as_ref()
            .is_some_and(|s| s.is_empty() || s.len() > 256)
        {
            return Err(EngineError::invalid("invalid Undo group"));
        }
        if self.deadline_ms.is_some_and(|n| n == 0 || n > 60_000) {
            return Err(EngineError::invalid(
                "deadline must be 1–60000 milliseconds",
            ));
        }
        let count = self.command.operation_count();
        if count == 0 || count > MAX_BATCH_OPERATIONS {
            return Err(EngineError::new(
                "resource_limit",
                "batch operation limit is 100",
            ));
        }
        if serde_json::to_vec(&self.command)
            .map_err(|e| EngineError::invalid(e.to_string()))?
            .len()
            > MAX_SEMANTIC_BYTES
        {
            return Err(EngineError::new(
                "resource_limit",
                "semantic payload exceeds 4 MiB",
            ));
        }
        Ok(())
    }

    pub fn digest(&self) -> Result<String> {
        let payload = serde_json::json!({"protocol": self.protocol, "documentId": self.document_id,
            "targetEpoch": self.target_epoch, "command": self.command, "preconditions": self.preconditions,
            "undoGroup": self.undo_group});
        canonical_digest(&payload)
    }
}

pub fn canonical_digest<T: Serialize>(value: &T) -> Result<String> {
    let bytes = serde_jcs::to_vec(value).map_err(|e| EngineError::invalid(e.to_string()))?;
    Ok(hex::encode(Sha256::digest(bytes)))
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RequestContext {
    pub author_id: String,
    pub session_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DurableResult {
    pub request_id: String,
    pub status: String,
    pub transaction_id: String,
    pub revision: Revision,
    pub replayed: bool,
    pub result: Value,
}

/// Decode once at the trust boundary. serde_json::Value alone discards duplicate keys.
pub fn decode_command(bytes: &[u8]) -> Result<CommandEnvelope> {
    let value = decode_json(bytes)?;
    let envelope: CommandEnvelope =
        serde_json::from_value(value).map_err(|e| EngineError::invalid(e.to_string()))?;
    envelope.validate()?;
    Ok(envelope)
}

pub fn decode_json(bytes: &[u8]) -> Result<Value> {
    decode_json_with_limit(bytes, MAX_REQUEST_BYTES)
}

/// Opt-in for explicit native file operations; ordinary MCP remains limited to 1 MiB.
pub fn decode_json_with_limit(bytes: &[u8], maximum: usize) -> Result<Value> {
    if bytes.len() > maximum.min(64 * 1024 * 1024) {
        return Err(EngineError::new(
            "resource_limit",
            "request exceeds its declared body limit",
        ));
    }
    let mut de = serde_json::Deserializer::from_slice(bytes);
    let value = UniqueValue::deserialize(&mut de)
        .map_err(|e| EngineError::invalid(e.to_string()))?
        .0;
    de.end().map_err(|e| EngineError::invalid(e.to_string()))?;
    if depth(&value) > 64 {
        return Err(EngineError::new(
            "resource_limit",
            "JSON nesting exceeds 64",
        ));
    }
    Ok(value)
}

fn depth(value: &Value) -> usize {
    match value {
        Value::Array(a) => 1 + a.iter().map(depth).max().unwrap_or(0),
        Value::Object(o) => 1 + o.values().map(depth).max().unwrap_or(0),
        _ => 0,
    }
}
struct UniqueValue(Value);
impl<'de> Deserialize<'de> for UniqueValue {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> std::result::Result<Self, D::Error> {
        struct UniqueVisitor;
        impl<'de> Visitor<'de> for UniqueVisitor {
            type Value = UniqueValue;
            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str("JSON without duplicate object keys")
            }
            fn visit_bool<E: serde::de::Error>(
                self,
                v: bool,
            ) -> std::result::Result<Self::Value, E> {
                Ok(UniqueValue(Value::Bool(v)))
            }
            fn visit_i64<E: serde::de::Error>(self, v: i64) -> std::result::Result<Self::Value, E> {
                Ok(UniqueValue(v.into()))
            }
            fn visit_u64<E: serde::de::Error>(self, v: u64) -> std::result::Result<Self::Value, E> {
                Ok(UniqueValue(v.into()))
            }
            fn visit_f64<E: serde::de::Error>(self, v: f64) -> std::result::Result<Self::Value, E> {
                serde_json::Number::from_f64(v)
                    .map(|n| UniqueValue(Value::Number(n)))
                    .ok_or_else(|| E::custom("nonfinite number"))
            }
            fn visit_str<E: serde::de::Error>(
                self,
                v: &str,
            ) -> std::result::Result<Self::Value, E> {
                Ok(UniqueValue(Value::String(v.into())))
            }
            fn visit_string<E: serde::de::Error>(
                self,
                v: String,
            ) -> std::result::Result<Self::Value, E> {
                Ok(UniqueValue(Value::String(v)))
            }
            fn visit_none<E: serde::de::Error>(self) -> std::result::Result<Self::Value, E> {
                Ok(UniqueValue(Value::Null))
            }
            fn visit_unit<E: serde::de::Error>(self) -> std::result::Result<Self::Value, E> {
                Ok(UniqueValue(Value::Null))
            }
            fn visit_seq<A: SeqAccess<'de>>(
                self,
                mut seq: A,
            ) -> std::result::Result<Self::Value, A::Error> {
                let mut out = Vec::new();
                while let Some(value) = seq.next_element::<UniqueValue>()? {
                    out.push(value.0);
                }
                Ok(UniqueValue(Value::Array(out)))
            }
            fn visit_map<A: MapAccess<'de>>(
                self,
                mut map: A,
            ) -> std::result::Result<Self::Value, A::Error> {
                let mut out = serde_json::Map::new();
                while let Some((key, value)) = map.next_entry::<String, UniqueValue>()? {
                    if out.insert(key, value.0).is_some() {
                        return Err(serde::de::Error::custom("duplicate JSON object key"));
                    }
                }
                Ok(UniqueValue(Value::Object(out)))
            }
        }
        deserializer.deserialize_any(UniqueVisitor)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unknown_and_duplicate_fields_reject_at_trust_boundary() {
        let e = CommandEnvelope::new(
            omc_model::new_id("doc"),
            uuid::Uuid::new_v4().to_string(),
            Command::Undo,
        );
        let mut value = serde_json::to_value(&e).unwrap();
        value["authorId"] = "impersonated".into();
        assert!(decode_command(&serde_json::to_vec(&value).unwrap()).is_err());
        assert!(
            decode_command(br#"{"protocol":"x","protocol":"y"}"#)
                .unwrap_err()
                .message
                .contains("duplicate")
        );
    }
    #[test]
    fn request_id_and_deadline_do_not_change_durable_identity() {
        let mut e = CommandEnvelope::new(
            omc_model::new_id("doc"),
            uuid::Uuid::new_v4().to_string(),
            Command::Undo,
        );
        let digest = e.digest().unwrap();
        e.request_id = "another".into();
        e.deadline_ms = Some(500);
        assert_eq!(digest, e.digest().unwrap());
    }
    #[test]
    fn jcs_uses_utf16_key_order() {
        let value = serde_json::json!({"\u{e000}":1,"\u{1f600}":2,"a":-0.0});
        assert_eq!(
            String::from_utf8(serde_jcs::to_vec(&value).unwrap()).unwrap(),
            "{\"a\":0,\"😀\":2,\"\u{e000}\":1}"
        );
    }
}
