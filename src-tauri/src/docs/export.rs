//! 导出支撑：把 VFS 文档还原成可被普通 Markdown 编辑器打开的字节流。
//!
//! 单文档导出为 `.md`；多文档/文件夹导出为 ZIP。文件写入由 command 层
//! 通过 tauri-plugin-fs 完成，本模块只负责内容收集与 ZIP 打包。

use std::collections::HashMap;
use std::io::Write;

use rusqlite::params;
use zip::write::SimpleFileOptions;
use zip::CompressionMethod;

use crate::vfs::error::ToolError;
use crate::vfs::VirtualFs;

use super::util::{basename, fetch_row, folder_path};

pub struct ExportEntry {
    pub id: i64,
    pub title: String,
    pub markdown: String,
}

/// 单个文档的完整 Markdown（含 frontmatter）。
pub fn markdown(vfs: &VirtualFs, id: i64) -> Result<String, ToolError> {
    let row = fetch_row(vfs.conn(), id, false)?;
    Ok(row.content)
}

/// 收集多个文档，保持传入 id 顺序。
pub fn collect(vfs: &VirtualFs, ids: &[i64]) -> Result<Vec<ExportEntry>, ToolError> {
    let conn = vfs.conn();
    let mut entries = Vec::new();
    for id in ids {
        entries.push(collect_one(conn, *id)?);
    }
    Ok(entries)
}

/// 收集文件夹内的笔记（folder_id < 0 表示默认文件夹）。
pub fn collect_folder(vfs: &VirtualFs, folder_id: i64) -> Result<Vec<ExportEntry>, ToolError> {
    let conn = vfs.conn();
    let dir = if folder_id < 0 {
        crate::db::schema::NOTES_ROOT.to_string()
    } else {
        folder_path(conn, folder_id)?
    };
    let prefix = format!("{dir}/");
    let like = format!("{}%", crate::vfs::cap_gate::escape_like(&prefix));
    let ids: Vec<i64> = {
        let mut stmt = conn.prepare(
            "SELECT i.inode FROM inodes i
             WHERE i.kind = 'file' AND i.deleted = 0
               AND i.path LIKE ?1 ESCAPE '\\'
               AND instr(substr(i.path, length(?2) + 1), '/') = 0
             ORDER BY i.mtime DESC",
        )?;
        let rows = stmt.query_map(params![like, prefix], |r| r.get::<_, i64>(0))?;
        let mut ids = Vec::new();
        for row in rows {
            ids.push(row?);
        }
        ids
    };
    let mut entries = Vec::new();
    for id in ids {
        if let Ok(entry) = collect_one(conn, id) {
            entries.push(entry);
        }
    }
    if entries.is_empty() {
        return Err(ToolError::invalid("没有可导出的笔记"));
    }
    Ok(entries)
}

fn collect_one(conn: &rusqlite::Connection, id: i64) -> Result<ExportEntry, ToolError> {
    let row = fetch_row(conn, id, false)?;
    Ok(ExportEntry {
        id,
        title: row
            .meta_title
            .clone()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| basename(&row.path).to_string()),
        markdown: row.content,
    })
}

/// 打包为 ZIP 字节。文件名格式 `{id}-{安全标题}.md`，冲突自动加序号。
pub fn zip_entries(entries: &[ExportEntry]) -> Result<Vec<u8>, ToolError> {
    let mut names: HashMap<String, u32> = HashMap::new();
    let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);

    for entry in entries {
        let base = format!("{}-{}", entry.id, safe_file_name(&entry.title));
        let count = names.entry(base.clone()).or_insert(0);
        *count += 1;
        let name = if *count == 1 {
            format!("{base}.md")
        } else {
            format!("{base}-{}.md", *count)
        };
        zip.start_file(name, options)
            .map_err(|e| ToolError::Storage {
                message: format!("导出 ZIP 写入失败: {e}"),
            })?;
        zip.write_all(entry.markdown.as_bytes())
            .map_err(|e| ToolError::Storage {
                message: format!("导出 ZIP 写入失败: {e}"),
            })?;
    }

    zip.finish()
        .map(|cursor| cursor.into_inner())
        .map_err(|e| ToolError::Storage {
            message: format!("导出 ZIP 写入失败: {e}"),
        })
}

fn safe_file_name(title: &str) -> String {
    let cleaned: String = title
        .chars()
        .map(|c| {
            if c.is_control() || "\\/:*?\"<>|".contains(c) {
                '_'
            } else {
                c
            }
        })
        .collect();
    let trimmed = cleaned.trim();
    let base = if trimmed.is_empty() {
        "未命名"
    } else {
        trimmed
    };
    base.chars().take(60).collect()
}
