//! 通用文档层：所有内容都是一条记录一个 Markdown 文件。
//!
//! 路径约定：
//! - 笔记：`/life/notes[/<folder>]/<slug>.md`
//! - 日记：`/life/diary/<slug>.md`
//! - 待办：`/life/todos/<slug>.md`
//! - 日程：`/life/schedule/<date>-<slug>.md`
//! - 联系人：`/life/contacts/<slug>.md`
//!
//! id 使用 inode，移动文件不改变 id；每次保存追加 rev，前端通过 version_meta
//! 回溯历史。文件夹本质是 `/life/notes` 下的目录，笔记移动即修改 inode.path。

pub mod export;
pub mod folders;
pub mod index;
pub mod types;
pub mod util;
pub mod versions;

use rusqlite::types::Value as SqlValue;
use rusqlite::{params, OptionalExtension};
use serde_json::Value;

use crate::db::schema::NOTES_ROOT;
use crate::vfs::cap_gate;
use crate::vfs::{
    error::ToolError,
    meta,
    types::{WriteRequest, WriteSource},
    VirtualFs,
};

use types::{Doc, DocFields, ListQuery};
use util::{
    basename, doc_date, doc_from_row, fetch_row, folder_map, folder_path, head_content, parent_dir,
    root_for, safe_segment, unique_file_path,
};

/// 读取单个文档。
pub fn get(vfs: &VirtualFs, id: i64, include_deleted: bool) -> Result<Doc, ToolError> {
    let conn = vfs.conn();
    let folders = folder_map(conn)?;
    let row = fetch_row(conn, id, include_deleted)?;
    Ok(doc_from_row(row, &folders))
}

/// 通用列表查询。SQL 只做粗筛，tag / month / 排序在 Rust 侧完成，
/// 这样字段扩展不需要频繁改 SQL，文档量级（千级）下成本可控。
pub fn list(vfs: &VirtualFs, query: ListQuery) -> Result<Vec<Doc>, ToolError> {
    let conn = vfs.conn();
    let deleted = if query.deleted.unwrap_or(false) { 1 } else { 0 };
    let kind_filter = query.kind.clone();
    let mut sql = String::from(
        "SELECT i.inode, i.path, i.head_rev, i.pinned, i.ctime, i.mtime, i.deleted_at,
                m.kind, m.title, COALESCE(b.content, '')
         FROM inodes i
         JOIN meta m ON m.inode = i.inode
         JOIN blobs b ON b.inode = i.inode AND b.rev = i.head_rev
         WHERE i.kind = 'file' AND i.deleted = ?",
    );
    let mut args: Vec<SqlValue> = vec![SqlValue::Integer(deleted)];

    if let Some(kind) = kind_filter.as_deref() {
        sql.push_str(" AND m.kind = ?");
        args.push(SqlValue::Text(kind.to_string()));
    }

    if let Some(folder_id) = query.folder_id {
        let dir = folder_path(conn, folder_id)?;
        push_direct_child_filter(&mut sql, &mut args, &dir);
    } else if query.unclassified.unwrap_or(false) {
        push_direct_child_filter(&mut sql, &mut args, NOTES_ROOT);
    } else if let Some(kind) = kind_filter.as_deref() {
        let root = root_for(kind)?;
        sql.push_str(" AND i.path LIKE ? ESCAPE '\\'");
        args.push(SqlValue::Text(format!(
            "{}%",
            cap_gate::escape_like(&format!("{root}/"))
        )));
    }

    if let Some(raw) = query.search.as_deref() {
        let search = raw.trim();
        if !search.is_empty() {
            sql.push_str(
                " AND (instr(lower(COALESCE(m.title, '')), lower(?)) > 0
                       OR instr(lower(b.content), lower(?)) > 0
                       OR instr(lower(COALESCE(m.extra, '')), lower(?)) > 0)",
            );
            args.push(SqlValue::Text(search.to_string()));
            args.push(SqlValue::Text(search.to_string()));
            args.push(SqlValue::Text(search.to_string()));
        }
    }
    sql.push_str(" ORDER BY i.mtime DESC LIMIT 2000");

    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(rusqlite::params_from_iter(args), util::row_to_doc)?;
    let folders = folder_map(conn)?;
    let mut docs = Vec::new();
    for row in rows {
        docs.push(doc_from_row(row?, &folders));
    }

    if let Some(raw) = query.tag.as_deref() {
        let tag = raw.trim();
        if !tag.is_empty() {
            docs.retain(|doc| util::doc_has_tag(doc, tag));
        }
    }
    if let Some(raw) = query.month.as_deref() {
        let month = raw.trim();
        if !month.is_empty() {
            docs.retain(|doc| {
                doc_date(doc)
                    .map(|date| date.starts_with(month))
                    .unwrap_or(false)
            });
        }
    }

    sort_docs(&mut docs, query.sort.as_deref().unwrap_or("updated"));
    let limit = query.limit.unwrap_or(1000).clamp(1, 2000);
    docs.truncate(limit);
    Ok(docs)
}

