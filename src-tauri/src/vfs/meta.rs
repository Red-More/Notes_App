//! frontmatter 解析与组装。
//!
//! 文档模型规定每个 Markdown 文件头部可带 `--- ... ---`。本模块负责：
//! - 把任意 frontmatter 解析成 `DocumentParts`（kind/title/时间戳 + 通用字段 + 正文）；
//! - 把结构化字段重新组装成 Markdown；
//! - 为列表/搜索提供「从正文推导 kind/title」的纯函数。
//!
//! Frontmatter 只存在于 Markdown 正文里（YAML），数据库不建镜像表：
//! 基础属性（id/路径/时间/哈希/状态）在 `inodes`，frontmatter 随文件走。
//!
//! # Ownership
//!
//! Only `created_at` and `updated_at` are system-owned: they are validated and
//! rewritten on every write (`created_at` from `inodes.ctime`, `updated_at`
//! from the clock). Every other key, including `kind`, `title`, `tags` and any
//! user-defined field, is owned by the user: the system neither validates nor
//! rewrites it. [`DocumentParts::fields`] is the pass-through view reserved for
//! the future tag system; no field schema is enforced today.
//!
//! 不引入 YAML 依赖：只支持单行 `key: value`、引号字符串、布尔/数字与内联数组，
//! 足以覆盖当前全部文档类型，同时保持字段可扩展。

use std::collections::BTreeMap;

use serde_json::Value;

/// 解析后的文档结构。
#[derive(Debug, Default, Clone)]
pub struct DocumentParts {
    pub kind: Option<String>,
    pub title: Option<String>,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
    /// 规范化后的逗号分隔标签（合并 tags 数组与单值 tag 字段）。
    pub tags: Option<String>,
    /// frontmatter 中除 kind/title/created_at/updated_at 外的全部字段。
    ///
    /// User-owned pass-through data: used verbatim by the UI/Agent and reserved
    /// as the storage of the future tag system (no schema is enforced).
    pub fields: BTreeMap<String, Value>,
    /// 正文（不含 frontmatter）。
    pub body: String,
    pub has_frontmatter: bool,
}

/// 解析 Markdown 文档。没有完整 `--- ... ---` 块时，正文即全文。
pub fn parse_document(content: &str) -> DocumentParts {
    let content = content.strip_prefix('\u{feff}').unwrap_or(content);
    let mut parts = DocumentParts {
        body: content.to_string(),
        ..Default::default()
    };

    let mut lines = content.split_inclusive('\n');
    let Some(first) = lines.next() else {
        return parts;
    };
    if first.trim_end_matches(['\r', '\n']).trim() != "---" {
        return parts;
    }

    let mut offset = first.len();
    let mut closed = false;
    let mut raw: Vec<&str> = Vec::new();
    for line in lines {
        let text = line.trim_end_matches(['\r', '\n']);
        offset += line.len();
        if text.trim() == "---" {
            closed = true;
            break;
        }
        raw.push(text);
    }
    if !closed {
        return parts;
    }

    parts.has_frontmatter = true;
    let rest = &content[offset..];
    // frontmatter 与正文之间通常有一个空行；只吃掉一个换行，保留正文原貌。
    parts.body = rest.strip_prefix('\n').unwrap_or(rest).to_string();

    for line in raw {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        let key = key.trim();
        let value = parse_value(value.trim());
        match key {
            "kind" => parts.kind = non_empty_string(&value),
            "title" => parts.title = string_value(&value),
            "created_at" | "created" => {
                parts.created_at = non_empty_string(&value);
            }
            "updated_at" | "updated" => {
                parts.updated_at = non_empty_string(&value);
            }
            "" => {}
            _ if is_safe_key(key) => {
                parts.fields.insert(key.to_string(), value);
            }
            _ => {}
        }
    }

    parts.tags = tags_from_fields(&parts.fields);
    parts
}

/// 把结构化字段组装成 Markdown。`body` 是纯正文。
///
/// Creation only: every key here comes from user input (title/kind/fields), so
/// re-rendering an existing document must use [`rewrite_document`] instead.
pub fn compose(
    kind: &str,
    title: &str,
    created_at: &str,
    updated_at: &str,
    fields: &BTreeMap<String, Value>,
    body: &str,
) -> String {
    let mut out = String::from("---\n");
    out.push_str(&format!("kind: {}\n", yaml_scalar(kind)));
    out.push_str(&format!("title: {}\n", yaml_scalar(title)));
    out.push_str(&format!("created_at: {}\n", yaml_scalar(created_at)));
    out.push_str(&format!("updated_at: {}\n", yaml_scalar(updated_at)));
    for (key, value) in fields {
        if value.is_null() || !is_safe_key(key) {
            continue;
        }
        if matches!(key.as_str(), "kind" | "title" | "created_at" | "updated_at") {
            continue;
        }
        out.push_str(&format!("{key}: {}\n", yaml_value(value)));
    }
    out.push_str("---\n");
    if !body.is_empty() {
        out.push('\n');
        out.push_str(body);
    }
    out
}

