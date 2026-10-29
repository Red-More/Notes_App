//! 交叉索引查询：按维度值反向聚合文档。
//!
//! 典型用法：
//! - `index_query("person", "zhang-san")` → 该人物相关的日记/待办/笔记；
//! - `index_query("date", "2026-10-29")` → 当天全部文档；
//! - `index_query("location", "北京")`；
//! - `index_query("tag", "日语", kind='note')`。

use rusqlite::types::Value as SqlValue;

use crate::vfs::error::ToolError;
use crate::vfs::VirtualFs;

use super::types::DocRef;
use super::util::basename;

pub fn query(
    vfs: &VirtualFs,
    dimension: &str,
    value: &str,
    kind: Option<&str>,
    limit: Option<usize>,
) -> Result<Vec<DocRef>, ToolError> {
    let dimension = dimension.trim();
    let value = value.trim();
    if dimension.is_empty() || value.is_empty() {
        return Err(ToolError::invalid("索引维度与值不能为空"));
    }
    let limit = limit.unwrap_or(200).clamp(1, 500) as i64;

    let mut sql = String::from(
        "SELECT i.inode, i.path, COALESCE(m.kind, ''), COALESCE(m.title, ''), i.mtime
         FROM index_entries e
         JOIN inodes i ON i.inode = e.inode
         LEFT JOIN meta m ON m.inode = i.inode
         WHERE i.kind = 'file' AND i.deleted = 0
           AND e.dimension = ? AND e.value = ?",
    );
    let mut args: Vec<SqlValue> = vec![
        SqlValue::Text(dimension.to_string()),
        SqlValue::Text(value.to_string()),
    ];
    if let Some(kind) = kind {
        let kind = kind.trim();
        if !kind.is_empty() {
            sql.push_str(" AND m.kind = ?");
            args.push(SqlValue::Text(kind.to_string()));
        }
    }
    sql.push_str(" ORDER BY i.mtime DESC LIMIT ?");
    args.push(SqlValue::Integer(limit));

    let conn = vfs.conn();
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(rusqlite::params_from_iter(args), |r| {
        Ok((
            r.get::<_, i64>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, String>(3)?,
            r.get::<_, String>(4)?,
        ))
    })?;

    let mut refs = Vec::new();
    for row in rows {
        let (id, path, kind, title, updated_at) = row?;
        let title = if title.is_empty() {
            basename(&path).to_string()
        } else {
            title
        };
        refs.push(DocRef {
            id,
            path,
            kind,
            title,
            updated_at,
        });
    }
    Ok(refs)
}
