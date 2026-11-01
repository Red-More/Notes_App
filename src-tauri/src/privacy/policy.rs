//! Declared sensitivity labels and the effective-level policy.
//!
//! Effective level = the stricter of (declared, detected). Declared levels come
//! from the longest matching path prefix; an unlabelled path defaults to S1 so
//! that "forgot to label" can never silently become "public".

use rusqlite::{params, Connection};
use serde::Serialize;

use super::entity::{self, EntityValue};
use crate::agent::secrets::SecretStore;
use crate::vfs::cap_gate;
use crate::vfs::error::ToolError;

/// Conservative defaults seeded once at schema v11.
/// Contacts and diaries are S0; notes, todos and schedules are S1.
pub const DEFAULT_LABELS: [(&str, i64); 5] = [
    ("/life/contacts", 0),
    ("/life/diary", 0),
    ("/life/notes", 1),
    ("/life/todos", 1),
    ("/life/schedule", 1),
];

/// Level of an unlabelled path. Fail-closed: never assume "public".
pub const DEFAULT_LEVEL: Level = Level::S1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Level {
    S0 = 0,
    S1 = 1,
    S2 = 2,
}

impl Level {
    pub fn from_i64(value: i64) -> Option<Self> {
        match value {
            0 => Some(Self::S0),
            1 => Some(Self::S1),
            2 => Some(Self::S2),
            _ => None,
        }
    }

    pub fn as_i64(self) -> i64 {
        self as i64
    }

    /// Effective level combines sources by picking the stricter one.
    /// `S2` is the least restrictive value, so "stricter" is the minimum.
    pub fn most_sensitive(self, other: Self) -> Self {
        self.min(other)
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Label {
    pub path_prefix: String,
    pub level: i64,
    pub source: String,
    pub updated_at: String,
}

/// Seed the built-in labels; `INSERT OR IGNORE` keeps user edits on re-run.
pub fn seed_defaults(conn: &Connection) -> rusqlite::Result<()> {
    for (prefix, level) in DEFAULT_LABELS {
        conn.execute(
            "INSERT OR IGNORE INTO sensitivity_labels (path_prefix, level, source, updated_at)
             VALUES (?1, ?2, 'default', datetime('now','localtime'))",
            params![prefix, level],
        )?;
    }
    Ok(())
}

pub fn list_labels(conn: &Connection) -> Result<Vec<Label>, ToolError> {
    let mut stmt = conn.prepare(
        "SELECT path_prefix, level, source, updated_at
         FROM sensitivity_labels ORDER BY level, path_prefix",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(Label {
            path_prefix: r.get(0)?,
            level: r.get(1)?,
            source: r.get(2)?,
            updated_at: r.get(3)?,
        })
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

/// Upsert one label. The path must stay inside `/life`; level must be 0..=2.
pub fn set_label(conn: &Connection, path: &str, level: i64) -> Result<Label, ToolError> {
    let path = cap_gate::normalize_path(path)?;
    if Level::from_i64(level).is_none() {
        return Err(ToolError::invalid("分级只能是 0（S0）、1（S1）或 2（S2）"));
    }
    conn.execute(
        "INSERT INTO sensitivity_labels (path_prefix, level, source, updated_at)
         VALUES (?1, ?2, 'user', datetime('now','localtime'))
         ON CONFLICT(path_prefix) DO UPDATE SET
             level = excluded.level,
             source = 'user',
             updated_at = excluded.updated_at",
        params![path, level],
    )?;
    read_label(conn, &path)
}

/// Built-in defaults cannot be deleted: removing them would silently downgrade
/// S0 folders to the S1 fallback. Users can still change their level.
pub fn delete_label(conn: &Connection, path: &str) -> Result<(), ToolError> {
    let path = cap_gate::normalize_path(path)?;
    let source: Option<String> = conn
        .query_row(
            "SELECT source FROM sensitivity_labels WHERE path_prefix = ?1",
            params![path],
            |r| r.get(0),
        )
        .ok();
    let Some(source) = source else {
        return Err(ToolError::invalid("该路径没有分级记录"));
    };
    if source == "default" {
        return Err(ToolError::invalid("内置分级不可删除，只能修改级别"));
    }
    conn.execute(
        "DELETE FROM sensitivity_labels WHERE path_prefix = ?1",
        params![path],
    )?;
    Ok(())
}

fn read_label(conn: &Connection, path: &str) -> Result<Label, ToolError> {
    Ok(conn.query_row(
        "SELECT path_prefix, level, source, updated_at
         FROM sensitivity_labels WHERE path_prefix = ?1",
        params![path],
        |r| {
            Ok(Label {
                path_prefix: r.get(0)?,
                level: r.get(1)?,
                source: r.get(2)?,
                updated_at: r.get(3)?,
            })
        },
    )?)
}

/// Immutable per-request snapshot: labels plus decrypted EDM plaintext.
/// Loaded under the VFS lock, then used without touching the database.
pub struct Snapshot {
    labels: Vec<Label>,
    pub entities: Vec<EntityValue>,
}

impl Snapshot {
    pub fn load(conn: &Connection, secrets: &SecretStore) -> Result<Self, ToolError> {
        Ok(Self {
            labels: list_labels(conn)?,
            entities: entity::load_values(secrets)?,
        })
    }

    /// Longest matching prefix wins; a boundary check keeps `/life/note`
    /// from matching `/life/notes`.
    pub fn declared_level(&self, path: &str) -> Level {
        let mut best: Option<(usize, Level)> = None;
        for label in &self.labels {
            if !prefix_matches(&label.path_prefix, path) {
                continue;
            }
            let Some(level) = Level::from_i64(label.level) else {
                continue;
            };
            let len = label.path_prefix.chars().count();
            if best.is_none_or(|(best_len, _)| len > best_len) {
                best = Some((len, level));
            }
        }
        best.map(|(_, level)| level).unwrap_or(DEFAULT_LEVEL)
    }
}

fn prefix_matches(prefix: &str, path: &str) -> bool {
    if path == prefix {
        return true;
    }
    match path.strip_prefix(prefix) {
        Some(rest) => rest.starts_with('/'),
        None => false,
    }
}
