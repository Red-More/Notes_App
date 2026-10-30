//! Agent 命令：会话、设置、密钥、流式代理。
//!
//! 边界：
//! - 会话命令只读写 `conversations/messages`，不碰 `/life` 文档；
//! - `agent_key_*` 是密钥唯一入口，回执只有布尔状态，不回传内容；
//! - `agent_stream` 的 provider/model/tools 在 Rust 侧二次校验，前端不可绕过。

use tauri::ipc::Channel;
use tauri::State;

use crate::agent::conversations::Conversation;
use crate::agent::{conversations, llm, AgentState, PROVIDERS};
use crate::vfs::error::ToolError;
use crate::vfs::VfsState;

#[tauri::command]
pub fn chat_list(state: State<'_, VfsState>) -> Result<Vec<Conversation>, ToolError> {
    let vfs = state.0.lock().unwrap();
    conversations::list(&vfs)
}

#[tauri::command]
pub fn chat_create(
    state: State<'_, VfsState>,
    title: Option<String>,
    provider: Option<String>,
    model: Option<String>,
) -> Result<conversations::Conversation, ToolError> {
    let vfs = state.0.lock().unwrap();
    let settings = conversations::settings(vfs.conn(), &[])?;
    let provider = provider.unwrap_or(settings.provider);
    let model = model.unwrap_or(settings.model);
    if !crate::agent::is_provider(&provider) {
        return Err(ToolError::invalid("不支持的厂商"));
    }
    conversations::create(&vfs, title, provider, model)
}

#[tauri::command]
pub fn chat_rename(state: State<'_, VfsState>, id: i64, title: String) -> Result<(), ToolError> {
    let vfs = state.0.lock().unwrap();
    conversations::rename(&vfs, id, title)
}

#[tauri::command]
pub fn chat_delete(state: State<'_, VfsState>, id: i64) -> Result<(), ToolError> {
    let vfs = state.0.lock().unwrap();
    conversations::delete(&vfs, id)
}

#[tauri::command]
pub fn chat_messages(
    state: State<'_, VfsState>,
    conversation_id: i64,
) -> Result<Vec<conversations::ChatMessage>, ToolError> {
    let vfs = state.0.lock().unwrap();
    conversations::messages(&vfs, conversation_id)
}

#[tauri::command]
pub fn chat_append(
    state: State<'_, VfsState>,
    conversation_id: i64,
    messages: Vec<conversations::NewMessage>,
) -> Result<Vec<conversations::ChatMessage>, ToolError> {
    let vfs = state.0.lock().unwrap();
    conversations::append(&vfs, conversation_id, messages)
}

/// 读取 Agent 配置：只返回“是否已配置 Key”，不返回内容。
#[tauri::command]
pub fn agent_settings(
    vfs_state: State<'_, VfsState>,
    agent_state: State<'_, AgentState>,
) -> Result<conversations::AgentSettings, ToolError> {
    let vfs = vfs_state.0.lock().unwrap();
    let keys: Vec<(String, bool)> = PROVIDERS
        .iter()
        .map(|p| ((*p).to_string(), agent_state.secrets.has(p)))
        .collect();
    conversations::settings(vfs.conn(), &keys)
}

#[tauri::command]
pub fn agent_settings_set(
    state: State<'_, VfsState>,
    provider: String,
    model: String,
) -> Result<(), ToolError> {
    let vfs = state.0.lock().unwrap();
    conversations::set_settings(vfs.conn(), &provider, &model)
}

#[tauri::command]
pub fn agent_key_set(
    state: State<'_, AgentState>,
    provider: String,
    key: String,
) -> Result<(), ToolError> {
    if !crate::agent::is_provider(&provider) || provider == "mock" {
        return Err(ToolError::invalid("该厂商不需要或不存在 API Key"));
    }
    if key.trim().is_empty() || key.len() > 4096 || key.chars().any(|c| c.is_control()) {
        return Err(ToolError::invalid("API Key 为空、过长或包含控制字符"));
    }
    state
        .secrets
        .set(&provider, &key)
        .map_err(|message| ToolError::Storage { message })
}

#[tauri::command]
pub fn agent_key_delete(state: State<'_, AgentState>, provider: String) -> Result<(), ToolError> {
    if !crate::agent::is_provider(&provider) {
        return Err(ToolError::invalid("不支持的厂商"));
    }
    state
        .secrets
        .delete(&provider)
        .map_err(|message| ToolError::Storage { message })
}

/// 流式对话：`request` 与 pi-agent 内置 `streamProxy` 的入参同构，
/// 事件经 `Channel` 回到 WebView；返回时流已结束。
#[tauri::command]
pub async fn agent_stream(
    state: State<'_, AgentState>,
    request: llm::ProxyRequest,
    on_event: Channel<llm::StreamEvent>,
) -> Result<(), ToolError> {
    let request_id = request.request_id.clone();
    let cancel = state.register_cancel(&request_id);
    let emit = |event: llm::StreamEvent| {
        if let Err(e) = on_event.send(event) {
            log::warn!("agent stream channel closed: {e}");
        }
    };
    let result = llm::run(state.inner(), request, cancel, &emit).await;
    state.clear_cancel(&request_id);
    result
}

/// 取消指定请求；下一次读到 chunk 时停止并回 `aborted`。
#[tauri::command]
pub fn agent_cancel(state: State<'_, AgentState>, request_id: String) -> Result<(), ToolError> {
    state.cancel(&request_id);
    Ok(())
}