/// 新建文档。内容与 fields 由调用方给出，后端负责生成唯一路径与 frontmatter。
pub fn create(
    vfs: &mut VirtualFs,
    kind: &str,
    title: &str,
    content: &str,
    folder_id: Option<i64>,
    fields: Option<DocFields>,
) -> Result<Doc, ToolError> {
    root_for(kind)?;
    let mut fields = fields.unwrap_or_default();

    let dir = {
        let conn = vfs.conn();
        if kind == "note" {
            match folder_id {
                Some(id) => folder_path(conn, id)?,
                None => NOTES_ROOT.to_string(),
            }
        } else {
            root_for(kind)?.to_string()
        }
    };

    let stem = match kind {
        "event" => {
            let date = util::field_str(&fields, "date").unwrap_or_default();
            if date.is_empty() {
                safe_segment(title, "event")
            } else {
                format!(
                    "{}-{}",
                    safe_segment(&date, "undated"),
                    safe_segment(title, "event")
                )
            }
        }
        _ => safe_segment(title, kind),
    };

    let path = {
        let conn = vfs.conn();
        unique_file_path(conn, &dir, &stem)?
    };

    if kind == "contact" && !fields.contains_key("personId") {
        fields.insert(
            "personId".to_string(),
            Value::String(basename(&path).to_string()),
        );
    }

    let now = util::now(vfs.conn())?;
    let markdown = meta::compose(kind, title, &now, &now, &fields, content);
    vfs.write(WriteRequest {
        path: path.clone(),
        content: markdown,
        create_parents: Some(true),
        auto_frontmatter: Some(false),
        source: WriteSource::User,
    })?;

    let conn = vfs.conn();
    let folders = folder_map(conn)?;
    let row = util::fetch_row_by_path(conn, &path, false)?;
    Ok(doc_from_row(row, &folders))
}

