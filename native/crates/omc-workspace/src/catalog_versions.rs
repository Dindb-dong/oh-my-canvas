use super::catalog::{Catalog, sql_error};
use omc_protocol::{EngineError, Result};
use rusqlite::{OptionalExtension, params};
use serde_json::{Value, json};

const VERSION_BYTES: usize = 16 * 1024 * 1024;
const DOCUMENT_HISTORY_BYTES: i64 = 64 * 1024 * 1024;

pub(crate) const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS document_versions(
 number INTEGER PRIMARY KEY,
 id TEXT NOT NULL UNIQUE, document TEXT NOT NULL REFERENCES documents(id),
 name TEXT NOT NULL, description TEXT NOT NULL, created INTEGER NOT NULL,
 automatic INTEGER NOT NULL, digest TEXT NOT NULL, content BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS document_versions_document ON document_versions(document, number);";

impl Catalog {
    pub fn versions(&self, document: &str) -> Result<Vec<Value>> {
        let mut query = self.connection.prepare("SELECT id,name,description,created,automatic FROM document_versions WHERE document=?1 ORDER BY number").map_err(sql_error)?;
        let rows = query.query_map([document], |row| {
            Ok(json!({"id":row.get::<_,String>(0)?,"name":row.get::<_,String>(1)?,"description":row.get::<_,String>(2)?,"time":row.get::<_,i64>(3)?,"auto":row.get::<_,bool>(4)?}))
        }).map_err(sql_error)?;
        rows.enumerate()
            .map(|(index, row)| {
                let mut value = row.map_err(sql_error)?;
                value["index"] = json!(index);
                Ok(value)
            })
            .collect()
    }

    pub fn save_version(
        &mut self,
        document: &str,
        name: &str,
        description: &str,
        bytes: &[u8],
        digest: &str,
        automatic: bool,
    ) -> Result<Option<Value>> {
        if bytes.len() > VERSION_BYTES {
            return Err(EngineError::new(
                "resource_limit",
                "a saved version exceeds 16 MiB",
            ));
        }
        let transaction = self.connection.transaction().map_err(sql_error)?;
        if automatic {
            let last: Option<String> = transaction.query_row("SELECT digest FROM document_versions WHERE document=?1 ORDER BY number DESC LIMIT 1",[document],|row|row.get(0)).optional().map_err(sql_error)?;
            if last.as_deref() == Some(digest) {
                return Ok(None);
            }
            transaction.execute("DELETE FROM document_versions WHERE number IN (SELECT number FROM document_versions WHERE document=?1 AND automatic ORDER BY number DESC LIMIT -1 OFFSET 19)",[document]).map_err(sql_error)?;
        }
        let size: i64 = transaction
            .query_row(
                "SELECT COALESCE(SUM(length(content)),0) FROM document_versions WHERE document=?1",
                [document],
                |row| row.get(0),
            )
            .map_err(sql_error)?;
        if size.saturating_add(bytes.len() as i64) > DOCUMENT_HISTORY_BYTES {
            return Err(EngineError::new(
                "resource_limit",
                "this document's version history exceeds 64 MiB",
            ));
        }
        let id = uuid::Uuid::new_v4().to_string();
        let time = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64;
        let index: i64 = transaction
            .query_row(
                "SELECT COUNT(*) FROM document_versions WHERE document=?1",
                [document],
                |row| row.get(0),
            )
            .map_err(sql_error)?;
        transaction.execute("INSERT INTO document_versions(id,document,name,description,created,automatic,digest,content) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",
            params![id,document,name,description,time,automatic,digest,bytes]).map_err(sql_error)?;
        transaction.commit().map_err(sql_error)?;
        Ok(Some(
            json!({"id":id,"index":index,"name":name,"description":description,"time":time,"auto":automatic}),
        ))
    }

    pub fn rename_version(
        &self,
        document: &str,
        id: &str,
        name: &str,
        description: Option<&str>,
    ) -> Result<()> {
        self.connection.execute("UPDATE document_versions SET name=?3,description=COALESCE(?4,description),automatic=0 WHERE document=?1 AND id=?2",
            params![document,id,name,description]).map_err(sql_error)?;
        Ok(())
    }
    pub fn delete_version(&self, document: &str, id: &str) -> Result<()> {
        self.connection
            .execute(
                "DELETE FROM document_versions WHERE document=?1 AND id=?2",
                [document, id],
            )
            .map_err(sql_error)?;
        Ok(())
    }
    pub fn version_bytes(&self, document: &str, id: &str) -> Result<Vec<u8>> {
        self.connection
            .query_row(
                "SELECT content FROM document_versions WHERE document=?1 AND id=?2",
                [document, id],
                |row| row.get(0),
            )
            .optional()
            .map_err(sql_error)?
            .ok_or_else(|| EngineError::new("not_found", "version was not found"))
    }
}
