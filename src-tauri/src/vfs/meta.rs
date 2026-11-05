//! frontmatter 解析与组装。
//!
//! 文档模型规定每个 Markdown 文件头部可带 `--- ... ---`。本模块负责：
//! - 把任意 frontmatter 解析成 `DocumentParts`（kind/title/时间戳 + 通用字段 + 正文）；
//! - 把结构化字段重新组装成 Markdown；
//! - 把 kind/title/status/due/tags 同步到 `meta` 表，其余字段进 `meta.extra` JSON。
//!
//! 不引入 YAML 依赖：只支持单行 `key: value`、引号字符串、布尔/数字与内联数组，
//! 足以覆盖当前全部文档类型，同时保持 `extra` 可扩展。

use std::collections::BTreeMap;

use rusqlite::{params, Connection};
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

/// 文件是否已经带有可解析的 frontmatter。
pub fn has_frontmatter(content: &str) -> bool {
    parse_document(content).has_frontmatter
}

/// 把结构化字段组装成 Markdown。`body` 是纯正文。
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

/// 自动补 frontmatter（仅给 `fs_write` 的通用路径使用）。
pub fn prepend(path: &str, content: &str, now: &str) -> String {
    let kind = infer_kind(path);
    let title = infer_title(path, content);
    compose(kind, &title, now, now, &BTreeMap::new(), content)
}

/// 基于路径与正文推断文档类型，作为 frontmatter 缺省值。
pub fn infer_kind(path: &str) -> &'static str {
    let rest = path.strip_prefix("/life/").unwrap_or(path);
    match rest.split('/').next().unwrap_or("") {
        "diary" => "diary",
        "notes" => "note",
        "todos" => "todo",
        "contacts" => "contact",
        "schedule" => "event",
        _ => "note",
    }
}

/// 在同一事务里 upsert `meta` 镜像。
pub fn upsert(conn: &Connection, inode: i64, path: &str, content: &str) -> rusqlite::Result<()> {
    let parts = parse_document(content);
    upsert_parts(conn, inode, path, &parts)
}

/// Same as [`upsert`] but reuses an already parsed document, so callers that
/// also refresh other mirrors can parse the rewritten markdown only once.
pub fn upsert_parts(
    conn: &Connection,
    inode: i64,
    path: &str,
    parts: &DocumentParts,
) -> rusqlite::Result<()> {
    let kind = parts
        .kind
        .clone()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| infer_kind(path).to_string());
    let title = parts
        .title
        .clone()
        .unwrap_or_else(|| infer_title(path, &parts.body));
    // Todo files may store completion as Markdown checkboxes (Agent edits) or
    // as a `completed` field (UI toggle). Frontmatter wins; otherwise derive
    // the status from the body so `meta.status` stays in sync either way.
    let status = status_from_fields(&parts.fields).or_else(|| {
        if kind == "todo" {
            status_from_checkboxes(&parts.body)
        } else {
            None
        }
    });
    let due = field_string(&parts.fields, "dueDate").or_else(|| field_string(&parts.fields, "due"));
    let extra = serde_json::to_string(&parts.fields).unwrap_or_else(|_| "{}".to_string());

    conn.execute(
        "INSERT INTO meta (inode, kind, title, status, due, tags, extra)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(inode) DO UPDATE SET
             kind = excluded.kind,
             title = excluded.title,
             status = excluded.status,
             due = excluded.due,
             tags = excluded.tags,
             extra = excluded.extra",
        params![inode, kind, title, status, due, parts.tags, extra],
    )?;
    Ok(())
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
fn infer_title(path: &str, content: &str) -> String {
    for line in content.lines() {
        let line = line.trim();
        if let Some(heading) = line.strip_prefix('#') {
            let heading = heading.trim_start_matches('#').trim();
            if !heading.is_empty() {
                return heading.to_string();
            }
        }
    }
    std::path::Path::new(path)
        .file_stem()
        .and_then(|stem| stem.to_str())
        .filter(|stem| !stem.is_empty())
        .unwrap_or("未命名")
        .to_string()
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