/// 保存文档：可选更新标题/正文/字段；笔记可同时移动到另一个文件夹。
/// 每次保存追加一个新 rev，expect_rev 不一致时返回 Conflict。
pub fn save(
    vfs: &mut VirtualFs,
    id: i64,
    title: Option<String>,
    content: Option<String>,
    fields: Option<DocFields>,
    folder_id: Option<i64>,
    expect_rev: Option<i64>,
) -> Result<Doc, ToolError> {
    let tx = vfs.conn_mut().transaction()?;
    let row = fetch_row(&tx, id, false)?;
    // The row reader falls back to an empty body when the head blob is gone,
    // so refuse to save instead of silently rewriting the document without content.
    let Some(head) = head_content(&tx, id, row.head_rev)? else {
        return Err(ToolError::Storage {
            message: format!("inode {id} has no body for rev={}", row.head_rev),
        });
    };
    let parts = meta::parse_document(&head);
    let kind = row
        .meta_kind
        .clone()
        .filter(|s| !s.is_empty())
        .or_else(|| parts.kind.clone())
        .unwrap_or_else(|| meta::infer_kind(&row.path).to_string());

    if let Some(expect) = expect_rev {
        if expect != row.head_rev {
            return Err(ToolError::Conflict {
                current: row.head_rev,
                expect,
            });
        }
    }

    let mut new_path = row.path.clone();
    if kind == "note" {
        if let Some(target_id) = folder_id {
            let target_dir = if target_id < 0 {
                NOTES_ROOT.to_string()
            } else {
                folder_path(&tx, target_id)?
            };
            if parent_dir(&row.path) != target_dir.as_str() {
                let stem = basename(&row.path).to_string();
                new_path = unique_file_path(&tx, &target_dir, &stem)?;
            }
        }
    }

    let old_title = row
        .meta_title
        .clone()
        .filter(|s| !s.is_empty())
        .or_else(|| parts.title.clone())
        .unwrap_or_else(|| basename(&row.path).to_string());
    let title = title.unwrap_or(old_title);
    let body = content.unwrap_or(parts.body);

    let mut merged = parts.fields;
    if let Some(update) = fields {
        for (key, value) in update {
            if value.is_null() {
                merged.remove(&key);
            } else {
                merged.insert(key, value);
            }
        }
    }
    if kind == "contact" && !merged.contains_key("personId") {
        merged.insert(
            "personId".to_string(),
            Value::String(basename(&new_path).to_string()),
        );
    }

    let created_at = parts.created_at.unwrap_or_else(|| row.ctime.clone());
    let now = util::now(&tx)?;
    let markdown = meta::compose(&kind, &title, &created_at, &now, &merged, &body);
    if markdown.len() > 1024 * 1024 {
        return Err(ToolError::ContentTooLarge {
            limit: 1024 * 1024,
            actual: markdown.len(),
        });
    }
    // 内容未变化且未移动时，不追加空 rev，避免自动保存把历史撑爆。
    if new_path == row.path && markdown == head {
        drop(tx);
        return get(vfs, id, false);
    }

    let next = row.head_rev + 1;
    tx.execute(
        "INSERT INTO blobs (inode, rev, content, source, created_at)
         VALUES (?1, ?2, ?3, 'user', ?4)",
        params![id, next, markdown, now],
    )?;
    tx.execute(
        "UPDATE inodes SET path = ?1, head_rev = ?2, size = ?3, mtime = ?4 WHERE inode = ?5",
        params![new_path, next, markdown.len() as i64, now, id],
    )?;
    meta::upsert(&tx, id, &new_path, &markdown)?;
    crate::vfs::index::refresh(&tx, id, &new_path, &markdown)?;
    crate::vfs::fts::index_document(&tx, id, &markdown)?;
    tx.execute(
        "INSERT OR IGNORE INTO version_meta
             (inode, rev, label, label_description, is_manual, created_at)
         VALUES (?1, ?2, NULL, NULL, 0, ?3)",
        params![id, next, now],
    )?;
    tx.commit()?;

    get(vfs, id, false)
}

/// 批量软删除（进入回收站）。
pub fn delete_many(vfs: &mut VirtualFs, ids: &[i64]) -> Result<(), ToolError> {
    let tx = vfs.conn_mut().transaction()?;
    let now = util::now(&tx)?;
    for id in ids {
        tx.execute(
            "UPDATE inodes SET deleted = 1, deleted_at = ?1, mtime = ?1
             WHERE inode = ?2 AND kind = 'file' AND deleted = 0",
            params![now, id],
        )?;
        // 回收站内容不可被检索；恢复时再重建索引行。
        crate::vfs::fts::remove_document(&tx, *id)?;
    }
    tx.commit()?;
    Ok(())
}

