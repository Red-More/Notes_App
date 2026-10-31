//! pi-agent 的原生 streamProxy 等价实现：唯一边界是 Tauri channel，不是 HTTP。
//!
//! 契约与 `@earendil-works/pi-agent-core` 内置 `streamProxy` 完全一致：
//! - 参数：`{ requestId, model, context, options }`（`context.messages` 是 pi-ai `Message[]`）；
//! - 输出：`ProxyAssistantMessageEvent` 形状的 `data:` 事件（不含 `partial`，由前端重建）。
//!
//! 支持三种用户自定义协议：OpenAI Chat Completions、OpenAI Responses API、
//! Anthropic Messages。
//!
//! 安全约束（Rust 侧二次校验，不信任前端）：
//! - model.provider 必须是 `life.db` 中已存在的模型条目 id；`model.baseUrl`
//!   一律忽略，URL 只来自持久化的模型配置（HTTPS、无凭据、非内网地址）；
//! - `model.api` 必须与条目的协议一致，`model.id` 必须与条目保存的 Model ID 一致；
//! - 工具声明最多 5 个且必须在 `fs_*` 白名单内；
//! - Key 只从 Rust 私有存储（Keystore / 0600 文件）读取，请求体不接受 `apiKey`；
//! - 禁用重定向、仅 HTTPS。

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use super::model_store::{self, ApiFormat, ModelEntry};
use super::params::LlmParams;
use super::{AgentState, TOOL_ALLOWLIST};
use crate::vfs::error::ToolError;

const MAX_SYSTEM_BYTES: usize = 64 * 1024;
const MAX_MESSAGES: usize = 200;
const MAX_TOTAL_BYTES: usize = 4 * 1024 * 1024;
const MAX_MODEL_CHARS: usize = 100;
/// Anthropic rejects requests without `max_tokens`; used only when the user
/// left both `max_tokens` and the output context window empty.
const ANTHROPIC_REQUIRED_MAX_TOKENS: u32 = 4096;

