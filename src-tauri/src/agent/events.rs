//! Persisted boundary events for one run.
//!
//! `seq` is monotonic per run. Token-level deltas are broadcast live only; a
//! reconnecting client replays these rows with `seq > after_seq`, so it can
//! rebuild run state without replaying every token.

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::vfs::error::ToolError;

pub const STATE: &str = "state";
pub const ASSISTANT: &str = "assistant";
/// One persisted `role=tool` row; payload is the full message.
pub const TOOL: &str = "tool";
pub const ERROR: &str = "error";
pub const END: &str = "end";

/// One event on the run's timeline; `payload` is event-kind specific JSON.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunEvent {
    pub run_id: i64,
    pub seq: i64,
    pub kind: String,
    pub payload: Value,
}

impl RunEvent {
    pub fn new(run_id: i64, seq: i64, kind: &str, payload: Value) -> Self {
        Self {
            run_id,
            seq,
            kind: kind.to_string(),
            payload,
        }
    }
}

/// Highest persisted seq; the in-memory counter continues from here.
pub fn max_seq(conn: &Connection, run_id: i64) -> Result<i64, ToolError> {
    let value: i64 = conn.query_row(
        "SELECT COALESCE(MAX(seq), 0) FROM agent_events WHERE run_id = ?1",
        params![run_id],
        |row| row.get(0),
    )?;
    Ok(value)
}

/// Append one boundary event. Duplicate `(run_id, seq)` is a programming error.
pub fn append(conn: &Connection, event: &RunEvent) -> Result<(), ToolError> {
    let at: String = conn.query_row("SELECT datetime('now','localtime')", [], |row| row.get(0))?;
    conn.execute(
        "INSERT INTO agent_events (run_id, seq, kind, payload, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![
            event.run_id,
            event.seq,
            event.kind,
            event.payload.to_string(),
            at
        ],
    )?;
    Ok(())
}

/// Every persisted event after `after_seq`, oldest first.
pub fn replay(conn: &Connection, run_id: i64, after_seq: i64) -> Result<Vec<RunEvent>, ToolError> {
    let mut stmt = conn.prepare(
        "SELECT run_id, seq, kind, payload FROM agent_events
         WHERE run_id = ?1 AND seq > ?2 ORDER BY seq ASC",
    )?;
    let rows = stmt.query_map(params![run_id, after_seq], |row| {
        let payload: String = row.get(3)?;
        Ok(RunEvent {
            run_id: row.get(0)?,
            seq: row.get(1)?,
            kind: row.get(2)?,
            payload: serde_json::from_str(&payload).unwrap_or(Value::Null),
        })
    })?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}