/// 从回收站恢复。
pub fn restore_many(vfs: &mut VirtualFs, ids: &[i64]) -> Result<(), ToolError> {
    let tx = vfs.conn_mut().transaction()?;
    for id in ids {
        tx.execute(
            "UPDATE inodes SET deleted = 0, deleted_at = NULL
             WHERE inode = ?1 AND kind = 'file'",
            params![id],
        )?;
        // 恢复后立即补齐交叉索引，避免历史文档恢复后查不到。
        let row: Option<(String, String)> = tx
            .query_row(
                "SELECT i.path, COALESCE(b.content, '')
                 FROM inodes i
                 LEFT JOIN blobs b ON b.inode = i.inode AND b.rev = i.head_rev
                 WHERE i.inode = ?1 AND i.kind = 'file'",
                params![id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        if let Some((path, content)) = row {
            crate::vfs::index::refresh(&tx, *id, &path, &content)?;
            crate::vfs::fts::index_document(&tx, *id, &content)?;
        }
    }
    tx.commit()?;
    Ok(())
}

/// 物理删除回收站中的文档（blobs/meta/version/index 级联删除）。
pub fn purge_many(vfs: &mut VirtualFs, ids: &[i64]) -> Result<(), ToolError> {
    let tx = vfs.conn_mut().transaction()?;
    for id in ids {
        crate::vfs::fts::remove_document(&tx, *id)?;
        tx.execute(
            "DELETE FROM inodes WHERE inode = ?1 AND kind = 'file' AND deleted = 1",
            params![id],
        )?;
    }
    tx.commit()?;
    Ok(())
}

/// 清空回收站。
pub fn empty_trash(vfs: &mut VirtualFs) -> Result<(), ToolError> {
    crate::vfs::fts::remove_deleted(vfs.conn_mut())?;
    vfs.conn_mut()
        .execute("DELETE FROM inodes WHERE kind = 'file' AND deleted = 1", [])?;
    Ok(())
}

/// 批量置顶/取消置顶。
pub fn set_pinned(vfs: &mut VirtualFs, ids: &[i64], pinned: bool) -> Result<(), ToolError> {
    let tx = vfs.conn_mut().transaction()?;
    for id in ids {
        tx.execute(
            "UPDATE inodes SET pinned = ?1 WHERE inode = ?2 AND kind = 'file'",
            params![pinned as i64, id],
        )?;
    }
    tx.commit()?;
    Ok(())
}

/// 批量移动笔记到文件夹；folder_id 为 None 或负数时移动到默认根。
pub fn move_many(
    vfs: &mut VirtualFs,
    ids: &[i64],
    folder_id: Option<i64>,
) -> Result<(), ToolError> {
    let tx = vfs.conn_mut().transaction()?;
    let target_dir = match folder_id {
        Some(id) if id >= 0 => folder_path(&tx, id)?,
        _ => NOTES_ROOT.to_string(),
    };
    for id in ids {
        let row: Option<(String, String)> = {
            let mut stmt = tx.prepare(
                "SELECT i.path, COALESCE(m.kind, '')
                 FROM inodes i LEFT JOIN meta m ON m.inode = i.inode
                 WHERE i.inode = ?1 AND i.kind = 'file' AND i.deleted = 0",
            )?;
            let mut rows = stmt.query(params![id])?;
            match rows.next()? {
                Some(r) => Some((r.get(0)?, r.get(1)?)),
                None => None,
            }
        };
        let Some((path, kind)) = row else {
            return Err(ToolError::NotFound {
                path: format!("doc#{id}"),
            });
        };
        if !kind.is_empty() && kind != "note" {
            return Err(ToolError::invalid("只有笔记可以移动文件夹"));
        }
        if parent_dir(&path) == target_dir.as_str() {
            continue;
        }
        let stem = basename(&path).to_string();
        let new_path = unique_file_path(&tx, &target_dir, &stem)?;
        tx.execute(
            "UPDATE inodes SET path = ?1, mtime = datetime('now','localtime') WHERE inode = ?2",
            params![new_path, id],
        )?;
    }
    tx.commit()?;
    Ok(())
}

fn push_direct_child_filter(sql: &mut String, args: &mut Vec<SqlValue>, dir: &str) {
    let prefix = format!("{dir}/");
    sql.push_str(
        " AND i.path LIKE ? ESCAPE '\\'
          AND instr(substr(i.path, length(?) + 1), '/') = 0",
    );
    args.push(SqlValue::Text(format!(
        "{}%",
        cap_gate::escape_like(&prefix)
    )));
    args.push(SqlValue::Text(prefix));
}

fn sort_docs(docs: &mut [Doc], sort: &str) {
    docs.sort_by(|a, b| {
        let pinned = b.pinned.cmp(&a.pinned);
        if pinned != std::cmp::Ordering::Equal {
            return pinned;
        }
        let order = match sort {
            "created" => b.created_at.cmp(&a.created_at),
            "title" => a.title.to_lowercase().cmp(&b.title.to_lowercase()),
            "date" => doc_date(a)
                .unwrap_or_default()
                .cmp(&doc_date(b).unwrap_or_default())
                .then_with(|| {
                    util::field_str(&a.fields, "startTime")
                        .unwrap_or_default()
                        .cmp(&util::field_str(&b.fields, "startTime").unwrap_or_default())
                }),
            _ => b.updated_at.cmp(&a.updated_at),
        };
        order.then_with(|| b.id.cmp(&a.id))
    });
}
