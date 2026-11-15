//! 文件夹：`/life/notes` 下的目录即文件夹。
//!
//! 显示名存 `meta.title`，路径由安全 slug 生成并保持稳定；重命名只改显示名，
//! 不移动文件，因此笔记 id / rev 都不会受影响。
//! `list` 只返回笔记文件夹（`/life/notes` 的直接子目录）；日记、待办等系统
//! 目录属于固定页签，不在文件夹管理范围内。

use rusqlite::{params, Connection, OptionalExtension};

use crate::db::schema::{ensure_notes_root, NOTES_ROOT};
use crate::vfs::error::ToolError;
use crate::vfs::{cap_gate, VirtualFs};

use super::types::{Folder, FolderCrumb, FolderStats};
use super::util::{basename, now, parent_dir, safe_segment, unique_dir_path, unique_file_path};

const MAX_FOLDER_NAME_CHARS: usize = 50;

/// Chinese display names for well-known top-level directories.
fn system_dir_label(path: &str) -> Option<&'static str> {
    match path {
        "/life/notes" => Some("笔记"),
        "/life/diary" => Some("日记"),
        "/life/todos" => Some("待办"),
        "/life/contacts" => Some("联系人"),
        "/life/ai_default" => Some("AI 工作区"),
        _ => None,
    }
}

/// A top-level `/life` directory shown in the notes-page browse menu.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RootDir {
    pub path: String,
    pub label: String,
}

/// All visible top-level directories under `/life`, notes root included.
pub fn root_dirs(vfs: &VirtualFs) -> Result<Vec<RootDir>, ToolError> {
    let conn = vfs.conn();
    let prefix = format!("{}/", cap_gate::ROOT);
    let mut stmt = conn.prepare(
        "SELECT i.path, COALESCE(m.title, '')
         FROM inodes i
         LEFT JOIN meta m ON m.inode = i.inode
         WHERE i.kind = 'directory' AND i.deleted = 0
           AND i.path LIKE ?1 ESCAPE '\\'
           AND instr(substr(i.path, length(?2) + 1), '/') = 0
           AND i.path != ?2
           AND i.path NOT GLOB '*/.agent'
           AND i.path NOT GLOB '*/.lifeos'
         ORDER BY i.path",
    )?;
    let rows = stmt.query_map(params![format!("{}%", cap_gate::escape_like(&prefix)), prefix], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
    })?;

    let mut dirs = Vec::new();
    for row in rows {
        let (path, title) = row?;
        let label = if title.is_empty() {
            system_dir_label(&path)
                .map(str::to_string)
                .unwrap_or_else(|| basename(&path).to_string())
        } else {
            title
        };
        dirs.push(RootDir { path, label });
    }
    // Notes-adjacent system dirs first, then anything user-created by path.
    dirs.sort_by_key(|d| {
        let rank = if d.path == "/life/notes" {
            0
        } else if matches!(d.path.as_str(), "/life/diary" | "/life/todos" | "/life/contacts" | "/life/ai_default")
        {
            1
        } else {
            2
        };
        (rank, d.path.clone())
    });
    Ok(dirs)
}

/// Chinese fallback for system folders whose `meta.title` is missing.
fn default_display_name(path: &str) -> Option<&'static str> {
    match path {
        "/life/notes" => Some("默认"),
        "/life/diary" => Some("日记"),
        "/life/todos" => Some("待办"),
        "/life/contacts" => Some("联系人"),
        "/life/ai_default" => Some("AI 工作区"),
        _ => None,
    }
}

/// System folders seeded from `DEFAULT_DIRS` cannot be deleted or renamed.
///
/// Deleting one of them would move its documents into `/life/notes` while their
/// `kind` stays `diary`/`todo`/..., hiding the files from every list. `/life/notes`
/// is excluded here because it has its own dedicated rename command.
fn protected_folder_name(path: &str) -> Option<&'static str> {
    if path == NOTES_ROOT {
        return None;
    }
    default_display_name(path)
}

