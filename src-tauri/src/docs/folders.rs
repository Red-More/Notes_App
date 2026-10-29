//! 文件夹：`/life/notes` 下的目录即文件夹。
//!
//! 显示名存 `meta.title`，路径由安全 slug 生成并保持稳定；重命名只改显示名，
//! 不移动文件，因此笔记 id / rev 都不会受影响。

use rusqlite::{params, Connection, OptionalExtension};

use crate::db::schema::{ensure_notes_root, NOTES_ROOT};
use crate::vfs::error::ToolError;
use crate::vfs::{cap_gate, VirtualFs};

use super::types::{Folder, FolderStats};
use super::util::{basename, now, safe_segment, unique_dir_path, unique_file_path};

const MAX_FOLDER_NAME_CHARS: usize = 50;

/// 列出文件夹统计。默认文件夹 = `/life/notes` 本身，folderId 为 null。
pub fn list(vfs: &VirtualFs) -> Result<FolderStats, ToolError> {
    let conn = vfs.conn();
    ensure_notes_root(conn)?;

    let default_folder_name = folder_title(conn, NOTES_ROOT)?.unwrap_or_else(|| "默认".into());
    let total = count_files_under(conn, NOTES_ROOT)?;
    let unclassified = count_direct_files(conn, NOTES_ROOT)?;

    let prefix = format!("{NOTES_ROOT}/");
    let like = format!("{}%", cap_gate::escape_like(&prefix));
    let mut stmt = conn.prepare(
        "SELECT i.inode, i.path, i.pinned, i.ctime, COALESCE(m.title, '')
         FROM inodes i
         LEFT JOIN meta m ON m.inode = i.inode
         WHERE i.kind = 'directory' AND i.deleted = 0
           AND i.path LIKE ?1 ESCAPE '\\'
           AND instr(substr(i.path, length(?2) + 1), '/') = 0
         ORDER BY i.pinned DESC, i.ctime ASC",
    )?;
    let rows = stmt.query_map(params![like, prefix], |r| {
        Ok((
            r.get::<_, i64>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, i64>(2)?,
            r.get::<_, String>(3)?,
            r.get::<_, String>(4)?,
        ))
    })?;

    let mut folders = Vec::new();
    for row in rows {
        let (id, path, pinned, created_at, title) = row?;
        let name = if title.is_empty() {
            basename(&path).to_string()
        } else {
            title
        };
        folders.push(Folder {
            id,
            name,
            is_pinned: pinned,
            sort_order: 0,
            note_count: count_direct_files(conn, &path)?,
            created_at,
        });
    }

    Ok(FolderStats {
        total,
        unclassified,
        default_folder_name,
        folders,
    })
}

/// 新建文件夹。显示名查重，路径自动去重。
pub fn create(vfs: &mut VirtualFs, name: &str) -> Result<Folder, ToolError> {
    let name = validate_name(name)?;
    ensure_notes_root(vfs.conn())?;
    if folder_name_exists(vfs.conn(), &name, None)? {
        return Err(ToolError::invalid("同名文件夹已存在"));
    }

    let tx = vfs.conn_mut().transaction()?;
    let segment = safe_segment(&name, "folder");
    let path = unique_dir_path(&tx, NOTES_ROOT, &segment)?;
    let now = now(&tx)?;
    tx.execute(
        "INSERT INTO inodes (path, kind, head_rev, size, ctime, mtime)
         VALUES (?1, 'directory', 0, 0, ?2, ?2)",
        params![path, now],
    )?;
    let id = tx.last_insert_rowid();
    tx.execute(
        "INSERT INTO meta (inode, kind, title, status, due, tags, extra)
         VALUES (?1, 'folder', ?2, NULL, NULL, NULL, '{}')",
        params![id, name],
    )?;
    tx.commit()?;

    Ok(Folder {
        id,
        name,
        is_pinned: 0,
        sort_order: 0,
        note_count: 0,
        created_at: now,
    })
}

