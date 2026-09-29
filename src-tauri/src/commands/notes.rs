use crate::db::Db;
use crate::models::{Note, NoteVersion};
use rusqlite::types::Value as SqlValue;
use rusqlite::{params, Connection, OptionalExtension, Row};
use tauri::State;

const MAX_VERSIONS: i64 = 20;
const VERSION_INTERVAL_SECONDS: f64 = 30.0;

fn db_err(e: rusqlite::Error) -> String {
    format!("数据库错误: {e}")
}

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
        "SELECT n.id, n.title, n.content, n.folder_id, f.name, n.is_pinned, n.created_at, n.updated_at
         FROM notes n LEFT JOIN folders f ON f.id = n.folder_id
         WHERE n.id = ?1",
        params![id],
        note_from_row,
    )
    .map_err(db_err)
}

fn insert_version(
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
    conn.execute(
        "INSERT INTO note_versions (note_id, version_number, title, content, label, label_description, is_manual)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![note_id, next, title, content, label, label_description, is_manual as i64],
    )
    .map_err(db_err)?;
    cleanup_versions(conn, note_id)
}

/// Keep at most MAX_VERSIONS versions. The latest version and any
/// labeled / manually created versions are never removed.
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
    conn.execute(
        "DELETE FROM note_versions WHERE id IN (
            SELECT id FROM note_versions
            WHERE note_id = ?1
              AND label IS NULL
              AND is_manual = 0
              AND id != (SELECT id FROM note_versions WHERE note_id = ?1 ORDER BY version_number DESC LIMIT 1)
            ORDER BY version_number ASC
            LIMIT ?2
        )",
        params![note_id, excess],
    )
    .map_err(db_err)?;
    Ok(())
}

/// List notes ordered by pinned first, then last-updated first.
/// `unclassified = true` filters notes without a folder; otherwise
/// `folder_id = None` means all folders.
#[tauri::command]
pub fn list_notes(
    state: State<Db>,
    unclassified: Option<bool>,
    folder_id: Option<i64>,
    search: Option<String>,
) -> Result<Vec<Note>, String> {
    let conn = state.0.lock().unwrap();
    let mut sql = String::from(
        "SELECT n.id, n.title, n.content, n.folder_id, f.name, n.is_pinned, n.created_at, n.updated_at
         FROM notes n LEFT JOIN folders f ON f.id = n.folder_id WHERE 1 = 1",
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
    sql.push_str(" ORDER BY n.is_pinned DESC, n.updated_at DESC");

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
    let conn = state.0.lock().unwrap();
    conn.execute(
        "INSERT INTO notes (title, content, folder_id) VALUES (?1, ?2, ?3)",
        params![title, content, folder_id],
    )
    .map_err(db_err)?;
    let id = conn.last_insert_rowid();
    insert_version(&conn, id, &title, &content, None, None, false)?;
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
    let conn = state.0.lock().unwrap();
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
            insert_version(&conn, id, &title, &content, None, None, false)?;
        }
    }
    get_note_by_id(&conn, id)
}

#[tauri::command]
pub fn delete_notes(state: State<Db>, ids: Vec<i64>) -> Result<(), String> {
    let conn = state.0.lock().unwrap();
    for id in ids {
        conn.execute("DELETE FROM notes WHERE id = ?1", params![id])
            .map_err(db_err)?;
    }
    Ok(())
}

#[tauri::command]
pub fn set_notes_pinned(state: State<Db>, ids: Vec<i64>, pinned: bool) -> Result<(), String> {
    let conn = state.0.lock().unwrap();
    for id in ids {
        conn.execute(
            "UPDATE notes SET is_pinned = ?1 WHERE id = ?2",
            params![pinned as i64, id],
        )
        .map_err(db_err)?;
    }
    Ok(())
}

/// Move notes to a folder. `folder_id = None` moves them to "默认".
#[tauri::command]
pub fn move_notes(state: State<Db>, ids: Vec<i64>, folder_id: Option<i64>) -> Result<(), String> {
    let conn = state.0.lock().unwrap();
    for id in ids {
        conn.execute(
            "UPDATE notes SET folder_id = ?1 WHERE id = ?2",
            params![folder_id, id],
        )
        .map_err(db_err)?;
    }
    Ok(())
}