/// Reject delete/rename on a protected system folder with a dedicated error code.
fn guard_protected(path: &str, action: &str) -> Result<(), ToolError> {
    match protected_folder_name(path) {
        Some(name) => Err(ToolError::SystemFolder {
            path: path.to_string(),
            message: format!("「{name}」是系统文件夹，不能{action}"),
        }),
        None => Ok(()),
    }
}

/// 列出当前作用域的直接子文件夹统计。
///
/// `parent_id` 为 `None` 时作用域是 `root`（缺省 `/life/notes`）；`root` 为
/// `/life` 时可浏览整个虚拟文件系统。只返回直接子目录，深层节点由前端懒加载。
pub fn list(
    vfs: &VirtualFs,
    parent_id: Option<i64>,
    root: Option<&str>,
) -> Result<FolderStats, ToolError> {
    let conn = vfs.conn();
    ensure_notes_root(conn)?;

    let (_, scope_path, scope_name) = resolve_scope(conn, parent_id, root)?;
    let vfs_mode = scope_path == cap_gate::ROOT;
    let total = count_files_under(conn, &scope_path)?;
    let unclassified = count_direct_files(conn, &scope_path)?;

    let scope_prefix = format!("{scope_path}/");
    let like = format!("{}%", cap_gate::escape_like(&scope_prefix));
    let mut stmt = conn.prepare(
        "SELECT i.inode, i.path, i.pinned, i.ctime
         FROM inodes i
         WHERE i.kind = 'directory' AND i.deleted = 0
           AND i.path LIKE ?1 ESCAPE '\\'
           AND instr(substr(i.path, length(?2) + 1), '/') = 0
           AND i.path NOT GLOB '*/.agent'
           AND i.path NOT GLOB '*/.lifeos'
         ORDER BY i.pinned DESC, i.ctime ASC, i.inode ASC",
    )?;
    let rows = stmt.query_map(params![like, scope_prefix], |r| {
        Ok((
            r.get::<_, i64>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, i64>(2)?,
            r.get::<_, String>(3)?,
        ))
    })?;

    let mut folders = Vec::new();
    for row in rows {
        let (id, path, pinned, created_at) = row?;
        folders.push(Folder {
            id,
            name: display_name(conn, &path, vfs_mode)?,
            path: path.clone(),
            is_pinned: pinned,
            sort_order: 0,
            note_count: count_direct_files(conn, &path)?,
            has_children: has_child_dirs(conn, &path)?,
            created_at,
        });
    }

    Ok(FolderStats {
        total,
        unclassified,
        default_folder_name: scope_name.clone(),
        folders,
        scope_name,
        scope_path,
    })
}

/// 新建文件夹；`parent_id` 指定父级，缺省挂在笔记根目录下。
pub fn create(
    vfs: &mut VirtualFs,
    name: &str,
    parent_id: Option<i64>,
) -> Result<Folder, ToolError> {
    let name = validate_name(name)?;
    ensure_notes_root(vfs.conn())?;
    let parent_path = match parent_id {
        None => NOTES_ROOT.to_string(),
        Some(id) => folder_path_by_id(vfs.conn(), id)?,
    };
    if folder_name_exists(vfs.conn(), &name, None, &parent_path)? {
        return Err(ToolError::invalid("同级已存在同名文件夹"));
    }

    let tx = vfs.conn_mut().transaction()?;
    let segment = safe_segment(&name, "folder");
    let path = unique_dir_path(&tx, &parent_path, &segment)?;
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
        path,
        is_pinned: 0,
        sort_order: 0,
        note_count: 0,
        has_children: false,
        created_at: now,
    })
}

