//! 技能系统（M3）：技能是 `.agents/skills/<id>/SKILL.md` 文档，只进 Prompt。
//!
//! 边界：
//! - 技能不注册工具、不执行代码；新增能力 = 新增一份 SKILL.md。
//! - 模型工具不能读写 `.agents`；本模块通过 `VirtualFs::write_skill/edit_skill`
//!   这条专用入口维护技能文档，仍复用同一套事务、版本与索引。
//! - 初始 Prompt 只含摘要（name/description/triggers），正文按触发按需读取。

use std::io::{Cursor, Read};

use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::vfs::error::ToolError;
use crate::vfs::meta;
use crate::vfs::types::{EditRequest, WriteRequest, WriteSource};
use crate::vfs::VirtualFs;

const SKILLS_ROOT: &str = "/life/.agents/skills";
const SKILL_FILE: &str = "SKILL.md";
const DISABLED_KEY: &str = "skills.disabled";
/// Agent 工作区：模型可读写，但其中的草稿不会被自动加载。
const AGENT_ROOT: &str = "/life/agent";
const DRAFT_ROOT: &str = "/life/agent/skills-drafts";
const RULES_ROOT: &str = "/life/agent/rules";
/// 触发词数量与单项长度上限，与前端 `parseTriggerInput` 保持一致。
const MAX_TRIGGERS: usize = 10;
const MAX_TRIGGER_CHARS: usize = 40;
const TRIGGER_SEPARATORS: [char; 3] = [',', '，', '、'];
/// 技能包上传上限：webview 传来的 base64 解码后不得超过 2MB。
const MAX_PACKAGE_BYTES: usize = 2 * 1024 * 1024;
/// 单个 SKILL.md 解压后的上限，防止 zip bomb。
const MAX_SKILL_FILE_BYTES: u64 = 128 * 1024;

/// Prompt 索引与技能列表使用的摘要，不含正文。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillSummary {
    pub id: String,
    pub name: String,
    pub description: String,
    pub triggers: Vec<String>,
    pub scope: String,
    pub version: String,
    pub enabled: bool,
    pub builtin: bool,
}

/// 按需读取的完整技能。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillDetail {
    #[serde(flatten)]
    pub summary: SkillSummary,
    pub body: String,
}

/// 新建或更新技能的入参。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillInput {
    #[serde(default)]
    pub id: String,
    pub name: String,
    pub description: String,
    #[serde(default)]
    pub triggers: Vec<String>,
    #[serde(default)]
    pub scope: String,
    #[serde(default)]
    pub version: String,
    pub body: String,
}

fn skill_dir(id: &str) -> String {
    format!("{SKILLS_ROOT}/{id}")
}

fn skill_path(id: &str) -> String {
    format!("{SKILLS_ROOT}/{id}/{SKILL_FILE}")
}

fn draft_dir(id: &str) -> String {
    format!("{DRAFT_ROOT}/{id}")
}

fn draft_path(id: &str) -> String {
    format!("{DRAFT_ROOT}/{id}/{SKILL_FILE}")
}

/// 技能 id 只允许字母/数字与 `-_.`，避免路径穿越与隐式目录。
fn validate_id(id: &str) -> Result<String, ToolError> {
    let id = id.trim();
    if id.is_empty() || id.chars().count() > 60 {
        return Err(ToolError::invalid("技能 id 长度必须在 1–60 字符之间"));
    }
    if !id
        .chars()
        .all(|c| c.is_alphanumeric() || matches!(c, '-' | '_' | '.'))
    {
        return Err(ToolError::invalid(
            "技能 id 只能包含字母、数字与 - _ . 字符",
        ));
    }
    if id.starts_with('.') {
        return Err(ToolError::invalid("技能 id 不能以点开头"));
    }
    Ok(id.to_string())
}

fn id_from_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| match c {
            c if c.is_alphanumeric() => c,
            '-' | '_' => c,
            _ => '-',
        })
        .collect();
    let trimmed = cleaned.trim_matches('-');
    let base = if trimmed.is_empty() { "skill" } else { trimmed };
    base.chars().take(60).collect()
}