/// 重命名真实文件夹（仅改 meta.title）。
pub fn rename(vfs: &mut VirtualFs, id: i64, name: &str) -> Result<(), ToolError> {
    let name = validate_name(name)?;
    let conn = vfs.conn();
    let path = folder_path_by_id(conn, id)?;
    if path.as_str() == NOTES_ROOT {
        return Err(ToolError::invalid("默认文件夹请使用重命名默认文件夹接口"));
    }
    if folder_name_exists(conn, &name, Some(id))? {
        return Err(ToolError::invalid("同名文件夹已存在"));
    }
    upsert_title(conn, id, &name)?;
    Ok(())
}

/// 重命名默认文件夹（`/life/notes` 的 meta.title）。
pub fn rename_default(vfs: &mut VirtualFs, name: &str) -> Result<(), ToolError> {
    let name = validate_name(name)?;
    ensure_notes_root(vfs.conn())?;
    let conn = vfs.conn();
    let id = folder_id_by_path(conn, NOTES_ROOT)?.ok_or_else(|| ToolError::NotFound {
        path: NOTES_ROOT.to_string(),
    })?;
    upsert_title(conn, id, &name)?;
    Ok(())
}

/// 删除文件夹：先把其中笔记移动到默认文件夹，再删除空目录。
pub fn delete(vfs: &mut VirtualFs, id: i64) -> Result<(), ToolError> {
    let tx = vfs.conn_mut().transaction()?;
    let path = folder_path_by_id(&tx, id)?;
    if path.as_str() == NOTES_ROOT {
        return Err(ToolError::invalid("不能删除默认文件夹"));
    }

    let nested: i64 = tx.query_row(
        "SELECT COUNT(*) FROM inodes
         WHERE kind = 'directory' AND deleted = 0
           AND path LIKE ?1 ESCAPE '\\'
           AND instr(substr(path, length(?2) + 1), '/') = 0",
        params![
            format!("{}%", cap_gate::escape_like(&format!("{path}/"))),
            format!("{path}/")
        ],
        |r| r.get(0),
    )?;
    if nested > 0 {
        return Err(ToolError::invalid("暂不支持删除包含子文件夹的文件夹"));
    }

    let prefix = format!("{path}/");
    let like = format!("{}%", cap_gate::escape_like(&prefix));
    let files: Vec<String> = {
        let mut stmt = tx.prepare(
            "SELECT path FROM inodes
             WHERE kind = 'file'
               AND path LIKE ?1 ESCAPE '\\'
               AND instr(substr(path, length(?2) + 1), '/') = 0",
        )?;
        let rows = stmt.query_map(params![like, prefix], |r| r.get::<_, String>(0))?;
        let mut files = Vec::new();
        for row in rows {
            files.push(row?);
        }
        files
    };

    for file in files {
        let stem = basename(&file).to_string();
        let new_path = unique_file_path(&tx, NOTES_ROOT, &stem)?;
        tx.execute(
            "UPDATE inodes SET path = ?1, mtime = datetime('now','localtime')
             WHERE path = ?2 AND kind = 'file'",
            params![new_path, file],
        )?;
    }
    tx.execute(
        "DELETE FROM inodes WHERE inode = ?1 AND kind = 'directory'",
        params![id],
    )?;
    tx.commit()?;
    Ok(())
}

/// 文件夹置顶。
pub fn set_pinned(vfs: &mut VirtualFs, id: i64, pinned: bool) -> Result<(), ToolError> {
    let path = folder_path_by_id(vfs.conn(), id)?;
    if path.as_str() == NOTES_ROOT {
        return Err(ToolError::invalid("默认文件夹不能置顶"));
    }
    vfs.conn_mut().execute(
        "UPDATE inodes SET pinned = ?1 WHERE inode = ?2 AND kind = 'directory'",
        params![pinned as i64, id],
    )?;
    Ok(())
}