/// Whether a key is a system-owned date (`created` / `updated` are accepted as
/// aliases so user variants are normalized instead of duplicated).
fn is_date_key(key: &str) -> bool {
    matches!(key, "created_at" | "created" | "updated_at" | "updated")
}

/// Refresh the two system-owned dates and leave every other byte intact.
pub fn sync_system_dates(content: &str, created_at: &str, updated_at: &str) -> String {
    rewrite_document(content, None, &BTreeMap::new(), created_at, updated_at)
}

/// Rewrite selected frontmatter keys and/or the body while preserving every
/// other line (comments, ordering, quoting, unknown keys and the body).
///
/// `updates` are user-owned attributes: `Value::Null` removes the key, any
/// other value replaces only that line. The two system-owned dates always come
/// from the arguments, so a caller edit to them never takes effect.
///
/// This single-writer entry point is where the future tag system will hook in:
/// user fields already round-trip untouched, so adding a schema later does not
/// change storage.
pub fn rewrite_document(
    content: &str,
    body: Option<&str>,
    updates: &BTreeMap<String, Value>,
    created_at: &str,
    updated_at: &str,
) -> String {
    let updates: BTreeMap<String, Value> = updates
        .iter()
        .filter(|(key, _)| is_safe_key(key) && !is_date_key(key))
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect();

    match split_frontmatter(content) {
        Some(block) => {
            let header = render_header(&block.lines, &updates, created_at, updated_at);
            let mut out = String::with_capacity(content.len() + 96);
            out.push_str(block.bom);
            out.push_str(block.open);
            for line in header {
                out.push_str(&line);
                out.push_str(block.eol);
            }
            out.push_str(block.close);
            let Some(new_body) = body else {
                out.push_str(block.rest);
                return out;
            };
            if !block.close.ends_with('\n') {
                out.push_str(block.eol);
            }
            // Keep the blank line that separates the closing fence from the body.
            if block.rest.starts_with("\r\n") {
                out.push_str("\r\n");
            } else if block.rest.starts_with('\n') {
                out.push('\n');
            }
            out.push_str(new_body);
            out
        }
        None => {
            // No frontmatter yet: create one holding only the system dates plus
            // the caller's explicit updates. The original content is the body.
            let bom = if content.starts_with('\u{feff}') {
                "\u{feff}"
            } else {
                ""
            };
            let source = content.strip_prefix('\u{feff}').unwrap_or(content);
            let new_body = body.unwrap_or(source);
            let header = render_header(&[], &updates, created_at, updated_at);
            let mut out = String::with_capacity(content.len() + 96);
            out.push_str(bom);
            out.push_str("---\n");
            for line in header {
                out.push_str(&line);
                out.push('\n');
            }
            out.push_str("---\n");
            if !new_body.is_empty() {
                out.push('\n');
                out.push_str(new_body);
            }
            out
        }
    }
}

/// Line-oriented view of an existing `--- ... ---` block. Every slice borrows
/// the original document so untouched lines can be replayed byte-for-byte.
struct FrontmatterBlock<'a> {
    /// Leading BOM, emptied when the document has none.
    bom: &'a str,
    /// Opening fence line (including its line ending).
    open: &'a str,
    /// Line ending used for rewritten lines.
    eol: &'a str,
    /// Raw header lines (including their line endings).
    lines: Vec<&'a str>,
    /// Closing fence line (including its line ending).
    close: &'a str,
    /// Everything after the closing fence line.
    rest: &'a str,
}

fn split_frontmatter(content: &str) -> Option<FrontmatterBlock<'_>> {
    let (bom, text) = match content.strip_prefix('\u{feff}') {
        Some(rest) => ("\u{feff}", rest),
        None => ("", content),
    };
    let mut lines = text.split_inclusive('\n');
    let open = lines.next()?;
    if open.trim_end_matches(['\r', '\n']).trim() != "---" {
        return None;
    }
    let eol = if open.ends_with("\r\n") { "\r\n" } else { "\n" };
    let mut offset = open.len();
    let mut header = Vec::new();
    for line in lines {
        offset += line.len();
        if line.trim_end_matches(['\r', '\n']).trim() == "---" {
            return Some(FrontmatterBlock {
                bom,
                open,
                eol,
                lines: header,
                close: line,
                rest: &text[offset..],
            });
        }
        header.push(line);
    }
    None
}

