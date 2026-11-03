//! Model discovery and connectivity checks for user-defined endpoints.
//!
//! The app ships no model catalog, so the only way to populate a Model ID is
//! either manual input or `GET <baseUrl><modelsPath>` against the user's
//! endpoint (`/models` for OpenAI formats, `/v1/models` for Anthropic).

use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::{json, Value};

use super::model_store::{self, endpoint, ApiFormat, ModelEntry};
use super::AgentState;
use crate::vfs::error::ToolError;

const MAX_MODELS: usize = 500;
const MAX_BODY_BYTES: usize = 1024 * 1024;
const FETCH_TIMEOUT: Duration = Duration::from_secs(20);
/// OpenAI Responses rejects `max_output_tokens` below 16.
const RESPONSES_MIN_OUTPUT_TOKENS: u32 = 16;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionTest {
    pub latency_ms: u64,
    pub status: u16,
    pub model: String,
}

/// Fetch the endpoint's real model ids. Full URL mode cannot expose a
/// discoverable `/models` path, so the UI must fall back to manual input.
pub async fn fetch(
    state: &AgentState,
    format: ApiFormat,
    base_url: &str,
    full_url: bool,
    api_key: &str,
) -> Result<Vec<String>, ToolError> {
    if full_url {
        return Err(ToolError::invalid(
            "Full URL 模式下无法自动发现模型，请手动填写 Model ID",
        ));
    }
    let Some(client) = &state.client else {
        return Err(ToolError::invalid("HTTP 客户端初始化失败，请重启应用"));
    };
    let base_url = model_store::normalize_anthropic_base(
        base_url.trim_end_matches('/').to_string(),
        format,
        full_url,
    );
    let url = format!("{}{}", base_url, format.models_path());
    let mut request = client.get(&url).timeout(FETCH_TIMEOUT);
    request = match format {
        ApiFormat::OpenAiChat
        | ApiFormat::OpenAiResponses
        | ApiFormat::OpenAiImages
        | ApiFormat::OpenAiAudio
        | ApiFormat::OpenAiVideos
        | ApiFormat::OpenAiTranscriptions
        | ApiFormat::DashScopeImage
        | ApiFormat::DashScopeVideo
        | ApiFormat::DashScopeTts
        | ApiFormat::VolcVideo => request.bearer_auth(api_key),
        ApiFormat::AnthropicMessages => request
            .header("x-api-key", api_key)
            .header("anthropic-version", "2023-06-01"),
        ApiFormat::ElevenLabsTts => request.header("xi-api-key", api_key),
        // Kling has no public model-list endpoint; the model name is chosen by hand.
        ApiFormat::KlingVideo => {
            return Err(ToolError::invalid(
                "可灵不支持自动发现模型，请手动填写 Model ID",
            ));
        }
        ApiFormat::LocalLlama | ApiFormat::LocalMnn => {
            return Err(ToolError::invalid("本地模型无需发现模型列表"));
        }
    };
    let resp = request
        .send()
        .await
        .map_err(|e| ToolError::invalid(format!("拉取模型列表失败：{e}")))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        let snippet: String = text.chars().take(200).collect();
        return Err(ToolError::invalid(format!(
            "服务端返回 HTTP {status}：{snippet}"
        )));
    }
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| ToolError::invalid(format!("读取模型列表失败：{e}")))?;
    if bytes.len() > MAX_BODY_BYTES {
        return Err(ToolError::invalid("模型列表响应过大"));
    }
    let json: Value = serde_json::from_slice(&bytes)
        .map_err(|e| ToolError::invalid(format!("模型列表不是合法 JSON：{e}")))?;
    parse_models(&json)
}

/// Pure parser, unit-tested without network access. OpenAI and Anthropic both
/// return `{ "data": [{ "id": "..." }] }`.
pub fn parse_models(json: &Value) -> Result<Vec<String>, ToolError> {
    let mut models: Vec<String> = json
        .get("data")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.get("id").and_then(Value::as_str))
                .map(str::trim)
                .filter(|id| !id.is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    models.sort();
    models.dedup();
    models.truncate(MAX_MODELS);
    if models.is_empty() {
        return Err(ToolError::invalid("服务端未返回任何模型"));
    }
    Ok(models)
}