/// 重命名真实文件夹（仅改 meta.title）。
pub fn rename(vfs: &mut VirtualFs, id: i64, name: &str) -> Result<(), ToolError> {
    let name = validate_name(name)?;
    let conn = vfs.conn();
    let path = directory_path_by_id(conn, id)?;
    if path.as_str() == NOTES_ROOT {
        return Err(ToolError::invalid("默认文件夹请使用重命名默认文件夹接口"));
    }
    guard_protected(&path, "重命名")?;
    ensure_note_folder(&path)?;
    if folder_name_exists(conn, &name, Some(id), parent_dir(&path))? {
        return Err(ToolError::invalid("同级已存在同名文件夹"));
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
    let path = directory_path_by_id(&tx, id)?;
    if path.as_str() == NOTES_ROOT {
        return Err(ToolError::invalid("不能删除默认文件夹"));
    }
    guard_protected(&path, "删除")?;
    ensure_note_folder(&path)?;

    // Recursive delete: every document in the subtree returns to the default
    // root, then the whole directory subtree is removed in one statement.
    let prefix = format!("{path}/");
    let like = format!("{}%", cap_gate::escape_like(&prefix));
    let files: Vec<String> = {
        let mut stmt = tx.prepare(
            "SELECT path FROM inodes
             WHERE kind = 'file' AND deleted = 0 AND path LIKE ?1 ESCAPE '\\'",
        )?;
        let rows = stmt.query_map(params![like], |r| r.get::<_, String>(0))?;
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
        "DELETE FROM inodes
         WHERE kind = 'directory' AND (path = ?1 OR path LIKE ?2 ESCAPE '\\')",
        params![path, format!("{}%", cap_gate::escape_like(&prefix))],
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

/// 从作用域根到 `id` 的面包屑；根节点 `id` 为 `None`。
pub fn path(
    vfs: &VirtualFs,
    id: Option<i64>,
    root: Option<&str>,
) -> Result<Vec<FolderCrumb>, ToolError> {
    let conn = vfs.conn();
    ensure_notes_root(conn)?;
    let (root_path, root_name) = resolve_root(conn, root)?;
    let vfs_mode = root_path == cap_gate::ROOT;
    let mut crumbs = vec![FolderCrumb {
        id: None,
        name: root_name,
        path: root_path.clone(),
    }];
    let Some(id) = id else {
        return Ok(crumbs);
    };
    let target = directory_path_by_id(conn, id)?;
    ensure_under(&target, &root_path)?;
    if target == root_path {
        return Ok(crumbs);
    }

    let relative = target
        .strip_prefix(&format!("{root_path}/"))
        .unwrap_or_default();
    let mut current = root_path;
    for segment in relative.split('/').filter(|segment| !segment.is_empty()) {
        current.push('/');
        current.push_str(segment);
        let row: Option<i64> = conn
            .query_row(
                "SELECT inode FROM inodes
                 WHERE path = ?1 AND kind = 'directory' AND deleted = 0",
                params![current],
                |r| r.get(0),
            )
            .optional()?;
        let Some(inode) = row else {
            return Err(ToolError::NotFound {
                path: current.clone(),
            });
        };
        crumbs.push(FolderCrumb {
            id: Some(inode),
            name: display_name(conn, &current, vfs_mode)?,
            path: current.clone(),
        });
    }
    Ok(crumbs)
}

/// 解析作用域根：返回 (虚拟路径, 显示名)，必须是 /life 下的目录。
fn resolve_root(
    conn: &Connection,
    root: Option<&str>,
) -> Result<(String, String), ToolError> {
    let path = root.unwrap_or(NOTES_ROOT).trim_end_matches('/');
    if path != cap_gate::ROOT && !path.starts_with("/life/") {
        return Err(ToolError::invalid("作用域必须位于 /life 下"));
    }
    let kind: Option<String> = conn
        .query_row(
            "SELECT kind FROM inodes WHERE path = ?1 AND deleted = 0",
            params![path],
            |r| r.get(0),
        )
        .optional()?;
    if kind.as_deref() != Some("directory") {
        return Err(ToolError::NotFound {
            path: path.to_string(),
        });
    }
    let vfs_mode = path == cap_gate::ROOT;
    let name = display_name(conn, path, vfs_mode)?;
    Ok((path.to_string(), name))
}

/// 解析作用域：返回 (文件夹 id, 虚拟路径, 显示名)；根作用域 id 为 None。
fn resolve_scope(
    conn: &Connection,
    parent_id: Option<i64>,
    root: Option<&str>,
) -> Result<(Option<i64>, String, String), ToolError> {
    let (root_path, root_name) = resolve_root(conn, root)?;
    match parent_id {
        None => Ok((None, root_path, root_name)),
        Some(id) => {
            let path = directory_path_by_id(conn, id)?;
            ensure_under(&path, &root_path)?;
            let name = display_name(conn, &path, root_path == cap_gate::ROOT)?;
            if path == root_path {
                Ok((None, path, name))
            } else {
                Ok((Some(id), path, name))
            }
        }
    }
}

fn ensure_under(path: &str, root: &str) -> Result<(), ToolError> {
    if path == root || path.starts_with(&format!("{root}/")) {
        Ok(())
    } else {
        Err(ToolError::invalid("目标不在当前作用域内"))
    }
}

/// Display names: system labels win when browsing the whole VFS, otherwise the
/// folder's own renameable title is authoritative.
fn display_name(conn: &Connection, path: &str, vfs_mode: bool) -> Result<String, ToolError> {
    if vfs_mode {
        if let Some(label) = system_dir_label(path) {
            return Ok(label.to_string());
        }
    }
    if let Some(title) = folder_title(conn, path)? {
        if !title.is_empty() {
            return Ok(title);
        }
    }
    if path == cap_gate::ROOT {
        return Ok("文件".into());
    }
    Ok(basename(path).to_string())
}

fn has_child_dirs(conn: &Connection, dir: &str) -> Result<bool, ToolError> {
    let prefix = format!("{dir}/");
    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM inodes
         WHERE kind = 'directory' AND deleted = 0
           AND path LIKE ?1 ESCAPE '\\'
           AND instr(substr(path, length(?2) + 1), '/') = 0
           AND path NOT GLOB '*/.agent'
           AND path NOT GLOB '*/.lifeos'",
        params![format!("{}%", cap_gate::escape_like(&prefix)), prefix],
        |r| r.get(0),
    )?;
    Ok(count > 0)
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
    parent: &str,
) -> Result<bool, ToolError> {
    // A child folder may share its parent's display name; only siblings clash.
    if parent == NOTES_ROOT {
        if let Some(default_name) = folder_title(conn, NOTES_ROOT)? {
            if default_name == name {
                return Ok(true);
            }
        }
    }
    let prefix = format!("{parent}/");
    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM inodes i
         JOIN meta m ON m.inode = i.inode
         WHERE i.kind = 'directory' AND i.deleted = 0
           AND i.path LIKE ?1 ESCAPE '\\'
           AND instr(substr(i.path, length(?2) + 1), '/') = 0
           AND m.title = ?3
           AND (?4 IS NULL OR i.inode != ?4)",
        params![
            format!("{}%", cap_gate::escape_like(&prefix)),
            prefix,
            name,
            exclude_id
        ],
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

/// Resolve any directory by id so delete/rename can reject system folders with
/// their own error before falling back to the notes-root check.
fn directory_path_by_id(conn: &Connection, id: i64) -> Result<String, ToolError> {
    let row: Option<(String, String)> = conn
        .query_row(
            "SELECT kind, path FROM inodes WHERE inode = ?1 AND deleted = 0",
            params![id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    match row {
        Some((kind, path)) if kind == "directory" => Ok(path),
        Some(_) => Err(ToolError::invalid("目标不是文件夹")),
        None => Err(ToolError::NotFound {
            path: format!("folder#{id}"),
        }),
    }
}

/// Anything past the system-folder guard must be an ordinary folder.
fn ensure_note_folder(path: &str) -> Result<(), ToolError> {
    if path.starts_with("/life/notes/") {
        Ok(())
    } else {
        Err(ToolError::invalid("目标不是笔记文件夹"))
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
         WHERE kind = 'file' AND deleted = 0 AND path LIKE ?1 ESCAPE '\\'
           AND path NOT GLOB '*/.agent/*' AND path NOT GLOB '*/.lifeos/*'
           AND path NOT GLOB '*/ai.policy'",
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
           AND instr(substr(path, length(?2) + 1), '/') = 0
           AND path NOT GLOB '*/.agent/*'
           AND path NOT GLOB '*/.lifeos/*'
           AND path NOT GLOB '*/ai.policy'",
        params![like, prefix],
        |r| r.get(0),
    )?)
}