fn validate_name(name: &str) -> Result<String, ToolError> {
    let name = name.trim();
    if name.is_empty() {
        return Err(ToolError::invalid("文件夹名称不能为空"));
    }
    if name.chars().count() > MAX_FOLDER_NAME_CHARS {
        return Err(ToolError::invalid(format!(
            "文件夹名称最多 {MAX_FOLDER_NAME_CHARS} 个字符"
        )));
    }
    Ok(name.to_string())
}

fn folder_title(conn: &Connection, path: &str) -> Result<Option<String>, ToolError> {
    Ok(conn
        .query_row(
            "SELECT m.title FROM inodes i LEFT JOIN meta m ON m.inode = i.inode
             WHERE i.path = ?1 AND i.kind = 'directory' AND i.deleted = 0",
            params![path],
            |r| r.get::<_, Option<String>>(0),
        )
        .optional()?
        .flatten())
}

fn folder_name_exists(
    conn: &Connection,
    name: &str,
    exclude_id: Option<i64>,
) -> Result<bool, ToolError> {
    if let Some(default_name) = folder_title(conn, NOTES_ROOT)? {
        if default_name == name {
            return Ok(true);
        }
    }
    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM inodes i
         JOIN meta m ON m.inode = i.inode
         WHERE i.kind = 'directory' AND i.deleted = 0
           AND i.path LIKE '/life/notes/%' AND m.title = ?1
           AND (?2 IS NULL OR i.inode != ?2)",
        params![name, exclude_id],
        |r| r.get(0),
    )?;
    Ok(count > 0)
}

fn folder_id_by_path(conn: &Connection, path: &str) -> Result<Option<i64>, ToolError> {
    conn.query_row(
        "SELECT inode FROM inodes WHERE path = ?1 AND kind = 'directory' AND deleted = 0",
        params![path],
        |r| r.get(0),
    )
    .optional()
    .map_err(ToolError::from)
}

fn folder_path_by_id(conn: &Connection, id: i64) -> Result<String, ToolError> {
    let row: Option<(String, String)> = conn
        .query_row(
            "SELECT kind, path FROM inodes WHERE inode = ?1 AND deleted = 0",
            params![id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    match row {
        Some((kind, path))
            if kind == "directory"
                && (path.as_str() == NOTES_ROOT || path.starts_with("/life/notes/")) =>
        {
            Ok(path)
        }
        Some(_) => Err(ToolError::invalid("目标不是笔记文件夹")),
        None => Err(ToolError::NotFound {
            path: format!("folder#{id}"),
        }),
    }
}

fn upsert_title(conn: &Connection, id: i64, name: &str) -> Result<(), ToolError> {
    conn.execute(
        "INSERT INTO meta (inode, kind, title, status, due, tags, extra)
         VALUES (?1, 'folder', ?2, NULL, NULL, NULL, '{}')
         ON CONFLICT(inode) DO UPDATE SET title = excluded.title, kind = 'folder'",
        params![id, name],
    )?;
    Ok(())
}

fn count_files_under(conn: &Connection, dir: &str) -> Result<i64, ToolError> {
    let like = format!("{}%", cap_gate::escape_like(&format!("{dir}/")));
    Ok(conn.query_row(
        "SELECT COUNT(*) FROM inodes
         WHERE kind = 'file' AND deleted = 0 AND path LIKE ?1 ESCAPE '\\'",
        params![like],
        |r| r.get(0),
    )?)
}

fn count_direct_files(conn: &Connection, dir: &str) -> Result<i64, ToolError> {
    let prefix = format!("{dir}/");
    let like = format!("{}%", cap_gate::escape_like(&prefix));
    Ok(conn.query_row(
        "SELECT COUNT(*) FROM inodes
         WHERE kind = 'file' AND deleted = 0
           AND path LIKE ?1 ESCAPE '\\'
           AND instr(substr(path, length(?2) + 1), '/') = 0",
        params![like, prefix],
        |r| r.get(0),
    )?)
}