/// One real, minimal request to verify key + endpoint + model id. The key is
/// used transiently and never persisted by this path.
pub async fn test_connection(
    state: &AgentState,
    entry: &ModelEntry,
    api_key: &str,
) -> Result<ConnectionTest, ToolError> {
    let Some(client) = &state.client else {
        return Err(ToolError::invalid("HTTP 客户端初始化失败，请重启应用"));
    };
    let url = endpoint(entry);
    // `max_tokens` is a required wire field for Anthropic and Responses; this
    // minimal ping value is never copied into a chat request.
    let body = match entry.format {
        ApiFormat::OpenAiChat => json!({
            "model": entry.model_id,
            "messages": [{ "role": "user", "content": "ping" }],
            "max_tokens": 1,
            "stream": false,
        }),
        ApiFormat::OpenAiResponses => json!({
            "model": entry.model_id,
            "input": "ping",
            "max_output_tokens": RESPONSES_MIN_OUTPUT_TOKENS,
            "stream": false,
        }),
        ApiFormat::AnthropicMessages => json!({
            "model": entry.model_id,
            "max_tokens": 1,
            "messages": [{ "role": "user", "content": "ping" }],
            "stream": false,
        }),
        // Media models have no chat ping; the UI disables testing for them.
        ApiFormat::OpenAiImages
        | ApiFormat::OpenAiAudio
        | ApiFormat::OpenAiVideos
        | ApiFormat::OpenAiTranscriptions
        | ApiFormat::DashScopeImage
        | ApiFormat::DashScopeVideo
        | ApiFormat::DashScopeTts
        | ApiFormat::VolcVideo
        | ApiFormat::KlingVideo
        | ApiFormat::ElevenLabsTts => {
            return Err(ToolError::invalid("媒体模型暂不支持连接测试"));
        }
        // Local entries never reach the network; the settings page handles loading.
        ApiFormat::LocalLlama | ApiFormat::LocalMnn => {
            return Err(ToolError::invalid("本地模型无需连接测试"));
        }
    };
    let mut request = client.post(&url).timeout(FETCH_TIMEOUT).json(&body);
    request = match entry.format {
        ApiFormat::OpenAiChat
        | ApiFormat::OpenAiResponses
        | ApiFormat::OpenAiImages
        | ApiFormat::OpenAiAudio
        | ApiFormat::OpenAiVideos
        | ApiFormat::OpenAiTranscriptions
        | ApiFormat::DashScopeImage
        | ApiFormat::DashScopeVideo
        | ApiFormat::DashScopeTts
        | ApiFormat::VolcVideo => request.bearer_auth(api_key),
        ApiFormat::AnthropicMessages => request
            .header("x-api-key", api_key)
            .header("anthropic-version", "2023-06-01"),
        ApiFormat::ElevenLabsTts => request.header("xi-api-key", api_key),
        ApiFormat::KlingVideo => {
            return Err(ToolError::invalid("媒体模型暂不支持连接测试"));
        }
        ApiFormat::LocalLlama | ApiFormat::LocalMnn => {
            return Err(ToolError::invalid("本地模型无需连接测试"));
        }
    };
    let started = Instant::now();
    let resp = request
        .send()
        .await
        .map_err(|e| ToolError::invalid(format!("连接测试失败：{e}")))?;
    let status = resp.status();
    if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        let snippet: String = text.chars().take(200).collect();
        return Err(ToolError::invalid(format!(
            "连接测试返回 HTTP {status}：{snippet}"
        )));
    }
    Ok(ConnectionTest {
        latency_ms: started.elapsed().as_millis() as u64,
        status: status.as_u16(),
        model: entry.model_id.clone(),
    })
}
