//! User-defined model registry.
//!
//! Every callable model is created by the user; the app ships **no preset
//! models**. The preset list only suggests Base URLs in the "Add Model" dialog,
//! so it never appears in this module.
//!
//! Security boundaries:
//! - The WebView only passes a model entry id to `agent_stream`; the URL and
//!   model id are read from `life.db` here.
//! - Base URLs must be HTTPS, without embedded credentials, query strings,
//!   fragments or private/loopback hosts, so a compromised WebView cannot
//!   turn the stored config into an SSRF primitive.

use std::collections::BTreeMap;

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use url::{Host, Url};

use super::params;
use super::secrets::SecretStore;
use crate::vfs::error::ToolError;

const KEY_MODELS: &str = "agent.models.v2";
const KEY_ACTIVE: &str = "agent.active_model.v2";
const KEY_SYSTEM_PROMPT: &str = "agent.system_prompt.v1";
const KEY_RULES: &str = "agent.rules.v1";
const KEY_INJECT_SKILLS: &str = "agent.skills_injection.v1";
const MAX_ID_CHARS: usize = 32;
const MAX_LABEL_CHARS: usize = 64;
const MAX_BASE_URL_CHARS: usize = 200;
const MAX_MODEL_CHARS: usize = 100;
/// The proxy rejects prompts over 64KB; keep headroom for each prompt block.
const MAX_PROMPT_BLOCK_BYTES: usize = 32 * 1024;

/// Default base instruction; the settings textarea shows exactly this value.
pub const DEFAULT_SYSTEM_PROMPT: &str = "You are a helpful assistant running LifeOS.";

/// Request protocol used by one model entry.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ApiFormat {
    /// `POST <baseUrl>/chat/completions`
    #[serde(rename = "openai-chat")]
    OpenAiChat,
    /// `POST <baseUrl>/responses`
    #[serde(rename = "openai-responses")]
    OpenAiResponses,
    /// `POST <baseUrl>/messages`
    #[serde(rename = "anthropic-messages")]
    AnthropicMessages,
}

impl ApiFormat {
    /// The `api` string pi-ai expects for its model descriptor.
    pub fn pi_api(self) -> &'static str {
        match self {
            Self::OpenAiChat => "openai-completions",
            Self::OpenAiResponses => "openai-responses",
            Self::AnthropicMessages => "anthropic-messages",
        }
    }

    /// Path appended to a Base URL when Full URL mode is off.
    pub fn path_suffix(self) -> &'static str {
        match self {
            Self::OpenAiChat => "/chat/completions",
            Self::OpenAiResponses => "/responses",
            // Anthropic's canonical base URL ends at the host, so the version
            // prefix belongs to the appended path.
            Self::AnthropicMessages => "/v1/messages",
        }
    }

    /// Path used to discover model ids from the endpoint.
    pub fn models_path(self) -> &'static str {
        match self {
            Self::AnthropicMessages => "/v1/models",
            _ => "/models",
        }
    }
}

/// One persisted model entry. API keys live in the OS secret store, never here.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelEntry {
    pub id: String,
    pub label: String,
    pub format: ApiFormat,
    pub base_url: String,
    /// Use `base_url` as the complete endpoint instead of appending a path.
    #[serde(default)]
    pub full_url: bool,
    pub model_id: String,
}

/// Input for creating or editing a model entry.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInput {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub label: String,
    pub format: ApiFormat,
    #[serde(default)]
    pub base_url: String,
    #[serde(default)]
    pub model_id: String,
    #[serde(default)]
    pub full_url: bool,
}

