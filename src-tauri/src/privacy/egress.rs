//! The single egress gate (Phase A).
//!
//! Every cloud chat request passes through `guard` before any HTTP call.
//! The decision is fail-closed: S0 and un-redacted S1 payloads are rejected,
//! and each decision is written to `egress_audit` with counts only.

use std::collections::{BTreeMap, BTreeSet};

use rusqlite::{params, Connection};
use serde::Serialize;
use serde_json::Value;

use super::policy::{Level, Snapshot};
use super::recognizers;
use crate::vfs::cap_gate;

/// Tools whose arguments name a document path.
const FS_TOOL_PREFIX: &str = "fs_";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Decision {
    /// Effective level = max(declared, detected).
    pub level: i64,
    pub declared: i64,
    pub detected: i64,
    pub paths: Vec<String>,
    /// Entity kind -> occurrence count. Never contains any value.
    pub entity_kinds: BTreeMap<String, usize>,
    /// `allow` or `block`.
    pub decision: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    pub bytes: i64,
}

impl Decision {
    pub fn blocked(&self) -> bool {
        self.decision == "block"
    }
}

/// Judge one outgoing transcript. Pure computation: the snapshot already holds
/// labels and decrypted entities, so no database access happens here.
pub fn guard(messages: &[Value], snapshot: &Snapshot) -> Decision {
    let mut text = String::new();
    for message in messages {
        collect_text(message, &mut text);
    }
    let bytes = text.len() as i64;

    let mut kinds: BTreeMap<String, usize> = BTreeMap::new();
    let mut detected = Level::S2;
    for span in recognizers::scan(&text) {
        *kinds.entry(span.kind.as_str().to_string()).or_default() += 1;
        detected = detected.most_sensitive(span.kind.level());
    }

    let normalized = recognizers::normalize_generic(&text);
    for entity in &snapshot.entities {
        if normalized.contains(&entity.normalized) {
            *kinds.entry(entity.kind.as_str().to_string()).or_default() += 1;
            detected = detected.most_sensitive(entity.kind.level());
        }
    }

    let paths = referenced_paths(messages);
    let declared = paths
        .iter()
        .map(|path| snapshot.declared_level(path))
        .fold(Level::S2, |acc, level| acc.most_sensitive(level));

    let level = declared.most_sensitive(detected);
    let (decision, code, message) = verdict(level, declared, detected, &paths, &kinds);

    Decision {
        level: level.as_i64(),
        declared: declared.as_i64(),
        detected: detected.as_i64(),
        paths,
        entity_kinds: kinds,
        decision,
        code,
        message,
        bytes,
    }
}

/// Judge a plain-text payload that has no document-path provenance (media jobs).
/// Declared level stays S2 because there is no path reference, but recognizers
/// and configured entities still apply, so sensitive text is blocked before upload.
pub fn guard_text(text: &str, snapshot: &Snapshot) -> Decision {
    let message = serde_json::json!({
        "role": "user",
        "content": [{ "type": "text", "text": text }],
    });
    guard(&[message], snapshot)
}

fn verdict(
    level: Level,
    declared: Level,
    detected: Level,
    paths: &[String],
    kinds: &BTreeMap<String, usize>,
) -> (String, Option<String>, Option<String>) {
    match level {
        Level::S2 => ("allow".into(), None, None),
        Level::S1 => (
            "block".into(),
            Some("s1_unredacted".into()),
            Some(format!(
                "隐私拦截：本次请求包含尚未脱敏的敏感内容（{}）。当前版本尚未启用脱敏外发，已阻止发送到云端。可将相关路径在「设置 → 数据分级」中标记为 S2，或移除敏感内容后重试。",
                describe(declared, detected, paths, kinds)
            )),
        ),
        Level::S0 => (
            "block".into(),
            Some("s0".into()),
            Some(format!(
                "隐私拦截：本次请求涉及 S0 级敏感数据（{}），按隐私策略禁止发送到云端。",
                describe(declared, detected, paths, kinds)
            )),
        ),
    }
}

/// Human-readable, value-free description used in both the UI error and logs.
fn describe(
    declared: Level,
    detected: Level,
    paths: &[String],
    kinds: &BTreeMap<String, usize>,
) -> String {
    let mut parts = Vec::new();
    if declared < Level::S2 {
        parts.push(format!("路径 {}", paths.join("、")));
    }
    if detected < Level::S2 {
        let items: Vec<String> = kinds
            .iter()
            .map(|(kind, count)| format!("{kind}×{count}"))
            .collect();
        parts.push(format!("检测到 {}", items.join("、")));
    }
    parts.join("；")
}