/// Render the header lines that must be written: untouched lines are replayed,
/// user updates replace only their own key, and the system dates are always
/// emitted (once, canonical key name).
fn render_header(
    lines: &[&str],
    updates: &BTreeMap<String, Value>,
    created_at: &str,
    updated_at: &str,
) -> Vec<String> {
    let mut rendered = Vec::with_capacity(lines.len() + 2 + updates.len());
    let mut applied: Vec<&str> = Vec::new();
    let mut created = false;
    let mut updated = false;
    for line in lines {
        let text = line.trim_end_matches(['\r', '\n']);
        match header_key(text) {
            Some(key) if key == "created_at" || key == "created" => {
                if !created {
                    rendered.push(format!("created_at: {}", yaml_scalar(created_at)));
                    created = true;
                }
            }
            Some(key) if key == "updated_at" || key == "updated" => {
                if !updated {
                    rendered.push(format!("updated_at: {}", yaml_scalar(updated_at)));
                    updated = true;
                }
            }
            Some(key) => {
                applied.push(key);
                match updates.get(key) {
                    Some(Value::Null) => {}
                    Some(value) => rendered.push(format!("{key}: {}", yaml_value(value))),
                    None => rendered.push(text.to_string()),
                }
            }
            None => rendered.push(text.to_string()),
        }
    }
    if !created {
        rendered.push(format!("created_at: {}", yaml_scalar(created_at)));
    }
    if !updated {
        rendered.push(format!("updated_at: {}", yaml_scalar(updated_at)));
    }
    for (key, value) in updates {
        if value.is_null() || applied.contains(&key.as_str()) {
            continue;
        }
        rendered.push(format!("{key}: {}", yaml_value(value)));
    }
    rendered
}

/// Top-level `key:` of a frontmatter line. Comments, blank lines and nested
/// (indented) keys return `None`, so they are never mistaken for user fields.
fn header_key(line: &str) -> Option<&str> {
    let trimmed = line.trim();
    let nested = line.starts_with(' ') || line.starts_with('\t');
    if trimmed.is_empty() || trimmed.starts_with('#') || nested {
        return None;
    }
    let key = trimmed.split_once(':')?.0.trim();
    if is_safe_key(key) {
        Some(key)
    } else {
        None
    }
}

/// 基于路径与正文推断文档类型，作为 frontmatter 缺省值。
pub fn infer_kind(path: &str) -> &'static str {
    let rest = path.strip_prefix("/life/").unwrap_or(path);
    match rest.split('/').next().unwrap_or("") {
        "diary" => "diary",
        "notes" => "note",
        "todos" => "todo",
        "contacts" => "contact",
        _ => "note",
    }
}

/// The single source of truth for "which documents keep a version history".
/// Notes and diary entries are versioned; todos and contacts are not.
pub fn is_versioned(kind: &str) -> bool {
    matches!(kind, "note" | "diary")
}

/// Extensions stored and rendered as Markdown; everything else is raw text.
///
/// Callers must use the **persisted** `inodes.ext`: a base name may contain dots
/// (a contact is `Dr. Smith-c_ab12.md`), so splitting the path would mislead.
pub fn is_markdown_ext(ext: &str) -> bool {
    matches!(
        ext.to_ascii_lowercase().as_str(),
        "md" | "markdown" | "mdown" | "mkd" | "mkdn" | "mdx"
    )
}

/// File name without its persisted extension.
///
/// The stored extension decides the split, so an extension-less `v1.2` keeps its
/// dot while `archive.tar.gz` loses all three segments. This is the same rule as
/// `docs::util::stem`, so the title never disagrees with the file name.
pub fn path_stem(path: &str, ext: &str) -> String {
    let name = path.rsplit('/').next().unwrap_or(path);
    if ext.is_empty() {
        return name.to_string();
    }
    let suffix_len = ext.len() + 1;
    if name.len() > suffix_len {
        let (base, suffix) = name.split_at(name.len() - suffix_len);
        if suffix.starts_with('.') && suffix[1..].eq_ignore_ascii_case(ext) {
            return base.to_string();
        }
    }
    name.to_string()
}

/// Document title derived from frontmatter, falling back to the file name.
pub fn doc_title(parts: &DocumentParts, path: &str, ext: &str) -> String {
    parts
        .title
        .clone()
        .filter(|title| !title.trim().is_empty())
        .unwrap_or_else(|| infer_title(path, "", ext))
}

