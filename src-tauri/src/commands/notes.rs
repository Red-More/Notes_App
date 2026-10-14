use crate::commands::db_err;
use crate::db::Db;
use crate::models::{Note, NoteVersion};
use rusqlite::types::Value as SqlValue;
use rusqlite::{params, Connection, OptionalExtension, Row};
use tauri::State;

const MAX_VERSIONS: i64 = 20;
const VERSION_INTERVAL_SECONDS: f64 = 30.0;

fn note_from_row(r: &Row) -> rusqlite::Result<Note> {
    Ok(Note {
        id: r.get(0)?,
        title: r.get(1)?,
        content: r.get(2)?,
        folder_id: r.get(3)?,
        folder_name: r.get(4)?,
        is_pinned: r.get(5)?,
        created_at: r.get(6)?,
        updated_at: r.get(7)?,
        deleted_at: r.get(8)?,
    })
}

fn version_from_row(r: &Row) -> rusqlite::Result<NoteVersion> {
    Ok(NoteVersion {
        id: r.get(0)?,
        note_id: r.get(1)?,
        version_number: r.get(2)?,
        title: r.get(3)?,
        content: r.get(4)?,
        label: r.get(5)?,
        label_description: r.get(6)?,
        is_manual: r.get(7)?,
        created_at: r.get(8)?,
    })
}

/// Format a sequential version number as v{major}.{minor}.{patch}.
pub fn fmt_version(n: i64) -> String {
    format!("v{}.{}.{}", n / 100, (n % 100) / 10, n % 10)
}

fn get_note_by_id(conn: &Connection, id: i64) -> Result<Note, String> {
    conn.query_row(
        "SELECT n.id, n.title, n.content, n.folder_id, f.name, n.is_pinned, n.created_at, n.updated_at, n.deleted_at
         FROM notes n LEFT JOIN folders f ON f.id = n.folder_id
         WHERE n.id = ?1 AND n.deleted_at IS NULL",
        params![id],
        note_from_row,
    )
    .map_err(db_err)
}

/// Encode a reverse delta: given the successor's full content `from` and the
/// target version's full content `to`, store only the differing middle segment
/// (the common prefix/suffix are elided). `decode_delta(from, delta)` recovers `to`.
/// Character-based so multi-byte UTF-8 (Chinese/emoji) is safe.
fn encode_delta(from: &str, to: &str) -> String {
    let f: Vec<char> = from.chars().collect();
    let t: Vec<char> = to.chars().collect();
    let mut p = 0;
    while p < f.len() && p < t.len() && f[p] == t[p] {
        p += 1;
    }
    let mut s = 0;
    while s < f.len().saturating_sub(p)
        && s < t.len().saturating_sub(p)
        && f[f.len() - 1 - s] == t[t.len() - 1 - s]
    {
        s += 1;
    }
    let middle: String = t[p..t.len() - s].iter().collect();
    format!("{},{},{}\n{}", p, s, middle.chars().count(), middle)
}

/// Recover the full content encoded by `encode_delta`. `from` must be the exact
/// successor content used at encode time. Parsing is defensive: malformed deltas
/// degrade to the middle segment instead of panicking.
fn decode_delta(from: &str, delta: &str) -> String {
    let (header, middle) = delta.split_once('\n').unwrap_or((delta, ""));
    let mut parts = header.split(',');
    let p: usize = parts.next().and_then(|v| v.parse().ok()).unwrap_or(0);
    let s: usize = parts.next().and_then(|v| v.parse().ok()).unwrap_or(0);
    let chars: Vec<char> = from.chars().collect();
    let p = p.min(chars.len());
    let s = s.min(chars.len().saturating_sub(p));
    let mut out: String = chars[..p].iter().collect();
    out.push_str(middle);
    out.extend(chars[chars.len() - s..].iter());
    out
}

/// Insert a new version snapshot. The newest version is always stored in full
/// (the chain anchor); the previously-newest version is converted into a reverse
/// delta referencing the new one, so storage only keeps the difference content.
/// The delta update, insert and cleanup run inside one transaction.
fn insert_version(
    conn: &mut Connection,
    note_id: i64,
    title: &str,
    content: &str,
    label: Option<&str>,
    label_description: Option<&str>,
    is_manual: bool,
) -> Result<(), String> {
    let tx = conn.transaction().map_err(db_err)?;
    insert_version_tx(&tx, note_id, title, content, label, label_description, is_manual)?;
    tx.commit().map_err(db_err)
}

