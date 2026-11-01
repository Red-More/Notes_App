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
const MAX_ID_CHARS: usize = 32;
const MAX_LABEL_CHARS: usize = 64;
const MAX_BASE_URL_CHARS: usize = 200;
const MAX_MODEL_CHARS: usize = 100;

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
    /// `POST <baseUrl>/images/generations`
    #[serde(rename = "openai-images")]
    OpenAiImages,
    /// `POST <baseUrl>/audio/speech`
    #[serde(rename = "openai-audio")]
    OpenAiAudio,
    /// `POST <baseUrl>/videos` followed by polling and `/videos/{id}/content`
    #[serde(rename = "openai-videos")]
    OpenAiVideos,
    /// `POST <baseUrl>/audio/transcriptions`
    #[serde(rename = "openai-transcriptions")]
    OpenAiTranscriptions,
    /// DashScope Wanx image synthesis (async task + poll).
    #[serde(rename = "dashscope-image")]
    DashScopeImage,
    /// DashScope Wan text-to-video (async task + poll).
    #[serde(rename = "dashscope-video")]
    DashScopeVideo,
    /// DashScope CosyVoice text-to-speech.
    #[serde(rename = "dashscope-tts")]
    DashScopeTts,
    /// Volcano Ark Seedance video tasks.
    #[serde(rename = "volc-video")]
    VolcVideo,
    /// Kling AI text-to-video (AccessKey:SecretKey JWT).
    #[serde(rename = "kling-video")]
    KlingVideo,
    /// ElevenLabs text-to-speech (`xi-api-key`).
    #[serde(rename = "elevenlabs-tts")]
    ElevenLabsTts,
    /// Embedded llama.cpp runtime; `base_url` holds a `.gguf` file name inside
    /// the app models directory and never leaves the device.
    #[serde(rename = "local-llama")]
    LocalLlama,
}

impl ApiFormat {
    /// The `api` string pi-ai expects for its model descriptor.
    pub fn pi_api(self) -> &'static str {
        match self {
            Self::OpenAiChat => "openai-completions",
            Self::OpenAiResponses => "openai-responses",
            Self::AnthropicMessages => "anthropic-messages",
            // Local requests reuse the OpenAI-compatible descriptor so pi-agent's
            // stream loop is unchanged; Rust dispatches them before any HTTP call.
            Self::LocalLlama => "openai-completions",
            // Media entries never flow through pi-agent; these values are unused.
            Self::OpenAiImages
            | Self::OpenAiAudio
            | Self::OpenAiVideos
            | Self::OpenAiTranscriptions
            | Self::DashScopeImage
            | Self::DashScopeVideo
            | Self::DashScopeTts
            | Self::VolcVideo
            | Self::KlingVideo
            | Self::ElevenLabsTts => "openai-completions",
        }
    }

    /// Whether this format belongs to the chat/agent protocol family.
    pub fn is_chat(self) -> bool {
        matches!(
            self,
            Self::OpenAiChat | Self::OpenAiResponses | Self::AnthropicMessages | Self::LocalLlama
        )
    }

    /// Local entries never touch the network; the egress gate is skipped.
    pub fn is_local(self) -> bool {
        matches!(self, Self::LocalLlama)
    }

    /// Path appended to a Base URL when Full URL mode is off.
    pub fn path_suffix(self) -> &'static str {
        match self {
            Self::OpenAiChat => "/chat/completions",
            Self::OpenAiResponses => "/responses",
            // Anthropic's canonical base URL ends at the host, so the version
            // prefix belongs to the appended path.
            Self::AnthropicMessages => "/v1/messages",
            Self::OpenAiImages => "/images/generations",
            Self::OpenAiAudio => "/audio/speech",
            Self::OpenAiVideos => "/videos",
            Self::OpenAiTranscriptions => "/audio/transcriptions",
            Self::DashScopeImage => "/api/v1/services/aigc/text2image/image-synthesis",
            Self::DashScopeVideo => "/api/v1/services/aigc/video-generation/video-synthesis",
            Self::DashScopeTts => "/api/v1/services/aigc/multimodal-generation/generation",
            Self::VolcVideo => "/api/v3/contents/generations/tasks",
            Self::KlingVideo => "/v1/videos/text2video",
            Self::ElevenLabsTts => "/v1/text-to-speech",
            Self::LocalLlama => "",
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

/// What a model entry is used for. Only `Chat` runs today; the other kinds are
/// configured ahead of the media pipeline and stay inactive until wired up.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ModelKind {
    #[default]
    Chat,
    Image,
    Video,
    Tts,
    Classify,
    Asr,
}