// ---------------------------------------------------------------------------
// 请求：pi 的 { model, context, options }
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyRequest {
    /// 前端生成的幂等 id，用于 `agent_cancel`。
    pub request_id: String,
    /// pi 的 Model 对象；只读取 id/provider，baseUrl/headers 全部忽略。
    pub model: ModelRef,
    #[serde(default)]
    pub context: ProxyContext,
    #[serde(default)]
    pub options: Options,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ModelRef {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub provider: String,
    #[serde(default)]
    pub api: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct ProxyContext {
    #[serde(default)]
    pub messages: Vec<Value>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Options {
    #[serde(default)]
    pub temperature: Option<f64>,
    #[serde(default)]
    pub max_tokens: Option<u32>,
    #[serde(default)]
    pub tool_choice: Option<String>,
}

/// 工具声明，直接取自 pi 的 `Tool`（`parameters` 是 TypeBox 生成的 JSON Schema）。
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct ToolSpec {
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub parameters: Value,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCallSpec {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub arguments: Value,
}

// ---------------------------------------------------------------------------
// 输出：ProxyAssistantMessageEvent
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    pub input: i64,
    pub output: i64,
    pub cache_read: i64,
    pub cache_write: i64,
    pub total_tokens: i64,
    pub cost: Cost,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Cost {
    pub input: f64,
    pub output: f64,
    pub cache_read: f64,
    pub cache_write: f64,
    pub total: f64,
}

impl Default for Usage {
    fn default() -> Self {
        Self {
            input: 0,
            output: 0,
            cache_read: 0,
            cache_write: 0,
            total_tokens: 0,
            cost: Cost {
                input: 0.0,
                output: 0.0,
                cache_read: 0.0,
                cache_write: 0.0,
                total: 0.0,
            },
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCallPayload {
    #[serde(rename = "type")]
    pub kind: &'static str,
    pub id: String,
    pub name: String,
    pub arguments: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub arguments_error: Option<String>,
}

impl ToolCallPayload {
    fn new(id: String, name: String, raw_json: &str) -> Self {
        match serde_json::from_str::<Value>(raw_json.trim()) {
            Ok(Value::Object(map)) => Self {
                kind: "toolCall",
                id,
                name,
                arguments: Value::Object(map),
                arguments_error: None,
            },
            Ok(other) => Self {
                kind: "toolCall",
                id,
                name,
                arguments: json!({}),
                arguments_error: Some(format!("参数不是 JSON 对象：{other}")),
            },
            Err(e) => Self {
                kind: "toolCall",
                id,
                name,
                arguments: json!({}),
                arguments_error: Some(format!("参数 JSON 解析失败：{e}")),
            },
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type")]
pub enum StreamEvent {
    #[serde(rename = "start")]
    Start,
    #[serde(rename = "text_start")]
    TextStart {
        #[serde(rename = "contentIndex")]
        content_index: usize,
    },
    #[serde(rename = "text_delta")]
    TextDelta {
        #[serde(rename = "contentIndex")]
        content_index: usize,
        delta: String,
    },
    #[serde(rename = "text_end")]
    TextEnd {
        #[serde(rename = "contentIndex")]
        content_index: usize,
    },
    #[serde(rename = "toolcall_start")]
    ToolCallStart {
        #[serde(rename = "contentIndex")]
        content_index: usize,
        id: String,
        #[serde(rename = "toolName")]
        tool_name: String,
    },
    #[serde(rename = "toolcall_delta")]
    ToolCallDelta {
        #[serde(rename = "contentIndex")]
        content_index: usize,
        delta: String,
    },
    #[serde(rename = "toolcall_end")]
    ToolCallEnd {
        #[serde(rename = "contentIndex")]
        content_index: usize,
        #[serde(rename = "toolCall")]
        tool_call: ToolCallPayload,
    },
    #[serde(rename = "done")]
    Done { reason: String, usage: Usage },
    #[serde(rename = "error")]
    Error {
        reason: String,
        #[serde(rename = "errorMessage")]
        error_message: String,
        usage: Usage,
    },
}

type Emit<'a> = &'a (dyn Fn(StreamEvent) + Send + Sync);

fn emit_error(emit: Emit<'_>, message: impl Into<String>, reason: &str) {
    emit(StreamEvent::Error {
        reason: reason.to_string(),
        error_message: message.into(),
        usage: Usage::default(),
    });
}

// ---------------------------------------------------------------------------
// pi transcript → 中立 turns
// ---------------------------------------------------------------------------

enum Role {
    User,
    Assistant,
    Tool,
}

struct Turn {
    role: Role,
    text: String,
    tool_calls: Vec<ToolCallSpec>,
    tool_call_id: Option<String>,
    is_error: bool,
}

fn text_of(content: &Value) -> String {
    match content {
        Value::String(s) => s.clone(),
        Value::Array(items) => items
            .iter()
            .filter_map(|item| item.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

/// 重放 transcript 里的所有 system 消息：base prompt + sections + tools 增删。
pub(crate) fn replay_system(messages: &[Value]) -> (String, Vec<ToolSpec>) {
    let mut parts: Vec<String> = Vec::new();
    let mut sections: BTreeMap<String, String> = BTreeMap::new();
    let mut tools: Vec<ToolSpec> = Vec::new();

    for message in messages {
        if message.get("role").and_then(Value::as_str) != Some("system") {
            continue;
        }
        if let Some(content) = message.get("content") {
            let text = text_of(content);
            if !text.trim().is_empty() {
                parts.push(text);
            }
        }
        if let Some(map) = message.get("sections").and_then(Value::as_object) {
            for (name, value) in map {
                match value.as_str() {
                    Some(text) => {
                        sections.insert(name.clone(), text.to_string());
                    }
                    None => {
                        sections.remove(name);
                    }
                }
            }
        }
        if let Some(added) = message.get("toolsAdded").and_then(Value::as_array) {
            for item in added {
                if let Ok(spec) = serde_json::from_value::<ToolSpec>(item.clone()) {
                    tools.retain(|t| t.name != spec.name);
                    tools.push(spec);
                }
            }
        }
        if let Some(removed) = message.get("toolsRemoved").and_then(Value::as_array) {
            for item in removed {
                if let Some(name) = item.get("name").and_then(Value::as_str) {
                    tools.retain(|t| t.name != name);
                }
            }
        }
    }

    let mut prompt = parts.join("\n\n");
    for value in sections.values() {
        if !value.trim().is_empty() {
            prompt.push_str("\n\n");
            prompt.push_str(value);
        }
    }
    (prompt, tools)
}

fn parse_tool_call(item: &Value) -> Option<ToolCallSpec> {
    serde_json::from_value::<ToolCallSpec>(item.clone()).ok()
}

fn to_turns(messages: &[Value]) -> Vec<Turn> {
    let mut turns = Vec::new();
    for message in messages {
        match message.get("role").and_then(Value::as_str).unwrap_or("") {
            "user" => turns.push(Turn {
                role: Role::User,
                text: message.get("content").map(text_of).unwrap_or_default(),
                tool_calls: Vec::new(),
                tool_call_id: None,
                is_error: false,
            }),
            "assistant" => {
                let mut text = String::new();
                let mut calls = Vec::new();
                if let Some(items) = message.get("content").and_then(Value::as_array) {
                    for item in items {
                        match item.get("type").and_then(Value::as_str).unwrap_or("") {
                            "text" => {
                                if let Some(t) = item.get("text").and_then(Value::as_str) {
                                    if !text.is_empty() {
                                        text.push('\n');
                                    }
                                    text.push_str(t);
                                }
                            }
                            "toolCall" => {
                                if let Some(spec) = parse_tool_call(item) {
                                    calls.push(spec);
                                }
                            }
                            _ => {}
                        }
                    }
                }
                turns.push(Turn {
                    role: Role::Assistant,
                    text,
                    tool_calls: calls,
                    tool_call_id: None,
                    is_error: false,
                });
            }
            "toolResult" => {
                let error = message
                    .get("isError")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                let mut text = message.get("content").map(text_of).unwrap_or_default();
                if error {
                    text = format!("[error] {text}");
                }
                turns.push(Turn {
                    role: Role::Tool,
                    text,
                    tool_calls: Vec::new(),
                    tool_call_id: message
                        .get("toolCallId")
                        .and_then(Value::as_str)
                        .map(|s| s.to_string()),
                    is_error: error,
                });
            }
            _ => {}
        }
    }
    turns
}

// ---------------------------------------------------------------------------
// 校验
// ---------------------------------------------------------------------------

pub fn validate_request(req: &ProxyRequest, entry: &ModelEntry) -> Result<(), ToolError> {
    if req.model.provider != entry.id {
        return Err(ToolError::invalid("未找到模型"));
    }
    if req.request_id.trim().is_empty() || req.request_id.chars().count() > 64 {
        return Err(ToolError::invalid("requestId 非法"));
    }
    // baseUrl/headers 等字段一律忽略：URL 只能来自 life.db 中的模型条目。
    if !req.model.api.is_empty() && req.model.api != entry.format.pi_api() {
        return Err(ToolError::invalid("model.api 与模型协议不一致"));
    }
    let model = req.model.id.trim();
    if model.is_empty() || model.chars().count() > MAX_MODEL_CHARS {
        return Err(ToolError::invalid("模型名非法"));
    }
    if model.chars().any(char::is_control) {
        return Err(ToolError::invalid("模型名包含控制字符"));
    }
    // The request may only use the model id saved for this entry.
    if model != entry.model_id {
        return Err(ToolError::invalid("请求模型与已保存的 Model ID 不一致"));
    }
    if req.context.messages.len() > MAX_MESSAGES {
        return Err(ToolError::invalid(format!("消息条数超过 {MAX_MESSAGES}")));
    }
    let (system, tools) = replay_system(&req.context.messages);
    if system.len() > MAX_SYSTEM_BYTES {
        return Err(ToolError::invalid("system prompt 超过 64KB"));
    }
    // 只序列化一次整份上下文来计算大小，避免逐条 to_string 造成重复分配。
    let total = serde_json::to_vec(&req.context.messages)
        .map_err(|e| ToolError::invalid(format!("上下文序列化失败：{e}")))?
        .len();
    if total > MAX_TOTAL_BYTES {
        return Err(ToolError::invalid("单次请求上下文超过 4MB"));
    }
    if tools.len() > TOOL_ALLOWLIST.len() {
        return Err(ToolError::invalid("工具数量超过 5 个白名单"));
    }
    for tool in &tools {
        if !TOOL_ALLOWLIST.contains(&tool.name.as_str()) {
            return Err(ToolError::invalid(format!(
                "工具 {} 不在白名单内",
                tool.name
            )));
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

/// 保留全部 system 消息与最近的非 system 消息，总数不超过 MAX_MESSAGES。
/// 避免长会话超过上限后每次请求都失败；历史仍完整保存在数据库里。
pub(crate) fn trim_messages(messages: &[Value]) -> Vec<Value> {
    if messages.len() <= MAX_MESSAGES {
        return messages.to_vec();
    }
    let mut system = Vec::new();
    let mut rest = Vec::new();
    for message in messages {
        if message.get("role").and_then(Value::as_str) == Some("system") {
            system.push(message.clone());
        } else {
            rest.push(message.clone());
        }
    }
    let keep = MAX_MESSAGES.saturating_sub(system.len());
    let mut result = system;
    if keep > 0 {
        let start = rest.len().saturating_sub(keep);
        result.extend(rest.drain(start..));
    }
    result
}

pub async fn run(
    state: &AgentState,
    req: ProxyRequest,
    entry: &ModelEntry,
    params: &LlmParams,
    cancel: Arc<AtomicBool>,
    emit: Emit<'_>,
) -> Result<(), ToolError> {
    // 长会话先裁剪再校验：宁可丢弃最旧的对话轮次，也不能让整次请求失败。
    let mut req = req;
    req.context.messages = trim_messages(&req.context.messages);
    validate_request(&req, entry)?;
    emit(StreamEvent::Start);

    let (system, tools) = replay_system(&req.context.messages);
    let turns = to_turns(&req.context.messages);
    let model = entry.model_id.clone();

    let key = match state.secrets.get(&entry.id) {
        Ok(Some(key)) if !key.trim().is_empty() => key,
        Ok(_) => {
            emit_error(
                emit,
                format!("尚未配置 {} 的 API Key，请到设置页编辑模型", entry.label),
                "error",
            );
            return Ok(());
        }
        Err(e) => {
            emit_error(emit, format!("密钥存储不可用：{e}"), "error");
            return Ok(());
        }
    };

    let stream = params.stream_enabled();
    // URL 只能来自 life.db 的模型条目；请求体里的 baseUrl 一律忽略。
    let endpoint = model_store::endpoint(entry);
    let prepared = Prepared {
        model: &model,
        endpoint: &endpoint,
        system: &system,
        tools: &tools,
        turns: &turns,
        options: &req.options,
        params,
    };
    let result = match (entry.format, stream) {
        (ApiFormat::OpenAiChat, true) => {
            openai_stream(state, &key, &prepared, &cancel, emit).await
        }
        (ApiFormat::OpenAiChat, false) => openai_json(state, &key, &prepared, &cancel, emit).await,
        (ApiFormat::OpenAiResponses, true) => {
            responses_stream(state, &key, &prepared, &cancel, emit).await
        }
        (ApiFormat::OpenAiResponses, false) => {
            responses_json(state, &key, &prepared, &cancel, emit).await
        }
        (ApiFormat::AnthropicMessages, true) => {
            anthropic_stream(state, &key, &prepared, &cancel, emit).await
        }
        (ApiFormat::AnthropicMessages, false) => {
            anthropic_json(state, &key, &prepared, &cancel, emit).await
        }
    };

    if let Err(message) = result {
        emit_error(
            emit,
            message,
            if cancel.load(Ordering::SeqCst) {
                "aborted"
            } else {
                "error"
            },
        );
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// HTTP / SSE 基础设施
// ---------------------------------------------------------------------------

async fn send_json(
    state: &AgentState,
    url: &str,
    headers: &[(&str, String)],
    body: &Value,
    timeout: Option<std::time::Duration>,
) -> Result<reqwest::Response, String> {
    // 客户端初始化失败时以错误形式回给 UI，绝不降级到裸 Client。
    let Some(client) = &state.client else {
        return Err("HTTP 客户端初始化失败，请重启应用".to_string());
    };
    let mut builder = client.post(url).json(body);
    if let Some(limit) = timeout {
        builder = builder.timeout(limit);
    }
    for (name, value) in headers {
        builder = builder.header(*name, value.clone());
    }
    let resp = builder
        .send()
        .await
        .map_err(|e| format!("网络请求失败：{e}"))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        let snippet: String = text.chars().take(300).collect();
        return Err(format!("厂商返回 HTTP {status}：{snippet}"));
    }
    Ok(resp)
}

enum SseOutcome {
    Completed,
    Cancelled,
}

/// 逐行读取 SSE；跨 chunk 的 UTF-8 与换行都在字节层处理，避免中文被截断。
async fn read_sse<F>(
    resp: reqwest::Response,
    cancel: &AtomicBool,
    mut on_data: F,
) -> Result<SseOutcome, String>
where
    F: FnMut(&str),
{
    let mut stream = Box::pin(resp.bytes_stream());
    let mut buffer: Vec<u8> = Vec::new();
    while let Some(chunk) = stream.next().await {
        if cancel.load(Ordering::SeqCst) {
            return Ok(SseOutcome::Cancelled);
        }
        let chunk = chunk.map_err(|e| format!("流式读取失败：{e}"))?;
        buffer.extend_from_slice(&chunk);
        while let Some(pos) = buffer.iter().position(|b| *b == b'\n') {
            let line: Vec<u8> = buffer.drain(..=pos).collect();
            let line = String::from_utf8_lossy(&line);
            let line = line.trim_end_matches(['\r', '\n']);
            if let Some(data) = line.strip_prefix("data:") {
                let data = data.trim();
                if !data.is_empty() {
                    on_data(data);
                }
            }
        }
    }
    if cancel.load(Ordering::SeqCst) {
        return Ok(SseOutcome::Cancelled);
    }
    Ok(SseOutcome::Completed)
}

/// 一次请求里与厂商无关的已准备数据，避免适配器参数过长。
struct Prepared<'a> {
    model: &'a str,
    /// Fully built endpoint from the stored model entry.
    endpoint: &'a str,
    system: &'a str,
    tools: &'a [ToolSpec],
    turns: &'a [Turn],
    options: &'a Options,
    params: &'a LlmParams,
}

// ---------------------------------------------------------------------------
// OpenAI（/v1/chat/completions）
// ---------------------------------------------------------------------------

fn openai_body(
    model: &str,
    system: &str,
    tools: &[ToolSpec],
    turns: &[Turn],
    options: &Options,
) -> Value {
    let mut messages: Vec<Value> = Vec::new();
    if !system.trim().is_empty() {
        messages.push(json!({ "role": "system", "content": system }));
    }
    for turn in turns {
        match turn.role {
            Role::Assistant => {
                if turn.tool_calls.is_empty() {
                    messages.push(json!({ "role": "assistant", "content": turn.text }));
                } else {
                    let calls: Vec<Value> = turn
                        .tool_calls
                        .iter()
                        .map(|c| {
                            json!({
                                "id": c.id,
                                "type": "function",
                                "function": {
                                    "name": c.name,
                                    "arguments": serde_json::to_string(&c.arguments)
                                        .unwrap_or_else(|_| "{}".to_string()),
                                }
                            })
                        })
                        .collect();
                    messages.push(json!({
                        "role": "assistant",
                        "content": if turn.text.is_empty() {
                            Value::Null
                        } else {
                            json!(turn.text)
                        },
                        "tool_calls": calls,
                    }));
                }
            }
            Role::Tool => messages.push(json!({
                "role": "tool",
                "tool_call_id": turn.tool_call_id.clone().unwrap_or_default(),
                "content": turn.text,
            })),
            Role::User => messages.push(json!({ "role": "user", "content": turn.text })),
        }
    }

    let mut body = Map::new();
    body.insert("model".into(), json!(model));
    body.insert("messages".into(), Value::Array(messages));
    body.insert("stream".into(), json!(true));
    body.insert("stream_options".into(), json!({ "include_usage": true }));
    if let Some(temp) = options.temperature {
        body.insert("temperature".into(), json!(temp));
    }
    if let Some(max) = options.max_tokens {
        body.insert("max_tokens".into(), json!(max));
    }
    if !tools.is_empty() {
        let specs: Vec<Value> = tools
            .iter()
            .map(|t| {
                json!({
                    "type": "function",
                    "function": {
                        "name": t.name,
                        "description": t.description,
                        "parameters": t.parameters,
                    }
                })
            })
            .collect();
        body.insert("tools".into(), Value::Array(specs));
        let choice = options
            .tool_choice
            .as_deref()
            .filter(|c| *c == "auto" || *c == "none")
            .unwrap_or("auto");
        body.insert("tool_choice".into(), json!(choice));
    }
    Value::Object(body)
}

/// Base OpenAI body + stored params + passthrough, with `stream` honoured.
fn prepare_openai_body(req: &Prepared<'_>) -> Result<Value, ToolError> {
    let mut body = openai_body(req.model, req.system, req.tools, req.turns, req.options);
    let Some(map) = body.as_object_mut() else {
        unreachable!("openai body is always an object")
    };
    let stream = req.params.stream_enabled();
    req.params.apply_openai(map);
    map.insert("stream".into(), json!(stream));
    if !stream {
        map.remove("stream_options");
    }
    req.params.merge_extra(map)?;
    Ok(body)
}

struct OpenAiToolState {
    /// OpenAI 侧 `tool_calls[i].index`，唯一对应一次工具调用。
    openai_index: usize,
    /// 输出给前端的内容块编号；与 openai_index 无关，只负责 contentIndex 连续。
    block: usize,
    id: String,
    name: String,
    args: String,
}

async fn openai_stream(
    state: &AgentState,
    key: &str,
    req: &Prepared<'_>,
    cancel: &AtomicBool,
    emit: Emit<'_>,
) -> Result<(), String> {
    let body = prepare_openai_body(req).map_err(|e| e.to_string())?;
    let headers = [
        ("authorization", format!("Bearer {key}")),
        ("content-type", "application/json".to_string()),
    ];
    let resp = send_json(state, req.endpoint, &headers, &body, req.params.timeout()).await?;

    let mut next_index = 0usize;
    let mut text_index: Option<usize> = None;
    let mut tool_states: Vec<OpenAiToolState> = Vec::new();
    let mut finish: Option<String> = None;
    let mut usage = Usage::default();

    let outcome = read_sse(resp, cancel, |data| {
        let Ok(chunk) = serde_json::from_str::<Value>(data) else {
            return;
        };
        if let Some(u) = chunk.get("usage").filter(|u| !u.is_null()) {
            usage.input = u.get("prompt_tokens").and_then(Value::as_i64).unwrap_or(0);
            usage.output = u
                .get("completion_tokens")
                .and_then(Value::as_i64)
                .unwrap_or(0);
            usage.total_tokens = u
                .get("total_tokens")
                .and_then(Value::as_i64)
                .unwrap_or(usage.input + usage.output);
        }
        let Some(choice) = chunk
            .get("choices")
            .and_then(Value::as_array)
            .and_then(|a| a.first())
        else {
            return;
        };
        if let Some(reason) = choice.get("finish_reason").and_then(Value::as_str) {
            finish = Some(reason.to_string());
        }
        let Some(delta) = choice.get("delta") else {
            return;
        };
        if let Some(text) = delta.get("content").and_then(Value::as_str) {
            if !text.is_empty() {
                let index = *text_index.get_or_insert_with(|| {
                    let index = next_index;
                    next_index += 1;
                    emit(StreamEvent::TextStart {
                        content_index: index,
                    });
                    index
                });
                emit(StreamEvent::TextDelta {
                    content_index: index,
                    delta: text.to_string(),
                });
            }
        }
        let Some(calls) = delta.get("tool_calls").and_then(Value::as_array) else {
            return;
        };
        for call in calls {
            let key_index = call.get("index").and_then(Value::as_u64).unwrap_or(0) as usize;
            // 用 OpenAI 的 index 匹配已创建的工具状态，绝不能拿内容块编号比，
            // 否则文本先占用了 contentIndex 0 后，工具状态会被重复创建或参数拼错。
            let existing = tool_states.iter().position(|t| t.openai_index == key_index);
            let slot = match existing {
                Some(pos) => pos,
                None => {
                    let block = next_index;
                    next_index += 1;
                    let id = call
                        .get("id")
                        .and_then(Value::as_str)
                        .map(|s| s.to_string())
                        .unwrap_or_else(|| format!("call_{key_index}"));
                    let name = call
                        .get("function")
                        .and_then(|f| f.get("name"))
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string();
                    emit(StreamEvent::ToolCallStart {
                        content_index: block,
                        id: id.clone(),
                        tool_name: name.clone(),
                    });
                    tool_states.push(OpenAiToolState {
                        openai_index: key_index,
                        block,
                        id,
                        name,
                        args: String::new(),
                    });
                    tool_states.len() - 1
                }
            };
            if let Some(name) = call
                .get("function")
                .and_then(|f| f.get("name"))
                .and_then(Value::as_str)
            {
                if tool_states[slot].name.is_empty() {
                    tool_states[slot].name = name.to_string();
                }
            }
            if let Some(args) = call
                .get("function")
                .and_then(|f| f.get("arguments"))
                .and_then(Value::as_str)
            {
                if !args.is_empty() {
                    tool_states[slot].args.push_str(args);
                    emit(StreamEvent::ToolCallDelta {
                        content_index: tool_states[slot].block,
                        delta: args.to_string(),
                    });
                }
            }
        }
    })
    .await?;

    if matches!(outcome, SseOutcome::Cancelled) {
        emit(StreamEvent::Error {
            reason: "aborted".to_string(),
            error_message: "已取消".to_string(),
            usage,
        });
        return Ok(());
    }

    if let Some(index) = text_index {
        emit(StreamEvent::TextEnd {
            content_index: index,
        });
    }
    for tool in &tool_states {
        emit(StreamEvent::ToolCallEnd {
            content_index: tool.block,
            tool_call: ToolCallPayload::new(tool.id.clone(), tool.name.clone(), &tool.args),
        });
    }
    let reason = match finish.as_deref() {
        Some("tool_calls") => "toolUse",
        Some("length") => "length",
        _ => {
            if tool_states.is_empty() {
                "stop"
            } else {
                "toolUse"
            }
        }
    };
    emit(StreamEvent::Done {
        reason: reason.to_string(),
        usage,
    });
    Ok(())
}

// ---------------------------------------------------------------------------
// OpenAI Responses API（/v1/responses）
// ---------------------------------------------------------------------------

fn responses_body(
    model: &str,
    system: &str,
    tools: &[ToolSpec],
    turns: &[Turn],
    options: &Options,
) -> Value {
    let mut input: Vec<Value> = Vec::new();
    for turn in turns {
        match turn.role {
            Role::Assistant => {
                if !turn.text.is_empty() {
                    input.push(json!({
                        "type": "message",
                        "role": "assistant",
                        "content": [{ "type": "output_text", "text": turn.text }],
                    }));
                }
                for call in &turn.tool_calls {
                    input.push(json!({
                        "type": "function_call",
                        "call_id": call.id,
                        "name": call.name,
                        "arguments": serde_json::to_string(&call.arguments)
                            .unwrap_or_else(|_| "{}".to_string()),
                    }));
                }
            }
            Role::Tool => input.push(json!({
                "type": "function_call_output",
                "call_id": turn.tool_call_id.clone().unwrap_or_default(),
                "output": turn.text,
            })),
            Role::User => input.push(json!({
                "type": "message",
                "role": "user",
                "content": [{ "type": "input_text", "text": turn.text }],
            })),
        }
    }

    let mut body = Map::new();
    body.insert("model".into(), json!(model));
    body.insert("input".into(), Value::Array(input));
    body.insert("stream".into(), json!(true));
    if !system.trim().is_empty() {
        body.insert("instructions".into(), json!(system));
    }
    if !tools.is_empty() {
        let specs: Vec<Value> = tools
            .iter()
            .map(|t| {
                json!({
                    "type": "function",
                    "name": t.name,
                    "description": t.description,
                    "parameters": t.parameters,
                })
            })
            .collect();
        body.insert("tools".into(), Value::Array(specs));
        body.insert("tool_choice".into(), json!("auto"));
    }
    if let Some(temp) = options.temperature {
        body.insert("temperature".into(), json!(temp));
    }
    if let Some(max) = options.max_tokens {
        body.insert("max_output_tokens".into(), json!(max));
    }
    Value::Object(body)
}

/// Base Responses body + stored params + passthrough, with `stream` honoured.
fn prepare_responses_body(req: &Prepared<'_>) -> Result<Value, ToolError> {
    let mut body = responses_body(req.model, req.system, req.tools, req.turns, req.options);
    let Some(map) = body.as_object_mut() else {
        unreachable!("responses body is always an object")
    };
    req.params.apply_openai_responses(map);
    map.insert("stream".into(), json!(req.params.stream_enabled()));
    req.params.merge_extra(map)?;
    Ok(body)
}

struct ResponsesToolState {
    output_index: usize,
    block: usize,
    call_id: String,
    name: String,
    args: String,
    done: bool,
}

fn responses_usage(response: &Value) -> Usage {
    let mut usage = Usage::default();
    if let Some(u) = response.get("usage") {
        usage.input = u.get("input_tokens").and_then(Value::as_i64).unwrap_or(0);
        usage.output = u.get("output_tokens").and_then(Value::as_i64).unwrap_or(0);
        usage.cache_read = u
            .get("input_tokens_details")
            .and_then(|d| d.get("cached_tokens"))
            .and_then(Value::as_i64)
            .unwrap_or(0);
        usage.total_tokens = u
            .get("total_tokens")
            .and_then(Value::as_i64)
            .unwrap_or(usage.input + usage.output);
    }
    usage
}

async fn responses_stream(
    state: &AgentState,
    key: &str,
    req: &Prepared<'_>,
    cancel: &AtomicBool,
    emit: Emit<'_>,
) -> Result<(), String> {
    let body = prepare_responses_body(req).map_err(|e| e.to_string())?;
    let headers = [
        ("authorization", format!("Bearer {key}")),
        ("content-type", "application/json".to_string()),
    ];
    let resp = send_json(state, req.endpoint, &headers, &body, req.params.timeout()).await?;

    let mut next_index = 0usize;
    let mut text_index: Option<usize> = None;
    let mut text_ended = false;
    let mut tool_states: Vec<ResponsesToolState> = Vec::new();
    let mut usage = Usage::default();
    let mut incomplete_reason: Option<String> = None;
    let mut error_message: Option<String> = None;

    let outcome = read_sse(resp, cancel, |data| {
        let Ok(event) = serde_json::from_str::<Value>(data) else {
            return;
        };
        match event.get("type").and_then(Value::as_str).unwrap_or("") {
            "response.output_item.added" => {
                let item = event.get("item").cloned().unwrap_or(Value::Null);
                if item.get("type").and_then(Value::as_str) != Some("function_call") {
                    return;
                }
                let output_index = event
                    .get("output_index")
                    .and_then(Value::as_u64)
                    .unwrap_or(0) as usize;
                if tool_states.iter().any(|t| t.output_index == output_index) {
                    return;
                }
                let block = next_index;
                next_index += 1;
                let call_id = item
                    .get("call_id")
                    .or_else(|| item.get("id"))
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .unwrap_or_else(|| format!("call_{output_index}"));
                let name = item
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                emit(StreamEvent::ToolCallStart {
                    content_index: block,
                    id: call_id.clone(),
                    tool_name: name.clone(),
                });
                tool_states.push(ResponsesToolState {
                    output_index,
                    block,
                    call_id,
                    name,
                    args: String::new(),
                    done: false,
                });
            }
            "response.output_text.delta" | "response.refusal.delta" => {
                if text_ended {
                    return;
                }
                let Some(delta) = event.get("delta").and_then(Value::as_str) else {
                    return;
                };
                if delta.is_empty() {
                    return;
                }
                let index = *text_index.get_or_insert_with(|| {
                    let index = next_index;
                    next_index += 1;
                    emit(StreamEvent::TextStart {
                        content_index: index,
                    });
                    index
                });
                emit(StreamEvent::TextDelta {
                    content_index: index,
                    delta: delta.to_string(),
                });
            }
            "response.function_call_arguments.delta" => {
                let output_index = event
                    .get("output_index")
                    .and_then(Value::as_u64)
                    .unwrap_or(0) as usize;
                let Some(state) = tool_states
                    .iter_mut()
                    .find(|t| t.output_index == output_index && !t.done)
                else {
                    return;
                };
                let Some(delta) = event.get("delta").and_then(Value::as_str) else {
                    return;
                };
                if delta.is_empty() {
                    return;
                }
                state.args.push_str(delta);
                emit(StreamEvent::ToolCallDelta {
                    content_index: state.block,
                    delta: delta.to_string(),
                });
            }
            "response.output_item.done" => {
                let item = event.get("item").cloned().unwrap_or(Value::Null);
                let output_index = event
                    .get("output_index")
                    .and_then(Value::as_u64)
                    .unwrap_or(0) as usize;
                match item.get("type").and_then(Value::as_str).unwrap_or("") {
                    "function_call" => {
                        let Some(state) = tool_states
                            .iter_mut()
                            .find(|t| t.output_index == output_index)
                        else {
                            return;
                        };
                        if state.done {
                            return;
                        }
                        // Prefer the complete arguments carried by the done item.
                        let args = item
                            .get("arguments")
                            .and_then(Value::as_str)
                            .filter(|value| !value.is_empty())
                            .unwrap_or(&state.args)
                            .to_string();
                        state.done = true;
                        emit(StreamEvent::ToolCallEnd {
                            content_index: state.block,
                            tool_call: ToolCallPayload::new(
                                state.call_id.clone(),
                                state.name.clone(),
                                &args,
                            ),
                        });
                    }
                    "message" => {
                        if let Some(index) = text_index {
                            if !text_ended {
                                emit(StreamEvent::TextEnd {
                                    content_index: index,
                                });
                                text_ended = true;
                            }
                        }
                    }
                    _ => {}
                }
            }
            "response.completed" | "response.incomplete" | "response.failed" => {
                let response = event.get("response").cloned().unwrap_or(Value::Null);
                usage = responses_usage(&response);
                if let Some(reason) = response
                    .get("incomplete_details")
                    .and_then(|d| d.get("reason"))
                    .and_then(Value::as_str)
                {
                    incomplete_reason = Some(reason.to_string());
                }
                if let Some(error) = response.get("error") {
                    let code = error.get("code").and_then(Value::as_str).unwrap_or("");
                    let message = error.get("message").and_then(Value::as_str).unwrap_or("");
                    let text = format!("{code}: {message}");
                    error_message = Some(text.trim_matches([':', ' ']).to_string());
                }
            }
            "error" => {
                let code = event.get("code").and_then(Value::as_str).unwrap_or("");
                let message = event.get("message").and_then(Value::as_str).unwrap_or("");
                let text = format!("{code}: {message}");
                error_message = Some(text.trim_matches([':', ' ']).to_string());
            }
            _ => {}
        }
    })
    .await?;

    if matches!(outcome, SseOutcome::Cancelled) {
        emit(StreamEvent::Error {
            reason: "aborted".to_string(),
            error_message: "已取消".to_string(),
            usage,
        });
        return Ok(());
    }
    if let Some(message) = error_message {
        emit(StreamEvent::Error {
            reason: "error".to_string(),
            error_message: message,
            usage,
        });
        return Ok(());
    }

    if let Some(index) = text_index {
        if !text_ended {
            emit(StreamEvent::TextEnd {
                content_index: index,
            });
        }
    }
    for state in tool_states.iter().filter(|state| !state.done) {
        emit(StreamEvent::ToolCallEnd {
            content_index: state.block,
            tool_call: ToolCallPayload::new(state.call_id.clone(), state.name.clone(), &state.args),
        });
    }
    let reason = if incomplete_reason.as_deref() == Some("max_output_tokens") {
        "length"
    } else if tool_states.is_empty() {
        "stop"
    } else {
        "toolUse"
    };
    emit(StreamEvent::Done {
        reason: reason.to_string(),
        usage,
    });
    Ok(())
}

async fn responses_json(
    state: &AgentState,
    key: &str,
    req: &Prepared<'_>,
    cancel: &AtomicBool,
    emit: Emit<'_>,
) -> Result<(), String> {
    let body = prepare_responses_body(req).map_err(|e| e.to_string())?;
    let headers = [
        ("authorization", format!("Bearer {key}")),
        ("content-type", "application/json".to_string()),
    ];
    let resp = send_json(state, req.endpoint, &headers, &body, req.params.timeout()).await?;
    let payload = read_json_response(resp).await?;
    if cancel.load(Ordering::SeqCst) {
        emit(StreamEvent::Error {
            reason: "aborted".to_string(),
            error_message: "已取消".to_string(),
            usage: Usage::default(),
        });
        return Ok(());
    }

    let usage = responses_usage(&payload);
    let mut index = 0usize;
    let mut has_tools = false;
    if let Some(items) = payload.get("output").and_then(Value::as_array) {
        for item in items {
            match item.get("type").and_then(Value::as_str).unwrap_or("") {
                "message" => {
                    let text = item
                        .get("content")
                        .and_then(Value::as_array)
                        .map(|parts| {
                            parts
                                .iter()
                                .filter_map(|part| {
                                    part.get("text")
                                        .or_else(|| part.get("refusal"))
                                        .and_then(Value::as_str)
                                })
                                .collect::<Vec<_>>()
                                .join("")
                        })
                        .unwrap_or_default();
                    emit_text_block(emit, index, &text);
                    if !text.trim().is_empty() {
                        index += 1;
                    }
                }
                "function_call" => {
                    let id = item
                        .get("call_id")
                        .or_else(|| item.get("id"))
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string();
                    let name = item
                        .get("name")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string();
                    let args = item
                        .get("arguments")
                        .and_then(Value::as_str)
                        .unwrap_or("{}");
                    emit_raw_tool_block(emit, index, id, name, args);
                    index += 1;
                    has_tools = true;
                }
                _ => {}
            }
        }
    }
    let reason = if payload
        .get("incomplete_details")
        .and_then(|d| d.get("reason"))
        .and_then(Value::as_str)
        == Some("max_output_tokens")
    {
        "length"
    } else if has_tools {
        "toolUse"
    } else {
        "stop"
    };
    emit(StreamEvent::Done {
        reason: reason.to_string(),
        usage,
    });
    Ok(())
}

// ---------------------------------------------------------------------------
// Anthropic（/v1/messages）
// ---------------------------------------------------------------------------

fn anthropic_body(
    model: &str,
    system: &str,
    tools: &[ToolSpec],
    turns: &[Turn],
    options: &Options,
) -> Value {
    let mut messages: Vec<Value> = Vec::new();
    for turn in turns {
        match turn.role {
            Role::Assistant => {
                let mut blocks: Vec<Value> = Vec::new();
                if !turn.text.is_empty() {
                    blocks.push(json!({ "type": "text", "text": turn.text }));
                }
                for call in &turn.tool_calls {
                    blocks.push(json!({
                        "type": "tool_use",
                        "id": call.id,
                        "name": call.name,
                        "input": call.arguments,
                    }));
                }
                if !blocks.is_empty() {
                    push_turn(&mut messages, "assistant", blocks);
                }
            }
            Role::Tool => {
                let block = json!({
                    "type": "tool_result",
                    "tool_use_id": turn.tool_call_id.clone().unwrap_or_default(),
                    "content": turn.text,
                    "is_error": turn.is_error,
                });
                push_turn(&mut messages, "user", vec![block]);
            }
            Role::User => push_turn(
                &mut messages,
                "user",
                vec![json!({ "type": "text", "text": turn.text })],
            ),
        }
    }

    let mut body = Map::new();
    body.insert("model".into(), json!(model));
    // Anthropic requires `max_tokens`; an explicit user budget wins, otherwise
    // the protocol minimum keeps the request valid.
    body.insert(
        "max_tokens".into(),
        json!(options.max_tokens.unwrap_or(ANTHROPIC_REQUIRED_MAX_TOKENS)),
    );
    body.insert("stream".into(), json!(true));
    if !system.trim().is_empty() {
        body.insert("system".into(), json!(system));
    }
    body.insert("messages".into(), Value::Array(messages));
    if !tools.is_empty() {
        let specs: Vec<Value> = tools
            .iter()
            .map(|t| {
                json!({
                    "name": t.name,
                    "description": t.description,
                    "input_schema": t.parameters,
                })
            })
            .collect();
        body.insert("tools".into(), Value::Array(specs));
    }
    if let Some(temp) = options.temperature {
        body.insert("temperature".into(), json!(temp));
    }
    Value::Object(body)
}

/// Anthropic 要求 user/assistant 交替；把相邻同角色消息的 content 块合并。
fn push_turn(messages: &mut Vec<Value>, role: &str, blocks: Vec<Value>) {
    if let Some(last) = messages.last_mut() {
        if last.get("role").and_then(Value::as_str) == Some(role) {
            if let Some(content) = last.get_mut("content").and_then(Value::as_array_mut) {
                content.extend(blocks);
                return;
            }
        }
    }
    messages.push(json!({ "role": role, "content": Value::Array(blocks) }));
}

/// Base Anthropic body + stored params + passthrough, with `stream` honoured.
fn prepare_anthropic_body(req: &Prepared<'_>) -> Result<Value, ToolError> {
    let mut body = anthropic_body(req.model, req.system, req.tools, req.turns, req.options);
    let Some(map) = body.as_object_mut() else {
        unreachable!("anthropic body is always an object")
    };
    // `apply_anthropic` overwrites the protocol fallback whenever the user set
    // an output budget; otherwise the fallback keeps the request valid.
    req.params.apply_anthropic(map);
    map.insert("stream".into(), json!(req.params.stream_enabled()));
    req.params.merge_extra(map)?;
    Ok(body)
}

struct AnthropicToolState {
    block: usize,
    id: String,
    name: String,
    args: String,
}

async fn anthropic_stream(
    state: &AgentState,
    key: &str,
    req: &Prepared<'_>,
    cancel: &AtomicBool,
    emit: Emit<'_>,
) -> Result<(), String> {
    let body = prepare_anthropic_body(req).map_err(|e| e.to_string())?;
    let headers = [
        ("x-api-key", key.to_string()),
        ("anthropic-version", "2023-06-01".to_string()),
        ("content-type", "application/json".to_string()),
    ];
    let resp = send_json(state, req.endpoint, &headers, &body, req.params.timeout()).await?;

    let mut usage = Usage::default();
    let mut text_blocks: Vec<usize> = Vec::new();
    let mut tool_states: Vec<AnthropicToolState> = Vec::new();
    let mut stop_reason: Option<String> = None;

    let outcome = read_sse(resp, cancel, |data| {
        let Ok(event) = serde_json::from_str::<Value>(data) else {
            return;
        };
        match event.get("type").and_then(Value::as_str).unwrap_or("") {
            "message_start" => {
                if let Some(u) = event.get("message").and_then(|m| m.get("usage")) {
                    usage.input = u.get("input_tokens").and_then(Value::as_i64).unwrap_or(0);
                    usage.cache_read = u
                        .get("cache_read_input_tokens")
                        .and_then(Value::as_i64)
                        .unwrap_or(0);
                    usage.cache_write = u
                        .get("cache_creation_input_tokens")
                        .and_then(Value::as_i64)
                        .unwrap_or(0);
                }
            }
            "content_block_start" => {
                let index = event.get("index").and_then(Value::as_u64).unwrap_or(0) as usize;
                let Some(block) = event.get("content_block") else {
                    return;
                };
                match block.get("type").and_then(Value::as_str).unwrap_or("") {
                    "text" => {
                        text_blocks.push(index);
                        emit(StreamEvent::TextStart {
                            content_index: index,
                        });
                    }
                    "tool_use" => {
                        let id = block
                            .get("id")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_string();
                        let name = block
                            .get("name")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_string();
                        emit(StreamEvent::ToolCallStart {
                            content_index: index,
                            id: id.clone(),
                            tool_name: name.clone(),
                        });
                        tool_states.push(AnthropicToolState {
                            block: index,
                            id,
                            name,
                            args: String::new(),
                        });
                    }
                    _ => {}
                }
            }
            "content_block_delta" => {
                let index = event.get("index").and_then(Value::as_u64).unwrap_or(0) as usize;
                let Some(delta) = event.get("delta") else {
                    return;
                };
                match delta.get("type").and_then(Value::as_str).unwrap_or("") {
                    "text_delta" => {
                        if let Some(text) = delta.get("text").and_then(Value::as_str) {
                            emit(StreamEvent::TextDelta {
                                content_index: index,
                                delta: text.to_string(),
                            });
                        }
                    }
                    "input_json_delta" => {
                        if let Some(partial) = delta.get("partial_json").and_then(Value::as_str) {
                            if let Some(tool) = tool_states.iter_mut().find(|t| t.block == index) {
                                tool.args.push_str(partial);
                                emit(StreamEvent::ToolCallDelta {
                                    content_index: index,
                                    delta: partial.to_string(),
                                });
                            }
                        }
                    }
                    _ => {}
                }
            }
            "content_block_stop" => {
                let index = event.get("index").and_then(Value::as_u64).unwrap_or(0) as usize;
                if text_blocks.contains(&index) {
                    emit(StreamEvent::TextEnd {
                        content_index: index,
                    });
                }
                if let Some(tool) = tool_states.iter().find(|t| t.block == index) {
                    let payload =
                        ToolCallPayload::new(tool.id.clone(), tool.name.clone(), &tool.args);
                    emit(StreamEvent::ToolCallEnd {
                        content_index: index,
                        tool_call: payload,
                    });
                }
            }
            "message_delta" => {
                if let Some(reason) = event
                    .get("delta")
                    .and_then(|d| d.get("stop_reason"))
                    .and_then(Value::as_str)
                {
                    stop_reason = Some(reason.to_string());
                }
                if let Some(u) = event.get("usage") {
                    usage.output = u.get("output_tokens").and_then(Value::as_i64).unwrap_or(0);
                }
            }
            _ => {}
        }
    })
    .await?;

    if matches!(outcome, SseOutcome::Cancelled) {
        emit(StreamEvent::Error {
            reason: "aborted".to_string(),
            error_message: "已取消".to_string(),
            usage,
        });
        return Ok(());
    }

    usage.total_tokens = usage.input + usage.output + usage.cache_read + usage.cache_write;
    let reason = match stop_reason.as_deref() {
        Some("tool_use") => "toolUse",
        Some("max_tokens") => "length",
        _ => {
            if tool_states.is_empty() {
                "stop"
            } else {
                "toolUse"
            }
        }
    };
    emit(StreamEvent::Done {
        reason: reason.to_string(),
        usage,
    });
    Ok(())
}

// ---------------------------------------------------------------------------
// 非流式路径（stream=false）：一次性响应，仍以相同事件序列回给前端
// ---------------------------------------------------------------------------

fn emit_text_block(emit: Emit<'_>, index: usize, text: &str) {
    if text.trim().is_empty() {
        return;
    }
    emit(StreamEvent::TextStart {
        content_index: index,
    });
    emit(StreamEvent::TextDelta {
        content_index: index,
        delta: text.to_string(),
    });
    emit(StreamEvent::TextEnd {
        content_index: index,
    });
}

fn emit_tool_block(emit: Emit<'_>, index: usize, id: String, name: String, arguments: &Value) {
    let args = serde_json::to_string(arguments).unwrap_or_else(|_| "{}".to_string());
    emit_raw_tool_block(emit, index, id, name, &args);
}

/// Same as `emit_tool_block`, but the provider already gave us raw JSON text.
fn emit_raw_tool_block(emit: Emit<'_>, index: usize, id: String, name: String, args: &str) {
    emit(StreamEvent::ToolCallStart {
        content_index: index,
        id: id.clone(),
        tool_name: name.clone(),
    });
    emit(StreamEvent::ToolCallDelta {
        content_index: index,
        delta: args.to_string(),
    });
    emit(StreamEvent::ToolCallEnd {
        content_index: index,
        tool_call: ToolCallPayload::new(id, name, args),
    });
}

async fn read_json_response(resp: reqwest::Response) -> Result<Value, String> {
    resp.json::<Value>()
        .await
        .map_err(|e| format!("响应不是合法 JSON：{e}"))
}

async fn openai_json(
    state: &AgentState,
    key: &str,
    req: &Prepared<'_>,
    cancel: &AtomicBool,
    emit: Emit<'_>,
) -> Result<(), String> {
    let body = prepare_openai_body(req).map_err(|e| e.to_string())?;
    let headers = [
        ("authorization", format!("Bearer {key}")),
        ("content-type", "application/json".to_string()),
    ];
    let resp = send_json(state, req.endpoint, &headers, &body, req.params.timeout()).await?;
    let payload = read_json_response(resp).await?;
    if cancel.load(Ordering::SeqCst) {
        emit(StreamEvent::Error {
            reason: "aborted".to_string(),
            error_message: "已取消".to_string(),
            usage: Usage::default(),
        });
        return Ok(());
    }

    let mut usage = Usage::default();
    if let Some(u) = payload.get("usage") {
        usage.input = u.get("prompt_tokens").and_then(Value::as_i64).unwrap_or(0);
        usage.output = u
            .get("completion_tokens")
            .and_then(Value::as_i64)
            .unwrap_or(0);
        usage.total_tokens = u
            .get("total_tokens")
            .and_then(Value::as_i64)
            .unwrap_or(usage.input + usage.output);
    }

    let choice = payload
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|items| items.first());
    let mut index = 0usize;
    if let Some(message) = choice.and_then(|c| c.get("message")) {
        if let Some(text) = message.get("content").and_then(Value::as_str) {
            emit_text_block(emit, index, text);
            index += 1;
        }
        if let Some(calls) = message.get("tool_calls").and_then(Value::as_array) {
            for (offset, call) in calls.iter().enumerate() {
                let id = call
                    .get("id")
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .unwrap_or_else(|| format!("call_{offset}"));
                let name = call
                    .get("function")
                    .and_then(|f| f.get("name"))
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                let arguments = call
                    .get("function")
                    .and_then(|f| f.get("arguments"))
                    .cloned()
                    .unwrap_or_else(|| json!({}));
                emit_tool_block(emit, index, id, name, &arguments);
                index += 1;
            }
        }
    }
    let reason = match choice
        .and_then(|c| c.get("finish_reason"))
        .and_then(Value::as_str)
        .unwrap_or("stop")
    {
        "tool_calls" => "toolUse",
        "length" => "length",
        _ => "stop",
    };
    emit(StreamEvent::Done {
        reason: reason.to_string(),
        usage,
    });
    Ok(())
}

async fn anthropic_json(
    state: &AgentState,
    key: &str,
    req: &Prepared<'_>,
    cancel: &AtomicBool,
    emit: Emit<'_>,
) -> Result<(), String> {
    let body = prepare_anthropic_body(req).map_err(|e| e.to_string())?;
    let headers = [
        ("x-api-key", key.to_string()),
        ("anthropic-version", "2023-06-01".to_string()),
        ("content-type", "application/json".to_string()),
    ];
    let resp = send_json(state, req.endpoint, &headers, &body, req.params.timeout()).await?;
    let payload = read_json_response(resp).await?;
    if cancel.load(Ordering::SeqCst) {
        emit(StreamEvent::Error {
            reason: "aborted".to_string(),
            error_message: "已取消".to_string(),
            usage: Usage::default(),
        });
        return Ok(());
    }

    let mut usage = Usage::default();
    if let Some(u) = payload.get("usage") {
        usage.input = u.get("input_tokens").and_then(Value::as_i64).unwrap_or(0);
        usage.output = u.get("output_tokens").and_then(Value::as_i64).unwrap_or(0);
        usage.total_tokens = usage.input + usage.output;
    }

    let mut index = 0usize;
    if let Some(blocks) = payload.get("content").and_then(Value::as_array) {
        for block in blocks {
            match block.get("type").and_then(Value::as_str).unwrap_or("") {
                "text" => {
                    if let Some(text) = block.get("text").and_then(Value::as_str) {
                        emit_text_block(emit, index, text);
                        index += 1;
                    }
                }
                "tool_use" => {
                    let id = block
                        .get("id")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string();
                    let name = block
                        .get("name")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string();
                    let input = block.get("input").cloned().unwrap_or_else(|| json!({}));
                    emit_tool_block(emit, index, id, name, &input);
                    index += 1;
                }
                _ => {}
            }
        }
    }
    let reason = match payload.get("stop_reason").and_then(Value::as_str) {
        Some("tool_use") => "toolUse",
        Some("max_tokens") => "length",
        _ if index > 0 => "stop",
        _ => "stop",
    };
    emit(StreamEvent::Done {
        reason: reason.to_string(),
        usage,
    });
    Ok(())
}

