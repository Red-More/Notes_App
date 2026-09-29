use crate::db::Db;
use crate::models::{Folder, FolderStats};
use rusqlite::{params, Row};
use tauri::State;

fn db_err(e: rusqlite::Error) -> String {
    format!("数据库错误: {e}")
}

fn folder_from_row(r: &Row) -> rusqlite::Result<Folder> {
    Ok(Folder {
        id: r.get(0)?,
        name: r.get(1)?,
        is_pinned: r.get(2)?,
        sort_order: r.get(3)?,
        note_count: r.get(4)?,
        created_at: r.get(5)?,
    })
}

/// List user folders with note counts, plus totals for the virtual
/// "全部" and "默认" entries shown on the folder management page.
#[tauri::command]
pub fn list_folders(state: State<Db>) -> Result<FolderStats, String> {
    let conn = state.0.lock().unwrap();
    let total: i64 = conn
        .query_row("SELECT COUNT(*) FROM notes", [], |r| r.get(0))
        .map_err(db_err)?;
    let unclassified: i64 = conn
        .query_row("SELECT COUNT(*) FROM notes WHERE folder_id IS NULL", [], |r| {
            r.get(0)
        })
        .map_err(db_err)?;
    let mut stmt = conn
        .prepare(
            "SELECT f.id, f.name, f.is_pinned, f.sort_order,
                    (SELECT COUNT(*) FROM notes n WHERE n.folder_id = f.id),
                    f.created_at
             FROM folders f
             ORDER BY f.is_pinned DESC, f.sort_order ASC, f.created_at ASC",
        )
        .map_err(db_err)?;
    let rows = stmt
        .query_map([], folder_from_row)
        .map_err(db_err)?;
    let mut folders = Vec::new();
    for row in rows {
        folders.push(row.map_err(db_err)?);
    }
    Ok(FolderStats {
        total,
        unclassified,
        folders,
    })
}

#[tauri::command]
pub fn create_folder(state: State<Db>, name: String) -> Result<Folder, String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("文件夹名称不能为空".into());
    }
    if name.chars().count() > 50 {
        return Err("文件夹名称最多50个字符".into());
    }
    let conn = state.0.lock().unwrap();
    let exists: bool = conn
        .query_row(
            "SELECT COUNT(*) > 0 FROM folders WHERE name = ?1",
            params![name],
            |r| r.get(0),
        )
        .map_err(db_err)?;
    if exists {
        return Err("同名文件夹已存在".into());
    }
    conn.execute("INSERT INTO folders (name) VALUES (?1)", params![name])
        .map_err(db_err)?;
    let id = conn.last_insert_rowid();
    conn.query_row(
        "SELECT f.id, f.name, f.is_pinned, f.sort_order,
                (SELECT COUNT(*) FROM notes n WHERE n.folder_id = f.id),
                f.created_at
         FROM folders f WHERE f.id = ?1",
        params![id],
        folder_from_row,
    )
    .map_err(db_err)
}

#[tauri::command]
pub fn rename_folder(state: State<Db>, id: i64, name: String) -> Result<(), String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("文件夹名称不能为空".into());
    }
    if name.chars().count() > 50 {
        return Err("文件夹名称最多50个字符".into());
    }
    let conn = state.0.lock().unwrap();
    let exists: bool = conn
        .query_row(
            "SELECT COUNT(*) > 0 FROM folders WHERE name = ?1 AND id != ?2",
            params![name, id],
            |r| r.get(0),
        )
        .map_err(db_err)?;
    if exists {
        return Err("同名文件夹已存在".into());
    }
    conn.execute(
        "UPDATE folders SET name = ?1, updated_at = datetime('now','localtime') WHERE id = ?2",
        params![name, id],
    )
    .map_err(db_err)?;
    Ok(())
}

/// Delete a folder. Its notes are kept and become "默认"
/// (enforced by the ON DELETE SET NULL foreign key).
#[tauri::command]
pub fn delete_folder(state: State<Db>, id: i64) -> Result<(), String> {
    let conn = state.0.lock().unwrap();
    conn.execute("DELETE FROM folders WHERE id = ?1", params![id])
        .map_err(db_err)?;
    Ok(())
}

#[tauri::command]
pub fn set_folder_pinned(state: State<Db>, id: i64, pinned: bool) -> Result<(), String> {
    let conn = state.0.lock().unwrap();
    conn.execute(
        "UPDATE folders SET is_pinned = ?1 WHERE id = ?2",
        params![pinned as i64, id],
    )
    .map_err(db_err)?;
    Ok(())
}
