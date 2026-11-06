//! 文档版本：台账 + 基线全文 + 链式 unified diff。
//!
//! 存储模型（详见 `db/schema.rs` 的最终 DDL）：
//! - `version_meta` 只有台账信息（标题快照、kind、标签、时间），不含正文；
//! - `version_bases` 保存每篇文档的基线全文，一篇仅一行；
//! - `version_diffs` 保存后续版本的 unified diff，始终相对上一个已记录版本；
//! - `blobs` 只保留当前 head，自动保存原地更新，不进入历史链。
//!
//! 因此历史链上的 `content(rev) = replay(baseline, diffs[2..=rev])`，除基线
//! 与 head 外不再有任何整份正文副本。

use std::path::Path;

use rusqlite::{params, Connection, OptionalExtension};

use crate::vfs::error::ToolError;
use crate::vfs::meta;
use crate::vfs::{fts, index, version_store, VirtualFs};

use super::types::{Doc, DocVersion};
use super::util;

/// 列出一个文档的所有版本（新版本在前）。
/// `include_auto=false` 时只返回手工版本（is_manual=1）。
/// 标题读取台账快照，不依赖正文。
pub fn list(
    vfs: &VirtualFs,
    doc_id: i64,
    include_auto: bool,
) -> Result<Vec<DocVersion>, ToolError> {
    let conn = vfs.conn();
    let mut statement = conn.prepare(
        "SELECT v.id, v.inode, v.rev,
                CASE WHEN v.title <> '' THEN v.title ELSE COALESCE(m.title, '') END,
                v.label, v.label_description, v.is_manual, v.created_at
         FROM version_meta v
         LEFT JOIN meta m ON m.inode = v.inode
         WHERE v.inode = ?1 AND (?2 = 1 OR v.is_manual = 1 OR v.kind = 'baseline')
         ORDER BY v.rev DESC",
    )?;
    let rows = statement.query_map(params![doc_id, i64::from(include_auto)], |row| {
        Ok(DocVersion {
            id: row.get(0)?,
            doc_id: row.get(1)?,
            version_number: row.get(2)?,
            title: row.get(3)?,
            content: String::new(),
            label: row.get(4)?,
            label_description: row.get(5)?,
            is_manual: row.get(6)?,
            created_at: row.get(7)?,
        })
    })?;
    let mut versions = Vec::new();
    for row in rows {
        versions.push(row?);
    }
    Ok(versions)
}

/// 读取单个版本的正文：从基线开始回放 diff 链，返回去掉 frontmatter 的正文。
pub fn content(vfs: &VirtualFs, version_id: i64) -> Result<String, ToolError> {
    let conn = vfs.conn();
    let target = find_version(conn, version_id)?;
    let Some((doc_id, rev)) = target else {
        return Err(ToolError::NotFound {
            path: format!("version#{version_id}"),
        });
    };
    let markdown = version_store::replay(conn, doc_id, rev)?;
    Ok(meta::parse_document(&markdown).body)
}

/// 显式创建快照：以当前 head 内容追加一个手工版本。
pub fn create(vfs: &mut VirtualFs, doc_id: i64) -> Result<DocVersion, ToolError> {
    let tx = vfs.conn_mut().transaction()?;
    let row = util::fetch_row(&tx, doc_id, false)?;
    let now = util::now(&tx)?;
    let parts = meta::parse_document(&row.content);
    let title = title_of(&parts, &row.path);
    let rev = version_store::append_version(
        &tx,
        doc_id,
        &version_store::VersionRecord {
            content: &row.content,
            source: "user",
            title: &title,
            kind: version_store::KIND_SNAPSHOT,
            is_manual: true,
            label: None,
            created_at: &now,
        },
    )?;
    let version = fetch_version(&tx, doc_id, rev)?;
    tx.commit()?;
    Ok(version)
}

