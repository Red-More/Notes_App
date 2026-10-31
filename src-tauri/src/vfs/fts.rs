//! FTS5 search index for `/life` documents (M1).
//!
//! The index is maintained by the application layer inside the same transaction
//! as the blob write (no triggers, schema version unchanged), so a committed
//! document is always searchable and a rolled-back one leaves no residue.
//!
//! Tokenization decision (ADR, M1-3): FTS5's `unicode61` tokenizer treats a
//! whole CJK run as one token, so `拉面` cannot match `今天吃了拉面`. Instead of
//! pulling in jieba/ICU, the indexed text is per-character spaced for CJK and
//! queries are turned into quoted phrases (`"拉 面"*`). Two-character words
//! therefore stay searchable with stock SQLite.

use rusqlite::{params, Connection};

/// Characters that must be split into single-character tokens.
fn is_cjk_char(c: char) -> bool {
    matches!(c as u32,
        0x2E80..=0x2FFF       // CJK radicals, Kangxi radicals
        | 0x3040..=0x30FF     // Hiragana / Katakana
        | 0x3100..=0x312F     // Bopomofo
        | 0x3400..=0x4DBF     // CJK Extension A
        | 0x4E00..=0x9FFF     // CJK Unified Ideographs
        | 0xAC00..=0xD7AF     // Hangul syllables
        | 0xF900..=0xFAFF     // CJK Compatibility Ideographs
        | 0x20000..=0x2FA1F   // CJK Extension B and beyond
    )
}

/// Build index text: CJK characters are separated by single spaces, other
/// characters are kept intact; runs of whitespace collapse to one space.
pub(crate) fn index_text(text: &str) -> String {
    let mut spaced = String::with_capacity(text.len() * 2);
    for ch in text.chars() {
        if is_cjk_char(ch) {
            spaced.push(' ');
            spaced.push(ch);
            spaced.push(' ');
        } else {
            spaced.push(ch);
        }
    }

    let mut out = String::with_capacity(spaced.len());
    let mut pending_space = false;
    for ch in spaced.chars() {
        if ch.is_whitespace() {
            pending_space = true;
            continue;
        }
        if pending_space && !out.is_empty() {
            out.push(' ');
        }
        pending_space = false;
        out.push(ch);
    }
    out
}

/// Translate a user pattern into an FTS5 MATCH expression.
///
/// Every whitespace-separated term becomes a quoted phrase with a trailing
/// `*`, which keeps FTS5 syntax characters literal and allows latin prefixes.
/// Returns `None` when no term contains a searchable character, so the caller
/// falls back to the LIKE scan.
pub(crate) fn match_query(pattern: &str) -> Option<String> {
    let mut terms: Vec<String> = Vec::new();
    for raw in pattern.split_whitespace() {
        let text = index_text(raw);
        if !text.chars().any(char::is_alphanumeric) {
            continue;
        }
        terms.push(format!("\"{}\"*", text.replace('"', "\"\"")));
    }
    if terms.is_empty() {
        None
    } else {
        Some(terms.join(" "))
    }
}

/// Replace the search row for `inode`. The caller must already own the
/// transaction that wrote the blob, so index and content commit together.
pub(crate) fn index_document(conn: &Connection, inode: i64, content: &str) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM fts_docs WHERE rowid = ?1", params![inode])?;
    conn.execute(
        "INSERT INTO fts_docs (rowid, title, content) VALUES (?1, '', ?2)",
        params![inode, index_text(content)],
    )?;
    Ok(())
}

/// Drop one document from the index (soft delete or purge).
pub(crate) fn remove_document(conn: &Connection, inode: i64) -> rusqlite::Result<usize> {
    conn.execute("DELETE FROM fts_docs WHERE rowid = ?1", params![inode])
}

/// Drop every row that belongs to a currently trashed document.
pub(crate) fn remove_deleted(conn: &Connection) -> rusqlite::Result<usize> {
    conn.execute(
        "DELETE FROM fts_docs WHERE rowid IN
             (SELECT inode FROM inodes WHERE kind = 'file' AND deleted = 1)",
        [],
    )
}

/// Startup self-heal: remove orphan rows and index visible files that are
/// missing from the index. Returns `(removed, added)` for the startup log.
pub(crate) fn rebuild_missing(conn: &Connection) -> rusqlite::Result<(usize, usize)> {
    let tx = conn.unchecked_transaction()?;
    let removed = tx.execute(
        "DELETE FROM fts_docs WHERE rowid NOT IN
             (SELECT inode FROM inodes WHERE kind = 'file' AND deleted = 0)",
        [],
    )?;

    let rows: Vec<(i64, String)> = {
        let mut stmt = tx.prepare(
            "SELECT i.inode, b.content
             FROM inodes i
             JOIN blobs b ON b.inode = i.inode AND b.rev = i.head_rev
             WHERE i.kind = 'file' AND i.deleted = 0
               AND NOT EXISTS (SELECT 1 FROM fts_docs f WHERE f.rowid = i.inode)",
        )?;
        let mapped = stmt.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))?;
        let mut rows = Vec::new();
        for row in mapped {
            rows.push(row?);
        }
        rows
    };

    let added = rows.len();
    for (inode, content) in rows {
        index_document(&tx, inode, &content)?;
    }
    tx.commit()?;
    Ok((removed, added))
}

/// Manual full rebuild; used by the `search_reindex` command.
pub(crate) fn rebuild_all(conn: &Connection) -> rusqlite::Result<usize> {
    let tx = conn.unchecked_transaction()?;
    tx.execute("DELETE FROM fts_docs", [])?;
    const SQL: &str = "SELECT i.inode, b.content
                        FROM inodes i
                        JOIN blobs b ON b.inode = i.inode AND b.rev = i.head_rev
                        WHERE i.kind = 'file' AND i.deleted = 0";
    let mut stmt = tx.prepare(SQL)?;
    let mapped = stmt.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))?;
    let mut indexed = 0;
    for row in mapped {
        let (inode, content) = row?;
        index_document(&tx, inode, &content)?;
        indexed += 1;
    }
    drop(stmt);
    tx.commit()?;
    Ok(indexed)
}

/// `(indexed rows, visible files)` for the startup consistency check.
pub(crate) fn stats(conn: &Connection) -> rusqlite::Result<(i64, i64)> {
    let indexed: i64 = conn.query_row("SELECT COUNT(*) FROM fts_docs", [], |r| r.get(0))?;
    let visible: i64 = conn.query_row(
        "SELECT COUNT(*) FROM inodes WHERE kind = 'file' AND deleted = 0",
        [],
        |r| r.get(0),
    )?;
    Ok((indexed, visible))
}