impl ModelKind {
    /// Whether this entry can currently back the chat agent.
    pub fn is_chat(self) -> bool {
        matches!(self, Self::Chat)
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
    /// Capability this entry serves; older records default to chat.
    #[serde(default)]
    pub kind: ModelKind,
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
    #[serde(default)]
    pub kind: ModelKind,
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
    pub kind: ModelKind,
    /// Capability hints mirrored from `LlmParams` so the list can show them.
    pub context_window_input: Option<u32>,
    pub context_window_output: Option<u32>,
    pub supports_images: Option<bool>,
    /// Optional USD prices mirrored from `LlmParams`.
    pub input_price: Option<f64>,
    pub output_price: Option<f64>,
    pub image_price: Option<f64>,
    pub video_second_price: Option<f64>,
    pub tts_kchar_price: Option<f64>,
    pub asr_minute_price: Option<f64>,
    pub configured: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSettings {
    /// `None` until the user adds a model.
    pub active_id: Option<String>,
    pub models: Vec<ModelView>,
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
    })
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
        kind: entry.kind,
        context_window_input: params.context_window_input,
        context_window_output: params.context_window_output,
        supports_images: params.supports_images,
        input_price: params.input_price,
        output_price: params.output_price,
        image_price: params.image_price,
        video_second_price: params.video_second_price,
        tts_kchar_price: params.tts_kchar_price,
        asr_minute_price: params.asr_minute_price,
        configured,
    }
}

/// Only chat entries may back the chat agent. Heal stale or non-chat pointers.
fn heal_active(conn: &Connection, models: &[ModelEntry]) -> Result<Option<String>, ToolError> {
    let stored = read_setting(conn, KEY_ACTIVE)?;
    let active = stored
        .as_deref()
        .filter(|id| {
            models
                .iter()
                .any(|item| item.id == *id && item.kind.is_chat())
        })
        .map(str::to_string)
        .or_else(|| {
            models
                .iter()
                .find(|item| item.kind.is_chat())
                .map(|item| item.id.clone())
        });
    if active.as_deref() != stored.as_deref() {
        match &active {
            Some(id) => write_setting(conn, KEY_ACTIVE, id)?,
            None => delete_setting(conn, KEY_ACTIVE)?,
        }
    }
    Ok(active)
}

pub fn set_active(conn: &Connection, id: &str) -> Result<(), ToolError> {
    let entry = resolve(conn, id)?;
    if !entry.kind.is_chat() {
        return Err(ToolError::invalid("只有对话模型可以设为当前模型"));
    }
    write_setting(conn, KEY_ACTIVE, id)
}

