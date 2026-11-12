use omc_protocol::{EngineError, Result};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};
use std::{
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};

pub struct Catalog {
    pub connection: Connection,
    pub epoch: String,
}
pub fn sql_error(error: rusqlite::Error) -> EngineError {
    EngineError::new("storage_unavailable", error.to_string())
}
impl Catalog {
    pub fn open(path: &Path) -> Result<Self> {
        let connection = Connection::open(path).map_err(sql_error)?;
        omc_storage::verify_sqlite(&connection)?;
        connection.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA wal_autocheckpoint=0; PRAGMA busy_timeout=50;
         CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
         CREATE TABLE IF NOT EXISTS documents(id TEXT PRIMARY KEY,title TEXT NOT NULL,epoch TEXT NOT NULL,sequence TEXT NOT NULL,archived INTEGER NOT NULL DEFAULT 0,starred INTEGER NOT NULL DEFAULT 0,folder_id TEXT,trashed INTEGER NOT NULL DEFAULT 0,updated_ms INTEGER NOT NULL DEFAULT 0);
         CREATE TABLE IF NOT EXISTS folders(id TEXT PRIMARY KEY,title TEXT NOT NULL,parent_id TEXT REFERENCES folders(id));
         CREATE TABLE IF NOT EXISTS principals(id TEXT PRIMARY KEY,credential_hash TEXT NOT NULL,scope TEXT NOT NULL,revoked INTEGER NOT NULL DEFAULT 0);
         CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,kind TEXT NOT NULL,state TEXT NOT NULL,details TEXT NOT NULL);
         CREATE TABLE IF NOT EXISTS adapter_intents(principal TEXT NOT NULL,document_id TEXT NOT NULL,epoch TEXT NOT NULL,operation_key TEXT NOT NULL,request_digest TEXT NOT NULL,envelope TEXT NOT NULL,output TEXT NOT NULL,integrity_digest TEXT NOT NULL,PRIMARY KEY(principal,document_id,epoch,operation_key));
         UPDATE jobs SET state='interrupted' WHERE state IN ('queued','running','cancelling');").map_err(sql_error)?;
        let has_update_time = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM pragma_table_info('documents') WHERE name='updated_ms')",
            [], |row| row.get::<_, bool>(0),
        ).map_err(sql_error)?;
        if !has_update_time {
            connection
                .execute_batch(
                    "ALTER TABLE documents ADD COLUMN updated_ms INTEGER NOT NULL DEFAULT 0;",
                )
                .map_err(sql_error)?;
        }
        connection
            .execute_batch(super::catalog_versions::SCHEMA)
            .map_err(sql_error)?;
        connection
            .execute_batch(super::catalog_branches::SCHEMA)
            .map_err(sql_error)?;
        let mode: String = connection
            .query_row("PRAGMA journal_mode", [], |row| row.get(0))
            .map_err(sql_error)?;
        let sync: i64 = connection
            .query_row("PRAGMA synchronous", [], |row| row.get(0))
            .map_err(sql_error)?;
        if mode != "wal" || sync != 2 {
            return Err(EngineError::new(
                "storage_unavailable",
                "workspace requires SQLite WAL/FULL",
            ));
        }
        let epoch: Option<String> = connection
            .query_row("SELECT value FROM meta WHERE key='epoch'", [], |r| r.get(0))
            .optional()
            .map_err(sql_error)?;
        let epoch = match epoch {
            Some(e) => e,
            None => {
                let e = uuid::Uuid::new_v4().to_string();
                connection
                    .execute("INSERT INTO meta VALUES('epoch',?1)", [&e])
                    .map_err(sql_error)?;
                e
            }
        };
        Ok(Self { connection, epoch })
    }
    pub fn record(&self, id: &str, meta: &Value) -> Result<()> {
        self.record_at(id, meta, clock_ms(SystemTime::now()), true)
    }
    pub(super) fn document_stamp(database: &Path) -> i64 {
        [
            database.to_owned(),
            database.with_file_name("document.sqlite-wal"),
        ]
        .iter()
        .filter_map(|path| std::fs::metadata(path).ok()?.modified().ok())
        .max()
        .map_or(0, clock_ms)
    }
    pub(super) fn record_discovered(&self, id: &str, meta: &Value, updated: i64) -> Result<()> {
        self.record_at(id, meta, updated, false)
    }
    fn record_at(&self, id: &str, meta: &Value, updated: i64, modified: bool) -> Result<()> {
        let title = meta["title"].as_str().unwrap_or("Untitled");
        let epoch = meta["epoch"]
            .as_str()
            .ok_or_else(|| EngineError::new("corrupt_state", "document has no epoch"))?;
        let sequence = meta["sequence"]
            .as_str()
            .map(str::to_owned)
            .unwrap_or_else(|| meta["sequence"].to_string());
        self.connection.execute(
            "INSERT INTO documents(id,title,epoch,sequence,updated_ms) VALUES(?1,?2,?3,?4,?5)
             ON CONFLICT(id) DO UPDATE SET title=excluded.title,epoch=excluded.epoch,sequence=excluded.sequence,
             updated_ms=CASE WHEN documents.updated_ms=0 OR documents.epoch<>excluded.epoch
                    OR documents.sequence<>excluded.sequence OR ?6
                 THEN max(documents.updated_ms,excluded.updated_ms) ELSE documents.updated_ms END",
            params![id, title, epoch, sequence, updated, modified],
        ).map_err(sql_error)?;
        Ok(())
    }
    pub(super) fn touch(&self, id: &str, revision: &Value) -> Result<()> {
        let Some(sequence) = revision["sequence"].as_str() else {
            return Ok(());
        };
        self.connection
            .execute(
                "UPDATE documents SET updated_ms=max(updated_ms,?2),sequence=?3
                 WHERE id=?1 AND epoch=?4 AND (length(sequence)<length(?3)
                    OR (length(sequence)=length(?3) AND sequence<?3))",
                params![
                    id,
                    clock_ms(SystemTime::now()),
                    sequence,
                    revision["epoch"].as_str()
                ],
            )
            .map_err(sql_error)?;
        Ok(())
    }
    pub fn list(&self, include_archived: bool) -> Result<Vec<Value>> {
        let mut statement = self
            .connection
            .prepare(
                "SELECT id,title,epoch,sequence,archived,starred,folder_id,updated_ms,
                strftime('%Y-%m-%dT%H:%M:%fZ',updated_ms/1000.0,'unixepoch')
             FROM documents WHERE trashed=0 AND (?1 OR archived=0) ORDER BY lower(title),id",
            )
            .map_err(sql_error)?;
        let rows = statement.query_map([include_archived], |r| Ok(json!({
            "id":r.get::<_,String>(0)?,"title":r.get::<_,String>(1)?,"epoch":r.get::<_,String>(2)?,
            "sequence":r.get::<_,String>(3)?,"archived":r.get::<_,bool>(4)?,"starred":r.get::<_,bool>(5)?,
            "folderId":r.get::<_,Option<String>>(6)?,"updatedAtMs":r.get::<_,i64>(7)?,
            "updatedAt":r.get::<_,Option<String>>(8)?,
        }))).map_err(sql_error)?;
        rows.collect::<std::result::Result<Vec<_>, _>>()
            .map_err(sql_error)
    }
    pub fn exists(&self, id: &str) -> Result<bool> {
        self.connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM documents WHERE id=?1 AND trashed=0)",
                [id],
                |r| r.get(0),
            )
            .map_err(sql_error)
    }
    pub fn preference(&self) -> Result<Value> {
        let data: Option<String> = self
            .connection
            .query_row("SELECT value FROM meta WHERE key='preferences'", [], |r| {
                r.get(0)
            })
            .optional()
            .map_err(sql_error)?;
        Ok(data
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_else(|| json!({"name":"Local designer","view":"grid"})))
    }
    pub fn set_preference(&self, value: &Value) -> Result<()> {
        self.connection.execute("INSERT INTO meta VALUES('preferences',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",[value.to_string()]).map_err(sql_error)?;
        Ok(())
    }
    pub fn organization(&mut self, args: &Value) -> Result<Value> {
        if args["targetEpoch"].as_str() != Some(&self.epoch) {
            return Err(EngineError::new(
                "epoch_mismatch",
                "workspace generation required",
            ));
        }
        match args["action"].as_str().unwrap_or("") {
            "create_folder" => {
                let title = args["title"]
                    .as_str()
                    .filter(|s| !s.trim().is_empty() && s.len() <= 240)
                    .ok_or_else(|| EngineError::invalid("folder title required"))?;
                let id = omc_model::new_id("folder");
                let parent = args["parentId"].as_str();
                self.connection
                    .execute(
                        "INSERT INTO folders VALUES(?1,?2,?3)",
                        params![id, title, parent],
                    )
                    .map_err(sql_error)?;
                Ok(json!({"id":id,"title":title,"parentId":parent}))
            }
            "rename_folder" => {
                let id = string(args, "id")?;
                let title = string(args, "title")?;
                if title.trim().is_empty() || title.len() > 240 {
                    return Err(EngineError::invalid("invalid folder title"));
                }
                let n = self
                    .connection
                    .execute(
                        "UPDATE folders SET title=?2 WHERE id=?1",
                        params![id, title],
                    )
                    .map_err(sql_error)?;
                if n == 0 {
                    return Err(EngineError::invalid("folder not found"));
                }
                Ok(json!({"id":id,"title":title}))
            }
            "move_document" => {
                let id = string(args, "documentId")?;
                let folder = args["folderId"].as_str();
                if let Some(folder) = folder {
                    let exists: bool = self
                        .connection
                        .query_row(
                            "SELECT EXISTS(SELECT 1 FROM folders WHERE id=?1)",
                            [folder],
                            |r| r.get(0),
                        )
                        .map_err(sql_error)?;
                    if !exists {
                        return Err(EngineError::invalid("folder not found"));
                    }
                }
                let n = self
                    .connection
                    .execute(
                        "UPDATE documents SET folder_id=?2 WHERE id=?1 AND trashed=0",
                        params![id, folder],
                    )
                    .map_err(sql_error)?;
                if n == 0 {
                    return Err(EngineError::invalid("document not found"));
                }
                Ok(json!({"documentId":id,"folderId":folder}))
            }
            "archive" | "restore" => {
                let id = string(args, "documentId")?;
                let archived = args["action"] == "archive";
                let n = self
                    .connection
                    .execute(
                        "UPDATE documents SET archived=?2 WHERE id=?1 AND trashed=0",
                        params![id, archived],
                    )
                    .map_err(sql_error)?;
                if n == 0 {
                    return Err(EngineError::invalid("document not found"));
                }
                Ok(json!({"documentId":id,"archived":archived}))
            }
            "delete_folder" => {
                let id = string(args, "id")?;
                let occupied:bool=self.connection.query_row("SELECT EXISTS(SELECT 1 FROM folders WHERE parent_id=?1 UNION ALL SELECT 1 FROM documents WHERE folder_id=?1)",[id],|r|r.get(0)).map_err(sql_error)?;
                if occupied {
                    return Err(EngineError::new(
                        "conflict",
                        "move folder contents before deleting",
                    ));
                }
                self.connection
                    .execute("DELETE FROM folders WHERE id=?1", [id])
                    .map_err(sql_error)?;
                Ok(json!({"deleted":true}))
            }
            _ => Err(EngineError::invalid("unknown organization action")),
        }
    }
    pub fn folders(&self) -> Result<Vec<Value>> {
        let mut stmt = self
            .connection
            .prepare("SELECT id,title,parent_id FROM folders ORDER BY title,id")
            .map_err(sql_error)?;
        stmt.query_map([],|r|Ok(json!({"id":r.get::<_,String>(0)?,"title":r.get::<_,String>(1)?,"parentId":r.get::<_,Option<String>>(2)?}))).map_err(sql_error)?.collect::<std::result::Result<Vec<_>,_>>().map_err(sql_error)
    }
}
fn string<'a>(v: &'a Value, k: &str) -> Result<&'a str> {
    v[k].as_str()
        .ok_or_else(|| EngineError::invalid(format!("{k} required")))
}

fn clock_ms(time: SystemTime) -> i64 {
    time.duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|duration| i64::try_from(duration.as_millis()).ok())
        .unwrap_or_default()
}