/// Model row shown in settings; never contains the API key itself.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelView {
    pub id: String,
    pub label: String,
    pub format: ApiFormat,
    pub base_url: String,
    pub full_url: bool,
    pub model_id: String,
    /// Capability hints mirrored from `LlmParams` so the list can show them.
    pub context_window_input: Option<u32>,
    pub context_window_output: Option<u32>,
    /// Optional USD prices mirrored from `LlmParams`.
    pub input_price: Option<f64>,
    pub output_price: Option<f64>,
    pub configured: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSettings {
    /// `None` until the user adds a model.
    pub active_id: Option<String>,
    pub models: Vec<ModelView>,
    /// Verbatim base system prompt; defaults to [`DEFAULT_SYSTEM_PROMPT`].
    pub system_prompt: String,
    /// User-maintained rules; empty means the request carries no rules block.
    pub rules: String,
    /// Explicit opt-in for appending the enabled-skills index to the prompt.
    pub inject_skills: bool,
}

/// All stored entries, newest last.
pub fn configs(conn: &Connection) -> Result<Vec<ModelEntry>, ToolError> {
    Ok(read_models(conn))
}

pub fn resolve(conn: &Connection, id: &str) -> Result<ModelEntry, ToolError> {
    configs(conn)?
        .into_iter()
        .find(|item| item.id == id)
        .ok_or_else(|| ToolError::invalid(format!("未找到模型：{id}")))
}

/// Active chat model plus the full list and key status.
pub fn settings(conn: &Connection, keys: &[(String, bool)]) -> Result<AgentSettings, ToolError> {
    let models = configs(conn)?;
    let active_id = heal_active(conn, &models)?;
    let key_map: BTreeMap<&str, bool> = keys
        .iter()
        .map(|(id, configured)| (id.as_str(), *configured))
        .collect();
    Ok(AgentSettings {
        active_id,
        models: models
            .into_iter()
            .map(|item| {
                let configured = key_map.get(item.id.as_str()).copied().unwrap_or(false);
                view(conn, item, configured)
            })
            .collect(),
        system_prompt: system_prompt(conn),
        rules: rules(conn),
        inject_skills: inject_skills(conn),
    })
}

/// Persisted base system prompt; falls back to the default when unset.
pub fn system_prompt(conn: &Connection) -> String {
    read_setting_opt(conn, KEY_SYSTEM_PROMPT)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_SYSTEM_PROMPT.to_string())
}

/// Normalize one prompt block; `None` clears the setting.
///
/// `too_long` is the full error prefix so both blocks keep their wording.
fn prompt_block(text: &str, too_long: &str) -> Result<Option<String>, ToolError> {
    let trimmed = text.trim();
    if trimmed.len() > MAX_PROMPT_BLOCK_BYTES {
        return Err(ToolError::invalid(format!(
            "{too_long} {} KB",
            MAX_PROMPT_BLOCK_BYTES / 1024
        )));
    }
    Ok(if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    })
}

/// Persist all prompt settings in one transaction.
///
/// Both blocks are validated before the first write so a rejected input can
/// never leave a half-applied configuration (prompt saved, rules failed).
pub fn save_prompt_config(
    conn: &Connection,
    system_prompt: &str,
    rules: &str,
    inject_skills: bool,
) -> Result<(), ToolError> {
    let system_prompt = prompt_block(system_prompt, "系统提示词超过")?;
    let rules = prompt_block(rules, "Rules 超过")?;
    let tx = conn.unchecked_transaction()?;
    match system_prompt {
        Some(text) => write_setting(&tx, KEY_SYSTEM_PROMPT, &text)?,
        None => delete_setting(&tx, KEY_SYSTEM_PROMPT)?,
    }
    match rules {
        Some(text) => write_setting(&tx, KEY_RULES, &text)?,
        None => delete_setting(&tx, KEY_RULES)?,
    }
    write_setting(
        &tx,
        KEY_INJECT_SKILLS,
        if inject_skills { "1" } else { "0" },
    )?;
    tx.commit()?;
    Ok(())
}

/// User-maintained rules; empty means no rules block is sent.
pub fn rules(conn: &Connection) -> String {
    read_setting_opt(conn, KEY_RULES).unwrap_or_default()
}

/// Whether enabled skills' index is appended to the system prompt.
pub fn inject_skills(conn: &Connection) -> bool {
    read_setting_opt(conn, KEY_INJECT_SKILLS).is_some_and(|value| value == "1")
}

