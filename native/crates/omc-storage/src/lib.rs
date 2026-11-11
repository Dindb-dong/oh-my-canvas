//! SQLite durability boundary for the native document authority.
use omc_model::{DocumentContent, Node, Revision};
use omc_protocol::{DurableResult, EngineError, Result};
use omc_sync::{CatalogState, NodeState, Operation, RemoteTransaction, TransferHeader};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, path::Path};

pub fn verify_sqlite(connection: &Connection) -> Result<()> {
    let number = rusqlite::version_number();
    if number < 3_051_003 {
        return Err(EngineError::new(
            "storage_unavailable",
            "SQLite 3.51.3 or later is required",
        ));
    }
    connection.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA wal_autocheckpoint=0; PRAGMA busy_timeout=50;")
        .map_err(|error| EngineError::new("storage_unavailable", error.to_string()))?;
    let journal: String = connection
        .query_row("PRAGMA journal_mode", [], |row| row.get(0))
        .map_err(|e| EngineError::new("storage_unavailable", e.to_string()))?;
    let sync: i64 = connection
        .query_row("PRAGMA synchronous", [], |row| row.get(0))
        .map_err(|e| EngineError::new("storage_unavailable", e.to_string()))?;
    let foreign: i64 = connection
        .query_row("PRAGMA foreign_keys", [], |row| row.get(0))
        .map_err(|e| EngineError::new("storage_unavailable", e.to_string()))?;
    let auto: i64 = connection
        .query_row("PRAGMA wal_autocheckpoint", [], |row| row.get(0))
        .map_err(|e| EngineError::new("storage_unavailable", e.to_string()))?;
    if journal != "wal" || sync != 2 || foreign != 1 || auto != 0 {
        return Err(EngineError::new(
            "storage_unavailable",
            "SQLite durability settings were not applied",
        ));
    }
    #[cfg(target_os = "macos")]
    connection
        .execute_batch("PRAGMA fullfsync=ON; PRAGMA checkpoint_fullfsync=ON;")
        .map_err(|e| EngineError::new("storage_unavailable", e.to_string()))?;
    Ok(())
}

const APPLICATION_ID: i64 = 0x4f4d4331;
const SCHEMA_VERSION: i64 = 1;

fn sql_error(error: rusqlite::Error) -> EngineError {
    EngineError::new("storage_unavailable", error.to_string())
}
fn encode<T: Serialize>(value: &T) -> Result<Vec<u8>> {
    serde_json::to_vec(value).map_err(|e| EngineError::invalid(e.to_string()))
}
fn decode<T: serde::de::DeserializeOwned>(bytes: &[u8]) -> Result<T> {
    serde_json::from_slice(bytes).map_err(|e| EngineError::new("corrupt_state", e.to_string()))
}
fn integer(value: u64) -> Result<i64> {
    value
        .try_into()
        .map_err(|_| EngineError::new("resource_limit", "SQLite sequence capacity reached"))
}
fn unsigned(row: &rusqlite::Row<'_>, index: usize) -> rusqlite::Result<u64> {
    let value: i64 = row.get(index)?;
    value
        .try_into()
        .map_err(|_| rusqlite::Error::IntegralValueOutOfRange(index, value))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentMetadata {
    pub id: String,
    pub title: String,
    pub epoch: String,
    #[serde(with = "omc_model::decimal_u64")]
    pub sequence: u64,
    pub replica_id: String,
    pub transaction_counter: u64,
    pub operation_counter: u64,
    pub lamport: u64,
}
impl DocumentMetadata {
    pub fn revision(&self) -> Revision {
        Revision {
            epoch: self.epoch.clone(),
            sequence: self.sequence,
        }
    }
}

pub struct DocumentStore {
    connection: Connection,
}

pub struct Commit<'a> {
    pub expected_sequence: u64,
    pub transaction: &'a RemoteTransaction,
    pub nodes: &'a BTreeMap<String, NodeState>,
    pub catalog: &'a CatalogState,
    pub receipt: Option<ReceiptWrite<'a>>,
    pub local: bool,
}
pub struct ReceiptWrite<'a> {
    pub principal: &'a str,
    pub key: &'a str,
    pub digest: &'a str,
    pub result: &'a DurableResult,
}

