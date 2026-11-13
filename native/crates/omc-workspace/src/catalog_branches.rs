use super::catalog::{Catalog, sql_error};
use omc_model::DocumentContent;
use omc_protocol::{EngineError, Result};
use rusqlite::{OptionalExtension, params};
use serde::Serialize;

const BRANCH_BYTES: usize = 16 * 1024 * 1024;
const MAX_BRANCHES_PER_DOCUMENT: i64 = 32;

pub(crate) const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS document_branches(
 id TEXT PRIMARY KEY, main TEXT NOT NULL REFERENCES documents(id),
 document TEXT NOT NULL UNIQUE REFERENCES documents(id), owner TEXT NOT NULL,
 name TEXT NOT NULL, time INTEGER NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('active','merged','archived')),
 generation INTEGER NOT NULL DEFAULT 0, base BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS document_branches_main ON document_branches(main, owner, time);";

#[derive(Debug, Serialize)]
pub struct Branch {
    pub id: String,
    pub name: String,
    pub time: i64,
    pub state: String,
    #[serde(skip)]
    pub main: String,
    #[serde(skip)]
    pub document: String,
    #[serde(skip)]
    pub generation: i64,
}

fn summary(row: &rusqlite::Row<'_>) -> rusqlite::Result<Branch> {
    Ok(Branch {
        id: row.get(0)?,
        name: row.get(1)?,
        time: row.get(2)?,
        state: row.get(3)?,
        main: row.get(4)?,
        document: row.get(5)?,
        generation: row.get(6)?,
    })
}

fn encode(base: &DocumentContent) -> Result<Vec<u8>> {
    let bytes = serde_json::to_vec(base)
        .map_err(|error| EngineError::new("storage_unavailable", error.to_string()))?;
    if bytes.len() > BRANCH_BYTES {
        return Err(EngineError::new(
            "resource_limit",
            "branch base exceeds 16 MiB",
        ));
    }
    Ok(bytes)
}

impl Catalog {
    pub fn branches(&self, main: &str, owner: &str) -> Result<Vec<Branch>> {
        let mut query = self
            .connection
            .prepare(
                "SELECT id,name,time,state,main,document,generation FROM document_branches
             WHERE main=?1 AND owner=?2 ORDER BY time,rowid",
            )
            .map_err(sql_error)?;
        let rows = query
            .query_map(params![main, owner], summary)
            .map_err(sql_error)?;
        rows.collect::<std::result::Result<Vec<_>, _>>()
            .map_err(sql_error)
    }

    pub fn branch_for_document(&self, document: &str, owner: &str) -> Result<Option<Branch>> {
        self.connection
            .query_row(
                "SELECT id,name,time,state,main,document,generation FROM document_branches
             WHERE document=?1 AND owner=?2",
                params![document, owner],
                summary,
            )
            .optional()
            .map_err(sql_error)
    }

    pub fn check_branch_capacity(&self, main: &str, base: &DocumentContent) -> Result<()> {
        encode(base)?;
        let count: i64 = self
            .connection
            .query_row(
                "SELECT COUNT(*) FROM document_branches WHERE main=?1",
                [main],
                |row| row.get(0),
            )
            .map_err(sql_error)?;
        if count >= MAX_BRANCHES_PER_DOCUMENT {
            return Err(EngineError::new(
                "resource_limit",
                "document branch limit reached",
            ));
        }
        Ok(())
    }

    pub fn create_branch(
        &mut self,
        main: &str,
        document: &str,
        owner: &str,
        name: &str,
        base: &DocumentContent,
    ) -> Result<Branch> {
        let base = encode(base)?;
        let transaction = self.connection.transaction().map_err(sql_error)?;
        let count: i64 = transaction
            .query_row(
                "SELECT COUNT(*) FROM document_branches WHERE main=?1",
                [main],
                |row| row.get(0),
            )
            .map_err(sql_error)?;
        if count >= MAX_BRANCHES_PER_DOCUMENT {
            return Err(EngineError::new(
                "resource_limit",
                "document branch limit reached",
            ));
        }
        let id = uuid::Uuid::new_v4().to_string();
        let time = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64;
        transaction
            .execute(
                "INSERT INTO document_branches(id,main,document,owner,name,time,state,base)
             VALUES(?1,?2,?3,?4,?5,?6,'active',?7)",
                params![id, main, document, owner, name, time, base],
            )
            .map_err(sql_error)?;
        transaction.commit().map_err(sql_error)?;
        Ok(Branch {
            id,
            name: name.into(),
            time,
            state: "active".into(),
            main: main.into(),
            document: document.into(),
            generation: 0,
        })
    }

    pub fn branch_base(&self, branch: &Branch) -> Result<DocumentContent> {
        let content: Vec<u8> = self
            .connection
            .query_row(
                "SELECT base FROM document_branches WHERE id=?1 AND generation=?2",
                params![branch.id, branch.generation],
                |row| row.get(0),
            )
            .optional()
            .map_err(sql_error)?
            .ok_or_else(|| EngineError::new("conflict", "branch changed during the request"))?;
        serde_json::from_slice(&content)
            .map_err(|error| EngineError::new("corrupt_state", error.to_string()))
    }

    pub fn advance_branch(
        &self,
        branch: &Branch,
        state: &str,
        base: Option<&DocumentContent>,
    ) -> Result<()> {
        let base = base.map(encode).transpose()?;
        let rows = self
            .connection
            .execute(
                "UPDATE document_branches SET state=?3,base=COALESCE(?4,base),
             generation=generation+1 WHERE id=?1 AND generation=?2",
                params![branch.id, branch.generation, state, base],
            )
            .map_err(sql_error)?;
        if rows != 1 {
            return Err(EngineError::new(
                "conflict",
                "branch changed during the request",
            ));
        }
        Ok(())
    }
}