/// Settings row for one entry, including capability hints from `LlmParams`.
pub fn view(conn: &Connection, entry: ModelEntry, configured: bool) -> ModelView {
    let params = params::get(conn, &entry.id);
    ModelView {
        id: entry.id,
        label: entry.label,
        format: entry.format,
        base_url: entry.base_url,
        full_url: entry.full_url,
        model_id: entry.model_id,
        context_window_input: params.context_window_input,
        context_window_output: params.context_window_output,
        input_price: params.input_price,
        output_price: params.output_price,
        configured,
    }
}

/// Heal stale active pointers after edits or deletions.
fn heal_active(conn: &Connection, models: &[ModelEntry]) -> Result<Option<String>, ToolError> {
    let stored = read_setting(conn, KEY_ACTIVE)?;
    let active = stored
        .as_deref()
        .filter(|id| models.iter().any(|item| item.id == *id))
        .map(str::to_string)
        .or_else(|| models.first().map(|item| item.id.clone()));
    if active.as_deref() != stored.as_deref() {
        match &active {
            Some(id) => write_setting(conn, KEY_ACTIVE, id)?,
            None => delete_setting(conn, KEY_ACTIVE)?,
        }
    }
    Ok(active)
}

pub fn set_active(conn: &Connection, id: &str) -> Result<(), ToolError> {
    resolve(conn, id)?;
    write_setting(conn, KEY_ACTIVE, id)
}

/// Create or edit a model entry. Editing keeps the existing id.
pub fn save(conn: &Connection, input: ModelInput) -> Result<ModelEntry, ToolError> {
    let all = configs(conn)?;
    let existing = if input.id.trim().is_empty() {
        None
    } else {
        let id = validate_id(&input.id)?;
        Some(
            all.iter()
                .find(|item| item.id == id)
                .ok_or_else(|| ToolError::invalid("未找到要编辑的模型"))?,
        )
    };
    let model_id = validate_model_id(&input.model_id)?;
    let base_url = normalize_anthropic_base(
        validate_base_url(&input.base_url)?,
        input.format,
        input.full_url,
    );
    // Display name is optional: fall back to the model id.
    let label = if input.label.trim().is_empty() {
        model_id.clone()
    } else {
        validate_label(&input.label)?
    };
    let id = match existing {
        Some(item) => item.id.clone(),
        None => next_custom_id(&all),
    };
    let entry = ModelEntry {
        id: id.clone(),
        label,
        format: input.format,
        base_url,
        full_url: input.full_url,
        model_id,
    };
    let mut next = all;
    match next.iter_mut().find(|item| item.id == id) {
        Some(slot) => *slot = entry.clone(),
        None => next.push(entry.clone()),
    }
    write_models(conn, &next)?;
    // First chat model added becomes active so the chat page is usable immediately.
    heal_active(conn, &next)?;
    Ok(entry)
}

/// Delete an entry and move the active pointer to the next remaining chat model.
pub fn delete(conn: &Connection, id: &str) -> Result<(), ToolError> {
    let mut all = configs(conn)?;
    let before = all.len();
    all.retain(|item| item.id != id);
    if all.len() == before {
        return Err(ToolError::invalid(format!("未找到模型：{id}")));
    }
    write_models(conn, &all)?;
    heal_active(conn, &all)?;
    Ok(())
}

/// Build the request endpoint. The model id never enters the URL, so no
/// additional path-injection validation is needed here.
pub fn endpoint(entry: &ModelEntry) -> String {
    if entry.full_url {
        entry.base_url.clone()
    } else {
        format!("{}{}", entry.base_url, entry.format.path_suffix())
    }
}