/// Document kind derived from frontmatter, falling back to the path root.
pub fn doc_kind(parts: &DocumentParts, path: &str) -> String {
    parts
        .kind
        .clone()
        .filter(|kind| !kind.is_empty())
        .unwrap_or_else(|| infer_kind(path).to_string())
}

/// Derived todo status: the frontmatter field wins, otherwise the first
/// Markdown checkbox in the body decides.
pub fn doc_status(parts: &DocumentParts) -> Option<String> {
    status_from_fields(&parts.fields).or_else(|| status_from_checkboxes(&parts.body))
}

/// Due date written by the UI (`dueDate`) or by an Agent (`due`).
pub fn doc_due(parts: &DocumentParts) -> Option<String> {
    field_string(&parts.fields, "dueDate").or_else(|| field_string(&parts.fields, "due"))
}

/// 从字段 map 里取字符串值（数字/布尔会转成字符串）。
pub fn field_string(fields: &BTreeMap<String, Value>, key: &str) -> Option<String> {
    match fields.get(key)? {
        Value::String(s) if !s.is_empty() => Some(s.to_string()),
        Value::Number(n) => Some(n.to_string()),
        Value::Bool(b) => Some(b.to_string()),
        Value::Array(items) => {
            let joined: Vec<String> = items.iter().filter_map(value_as_string).collect();
            if joined.is_empty() {
                None
            } else {
                Some(joined.join(","))
            }
        }
        _ => None,
    }
}

/// 把 tags 数组与单值 `tag` 合并成逗号分隔串。
pub fn tags_from_fields(fields: &BTreeMap<String, Value>) -> Option<String> {
    let mut tags: Vec<String> = Vec::new();
    if let Some(value) = fields.get("tags") {
        match value {
            Value::Array(items) => {
                tags.extend(items.iter().filter_map(value_as_string));
            }
            Value::String(s) => {
                tags.extend(
                    s.trim()
                        .trim_start_matches('[')
                        .trim_end_matches(']')
                        .split(',')
                        .map(|t| t.trim().to_string())
                        .filter(|t| !t.is_empty()),
                );
            }
            _ => {}
        }
    }
    if let Some(tag) = field_string(fields, "tag") {
        tags.extend(
            tag.split(',')
                .map(|t| t.trim().to_string())
                .filter(|t| !t.is_empty()),
        );
    }
    tags.sort();
    tags.dedup();
    if tags.is_empty() {
        None
    } else {
        Some(tags.join(","))
    }
}

fn status_from_fields(fields: &BTreeMap<String, Value>) -> Option<String> {
    if let Some(status) = field_string(fields, "status") {
        return Some(status);
    }
    match fields
        .get("completed")
        .or_else(|| fields.get("isCompleted"))
    {
        Some(Value::Bool(true)) => Some("done".to_string()),
        Some(Value::Bool(false)) => Some("open".to_string()),
        Some(Value::Number(n)) => {
            let done = n.as_i64().map(|value| value != 0).unwrap_or(false);
            Some(if done { "done" } else { "open" }.to_string())
        }
        _ => None,
    }
}

/// 从 Markdown checkbox 推断待办状态：`- [x]` 视为完成，`- [ ]` 视为未完成。
/// 全部勾选返回 `done`，存在未勾选返回 `open`，没有 checkbox 返回 `None`。
fn status_from_checkboxes(body: &str) -> Option<String> {
    let mut found = false;
    let mut all_done = true;
    for line in body.lines() {
        let Some(rest) = line.trim_start().strip_prefix("- [") else {
            continue;
        };
        let mut chars = rest.chars();
        let checked = match chars.next() {
            Some(' ') => false,
            Some('x') | Some('X') => true,
            _ => continue,
        };
        if chars.next() != Some(']') {
            continue;
        }
        found = true;
        if !checked {
            all_done = false;
        }
    }
    if !found {
        return None;
    }
    Some(if all_done { "done" } else { "open" }.to_string())
}

/// 标题优先取正文第一个 Markdown 标题，否则退回文件名（不含扩展名）。
///
/// The *persisted* extension decides the split: a document without one keeps
/// every dot of its name (`v1.2` stays `v1.2`), while `archive.tar.gz` loses the
/// whole multi-part extension.
fn infer_title(path: &str, content: &str, ext: &str) -> String {
    for line in content.lines() {
        let line = line.trim();
        if let Some(heading) = line.strip_prefix('#') {
            let heading = heading.trim_start_matches('#').trim();
            if !heading.is_empty() {
                return heading.to_string();
            }
        }
    }
    let stem = path_stem(path, ext);
    if stem.is_empty() {
        "未命名".to_string()
    } else {
        stem
    }
}

