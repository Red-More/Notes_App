//! 交叉索引维护。
//!
//! 每次 write/edit（包括 doc_save）都在同一事务里重建该 inode 的索引行：
//! - type：文档类型（note/todo/event/contact/diary）；
//! - date / time / due：日期、时间、截止时间；
//! - location：地点；
//! - person：人物标识（personId，多个用逗号分隔）；
//! - tag：标签。
//!
//! 反向查询由 `docs::index_query` 负责：给定维度与值，返回关联的全部文档。
//! 这样在人物条目下可以聚合其相关的日记、待办、笔记等跨类型内容。

use rusqlite::{params, Connection};

use super::meta;

/// 索引维度常量，避免字符串散落在 SQL 里。
pub const DIM_TYPE: &str = "type";
pub const DIM_DATE: &str = "date";
pub const DIM_TIME: &str = "time";
pub const DIM_DUE: &str = "due";
pub const DIM_LOCATION: &str = "location";
pub const DIM_PERSON: &str = "person";
pub const DIM_TAG: &str = "tag";

/// 重建一个 inode 的全部索引行。调用方必须已在事务中。
pub fn refresh(conn: &Connection, inode: i64, path: &str, content: &str) -> rusqlite::Result<()> {
    let parts = meta::parse_document(content);
    refresh_parts(conn, inode, path, &parts)
}

/// Same as [`refresh`] but reuses an already parsed document.
pub fn refresh_parts(
    conn: &Connection,
    inode: i64,
    path: &str,
    parts: &meta::DocumentParts,
) -> rusqlite::Result<()> {
    let kind = parts
        .kind
        .clone()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| meta::infer_kind(path).to_string());

    conn.execute("DELETE FROM index_entries WHERE inode = ?1", params![inode])?;

    insert(conn, inode, DIM_TYPE, &kind)?;

    if let Some(date) = meta::field_string(&parts.fields, "date").or_else(|| {
        parts
            .created_at
            .as_deref()
            .map(|value| date_part(value).to_string())
    }) {
        insert(conn, inode, DIM_DATE, &date)?;
    }
    if let Some(time) = meta::field_string(&parts.fields, "startTime")
        .or_else(|| meta::field_string(&parts.fields, "time"))
    {
        insert(conn, inode, DIM_TIME, &time)?;
    }
    if let Some(due) = meta::field_string(&parts.fields, "dueDate")
        .or_else(|| meta::field_string(&parts.fields, "due"))
    {
        insert(conn, inode, DIM_DUE, &due)?;
    }
    if let Some(location) = meta::field_string(&parts.fields, "location") {
        insert(conn, inode, DIM_LOCATION, &location)?;
    }
    if let Some(person) = meta::field_string(&parts.fields, "personId") {
        for value in split_multi(&person) {
            insert(conn, inode, DIM_PERSON, &value)?;
        }
    }
    if let Some(tags) = parts.tags.as_deref() {
        for value in split_multi(tags) {
            insert(conn, inode, DIM_TAG, &value)?;
        }
    }
    Ok(())
}

fn insert(conn: &Connection, inode: i64, dimension: &str, value: &str) -> rusqlite::Result<()> {
    let value = value.trim();
    if value.is_empty() {
        return Ok(());
    }
    conn.execute(
        "INSERT OR IGNORE INTO index_entries (inode, dimension, value)
         VALUES (?1, ?2, ?3)",
        params![inode, dimension, value],
    )?;
    Ok(())
}

fn split_multi(value: &str) -> Vec<String> {
    value
        .split([',', '，', '、'])
        .map(|part| part.trim().to_string())
        .filter(|part| !part.is_empty())
        .collect()
}

fn date_part(value: &str) -> &str {
    value.get(0..10).unwrap_or(value)
}

/// 为还没有索引行的历史文件补建索引（启动时调用一次）。
/// 只处理 `index_entries` 为空的 inode，正常启动成本接近零。
pub fn rebuild_missing(conn: &Connection) -> rusqlite::Result<()> {
    let rows: Vec<(i64, String, String)> = {
        let mut stmt = conn.prepare(
            "SELECT i.inode, i.path, b.content
             FROM inodes i
             JOIN blobs b ON b.inode = i.inode AND b.rev = i.head_rev
             WHERE i.kind = 'file' AND i.deleted = 0
               AND NOT EXISTS (SELECT 1 FROM index_entries e WHERE e.inode = i.inode)",
        )?;
        let mapped = stmt.query_map([], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })?;
        let mut rows = Vec::new();
        for row in mapped {
            rows.push(row?);
        }
        rows
    };
    for (inode, path, content) in rows {
        refresh(conn, inode, &path, &content)?;
    }
    Ok(())
}
