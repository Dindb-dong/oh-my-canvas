//! Authored document types. This crate has no storage, graphics or network dependencies.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use uuid::Uuid;

pub type Properties = BTreeMap<String, Value>;

pub fn new_id(prefix: &str) -> String {
    format!("{prefix}_{}", Uuid::new_v4().simple())
}

pub fn valid_id(id: &str, prefix: &str) -> bool {
    id.strip_prefix(&format!("{prefix}_"))
        .is_some_and(|suffix| {
            suffix.len() == 32
                && suffix
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        })
}

pub fn valid_rank(rank: &str) -> bool {
    rank.len() == 32
        && rank
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

pub fn initial_rank() -> String {
    format!("{:032x}", u128::MAX / 2)
}

pub fn rank_between(left: Option<&str>, right: Option<&str>) -> Option<String> {
    let left = left
        .map(|v| u128::from_str_radix(v, 16))
        .transpose()
        .ok()?
        .unwrap_or(0);
    let right = right
        .map(|v| u128::from_str_radix(v, 16))
        .transpose()
        .ok()?
        .unwrap_or(u128::MAX);
    if right <= left || right - left < 2 {
        return None;
    }
    Some(format!("{:032x}", left + (right - left) / 2))
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NodeKind {
    #[default]
    Frame,
    Group,
    Rect,
    Ellipse,
    Line,
    Path,
    Text,
    Image,
    Component,
    Instance,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Node {
    pub id: String,
    pub kind: NodeKind,
    pub parent_id: Option<String>,
    pub rank: String,
    pub home_shard: String,
    #[serde(default)]
    pub properties: Properties,
}

impl Node {
    pub fn new(kind: NodeKind) -> Self {
        Self {
            id: new_id("node"),
            kind,
            parent_id: None,
            rank: initial_rank(),
            home_shard: new_id("shard"),
            properties: Properties::new(),
        }
    }

    pub fn number(&self, name: &str, default: f64) -> f64 {
        self.properties
            .get(name)
            .and_then(Value::as_f64)
            .filter(|v| v.is_finite())
            .unwrap_or(default)
    }

    pub fn string(&self, name: &str) -> Option<&str> {
        self.properties.get(name).and_then(Value::as_str)
    }

    pub fn validate(&self) -> Result<(), String> {
        if !valid_id(&self.id, "node") {
            return Err("invalid node ID".into());
        }
        if !valid_id(&self.home_shard, "shard") {
            return Err("invalid home shard ID".into());
        }
        if !valid_rank(&self.rank) {
            return Err("rank must be 32 lowercase hexadecimal digits".into());
        }
        if self
            .parent_id
            .as_ref()
            .is_some_and(|id| !valid_id(id, "node"))
        {
            return Err("invalid parent ID".into());
        }
        validate_properties(&self.properties)?;
        if self.kind == NodeKind::Text {
            let text = match self.properties.get("text") {
                Some(Value::String(text)) => text.as_str(),
                None => "",
                _ => return Err("text must be a string".into()),
            };
            if let Some(runs) = self.properties.get("textRuns") {
                let runs = runs.as_array().ok_or("textRuns must be an array")?;
                let mut offset = 0;
                for run in runs {
                    let object = run.as_object().ok_or("text run must be an object")?;
                    if object
                        .keys()
                        .any(|key| key != "text" && key != "attributes")
                    {
                        return Err("unknown text run field".into());
                    }
                    let part = object
                        .get("text")
                        .and_then(Value::as_str)
                        .ok_or("text run requires text")?;
                    let attributes = object
                        .get("attributes")
                        .and_then(Value::as_object)
                        .ok_or("text run requires attributes")?;
                    validate_properties(
                        &attributes
                            .iter()
                            .map(|(key, value)| (key.clone(), value.clone()))
                            .collect(),
                    )?;
                    let end = offset + part.len();
                    if text.get(offset..end) != Some(part) {
                        return Err("textRuns must concatenate to canonical text".into());
                    }
                    offset = end;
                }
                if offset != text.len() {
                    return Err("textRuns must concatenate to canonical text".into());
                }
            }
        }
        Ok(())
    }
}

pub fn validate_properties(properties: &Properties) -> Result<(), String> {
    if properties.len() > 1024 {
        return Err("too many properties".into());
    }
    for (key, value) in properties {
        if key.is_empty() || key.len() > 256 {
            return Err("invalid property name".into());
        }
        if matches!(
            key.as_str(),
            "x" | "y" | "width" | "height" | "rotation" | "opacity" | "fontSize" | "strokeWidth"
        ) {
            let number = value
                .as_f64()
                .filter(|n| n.is_finite())
                .ok_or_else(|| format!("{key} must be a finite number"))?;
            if matches!(
                key.as_str(),
                "width" | "height" | "fontSize" | "strokeWidth"
            ) && number < 0.0
            {
                return Err(format!("{key} cannot be negative"));
            }
            if key == "opacity" && !(0.0..=1.0).contains(&number) {
                return Err("opacity must be between zero and one".into());
            }
        }
        if json_depth(value) > 64 {
            return Err("property nesting exceeds 64".into());
        }
    }
    Ok(())
}

fn json_depth(value: &Value) -> usize {
    match value {
        Value::Array(values) => 1 + values.iter().map(json_depth).max().unwrap_or(0),
        Value::Object(values) => 1 + values.values().map(json_depth).max().unwrap_or(0),
        _ => 0,
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Page {
    pub id: String,
    pub title: String,
    pub root_node_id: String,
    pub rank: String,
}

impl Page {
    pub fn new(title: impl Into<String>, root_node_id: impl Into<String>) -> Self {
        Self {
            id: new_id("page"),
            title: title.into(),
            root_node_id: root_node_id.into(),
            rank: initial_rank(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DocumentContent {
    pub title: String,
    pub pages: Vec<Page>,
    pub nodes: BTreeMap<String, Node>,
    #[serde(default)]
    pub metadata: Properties,
}

impl DocumentContent {
    pub fn empty(title: impl Into<String>) -> Self {
        let mut root = Node::new(NodeKind::Frame);
        root.properties
            .insert("name".into(), Value::String("Page 1".into()));
        let page = Page::new("Page 1", root.id.clone());
        Self {
            title: title.into(),
            pages: vec![page],
            nodes: [(root.id.clone(), root)].into(),
            metadata: Properties::new(),
        }
    }

    pub fn validate(&self) -> Result<(), String> {
        if self.title.len() > 4096 {
            return Err("document title is too long".into());
        }
        if self.pages.is_empty() {
            return Err("a document needs at least one page".into());
        }
        let mut page_ids = BTreeSet::new();
        let mut roots = BTreeSet::new();
        for page in &self.pages {
            if !valid_id(&page.id, "page") || !valid_rank(&page.rank) || page.title.len() > 4096 {
                return Err("invalid page".into());
            }
            if !page_ids.insert(&page.id) || !roots.insert(&page.root_node_id) {
                return Err("duplicate page or root".into());
            }
            let root = self
                .nodes
                .get(&page.root_node_id)
                .ok_or("missing page root")?;
            if root.parent_id.is_some() || root.kind != NodeKind::Frame {
                return Err("page root must be an unparented frame".into());
            }
        }
        for (id, node) in &self.nodes {
            if id != &node.id {
                return Err("node map key does not match its identity".into());
            }
            node.validate()?;
            let mut cursor = node;
            let mut visited = BTreeSet::new();
            while let Some(parent_id) = &cursor.parent_id {
                if !visited.insert(parent_id) {
                    return Err("containment cycle".into());
                }
                if visited.len() > 256 {
                    return Err("containment depth exceeds 256".into());
                }
                cursor = self.nodes.get(parent_id).ok_or("missing parent")?;
            }
            if !roots.contains(&cursor.id) {
                return Err("node is not attached to a page".into());
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Revision {
    pub epoch: String,
    #[serde(with = "decimal_u64")]
    pub sequence: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DocumentSnapshot {
    pub id: String,
    pub title: String,
    pub epoch: String,
    #[serde(with = "decimal_u64")]
    pub sequence: u64,
    pub pages: Vec<Page>,
    pub nodes: BTreeMap<String, Node>,
    #[serde(default)]
    pub metadata: Properties,
}

impl DocumentSnapshot {
    pub fn revision(&self) -> Revision {
        Revision {
            epoch: self.epoch.clone(),
            sequence: self.sequence,
        }
    }
    pub fn content(&self) -> DocumentContent {
        DocumentContent {
            title: self.title.clone(),
            pages: self.pages.clone(),
            nodes: self.nodes.clone(),
            metadata: self.metadata.clone(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Association {
    Before,
    After,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RelativePosition {
    pub left: Option<String>,
    pub right: Option<String>,
    pub association: Association,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TextSelection {
    pub node_id: String,
    pub start: RelativePosition,
    pub end: RelativePosition,
    pub observed_items: Vec<String>,
}

pub mod decimal_u64 {
    use serde::{Deserialize, Deserializer, Serializer, de::Error};
    pub fn serialize<S: Serializer>(value: &u64, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&value.to_string())
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<u64, D::Error> {
        let text = String::deserialize(deserializer)?;
        if text.is_empty()
            || (text.len() > 1 && text.starts_with('0'))
            || !text.bytes().all(|b| b.is_ascii_digit())
        {
            return Err(D::Error::custom(
                "expected canonical unsigned decimal string",
            ));
        }
        text.parse().map_err(D::Error::custom)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ids_and_ranks_do_not_accept_ambiguous_inputs() {
        assert!(valid_id(&new_id("node"), "node"));
        assert!(!valid_id("node_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "node"));
        assert!(
            rank_between(
                Some("00000000000000000000000000000001"),
                Some("00000000000000000000000000000002")
            )
            .is_none()
        );
    }
    #[test]
    fn import_rejects_cycle_and_missing_parent() {
        let mut content = DocumentContent::empty("test");
        let mut child = Node::new(NodeKind::Rect);
        child.parent_id = Some(child.id.clone());
        content.nodes.insert(child.id.clone(), child);
        assert!(content.validate().unwrap_err().contains("cycle"));
    }
    #[test]
    fn revisions_do_not_round_large_counters() {
        let revision = Revision {
            epoch: Uuid::nil().to_string(),
            sequence: u64::MAX,
        };
        let text = serde_json::to_string(&revision).unwrap();
        assert!(text.contains("\"18446744073709551615\""));
        assert_eq!(serde_json::from_str::<Revision>(&text).unwrap(), revision);
        assert!(serde_json::from_str::<Revision>("{\"epoch\":\"x\",\"sequence\":1}").is_err());
    }
}
