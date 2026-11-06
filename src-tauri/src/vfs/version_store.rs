//! Persistent version chain: one baseline body per document plus a unified
//! diff for every later revision.
//!
//! Chain invariant: `content(rev) = apply(diff(rev), content(rev-1))`. Every
//! append computes its diff against the latest *recorded* version, never
//! against an autosaved head, so autosave edits never invalidate history.

use rusqlite::{params, Connection, OptionalExtension};

use super::error::ToolError;
use super::patch;

pub const KIND_SNAPSHOT: &str = "snapshot";
pub const KIND_RESTORE: &str = "restore";
pub const KIND_AGENT: &str = "agent";

/// Store the immutable baseline body of a new document. The baseline is also
/// the version row shown as `rev 1` in the history panel.
pub fn record_baseline(
    conn: &Connection,
    inode: i64,
    content: &str,
    title: &str,
    created_at: &str,
) -> Result<(), ToolError> {
    conn.execute(
        "INSERT INTO version_bases (inode, content, created_at) VALUES (?1, ?2, ?3)",
        params![inode, content, created_at],
    )?;
    conn.execute(
        "INSERT INTO version_meta
             (inode, rev, title, label, label_description, is_manual, kind, created_at)
         VALUES (?1, 1, ?2, NULL, NULL, 0, 'baseline', ?3)",
        params![inode, title, created_at],
    )?;
    Ok(())
}

/// Highest revision that still has a ledger row. Autosaved head revisions are
/// not recorded here, so this is the parent of the next diff.
pub fn latest_rev(conn: &Connection, inode: i64) -> Result<Option<i64>, ToolError> {
    let rev: Option<i64> = conn.query_row(
        "SELECT MAX(rev) FROM version_meta WHERE inode = ?1",
        params![inode],
        |row| row.get(0),
    )?;
    Ok(rev)
}

/// Rebuild the body of `upto_rev` from the baseline by replaying every
/// recorded diff up to that revision.
pub fn replay(conn: &Connection, inode: i64, upto_rev: i64) -> Result<String, ToolError> {
    let Some(mut content) = baseline_content(conn, inode)? else {
        return Err(ToolError::Storage {
            message: format!("inode {inode} 缺少版本基线，无法回放历史"),
        });
    };

    let mut statement = conn.prepare(
        "SELECT d.rev, d.diff
         FROM version_diffs d
         JOIN version_meta v ON v.inode = d.inode AND v.rev = d.rev
         WHERE d.inode = ?1 AND d.rev <= ?2
         ORDER BY d.rev ASC",
    )?;
    let mut rows = statement.query(params![inode, upto_rev])?;
    while let Some(row) = rows.next()? {
        let rev: i64 = row.get(0)?;
        let diff: String = row.get(1)?;
        content = patch::apply_unified(&content, &diff).ok_or_else(|| ToolError::Storage {
            message: format!("inode {inode} rev {rev} 的 diff 无法回放"),
        })?;
    }
    Ok(content)
}

fn baseline_content(conn: &Connection, inode: i64) -> Result<Option<String>, ToolError> {
    Ok(conn
        .query_row(
            "SELECT content FROM version_bases WHERE inode = ?1",
            params![inode],
            |row| row.get(0),
        )
        .optional()?)
}

/// Description of a version to append; keeps the ledger fields readable at
/// every call site instead of a long positional argument list.
pub struct VersionRecord<'a> {
    pub content: &'a str,
    pub source: &'a str,
    pub title: &'a str,
    pub kind: &'a str,
    pub is_manual: bool,
    pub label: Option<&'a str>,
    pub created_at: &'a str,
}

/// Append a recorded version whose body is `record.content`, reusing the
/// current head blob row (it moves to the new rev in place) and returning that rev.
pub fn append_version(
    conn: &Connection,
    inode: i64,
    record: &VersionRecord<'_>,
) -> Result<i64, ToolError> {
    let head_rev: i64 = conn.query_row(
        "SELECT head_rev FROM inodes WHERE inode = ?1",
        params![inode],
        |row| row.get(0),
    )?;
    let next = head_rev + 1;

    let parent_rev = latest_rev(conn, inode)?;
    let parent = match parent_rev {
        Some(rev) => replay(conn, inode, rev)?,
        None => {
            return Err(ToolError::Storage {
                message: format!("inode {inode} 缺少可用的历史基线"),
            })
        }
    };
    let diff = patch::unified_diff(&parent, record.content);
    conn.execute(
        "INSERT INTO version_diffs (inode, rev, diff, created_at) VALUES (?1, ?2, ?3, ?4)",
        params![inode, next, diff, record.created_at],
    )?;
    conn.execute(
        "INSERT INTO version_meta
             (inode, rev, title, label, label_description, is_manual, kind, created_at)
         VALUES (?1, ?2, ?3, ?4, NULL, ?5, ?6, ?7)",
        params![
            inode,
            next,
            record.title,
            record.label,
            i64::from(record.is_manual),
            record.kind,
            record.created_at
        ],
    )?;
    conn.execute(
        "UPDATE blobs SET rev = ?1, content = ?2, source = ?3, created_at = ?4
         WHERE inode = ?5 AND rev = ?6",
        params![
            next,
            record.content,
            record.source,
            record.created_at,
            inode,
            head_rev
        ],
    )?;
    conn.execute(
        "UPDATE inodes SET head_rev = ?1, size = ?2, mtime = ?3 WHERE inode = ?4",
        params![next, record.content.len() as i64, record.created_at, inode],
    )?;
    Ok(next)
}