/// 解析 SKILL.md；缺少 name/description 视为非法技能，由调用方跳过。
fn parse_skill(id: &str, content: &str) -> Option<(String, SkillSummary)> {
    let parts = meta::parse_document(content);
    let name = meta::field_string(&parts.fields, "name")
        .or_else(|| parts.title.clone())
        .filter(|value| !value.trim().is_empty())?;
    let description = meta::field_string(&parts.fields, "description")
        .filter(|value| !value.trim().is_empty())?;
    let triggers = triggers_from(content, parts.fields.get("triggers"));
    let scope = meta::field_string(&parts.fields, "scope").unwrap_or_else(|| "chat".into());
    let version = meta::field_string(&parts.fields, "version").unwrap_or_else(|| "1.0".into());

    let summary = SkillSummary {
        id: id.to_string(),
        name,
        description,
        triggers,
        scope,
        version,
        enabled: true,
        // The app ships no preset skills: every skill is user-installed.
        builtin: false,
    };
    Some((parts.body, summary))
}

/// Triggers support two YAML shapes: an inline list (`[a, b]`) or a block
/// sequence (`triggers:` + `- a`). `meta::parse_document` only understands
/// single-line values, so block sequences are collected from raw frontmatter.
fn triggers_from(content: &str, inline: Option<&Value>) -> Vec<String> {
    let inline = field_list(inline);
    if !inline.is_empty() {
        return inline;
    }
    let source = content.strip_prefix('\u{feff}').unwrap_or(content);
    let mut in_frontmatter = false;
    let mut collecting = false;
    let mut result = Vec::new();
    for line in source.lines() {
        let text = line.trim();
        if !in_frontmatter {
            in_frontmatter = text == "---";
            continue;
        }
        if text == "---" {
            break;
        }
        if collecting {
            match text.strip_prefix('-') {
                Some(item) => {
                    let item = item.trim().trim_matches('"').trim_matches('\'');
                    if !item.is_empty() {
                        result.push(item.to_string());
                    }
                    continue;
                }
                None => break,
            }
        }
        if let Some(rest) = text.strip_prefix("triggers:") {
            let rest = rest.trim();
            if rest.is_empty() {
                collecting = true;
            } else {
                return split_triggers(rest);
            }
        }
    }
    result
}

fn field_list(value: Option<&Value>) -> Vec<String> {
    match value {
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(|item| match item {
                Value::String(s) if !s.trim().is_empty() => Some(s.trim().to_string()),
                _ => None,
            })
            .collect(),
        Some(Value::String(s)) => split_triggers(s),
        Some(Value::Number(n)) => vec![n.to_string()],
        _ => Vec::new(),
    }
}

fn split_triggers(raw: &str) -> Vec<String> {
    raw.trim()
        .trim_start_matches('[')
        .trim_end_matches(']')
        .split([',', '，', '、'])
        .map(|part| part.trim().trim_matches('"').trim_matches('\'').to_string())
        .filter(|part| !part.is_empty())
        .collect()
}

fn quote(value: &str) -> String {
    let escaped = value
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\n', "\\n");
    format!("\"{escaped}\"")
}

/// 规范化并校验触发词：折叠空白、去空、忽略大小写去重、限长限量。
/// 空数组合法（技能仍可依靠 description 被路由）；违规直接返回可行动错误。
fn normalize_triggers(triggers: &[String]) -> Result<Vec<String>, ToolError> {
    let mut result = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for raw in triggers {
        let value = raw.split_whitespace().collect::<Vec<_>>().join(" ");
        if value.is_empty() {
            continue;
        }
        if value.chars().count() > MAX_TRIGGER_CHARS {
            return Err(ToolError::invalid(format!(
                "触发词「{value}」超过 {MAX_TRIGGER_CHARS} 个字符"
            )));
        }
        if value
            .chars()
            .any(|c| c.is_control() || TRIGGER_SEPARATORS.contains(&c))
        {
            return Err(ToolError::invalid(
                "触发词不能包含逗号、顿号、换行或控制字符；请用分隔符拆分",
            ));
        }
        if seen.insert(value.to_lowercase()) {
            result.push(value);
        }
    }
    if result.len() > MAX_TRIGGERS {
        return Err(ToolError::invalid(format!(
            "最多 {MAX_TRIGGERS} 个触发词，当前 {} 个",
            result.len()
        )));
    }
    Ok(result)
}

