//! 导出支撑：把 VFS 文档还原成可被普通 Markdown 编辑器打开的字节流。
//!
//! 单文档导出为 `.md`（含图片引用时改为 ZIP）；多文档/文件夹导出为 ZIP。
//! 笔记正文里的 `asset:<id>` 引用会改写成 ZIP 内的 `assets/<sha>.<ext>`，
//! 图片字节一并打包，导出的 Markdown 打开后图片不会丢失。
//! 文件写入由 command 层通过 tauri-plugin-fs 完成，本模块只负责内容收集与
//! ZIP 打包。

use std::collections::{HashMap, HashSet};
use std::io::Write;

use rusqlite::params;
use zip::write::SimpleFileOptions;
use zip::CompressionMethod;

use crate::assets::AssetStore;
use crate::vfs::error::ToolError;
use crate::vfs::meta;
use crate::vfs::VirtualFs;

use super::util::{fetch_row, folder_path, stem};

pub struct ExportEntry {
    pub id: i64,
    pub title: String,
    /// Extension of the backing file, so archived names keep their type.
    pub ext: String,
    pub markdown: String,
    /// Referenced images already rewritten to `assets/<sha>.<ext>`.
    pub assets: Vec<ExportAsset>,
}

pub struct ExportAsset {
    /// Name inside the `assets/` archive directory.
    pub name: String,
    pub bytes: Vec<u8>,
}

/// 收集多个文档，保持传入 id 顺序。
pub fn collect(
    vfs: &VirtualFs,
    ids: &[i64],
    store: &AssetStore,
) -> Result<Vec<ExportEntry>, ToolError> {
    let mut entries = Vec::new();
    for id in ids {
        entries.push(collect_one(vfs, *id, store)?);
    }
    Ok(entries)
}

/// 收集文件夹内的笔记（folder_id < 0 表示默认文件夹）。
pub fn collect_folder(
    vfs: &VirtualFs,
    folder_id: i64,
    store: &AssetStore,
) -> Result<Vec<ExportEntry>, ToolError> {
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
             WHERE i.kind = 'file' AND i.status = 'active'
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
        if let Ok(entry) = collect_one(vfs, id, store) {
            entries.push(entry);
        }
    }
    if entries.is_empty() {
        return Err(ToolError::invalid("没有可导出的笔记"));
    }
    Ok(entries)
}

/// 收集单个文档，并把图片引用改写为归档内的相对路径。
pub fn collect_one(
    vfs: &VirtualFs,
    id: i64,
    store: &AssetStore,
) -> Result<ExportEntry, ToolError> {
    let row = fetch_row(vfs.conn(), id, false)?;
    let is_markdown = meta::is_markdown_ext(&row.ext);
    let title = if is_markdown {
        meta::doc_title(&meta::parse_document(&row.content), &row.path, &row.ext)
    } else {
        stem(&row.path, &row.ext).to_string()
    };
    // Raw documents are exported byte-for-byte: `asset:` inside code is not a
    // reference and no frontmatter must be added.
    let (markdown, assets) = if is_markdown {
        rewrite_assets(vfs, store, &row.content)
    } else {
        (row.content.clone(), Vec::new())
    };
    Ok(ExportEntry {
        id,
        title,
        ext: row.ext,
        markdown,
        assets,
    })
}

/// Replace every `asset:<id>` reference with `assets/<sha>.<ext>` and collect
/// the referenced bytes. Missing assets keep their original text so nothing is
/// silently dropped from the document.
fn rewrite_assets(
    vfs: &VirtualFs,
    store: &AssetStore,
    content: &str,
) -> (String, Vec<ExportAsset>) {
    let conn = vfs.conn();
    let mut output = String::with_capacity(content.len());
    let mut assets = Vec::new();
    let mut resolved: HashMap<i64, Option<String>> = HashMap::new();
    let mut index = 0usize;

    while let Some(found) = content[index..].find("asset:") {
        let start = index + found;
        output.push_str(&content[index..start]);

        let digits_start = start + "asset:".len();
        let bytes = content.as_bytes();
        let mut end = digits_start;
        while end < bytes.len() && bytes[end].is_ascii_digit() {
            end += 1;
        }
        if end == digits_start {
            // Not an asset reference (e.g. a word that merely contains "asset:").
            output.push_str(&content[start..digits_start]);
            index = digits_start;
            continue;
        }

        let id = content[digits_start..end].parse::<i64>().ok();
        let name = id.and_then(|id| {
            if let Some(name) = resolved.get(&id) {
                return name.clone();
            }
            let fetched = store.export_bytes(conn, id);
            let name = fetched.as_ref().map(|(name, _)| name.clone());
            if let Some((name, bytes)) = fetched {
                assets.push(ExportAsset { name, bytes });
            }
            resolved.insert(id, name.clone());
            name
        });

        match name {
            Some(name) => {
                output.push_str("assets/");
                output.push_str(&name);
            }
            // Stale reference: keep it verbatim rather than losing the text.
            None => output.push_str(&content[start..end]),
        }
        index = end;
    }
    output.push_str(&content[index..]);
    (output, assets)
}

/// 打包为 ZIP 字节。图片先写入 `assets/`，再写 `{id}-{安全标题}.md`。
pub fn zip_entries(entries: &[ExportEntry]) -> Result<Vec<u8>, ToolError> {
    let mut names: HashMap<String, u32> = HashMap::new();
    let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);

    // Deduplicate images: several notes usually reference the same asset.
    let mut written_assets: HashSet<String> = HashSet::new();
    for entry in entries {
        for asset in &entry.assets {
            let name = format!("assets/{}", asset.name);
            if !written_assets.insert(name.clone()) {
                continue;
            }
            zip.start_file(name, options).map_err(zip_error)?;
            zip.write_all(&asset.bytes).map_err(zip_error)?;
        }
    }

    for entry in entries {
        let base = format!("{}-{}", entry.id, safe_file_name(&entry.title));
        let count = names.entry(base.clone()).or_insert(0);
        *count += 1;
        // No extension fallback: a document without one stays extension-less.
        let name = match (entry.ext.is_empty(), *count) {
            (false, 1) => format!("{base}.{}", entry.ext),
            (false, count) => format!("{base}-{count}.{}", entry.ext),
            (true, 1) => base,
            (true, count) => format!("{base}-{count}"),
        };
        zip.start_file(name, options).map_err(zip_error)?;
        zip.write_all(entry.markdown.as_bytes()).map_err(zip_error)?;
    }

    zip.finish()
        .map(|cursor| cursor.into_inner())
        .map_err(zip_error)
}

fn zip_error(error: impl std::fmt::Display) -> ToolError {
    ToolError::Storage {
        message: format!("导出 ZIP 写入失败: {error}"),
    }
}

/// Archive entry base name: dots are reserved for the extension separator, so
/// they cannot appear in the title part.
fn safe_file_name(title: &str) -> String {
    let cleaned: String = title
        .chars()
        .map(|c| {
            if c.is_control() || "\\/:*?\"<>|.".contains(c) {
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