impl DocumentStore {
    pub fn create(
        path: &Path,
        id: &str,
        epoch: &str,
        replica_id: &str,
        content: &DocumentContent,
    ) -> Result<Self> {
        content.validate().map_err(EngineError::invalid)?;
        if path.exists() {
            return Err(EngineError::new(
                "conflict",
                "destination database already exists",
            ));
        }
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| EngineError::new("storage_unavailable", e.to_string()))?;
        }
        let mut store = Self {
            connection: Connection::open(path).map_err(sql_error)?,
        };
        verify_sqlite(&store.connection)?;
        store.connection.execute_batch(SCHEMA).map_err(sql_error)?;
        store
            .connection
            .pragma_update(None, "application_id", APPLICATION_ID)
            .map_err(sql_error)?;
        store
            .connection
            .pragma_update(None, "user_version", SCHEMA_VERSION)
            .map_err(sql_error)?;
        let transaction = store
            .connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(sql_error)?;
        transaction
            .execute(
                "INSERT INTO document_meta VALUES(1,?1,?2,?3,?4,0,0,0,0)",
                params![id, epoch, replica_id, content.title],
            )
            .map_err(sql_error)?;
        transaction
            .execute(
                "INSERT INTO genesis VALUES(1,?1)",
                params![encode(content)?],
            )
            .map_err(sql_error)?;
        transaction
            .execute(
                "INSERT INTO catalog_seed VALUES(1,?1)",
                params![encode(&CatalogState::from_content(content))?],
            )
            .map_err(sql_error)?;
        for node in content.nodes.values() {
            transaction
                .execute(
                    "INSERT INTO node_seeds(node_id,body) VALUES(?1,?2)",
                    params![node.id, encode(node)?],
                )
                .map_err(sql_error)?;
            transaction
                .execute(
                    "INSERT OR IGNORE INTO shards(shard_id,kind) VALUES(?1,'nodes')",
                    params![node.home_shard],
                )
                .map_err(sql_error)?;
            let projection = projection_bytes(Some(node.clone()))?;
            transaction.execute("INSERT INTO current_nodes(node_id,home_shard,parent_id,deleted,projection) VALUES(?1,?2,?3,0,?4)", params![node.id,node.home_shard,node.parent_id,projection]).map_err(sql_error)?;
            transaction.execute("INSERT INTO entity_versions(entity_id,sequence,home_shard,parent_id,deleted,projection) VALUES(?1,0,?2,?3,0,?4)", params![node.id,node.home_shard,node.parent_id,projection]).map_err(sql_error)?;
            transaction.execute("INSERT INTO node_routes(entity_id,sequence,home_shard,parent_id) VALUES(?1,0,?2,?3)", params![node.id,node.home_shard,node.parent_id]).map_err(sql_error)?;
        }
        transaction.commit().map_err(sql_error)?;
        Ok(store)
    }

    pub fn open(path: &Path) -> Result<Self> {
        let connection =
            Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE)
                .map_err(sql_error)?;
        verify_sqlite(&connection)?;
        let application: i64 = connection
            .pragma_query_value(None, "application_id", |row| row.get(0))
            .map_err(sql_error)?;
        let version: i64 = connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .map_err(sql_error)?;
        if application != APPLICATION_ID || version != SCHEMA_VERSION {
            return Err(EngineError::new(
                "protocol_mismatch",
                "unsupported native database schema",
            ));
        }
        let check: String = connection
            .query_row("PRAGMA quick_check(1)", [], |row| row.get(0))
            .map_err(sql_error)?;
        if check != "ok" {
            return Err(EngineError::new(
                "corrupt_state",
                "SQLite integrity check failed",
            ));
        }
        let store = Self { connection };
        let meta = store.metadata()?;
        if !omc_model::valid_id(&meta.id, "doc") || uuid::Uuid::parse_str(&meta.epoch).is_err() {
            return Err(EngineError::new(
                "corrupt_state",
                "invalid committed document identity",
            ));
        }
        Ok(store)
    }

    pub fn metadata(&self) -> Result<DocumentMetadata> {
        self.connection.query_row("SELECT document_id,title,epoch,sequence,replica_id,transaction_counter,operation_counter,lamport FROM document_meta WHERE singleton=1", [], |row| {
            Ok(DocumentMetadata { id:row.get(0)?,title:row.get(1)?,epoch:row.get(2)?,sequence:unsigned(row,3)?,replica_id:row.get(4)?,transaction_counter:unsigned(row,5)?,operation_counter:unsigned(row,6)?,lamport:unsigned(row,7)? })
        }).map_err(sql_error)
    }

    pub fn genesis(&self) -> Result<DocumentContent> {
        let bytes: Vec<u8> = self
            .connection
            .query_row("SELECT body FROM genesis WHERE singleton=1", [], |row| {
                row.get(0)
            })
            .map_err(sql_error)?;
        decode(&bytes)
    }

    pub fn node_state(&self, id: &str, sequence: Option<u64>) -> Result<Option<NodeState>> {
        let seed: Option<Vec<u8>> = self
            .connection
            .query_row(
                "SELECT body FROM node_seeds WHERE node_id=?1",
                params![id],
                |row| row.get(0),
            )
            .optional()
            .map_err(sql_error)?;
        let mut state = NodeState {
            seed: seed.as_deref().map(decode).transpose()?,
            events: Vec::new(),
        };
        let cut = integer(sequence.unwrap_or(i64::MAX as u64))?;
        let mut statement = self.connection.prepare("SELECT body FROM operations WHERE entity_id=?1 AND sequence<=?2 ORDER BY sequence,ordinal").map_err(sql_error)?;
        let rows = statement
            .query_map(params![id, cut], |row| row.get::<_, Vec<u8>>(0))
            .map_err(sql_error)?;
        for row in rows {
            state.events.push(decode(&row.map_err(sql_error)?)?);
        }
        if state.seed.is_none() && state.events.is_empty() {
            Ok(None)
        } else {
            Ok(Some(state))
        }
    }

    pub fn catalog(&self, sequence: Option<u64>) -> Result<CatalogState> {
        let bytes: Vec<u8> = self
            .connection
            .query_row(
                "SELECT body FROM catalog_seed WHERE singleton=1",
                [],
                |row| row.get(0),
            )
            .map_err(sql_error)?;
        let mut catalog: CatalogState = decode(&bytes)?;
        let mut statement = self.connection.prepare("SELECT body FROM operations WHERE entity_id='catalog' AND sequence<=?1 ORDER BY sequence,ordinal").map_err(sql_error)?;
        let rows = statement
            .query_map(
                params![integer(sequence.unwrap_or(i64::MAX as u64))?],
                |row| row.get::<_, Vec<u8>>(0),
            )
            .map_err(sql_error)?;
        for row in rows {
            catalog.events.push(decode(&row.map_err(sql_error)?)?);
        }
        Ok(catalog)
    }

    pub fn node_ids(&self, sequence: Option<u64>) -> Result<Vec<String>> {
        let mut statement=self.connection.prepare("SELECT DISTINCT entity_id FROM entity_versions WHERE sequence<=?1 ORDER BY entity_id").map_err(sql_error)?;
        statement
            .query_map(
                params![integer(sequence.unwrap_or(i64::MAX as u64))?],
                |row| row.get(0),
            )
            .map_err(sql_error)?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(sql_error)
    }

    pub fn node_ids_page(
        &self,
        sequence: u64,
        after: Option<&str>,
        limit: usize,
    ) -> Result<Vec<String>> {
        let mut statement=self.connection.prepare("SELECT DISTINCT entity_id FROM entity_versions WHERE sequence<=?1 AND entity_id>?2 ORDER BY entity_id LIMIT ?3").map_err(sql_error)?;
        statement
            .query_map(
                params![integer(sequence)?, after.unwrap_or(""), limit as i64],
                |row| row.get(0),
            )
            .map_err(sql_error)?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(sql_error)
    }

    pub fn node_count(&self) -> Result<u64> {
        self.connection
            .query_row(
                "SELECT count(*) FROM current_nodes WHERE deleted=0",
                [],
                |row| unsigned(row, 0),
            )
            .map_err(sql_error)
    }

    pub fn transaction_at(&self, replica: &str, counter: u64) -> Result<Option<RemoteTransaction>> {
        let bytes: Option<Vec<u8>> = self
            .connection
            .query_row(
                "SELECT body FROM transactions WHERE replica_id=?1 AND counter=?2",
                params![replica, integer(counter)?],
                |row| row.get(0),
            )
            .optional()
            .map_err(sql_error)?;
        bytes.as_deref().map(decode).transpose()
    }

    pub fn child_ids(&self, parent: &str) -> Result<Vec<String>> {
        let mut statement=self.connection.prepare("SELECT node_id FROM current_nodes WHERE parent_id=?1 AND deleted=0 ORDER BY node_id").map_err(sql_error)?;
        statement
            .query_map(params![parent], |row| row.get(0))
            .map_err(sql_error)?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(sql_error)
    }

    pub fn receipt(
        &self,
        principal: &str,
        epoch: &str,
        key: &str,
    ) -> Result<Option<(String, DurableResult)>> {
        let row:Option<(String,Vec<u8>)>=self.connection.query_row("SELECT digest,result FROM operation_results WHERE principal=?1 AND epoch=?2 AND operation_key=?3",params![principal,epoch,key],|row|Ok((row.get(0)?,row.get(1)?))).optional().map_err(sql_error)?;
        row.map(|(digest, bytes)| Ok((digest, decode(&bytes)?)))
            .transpose()
    }

    pub fn frontiers(&self) -> Result<BTreeMap<String, u64>> {
        let mut statement = self
            .connection
            .prepare("SELECT replica_id,counter FROM peer_frontiers")
            .map_err(sql_error)?;
        statement
            .query_map([], |row| Ok((row.get(0)?, unsigned(row, 1)?)))
            .map_err(sql_error)?
            .collect::<std::result::Result<BTreeMap<_, _>, _>>()
            .map_err(sql_error)
    }

    pub fn transaction_digest(&self, transaction: &RemoteTransaction) -> Result<Option<String>> {
        self.connection.query_row("SELECT digest FROM transactions WHERE transaction_id=?1 OR (replica_id=?2 AND counter=?3)",params![transaction.transaction_id,transaction.replica_id,integer(transaction.counter)?],|row|row.get(0)).optional().map_err(sql_error)
    }

    pub fn transactions(&self, after_sequence: u64) -> Result<Vec<RemoteTransaction>> {
        let mut statement = self
            .connection
            .prepare("SELECT body FROM transactions WHERE sequence>?1 ORDER BY sequence")
            .map_err(sql_error)?;
        let rows = statement
            .query_map(params![integer(after_sequence)?], |row| {
                row.get::<_, Vec<u8>>(0)
            })
            .map_err(sql_error)?;
        rows.map(|row| decode(&row.map_err(sql_error)?)).collect()
    }

    pub fn operation(&self, id: &str) -> Result<Option<Operation>> {
        let bytes: Option<Vec<u8>> = self
            .connection
            .query_row(
                "SELECT body FROM operations WHERE operation_id=?1",
                params![id],
                |row| row.get(0),
            )
            .optional()
            .map_err(sql_error)?;
        bytes.as_deref().map(decode).transpose()
    }

    pub fn commit(&mut self, commit: Commit<'_>) -> Result<DocumentMetadata> {
        let tx = commit.transaction;
        let digest = tx.digest()?;
        let next = commit
            .expected_sequence
            .checked_add(1)
            .ok_or_else(|| EngineError::new("resource_limit", "revision exhausted"))?;
        let title = commit.catalog.current_title();
        fault_boundary("before_transaction");
        let transaction = self
            .connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(sql_error)?;
        let meta_sequence: u64 = transaction
            .query_row(
                "SELECT sequence FROM document_meta WHERE singleton=1",
                [],
                |row| unsigned(row, 0),
            )
            .map_err(sql_error)?;
        if meta_sequence != commit.expected_sequence {
            return Err(EngineError::new(
                "stale_revision",
                "another writer committed before this candidate",
            ));
        }
        transaction.execute("INSERT INTO transactions(transaction_id,sequence,replica_id,counter,digest,body) VALUES(?1,?2,?3,?4,?5,?6)",params![tx.transaction_id,integer(next)?,tx.replica_id,integer(tx.counter)?,digest,encode(tx)?]).map_err(sql_error)?;
        let mut shard_operations: BTreeMap<String, Vec<&Operation>> = BTreeMap::new();
        for (ordinal, operation) in tx.operations.iter().enumerate() {
            let entity = operation.action.entity_id();
            transaction.execute("INSERT INTO operations(operation_id,entity_id,sequence,ordinal,body) VALUES(?1,?2,?3,?4,?5)",params![operation.id,entity,integer(next)?,ordinal as i64,encode(operation)?]).map_err(sql_error)?;
            let shard = if entity == "catalog" {
                "catalog".to_string()
            } else {
                commit
                    .nodes
                    .get(entity)
                    .and_then(NodeState::original_node)
                    .ok_or_else(|| {
                        EngineError::new("corrupt_state", "missing prepared node state")
                    })?
                    .home_shard
            };
            shard_operations.entry(shard).or_default().push(operation);
        }
        for (id, state) in commit.nodes {
            let original = state
                .original_node()
                .ok_or_else(|| EngineError::new("corrupt_state", "node has no creation"))?;
            let projected = state.project()?;
            let parent = projected
                .as_ref()
                .and_then(|node| node.parent_id.clone())
                .or_else(|| original.parent_id.clone());
            let deleted = projected.is_none();
            let projection = projection_bytes(projected)?;
            transaction.execute("INSERT INTO current_nodes(node_id,home_shard,parent_id,deleted,projection) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(node_id) DO UPDATE SET parent_id=excluded.parent_id,deleted=excluded.deleted,projection=excluded.projection",params![id,original.home_shard,parent,deleted,projection]).map_err(sql_error)?;
            transaction.execute("INSERT INTO entity_versions(entity_id,sequence,home_shard,parent_id,deleted,projection) VALUES(?1,?2,?3,?4,?5,?6)",params![id,integer(next)?,original.home_shard,parent,deleted,projection]).map_err(sql_error)?;
            transaction.execute("INSERT INTO node_routes(entity_id,sequence,home_shard,parent_id) VALUES(?1,?2,?3,?4)",params![id,integer(next)?,original.home_shard,parent]).map_err(sql_error)?;
        }
        for (shard, operations) in shard_operations {
            let bytes = encode(&operations)?;
            transaction
                .execute(
                    "INSERT OR IGNORE INTO shards(shard_id,kind) VALUES(?1,?2)",
                    params![
                        shard,
                        if shard == "catalog" {
                            "catalog"
                        } else {
                            "nodes"
                        }
                    ],
                )
                .map_err(sql_error)?;
            transaction.execute("INSERT INTO shard_updates(shard_id,transaction_id,body,digest,byte_length) VALUES(?1,?2,?3,?4,?5)",params![shard,tx.transaction_id,bytes,hex::encode(Sha256::digest(&bytes)),bytes.len() as i64]).map_err(sql_error)?;
        }
        fault_boundary("after_operations");
        transaction.execute("INSERT INTO peer_frontiers(replica_id,counter) VALUES(?1,?2) ON CONFLICT(replica_id) DO UPDATE SET counter=excluded.counter",params![tx.replica_id,integer(tx.counter)?]).map_err(sql_error)?;
        let max_counter = tx
            .operations
            .iter()
            .map(|op| op.stamp.counter)
            .max()
            .unwrap_or(0);
        if commit.local {
            transaction.execute("UPDATE document_meta SET title=?1,sequence=?2,transaction_counter=?3,operation_counter=?4,lamport=max(lamport,?5) WHERE singleton=1",params![title,integer(next)?,integer(tx.counter)?,integer(max_counter)?,integer(tx.lamport)?]).map_err(sql_error)?;
        } else {
            transaction.execute("UPDATE document_meta SET title=?1,sequence=?2,lamport=max(lamport,?3) WHERE singleton=1",params![title,integer(next)?,integer(tx.lamport)?]).map_err(sql_error)?;
        }
        if let Some(receipt) = commit.receipt {
            fault_boundary("before_receipt");
            transaction.execute("INSERT INTO operation_results(principal,epoch,operation_key,digest,result) VALUES(?1,?2,?3,?4,?5)",params![receipt.principal,tx.epoch,receipt.key,receipt.digest,encode(receipt.result)?]).map_err(sql_error)?;
        }
        transaction
            .execute(
                "DELETE FROM inbox_transfers WHERE transaction_id=?1",
                params![tx.transaction_id],
            )
            .map_err(sql_error)?;
        fault_boundary("before_commit");
        transaction.commit().map_err(sql_error)?;
        fault_boundary("after_commit");
        self.metadata()
    }

    pub fn stage_transaction(&mut self, transaction: &RemoteTransaction) -> Result<()> {
        transaction.validate()?;
        let digest = transaction.digest()?;
        let existing:Option<String>=self.connection.query_row("SELECT digest FROM inbox_transfers WHERE transaction_id=?1 OR (replica_id=?2 AND counter=?3)",params![transaction.transaction_id,transaction.replica_id,integer(transaction.counter)?],|row|row.get(0)).optional().map_err(sql_error)?;
        if let Some(existing) = existing {
            if existing == digest {
                return Ok(());
            }
            return Err(EngineError::new(
                "protocol_mismatch",
                "conflicting staged transaction identity",
            ));
        }
        let (count, total): (u64, u64) = self
            .connection
            .query_row(
                "SELECT count(*),coalesce(sum(length(body)),0) FROM inbox_transfers",
                [],
                |row| Ok((unsigned(row, 0)?, unsigned(row, 1)?)),
            )
            .map_err(sql_error)?;
        let bytes = encode(transaction)?;
        if count >= 256 || total + bytes.len() as u64 > 64 * 1024 * 1024 {
            return Err(EngineError::new(
                "resource_limit",
                "durable peer inbox is full",
            ));
        }
        self.connection.execute("INSERT INTO inbox_transfers(transaction_id,replica_id,counter,digest,body) VALUES(?1,?2,?3,?4,?5)",params![transaction.transaction_id,transaction.replica_id,integer(transaction.counter)?,digest,bytes]).map_err(sql_error)?;
        Ok(())
    }

    pub fn staged_transactions(&self) -> Result<Vec<RemoteTransaction>> {
        let mut statement = self
            .connection
            .prepare(
                "SELECT body FROM inbox_transfers WHERE state='staged' ORDER BY transaction_id",
            )
            .map_err(sql_error)?;
        let rows = statement
            .query_map([], |row| row.get::<_, Vec<u8>>(0))
            .map_err(sql_error)?;
        rows.map(|row| decode(&row.map_err(sql_error)?)).collect()
    }

    pub fn reject_staged(&self, id: &str, error: &EngineError) -> Result<()> {
        self.connection
            .execute(
                "UPDATE inbox_transfers SET state='rejected',error=?2 WHERE transaction_id=?1",
                params![id, encode(error)?],
            )
            .map_err(sql_error)?;
        Ok(())
    }

    pub fn stage_fragment(
        &mut self,
        header: &TransferHeader,
        index: usize,
        bytes: &[u8],
    ) -> Result<Option<Vec<Vec<u8>>>> {
        if header.profile != omc_protocol::CRDT_PROFILE
            || header.total_bytes > omc_protocol::MAX_SEMANTIC_BYTES
            || header.fragment_hashes.is_empty()
            || header.fragment_hashes.len() > 17
            || index >= header.fragment_hashes.len()
            || bytes.len() > omc_protocol::MAX_FRAGMENT_BYTES
            || hex::encode(Sha256::digest(bytes)) != header.fragment_hashes[index]
        {
            return Err(EngineError::invalid("invalid peer fragment"));
        }
        let header_bytes = encode(header)?;
        let previous: Option<Vec<u8>> = self
            .connection
            .query_row(
                "SELECT header FROM transfer_headers WHERE transfer_id=?1",
                params![header.transfer_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(sql_error)?;
        if previous.as_ref().is_some_and(|old| old != &header_bytes) {
            return Err(EngineError::new(
                "protocol_mismatch",
                "transfer manifest changed",
            ));
        }
        let total: u64 = self
            .connection
            .query_row(
                "SELECT coalesce(sum(length(body)),0) FROM inbox_fragments",
                [],
                |row| unsigned(row, 0),
            )
            .map_err(sql_error)?;
        if total + bytes.len() as u64 > 64 * 1024 * 1024 {
            return Err(EngineError::new("resource_limit", "fragment inbox is full"));
        }
        let transaction = self
            .connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(sql_error)?;
        transaction
            .execute(
                "INSERT OR IGNORE INTO transfer_headers(transfer_id,header) VALUES(?1,?2)",
                params![header.transfer_id, header_bytes],
            )
            .map_err(sql_error)?;
        transaction
            .execute(
                "INSERT OR IGNORE INTO inbox_fragments(transfer_id,ordinal,body) VALUES(?1,?2,?3)",
                params![header.transfer_id, index as i64, bytes],
            )
            .map_err(sql_error)?;
        transaction.commit().map_err(sql_error)?;
        let mut statement = self
            .connection
            .prepare("SELECT body FROM inbox_fragments WHERE transfer_id=?1 ORDER BY ordinal")
            .map_err(sql_error)?;
        let fragments = statement
            .query_map(params![header.transfer_id], |row| row.get::<_, Vec<u8>>(0))
            .map_err(sql_error)?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(sql_error)?;
        if fragments.len() == header.fragment_hashes.len() {
            Ok(Some(fragments))
        } else {
            Ok(None)
        }
    }

    pub fn finish_fragments(&mut self, id: &str) -> Result<()> {
        let transaction = self.connection.transaction().map_err(sql_error)?;
        transaction
            .execute(
                "DELETE FROM inbox_fragments WHERE transfer_id=?1",
                params![id],
            )
            .map_err(sql_error)?;
        transaction
            .execute(
                "DELETE FROM transfer_headers WHERE transfer_id=?1",
                params![id],
            )
            .map_err(sql_error)?;
        transaction.commit().map_err(sql_error)
    }

    pub fn checkpoint(&self) -> Result<()> {
        let (busy, _, _): (i64, i64, i64) = self
            .connection
            .query_row("PRAGMA wal_checkpoint(PASSIVE)", [], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?))
            })
            .map_err(sql_error)?;
        if busy != 0 {
            return Err(EngineError::new(
                "busy",
                "checkpoint is waiting for a reader",
            ));
        }
        Ok(())
    }

    pub fn sqlite_info(&self) -> Result<serde_json::Value> {
        let source: String = self
            .connection
            .query_row("SELECT sqlite_source_id()", [], |row| row.get(0))
            .map_err(sql_error)?;
        let mut statement = self
            .connection
            .prepare("PRAGMA compile_options")
            .map_err(sql_error)?;
        let options = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(sql_error)?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(sql_error)?;
        Ok(
            serde_json::json!({"version":rusqlite::version(),"sourceId":source,"compileOptions":options,"journalMode":"wal","synchronous":"full"}),
        )
    }
}