#[tauri::command]
pub fn list_versions(state: State<Db>, note_id: i64) -> Result<Vec<NoteVersion>, String> {
    let conn = state.0.lock().unwrap();
    let mut stmt = conn
        .prepare(
            "SELECT id, note_id, version_number, title, content, label, label_description, is_manual, created_at
             FROM note_versions WHERE note_id = ?1 ORDER BY version_number DESC",
        )
        .map_err(db_err)?;
    let rows = stmt
        .query_map(params![note_id], version_from_row)
        .map_err(db_err)?;
    let mut versions = Vec::new();
    for row in rows {
        versions.push(row.map_err(db_err)?);
    }
    Ok(versions)
}

/// Restore a note to the given version. The note content is updated and a
/// new manual version labeled "恢复自 vX.Y.Z" is created to record the action.
#[tauri::command]
pub fn restore_version(state: State<Db>, version_id: i64) -> Result<Note, String> {
    let conn = state.0.lock().unwrap();
    let v: NoteVersion = conn
        .query_row(
            "SELECT id, note_id, version_number, title, content, label, label_description, is_manual, created_at
             FROM note_versions WHERE id = ?1",
            params![version_id],
            version_from_row,
        )
        .map_err(db_err)?;
    conn.execute(
        "UPDATE notes SET title = ?1, content = ?2, updated_at = datetime('now','localtime') WHERE id = ?3",
        params![v.title, v.content, v.note_id],
    )
    .map_err(db_err)?;
    let label = format!("恢复自 {}", fmt_version(v.version_number));
    insert_version(&conn, v.note_id, &v.title, &v.content, Some(&label), None, true)?;
    get_note_by_id(&conn, v.note_id)
}

/// Create a labeled snapshot of the note's current content.
#[tauri::command]
pub fn create_label(
    state: State<Db>,
    note_id: i64,
    label: String,
    description: Option<String>,
) -> Result<NoteVersion, String> {
    let label = label.trim().to_string();
    if label.is_empty() {
        return Err("标签名称不能为空".into());
    }
    if label.chars().count() > 50 {
        return Err("标签名称最多50个字符".into());
    }
    let conn = state.0.lock().unwrap();
    let (title, content): (String, String) = conn
        .query_row(
            "SELECT title, content FROM notes WHERE id = ?1",
            params![note_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(db_err)?;
    insert_version(
        &conn,
        note_id,
        &title,
        &content,
        Some(&label),
        description.as_deref(),
        true,
    )?;
    conn.query_row(
        "SELECT id, note_id, version_number, title, content, label, label_description, is_manual, created_at
         FROM note_versions WHERE note_id = ?1 ORDER BY version_number DESC LIMIT 1",
        params![note_id],
        version_from_row,
    )
    .map_err(db_err)
}

/// Update the label of a version without creating a new version.
#[tauri::command]
pub fn update_label(
    state: State<Db>,
    version_id: i64,
    label: String,
    description: Option<String>,
) -> Result<(), String> {
    let label = label.trim().to_string();
    if label.is_empty() {
        return Err("标签名称不能为空".into());
    }
    if label.chars().count() > 50 {
        return Err("标签名称最多50个字符".into());
    }
    let conn = state.0.lock().unwrap();
    conn.execute(
        "UPDATE note_versions SET label = ?1, label_description = ?2 WHERE id = ?3",
        params![label, description, version_id],
    )
    .map_err(db_err)?;
    Ok(())
}

/// Remove the label from a version. The version content is kept.
#[tauri::command]
pub fn delete_label(state: State<Db>, version_id: i64) -> Result<(), String> {
    let conn = state.0.lock().unwrap();
    conn.execute(
        "UPDATE note_versions SET label = NULL, label_description = NULL WHERE id = ?1",
        params![version_id],
    )
    .map_err(db_err)?;
    Ok(())
}