/// Transaction-free body of `insert_version`; callers that already hold a
/// transaction (e.g. `restore_version_impl`) reuse it to stay atomic.
fn insert_version_tx(
    conn: &Connection,
    note_id: i64,
    title: &str,
    content: &str,
    label: Option<&str>,
    label_description: Option<&str>,
    is_manual: bool,
) -> Result<(), String> {
    let next: i64 = conn
        .query_row(
            "SELECT COALESCE(MAX(version_number), 0) + 1 FROM note_versions WHERE note_id = ?1",
            params![note_id],
            |r| r.get(0),
        )
        .map_err(db_err)?;
    let prev: Option<(i64, String, Option<i64>)> = conn
        .query_row(
            "SELECT version_number, content, delta_base FROM note_versions
             WHERE note_id = ?1 ORDER BY version_number DESC LIMIT 1",
            params![note_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()
        .map_err(db_err)?;
    if let Some((prev_num, prev_content, prev_base)) = prev {
        // Reconstruct the previous newest's full content (it is normally full, but
        // reconstruct defensively in case an earlier cleanup left it as a delta).
        let prev_full = match prev_base {
            Some(_) => reconstruct_version_content(conn, note_id, prev_num)?,
            None => prev_content,
        };
        let delta = encode_delta(content, &prev_full);
        conn.execute(
            "UPDATE note_versions SET content = ?1, delta_base = ?2
             WHERE note_id = ?3 AND version_number = ?4",
            params![delta, next, note_id, prev_num],
        )
        .map_err(db_err)?;
    }
    conn.execute(
        "INSERT INTO note_versions (note_id, version_number, title, content, label, label_description, is_manual, delta_base)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL)",
        params![note_id, next, title, content, label, label_description, is_manual as i64],
    )
    .map_err(db_err)?;
    cleanup_versions(conn, note_id)
}

/// Reconstruct a version's full content by walking the reverse-delta chain from
/// the newest (full) version back to `version_number`.
fn reconstruct_version_content(
    conn: &Connection,
    note_id: i64,
    version_number: i64,
) -> Result<String, String> {
    let mut chain: Vec<String> = Vec::new();
    let mut cur = version_number;
    let full = loop {
        let (delta_base, content): (Option<i64>, String) = conn
            .query_row(
                "SELECT delta_base, content FROM note_versions WHERE note_id = ?1 AND version_number = ?2",
                params![note_id, cur],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .map_err(db_err)?;
        match delta_base {
            Some(base) => {
                chain.push(content);
                cur = base;
            }
            None => break content,
        }
    };
    let mut result = full;
    for delta in chain.iter().rev() {
        result = decode_delta(&result, delta);
    }
    Ok(result)
}

/// Keep at most MAX_VERSIONS versions. The latest version and any labeled /
/// manually created versions are never removed. Since each older version holds a
/// delta referencing its successor, deletion only ever removes the oldest
/// versions; if the surviving oldest version's successor was deleted, it is
/// rebuilt as a full anchor first so the delta chain never breaks.
fn cleanup_versions(conn: &Connection, note_id: i64) -> Result<(), String> {
    let total: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM note_versions WHERE note_id = ?1",
            params![note_id],
            |r| r.get(0),
        )
        .map_err(db_err)?;
    if total <= MAX_VERSIONS {
        return Ok(());
    }
    let excess = total - MAX_VERSIONS;
    // Oldest unlabeled/manual versions (excluding the newest) are the candidates.
    let doomed: Vec<i64> = {
        let mut stmt = conn
            .prepare(
                "SELECT id FROM note_versions
                 WHERE note_id = ?1 AND label IS NULL AND is_manual = 0
                   AND id != (SELECT id FROM note_versions WHERE note_id = ?1 ORDER BY version_number DESC LIMIT 1)
                 ORDER BY version_number ASC LIMIT ?2",
            )
            .map_err(db_err)?;
        let rows = stmt
            .query_map(params![note_id, excess], |r| r.get::<_, i64>(0))
            .map_err(db_err)?;
        let mut ids = Vec::new();
        for row in rows {
            ids.push(row.map_err(db_err)?);
        }
        ids
    };
    if doomed.is_empty() {
        return Ok(());
    }
    let doomed_set: std::collections::HashSet<i64> = doomed.iter().copied().collect();
    // Every surviving version whose successor was deleted must be rebuilt as a
    // full anchor first, otherwise its delta chain is severed (this happens when
    // protected versions interleave with the deleted run).
    let mut reanchor: Vec<i64> = Vec::new();
    {
        let mut stmt = conn
            .prepare("SELECT id, version_number, delta_base FROM note_versions WHERE note_id = ?1")
            .map_err(db_err)?;
        let rows = stmt
            .query_map(params![note_id], |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, i64>(1)?,
                    r.get::<_, Option<i64>>(2)?,
                ))
            })
            .map_err(db_err)?;
        for row in rows {
            let (id, num, base) = row.map_err(db_err)?;
            if !doomed_set.contains(&id)
                && base.map_or(false, |b| doomed_set.contains(&b))
            {
                reanchor.push(num);
            }
        }
    }
    for num in reanchor {
        let full = reconstruct_version_content(conn, note_id, num)?;
        conn.execute(
            "UPDATE note_versions SET content = ?1, delta_base = NULL WHERE note_id = ?2 AND version_number = ?3",
            params![full, note_id, num],
        )
        .map_err(db_err)?;
    }
    for id in &doomed {
        conn.execute("DELETE FROM note_versions WHERE id = ?1", params![id])
            .map_err(db_err)?;
    }
    Ok(())
}