/// Older builds stored `https://api.anthropic.com/v1` as the Base URL and
/// appended only `/messages`. The adapter now appends `/v1/messages`, so strip
/// that legacy suffix to keep both conventions resolving to the same endpoint.
pub(crate) fn normalize_anthropic_base(
    base_url: String,
    format: ApiFormat,
    full_url: bool,
) -> String {
    if full_url || format != ApiFormat::AnthropicMessages {
        return base_url;
    }
    match base_url.strip_suffix("/v1") {
        Some(stripped) => stripped.to_string(),
        None => base_url,
    }
}

/// Remove pre-v2 provider settings and their API keys once.
///
/// The old design stored keys under provider ids (`deepseek`, `custom_1`, ...).
/// Those ids no longer name a model entry, so the keys are deleted too. The
/// empty v2 list acts as the migration marker.
pub fn cleanup_legacy(conn: &Connection, secrets: &SecretStore) {
    if read_setting_opt(conn, KEY_MODELS).is_some() {
        return;
    }
    let legacy = read_setting_opt(conn, "agent.provider_configs").unwrap_or_default();
    if let Ok(items) = serde_json::from_str::<Vec<LegacyConfig>>(&legacy) {
        for item in items {
            if let Err(e) = secrets.delete(&item.id) {
                log::warn!("legacy provider key cleanup failed for {}: {e}", item.id);
            }
        }
    }
    for key in [
        "agent.provider",
        "agent.model",
        "agent.provider_configs",
        "agent.params.v1",
    ] {
        let _ = delete_setting(conn, key);
    }
    if let Err(e) = write_models(conn, &[]) {
        log::warn!("legacy model cleanup marker failed: {e}");
    }
}

#[derive(Debug, Deserialize)]
struct LegacyConfig {
    id: String,
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

fn validate_id(raw: &str) -> Result<String, ToolError> {
    let id = raw.trim();
    if id.is_empty() || id.chars().count() > MAX_ID_CHARS {
        return Err(ToolError::invalid("模型条目 id 为空或超过 32 字符"));
    }
    if !id
        .chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_')
    {
        return Err(ToolError::invalid(
            "模型条目 id 只能包含小写字母、数字、短横线和下划线",
        ));
    }
    Ok(id.to_string())
}

fn validate_label(raw: &str) -> Result<String, ToolError> {
    let label = raw.trim();
    if label.is_empty() || label.chars().count() > MAX_LABEL_CHARS {
        return Err(ToolError::invalid(format!(
            "显示名称必须为 1–{MAX_LABEL_CHARS} 字符"
        )));
    }
    if label.chars().any(char::is_control) {
        return Err(ToolError::invalid("显示名称包含控制字符"));
    }
    Ok(label.to_string())
}

fn validate_model_id(raw: &str) -> Result<String, ToolError> {
    let model = raw.trim();
    if model.is_empty() {
        return Err(ToolError::invalid("Model ID 不能为空"));
    }
    if model.chars().count() > MAX_MODEL_CHARS {
        return Err(ToolError::invalid(format!(
            "Model ID 超过 {MAX_MODEL_CHARS} 字符"
        )));
    }
    if model.chars().any(char::is_control) {
        return Err(ToolError::invalid("Model ID 包含控制字符"));
    }
    Ok(model.to_string())
}

/// HTTPS-only, no credentials, public host only. Query and fragments are
/// checked separately so runtime endpoints (e.g. MCP SSE message URLs) can
/// carry a signed query while keeping the same SSRF boundary.
pub(crate) fn validate_public_https(parsed: &Url) -> Result<(), ToolError> {
    if parsed.scheme() != "https" {
        return Err(ToolError::invalid("Base URL 必须是 https:// 开头"));
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(ToolError::invalid("Base URL 不能包含用户名或密码"));
    }
    let host = parsed
        .host()
        .ok_or_else(|| ToolError::invalid("Base URL 缺少主机名"))?;
    match host {
        Host::Domain(name) => {
            let lower = name.to_ascii_lowercase();
            if lower == "localhost"
                || lower.ends_with(".local")
                || !lower.contains('.')
                || lower.starts_with('.')
            {
                return Err(ToolError::invalid("Base URL 必须使用公网完整域名"));
            }
        }
        Host::Ipv4(ip) => {
            if ip.is_private()
                || ip.is_loopback()
                || ip.is_link_local()
                || ip.is_unspecified()
                || ip.is_multicast()
                || ip.is_broadcast()
            {
                return Err(ToolError::invalid("Base URL 不能指向内网、回环或保留地址"));
            }
        }
        Host::Ipv6(ip) => {
            if ip.is_loopback()
                || ip.is_unspecified()
                || ip.is_multicast()
                || ip.is_unique_local()
                || ip.is_unicast_link_local()
            {
                return Err(ToolError::invalid("Base URL 不能指向内网、回环或保留地址"));
            }
        }
    }
    Ok(())
}

/// HTTPS-only, no credentials, no query/fragment, public host only.
pub(crate) fn validate_base_url(raw: &str) -> Result<String, ToolError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(ToolError::invalid("Base URL 不能为空"));
    }
    if trimmed.chars().count() > MAX_BASE_URL_CHARS {
        return Err(ToolError::invalid(format!(
            "Base URL 超过 {MAX_BASE_URL_CHARS} 字符"
        )));
    }
    let parsed =
        Url::parse(trimmed).map_err(|e| ToolError::invalid(format!("Base URL 解析失败：{e}")))?;
    validate_public_https(&parsed)?;
    if parsed.query().is_some() || parsed.fragment().is_some() {
        return Err(ToolError::invalid("Base URL 不能包含查询串或片段"));
    }
    if parsed.path().contains("..") {
        return Err(ToolError::invalid("Base URL 路径不能包含 .."));
    }
    Ok(trimmed.trim_end_matches('/').to_string())
}