fn compose_skill(input: &SkillInput, body: &str, triggers: &[String]) -> String {
    let rendered: Vec<String> = triggers.iter().map(|trigger| quote(trigger)).collect();
    format!(
        "---\nname: {}\ndescription: {}\ntriggers: [{}]\nscope: {}\nversion: {}\n---\n\n{}",
        quote(input.name.trim()),
        quote(input.description.trim()),
        rendered.join(", "),
        quote(if input.scope.trim().is_empty() {
            "chat"
        } else {
            input.scope.trim()
        }),
        quote(if input.version.trim().is_empty() {
            "1.0"
        } else {
            input.version.trim()
        }),
        body
    )
}

fn get_setting(conn: &Connection, key: &str) -> rusqlite::Result<Option<String>> {
    conn.query_row(
        "SELECT value FROM settings WHERE key = ?1",
        params![key],
        |row| row.get(0),
    )
    .optional()
}

fn set_setting(conn: &Connection, key: &str, value: &str) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO settings (key, value, updated_at)
         VALUES (?1, ?2, datetime('now','localtime'))
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        params![key, value],
    )?;
    Ok(())
}

fn disabled_ids(conn: &Connection) -> rusqlite::Result<Vec<String>> {
    let raw = get_setting(conn, DISABLED_KEY)?.unwrap_or_default();
    Ok(serde_json::from_str::<Vec<String>>(&raw).unwrap_or_default())
}

fn write_disabled(conn: &Connection, ids: &[String]) -> rusqlite::Result<()> {
    let value = serde_json::to_string(ids).unwrap_or_else(|_| "[]".into());
    set_setting(conn, DISABLED_KEY, &value)
}

fn skill_rows(conn: &Connection) -> rusqlite::Result<Vec<(String, String)>> {
    let mut stmt = conn.prepare(
        "SELECT i.path, COALESCE(b.content, '')
         FROM inodes i
         JOIN blobs b ON b.inode = i.inode AND b.rev = i.head_rev
         WHERE i.kind = 'file' AND i.deleted = 0
           AND i.path GLOB '/life/.agents/skills/*/SKILL.md'
         ORDER BY i.path ASC",
    )?;
    let rows = stmt.query_map([], |row| {
        let path: String = row.get(0)?;
        let content: String = row.get(1)?;
        Ok((path, content))
    })?;
    let mut result = Vec::new();
    for row in rows {
        result.push(row?);
    }
    Ok(result)
}

fn id_from_path(path: &str) -> Option<String> {
    let rest = path
        .strip_prefix(SKILLS_ROOT)?
        .strip_prefix('/')?
        .strip_suffix(&format!("/{SKILL_FILE}"))?;
    if rest.is_empty() || rest.contains('/') {
        return None;
    }
    Some(rest.to_string())
}

fn draft_rows(conn: &Connection) -> rusqlite::Result<Vec<(String, String)>> {
    let mut stmt = conn.prepare(
        "SELECT i.path, COALESCE(b.content, '')
         FROM inodes i
         JOIN blobs b ON b.inode = i.inode AND b.rev = i.head_rev
         WHERE i.kind = 'file' AND i.deleted = 0
           AND i.path GLOB '/life/agent/skills-drafts/*/SKILL.md'
         ORDER BY i.path ASC",
    )?;
    let rows = stmt.query_map([], |row| {
        let path: String = row.get(0)?;
        let content: String = row.get(1)?;
        Ok((path, content))
    })?;
    let mut result = Vec::new();
    for row in rows {
        result.push(row?);
    }
    Ok(result)
}

fn id_from_draft_path(path: &str) -> Option<String> {
    let rest = path
        .strip_prefix(DRAFT_ROOT)?
        .strip_prefix('/')?
        .strip_suffix(&format!("/{SKILL_FILE}"))?;
    if rest.is_empty() || rest.contains('/') {
        return None;
    }
    Some(rest.to_string())
}

