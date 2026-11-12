//! Document authority: validated semantic commands and durable native publication.
use omc_model::{Association, NodeKind, Properties, valid_id, valid_rank};
pub use omc_model::{DocumentContent, DocumentSnapshot, Node, Page, Revision, TextSelection};
pub use omc_protocol::{
    Command, CommandEnvelope, DurableResult, EngineError, HistoryChannel, Preconditions,
    RequestContext, Result,
};
pub use omc_storage::DocumentMetadata;
use omc_storage::{Commit, DocumentStore, ReceiptWrite};
use omc_sync::{Action, CatalogState, NodeState, Operation, Stamp, TransferHeader};
pub use omc_sync::{RemoteTransaction, ReplicaPackage};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::Path,
    sync::Arc,
    time::Instant,
};

pub struct DocumentEngine {
    store: DocumentStore,
    meta: DocumentMetadata,
    catalog: Arc<CatalogState>,
    undo: BTreeMap<(String, String, HistoryChannel), Vec<UndoGroup>>,
    redo: BTreeMap<(String, String, HistoryChannel), Vec<UndoGroup>>,
}

#[derive(Clone)]
struct UndoGroup {
    id: String,
    operations: Vec<Operation>,
}

struct Candidate {
    catalog: Arc<CatalogState>,
    nodes: BTreeMap<String, NodeState>,
    changed: BTreeSet<String>,
    operations: Vec<Operation>,
    author: String,
    lamport: u64,
    first_counter: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReceiveResult {
    pub status: String,
    pub revision: Revision,
    pub applied_transactions: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentContext {
    pub document_id: String,
    pub title: String,
    pub revision: Revision,
    pub pages: Vec<Page>,
    /// Own-visible records; descendants of a hidden ancestor can remain retained.
    pub retained_node_count: u64,
    pub metadata: Properties,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeQueryPage {
    pub revision: Revision,
    pub nodes: Vec<Node>,
    pub next_after: Option<String>,
}

impl DocumentEngine {
    pub fn create(path: impl AsRef<Path>, title: &str) -> Result<Self> {
        Self::create_from_content(path, DocumentContent::empty(title))
    }
    pub fn create_with_id(
        path: impl AsRef<Path>,
        document_id: String,
        title: &str,
    ) -> Result<Self> {
        Self::create_from_content_with_id(path, document_id, DocumentContent::empty(title))
    }
    pub fn create_from_content(path: impl AsRef<Path>, content: DocumentContent) -> Result<Self> {
        Self::create_from_content_with_id(path, omc_model::new_id("doc"), content)
    }
    pub fn create_from_content_with_id(
        path: impl AsRef<Path>,
        document_id: String,
        content: DocumentContent,
    ) -> Result<Self> {
        if !valid_id(&document_id, "doc") {
            return Err(EngineError::invalid("invalid document ID"));
        }
        let store = DocumentStore::create(
            path.as_ref(),
            &document_id,
            &uuid::Uuid::new_v4().to_string(),
            &uuid::Uuid::new_v4().to_string(),
            &content,
        )?;
        Self::from_store(store)
    }
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        Self::from_store(DocumentStore::open(path.as_ref())?)
    }
    fn from_store(store: DocumentStore) -> Result<Self> {
        let meta = store.metadata()?;
        let catalog = Arc::new(store.catalog(None)?);
        Ok(Self {
            store,
            meta,
            catalog,
            undo: BTreeMap::new(),
            redo: BTreeMap::new(),
        })
    }
    pub fn metadata(&self) -> Result<DocumentMetadata> {
        Ok(self.meta.clone())
    }
    pub fn revision(&self) -> Revision {
        self.meta.revision()
    }
    pub fn checkpoint(&self) -> Result<()> {
        self.store.checkpoint()
    }
    pub fn sqlite_info(&self) -> Result<Value> {
        self.store.sqlite_info()
    }
    pub fn frontiers(&self) -> Result<BTreeMap<String, u64>> {
        self.store.frontiers()
    }
    pub fn context(&self) -> Result<DocumentContext> {
        let (title, pages, metadata) = self.store.catalog(None)?.project();
        Ok(DocumentContext {
            document_id: self.meta.id.clone(),
            title,
            revision: self.revision(),
            pages,
            retained_node_count: self.store.node_count()?,
            metadata,
        })
    }
    pub fn query_nodes_at(
        &self,
        revision: &Revision,
        after_id: Option<&str>,
        limit: usize,
    ) -> Result<NodeQueryPage> {
        if revision.epoch != self.meta.epoch || revision.sequence > self.meta.sequence {
            return Err(EngineError::new(
                "stale_revision",
                "query revision is unavailable",
            ));
        }
        if limit == 0 || limit > 4096 {
            return Err(EngineError::new(
                "resource_limit",
                "node query limit must be 1–4096",
            ));
        }
        let mut ids = self
            .store
            .node_ids_page(revision.sequence, after_id, limit + 1)?;
        let more = ids.len() > limit;
        ids.truncate(limit);
        let next_after = if more { ids.last().cloned() } else { None };
        let nodes = ids
            .iter()
            .filter_map(|id| self.node_at(id, revision.sequence).transpose())
            .collect::<Result<Vec<_>>>()?;
        Ok(NodeQueryPage {
            revision: revision.clone(),
            nodes,
            next_after,
        })
    }

    pub fn node(&self, id: &str) -> Result<Option<Node>> {
        self.node_at(id, self.meta.sequence)
    }
    pub fn node_at(&self, id: &str, sequence: u64) -> Result<Option<Node>> {
        if sequence > self.meta.sequence {
            return Err(EngineError::new(
                "stale_revision",
                "requested future revision",
            ));
        }
        let Some(state) = self.store.node_state(id, Some(sequence))? else {
            return Ok(None);
        };
        let Some(node) = state.project()? else {
            return Ok(None);
        };
        let mut parent = node.parent_id.clone();
        let mut seen = BTreeSet::from([id.to_string()]);
        while let Some(parent_id) = parent {
            if !seen.insert(parent_id.clone()) {
                return Ok(Some(node));
            } // Coherent snapshot exposes deterministic repaired containment.
            let Some(parent_state) = self.store.node_state(&parent_id, Some(sequence))? else {
                return Ok(Some(node));
            };
            let Some(parent_node) = parent_state.project()? else {
                return Ok(None);
            };
            parent = parent_node.parent_id;
        }
        Ok(Some(node))
    }
    pub fn nodes(&self, ids: &[String]) -> Result<Vec<Node>> {
        if ids.len() > 4096 {
            return Err(EngineError::new(
                "resource_limit",
                "node query limit is 4096",
            ));
        }
        ids.iter()
            .filter_map(|id| self.node(id).transpose())
            .collect()
    }
    pub fn children(&self, parent_id: &str) -> Result<Vec<Node>> {
        let mut nodes = self.nodes(&self.store.child_ids(parent_id)?)?;
        nodes.sort_by(|a, b| a.rank.cmp(&b.rank).then_with(|| a.id.cmp(&b.id)));
        Ok(nodes)
    }
    pub fn field_version(&self, node_id: &str, field: &str) -> Result<Option<String>> {
        Ok(self
            .store
            .node_state(node_id, None)?
            .and_then(|state| state.field_version(field)))
    }
    pub fn text_selection(&self, node_id: &str, start: u32, end: u32) -> Result<TextSelection> {
        self.node(node_id)?
            .ok_or_else(|| EngineError::new("conflict", "text target was deleted"))?;
        self.store
            .node_state(node_id, None)?
            .ok_or_else(|| EngineError::invalid("unknown text node"))?
            .text_view()?
            .selection(node_id, start, end)
    }

    pub fn snapshot(&self) -> Result<DocumentSnapshot> {
        self.snapshot_at(self.meta.sequence)
    }
    pub fn snapshot_at(&self, sequence: u64) -> Result<DocumentSnapshot> {
        if sequence > self.meta.sequence {
            return Err(EngineError::new(
                "stale_revision",
                "requested future revision",
            ));
        }
        let catalog = self.store.catalog(Some(sequence))?;
        let (title, mut pages, mut metadata) = catalog.project();
        let mut nodes = BTreeMap::new();
        let mut all = BTreeMap::new();
        let mut stamps = BTreeMap::new();
        for id in self.store.node_ids(Some(sequence))? {
            if let Some(state) = self.store.node_state(&id, Some(sequence))? {
                stamps.insert(id.clone(), state.placement_stamp());
                all.insert(id.clone(), state.project()?);
            }
        }
        // A deleted ancestor hides its descendants; missing ancestry and concurrent cycles are recoverable.
        for (id, node) in &all {
            let Some(node) = node else { continue };
            let mut cursor = node.parent_id.as_ref();
            let mut seen = BTreeSet::new();
            let mut hidden = false;
            while let Some(parent) = cursor {
                if !seen.insert(parent) {
                    break;
                }
                match all.get(parent) {
                    Some(Some(parent_node)) => cursor = parent_node.parent_id.as_ref(),
                    Some(None) => {
                        hidden = true;
                        break;
                    }
                    None => break,
                }
            }
            if !hidden {
                nodes.insert(id.clone(), node.clone());
            }
        }
        pages.retain(|page| nodes.contains_key(&page.root_node_id));
        let roots: BTreeSet<_> = pages.iter().map(|page| page.root_node_id.clone()).collect();
        let recovery_hash = hex::encode(Sha256::digest(
            format!("omc.recovery/1\n{}\n{}", self.meta.id, self.meta.epoch).as_bytes(),
        ));
        let recovery_root = format!("recovery_root_{}", &recovery_hash[..32]);
        let mut repaired = BTreeSet::new();
        let ids: Vec<_> = nodes.keys().cloned().collect();
        for id in ids {
            let mut path: Vec<String> = Vec::new();
            let mut positions = BTreeMap::new();
            let mut cursor = id;
            loop {
                if roots.contains(&cursor) || cursor == recovery_root {
                    break;
                }
                if let Some(start) = positions.get(&cursor).copied() {
                    let cycle: &[String] = &path[start..];
                    if let Some(detach) = cycle
                        .iter()
                        .max_by(|a, b| stamps.get(*a).cmp(&stamps.get(*b)).then_with(|| a.cmp(b)))
                        && let Some(node) = nodes.get_mut(detach)
                    {
                        node.parent_id = Some(recovery_root.clone());
                        repaired.insert(detach.clone());
                    }
                    break;
                }
                positions.insert(cursor.clone(), path.len());
                path.push(cursor.clone());
                let next = nodes.get(&cursor).and_then(|node| node.parent_id.clone());
                if let Some(parent) = next.filter(|parent| nodes.contains_key(parent)) {
                    cursor = parent
                } else {
                    if let Some(node) = nodes.get_mut(&cursor) {
                        node.parent_id = Some(recovery_root.clone());
                        repaired.insert(cursor);
                    }
                    break;
                }
            }
        }
        if !repaired.is_empty() || pages.is_empty() {
            let mut root = Node::new(NodeKind::Frame);
            root.id = recovery_root.clone();
            root.home_shard = format!("shard_{}", &recovery_hash[..32]);
            root.properties
                .insert("name".into(), "Recovered content".into());
            nodes.insert(recovery_root.clone(), root);
            pages.push(Page {
                id: format!("recovery_page_{}", &recovery_hash[..32]),
                title: "Recovered content".into(),
                root_node_id: recovery_root,
                rank: omc_model::initial_rank(),
            });
            metadata.insert(
                "containmentDiagnostics".into(),
                serde_json::json!({"code":"containment_repaired","nodeIds":repaired}),
            );
        }
        Ok(DocumentSnapshot {
            id: self.meta.id.clone(),
            title,
            epoch: self.meta.epoch.clone(),
            sequence,
            pages,
            nodes,
            metadata,
        })
    }

    pub fn execute(
        &mut self,
        context: &RequestContext,
        envelope: &CommandEnvelope,
    ) -> Result<DurableResult> {
        let started = Instant::now();
        envelope.validate()?;
        if context.author_id.is_empty()
            || context.author_id.len() > 256
            || context.session_id.is_empty()
            || context.session_id.len() > 256
        {
            return Err(EngineError::new(
                "authentication_failed",
                "a server-bound author/session is required",
            ));
        }
        if envelope.document_id != self.meta.id {
            return Err(EngineError::new(
                "invalid_argument",
                "command targets a different document",
            ));
        }
        if envelope.target_epoch != self.meta.epoch {
            return Err(EngineError::new(
                "epoch_mismatch",
                "command belongs to a different document generation",
            ));
        }
        let digest = envelope.digest()?;
        if let Some((old_digest, mut result)) = self.store.receipt(
            &context.author_id,
            &self.meta.epoch,
            &envelope.idempotency_key,
        )? {
            if old_digest != digest {
                return Err(EngineError::new(
                    "idempotency_conflict",
                    "key was committed with a different semantic payload",
                ));
            }
            result.request_id.clone_from(&envelope.request_id);
            result.replayed = true;
            return Ok(result);
        }
        self.check_preconditions(&envelope.preconditions)?;
        let mut candidate = self.candidate(&context.author_id)?;
        let channel = history_channel(&envelope.command)?;
        let session_key = (
            context.author_id.clone(),
            context.session_id.clone(),
            channel,
        );
        let mut history_action = None;
        match &envelope.command {
            Command::Undo | Command::HistoryUndo { .. } => {
                let group = self
                    .undo
                    .get(&session_key)
                    .and_then(|groups| groups.last())
                    .cloned()
                    .ok_or_else(|| {
                        EngineError::new("conflict", "no Undo history in this author session")
                    })?;
                for operation in &group.operations {
                    self.append(
                        &mut candidate,
                        Action::Retract {
                            entity_id: operation.action.entity_id().into(),
                            operation_id: operation.id.clone(),
                        },
                    )?;
                }
                history_action = Some((false, group));
            }
            Command::Redo | Command::HistoryRedo { .. } => {
                let group = self
                    .redo
                    .get(&session_key)
                    .and_then(|groups| groups.last())
                    .cloned()
                    .ok_or_else(|| {
                        EngineError::new("conflict", "no Redo history in this author session")
                    })?;
                for operation in &group.operations {
                    self.append(&mut candidate, operation.action.clone())?;
                }
                history_action = Some((true, group));
            }
            command => self.prepare_command(
                &mut candidate,
                command,
                matches!(envelope.preconditions, Preconditions::Revision { .. }),
                0,
            )?,
        }
        self.validate_candidate(&candidate, false)?;
        if started.elapsed().as_millis() > envelope.deadline_ms.unwrap_or(30_000) as u128 {
            return Err(EngineError::new(
                "deadline_exceeded",
                "deadline elapsed before commit",
            ));
        }
        // Re-read the durable revision before installing; a competing local authority cannot silently overwrite it.
        if self.store.metadata()?.sequence != self.meta.sequence {
            return Err(EngineError::new(
                "stale_revision",
                "document writer changed during preparation",
            ));
        }
        let transaction = self.transaction(context, envelope.undo_group.clone(), &candidate)?;
        transaction.validate()?;
        let changed: Vec<_> = candidate.changed.iter().cloned().collect();
        let result = DurableResult {
            request_id: envelope.request_id.clone(),
            status: "durable".into(),
            transaction_id: transaction.transaction_id.clone(),
            revision: Revision {
                epoch: self.meta.epoch.clone(),
                sequence: self.meta.sequence + 1,
            },
            replayed: false,
            result: serde_json::json!({"changedIds":changed,"operationCount":transaction.operations.len()}),
        };
        let writes = self.changed_nodes(&candidate);
        let committed = self.store.commit(Commit {
            expected_sequence: self.meta.sequence,
            transaction: &transaction,
            nodes: &writes,
            catalog: &candidate.catalog,
            receipt: Some(ReceiptWrite {
                principal: &context.author_id,
                key: &envelope.idempotency_key,
                digest: &digest,
                result: &result,
            }),
            local: true,
        });
        match committed {
            Ok(meta) => {
                self.meta = meta;
                self.catalog = Arc::clone(&candidate.catalog);
            }
            Err(error) => {
                // A COMMIT I/O error can have an uncertain outcome. Resolve the durable receipt before retrying.
                if let Some((stored_digest, mut result)) = self.store.receipt(
                    &context.author_id,
                    &self.meta.epoch,
                    &envelope.idempotency_key,
                )? && stored_digest == digest
                {
                    self.meta = self.store.metadata()?;
                    self.catalog = Arc::new(self.store.catalog(None)?);
                    result.replayed = true;
                    return Ok(result);
                }
                return Err(error);
            }
        }
        if let Some((redo, group)) = history_action {
            if redo {
                self.redo.entry(session_key.clone()).or_default().pop();
                self.undo.entry(session_key).or_default().push(UndoGroup {
                    id: group.id,
                    operations: transaction.operations.clone(),
                });
            } else {
                self.undo.entry(session_key.clone()).or_default().pop();
                self.redo.entry(session_key).or_default().push(group);
            }
        } else {
            let id = envelope
                .undo_group
                .clone()
                .unwrap_or_else(|| transaction.transaction_id.clone());
            let groups = self.undo.entry(session_key.clone()).or_default();
            if let Some(last) = groups.last_mut().filter(|last| last.id == id) {
                last.operations.extend(transaction.operations.clone())
            } else {
                groups.push(UndoGroup {
                    id,
                    operations: transaction.operations.clone(),
                });
            }
            self.redo.remove(&session_key);
        }
        Ok(result)
    }

    fn check_preconditions(&self, preconditions: &Preconditions) -> Result<()> {
        match preconditions {
            Preconditions::Revision { revision } => {
                if revision != &self.revision() {
                    return Err(
                        EngineError::new("stale_revision", "document revision changed")
                            .detail(serde_json::json!({"currentRevision":self.revision()})),
                    );
                }
            }
            Preconditions::Dependencies { fields } => {
                if fields.is_empty() || fields.len() > 1024 {
                    return Err(EngineError::invalid(
                        "dependency preconditions require 1–1024 fields",
                    ));
                }
                for field in fields {
                    if self.field_version(&field.entity_id, &field.field)? != field.version {
                        return Err(
                            EngineError::new("conflict", "observed field changed").detail(
                                serde_json::json!({"entityId":field.entity_id,"field":field.field}),
                            ),
                        );
                    }
                }
            }
            Preconditions::Latest { .. } => {}
        }
        Ok(())
    }

    fn candidate(&self, author: &str) -> Result<Candidate> {
        Ok(Candidate {
            catalog: Arc::clone(&self.catalog),
            nodes: BTreeMap::new(),
            changed: BTreeSet::new(),
            operations: Vec::new(),
            author: author.into(),
            lamport: self
                .meta
                .lamport
                .checked_add(1)
                .ok_or_else(|| EngineError::new("resource_limit", "Lamport clock exhausted"))?,
            first_counter: self.meta.operation_counter,
        })
    }

    fn state(&self, candidate: &Candidate, id: &str) -> Result<Option<NodeState>> {
        if let Some(state) = candidate.nodes.get(id) {
            Ok(Some(state.clone()))
        } else {
            self.store.node_state(id, None)
        }
    }

    fn live_node(&self, candidate: &Candidate, id: &str) -> Result<Node> {
        let state = self
            .state(candidate, id)?
            .ok_or_else(|| EngineError::invalid(format!("unknown node {id}")))?;
        let node = state
            .project()?
            .ok_or_else(|| EngineError::new("conflict", "node was deleted"))?;
        let mut cursor = node.parent_id.clone();
        let mut seen = BTreeSet::from([id.to_string()]);
        while let Some(parent) = cursor {
            if !seen.insert(parent.clone()) {
                break;
            }
            match self.state(candidate, &parent)? {
                Some(state) => match state.project()? {
                    Some(node) => cursor = node.parent_id,
                    None => return Err(EngineError::new("conflict", "an ancestor was deleted")),
                },
                None => break,
            }
        }
        Ok(node)
    }

    fn append(&self, candidate: &mut Candidate, action: Action) -> Result<()> {
        let stamp = Stamp {
            lamport: candidate.lamport,
            replica_id: self.meta.replica_id.clone(),
            counter: candidate
                .first_counter
                .checked_add(candidate.operations.len() as u64 + 1)
                .ok_or_else(|| EngineError::new("resource_limit", "operation counter exhausted"))?,
        };
        let operation = Operation {
            id: stamp.operation_id(),
            stamp,
            author_id: candidate.author.clone(),
            action,
        };
        self.apply_operation(candidate, operation)
    }

    fn apply_operation(&self, candidate: &mut Candidate, operation: Operation) -> Result<()> {
        let entity = operation.action.entity_id().to_string();
        if entity == "catalog" {
            Arc::make_mut(&mut candidate.catalog).apply(operation.clone())?;
        } else {
            let mut state = self
                .state(candidate, &entity)?
                .unwrap_or_else(NodeState::empty);
            if state.original_node().is_none()
                && !matches!(operation.action, Action::CreateNode { .. })
            {
                return Err(EngineError::new(
                    "dependency_unavailable",
                    "node creation dependency is missing",
                ));
            }
            state.apply(operation.clone())?;
            candidate.nodes.insert(entity.clone(), state);
            candidate.changed.insert(entity);
        }
        candidate.operations.push(operation);
        Ok(())
    }

    fn prepare_command(
        &self,
        candidate: &mut Candidate,
        command: &Command,
        strict_revision: bool,
        depth: usize,
    ) -> Result<()> {
        if depth > 16 {
            return Err(EngineError::new(
                "resource_limit",
                "batch nesting exceeds 16",
            ));
        }
        match command {
            Command::NodeCreate { node } => {
                node.validate().map_err(EngineError::invalid)?;
                if self.state(candidate, &node.id)?.is_some() {
                    return Err(EngineError::new(
                        "conflict",
                        "node identity is already used",
                    ));
                }
                if node.parent_id.is_none() {
                    return Err(EngineError::invalid(
                        "ordinary node creation requires a parent",
                    ));
                }
                self.append(candidate, Action::CreateNode { node: node.clone() })?;
            }
            Command::NodeSet {
                node_id,
                properties,
            } => {
                self.live_node(candidate, node_id)?;
                self.append(
                    candidate,
                    Action::SetNode {
                        node_id: node_id.clone(),
                        properties: properties.clone(),
                    },
                )?;
            }
            Command::NodeUnset {
                node_id,
                properties,
            } => {
                self.live_node(candidate, node_id)?;
                self.append(
                    candidate,
                    Action::UnsetNode {
                        node_id: node_id.clone(),
                        properties: properties.clone(),
                    },
                )?;
            }
            Command::NodeMove {
                node_id,
                parent_id,
                rank,
            } => {
                self.live_node(candidate, node_id)?;
                if parent_id.is_none() || !valid_rank(rank) {
                    return Err(EngineError::invalid(
                        "move requires a parent and a 128-bit rank",
                    ));
                }
                if candidate
                    .catalog
                    .current_pages()
                    .iter()
                    .any(|page| page.root_node_id == *node_id)
                {
                    return Err(EngineError::invalid("page roots cannot be moved"));
                }
                self.append(
                    candidate,
                    Action::MoveNode {
                        node_id: node_id.clone(),
                        parent_id: parent_id.clone(),
                        rank: rank.clone(),
                    },
                )?;
            }
            Command::NodeDelete { node_ids } => {
                if node_ids.is_empty() || node_ids.len() > 4096 {
                    return Err(EngineError::invalid("delete requires 1–4096 nodes"));
                }
                let roots: BTreeSet<_> = candidate
                    .catalog
                    .current_pages()
                    .into_iter()
                    .map(|page| page.root_node_id)
                    .collect();
                let unique: BTreeSet<_> = node_ids.iter().cloned().collect();
                for id in unique {
                    self.live_node(candidate, &id)?;
                    if roots.contains(&id) {
                        return Err(EngineError::invalid("delete a page through page.delete"));
                    }
                    self.append(candidate, Action::DeleteNode { node_id: id })?;
                }
            }
            Command::NodeRebalance { parent_id } => {
                self.live_node(candidate, parent_id)?;
                let mut ids: BTreeSet<_> = self.store.child_ids(parent_id)?.into_iter().collect();
                for (id, state) in &candidate.nodes {
                    match state.project()? {
                        Some(node) if node.parent_id.as_ref() == Some(parent_id) => {
                            ids.insert(id.clone());
                        }
                        _ => {
                            ids.remove(id);
                        }
                    }
                }
                if ids.len() > 4096 {
                    return Err(EngineError::new(
                        "resource_limit",
                        "large sibling rebalance requires an isolated job",
                    ));
                }
                let mut siblings = ids
                    .into_iter()
                    .map(|id| self.live_node(candidate, &id))
                    .collect::<Result<Vec<_>>>()?;
                siblings.sort_by(|a, b| a.rank.cmp(&b.rank).then_with(|| a.id.cmp(&b.id)));
                let spacing = u128::MAX / (siblings.len() as u128 + 1);
                for (index, node) in siblings.into_iter().enumerate() {
                    let placement_version = self
                        .state(candidate, &node.id)?
                        .unwrap()
                        .base_placement_version()
                        .unwrap();
                    self.append(
                        candidate,
                        Action::AdjustRank {
                            node_id: node.id,
                            placement_version,
                            parent_id: parent_id.clone(),
                            rank: format!("{:032x}", spacing * (index as u128 + 1)),
                        },
                    )?;
                }
                if candidate.operations.is_empty() {
                    return Err(EngineError::invalid("parent has no siblings to rebalance"));
                }
            }
            Command::PageCreate { page, root } => {
                if !valid_id(&page.id, "page")
                    || !valid_rank(&page.rank)
                    || page.title.len() > 4096
                    || page.root_node_id != root.id
                    || root.parent_id.is_some()
                    || root.kind != NodeKind::Frame
                {
                    return Err(EngineError::invalid("invalid page/root pair"));
                }
                if candidate
                    .catalog
                    .current_pages()
                    .iter()
                    .any(|old| old.id == page.id)
                    || self.state(candidate, &root.id)?.is_some()
                {
                    return Err(EngineError::new(
                        "conflict",
                        "page identity is already used",
                    ));
                }
                self.append(candidate, Action::CreateNode { node: root.clone() })?;
                self.append(candidate, Action::CreatePage { page: page.clone() })?;
            }
            Command::PageRename { page_id, title } => {
                if title.len() > 4096
                    || !candidate
                        .catalog
                        .current_pages()
                        .iter()
                        .any(|page| &page.id == page_id)
                {
                    return Err(EngineError::invalid("invalid page or title"));
                }
                self.append(
                    candidate,
                    Action::RenamePage {
                        page_id: page_id.clone(),
                        title: title.clone(),
                    },
                )?;
            }
            Command::PageMove { page_id, rank } => {
                if !valid_rank(rank)
                    || !candidate
                        .catalog
                        .current_pages()
                        .iter()
                        .any(|page| &page.id == page_id)
                {
                    return Err(EngineError::invalid("invalid page or rank"));
                }
                self.append(
                    candidate,
                    Action::MovePage {
                        page_id: page_id.clone(),
                        rank: rank.clone(),
                    },
                )?;
            }
            Command::PageDelete { page_id } => {
                if candidate.catalog.current_pages().len() <= 1 {
                    return Err(EngineError::invalid("cannot delete the last page"));
                }
                let page = candidate
                    .catalog
                    .current_pages()
                    .into_iter()
                    .find(|page| &page.id == page_id)
                    .ok_or_else(|| EngineError::invalid("unknown page"))?;
                self.append(
                    candidate,
                    Action::DeletePage {
                        page_id: page_id.clone(),
                    },
                )?;
                self.append(
                    candidate,
                    Action::DeleteNode {
                        node_id: page.root_node_id,
                    },
                )?;
            }
            Command::DocumentRename { title } => {
                if title.len() > 4096 {
                    return Err(EngineError::invalid("document title is too long"));
                }
                self.append(
                    candidate,
                    Action::RenameDocument {
                        title: title.clone(),
                    },
                )?;
            }
            Command::DocumentMetadata { properties } => {
                omc_model::validate_properties(properties).map_err(EngineError::invalid)?;
                self.append(
                    candidate,
                    Action::SetMetadata {
                        properties: properties.clone(),
                    },
                )?;
            }
            Command::CatalogSet {
                namespace,
                entity_id,
                properties,
            } => {
                let valid = match namespace.as_str() {
                    "comments" => valid_id(entity_id, "comment") || valid_id(entity_id, "thread"),
                    "tokens" => valid_id(entity_id, "token"),
                    "styles" => valid_id(entity_id, "style"),
                    "components" => valid_id(entity_id, "component"),
                    "assets" => valid_id(entity_id, "asset"),
                    "libraries" => valid_id(entity_id, "library"),
                    _ => false,
                };
                if !valid || properties.is_empty() {
                    return Err(EngineError::invalid("invalid catalog namespace/entity"));
                }
                let mut patch = Properties::new();
                for (field, value) in properties {
                    if field.len() > 128 || field.contains('/') {
                        return Err(EngineError::invalid("invalid catalog field"));
                    }
                    patch.insert(format!("{namespace}/{entity_id}/{field}"), value.clone());
                }
                if namespace == "comments" {
                    let author_key = format!("comments/{entity_id}/authorId");
                    let existing = candidate.catalog.comment_author(entity_id);
                    if let Some(author) = existing {
                        if patch.get(&author_key).is_some_and(|new| new != &author) {
                            return Err(EngineError::new(
                                "authentication_failed",
                                "comment author attribution is immutable",
                            ));
                        }
                        if (properties.contains_key("body") || properties.contains_key("deleted"))
                            && author.as_str() != Some(candidate.author.as_str())
                        {
                            return Err(EngineError::new(
                                "authentication_failed",
                                "only the comment author may edit or delete its body",
                            ));
                        }
                    } else {
                        if patch.get(&author_key).is_some_and(|author| {
                            author.as_str() != Some(candidate.author.as_str())
                        }) {
                            return Err(EngineError::new(
                                "authentication_failed",
                                "comment author comes from authenticated context",
                            ));
                        }
                        patch.insert(author_key, Value::String(candidate.author.clone()));
                    }
                }
                omc_model::validate_properties(&patch).map_err(EngineError::invalid)?;
                self.append(candidate, Action::SetMetadata { properties: patch })?;
            }
            Command::TextInsert {
                node_id,
                offset,
                text,
                attributes,
            } => {
                self.live_node(candidate, node_id)?;
                let selection = self
                    .state(candidate, node_id)?
                    .unwrap()
                    .text_view()?
                    .selection(node_id, *offset, *offset)?;
                self.prepare_splice(candidate, &selection, text, attributes)?;
            }
            Command::TextDelete {
                node_id,
                start,
                end,
            } => {
                self.live_node(candidate, node_id)?;
                let selection = self
                    .state(candidate, node_id)?
                    .unwrap()
                    .text_view()?
                    .selection(node_id, *start, *end)?;
                self.append(
                    candidate,
                    Action::TextDelete {
                        node_id: node_id.clone(),
                        items: selection.observed_items,
                    },
                )?;
            }
            Command::TextMark {
                node_id,
                start,
                end,
                attributes,
            } => {
                self.live_node(candidate, node_id)?;
                omc_model::validate_properties(attributes).map_err(EngineError::invalid)?;
                let selection = self
                    .state(candidate, node_id)?
                    .unwrap()
                    .text_view()?
                    .selection(node_id, *start, *end)?;
                self.append(
                    candidate,
                    Action::TextMark {
                        node_id: node_id.clone(),
                        items: selection.observed_items,
                        attributes: attributes.clone(),
                    },
                )?;
            }
            Command::TextReplace { node_id, text } => {
                if !strict_revision {
                    return Err(EngineError::invalid(
                        "whole-text replacement requires a strict revision",
                    ));
                }
                self.live_node(candidate, node_id)?;
                let view = self.state(candidate, node_id)?.unwrap().text_view()?;
                let selection =
                    view.selection(node_id, 0, view.text.encode_utf16().count() as u32)?;
                self.prepare_splice(candidate, &selection, text, &Properties::new())?;
            }
            Command::TextSplice {
                selection,
                text,
                attributes,
            } => self.prepare_splice(candidate, selection, text, attributes)?,
            Command::Batch { commands } => {
                for command in commands {
                    if matches!(
                        command,
                        Command::Undo
                            | Command::Redo
                            | Command::HistoryUndo { .. }
                            | Command::HistoryRedo { .. }
                    ) {
                        return Err(EngineError::invalid(
                            "Undo/Redo cannot be nested in a batch",
                        ));
                    }
                    self.prepare_command(candidate, command, strict_revision, depth + 1)?;
                }
            }
            Command::Undo
            | Command::Redo
            | Command::HistoryUndo { .. }
            | Command::HistoryRedo { .. } => {
                return Err(EngineError::invalid("history command in preparation"));
            }
        }
        Ok(())
    }

    fn prepare_splice(
        &self,
        candidate: &mut Candidate,
        selection: &TextSelection,
        text: &str,
        attributes: &Properties,
    ) -> Result<()> {
        self.live_node(candidate, &selection.node_id)?;
        let view = self
            .state(candidate, &selection.node_id)?
            .unwrap()
            .text_view()?;
        for id in selection
            .start
            .left
            .iter()
            .chain(selection.start.right.iter())
            .chain(selection.end.left.iter())
            .chain(selection.end.right.iter())
            .chain(selection.observed_items.iter())
        {
            if !view.all_items.contains(id) {
                return Err(EngineError::new(
                    "conflict",
                    "composition anchor cannot resolve; preserve composed text for recovery",
                ));
            }
        }
        if !selection.observed_items.is_empty() {
            self.append(
                candidate,
                Action::TextDelete {
                    node_id: selection.node_id.clone(),
                    items: selection.observed_items.clone(),
                },
            )?;
        }
        // Insertion is anchored to stable identity, including a deleted atom. Foreign inserted descendants survive.
        let after = match selection.start.association {
            Association::After => selection.start.left.clone(),
            Association::Before => selection
                .start
                .right
                .as_ref()
                .and_then(|right| view.all_order.iter().position(|id| id == right))
                .and_then(|index| index.checked_sub(1))
                .map(|index| view.all_order[index].clone())
                .or_else(|| selection.start.left.clone()),
        };
        self.append(
            candidate,
            Action::TextInsert {
                node_id: selection.node_id.clone(),
                after,
                text: text.into(),
                attributes: attributes.clone(),
            },
        )
    }

    fn validate_candidate(&self, candidate: &Candidate, remote: bool) -> Result<()> {
        let pages = candidate.catalog.current_pages();
        let roots: BTreeSet<_> = pages.iter().map(|page| page.root_node_id.clone()).collect();
        for id in &candidate.changed {
            let state = &candidate.nodes[id];
            let Some(node) = state.project()? else {
                continue;
            };
            node.validate().map_err(EngineError::invalid)?;
            let mut cursor = node.clone();
            let mut seen = BTreeSet::new();
            while let Some(parent) = &cursor.parent_id {
                if !seen.insert(parent.clone()) {
                    if remote {
                        break;
                    }
                    return Err(EngineError::invalid("containment cycle"));
                }
                if seen.len() > 256 {
                    return Err(EngineError::new(
                        "resource_limit",
                        "containment depth exceeds 256",
                    ));
                }
                let Some(parent_state) = self.state(candidate, parent)? else {
                    return Err(EngineError::new(
                        "dependency_unavailable",
                        "parent dependency is missing",
                    ));
                };
                let Some(parent_node) = parent_state.project()? else {
                    if remote {
                        break;
                    }
                    return Err(EngineError::new("conflict", "parent was deleted"));
                };
                cursor = parent_node;
            }
            if !remote && cursor.parent_id.is_none() && !roots.contains(&cursor.id) {
                return Err(EngineError::invalid("node must remain attached to a page"));
            }
        }
        Ok(())
    }

    fn transaction(
        &self,
        context: &RequestContext,
        undo_group: Option<String>,
        candidate: &Candidate,
    ) -> Result<RemoteTransaction> {
        let mut dependencies = self.store.frontiers()?;
        dependencies.insert(self.meta.replica_id.clone(), self.meta.transaction_counter);
        Ok(RemoteTransaction {
            profile: omc_protocol::CRDT_PROFILE.into(),
            transaction_id: uuid::Uuid::new_v4().to_string(),
            document_id: self.meta.id.clone(),
            epoch: self.meta.epoch.clone(),
            replica_id: self.meta.replica_id.clone(),
            counter: self.meta.transaction_counter + 1,
            lamport: candidate.lamport,
            dependencies,
            author_id: context.author_id.clone(),
            session_id: context.session_id.clone(),
            undo_group,
            operations: candidate.operations.clone(),
        })
    }
    fn changed_nodes(&self, candidate: &Candidate) -> BTreeMap<String, NodeState> {
        candidate
            .changed
            .iter()
            .map(|id| (id.clone(), candidate.nodes[id].clone()))
            .collect()
    }

    pub fn operation_status(
        &self,
        principal: &str,
        epoch: &str,
        key: &str,
    ) -> Result<Option<DurableResult>> {
        Ok(self
            .store
            .receipt(principal, epoch, key)?
            .map(|(_, result)| result))
    }
    pub fn export_transactions(&self, after_sequence: u64) -> Result<Vec<RemoteTransaction>> {
        self.store.transactions(after_sequence)
    }
    pub fn replica_package(&self) -> Result<ReplicaPackage> {
        Ok(ReplicaPackage {
            profile: omc_protocol::CRDT_PROFILE.into(),
            document_id: self.meta.id.clone(),
            epoch: self.meta.epoch.clone(),
            genesis: self.store.genesis()?,
            transactions: self.store.transactions(0)?,
        })
    }
    pub fn fork_replica(path: impl AsRef<Path>, package: ReplicaPackage) -> Result<Self> {
        if package.profile != omc_protocol::CRDT_PROFILE
            || !valid_id(&package.document_id, "doc")
            || uuid::Uuid::parse_str(&package.epoch).is_err()
        {
            return Err(EngineError::new(
                "protocol_mismatch",
                "unsupported replica package",
            ));
        }
        package.genesis.validate().map_err(EngineError::invalid)?;
        // Validate the complete package before creating a public destination. The caller supplies a private staging path.
        for transaction in &package.transactions {
            transaction.validate()?;
            if transaction.document_id != package.document_id || transaction.epoch != package.epoch
            {
                return Err(EngineError::invalid(
                    "package contains another document generation",
                ));
            }
        }
        let store = DocumentStore::create(
            path.as_ref(),
            &package.document_id,
            &package.epoch,
            &uuid::Uuid::new_v4().to_string(),
            &package.genesis,
        )?;
        let mut engine = Self::from_store(store)?;
        for transaction in package.transactions {
            engine.receive_transaction(transaction)?;
        }
        if !engine.store.staged_transactions()?.is_empty() {
            return Err(EngineError::new(
                "dependency_unavailable",
                "replica package is not a closed causal cut",
            ));
        }
        Ok(engine)
    }

    pub fn receive_transaction(&mut self, transaction: RemoteTransaction) -> Result<ReceiveResult> {
        transaction.validate()?;
        if transaction.document_id != self.meta.id || transaction.epoch != self.meta.epoch {
            return Err(EngineError::new(
                "epoch_mismatch",
                "peer transaction belongs to another document generation",
            ));
        }
        if let Some(existing) = self.store.transaction_digest(&transaction)? {
            if existing != transaction.digest()? {
                return Err(EngineError::new(
                    "protocol_mismatch",
                    "replica identity/counter has divergent history",
                ));
            }
            return Ok(ReceiveResult {
                status: "replayed".into(),
                revision: self.revision(),
                applied_transactions: Vec::new(),
            });
        }
        if transaction.replica_id == self.meta.replica_id {
            return Err(EngineError::new(
                "protocol_mismatch",
                "another writer reused this durable replica identity",
            ));
        }
        self.store.stage_transaction(&transaction)?;
        let applied = self.apply_staged(Some(&transaction.transaction_id))?;
        let status = if applied.contains(&transaction.transaction_id) {
            "applied"
        } else {
            "staged"
        };
        Ok(ReceiveResult {
            status: status.into(),
            revision: self.revision(),
            applied_transactions: applied,
        })
    }

    fn apply_staged(&mut self, requested: Option<&str>) -> Result<Vec<String>> {
        let mut applied = Vec::new();
        loop {
            let frontiers = self.store.frontiers()?;
            let pending = self.store.staged_transactions()?;
            let mut progressed = false;
            for transaction in pending {
                if transaction.dependencies.iter().any(|(replica, counter)| {
                    frontiers.get(replica).copied().unwrap_or(0) < *counter
                }) {
                    continue;
                }
                if frontiers.get(&transaction.replica_id).copied().unwrap_or(0) + 1
                    != transaction.counter
                {
                    continue;
                }
                let previous = if transaction.counter > 1 {
                    self.store
                        .transaction_at(&transaction.replica_id, transaction.counter - 1)?
                } else {
                    None
                };
                let first_expected = previous
                    .as_ref()
                    .and_then(|previous| previous.operations.last())
                    .map(|op| op.stamp.counter + 1)
                    .unwrap_or(1);
                for (index, operation) in transaction.operations.iter().enumerate() {
                    if operation.stamp.counter != first_expected + index as u64 {
                        return Err(EngineError::new(
                            "protocol_mismatch",
                            "replica operation counter is divergent",
                        ));
                    }
                }
                for (replica, counter) in &transaction.dependencies {
                    if *counter > 0
                        && let Some(dependency) = self.store.transaction_at(replica, *counter)?
                        && transaction.lamport <= dependency.lamport
                    {
                        return Err(EngineError::new(
                            "protocol_mismatch",
                            "Lamport stamp does not follow observed dependencies",
                        ));
                    }
                }
                let prepared = (|| {
                    let mut candidate = self.candidate(&transaction.author_id)?;
                    for operation in &transaction.operations {
                        self.apply_operation(&mut candidate, operation.clone())?;
                    }
                    self.validate_candidate(&candidate, true)?;
                    Ok::<Candidate, EngineError>(candidate)
                })();
                let candidate = match prepared {
                    Ok(candidate) => candidate,
                    Err(error)
                        if matches!(
                            error.code.as_str(),
                            "dependency_unavailable" | "resource_limit"
                        ) =>
                    {
                        continue;
                    }
                    Err(error) => {
                        self.store
                            .reject_staged(&transaction.transaction_id, &error)?;
                        if requested == Some(transaction.transaction_id.as_str()) {
                            return Err(error);
                        }
                        progressed = true;
                        break;
                    }
                };
                let writes = self.changed_nodes(&candidate);
                self.meta = self.store.commit(Commit {
                    expected_sequence: self.meta.sequence,
                    transaction: &transaction,
                    nodes: &writes,
                    catalog: &candidate.catalog,
                    receipt: None,
                    local: false,
                })?;
                self.catalog = Arc::clone(&candidate.catalog);
                applied.push(transaction.transaction_id);
                progressed = true;
                break;
            }
            if !progressed {
                break;
            }
        }
        Ok(applied)
    }

    pub fn receive_fragment(
        &mut self,
        header: TransferHeader,
        index: usize,
        bytes: Vec<u8>,
    ) -> Result<ReceiveResult> {
        if header.epoch != self.meta.epoch {
            return Err(EngineError::new(
                "epoch_mismatch",
                "peer fragment belongs to another generation",
            ));
        }
        if let Some(fragments) = self.store.stage_fragment(&header, index, &bytes)? {
            let transaction = omc_sync::assemble_transaction(&header, &fragments)?;
            let result = self.receive_transaction(transaction)?;
            self.store.finish_fragments(&header.transfer_id)?;
            Ok(result)
        } else {
            Ok(ReceiveResult {
                status: "staged".into(),
                revision: self.revision(),
                applied_transactions: Vec::new(),
            })
        }
    }
}

fn history_channel(command: &Command) -> Result<HistoryChannel> {
    match command {
        Command::HistoryUndo { channel } | Command::HistoryRedo { channel } => Ok(*channel),
        Command::CatalogSet { namespace, .. } if namespace == "comments" => {
            Ok(HistoryChannel::Comments)
        }
        Command::DocumentMetadata { properties } => {
            let comments = properties
                .keys()
                .filter(|key| key.starts_with("comments/"))
                .count();
            if comments > 0 && comments != properties.len() {
                return Err(EngineError::invalid(
                    "design and comment metadata need separate history groups",
                ));
            }
            Ok(if comments > 0 {
                HistoryChannel::Comments
            } else {
                HistoryChannel::Design
            })
        }
        Command::Batch { commands } => {
            let mut channel = None;
            for command in commands {
                let next = history_channel(command)?;
                if channel.is_some_and(|old| old != next) {
                    return Err(EngineError::invalid(
                        "design and comment commands cannot share an Undo group",
                    ));
                }
                channel = Some(next);
            }
            Ok(channel.unwrap_or(HistoryChannel::Design))
        }
        _ => Ok(HistoryChannel::Design),
    }
}