/// Create or edit a model entry. Editing keeps the existing id.
pub fn save(conn: &Connection, input: ModelInput) -> Result<ModelEntry, ToolError> {
    let all = configs(conn)?;
    // An existing id edits in place; an unknown explicit id is accepted for
    // system-managed entries such as the stable local runtime slot.
    let existing = if input.id.trim().is_empty() {
        None
    } else {
        let id = validate_id(&input.id)?;
        all.iter().find(|item| item.id == id)
    };
    let model_id = validate_model_id(&input.model_id)?;
    validate_format_for_kind(input.kind, input.format)?;
    let base_url = if input.format.is_local() {
        // Local entries store a model file name, not a URL.
        validate_local_file(&input.base_url)?
    } else {
        normalize_anthropic_base(
            validate_base_url(&input.base_url)?,
            input.format,
            input.full_url,
        )
    };
    // Display name is optional: fall back to the model id.
    let label = if input.label.trim().is_empty() {
        model_id.clone()
    } else {
        validate_label(&input.label)?
    };
    let id = match existing {
        Some(item) => item.id.clone(),
        None if input.id.trim().is_empty() => next_custom_id(&all),
        None => validate_id(&input.id)?,
    };
    let entry = ModelEntry {
        id: id.clone(),
        label,
        format: input.format,
        base_url,
        full_url: input.full_url,
        model_id,
        kind: input.kind,
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

fn validate_format_for_kind(kind: ModelKind, format: ApiFormat) -> Result<(), ToolError> {
    match kind {
        // A local chat entry never leaves the device; other kinds stay network-only.
        ModelKind::Chat if format.is_local() => Ok(()),
        ModelKind::Chat | ModelKind::Classify if !format.is_chat() => {
            Err(ToolError::invalid("对话与分类模型必须使用对话协议"))
        }
        _ if format.is_local() => Err(ToolError::invalid("本地模型只能作为对话模型使用")),
        ModelKind::Image
            if !matches!(format, ApiFormat::OpenAiImages | ApiFormat::DashScopeImage) =>
        {
            Err(ToolError::invalid(
                "图像模型必须使用 OpenAI Images 或 DashScope 协议",
            ))
        }
        ModelKind::Tts
            if !matches!(
                format,
                ApiFormat::OpenAiAudio | ApiFormat::DashScopeTts | ApiFormat::ElevenLabsTts
            ) =>
        {
            Err(ToolError::invalid(
                "语音模型必须使用 OpenAI Audio、DashScope 或 ElevenLabs 协议",
            ))
        }
        ModelKind::Video
            if !matches!(
                format,
                ApiFormat::OpenAiVideos
                    | ApiFormat::DashScopeVideo
                    | ApiFormat::VolcVideo
                    | ApiFormat::KlingVideo
            ) =>
        {
            Err(ToolError::invalid(
                "视频模型必须使用 OpenAI Videos、DashScope、火山或可灵协议",
            ))
        }
        ModelKind::Asr if format != ApiFormat::OpenAiTranscriptions => {
            Err(ToolError::invalid("转写模型必须使用 OpenAI Transcriptions 协议"))
        }
        _ => Ok(()),
    }
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
    if parsed.scheme() != "https" {
        return Err(ToolError::invalid("Base URL 必须是 https:// 开头"));
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(ToolError::invalid("Base URL 不能包含用户名或密码"));
    }
    if parsed.query().is_some() || parsed.fragment().is_some() {
        return Err(ToolError::invalid("Base URL 不能包含查询串或片段"));
    }
    if parsed.path().contains("..") {
        return Err(ToolError::invalid("Base URL 路径不能包含 .."));
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
    Ok(trimmed.trim_end_matches('/').to_string())
}

/// Local entries store a `.gguf` file name inside the app models directory.
fn validate_local_file(raw: &str) -> Result<String, ToolError> {
    let name = raw.trim();
    if !super::local::runtime::is_valid_file_name(name) {
        return Err(ToolError::invalid(
            "本地模型必须是模型目录内的 .gguf 文件名",
        ));
    }
    Ok(name.to_string())
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
        .filter(|item| {
            let result = if item.format.is_local() {
                validate_local_file(&item.base_url).map(|_| ())
            } else {
                validate_base_url(&item.base_url).map(|_| ())
            };
            match result {
                Ok(()) => true,
                Err(e) => {
                    log::warn!("skip invalid stored model {}: {e}", item.id);
                    false
                }
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