/// 列出全部技能（含禁用项）；非法 SKILL.md 只记录告警并跳过。
pub fn list(vfs: &VirtualFs) -> Result<Vec<SkillSummary>, ToolError> {
    let disabled = disabled_ids(vfs.conn())?;
    let mut skills = Vec::new();
    for (path, content) in skill_rows(vfs.conn())? {
        let Some(id) = id_from_path(&path) else {
            continue;
        };
        match parse_skill(&id, &content) {
            Some((_, mut summary)) => {
                summary.enabled = !disabled.iter().any(|item| item == &id);
                skills.push(summary);
            }
            None => log::warn!("skip invalid skill document: {path}"),
        }
    }
    skills.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(skills)
}

/// 读取技能正文（按需注入用）。
pub fn read(vfs: &VirtualFs, id: &str) -> Result<SkillDetail, ToolError> {
    let id = validate_id(id)?;
    let content: Option<String> = vfs
        .conn()
        .query_row(
            "SELECT COALESCE(b.content, '')
             FROM inodes i
             JOIN blobs b ON b.inode = i.inode AND b.rev = i.head_rev
             WHERE i.path = ?1 AND i.kind = 'file' AND i.deleted = 0",
            params![skill_path(&id)],
            |row| row.get(0),
        )
        .optional()?;
    let Some(content) = content else {
        return Err(ToolError::NotFound {
            path: skill_path(&id),
        });
    };
    let Some((body, mut summary)) = parse_skill(&id, &content) else {
        return Err(ToolError::invalid(format!("技能 {id} 的 frontmatter 非法")));
    };
    summary.enabled = !disabled_ids(vfs.conn())?.iter().any(|item| item == &id);
    Ok(SkillDetail { summary, body })
}

