//! 文档版本：blobs 的每个 rev 都是一份完整内容，version_meta 提供全局 id。
//!
//! - 保存/编辑自动追加 rev；
//! - `create` 生成一份手工快照（相同内容也允许，语义由用户决定）；
//! - `restore` 用旧 rev 的内容追加上榜新 rev，历史不丢；
//! - 删除仅允许删除非 head 版本，避免内容指针悬空。

use rusqlite::{params, OptionalExtension};

use crate::vfs::error::ToolError;
use crate::vfs::{index, meta, VirtualFs};

use super::types::DocVersion;
use super::util::{basename, fetch_row, now};

/// 列出一个文档的所有版本（新版本在前）。
/// `include_auto=false` 时只返回手工快照（is_manual=1），保持旧版 UI 语义。
/// 不返回正文：版本历史只需要标题与时间，正文由 `content` 按需单取。
pub fn list(
    vfs: &VirtualFs,
    doc_id: i64,
    include_auto: bool,
) -> Result<Vec<DocVersion>, ToolError> {
    let conn = vfs.conn();
    let doc = fetch_row(conn, doc_id, false)?;
    let fallback_title = doc
        .meta_title
        .clone()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| basename(&doc.path).to_string());

    let mut stmt = conn.prepare(
        "SELECT vm.id, vm.rev, vm.label, vm.label_description, vm.is_manual, vm.created_at, b.content
         FROM version_meta vm
         JOIN blobs b ON b.inode = vm.inode AND b.rev = vm.rev
         WHERE vm.inode = ?1 AND (?2 = 1 OR vm.is_manual = 1)
         ORDER BY vm.rev DESC",
    )?;
    let rows = stmt.query_map(params![doc_id, include_auto as i64], |r| {
        Ok((
            r.get::<_, i64>(0)?,
            r.get::<_, i64>(1)?,
            r.get::<_, Option<String>>(2)?,
            r.get::<_, Option<String>>(3)?,
            r.get::<_, i64>(4)?,
            r.get::<_, String>(5)?,
            r.get::<_, String>(6)?,
        ))
    })?;

    let mut versions = Vec::new();
    for row in rows {
        let (id, rev, label, description, manual, created_at, content) = row?;
        versions.push(build_version(
            doc_id,
            id,
            rev,
            label,
            description,
            manual,
            created_at,
            &content,
            &fallback_title,
        ));
    }
    Ok(versions)
}

/// 手工创建版本：把当前 head 内容再追加一个 rev，并标记 is_manual。
pub fn create(vfs: &mut VirtualFs, doc_id: i64) -> Result<DocVersion, ToolError> {
    let tx = vfs.conn_mut().transaction()?;
    let row = fetch_row(&tx, doc_id, false)?;
    let now = now(&tx)?;
    let next = row.head_rev + 1;
    tx.execute(
        "INSERT INTO blobs (inode, rev, content, source, created_at)
         VALUES (?1, ?2, ?3, 'user', ?4)",
        params![doc_id, next, row.content, now],
    )?;
    tx.execute(
        "UPDATE inodes SET head_rev = ?1, size = ?2, mtime = ?3 WHERE inode = ?4",
        params![next, row.content.len() as i64, now, doc_id],
    )?;
    tx.execute(
        "INSERT INTO version_meta
             (inode, rev, label, label_description, is_manual, created_at)
         VALUES (?1, ?2, NULL, NULL, 1, ?3)",
        params![doc_id, next, now],
    )?;
    tx.commit()?;

    let fallback = row
        .meta_title
        .clone()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| basename(&row.path).to_string());
    let parts = meta::parse_document(&row.content);
    Ok(DocVersion {
        id: latest_version_id(vfs, doc_id, next)?,
        doc_id,
        version_number: next,
        title: parts.title.unwrap_or(fallback),
        content: parts.body,
        label: None,
        label_description: None,
        is_manual: 1,
        created_at: now,
    })
}

