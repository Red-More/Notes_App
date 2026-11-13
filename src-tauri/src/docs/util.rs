//! docs 层共享工具：路径生成、行读取、DTO 组装、文件夹映射。

use std::collections::HashMap;
use std::path::Path;

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;

use crate::db::schema::NOTES_ROOT;
use crate::vfs::error::ToolError;
use crate::vfs::meta;

use super::types::{Doc, DocFields};

/// 数据库行到 Doc 的中间结构。
pub(super) struct DocRow {
    pub inode: i64,
    pub path: String,
    pub head_rev: i64,
    pub pinned: i64,
    pub ctime: String,
    pub mtime: String,
    pub deleted_at: Option<String>,
    pub meta_kind: Option<String>,
    pub meta_title: Option<String>,
    pub content: String,
}

const DOC_COLUMNS: &str = "i.inode, i.path, i.head_rev, i.pinned, i.ctime, i.mtime, i.deleted_at,
                           m.kind, m.title, COALESCE(b.content, '')";

/// SQLite 本地时间（`YYYY-MM-DD HH:MM:SS`）。
pub(super) fn now(conn: &Connection) -> Result<String, ToolError> {
    Ok(conn.query_row("SELECT datetime('now','localtime')", [], |r| r.get(0))?)
}

/// Load the body stored for one revision. `None` means the row is missing,
/// which lets callers tell a corrupted store apart from an empty document.
pub(super) fn head_content(
    conn: &Connection,
    inode: i64,
    rev: i64,
) -> Result<Option<String>, ToolError> {
    Ok(conn
        .query_row(
            "SELECT content FROM blobs WHERE inode = ?1 AND rev = ?2",
            params![inode, rev],
            |r| r.get(0),
        )
        .optional()?)
}

/// 文档类型对应的根目录。
pub(super) fn root_for(kind: &str) -> Result<&'static str, ToolError> {
    match kind {
        "note" => Ok(NOTES_ROOT),
        "diary" => Ok("/life/diary"),
        "todo" => Ok("/life/todos"),
        "contact" => Ok("/life/contacts"),
        _ => Err(ToolError::invalid(format!("未知文档类型: {kind}"))),
    }
}

/// 把标题变成安全的路径段：非法字符替换为 `_`，截断 60 字符。
pub(super) fn safe_segment(value: &str, fallback: &str) -> String {
    let cleaned: String = value
        .chars()
        .map(|c| {
            if c.is_control() || "/\\:*?\"<>|".contains(c) {
                '_'
            } else {
                c
            }
        })
        .collect();
    let trimmed = cleaned.trim();
    let base = if trimmed.is_empty() || trimmed == "." || trimmed == ".." {
        fallback
    } else {
        trimmed
    };
    base.chars().take(60).collect()
}

/// 生成不冲突的文件路径（自动补 `.md`）。
pub(super) fn unique_file_path(
    conn: &Connection,
    dir: &str,
    stem: &str,
) -> Result<String, ToolError> {
    for n in 1..=9999 {
        let name = if n == 1 {
            format!("{stem}.md")
        } else {
            format!("{stem}-{n}.md")
        };
        let candidate = format!("{dir}/{name}");
        if !path_exists(conn, &candidate)? {
            return Ok(candidate);
        }
    }
    Err(ToolError::invalid("同名文档过多，无法生成唯一路径"))
}

/// 生成不冲突的目录路径。
pub(super) fn unique_dir_path(
    conn: &Connection,
    dir: &str,
    segment: &str,
) -> Result<String, ToolError> {
    for n in 1..=9999 {
        let name = if n == 1 {
            segment.to_string()
        } else {
            format!("{segment}-{n}")
        };
        let candidate = format!("{dir}/{name}");
        if !path_exists(conn, &candidate)? {
            return Ok(candidate);
        }
    }
    Err(ToolError::invalid("同名文件夹过多，无法生成唯一路径"))
}

fn path_exists(conn: &Connection, path: &str) -> Result<bool, ToolError> {
    let exists: i64 = conn.query_row(
        "SELECT COUNT(*) FROM inodes WHERE path = ?1",
        params![path],
        |r| r.get(0),
    )?;
    Ok(exists > 0)
}