/// Extract document paths from `fs_*` tool-call arguments.
/// Plain-text tokens are deliberately ignored: the system prompt itself
/// mentions `/life/...` examples and must not raise the declared level.
fn referenced_paths(messages: &[Value]) -> Vec<String> {
    let mut paths = BTreeSet::new();
    for message in messages {
        let Some(items) = message.get("content").and_then(Value::as_array) else {
            continue;
        };
        for item in items {
            if item.get("type").and_then(Value::as_str) != Some("toolCall") {
                continue;
            }
            let name = item.get("name").and_then(Value::as_str).unwrap_or("");
            if !name.starts_with(FS_TOOL_PREFIX) {
                continue;
            }
            let Some(args) = item.get("arguments") else {
                continue;
            };
            match name {
                "fs_read" | "fs_edit" | "fs_write" => {
                    if let Some(path) = args.get("path").and_then(Value::as_str) {
                        if let Some(path) = normalize_ref(path) {
                            paths.insert(path);
                        }
                    }
                }
                "fs_glob" => {
                    let pattern = args.get("pattern").and_then(Value::as_str).unwrap_or("");
                    let root = args.get("root").and_then(Value::as_str);
                    if let Some(scope) = glob_scope(pattern, root) {
                        paths.insert(scope);
                    }
                }
                "fs_grep" => {
                    // `pattern` is the search text, not a path; the optional
                    // `path` limits the search scope. No path means all of /life.
                    let scope = args
                        .get("path")
                        .and_then(Value::as_str)
                        .unwrap_or("/life");
                    if let Some(scope) = normalize_ref(scope) {
                        paths.insert(scope);
                    }
                }
                _ => {}
            }
        }
    }
    paths.into_iter().collect()
}

/// Resolve a glob into the directory scope it can reach.
/// Relative patterns are anchored at `root` (defaults to `/life`).
fn glob_scope(pattern: &str, root: Option<&str>) -> Option<String> {
    if pattern.is_empty() {
        return None;
    }
    let combined = if pattern.starts_with('/') {
        pattern.to_string()
    } else {
        let root = root.unwrap_or("/life").trim_end_matches('/');
        format!("{root}/{pattern}")
    };
    normalize_ref(&combined)
}

/// Normalize a tool argument into a label lookup scope.
/// A glob pattern is cut at its first wildcard so `/life/diary/*.md`
/// resolves to the `/life/diary` label.
fn normalize_ref(raw: &str) -> Option<String> {
    let raw = raw.trim().trim_matches(|c| matches!(c, '"' | '\'' | '`'));
    if raw.is_empty() {
        return None;
    }
    let cut = raw.find(['*', '?', '[']).unwrap_or(raw.len());
    let scope = raw[..cut].trim_end_matches('/');
    let scope = if scope.is_empty() { raw } else { scope };
    cap_gate::normalize_path(scope).ok()
}

/// Walk JSON values and concatenate every string. Image blocks are skipped
/// because their base64 payload is not user text and would be enormous.
fn collect_text(value: &Value, out: &mut String) {
    match value {
        Value::String(text) => {
            out.push_str(text);
            out.push('\n');
        }
        Value::Array(items) => {
            for item in items {
                collect_text(item, out);
            }
        }
        Value::Object(map) => {
            if map.get("type").and_then(Value::as_str) == Some("image") {
                return;
            }
            for (key, item) in map {
                if key == "data" || key == "mimeType" {
                    continue;
                }
                collect_text(item, out);
            }
        }
        _ => {}
    }
}

/// Append one audit row. Counts and sizes only, never document text.
pub fn record_audit(
    conn: &Connection,
    target: &str,
    purpose: &str,
    decision: &Decision,
) -> rusqlite::Result<()> {
    let kinds = serde_json::to_string(&decision.entity_kinds).unwrap_or_else(|_| "{}".into());
    conn.execute(
        "INSERT INTO egress_audit (created_at, target, purpose, entity_kinds, bytes, decision)
         VALUES (datetime('now','localtime'), ?1, ?2, ?3, ?4, ?5)",
        params![target, purpose, kinds, decision.bytes, decision.decision],
    )?;
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditRecord {
    pub id: i64,
    pub created_at: String,
    pub target: String,
    pub purpose: String,
    pub entity_kinds: String,
    pub bytes: i64,
    pub decision: String,
}

pub fn list_audit(conn: &Connection, limit: usize) -> Result<Vec<AuditRecord>, rusqlite::Error> {
    let limit = limit.clamp(1, 200) as i64;
    let mut stmt = conn.prepare(
        "SELECT id, created_at, target, purpose, entity_kinds, bytes, decision
         FROM egress_audit ORDER BY id DESC LIMIT ?1",
    )?;
    let rows = stmt.query_map(params![limit], |r| {
        Ok(AuditRecord {
            id: r.get(0)?,
            created_at: r.get(1)?,
            target: r.get(2)?,
            purpose: r.get(3)?,
            entity_kinds: r.get(4)?,
            bytes: r.get(5)?,
            decision: r.get(6)?,
        })
    })?;
    rows.collect()
}