/// List notes ordered by pinned first, then by the requested `sort` criterion
/// ("updated" by default, or "created" / "title"). `unclassified = true` filters
/// notes without a folder; otherwise `folder_id = None` means all folders.
/// Deleted (trash) notes are excluded.
fn list_notes_impl(
    conn: &Connection,
    unclassified: Option<bool>,
    folder_id: Option<i64>,
    search: Option<String>,
    sort: Option<String>,
) -> Result<Vec<Note>, String> {
    let mut sql = String::from(
        "SELECT n.id, n.title, n.content, n.folder_id, f.name, n.is_pinned, n.created_at, n.updated_at, n.deleted_at
         FROM notes n LEFT JOIN folders f ON f.id = n.folder_id WHERE n.deleted_at IS NULL",
    );
    let mut args: Vec<SqlValue> = Vec::new();
    if unclassified == Some(true) {
        sql.push_str(" AND n.folder_id IS NULL");
    }
    if let Some(fid) = folder_id {
        sql.push_str(" AND n.folder_id = ?");
        args.push(SqlValue::Integer(fid));
    }
    if let Some(s) = search {
        let s = s.trim().to_string();
        if !s.is_empty() {
            sql.push_str(" AND (n.title LIKE ? OR n.content LIKE ?)");
            let pat = format!("%{s}%");
            args.push(SqlValue::Text(pat.clone()));
            args.push(SqlValue::Text(pat));
        }
    }
    // Fixed ORDER BY branches (never interpolated from user input).
    let order_by = match sort.as_deref() {
        Some("created") => " ORDER BY n.is_pinned DESC, n.created_at DESC",
        Some("title") => " ORDER BY n.is_pinned DESC, n.title COLLATE NOCASE ASC, n.updated_at DESC",
        _ => " ORDER BY n.is_pinned DESC, n.updated_at DESC",
    };
    sql.push_str(order_by);

    let mut stmt = conn.prepare(&sql).map_err(db_err)?;
    let rows = stmt
        .query_map(rusqlite::params_from_iter(args), note_from_row)
        .map_err(db_err)?;
    let mut notes = Vec::new();
    for row in rows {
        notes.push(row.map_err(db_err)?);
    }
    Ok(notes)
}

#[tauri::command]
pub fn list_notes(
    state: State<Db>,
    unclassified: Option<bool>,
    folder_id: Option<i64>,
    search: Option<String>,
    sort: Option<String>,
) -> Result<Vec<Note>, String> {
    let conn = state.0.lock().unwrap();
    list_notes_impl(&conn, unclassified, folder_id, search, sort)
}

/// Fetch a single note by id.
#[tauri::command]
pub fn get_note(state: State<Db>, id: i64) -> Result<Note, String> {
    let conn = state.0.lock().unwrap();
    get_note_by_id(&conn, id)
}

/// Create a note together with its first version.
#[tauri::command]
pub fn create_note(
    state: State<Db>,
    title: String,
    content: String,
    folder_id: Option<i64>,
) -> Result<Note, String> {
    let mut conn = state.0.lock().unwrap();
    conn.execute(
        "INSERT INTO notes (title, content, folder_id) VALUES (?1, ?2, ?3)",
        params![title, content, folder_id],
    )
    .map_err(db_err)?;
    let id = conn.last_insert_rowid();
    insert_version(&mut *conn, id, &title, &content, None, None, false)?;
    get_note_by_id(&conn, id)
}

/// Save a note. A new version is created when the content changed AND
/// (force_version OR the last version is older than 30 seconds).
#[tauri::command]
pub fn save_note(
    state: State<Db>,
    id: i64,
    title: String,
    content: String,
    folder_id: Option<i64>,
    force_version: Option<bool>,
) -> Result<Note, String> {
    let mut conn = state.0.lock().unwrap();
    let (old_title, old_content): (String, String) = conn
        .query_row(
            "SELECT title, content FROM notes WHERE id = ?1",
            params![id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(db_err)?;
    conn.execute(
        "UPDATE notes SET title = ?1, content = ?2, folder_id = ?3, updated_at = datetime('now','localtime') WHERE id = ?4",
        params![title, content, folder_id, id],
    )
    .map_err(db_err)?;

    if old_title != title || old_content != content {
        let last_at: Option<String> = conn
            .query_row(
                "SELECT created_at FROM note_versions WHERE note_id = ?1 ORDER BY version_number DESC LIMIT 1",
                params![id],
                |r| r.get(0),
            )
            .optional()
            .map_err(db_err)?;
        let version_due = match last_at {
            None => true,
            Some(t) => {
                let secs: f64 = conn
                    .query_row(
                        "SELECT (julianday('now','localtime') - julianday(?1)) * 86400.0",
                        params![t],
                        |r| r.get(0),
                    )
                    .map_err(db_err)?;
                secs >= VERSION_INTERVAL_SECONDS
            }
        };
        if force_version.unwrap_or(false) || version_due {
            insert_version(&mut *conn, id, &title, &content, None, None, false)?;
        }
    }
    get_note_by_id(&conn, id)
}

/// Soft-delete notes: mark deleted_at so they move to the recycle bin
/// instead of being removed immediately. The whole batch shares one
/// transaction so a failure never leaves a partially soft-deleted set.
fn soft_delete_notes_impl(conn: &mut Connection, ids: &[i64]) -> Result<(), String> {
    let tx = conn.transaction().map_err(db_err)?;
    for id in ids {
        tx.execute(
            "UPDATE notes SET deleted_at = datetime('now','localtime') WHERE id = ?1 AND deleted_at IS NULL",
            params![id],
        )
        .map_err(db_err)?;
    }
    tx.commit().map_err(db_err)
}

#[tauri::command]
pub fn delete_notes(state: State<Db>, ids: Vec<i64>) -> Result<(), String> {
    let mut conn = state.0.lock().unwrap();
    soft_delete_notes_impl(&mut *conn, &ids)
}

/// List notes in the recycle bin (soft-deleted), newest deletion first.
fn list_deleted_notes_impl(conn: &Connection) -> Result<Vec<Note>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT n.id, n.title, n.content, n.folder_id, f.name, n.is_pinned, n.created_at, n.updated_at, n.deleted_at
             FROM notes n LEFT JOIN folders f ON f.id = n.folder_id
             WHERE n.deleted_at IS NOT NULL
             ORDER BY n.deleted_at DESC, n.id DESC",
        )
        .map_err(db_err)?;
    let rows = stmt.query_map([], note_from_row).map_err(db_err)?;
    let mut notes = Vec::new();
    for row in rows {
        notes.push(row.map_err(db_err)?);
    }
    Ok(notes)
}