/// 恢复旧版本：从基线回放出旧正文，原地写入 head，并追加一个 restore 版本。
pub fn restore(vfs: &mut VirtualFs, version_id: i64) -> Result<Doc, ToolError> {
    let tx = vfs.conn_mut().transaction()?;
    let target = find_version(&tx, version_id)?;
    let Some((doc_id, rev)) = target else {
        return Err(ToolError::NotFound {
            path: format!("version#{version_id}"),
        });
    };
    let row = util::fetch_row(&tx, doc_id, false)?;
    let content = version_store::replay(&tx, doc_id, rev)?;
    let now = util::now(&tx)?;
    let parts = meta::parse_document(&content);
    let title = title_of(&parts, &row.path);
    version_store::append_version(
        &tx,
        doc_id,
        &version_store::VersionRecord {
            content: &content,
            source: "user",
            title: &title,
            kind: version_store::KIND_RESTORE,
            is_manual: true,
            label: Some(&format!("恢复自 rev {rev}")),
            created_at: &now,
        },
    )?;
    meta::upsert_parts(&tx, doc_id, &row.path, &parts)?;
    index::refresh_parts(&tx, doc_id, &row.path, &parts)?;
    fts::index_document(&tx, doc_id, &content)?;
    tx.commit()?;

    super::get(vfs, doc_id, false)
}

/// 删除版本。为保持 diff 链完整，只允许删除最新版本（含 head 台账）：
/// - head 版本：只删台账，head blob 保留；
/// - 非 head 的最新版本：台账与 diff 一起删除；
/// - 基线或中间节点：拒绝，删除会切断回放链。
pub fn delete(vfs: &mut VirtualFs, version_id: i64) -> Result<(), ToolError> {
    let tx = vfs.conn_mut().transaction()?;
    let target = find_version(&tx, version_id)?;
    let Some((doc_id, rev)) = target else {
        return Err(ToolError::NotFound {
            path: format!("version#{version_id}"),
        });
    };
    let head_rev: i64 = tx.query_row(
        "SELECT head_rev FROM inodes WHERE inode = ?1",
        params![doc_id],
        |row| row.get(0),
    )?;
    let latest = version_store::latest_rev(&tx, doc_id)?;
    if rev <= 1 {
        return Err(ToolError::invalid("基线版本是历史链的起点，不能删除"));
    }
    if latest != Some(rev) {
        return Err(ToolError::invalid(
            "仅可删除最新版本；删除中间版本会切断 diff 链",
        ));
    }

    if rev == head_rev {
        tx.execute(
            "DELETE FROM version_meta WHERE id = ?1",
            params![version_id],
        )?;
    } else {
        tx.execute(
            "DELETE FROM version_meta WHERE id = ?1",
            params![version_id],
        )?;
        tx.execute(
            "DELETE FROM version_diffs WHERE inode = ?1 AND rev = ?2",
            params![doc_id, rev],
        )?;
    }
    tx.commit()?;
    Ok(())
}

fn find_version(conn: &Connection, version_id: i64) -> Result<Option<(i64, i64)>, ToolError> {
    Ok(conn
        .query_row(
            "SELECT inode, rev FROM version_meta WHERE id = ?1",
            params![version_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?)
}

fn fetch_version(conn: &Connection, doc_id: i64, rev: i64) -> Result<DocVersion, ToolError> {
    let version = conn.query_row(
        "SELECT v.id, v.inode, v.rev,
                CASE WHEN v.title <> '' THEN v.title ELSE COALESCE(m.title, '') END,
                v.label, v.label_description, v.is_manual, v.created_at
         FROM version_meta v
         LEFT JOIN meta m ON m.inode = v.inode
         WHERE v.inode = ?1 AND v.rev = ?2",
        params![doc_id, rev],
        |row| {
            Ok(DocVersion {
                id: row.get(0)?,
                doc_id: row.get(1)?,
                version_number: row.get(2)?,
                title: row.get(3)?,
                content: String::new(),
                label: row.get(4)?,
                label_description: row.get(5)?,
                is_manual: row.get(6)?,
                created_at: row.get(7)?,
            })
        },
    )?;
    Ok(version)
}

fn title_of(parts: &meta::DocumentParts, path: &str) -> String {
    parts
        .title
        .clone()
        .filter(|title| !title.trim().is_empty())
        .unwrap_or_else(|| {
            Path::new(path)
                .file_stem()
                .and_then(|stem| stem.to_str())
                .unwrap_or("untitled")
                .to_string()
        })
}