fn fault_boundary(_point: &str) {
    #[cfg(feature = "fault-injection")]
    if std::env::var("OMC_TEST_FAULT_POINT").ok().as_deref() == Some(_point) {
        if let Ok(path) = std::env::var("OMC_TEST_FAULT_READY") {
            if std::fs::write(path, _point).is_ok() {
                loop {
                    std::thread::park();
                }
            }
        }
    }
}

fn projection_bytes(node: Option<Node>) -> Result<Option<Vec<u8>>> {
    node.map(|mut node| {
        // Text items/history live in immutable operation rows; derived full strings are not copied into every version.
        if node.kind == omc_model::NodeKind::Text {
            node.properties.remove("text");
            node.properties.remove("textRuns");
        }
        encode(&node)
    })
    .transpose()
}

const SCHEMA: &str = r#"
CREATE TABLE document_meta(singleton INTEGER PRIMARY KEY CHECK(singleton=1),document_id TEXT NOT NULL,epoch TEXT NOT NULL,replica_id TEXT NOT NULL,title TEXT NOT NULL,sequence INTEGER NOT NULL CHECK(sequence>=0),transaction_counter INTEGER NOT NULL,operation_counter INTEGER NOT NULL,lamport INTEGER NOT NULL);
CREATE TABLE genesis(singleton INTEGER PRIMARY KEY CHECK(singleton=1),body BLOB NOT NULL);
CREATE TABLE catalog_seed(singleton INTEGER PRIMARY KEY CHECK(singleton=1),body BLOB NOT NULL);
CREATE TABLE node_seeds(node_id TEXT PRIMARY KEY,body BLOB NOT NULL);
CREATE TABLE shards(shard_id TEXT PRIMARY KEY,kind TEXT NOT NULL);
CREATE TABLE transactions(transaction_id TEXT PRIMARY KEY,sequence INTEGER UNIQUE NOT NULL,replica_id TEXT NOT NULL,counter INTEGER NOT NULL,digest TEXT NOT NULL,body BLOB NOT NULL,UNIQUE(replica_id,counter));
CREATE TABLE operations(operation_id TEXT PRIMARY KEY,entity_id TEXT NOT NULL,sequence INTEGER NOT NULL REFERENCES transactions(sequence),ordinal INTEGER NOT NULL,body BLOB NOT NULL);
CREATE INDEX operations_entity_cut ON operations(entity_id,sequence,ordinal);
CREATE TABLE current_nodes(node_id TEXT PRIMARY KEY,home_shard TEXT NOT NULL,parent_id TEXT,deleted INTEGER NOT NULL,projection BLOB);
CREATE INDEX current_nodes_parent ON current_nodes(parent_id,deleted);
CREATE TABLE entity_versions(entity_id TEXT NOT NULL,sequence INTEGER NOT NULL,home_shard TEXT NOT NULL,parent_id TEXT,deleted INTEGER NOT NULL,projection BLOB,PRIMARY KEY(entity_id,sequence));
CREATE TABLE node_routes(entity_id TEXT NOT NULL,sequence INTEGER NOT NULL,home_shard TEXT NOT NULL,parent_id TEXT,PRIMARY KEY(entity_id,sequence));
CREATE INDEX routes_parent ON node_routes(parent_id,sequence);
CREATE TABLE shard_updates(shard_id TEXT NOT NULL REFERENCES shards(shard_id),transaction_id TEXT NOT NULL REFERENCES transactions(transaction_id),body BLOB NOT NULL,digest TEXT NOT NULL,byte_length INTEGER NOT NULL,PRIMARY KEY(shard_id,transaction_id));
CREATE TABLE operation_results(principal TEXT NOT NULL,epoch TEXT NOT NULL,operation_key TEXT NOT NULL,digest TEXT NOT NULL,result BLOB NOT NULL,PRIMARY KEY(principal,epoch,operation_key));
CREATE TABLE peer_frontiers(replica_id TEXT PRIMARY KEY,counter INTEGER NOT NULL);
CREATE TABLE inbox_transfers(transaction_id TEXT PRIMARY KEY,replica_id TEXT NOT NULL,counter INTEGER NOT NULL,digest TEXT NOT NULL,body BLOB NOT NULL,state TEXT NOT NULL DEFAULT 'staged',error BLOB,UNIQUE(replica_id,counter));
CREATE TABLE transfer_headers(transfer_id TEXT PRIMARY KEY,header BLOB NOT NULL);
CREATE TABLE inbox_fragments(transfer_id TEXT NOT NULL REFERENCES transfer_headers(transfer_id),ordinal INTEGER NOT NULL,body BLOB NOT NULL,PRIMARY KEY(transfer_id,ordinal));
"#;