#[tauri::command]
pub fn list_deleted_notes(state: State<Db>) -> Result<Vec<Note>, String> {
    let conn = state.0.lock().unwrap();
    list_deleted_notes_impl(&conn)
}

/// Restore soft-deleted notes back to the active list.
fn restore_notes_impl(conn: &Connection, ids: &[i64]) -> Result<(), String> {
    for id in ids {
        conn.execute(
            "UPDATE notes SET deleted_at = NULL WHERE id = ?1",
            params![id],
        )
        .map_err(db_err)?;
    }
    Ok(())
}

#[tauri::command]
pub fn restore_notes(state: State<Db>, ids: Vec<i64>) -> Result<(), String> {
    let conn = state.0.lock().unwrap();
    restore_notes_impl(&conn, &ids)
}

/// Permanently delete notes; note_versions rows cascade via the FK.
fn purge_notes_impl(conn: &Connection, ids: &[i64]) -> Result<(), String> {
    for id in ids {
        conn.execute("DELETE FROM notes WHERE id = ?1", params![id])
            .map_err(db_err)?;
    }
    Ok(())
}

#[tauri::command]
pub fn purge_notes(state: State<Db>, ids: Vec<i64>) -> Result<(), String> {
    let conn = state.0.lock().unwrap();
    purge_notes_impl(&conn, &ids)
}

/// Permanently delete every soft-deleted note (empty the recycle bin).
fn empty_trash_impl(conn: &Connection) -> Result<(), String> {
    conn.execute("DELETE FROM notes WHERE deleted_at IS NOT NULL", [])
        .map_err(db_err)?;
    Ok(())
}

#[tauri::command]
pub fn empty_trash(state: State<Db>) -> Result<(), String> {
    let conn = state.0.lock().unwrap();
    empty_trash_impl(&conn)
}

#[tauri::command]
pub fn set_notes_pinned(state: State<Db>, ids: Vec<i64>, pinned: bool) -> Result<(), String> {
    let mut conn = state.0.lock().unwrap();
    let tx = conn.transaction().map_err(db_err)?;
    for id in ids {
        tx.execute(
            "UPDATE notes SET is_pinned = ?1 WHERE id = ?2 AND deleted_at IS NULL",
            params![pinned as i64, id],
        )
        .map_err(db_err)?;
    }
    tx.commit().map_err(db_err)
}

/// Move notes to a folder. `folder_id = None` moves them to "默认".
/// The whole batch shares one transaction so a failure (e.g. a foreign key
/// violation) rolls back every already-executed move.
fn move_notes_impl(
    conn: &mut Connection,
    ids: &[i64],
    folder_id: Option<i64>,
) -> Result<(), String> {
    let tx = conn.transaction().map_err(db_err)?;
    for id in ids {
        tx.execute(
            "UPDATE notes SET folder_id = ?1 WHERE id = ?2 AND deleted_at IS NULL",
            params![folder_id, id],
        )
        .map_err(db_err)?;
    }
    tx.commit().map_err(db_err)
}

#[tauri::command]
pub fn move_notes(state: State<Db>, ids: Vec<i64>, folder_id: Option<i64>) -> Result<(), String> {
    let mut conn = state.0.lock().unwrap();
    move_notes_impl(&mut *conn, &ids, folder_id)
}

/// List all versions of a note, newest first, with full reconstructed content.
/// The newest version is always stored in full; each older version normally
/// holds a delta against its successor, but a cleanup may re-anchor a surviving
/// oldest version back to full content. So contents are rebuilt in a single
/// pass: only rows with a non-NULL delta_base are decoded, against the already
/// reconstructed full content of the row above.
fn list_versions_impl(conn: &Connection, note_id: i64) -> Result<Vec<NoteVersion>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, note_id, version_number, title, content, label, label_description, is_manual, created_at, delta_base
             FROM note_versions WHERE note_id = ?1 ORDER BY version_number DESC",
        )
        .map_err(db_err)?;
    let rows = stmt
        .query_map(params![note_id], |r| {
            let version = version_from_row(r)?;
            let delta_base: Option<i64> = r.get(9)?;
            Ok((version, delta_base))
        })
        .map_err(db_err)?;
    let mut versions = Vec::new();
    for row in rows {
        versions.push(row.map_err(db_err)?);
    }
    for i in 1..versions.len() {
        if versions[i].1.is_some() {
            let delta = std::mem::replace(&mut versions[i].0.content, String::new());
            let newer_full = versions[i - 1].0.content.clone();
            versions[i].0.content = decode_delta(&newer_full, &delta);
        }
    }
    Ok(versions.into_iter().map(|(v, _)| v).collect())
}

