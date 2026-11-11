//! Native attributed-operation CRDT. This is explicitly not a Yjs/Yrs wire codec.
use omc_model::{
    Association, DocumentContent, Node, NodeKind, Page, Properties, RelativePosition, TextSelection,
};
use omc_protocol::{
    CRDT_PROFILE, EngineError, MAX_FRAGMENT_BYTES, MAX_SEMANTIC_BYTES, Result, canonical_digest,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Stamp {
    pub lamport: u64,
    pub replica_id: String,
    pub counter: u64,
}

impl Stamp {
    pub fn genesis() -> Self {
        Self {
            lamport: 0,
            replica_id: uuid::Uuid::nil().to_string(),
            counter: 0,
        }
    }
    pub fn operation_id(&self) -> String {
        format!("{}:{}", self.replica_id, self.counter)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum Action {
    CreateNode {
        node: Node,
    },
    SetNode {
        node_id: String,
        properties: Properties,
    },
    UnsetNode {
        node_id: String,
        properties: Vec<String>,
    },
    MoveNode {
        node_id: String,
        parent_id: Option<String>,
        rank: String,
    },
    AdjustRank {
        node_id: String,
        placement_version: String,
        parent_id: String,
        rank: String,
    },
    DeleteNode {
        node_id: String,
    },
    CreatePage {
        page: Page,
    },
    RenamePage {
        page_id: String,
        title: String,
    },
    DeletePage {
        page_id: String,
    },
    RenameDocument {
        title: String,
    },
    SetMetadata {
        properties: Properties,
    },
    TextInsert {
        node_id: String,
        after: Option<String>,
        text: String,
        attributes: Properties,
    },
    TextDelete {
        node_id: String,
        items: Vec<String>,
    },
    TextMark {
        node_id: String,
        items: Vec<String>,
        attributes: Properties,
    },
    Retract {
        entity_id: String,
        operation_id: String,
    },
}

impl Action {
    pub fn entity_id(&self) -> &str {
        match self {
            Self::CreateNode { node } => &node.id,
            Self::SetNode { node_id, .. }
            | Self::UnsetNode { node_id, .. }
            | Self::MoveNode { node_id, .. }
            | Self::AdjustRank { node_id, .. }
            | Self::DeleteNode { node_id }
            | Self::TextInsert { node_id, .. }
            | Self::TextDelete { node_id, .. }
            | Self::TextMark { node_id, .. } => node_id,
            Self::Retract { entity_id, .. } => entity_id,
            _ => "catalog",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Operation {
    pub id: String,
    pub stamp: Stamp,
    pub author_id: String,
    pub action: Action,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoteTransaction {
    pub profile: String,
    pub transaction_id: String,
    pub document_id: String,
    pub epoch: String,
    pub replica_id: String,
    pub counter: u64,
    pub lamport: u64,
    pub dependencies: BTreeMap<String, u64>,
    pub author_id: String,
    pub session_id: String,
    pub undo_group: Option<String>,
    pub operations: Vec<Operation>,
}

impl RemoteTransaction {
    pub fn digest(&self) -> Result<String> {
        canonical_digest(self)
    }
    pub fn validate(&self) -> Result<()> {
        if self.profile != CRDT_PROFILE {
            return Err(EngineError::new(
                "protocol_mismatch",
                "unsupported native CRDT profile",
            ));
        }
        if !omc_model::valid_id(&self.document_id, "doc")
            || !canonical_uuid(&self.epoch)
            || !canonical_uuid(&self.replica_id)
            || !canonical_uuid(&self.transaction_id)
            || self.counter == 0
            || self.lamport == 0
        {
            return Err(EngineError::invalid("invalid transaction identity"));
        }
        if self.author_id.is_empty()
            || self.author_id.len() > 256
            || self.session_id.len() > 256
            || self.operations.is_empty()
        {
            return Err(EngineError::invalid(
                "invalid transaction author or operation set",
            ));
        }
        if self
            .dependencies
            .get(&self.replica_id)
            .copied()
            .unwrap_or(0)
            != self.counter - 1
        {
            return Err(EngineError::invalid(
                "transaction must depend on its preceding local transaction",
            ));
        }
        if self.dependencies.len() > 256 || self.dependencies.keys().any(|id| !canonical_uuid(id)) {
            return Err(EngineError::invalid("invalid causal dependency frontier"));
        }
        let mut ids = BTreeSet::new();
        let mut previous_counter = None;
        for op in &self.operations {
            if op.stamp.replica_id != self.replica_id
                || op.stamp.lamport != self.lamport
                || op.author_id != self.author_id
                || op.id != op.stamp.operation_id()
                || op.stamp.counter == 0
                || !ids.insert(&op.id)
                || previous_counter.is_some_and(|counter| op.stamp.counter <= counter)
            {
                return Err(EngineError::invalid(
                    "operation identity or attribution does not match transaction",
                ));
            }
            previous_counter = Some(op.stamp.counter);
        }
        if serde_json::to_vec(self)
            .map_err(|e| EngineError::invalid(e.to_string()))?
            .len()
            > MAX_SEMANTIC_BYTES
        {
            return Err(EngineError::new(
                "resource_limit",
                "ordinary transaction exceeds 4 MiB",
            ));
        }
        Ok(())
    }
}

fn canonical_uuid(value: &str) -> bool {
    uuid::Uuid::parse_str(value).is_ok_and(|id| id.to_string() == value)
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReplicaPackage {
    pub profile: String,
    pub document_id: String,
    pub epoch: String,
    pub genesis: DocumentContent,
    pub transactions: Vec<RemoteTransaction>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NodeState {
    pub seed: Option<Node>,
    pub events: Vec<Operation>,
}

fn retractions(events: &[Operation]) -> BTreeSet<&str> {
    events
        .iter()
        .filter_map(|event| match &event.action {
            Action::Retract { operation_id, .. } => Some(operation_id.as_str()),
            _ => None,
        })
        .collect()
}

fn live_events(events: &[Operation]) -> Vec<&Operation> {
    let retracted = retractions(events);
    let mut live: Vec<_> = events
        .iter()
        .filter(|event| !retracted.contains(event.id.as_str()))
        .collect();
    live.sort_by(|a, b| a.stamp.cmp(&b.stamp));
    live
}

fn append_checked(events: &mut Vec<Operation>, operation: Operation) -> Result<()> {
    if let Some(existing) = events.iter().find(|existing| existing.id == operation.id) {
        if existing == &operation {
            return Ok(());
        }
        return Err(EngineError::new(
            "protocol_mismatch",
            "operation identity was reused with different content",
        ));
    }
    if let Action::Retract { operation_id, .. } = &operation.action {
        let target = events
            .iter()
            .find(|event| &event.id == operation_id)
            .ok_or_else(|| {
                EngineError::new("dependency_unavailable", "retraction target is not present")
            })?;
        if target.author_id != operation.author_id
            || target.stamp.replica_id != operation.stamp.replica_id
            || matches!(target.action, Action::Retract { .. })
        {
            return Err(EngineError::new(
                "authentication_failed",
                "an author can retract only its own ordinary operations",
            ));
        }
    }
    events.push(operation);
    Ok(())
}

impl NodeState {
    pub fn seeded(node: Node) -> Self {
        Self {
            seed: Some(node),
            events: Vec::new(),
        }
    }
    pub fn empty() -> Self {
        Self {
            seed: None,
            events: Vec::new(),
        }
    }

    pub fn apply(&mut self, operation: Operation) -> Result<()> {
        if self
            .original_node()
            .is_some_and(|node| node.id != operation.action.entity_id())
        {
            return Err(EngineError::invalid(
                "operation targets a different node identity",
            ));
        }
        match &operation.action {
            Action::CreateNode { node } => {
                node.validate().map_err(EngineError::invalid)?;
                let retracted = retractions(&self.events);
                if self.seed.is_some()
                    || self.events.iter().any(|e| {
                        matches!(e.action, Action::CreateNode { .. })
                            && e.id != operation.id
                            && (!retracted.contains(e.id.as_str())
                                || e.author_id != operation.author_id)
                    })
                {
                    return Err(EngineError::new(
                        "conflict",
                        "node ID already has a creation identity",
                    ));
                }
            }
            Action::TextInsert {
                after,
                text,
                attributes,
                ..
            } => {
                if text.chars().count() > 1_000_000 {
                    return Err(EngineError::new(
                        "resource_limit",
                        "text insertion is too large",
                    ));
                }
                omc_model::validate_properties(attributes).map_err(EngineError::invalid)?;
                if let Some(after) = after
                    && !self.text_view()?.all_items.contains(after)
                {
                    return Err(EngineError::new(
                        "dependency_unavailable",
                        "text insertion anchor is missing",
                    ));
                }
            }
            Action::TextDelete { items, .. } | Action::TextMark { items, .. } => {
                let view = self.text_view()?;
                if items.iter().any(|id| !view.all_items.contains(id)) {
                    return Err(EngineError::new(
                        "dependency_unavailable",
                        "observed text item is missing",
                    ));
                }
            }
            Action::SetNode { properties, .. } => {
                omc_model::validate_properties(properties).map_err(EngineError::invalid)?;
                if properties.contains_key("text") || properties.contains_key("textRuns") {
                    return Err(EngineError::invalid(
                        "text changes require character commands",
                    ));
                }
            }
            Action::UnsetNode { properties, .. } => {
                if properties.is_empty()
                    || properties.len() > 1024
                    || properties.iter().any(|key| {
                        key.is_empty()
                            || key.len() > 256
                            || matches!(key.as_str(), "text" | "textRuns")
                    })
                {
                    return Err(EngineError::invalid(
                        "invalid unset properties; text requires character commands",
                    ));
                }
            }
            Action::MoveNode {
                rank, parent_id, ..
            } => {
                if !omc_model::valid_rank(rank)
                    || parent_id
                        .as_ref()
                        .is_some_and(|id| !omc_model::valid_id(id, "node"))
                {
                    return Err(EngineError::invalid("invalid placement"));
                }
            }
            Action::AdjustRank {
                rank,
                parent_id,
                placement_version,
                ..
            } => {
                if !omc_model::valid_rank(rank)
                    || !omc_model::valid_id(parent_id, "node")
                    || placement_version.len() > 256
                {
                    return Err(EngineError::invalid("invalid rank adjustment"));
                }
            }
            _ => {}
        }
        append_checked(&mut self.events, operation)
    }

    pub fn original_node(&self) -> Option<Node> {
        self.seed.clone().or_else(|| {
            self.events.iter().find_map(|event| match &event.action {
                Action::CreateNode { node } => Some(node.clone()),
                _ => None,
            })
        })
    }

    pub fn project(&self) -> Result<Option<Node>> {
        let events = live_events(&self.events);
        if events
            .iter()
            .any(|e| matches!(e.action, Action::DeleteNode { .. }))
        {
            return Ok(None);
        }
        let mut node = self.seed.clone();
        for event in &events {
            if let Action::CreateNode { node: created } = &event.action {
                node = Some(created.clone());
            }
        }
        let Some(mut node) = node else {
            return Ok(None);
        };
        for event in &events {
            match &event.action {
                Action::SetNode { properties, .. } => node.properties.extend(properties.clone()),
                Action::UnsetNode { properties, .. } => {
                    for key in properties {
                        node.properties.remove(key);
                    }
                }
                Action::MoveNode {
                    parent_id, rank, ..
                } => {
                    node.parent_id = parent_id.clone();
                    node.rank.clone_from(rank);
                }
                _ => {}
            }
        }
        let placement = self.base_placement_version();
        for event in &events {
            if let Action::AdjustRank {
                placement_version,
                parent_id,
                rank,
                ..
            } = &event.action
                && placement.as_ref() == Some(placement_version)
                && node.parent_id.as_ref() == Some(parent_id)
            {
                node.rank.clone_from(rank);
            }
        }
        if node.kind == NodeKind::Text {
            let view = self.text_view()?;
            let runs: Vec<Value> = view.runs();
            node.properties
                .insert("text".into(), Value::String(view.text));
            node.properties
                .insert("textRuns".into(), Value::Array(runs));
        }
        Ok(Some(node))
    }

    pub fn field_version(&self, field: &str) -> Option<String> {
        if field == "placement" {
            let base = self.base_placement_version()?;
            let adjustment = live_events(&self.events)
                .into_iter()
                .rev()
                .find_map(|event| match &event.action {
                    Action::AdjustRank {
                        placement_version, ..
                    } if placement_version == &base => Some(event.id.clone()),
                    _ => None,
                });
            return Some(match adjustment {
                Some(adjustment) => format!("{base}|rank:{adjustment}"),
                None => base,
            });
        }
        let mut result = self.seed.as_ref().and_then(|node| {
            (field == "placement" || field == "existence" || node.properties.contains_key(field))
                .then(|| format!("genesis:{}:{field}", node.id))
        });
        for event in live_events(&self.events) {
            let applies = match &event.action {
                Action::CreateNode { node } => {
                    field == "existence"
                        || field == "placement"
                        || node.properties.contains_key(field)
                }
                Action::SetNode { properties, .. } => properties.contains_key(field),
                Action::UnsetNode { properties, .. } => properties.iter().any(|key| key == field),
                Action::MoveNode { .. } => field == "placement",
                Action::DeleteNode { .. } => field == "existence",
                Action::TextInsert { .. } | Action::TextDelete { .. } | Action::TextMark { .. } => {
                    field == "text"
                }
                _ => false,
            };
            if applies {
                result = Some(event.id.clone());
            }
        }
        result
    }

    pub fn base_placement_version(&self) -> Option<String> {
        live_events(&self.events)
            .into_iter()
            .rev()
            .find(|event| {
                matches!(
                    event.action,
                    Action::CreateNode { .. } | Action::MoveNode { .. }
                )
            })
            .map(|event| event.id.clone())
            .or_else(|| {
                self.seed
                    .as_ref()
                    .map(|node| format!("genesis:{}:placement", node.id))
            })
    }

    pub fn placement_stamp(&self) -> Stamp {
        live_events(&self.events)
            .iter()
            .rev()
            .find(|event| {
                matches!(
                    event.action,
                    Action::MoveNode { .. } | Action::CreateNode { .. }
                )
            })
            .map(|event| event.stamp.clone())
            .unwrap_or_else(Stamp::genesis)
    }

    pub fn text_view(&self) -> Result<TextView> {
        let original = self.original_node().ok_or_else(|| {
            EngineError::new("dependency_unavailable", "text node has no creation")
        })?;
        if original.kind != NodeKind::Text {
            return Err(EngineError::invalid("node is not text"));
        }
        let retracted = retractions(&self.events);
        let mut atoms: BTreeMap<String, Atom> = BTreeMap::new();
        let mut after = None;
        original.validate().map_err(EngineError::invalid)?;
        let mut initial_offset = 0;
        let initial_attributes: Vec<(usize, Properties)> = original
            .properties
            .get("textRuns")
            .and_then(Value::as_array)
            .map(|runs| {
                runs.iter()
                    .map(|run| {
                        let attributes: Properties = run["attributes"]
                            .as_object()
                            .unwrap()
                            .iter()
                            .filter(|(_, value)| !value.is_null())
                            .map(|(key, value)| (key.clone(), value.clone()))
                            .collect();
                        initial_offset += run["text"].as_str().unwrap().chars().count();
                        (initial_offset, attributes)
                    })
                    .collect()
            })
            .unwrap_or_default();
        let mut run_index = 0;
        for (index, character) in original.string("text").unwrap_or("").chars().enumerate() {
            while initial_attributes
                .get(run_index)
                .is_some_and(|(end, _)| index >= *end)
            {
                run_index += 1;
            }
            let id = format!("g:{}:{index}", original.id);
            atoms.insert(
                id.clone(),
                Atom {
                    id: id.clone(),
                    after,
                    character,
                    stamp: Stamp::genesis(),
                    attributes: initial_attributes
                        .get(run_index)
                        .map(|(_, attributes)| attributes.clone())
                        .unwrap_or_default(),
                    visible: true,
                },
            );
            after = Some(id);
        }
        for event in &self.events {
            if let Action::TextInsert {
                after,
                text,
                attributes,
                ..
            } = &event.action
            {
                let mut after = after.clone();
                for (index, character) in text.chars().enumerate() {
                    let id = format!("{}:{index}", event.id);
                    atoms.insert(
                        id.clone(),
                        Atom {
                            id: id.clone(),
                            after,
                            character,
                            stamp: event.stamp.clone(),
                            attributes: attributes.clone(),
                            visible: !retracted.contains(event.id.as_str()),
                        },
                    );
                    after = Some(id);
                }
            }
        }
        for event in live_events(&self.events) {
            match &event.action {
                Action::TextDelete { items, .. } => {
                    for id in items {
                        if let Some(atom) = atoms.get_mut(id) {
                            atom.visible = false;
                        }
                    }
                }
                Action::TextMark {
                    items, attributes, ..
                } => {
                    for id in items {
                        if let Some(atom) = atoms.get_mut(id) {
                            for (key, value) in attributes {
                                if value.is_null() {
                                    atom.attributes.remove(key);
                                } else {
                                    atom.attributes.insert(key.clone(), value.clone());
                                }
                            }
                        }
                    }
                }
                _ => {}
            }
        }
        let mut children: BTreeMap<Option<String>, Vec<String>> = BTreeMap::new();
        for atom in atoms.values() {
            if atom
                .after
                .as_ref()
                .is_some_and(|id| !atoms.contains_key(id))
            {
                return Err(EngineError::new(
                    "dependency_unavailable",
                    "text anchor dependency is absent",
                ));
            }
            children
                .entry(atom.after.clone())
                .or_default()
                .push(atom.id.clone());
        }
        for ids in children.values_mut() {
            ids.sort_by(|a, b| atoms[b].stamp.cmp(&atoms[a].stamp).then_with(|| b.cmp(a)));
        }
        let mut stack: Vec<_> = children
            .get(&None)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .rev()
            .collect();
        let mut visited = BTreeSet::new();
        let mut items = Vec::new();
        let mut all_order = Vec::new();
        while let Some(id) = stack.pop() {
            if !visited.insert(id.clone()) {
                return Err(EngineError::new(
                    "corrupt_state",
                    "cycle in text identity graph",
                ));
            }
            let atom = &atoms[&id];
            all_order.push(id.clone());
            if atom.visible {
                items.push(TextItem {
                    id: id.clone(),
                    character: atom.character,
                    attributes: atom.attributes.clone(),
                });
            }
            if let Some(next) = children.get(&Some(id)) {
                stack.extend(next.iter().rev().cloned());
            }
        }
        if visited.len() != atoms.len() {
            return Err(EngineError::new(
                "corrupt_state",
                "unreachable text identity",
            ));
        }
        Ok(TextView {
            text: items.iter().map(|item| item.character).collect(),
            items,
            all_items: atoms.into_keys().collect(),
            all_order,
        })
    }
}

struct Atom {
    id: String,
    after: Option<String>,
    character: char,
    stamp: Stamp,
    attributes: Properties,
    visible: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TextItem {
    pub id: String,
    pub character: char,
    pub attributes: Properties,
}

#[derive(Debug, Clone)]
pub struct TextView {
    pub text: String,
    pub items: Vec<TextItem>,
    pub all_items: BTreeSet<String>,
    pub all_order: Vec<String>,
}

impl TextView {
    pub fn index(&self, offset: u32) -> Result<usize> {
        let mut current = 0u32;
        for (index, item) in self.items.iter().enumerate() {
            if current == offset {
                return Ok(index);
            }
            current += item.character.len_utf16() as u32;
            if current > offset {
                return Err(EngineError::invalid(
                    "UTF-16 offset splits a surrogate pair",
                ));
            }
        }
        if current == offset {
            Ok(self.items.len())
        } else {
            Err(EngineError::invalid("UTF-16 range exceeds text"))
        }
    }
    pub fn selection(&self, node_id: &str, start: u32, end: u32) -> Result<TextSelection> {
        if start > end {
            return Err(EngineError::invalid("range start is after end"));
        }
        let start_index = self.index(start)?;
        let end_index = self.index(end)?;
        let position = |index: usize| RelativePosition {
            left: index.checked_sub(1).map(|i| self.items[i].id.clone()),
            right: self.items.get(index).map(|item| item.id.clone()),
            association: Association::After,
        };
        Ok(TextSelection {
            node_id: node_id.into(),
            start: position(start_index),
            end: position(end_index),
            observed_items: self.items[start_index..end_index]
                .iter()
                .map(|item| item.id.clone())
                .collect(),
        })
    }
    pub fn runs(&self) -> Vec<Value> {
        let mut output = Vec::new();
        let mut text = String::new();
        let mut attributes: Option<&Properties> = None;
        for item in &self.items {
            if attributes.is_some_and(|old| old != &item.attributes) {
                output.push(serde_json::json!({"text":text,"attributes":attributes.unwrap()}));
                text.clear();
            }
            attributes = Some(&item.attributes);
            text.push(item.character);
        }
        if let Some(attributes) = attributes {
            output.push(serde_json::json!({"text":text,"attributes":attributes}));
        }
        output
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CatalogState {
    pub title: String,
    pub pages: Vec<Page>,
    pub metadata: Properties,
    pub events: Vec<Operation>,
}

impl CatalogState {
    pub fn from_content(content: &DocumentContent) -> Self {
        Self {
            title: content.title.clone(),
            pages: content.pages.clone(),
            metadata: content.metadata.clone(),
            events: Vec::new(),
        }
    }
    pub fn apply(&mut self, operation: Operation) -> Result<()> {
        let known_page = |id: &str| {
            self.pages.iter().any(|page| page.id == id)
                || self
                    .events
                    .iter()
                    .any(|event| matches!(&event.action,Action::CreatePage{page} if page.id==id))
        };
        match &operation.action {
            Action::CreatePage { page } => {
                if !omc_model::valid_id(&page.id, "page")
                    || !omc_model::valid_id(&page.root_node_id, "node")
                    || !omc_model::valid_rank(&page.rank)
                    || page.title.len() > 4096
                {
                    return Err(EngineError::invalid("invalid page declaration"));
                }
                let existing = self.pages.iter().find(|old| old.id == page.id).or_else(|| {
                    self.events.iter().find_map(|event| match &event.action {
                        Action::CreatePage { page: old } if old.id == page.id => Some(old),
                        _ => None,
                    })
                });
                if existing.is_some_and(|old| old.root_node_id != page.root_node_id) {
                    return Err(EngineError::new(
                        "conflict",
                        "page identity has a different root",
                    ));
                }
            }
            Action::RenamePage { page_id, title } => {
                if !known_page(page_id) {
                    return Err(EngineError::new(
                        "dependency_unavailable",
                        "page declaration is missing",
                    ));
                }
                if title.len() > 4096 {
                    return Err(EngineError::invalid("page title is too long"));
                }
            }
            Action::DeletePage { page_id } => {
                if !known_page(page_id) {
                    return Err(EngineError::new(
                        "dependency_unavailable",
                        "page declaration is missing",
                    ));
                }
            }
            Action::RenameDocument { title } => {
                if title.len() > 4096 {
                    return Err(EngineError::invalid("document title is too long"));
                }
            }
            Action::SetMetadata { properties } => {
                omc_model::validate_properties(properties).map_err(EngineError::invalid)?;
                for (key, value) in properties {
                    let parts: Vec<_> = key.split('/').collect();
                    if parts.len() != 3 || parts[0] != "comments" {
                        continue;
                    }
                    let existing = self.comment_author(parts[1]);
                    let declared = properties.get(&format!("comments/{}/authorId", parts[1]));
                    if parts[2] == "authorId"
                        && (existing.as_ref().is_some_and(|author| author != value)
                            || (existing.is_none()
                                && value.as_str() != Some(operation.author_id.as_str())))
                    {
                        return Err(EngineError::new(
                            "authentication_failed",
                            "comment attribution cannot be reassigned",
                        ));
                    }
                    if matches!(parts[2], "body" | "deleted") {
                        let author = existing.as_ref().or(declared);
                        if author.and_then(Value::as_str) != Some(operation.author_id.as_str()) {
                            return Err(EngineError::new(
                                "authentication_failed",
                                "comment body belongs to another author",
                            ));
                        }
                    }
                }
            }
            Action::Retract { entity_id, .. } if entity_id == "catalog" => {}
            _ => return Err(EngineError::invalid("node operation cannot modify catalog")),
        }
        append_checked(&mut self.events, operation)
    }
    pub fn comment_author(&self, entity_id: &str) -> Option<Value> {
        let key = format!("comments/{entity_id}/authorId");
        if let Some(value) = self.metadata.get(&key) {
            return Some(value.clone());
        }
        self.events
            .iter()
            .filter_map(|event| match &event.action {
                Action::SetMetadata { properties } => {
                    properties.get(&key).map(|value| (&event.stamp, value))
                }
                _ => None,
            })
            .min_by(|a, b| a.0.cmp(b.0))
            .map(|(_, value)| value.clone())
    }
    pub fn current_title(&self) -> String {
        live_events(&self.events)
            .iter()
            .rev()
            .find_map(|event| match &event.action {
                Action::RenameDocument { title } => Some(title.clone()),
                _ => None,
            })
            .unwrap_or_else(|| self.title.clone())
    }
    pub fn current_pages(&self) -> Vec<Page> {
        let mut pages: BTreeMap<_, _> = self
            .pages
            .iter()
            .map(|page| (page.id.clone(), page.clone()))
            .collect();
        let mut deleted = BTreeSet::new();
        for event in live_events(&self.events) {
            match &event.action {
                Action::CreatePage { page } => {
                    pages.insert(page.id.clone(), page.clone());
                }
                Action::RenamePage { page_id, title } => {
                    if let Some(page) = pages.get_mut(page_id) {
                        page.title.clone_from(title);
                    }
                }
                Action::DeletePage { page_id } => {
                    deleted.insert(page_id.clone());
                }
                _ => {}
            }
        }
        let mut pages: Vec<_> = pages
            .into_values()
            .filter(|page| !deleted.contains(&page.id))
            .collect();
        pages.sort_by(|a, b| a.rank.cmp(&b.rank).then_with(|| a.id.cmp(&b.id)));
        pages
    }
    pub fn project(&self) -> (String, Vec<Page>, Properties) {
        let mut title = self.title.clone();
        let mut pages: BTreeMap<_, _> = self
            .pages
            .iter()
            .map(|page| (page.id.clone(), page.clone()))
            .collect();
        let mut metadata = self.metadata.clone();
        let mut deleted = BTreeSet::new();
        for event in live_events(&self.events) {
            match &event.action {
                Action::CreatePage { page } => {
                    pages.insert(page.id.clone(), page.clone());
                }
                Action::RenamePage { page_id, title } => {
                    if let Some(page) = pages.get_mut(page_id) {
                        page.title.clone_from(title);
                    }
                }
                Action::DeletePage { page_id } => {
                    deleted.insert(page_id.clone());
                }
                Action::RenameDocument { title: new_title } => title.clone_from(new_title),
                Action::SetMetadata { properties } => metadata.extend(properties.clone()),
                _ => {}
            }
        }
        let comment_ids: BTreeSet<String> = metadata
            .keys()
            .filter_map(|key| {
                let parts: Vec<_> = key.split('/').collect();
                (parts.len() == 3 && parts[0] == "comments" && parts[2] != "authorId")
                    .then(|| parts[1].to_string())
            })
            .collect();
        for id in comment_ids {
            if let Some(author) = self.comment_author(&id) {
                metadata.insert(format!("comments/{id}/authorId"), author);
            }
        }
        let mut pages: Vec<_> = pages
            .into_values()
            .filter(|page| !deleted.contains(&page.id))
            .collect();
        pages.sort_by(|a, b| a.rank.cmp(&b.rank).then_with(|| a.id.cmp(&b.id)));
        (title, pages, metadata)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TransferHeader {
    pub transfer_id: String,
    pub epoch: String,
    pub profile: String,
    pub total_bytes: usize,
    pub transaction_digest: String,
    pub fragment_hashes: Vec<String>,
}

pub fn split_transaction(
    transaction: &RemoteTransaction,
) -> Result<(TransferHeader, Vec<Vec<u8>>)> {
    transaction.validate()?;
    let bytes = serde_json::to_vec(transaction).map_err(|e| EngineError::invalid(e.to_string()))?;
    let fragments: Vec<Vec<u8>> = bytes
        .chunks(MAX_FRAGMENT_BYTES)
        .map(|part| part.to_vec())
        .collect();
    let header = TransferHeader {
        transfer_id: transaction.transaction_id.clone(),
        epoch: transaction.epoch.clone(),
        profile: CRDT_PROFILE.into(),
        total_bytes: bytes.len(),
        transaction_digest: transaction.digest()?,
        fragment_hashes: fragments
            .iter()
            .map(|part| hex::encode(Sha256::digest(part)))
            .collect(),
    };
    Ok((header, fragments))
}

pub fn assemble_transaction(
    header: &TransferHeader,
    fragments: &[Vec<u8>],
) -> Result<RemoteTransaction> {
    if header.profile != CRDT_PROFILE
        || header.total_bytes > MAX_SEMANTIC_BYTES
        || fragments.len() != header.fragment_hashes.len()
        || fragments.is_empty()
        || fragments.len() > MAX_SEMANTIC_BYTES / MAX_FRAGMENT_BYTES + 1
    {
        return Err(EngineError::invalid(
            "invalid or incomplete transaction framing",
        ));
    }
    let mut bytes = Vec::with_capacity(header.total_bytes);
    for (fragment, expected) in fragments.iter().zip(&header.fragment_hashes) {
        if fragment.len() > MAX_FRAGMENT_BYTES || hex::encode(Sha256::digest(fragment)) != *expected
        {
            return Err(EngineError::invalid("fragment hash or length mismatch"));
        }
        bytes.extend_from_slice(fragment);
    }
    if bytes.len() != header.total_bytes {
        return Err(EngineError::invalid("transfer length mismatch"));
    }
    let transaction: RemoteTransaction =
        serde_json::from_slice(&bytes).map_err(|e| EngineError::invalid(e.to_string()))?;
    transaction.validate()?;
    if transaction.epoch != header.epoch
        || transaction.transaction_id != header.transfer_id
        || transaction.digest()? != header.transaction_digest
    {
        return Err(EngineError::invalid(
            "transaction does not match transfer manifest",
        ));
    }
    Ok(transaction)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn operation(replica: &str, counter: u64, lamport: u64, action: Action) -> Operation {
        let stamp = Stamp {
            lamport,
            replica_id: replica.into(),
            counter,
        };
        Operation {
            id: stamp.operation_id(),
            stamp,
            author_id: replica.into(),
            action,
        }
    }
    #[test]
    fn observed_delete_preserves_concurrent_insert_in_both_orders() {
        let mut node = Node::new(NodeKind::Text);
        node.properties.insert("text".into(), "abc".into());
        let a = uuid::Uuid::from_u128(1).to_string();
        let b = uuid::Uuid::from_u128(2).to_string();
        let base = NodeState::seeded(node.clone());
        let selection = base.text_view().unwrap().selection(&node.id, 0, 3).unwrap();
        let insert = operation(
            &b,
            1,
            1,
            Action::TextInsert {
                node_id: node.id.clone(),
                after: Some(selection.observed_items[0].clone()),
                text: "X".into(),
                attributes: Properties::new(),
            },
        );
        let delete = operation(
            &a,
            1,
            1,
            Action::TextDelete {
                node_id: node.id.clone(),
                items: selection.observed_items,
            },
        );
        for ops in [
            [insert.clone(), delete.clone()],
            [delete.clone(), insert.clone()],
        ] {
            let mut state = base.clone();
            for op in ops {
                state.apply(op).unwrap();
            }
            assert_eq!(state.text_view().unwrap().text, "X");
        }
    }
    #[test]
    fn undo_of_insert_keeps_foreign_insert_and_marks() {
        let node = Node::new(NodeKind::Text);
        let mut state = NodeState::seeded(node.clone());
        let a = uuid::Uuid::from_u128(1).to_string();
        let b = uuid::Uuid::from_u128(2).to_string();
        let insert = operation(
            &a,
            1,
            1,
            Action::TextInsert {
                node_id: node.id.clone(),
                after: None,
                text: "AB".into(),
                attributes: Properties::new(),
            },
        );
        let target = format!("{}:0", insert.id);
        state.apply(insert.clone()).unwrap();
        state
            .apply(operation(
                &b,
                1,
                2,
                Action::TextInsert {
                    node_id: node.id.clone(),
                    after: Some(target),
                    text: "x".into(),
                    attributes: [("bold".into(), true.into())].into(),
                },
            ))
            .unwrap();
        state
            .apply(operation(
                &a,
                2,
                3,
                Action::Retract {
                    entity_id: node.id.clone(),
                    operation_id: insert.id,
                },
            ))
            .unwrap();
        let view = state.text_view().unwrap();
        assert_eq!(view.text, "x");
        assert_eq!(view.items[0].attributes["bold"], true);
    }
    #[test]
    fn utf16_and_observed_marks_are_explicit() {
        let mut node = Node::new(NodeKind::Text);
        node.properties
            .insert("text".into(), "A😀e\u{301}한".into());
        let state = NodeState::seeded(node);
        let view = state.text_view().unwrap();
        assert!(view.index(2).is_err());
        assert_eq!(view.index(3).unwrap(), 2);
        assert_eq!(view.index(6).unwrap(), 5);
    }
}
