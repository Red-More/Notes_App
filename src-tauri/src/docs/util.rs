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
    /// Persisted extension (case preserved, no dot); empty means "no extension".
    pub ext: String,
    pub head_rev: i64,
    pub pinned: i64,
    pub ctime: String,
    pub mtime: String,
    pub deleted_at: Option<String>,
    pub content: String,
}

const DOC_COLUMNS: &str = "i.inode, i.path, i.head_rev, i.pinned, i.ctime, i.mtime, i.deleted_at,
                           COALESCE(b.content, ''), i.ext";

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
///
/// `forbid_dots` applies the file-name rule (the dot separates the extension);
/// folder names keep dots, they have no extension semantics.
pub(super) fn safe_segment(value: &str, fallback: &str, forbid_dots: bool) -> String {
    let cleaned: String = value
        .chars()
        .map(|c| {
            if c.is_control() || "/\\:*?\"<>|".contains(c) || (forbid_dots && c == '.') {
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

/// 为已存在的文件生成不冲突的新路径，保留原文件名的基名与扩展名。
///
/// `ext` 为空表示文档没有扩展名；冲突时在基名后插入 `-n`，因此
/// `archive` + `tar.gz` 变成 `archive-1.tar.gz`，不会被改写成 `.md`。
pub(super) fn unique_file_path(
    conn: &Connection,
    dir: &str,
    base: &str,
    ext: &str,
) -> Result<String, ToolError> {
    for n in 1..=9999 {
        let candidate_name = match (ext.is_empty(), n) {
            (false, 1) => format!("{base}.{ext}"),
            (false, n) => format!("{base}-{n}.{ext}"),
            (true, 1) => base.to_string(),
            (true, n) => format!("{base}-{n}"),
        };
        let candidate = format!("{dir}/{candidate_name}");
        if !path_exists(conn, &candidate)? {
            return Ok(candidate);
        }
    }
    Err(ToolError::invalid("同名文档过多，无法生成唯一路径"))
}

/// 按持久化扩展名拆分文件名：`base` 是去掉 `.{ext}` 后缀的名称。
///
/// 扩展名为空时整个文件名就是基名，所以 `v1.2` 不会被拆成 `v1` + `2`。
pub(super) fn split_name<'a>(name: &'a str, ext: &str) -> &'a str {
    if ext.is_empty() {
        return name;
    }
    let suffix_len = ext.len() + 1;
    if name.len() > suffix_len {
        let (base, suffix) = name.split_at(name.len() - suffix_len);
        if suffix.starts_with('.') && suffix[1..].eq_ignore_ascii_case(ext) {
            return base;
        }
    }
    name
}

/// Same as [`normalize_extension`] but an empty value means "no extension".
pub(super) fn normalize_extension_or_empty(raw: &str) -> Result<String, ToolError> {
    if raw.trim().trim_start_matches('.').is_empty() {
        return Ok(String::new());
    }
    normalize_extension(raw)
}

/// Validate one user-supplied base name (no extension).
///
/// Mirrors the frontend rules so a hand-crafted command cannot store a name
/// Windows cannot represent. The extension is validated separately and may
/// contain dots.
///
/// `allow_dots` is false for notes, whose base name must not shadow the
/// extension separator, and true for free-text names such as a contact
/// ("Dr. Smith-c_ab12"). Dots are the only character released: path separators
/// and control characters stay errors either way.
pub(super) fn validate_file_name(name: &str, allow_dots: bool) -> Result<String, ToolError> {
    let name = name.trim();
    if name.is_empty() {
        return Err(ToolError::invalid("文件名不能为空"));
    }
    if name.chars().count() > 120 {
        return Err(ToolError::invalid("文件名最多 120 个字符"));
    }
    if name.chars().any(|c| c.is_control() || "/\\:*?\"<>|".contains(c)) {
        return Err(ToolError::invalid("文件名不能包含 / \\ : * ? \" < > | 等字符"));
    }
    if allow_dots {
        // A trailing dot would merge into the extension separator.
        if name.ends_with('.') {
            return Err(ToolError::invalid("文件名不能以点结尾"));
        }
    } else if name.contains('.') {
        return Err(ToolError::invalid("文件名不能包含点号，扩展名请单独填写"));
    }
    if name.ends_with(' ') {
        return Err(ToolError::invalid("文件名不能以空格结尾"));
    }
    let stem = name.split('.').next().unwrap_or(name).to_ascii_uppercase();
    const RESERVED: &[&str] = &[
        "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7",
        "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    ];
    if RESERVED.contains(&stem.as_str()) {
        return Err(ToolError::invalid("该文件名是系统保留名称"));
    }
    Ok(name.to_string())
}

/// Normalize a user-supplied extension (accepts a leading dot).
///
/// The extension may contain further dots (`tar.gz`); its case is preserved
/// exactly as typed. Whitespace, separators and a trailing dot are rejected.
pub(super) fn normalize_extension(raw: &str) -> Result<String, ToolError> {
    let ext = raw.trim().trim_start_matches('.');
    if ext.is_empty() || ext.chars().count() > 16 {
        return Err(ToolError::invalid("扩展名长度必须在 1–16 个字符之间"));
    }
    if ext.ends_with('.')
        || ext
            .chars()
            .any(|c| c.is_control() || c.is_whitespace() || "/\\:*?\"<>|".contains(c))
    {
        return Err(ToolError::invalid(
            "扩展名不能包含空格、结尾点或 / \\ : * ? \" < > | 等字符",
        ));
    }
    Ok(ext.to_string())
}

/// Extensions whose bytes cannot round-trip through a UTF-8 document.
///
/// Creating one would silently corrupt the file on save/export, so the document
/// API rejects them instead of storing a textual placeholder.
const BINARY_EXTENSIONS: &[&str] = &[
    "pdf", "doc", "docx", "odt", "rtf", "xls", "xlsx", "ods", "ppt", "pptx", "odp", "epub",
    "zip", "gz", "tgz", "bz2", "xz", "tar", "7z", "rar", "png", "jpg", "jpeg", "gif", "webp",
    "bmp", "tif", "tiff", "heic", "ico", "mp3", "wav", "flac", "ogg", "m4a", "mp4", "mov", "avi",
    "mkv", "webm", "exe", "dll", "so", "dylib", "bin", "iso", "dmg", "msi", "apk", "woff",
    "woff2", "ttf", "otf", "sqlite", "db",
];

/// Reject document extensions that cannot be stored as text.
///
/// Multi-part extensions are checked by their last segment too, so
/// `backup.tar.gz` is rejected like `.gz`.
pub(super) fn ensure_text_extension(ext: &str) -> Result<(), ToolError> {
    if ext.is_empty() {
        return Ok(());
    }
    let lower = ext.to_ascii_lowercase();
    let last = lower.rsplit('.').next().unwrap_or(lower.as_str());
    if BINARY_EXTENSIONS.contains(&lower.as_str()) || BINARY_EXTENSIONS.contains(&last) {
        return Err(ToolError::invalid(format!(
            "不支持创建二进制文档（.{ext}），请改用附件导入"
        )));
    }
    Ok(())
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

/// Case-insensitive existence check: Windows and macOS hosts cannot tell
/// `A.md` from `a.md`, so the virtual namespace must not either.
fn path_exists(conn: &Connection, path: &str) -> Result<bool, ToolError> {
    let exists: i64 = conn.query_row(
        "SELECT COUNT(*) FROM inodes WHERE lower(path) = lower(?1)",
        params![path],
        |r| r.get(0),
    )?;
    Ok(exists > 0)
}

/// 校验 folder_id 指向 /life/notes 下的目录，返回其虚拟路径。
pub(super) fn folder_path(conn: &Connection, folder_id: i64) -> Result<String, ToolError> {
    let row: Option<(String, String)> = conn
        .query_row(
            "SELECT kind, path FROM inodes WHERE inode = ?1 AND status = 'active'",
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
            "SELECT kind, path FROM inodes WHERE inode = ?1 AND status = 'active'",
            params![folder_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    match row {
        Some((kind, path)) if kind == "directory" && path.starts_with("/life/") => Ok(path),
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
         LEFT JOIN dir_titles m ON m.inode = i.inode
         WHERE i.kind = 'directory' AND i.status = 'active' AND i.path LIKE '/life/notes/%'",
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
        " AND i.status = 'active'"
    };
    let sql = format!(
        "SELECT {DOC_COLUMNS}
         FROM inodes i
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
        " AND i.status = 'active'"
    };
    let sql = format!(
        "SELECT {DOC_COLUMNS}
         FROM inodes i
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
        content: r.get(7)?,
        ext: r.get(8)?,
    })
}

/// 把 DocRow 组装成前端 DTO。
pub(super) fn doc_from_row(row: DocRow, folders: &HashMap<String, (i64, String)>) -> Doc {
    // Raw documents keep their bytes verbatim: parsing them as Markdown would
    // strip a leading `---` or treat a shebang as a heading. The persisted
    // extension decides, so a dotted contact name is never re-split.
    let is_markdown = meta::is_markdown_ext(&row.ext);
    let parts = if is_markdown {
        meta::parse_document(&row.content)
    } else {
        meta::DocumentParts {
            body: row.content,
            ..Default::default()
        }
    };
    let kind = meta::doc_kind(&parts, &row.path);
    let title = meta::doc_title(&parts, &row.path, &row.ext);
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
        ext: row.ext,
        kind,
        format: if is_markdown { "markdown" } else { "raw" }.to_string(),
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

/// 路径的最后一段，保留扩展名（与 Unix `basename` 语义一致）。
///
/// 不剥离扩展名，因此 `archive.tar.gz`、`v1.2` 这类名字不会被截断。
pub(super) fn basename(path: &str) -> &str {
    Path::new(path)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or(path)
}

/// 去掉持久化扩展名后的名称，用于文档标题与人物标识。
///
/// 扩展名为空时返回完整文件名，因此 `v1.2` 这类含点标题不会被截断。
pub(super) fn stem<'a>(path: &'a str, ext: &str) -> &'a str {
    split_name(basename(path), ext)
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

#[cfg(test)]
mod tests {
    use super::{basename, split_name, stem};

    #[test]
    fn basename_keeps_multi_part_extensions() {
        assert_eq!(basename("/life/notes/archive.tar.gz"), "archive.tar.gz");
        assert_eq!(basename("/life/notes/v1.2"), "v1.2");
        assert_eq!(basename("/life/notes"), "notes");
    }

    #[test]
    fn split_name_uses_the_persisted_extension() {
        assert_eq!(split_name("archive.tar.gz", "tar.gz"), "archive");
        assert_eq!(split_name("report.md", "md"), "report");
        assert_eq!(split_name("report.MD", "md"), "report");
        // No extension: every dot belongs to the title.
        assert_eq!(split_name("v1.2", ""), "v1.2");
        // A suffix that does not match the stored extension is part of the name.
        assert_eq!(split_name("notes.2026", "md"), "notes.2026");
        assert_eq!(split_name(".gitignore", "gitignore"), ".gitignore");
    }

    #[test]
    fn stem_strips_only_the_stored_extension() {
        assert_eq!(stem("/life/notes/archive.tar.gz", "tar.gz"), "archive");
        assert_eq!(stem("/life/notes/report.md", "md"), "report");
        assert_eq!(stem("/life/notes/v1.2", ""), "v1.2");
        assert_eq!(stem("/life/notes/noext", ""), "noext");
    }
}