#[tauri::command]
pub fn list_versions(state: State<Db>, note_id: i64) -> Result<Vec<NoteVersion>, String> {
    let conn = state.0.lock().unwrap();
    list_versions_impl(&conn, note_id)
}

/// Restore a note to the given version. The note content is updated to the
/// version's reconstructed full content and a new manual version labeled
/// "恢复自 vX.Y.Z" is created to record the action. Both writes share one
/// transaction so a failure in either step rolls back the whole restore.
fn restore_version_impl(conn: &mut Connection, version_id: i64) -> Result<Note, String> {
    let v: NoteVersion = conn
        .query_row(
            "SELECT id, note_id, version_number, title, content, label, label_description, is_manual, created_at
             FROM note_versions WHERE id = ?1",
            params![version_id],
            version_from_row,
        )
        .map_err(db_err)?;
    let full_content = reconstruct_version_content(conn, v.note_id, v.version_number)?;
    let tx = conn.transaction().map_err(db_err)?;
    tx.execute(
        "UPDATE notes SET title = ?1, content = ?2, updated_at = datetime('now','localtime') WHERE id = ?3",
        params![v.title, full_content, v.note_id],
    )
    .map_err(db_err)?;
    let label = format!("恢复自 {}", fmt_version(v.version_number));
    insert_version_tx(&tx, v.note_id, &v.title, &full_content, Some(&label), None, true)?;
    tx.commit().map_err(db_err)?;
    get_note_by_id(conn, v.note_id)
}

#[tauri::command]
pub fn restore_version(state: State<Db>, version_id: i64) -> Result<Note, String> {
    let mut conn = state.0.lock().unwrap();
    restore_version_impl(&mut *conn, version_id)
}

