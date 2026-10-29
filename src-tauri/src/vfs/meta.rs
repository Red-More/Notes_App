//! frontmatter 解析与 meta 镜像维护。
//!
//! 文档模型规定每个 Markdown 文件头部可带 `--- ... ---`，VirtualFs 在每次
//! write/edit 的同一事务里把 kind/title/status/due/tags 抄进 `meta` 表，
//! 供后续结构化查询使用。这里只做够用的行解析，不引入 YAML 依赖。

use rusqlite::{params, Connection};
use serde_json::{Map, Value};

/// 解析后的 frontmatter 字段。
#[derive(Debug, Default)]
pub struct ParsedFrontmatter {
    pub kind: Option<String>,
    pub title: Option<String>,
    pub status: Option<String>,
    pub due: Option<String>,
    /// 规范化后的逗号分隔标签，例如 `日语,学习,复盘`。
    pub tags: Option<String>,
    /// 未知字段原样收进 JSON，避免丢信息。
    pub extra: String,
}

/// 解析文件头 frontmatter；没有完整 `--- ... ---` 块时返回 None。
fn parse(content: &str) -> Option<ParsedFrontmatter> {
    let mut lines = content.lines();
    if lines.next()?.trim() != "---" {
        return None;
    }

    let mut parsed = ParsedFrontmatter::default();
    let mut extra: Map<String, Value> = Map::new();
    let mut closed = false;
    for line in lines {
        if line.trim() == "---" {
            closed = true;
            break;
        }
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        let key = key.trim();
        let value = unquote(value.trim());
        match key {
            "kind" => set_if_not_empty(&mut parsed.kind, value),
            "title" => set_if_not_empty(&mut parsed.title, value),
            "status" => set_if_not_empty(&mut parsed.status, value),
            "due" => set_if_not_empty(&mut parsed.due, value),
            "tags" => parsed.tags = normalize_tags(&value),
            _ if !key.is_empty() => {
                extra.insert(key.to_string(), Value::String(value));
            }
            _ => {}
        }
    }

    if !closed {
        return None;
    }
    parsed.extra = Value::Object(extra).to_string();
    Some(parsed)
}

/// 文件是否已经带有可解析的 frontmatter。
pub fn has_frontmatter(content: &str) -> bool {
    parse(content).is_some()
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

/// 自动补 frontmatter（仅 write 且文件原本没有头部时调用）。
pub fn prepend(path: &str, content: &str, now: &str) -> String {
    let kind = infer_kind(path);
    let title = infer_title(path, content);
    format!(
        "---\nkind: {kind}\ntitle: {}\ncreated_at: {now}\nupdated_at: {now}\n---\n\n{content}",
        yaml_scalar(&title)
    )
}

/// 在同一事务里 upsert `meta` 镜像。解析失败时使用路径推断的缺省值。
pub fn upsert(conn: &Connection, inode: i64, path: &str, content: &str) -> rusqlite::Result<()> {
    let parsed = parse(content);
    let kind = parsed
        .as_ref()
        .and_then(|p| p.kind.clone())
        .unwrap_or_else(|| infer_kind(path).to_string());
    let title = parsed
        .as_ref()
        .and_then(|p| p.title.clone())
        .unwrap_or_else(|| infer_title(path, content));
    let status = parsed.as_ref().and_then(|p| p.status.clone());
    let due = parsed.as_ref().and_then(|p| p.due.clone());
    let tags = parsed.as_ref().and_then(|p| p.tags.clone());
    let extra = parsed
        .as_ref()
        .map(|p| p.extra.clone())
        .unwrap_or_else(|| "{}".to_string());

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
        params![inode, kind, title, status, due, tags, extra],
    )?;
    Ok(())
}

fn set_if_not_empty(slot: &mut Option<String>, value: String) {
    if !value.is_empty() {
        *slot = Some(value);
    }
}

/// 去掉 YAML 单/双引号，并对双引号内的转义做最小还原。
fn unquote(value: &str) -> String {
    if value.len() < 2 {
        return value.to_string();
    }
    let first = value.as_bytes()[0];
    let last = value.as_bytes()[value.len() - 1];
    if first == b'"' && last == b'"' {
        return unescape_double(&value[1..value.len() - 1]);
    }
    if first == b'\'' && last == b'\'' {
        return value[1..value.len() - 1].to_string();
    }
    value.to_string()
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

/// 把 `[a, b]` / `a, b` 统一成 `a,b`；空列表返回 None。
fn normalize_tags(value: &str) -> Option<String> {
    let inner = value
        .trim()
        .trim_start_matches('[')
        .trim_end_matches(']');
    let tags: Vec<String> = inner
        .split(',')
        .map(|tag| unquote(tag.trim()))
        .filter(|tag| !tag.is_empty())
        .collect();
    if tags.is_empty() {
        None
    } else {
        Some(tags.join(","))
    }
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

/// 生成 YAML 双引号标量，转义反斜杠、双引号与换行。
fn yaml_scalar(value: &str) -> String {
    let escaped = value
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\n', "\\n");
    format!("\"{escaped}\"")
}