/// 校验 folder_id 指向 /life/notes 下的目录，返回其虚拟路径。
pub(super) fn folder_path(conn: &Connection, folder_id: i64) -> Result<String, ToolError> {
    let row: Option<(String, String)> = conn
        .query_row(
            "SELECT kind, path FROM inodes WHERE inode = ?1 AND deleted = 0",
            params![folder_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    match row {
        Some((kind, path)) if kind == "directory" && path_is_notes_dir(&path) => Ok(path),
        Some(_) => Err(ToolError::invalid("目标不是笔记文件夹")),
        None => Err(ToolError::NotFound {
            path: format!("folder#{folder_id}"),
        }),
    }
}

fn path_is_notes_dir(path: &str) -> bool {
    path == NOTES_ROOT || path.starts_with("/life/notes/")
}

/// 列表视图可浏览 `/life` 下任意可见目录（笔记页现在展示全部文件夹）。
/// 写路径（保存/移动/创建）仍使用严格的 `folder_path`。
pub(super) fn folder_path_any(conn: &Connection, folder_id: i64) -> Result<String, ToolError> {
    let row: Option<(String, String)> = conn
        .query_row(
            "SELECT kind, path FROM inodes WHERE inode = ?1 AND deleted = 0",
            params![folder_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    match row {
        Some((kind, path))
            if kind == "directory"
                && path.starts_with("/life/")
                && !path.starts_with("/life/.agents") =>
        {
            Ok(path)
        }
        Some(_) => Err(ToolError::invalid("目标不是可浏览的文件夹")),
        None => Err(ToolError::NotFound {
            path: format!("folder#{folder_id}"),
        }),
    }
}

/// 一次性加载 /life/notes 下所有目录的 (id, 显示名)，避免列表 N+1 查询。
pub(super) fn folder_map(conn: &Connection) -> Result<HashMap<String, (i64, String)>, ToolError> {
    let mut stmt = conn.prepare(
        "SELECT i.inode, i.path, m.title
         FROM inodes i
         LEFT JOIN meta m ON m.inode = i.inode
         WHERE i.kind = 'directory' AND i.deleted = 0 AND i.path LIKE '/life/notes/%'",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok((
            r.get::<_, i64>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, Option<String>>(2)?,
        ))
    })?;
    let mut map = HashMap::new();
    for row in rows {
        let (id, path, title) = row?;
        let name = title
            .filter(|t| !t.is_empty())
            .unwrap_or_else(|| basename(&path).to_string());
        map.insert(path, (id, name));
    }
    Ok(map)
}

/// 按 inode 读取文档行。
pub(super) fn fetch_row(
    conn: &Connection,
    id: i64,
    include_deleted: bool,
) -> Result<DocRow, ToolError> {
    let filter = if include_deleted {
        ""
    } else {
        " AND i.deleted = 0"
    };
    let sql = format!(
        "SELECT {DOC_COLUMNS}
         FROM inodes i
         LEFT JOIN meta m ON m.inode = i.inode
         LEFT JOIN blobs b ON b.inode = i.inode AND b.rev = i.head_rev
         WHERE i.inode = ?1 AND i.kind = 'file'{filter}"
    );
    conn.query_row(&sql, params![id], row_to_doc)
        .optional()?
        .ok_or_else(|| ToolError::NotFound {
            path: format!("doc#{id}"),
        })
}

/// 按路径读取文档行。
pub(super) fn fetch_row_by_path(
    conn: &Connection,
    path: &str,
    include_deleted: bool,
) -> Result<DocRow, ToolError> {
    let filter = if include_deleted {
        ""
    } else {
        " AND i.deleted = 0"
    };
    let sql = format!(
        "SELECT {DOC_COLUMNS}
         FROM inodes i
         LEFT JOIN meta m ON m.inode = i.inode
         LEFT JOIN blobs b ON b.inode = i.inode AND b.rev = i.head_rev
         WHERE i.path = ?1 AND i.kind = 'file'{filter}"
    );
    conn.query_row(&sql, params![path], row_to_doc)
        .optional()?
        .ok_or_else(|| ToolError::NotFound {
            path: path.to_string(),
        })
}

pub(super) fn row_to_doc(r: &rusqlite::Row<'_>) -> rusqlite::Result<DocRow> {
    Ok(DocRow {
        inode: r.get(0)?,
        path: r.get(1)?,
        head_rev: r.get(2)?,
        pinned: r.get(3)?,
        ctime: r.get(4)?,
        mtime: r.get(5)?,
        deleted_at: r.get(6)?,
        meta_kind: r.get(7)?,
        meta_title: r.get(8)?,
        content: r.get(9)?,
    })
}

/// 把 DocRow 组装成前端 DTO。
pub(super) fn doc_from_row(row: DocRow, folders: &HashMap<String, (i64, String)>) -> Doc {
    let parts = meta::parse_document(&row.content);
    let kind = row
        .meta_kind
        .clone()
        .filter(|s| !s.is_empty())
        .or_else(|| parts.kind.clone())
        .unwrap_or_else(|| meta::infer_kind(&row.path).to_string());
    let title = row
        .meta_title
        .clone()
        .filter(|s| !s.is_empty())
        .or_else(|| parts.title.clone())
        .unwrap_or_else(|| basename(&row.path).to_string());
    let (folder_id, folder_name) = if kind == "note" {
        let parent = parent_dir(&row.path);
        if parent == NOTES_ROOT {
            (None, None)
        } else {
            match folders.get(parent) {
                Some((id, name)) => (Some(*id), Some(name.clone())),
                None => (None, None),
            }
        }
    } else {
        (None, None)
    };

    let fields: DocFields = parts.fields;
    Doc {
        id: row.inode,
        path: row.path,
        kind,
        title,
        content: parts.body,
        fields,
        folder_id,
        folder_name,
        pinned: row.pinned,
        rev: row.head_rev,
        created_at: row.ctime,
        updated_at: row.mtime,
        deleted_at: row.deleted_at,
    }
}

pub(super) fn basename(path: &str) -> &str {
    Path::new(path)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(path)
}

pub(super) fn parent_dir(path: &str) -> &str {
    path.rsplit_once('/')
        .map(|(parent, _)| parent)
        .unwrap_or(path)
}

/// 读取字段的字符串值（数组会按逗号拼接）。
pub(super) fn field_str(fields: &DocFields, key: &str) -> Option<String> {
    match fields.get(key)? {
        Value::String(s) if !s.is_empty() => Some(s.to_string()),
        Value::Number(n) => Some(n.to_string()),
        Value::Bool(b) => Some(b.to_string()),
        Value::Array(items) => {
            let parts: Vec<String> = items.iter().filter_map(value_string).collect();
            if parts.is_empty() {
                None
            } else {
                Some(parts.join(","))
            }
        }
        _ => None,
    }
}

fn value_string(value: &Value) -> Option<String> {
    match value {
        Value::String(s) if !s.is_empty() => Some(s.to_string()),
        Value::Number(n) => Some(n.to_string()),
        Value::Bool(b) => Some(b.to_string()),
        _ => None,
    }
}

/// 联系人/待办等的标签匹配（字段 tag 或 tags 数组）。
pub(super) fn doc_has_tag(doc: &Doc, tag: &str) -> bool {
    if field_str(&doc.fields, "tag")
        .map(|t| t.split(',').any(|part| part.trim() == tag))
        .unwrap_or(false)
    {
        return true;
    }
    match doc.fields.get("tags") {
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(value_string)
            .any(|item| item == tag),
        Some(Value::String(s)) => s
            .trim()
            .trim_start_matches('[')
            .trim_end_matches(']')
            .split(',')
            .any(|item| item.trim() == tag),
        _ => false,
    }
}

/// 文档的日期字段（frontmatter 的 date 优先，否则用创建时间前 10 位）。
pub(super) fn doc_date(doc: &Doc) -> Option<String> {
    field_str(&doc.fields, "date").or_else(|| {
        if doc.created_at.len() >= 10 {
            Some(doc.created_at[..10].to_string())
        } else {
            None
        }
    })
}