/// Manually snapshot the note's current title/content as a new version.
/// Rejects the request when the note content is identical to the newest
/// version, so an empty snapshot can never be recorded.
fn create_version_impl(conn: &mut Connection, note_id: i64) -> Result<NoteVersion, String> {
    let (title, content): (String, String) = conn
        .query_row(
            "SELECT title, content FROM notes WHERE id = ?1",
            params![note_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(db_err)?;
    let last: Option<i64> = conn
        .query_row(
            "SELECT version_number FROM note_versions
             WHERE note_id = ?1 ORDER BY version_number DESC LIMIT 1",
            params![note_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(db_err)?;
    if let Some(num) = last {
        let last_full = reconstruct_version_content(conn, note_id, num)?;
        if last_full == content {
            return Err("内容与上一版本一致，不能创建新版本".to_string());
        }
    }
    insert_version(conn, note_id, &title, &content, None, None, true)?;
    conn.query_row(
        "SELECT id, note_id, version_number, title, content, label, label_description, is_manual, created_at
         FROM note_versions WHERE note_id = ?1 ORDER BY version_number DESC LIMIT 1",
        params![note_id],
        version_from_row,
    )
    .map_err(db_err)
}

#[tauri::command]
pub fn create_version(state: State<Db>, note_id: i64) -> Result<NoteVersion, String> {
    let mut conn = state.0.lock().unwrap();
    create_version_impl(&mut *conn, note_id)
}

/// Delete a specific version. If an older version's reverse delta references the
/// deleted one, it is re-anchored to full content first (while the deleted row
/// still exists to reconstruct from), so the delta chain never breaks.
fn delete_version_impl(conn: &Connection, version_id: i64) -> Result<(), String> {
    let (note_id, num): (i64, i64) = conn
        .query_row(
            "SELECT note_id, version_number FROM note_versions WHERE id = ?1",
            params![version_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(db_err)?;
    let dependent: Option<i64> = conn
        .query_row(
            "SELECT version_number FROM note_versions WHERE note_id = ?1 AND delta_base = ?2",
            params![note_id, num],
            |r| r.get(0),
        )
        .optional()
        .map_err(db_err)?;
    if let Some(dep) = dependent {
        let full = reconstruct_version_content(conn, note_id, dep)?;
        conn.execute(
            "UPDATE note_versions SET content = ?1, delta_base = NULL WHERE note_id = ?2 AND version_number = ?3",
            params![full, note_id, dep],
        )
        .map_err(db_err)?;
    }
    conn.execute("DELETE FROM note_versions WHERE id = ?1", params![version_id])
        .map_err(db_err)?;
    Ok(())
}

#[tauri::command]
pub fn delete_version(state: State<Db>, version_id: i64) -> Result<(), String> {
    let conn = state.0.lock().unwrap();
    delete_version_impl(&conn, version_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        // Mirrors db::init: FK cascade is only active when this pragma is set.
        conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
        conn.execute_batch(
            "CREATE TABLE folders (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL UNIQUE,
                is_pinned INTEGER NOT NULL DEFAULT 0,
                sort_order INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
            );
            CREATE TABLE notes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL DEFAULT '',
                content TEXT NOT NULL DEFAULT '',
                folder_id INTEGER REFERENCES folders(id) ON DELETE SET NULL,
                is_pinned INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
                deleted_at TEXT
            );
            CREATE TABLE note_versions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
                version_number INTEGER NOT NULL,
                title TEXT NOT NULL,
                content TEXT NOT NULL,
                label TEXT,
                label_description TEXT,
                is_manual INTEGER NOT NULL DEFAULT 0,
                delta_base INTEGER,
                created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
                UNIQUE(note_id, version_number)
            );",
        )
        .unwrap();
        conn
    }

    fn insert_note(conn: &Connection, id: i64, title: &str, content: &str) {
        conn.execute(
            "INSERT INTO notes (id, title, content) VALUES (?1, ?2, ?3)",
            params![id, title, content],
        )
        .unwrap();
    }

    #[test]
    fn delta_round_trip_recovers_full_content() {
        let cases: Vec<(&str, &str)> = vec![
            ("", ""),
            ("hello", "hello"),
            ("hello", "hello world"),
            ("hello world", "hello"),
            ("abc", "xyz"),
            ("abc", "ab"),
            ("ab", "abc"),
            ("你好世界", "你好，世界！"),
            ("a😀b", "a😀b😀c"),
            ("line1\nline2\nline3", "line1\nline2 changed\nline3\nline4"),
        ];
        for (from, to) in cases {
            let delta = encode_delta(from, to);
            assert_eq!(
                decode_delta(from, &delta),
                to,
                "round trip failed for from={from:?} to={to:?}"
            );
        }
        // Long generated content with a small middle change.
        let long_from = "a".repeat(500);
        let long_to = "a".repeat(200) + "B" + &"a".repeat(300);
        let delta = encode_delta(&long_from, &long_to);
        assert_eq!(decode_delta(&long_from, &delta), long_to);
        assert!(delta.len() < long_to.len(), "delta should be smaller than full content");
    }

    #[test]
    fn chain_reconstruction_returns_all_original_contents() {
        let mut conn = test_conn();
        insert_note(&conn, 1, "t1", "c1");
        let contents = ["c1", "c1\nmore", "完全不同内容", "你好世界", "final content 😀"];
        for (i, c) in contents.iter().enumerate() {
            insert_version(&mut conn, 1, &format!("t{}", i + 1), c, None, None, true).unwrap();
        }
        let versions = list_versions_impl(&conn, 1).unwrap();
        assert_eq!(versions.len(), contents.len());
        for (i, v) in versions.iter().enumerate() {
            assert_eq!(v.content, contents[contents.len() - 1 - i]);
        }
        // Exactly one row (the newest) is stored in full.
        let delta_cnt: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM note_versions WHERE delta_base IS NOT NULL",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(delta_cnt, (contents.len() - 1) as i64);
    }

    #[test]
    fn restore_middle_version_updates_note_and_keeps_chain() {
        let mut conn = test_conn();
        insert_note(&conn, 1, "t1", "content-v1");
        let contents = ["content-v1", "content-v2", "content-v3", "content-v4"];
        for (i, c) in contents.iter().enumerate() {
            insert_version(&mut conn, 1, &format!("t{}", i + 1), c, None, None, true).unwrap();
        }
        let v2_id: i64 = conn
            .query_row(
                "SELECT id FROM note_versions WHERE note_id = 1 AND version_number = 2",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let note = restore_version_impl(&mut conn, v2_id).unwrap();
        assert_eq!(note.content, "content-v2");
        // A manual "恢复自" version is appended and the chain still reconstructs.
        let versions = list_versions_impl(&conn, 1).unwrap();
        assert_eq!(versions.len(), 5);
        assert_eq!(versions[0].content, "content-v2");
        assert_eq!(versions[0].label.as_deref(), Some("恢复自 v0.0.2"));
        assert_eq!(versions[0].is_manual, 1);
        for v in &versions {
            reconstruct_version_content(&conn, 1, v.version_number).unwrap();
        }
    }

    #[test]
    fn cleanup_keeps_at_most_max_and_chain_intact() {
        let mut conn = test_conn();
        insert_note(&conn, 1, "t", "base");
        for i in 0..30 {
            let c = format!("content-version-{i}");
            insert_version(&mut conn, 1, "t", &c, None, None, false).unwrap();
        }
        let total: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM note_versions WHERE note_id = 1",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(total <= MAX_VERSIONS);
        let versions = list_versions_impl(&conn, 1).unwrap();
        assert_eq!(versions.len() as i64, total);
        for (i, v) in versions.iter().enumerate() {
            assert_eq!(v.content, format!("content-version-{}", 29 - i));
        }
    }

    #[test]
    fn cleanup_protected_oldest_version_is_reanchored() {
        let mut conn = test_conn();
        insert_note(&conn, 1, "t", "base");
        insert_version(&mut conn, 1, "t", "labeled-content", Some("important"), None, true).unwrap();
        for i in 0..30 {
            let c = format!("content-version-{i}");
            insert_version(&mut conn, 1, "t", &c, None, None, false).unwrap();
        }
        let total: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM note_versions WHERE note_id = 1",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(total <= MAX_VERSIONS);
        let versions = list_versions_impl(&conn, 1).unwrap();
        let v1 = versions
            .iter()
            .find(|v| v.version_number == 1)
            .expect("labeled v1 must be kept");
        assert_eq!(v1.label.as_deref(), Some("important"));
        assert_eq!(v1.content, "labeled-content");
        for v in &versions {
            reconstruct_version_content(&conn, 1, v.version_number).unwrap();
        }
    }

    #[test]
    fn cleanup_interleaved_protected_versions_reanchor_in_chain() {
        let mut conn = test_conn();
        insert_note(&conn, 1, "t", "base");
        // Protected versions interleave with the unprotected run: v2's and v4's
        // successors are deleted, so both v1 and v3 must be re-anchored.
        insert_version(&mut conn, 1, "t", "content-v1", Some("keep-1"), None, true).unwrap();
        insert_version(&mut conn, 1, "t", "content-v2", None, None, false).unwrap();
        insert_version(&mut conn, 1, "t", "content-v3", Some("keep-2"), None, true).unwrap();
        for i in 4..34 {
            let c = format!("content-version-{i}");
            insert_version(&mut conn, 1, "t", &c, None, None, false).unwrap();
        }
        let total: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM note_versions WHERE note_id = 1",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(total <= MAX_VERSIONS);
        let versions = list_versions_impl(&conn, 1).unwrap();
        let v1 = versions.iter().find(|v| v.version_number == 1).expect("v1 kept");
        let v3 = versions.iter().find(|v| v.version_number == 3).expect("v3 kept");
        assert_eq!(v1.content, "content-v1");
        assert_eq!(v3.content, "content-v3");
        for v in &versions {
            reconstruct_version_content(&conn, 1, v.version_number).unwrap();
        }
    }

    #[test]
    fn version_numbers_are_monotonic() {
        let mut conn = test_conn();
        insert_note(&conn, 1, "t", "c");
        for i in 0..10 {
            insert_version(&mut conn, 1, "t", &format!("c{i}"), None, None, true).unwrap();
        }
        let numbers: Vec<i64> = {
            let mut stmt = conn
                .prepare(
                    "SELECT version_number FROM note_versions WHERE note_id = 1 ORDER BY version_number ASC",
                )
                .unwrap();
            let rows = stmt.query_map([], |r| r.get::<_, i64>(0)).unwrap();
            let mut v = Vec::new();
            for r in rows {
                v.push(r.unwrap());
            }
            v
        };
        assert_eq!(numbers.len(), 10);
        for w in numbers.windows(2) {
            assert!(w[1] > w[0], "version numbers must be strictly increasing");
        }
    }

    #[test]
    fn create_version_rejects_identical_content() {
        let mut conn = test_conn();
        insert_note(&conn, 1, "t", "c1");
        insert_version(&mut conn, 1, "t", "c1", None, None, false).unwrap();
        // Note content matches the newest version -> must be rejected.
        assert!(create_version_impl(&mut conn, 1).is_err());
        // Changing the content allows a new manual version.
        conn.execute("UPDATE notes SET content = 'c2' WHERE id = 1", [])
            .unwrap();
        let v = create_version_impl(&mut conn, 1).unwrap();
        assert_eq!(v.content, "c2");
        assert_eq!(v.is_manual, 1);
    }

    #[test]
    fn delete_version_reanchors_chain_and_keeps_history() {
        let mut conn = test_conn();
        insert_note(&conn, 1, "t", "content-v1");
        let contents = ["content-v1", "content-v2", "content-v3", "content-v4"];
        for (i, c) in contents.iter().enumerate() {
            insert_version(&mut conn, 1, &format!("t{}", i + 1), c, None, None, true).unwrap();
        }
        // Delete v2 (middle): v1 holds a delta against it and must be re-anchored.
        let v2_id: i64 = conn
            .query_row(
                "SELECT id FROM note_versions WHERE note_id = 1 AND version_number = 2",
                [],
                |r| r.get(0),
            )
            .unwrap();
        delete_version_impl(&conn, v2_id).unwrap();
        let versions = list_versions_impl(&conn, 1).unwrap();
        assert_eq!(versions.len(), 3);
        let v1 = versions.iter().find(|v| v.version_number == 1).unwrap();
        assert_eq!(v1.content, "content-v1");
        for v in &versions {
            reconstruct_version_content(&conn, 1, v.version_number).unwrap();
        }
        // Delete the newest (v4): the new newest must be stored in full again.
        let v4_id: i64 = conn
            .query_row(
                "SELECT id FROM note_versions WHERE note_id = 1 AND version_number = 4",
                [],
                |r| r.get(0),
            )
            .unwrap();
        delete_version_impl(&conn, v4_id).unwrap();
        let versions = list_versions_impl(&conn, 1).unwrap();
        assert_eq!(versions.len(), 2);
        assert_eq!(versions[0].version_number, 3);
        assert_eq!(versions[0].content, "content-v3");
        for v in &versions {
            reconstruct_version_content(&conn, 1, v.version_number).unwrap();
        }
    }

    #[test]
    fn delete_note_cascades_versions() {
        let mut conn = test_conn();
        insert_note(&conn, 1, "t", "c1");
        insert_version(&mut conn, 1, "t", "c1", None, None, true).unwrap();
        insert_version(&mut conn, 1, "t", "c2", None, None, true).unwrap();
        // Mirrors the delete_notes command body; the FK cascade must remove
        // every version of the deleted note.
        conn.execute("DELETE FROM notes WHERE id = 1", []).unwrap();
        let cnt: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM note_versions WHERE note_id = 1",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(cnt, 0);
    }

    #[test]
    fn trash_soft_delete_restore_purge_and_empty() {
        let mut conn = test_conn();
        insert_note(&conn, 1, "t1", "c1");
        insert_note(&conn, 2, "t2", "c2");
        insert_version(&mut conn, 1, "t1", "c1", None, None, true).unwrap();
        insert_version(&mut conn, 2, "t2", "c2", None, None, true).unwrap();

        // Soft delete note 1; it must vanish from the active list but appear
        // in the trash, and the active note 2 must be unaffected.
        soft_delete_notes_impl(&mut conn, &[1]).unwrap();
        let active = list_notes_impl(&conn, None, None, None, None).unwrap();
        assert_eq!(active.len(), 1);
        assert_eq!(active[0].id, 2);
        let trash = list_deleted_notes_impl(&conn).unwrap();
        assert_eq!(trash.len(), 1);
        assert_eq!(trash[0].id, 1);
        assert!(trash[0].deleted_at.is_some());
        // Active list searches must also skip deleted notes.
        let hits = list_notes_impl(&conn, None, None, Some("t1".into()), None).unwrap();
        assert!(hits.is_empty());

        // Restore note 1: it is active again and the trash is empty.
        restore_notes_impl(&conn, &[1]).unwrap();
        let active = list_notes_impl(&conn, None, None, None, None).unwrap();
        assert_eq!(active.len(), 2);
        assert!(list_deleted_notes_impl(&conn).unwrap().is_empty());

        // Soft delete both, then purge note 1: note_versions cascade away.
        soft_delete_notes_impl(&mut conn, &[1, 2]).unwrap();
        purge_notes_impl(&conn, &[1]).unwrap();
        let versions: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM note_versions WHERE note_id = 1",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(versions, 0);
        assert_eq!(list_deleted_notes_impl(&conn).unwrap().len(), 1);

        // empty_trash removes every remaining soft-deleted note.
        empty_trash_impl(&conn).unwrap();
        assert!(list_deleted_notes_impl(&conn).unwrap().is_empty());
        let remaining: i64 = conn
            .query_row("SELECT COUNT(*) FROM notes", [], |r| r.get(0))
            .unwrap();
        assert_eq!(remaining, 0);
    }

    #[test]
    fn move_notes_batch_rolls_back_on_mid_batch_failure() {
        let mut conn = test_conn();
        conn.execute(
            "INSERT INTO folders (id, name) VALUES (1, 'work'), (2, 'archive')",
            [],
        )
        .unwrap();
        insert_note(&conn, 1, "t1", "c1");
        insert_note(&conn, 2, "t2", "c2");
        conn.execute("UPDATE notes SET folder_id = 1", []).unwrap();
        // A single folder_id applies to every row, so a plain foreign key
        // violation would fail on the very first matched row. To prove
        // mid-batch atomicity, abort only the second row's move after the
        // first one already ran inside the transaction.
        conn.execute_batch(
            "CREATE TRIGGER fail_move_note2
             BEFORE UPDATE OF folder_id ON notes
             WHEN NEW.id = 2 AND NEW.folder_id = 2
             BEGIN
                 SELECT RAISE(ABORT, 'boom');
             END;",
        )
        .unwrap();
        let err = move_notes_impl(&mut conn, &[1, 2], Some(2)).unwrap_err();
        assert!(err.contains("boom"), "unexpected error: {err}");
        // Atomicity: note 1's already-executed move must be rolled back too.
        let f1: Option<i64> = conn
            .query_row("SELECT folder_id FROM notes WHERE id = 1", [], |r| r.get(0))
            .unwrap();
        let f2: Option<i64> = conn
            .query_row("SELECT folder_id FROM notes WHERE id = 2", [], |r| r.get(0))
            .unwrap();
        assert_eq!(f1, Some(1));
        assert_eq!(f2, Some(1));
    }

    #[test]
    fn list_notes_sort_variants_order_notes() {
        let conn = test_conn();
        // Identical content, distinct timestamps/titles.
        conn.execute_batch(
            "INSERT INTO notes (id, title, content, created_at, updated_at) VALUES
             (1, 'apple',  'c', '2024-01-01 10:00:00', '2024-01-03 10:00:00'),
             (2, 'Banana', 'c', '2024-01-02 10:00:00', '2024-01-01 10:00:00'),
             (3, 'cherry', 'c', '2024-01-03 10:00:00', '2024-01-02 10:00:00');",
        )
        .unwrap();
        let ids = |sort: Option<&str>| -> Vec<i64> {
            list_notes_impl(&conn, None, None, None, sort.map(String::from))
                .unwrap()
                .into_iter()
                .map(|n| n.id)
                .collect()
        };
        // "updated" (and the default) sort by updated_at DESC: 1, 3, 2.
        assert_eq!(ids(Some("updated")), vec![1, 3, 2]);
        assert_eq!(ids(None), vec![1, 3, 2]);
        // "created" sorts by created_at DESC: 3, 2, 1.
        assert_eq!(ids(Some("created")), vec![3, 2, 1]);
        // "title" sorts case-insensitively by title ASC: apple, Banana, cherry.
        assert_eq!(ids(Some("title")), vec![1, 2, 3]);
        // Unknown values fall back to the default ordering.
        assert_eq!(ids(Some("bogus")), vec![1, 3, 2]);
    }
}