fn next_custom_id(all: &[ModelEntry]) -> String {
    for n in 1..=u32::MAX {
        let candidate = format!("custom_{n}");
        if !all.iter().any(|item| item.id == candidate) {
            return candidate;
        }
    }
    "custom_max".to_string()
}

// ---------------------------------------------------------------------------
// settings persistence
// ---------------------------------------------------------------------------

fn read_models(conn: &Connection) -> Vec<ModelEntry> {
    let Some(raw) = read_setting_opt(conn, KEY_MODELS) else {
        return Vec::new();
    };
    let Ok(items) = serde_json::from_str::<Vec<ModelEntry>>(&raw) else {
        log::warn!("agent model JSON is invalid; treating the list as empty");
        return Vec::new();
    };
    items
        .into_iter()
        .map(|mut item| {
            item.base_url = normalize_anthropic_base(item.base_url, item.format, item.full_url);
            item
        })
        .filter(|item| match validate_base_url(&item.base_url) {
            Ok(_) => true,
            Err(e) => {
                log::warn!("skip invalid stored model {}: {e}", item.id);
                false
            }
        })
        .collect()
}

fn write_models(conn: &Connection, models: &[ModelEntry]) -> Result<(), ToolError> {
    let body = serde_json::to_string(models)
        .map_err(|e| ToolError::invalid(format!("模型配置序列化失败：{e}")))?;
    write_setting(conn, KEY_MODELS, &body)
}

fn read_setting_opt(conn: &Connection, key: &str) -> Option<String> {
    conn.query_row(
        "SELECT value FROM settings WHERE key = ?1",
        params![key],
        |row| row.get(0),
    )
    .optional()
    .ok()
    .flatten()
}

fn read_setting(conn: &Connection, key: &str) -> Result<Option<String>, ToolError> {
    Ok(read_setting_opt(conn, key).filter(|value| !value.trim().is_empty()))
}

fn write_setting(conn: &Connection, key: &str, value: &str) -> Result<(), ToolError> {
    conn.execute(
        "INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, datetime('now','localtime'))
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        params![key, value],
    )?;
    Ok(())
}

fn delete_setting(conn: &Connection, key: &str) -> Result<(), ToolError> {
    conn.execute("DELETE FROM settings WHERE key = ?1", params![key])?;
    Ok(())
}