/// 新建或更新技能；更新时整文件替换并追加新 rev。
pub fn save(vfs: &mut VirtualFs, input: SkillInput) -> Result<SkillSummary, ToolError> {
    validate_input(&input)?;
    let triggers = normalize_triggers(&input.triggers)?;
    let id = if input.id.trim().is_empty() {
        id_from_name(input.name.trim())
    } else {
        validate_id(&input.id)?
    };
    let body = input.body.trim();
    let content = compose_skill(&input, body, &triggers);
    let path = skill_path(&id);

    let existing: Option<(String, i64)> = vfs
        .conn()
        .query_row(
            "SELECT COALESCE(b.content, ''), i.head_rev
             FROM inodes i
             JOIN blobs b ON b.inode = i.inode AND b.rev = i.head_rev
             WHERE i.path = ?1 AND i.kind = 'file' AND i.deleted = 0",
            params![path],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    match existing {
        Some((old, _)) if old == content => {}
        Some((old, rev)) => {
            vfs.edit_skill(EditRequest {
                path: path.clone(),
                old_string: old,
                new_string: content,
                replace_all: None,
                expect_rev: Some(rev),
                source: WriteSource::User,
            })?;
        }
        None => {
            vfs.write_skill(WriteRequest {
                path: path.clone(),
                content,
                create_parents: Some(true),
                auto_frontmatter: Some(false),
                source: WriteSource::User,
            })?;
        }
    }

    let detail = read(vfs, &id)?;
    Ok(detail.summary)
}

/// 导入 zip/.skill 技能包：读取根目录 SKILL.md，解析 frontmatter 后按名称落库。
/// 只接受根级 SKILL.md，避免把包里其它文件带进虚拟 FS。
pub fn import_package(
    vfs: &mut VirtualFs,
    filename: &str,
    data: &str,
) -> Result<SkillSummary, ToolError> {
    let lower = filename.to_ascii_lowercase();
    if !(lower.ends_with(".zip") || lower.ends_with(".skill")) {
        return Err(ToolError::invalid("只支持 .zip 或 .skill 技能包"));
    }
    let bytes = STANDARD
        .decode(data.trim())
        .map_err(|_| ToolError::invalid("技能包数据无法解码，请重新选择文件"))?;
    if bytes.len() > MAX_PACKAGE_BYTES {
        return Err(ToolError::ContentTooLarge {
            limit: MAX_PACKAGE_BYTES,
            actual: bytes.len(),
        });
    }

    let mut archive = zip::ZipArchive::new(Cursor::new(bytes))
        .map_err(|_| ToolError::invalid("无法解析技能包；请确认是 zip 或 .skill 格式"))?;
    let mut content: Option<String> = None;
    for index in 0..archive.len() {
        let mut file = archive
            .by_index(index)
            .map_err(|e| ToolError::invalid(format!("读取技能包失败：{e}")))?;
        if file.name() != SKILL_FILE {
            continue;
        }
        if file.size() > MAX_SKILL_FILE_BYTES {
            return Err(ToolError::ContentTooLarge {
                limit: MAX_SKILL_FILE_BYTES as usize,
                actual: file.size() as usize,
            });
        }
        let mut text = String::new();
        file.read_to_string(&mut text)
            .map_err(|_| ToolError::invalid("SKILL.md 必须是 UTF-8 文本"))?;
        content = Some(text);
        break;
    }

    let content = content.ok_or_else(|| {
        ToolError::invalid(format!(
            "技能包「{filename}」根目录缺少 SKILL.md（不支持嵌套目录）"
        ))
    })?;
    let Some((body, summary)) = parse_skill("import", &content) else {
        return Err(ToolError::invalid(
            "SKILL.md 的 frontmatter 缺少 name 或 description",
        ));
    };

    save(
        vfs,
        SkillInput {
            id: String::new(),
            name: summary.name,
            description: summary.description,
            triggers: summary.triggers,
            scope: summary.scope,
            version: summary.version,
            body,
        },
    )
}

/// 创建 Agent 工作区目录（幂等）。草稿目录不会被技能 loader 自动加载。
pub fn ensure_workspace(vfs: &VirtualFs) -> Result<(), ToolError> {
    let conn = vfs.conn();
    for path in [AGENT_ROOT, DRAFT_ROOT, RULES_ROOT] {
        conn.execute(
            "INSERT OR IGNORE INTO inodes (path, kind, head_rev, size, ctime, mtime)
             VALUES (?1, 'directory', 0, 0, datetime('now','localtime'), datetime('now','localtime'))",
            params![path],
        )?;
        conn.execute(
            "UPDATE inodes SET deleted = 0, deleted_at = NULL
             WHERE path = ?1 AND kind = 'directory' AND deleted = 1",
            params![path],
        )?;
    }
    Ok(())
}

/// 列出模型写入的草稿；它们不会被注入 prompt，必须由用户审核后载入。
pub fn list_drafts(vfs: &VirtualFs) -> Result<Vec<SkillSummary>, ToolError> {
    let mut drafts = Vec::new();
    for (path, content) in draft_rows(vfs.conn())? {
        let Some(id) = id_from_draft_path(&path) else {
            continue;
        };
        match parse_skill(&id, &content) {
            Some((_, mut summary)) => {
                summary.builtin = false;
                summary.enabled = true;
                drafts.push(summary);
            }
            None => log::warn!("skip invalid skill draft: {path}"),
        }
    }
    drafts.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(drafts)
}

/// 预览草稿正文（未载入前也可查看）。
pub fn read_draft(vfs: &VirtualFs, id: &str) -> Result<SkillDetail, ToolError> {
    let id = validate_id(id)?;
    let content: Option<String> = vfs
        .conn()
        .query_row(
            "SELECT COALESCE(b.content, '')
             FROM inodes i
             JOIN blobs b ON b.inode = i.inode AND b.rev = i.head_rev
             WHERE i.path = ?1 AND i.kind = 'file' AND i.deleted = 0",
            params![draft_path(&id)],
            |row| row.get(0),
        )
        .optional()?;
    let Some(content) = content else {
        return Err(ToolError::NotFound {
            path: draft_path(&id),
        });
    };
    let Some((body, mut summary)) = parse_skill(&id, &content) else {
        return Err(ToolError::invalid(format!("草稿 {id} 的 frontmatter 非法")));
    };
    summary.builtin = false;
    summary.enabled = true;
    Ok(SkillDetail { summary, body })
}

/// 用户审核后把草稿载入 `.agents/skills`；草稿本身保留在工作区。
pub fn promote_draft(vfs: &mut VirtualFs, id: &str) -> Result<SkillSummary, ToolError> {
    let id = validate_id(id)?;
    let detail = read_draft(vfs, &id)?;
    save(
        vfs,
        SkillInput {
            id: String::new(),
            name: detail.summary.name,
            description: detail.summary.description,
            triggers: detail.summary.triggers,
            scope: detail.summary.scope,
            version: detail.summary.version,
            body: detail.body,
        },
    )
}

/// 删除草稿（模型工作区内的文件，可不经审核直接丢弃）。
pub fn delete_draft(vfs: &mut VirtualFs, id: &str) -> Result<(), ToolError> {
    let id = validate_id(id)?;
    let path = draft_path(&id);
    let inode: Option<i64> = vfs
        .conn()
        .query_row(
            "SELECT inode FROM inodes WHERE path = ?1 AND kind = 'file'",
            params![path],
            |row| row.get(0),
        )
        .optional()?;
    let Some(inode) = inode else {
        return Err(ToolError::NotFound { path });
    };
    let tx = vfs.conn_mut().transaction()?;
    crate::vfs::fts::remove_document(&tx, inode)?;
    tx.execute(
        "DELETE FROM inodes WHERE inode = ?1 OR (path = ?2 AND kind = 'directory')",
        params![inode, draft_dir(&id)],
    )?;
    tx.commit()?;
    Ok(())
}

fn validate_input(input: &SkillInput) -> Result<(), ToolError> {
    let name = input.name.trim();
    let description = input.description.trim();
    if name.is_empty() || name.chars().count() > 60 {
        return Err(ToolError::invalid("技能名称长度必须在 1–60 字符之间"));
    }
    if description.is_empty() || description.chars().count() > 200 {
        return Err(ToolError::invalid("技能描述长度必须在 1–200 字符之间"));
    }
    if input.body.trim().is_empty() {
        return Err(ToolError::invalid("技能正文不能为空"));
    }
    if input.body.len() > 64 * 1024 {
        return Err(ToolError::ContentTooLarge {
            limit: 64 * 1024,
            actual: input.body.len(),
        });
    }
    Ok(())
}

/// 启用/停用技能；状态存 `settings.skills.disabled`。
pub fn set_enabled(vfs: &VirtualFs, id: &str, enabled: bool) -> Result<(), ToolError> {
    let id = validate_id(id)?;
    let exists: i64 = vfs.conn().query_row(
        "SELECT COUNT(*) FROM inodes WHERE path = ?1 AND kind = 'file' AND deleted = 0",
        params![skill_path(&id)],
        |row| row.get(0),
    )?;
    if exists == 0 {
        return Err(ToolError::NotFound {
            path: skill_path(&id),
        });
    }
    let mut disabled = disabled_ids(vfs.conn())?;
    disabled.retain(|item| item != &id);
    if !enabled {
        disabled.push(id);
    }
    write_disabled(vfs.conn(), &disabled)?;
    Ok(())
}

/// 卸载技能：物理删除 SKILL.md 与技能目录，并从禁用列表移除。
pub fn delete(vfs: &mut VirtualFs, id: &str) -> Result<(), ToolError> {
    let id = validate_id(id)?;
    let path = skill_path(&id);
    let inode: Option<i64> = vfs
        .conn()
        .query_row(
            "SELECT inode FROM inodes WHERE path = ?1 AND kind = 'file'",
            params![path],
            |row| row.get(0),
        )
        .optional()?;
    let Some(inode) = inode else {
        return Err(ToolError::NotFound { path });
    };

    let tx = vfs.conn_mut().transaction()?;
    crate::vfs::fts::remove_document(&tx, inode)?;
    tx.execute(
        "DELETE FROM inodes WHERE inode = ?1 OR (path = ?2 AND kind = 'directory')",
        params![inode, skill_dir(&id)],
    )?;
    let mut disabled = disabled_ids(&tx)?;
    disabled.retain(|item| item != &id);
    write_disabled(&tx, &disabled)?;
    tx.commit()?;
    Ok(())
}