fn non_empty_string(value: &Value) -> Option<String> {
    match value {
        Value::String(s) if !s.is_empty() => Some(s.to_string()),
        Value::Number(n) => Some(n.to_string()),
        Value::Bool(b) => Some(b.to_string()),
        _ => None,
    }
}

/// 允许空字符串的取值，用于 title：空标题是合法状态，不能被路径推断覆盖。
fn string_value(value: &Value) -> Option<String> {
    match value {
        Value::String(s) => Some(s.to_string()),
        Value::Number(n) => Some(n.to_string()),
        Value::Bool(b) => Some(b.to_string()),
        _ => None,
    }
}

fn value_as_string(value: &Value) -> Option<String> {
    match value {
        Value::String(s) if !s.is_empty() => Some(s.to_string()),
        Value::Number(n) => Some(n.to_string()),
        Value::Bool(b) => Some(b.to_string()),
        _ => None,
    }
}

fn is_safe_key(key: &str) -> bool {
    !key.is_empty()
        && key
            .chars()
            .all(|c| c.is_alphanumeric() || matches!(c, '_' | '-' | '.'))
}

fn parse_value(raw: &str) -> Value {
    let raw = raw.trim();
    if raw.is_empty() {
        return Value::String(String::new());
    }
    if raw == "null" || raw == "~" {
        return Value::Null;
    }
    if raw == "true" {
        return Value::Bool(true);
    }
    if raw == "false" {
        return Value::Bool(false);
    }
    if let Some(inner) = raw.strip_prefix('"').and_then(|s| s.strip_suffix('"')) {
        return Value::String(unescape_double(inner));
    }
    if let Some(inner) = raw.strip_prefix('\'').and_then(|s| s.strip_suffix('\'')) {
        return Value::String(inner.to_string());
    }
    if raw.starts_with('[') && raw.ends_with(']') {
        let inner = &raw[1..raw.len() - 1];
        let items: Vec<Value> = inner
            .split(',')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(parse_value)
            .collect();
        return Value::Array(items);
    }
    if raw.starts_with('{') && raw.ends_with('}') {
        if let Ok(value) = serde_json::from_str::<Value>(raw) {
            return value;
        }
    }
    if let Ok(n) = raw.parse::<i64>() {
        return Value::Number(n.into());
    }
    if let Ok(n) = raw.parse::<f64>() {
        if let Some(number) = serde_json::Number::from_f64(n) {
            return Value::Number(number);
        }
    }
    Value::String(raw.to_string())
}

fn yaml_value(value: &Value) -> String {
    match value {
        Value::Null => "null".to_string(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => n.to_string(),
        Value::String(s) => yaml_scalar(s),
        Value::Array(items) => {
            let rendered: Vec<String> = items.iter().map(yaml_value).collect();
            format!("[{}]", rendered.join(", "))
        }
        Value::Object(_) => yaml_scalar(&serde_json::to_string(value).unwrap_or_default()),
    }
}

fn yaml_scalar(value: &str) -> String {
    let escaped = value
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\n', "\\n");
    format!("\"{escaped}\"")
}

fn unescape_double(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut chars = value.chars();
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('n') => out.push('\n'),
            Some('"') => out.push('"'),
            Some('\\') => out.push('\\'),
            Some(other) => {
                out.push('\\');
                out.push(other);
            }
            None => out.push('\\'),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::path_stem;

    #[test]
    fn stem_uses_the_persisted_extension() {
        // A multi-part extension is removed whole.
        assert_eq!(path_stem("/life/notes/archive.tar.gz", "tar.gz"), "archive");
        assert_eq!(path_stem("/life/notes/report.md", "md"), "report");
        // Case of the stored extension does not matter.
        assert_eq!(path_stem("/life/notes/report.MD", "md"), "report");
        // No extension: every dot belongs to the name.
        assert_eq!(path_stem("/life/notes/v1.2", ""), "v1.2");
        // A suffix that is not the stored extension stays in the name.
        assert_eq!(path_stem("/life/notes/notes.2026", "md"), "notes.2026");
        // A contact keeps the dots of its name and only loses `.md`.
        assert_eq!(
            path_stem("/life/contacts/Dr. Smith-c_ab12.md", "md"),
            "Dr. Smith-c_ab12"
        );
    }
}