/// 恢复到指定版本：追加新 rev，不覆盖历史。
pub fn restore(vfs: &mut VirtualFs, version_id: i64) -> Result<super::types::Doc, ToolError> {
    let tx = vfs.conn_mut().transaction()?;
    let version: Option<(i64, i64)> = tx
        .query_row(
            "SELECT inode, rev FROM version_meta WHERE id = ?1",
            params![version_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    let Some((doc_id, rev)) = version else {
        return Err(ToolError::NotFound {
            path: format!("version#{version_id}"),
        });
    };
    let content: Option<String> = tx
        .query_row(
            "SELECT content FROM blobs WHERE inode = ?1 AND rev = ?2",
            params![doc_id, rev],
            |r| r.get(0),
        )
        .optional()?;
    let Some(content) = content else {
        return Err(ToolError::NotFound {
            path: format!("version#{version_id}"),
        });
    };
    let doc = fetch_row(&tx, doc_id, false)?;
    let now = now(&tx)?;
    let next = doc.head_rev + 1;
    tx.execute(
        "INSERT INTO blobs (inode, rev, content, source, created_at)
         VALUES (?1, ?2, ?3, 'user', ?4)",
        params![doc_id, next, content, now],
    )?;
    tx.execute(
        "UPDATE inodes SET head_rev = ?1, size = ?2, mtime = ?3 WHERE inode = ?4",
        params![next, content.len() as i64, now, doc_id],
    )?;
    meta::upsert(&tx, doc_id, &doc.path, &content)?;
    index::refresh(&tx, doc_id, &doc.path, &content)?;
    crate::vfs::fts::index_document(&tx, doc_id, &content)?;
    tx.execute(
        "INSERT INTO version_meta
             (inode, rev, label, label_description, is_manual, created_at)
         VALUES (?1, ?2, ?3, NULL, 1, ?4)",
        params![doc_id, next, format!("恢复自 rev {rev}"), now],
    )?;
    tx.commit()?;

    super::get(vfs, doc_id, false)
}

/// Read the body of one version on demand (already stripped of frontmatter).
pub fn content(vfs: &VirtualFs, version_id: i64) -> Result<String, ToolError> {
    let conn = vfs.conn();
    let target: Option<(i64, i64)> = conn
        .query_row(
            "SELECT inode, rev FROM version_meta WHERE id = ?1",
            params![version_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    let Some((doc_id, rev)) = target else {
        return Err(ToolError::NotFound {
            path: format!("version#{version_id}"),
        });
    };
    let raw: Option<String> = conn
        .query_row(
            "SELECT content FROM blobs WHERE inode = ?1 AND rev = ?2",
            params![doc_id, rev],
            |r| r.get(0),
        )
        .optional()?;
    let Some(raw) = raw else {
        return Err(ToolError::NotFound {
            path: format!("version#{version_id}"),
        });
    };
    Ok(meta::parse_document(&raw).body)
}

/// 删除非当前版本；当前 head 不允许删除。
pub fn delete(vfs: &mut VirtualFs, version_id: i64) -> Result<(), ToolError> {
    let tx = vfs.conn_mut().transaction()?;
    let row: Option<(i64, i64)> = tx
        .query_row(
            "SELECT inode, rev FROM version_meta WHERE id = ?1",
            params![version_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    let Some((doc_id, rev)) = row else {
        return Err(ToolError::NotFound {
            path: format!("version#{version_id}"),
        });
    };
    let head: i64 = tx.query_row(
        "SELECT head_rev FROM inodes WHERE inode = ?1",
        params![doc_id],
        |r| r.get(0),
    )?;
    if rev == head {
        // 当前 head 的 blob 必须保留（文档内容仍指向它），只移除版本台账行，
        // 让 UI 不再展示这个手工快照。
        tx.execute(
            "DELETE FROM version_meta WHERE id = ?1",
            params![version_id],
        )?;
        tx.commit()?;
        return Ok(());
    }
    tx.execute(
        "DELETE FROM version_meta WHERE id = ?1",
        params![version_id],
    )?;
    tx.execute(
        "DELETE FROM blobs WHERE inode = ?1 AND rev = ?2",
        params![doc_id, rev],
    )?;
    tx.commit()?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn build_version(
    doc_id: i64,
    id: i64,
    rev: i64,
    label: Option<String>,
    label_description: Option<String>,
    is_manual: i64,
    created_at: String,
    content: &str,
    fallback_title: &str,
) -> DocVersion {
    let parts = meta::parse_document(content);
    DocVersion {
        id,
        doc_id,
        version_number: rev,
        title: parts.title.unwrap_or_else(|| fallback_title.to_string()),
        // Bodies stay in storage; callers fetch one version on demand.
        content: String::new(),
        label,
        label_description,
        is_manual,
        created_at,
    }
}

fn latest_version_id(vfs: &VirtualFs, doc_id: i64, rev: i64) -> Result<i64, ToolError> {
    Ok(vfs.conn().query_row(
        "SELECT id FROM version_meta WHERE inode = ?1 AND rev = ?2",
        params![doc_id, rev],
        |r| r.get(0),
    )?)
}
