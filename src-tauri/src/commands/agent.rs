//! Agent 命令：会话、自定义模型、参数、密钥、流式代理。
//!
//! 边界：
//! - 会话命令只读写 `conversations/messages`，不碰 `/life` 文档；
//! - 模型配置（含 baseURL）只经这里写入 `settings`，`agent_stream` 不接受 URL；
//! - API Key 随模型条目保存/删除，回执只有状态，不回传内容；
//! - `agent_stream` 的模型条目/协议/tools 在 Rust 侧二次校验，前端不可绕过。

use tauri::ipc::Channel;
use tauri::{Manager, State};

use serde::Deserialize;

use crate::agent::discovery::ConnectionTest;
use crate::agent::model_store::{
    self, AgentSettings, ApiFormat, ModelEntry, ModelInput, ModelKind, ModelView,
};
use crate::agent::params::{self, LlmParams};
use crate::agent::{conversations, discovery, events, llm, runs, supervisor, AgentState};
use crate::privacy;
use crate::vfs::error::ToolError;
use crate::vfs::VfsState;

#[tauri::command]
pub fn chat_list(
    state: State<'_, VfsState>,
) -> Result<Vec<conversations::Conversation>, ToolError> {
    let vfs = crate::lock(&state.0);
    conversations::list(&vfs)
}

/// 新建会话：始终使用当前激活的自定义模型；没有模型时要求用户先添加。
#[tauri::command]
pub fn chat_create(
    state: State<'_, VfsState>,
    title: Option<String>,
) -> Result<conversations::Conversation, ToolError> {
    let vfs = crate::lock(&state.0);
    let settings = model_store::settings(vfs.conn(), &[])?;
    let active = settings
        .active_id
        .ok_or_else(|| ToolError::invalid("请先在设置中添加并启用一个对话模型"))?;
    let entry = model_store::resolve(vfs.conn(), &active)?;
    conversations::create(&vfs, title, entry.id, entry.model_id)
}

#[tauri::command]
pub fn chat_rename(state: State<'_, VfsState>, id: i64, title: String) -> Result<(), ToolError> {
    let vfs = crate::lock(&state.0);
    conversations::rename(&vfs, id, title)
}

#[tauri::command]
pub fn chat_delete(state: State<'_, VfsState>, id: i64) -> Result<(), ToolError> {
    let vfs = crate::lock(&state.0);
    conversations::delete(&vfs, id)
}

#[tauri::command]
pub fn chat_messages(
    state: State<'_, VfsState>,
    conversation_id: i64,
) -> Result<Vec<conversations::ChatMessage>, ToolError> {
    let vfs = crate::lock(&state.0);
    conversations::messages(&vfs, conversation_id)
}

#[tauri::command]
pub fn chat_append(
    state: State<'_, VfsState>,
    conversation_id: i64,
    messages: Vec<conversations::NewMessage>,
) -> Result<Vec<conversations::ChatMessage>, ToolError> {
    let vfs = crate::lock(&state.0);
    conversations::append(&vfs, conversation_id, messages)
}

/// Drop every message newer than `message_id` so retry can continue from the user turn.
#[tauri::command]
pub fn chat_truncate(
    state: State<'_, VfsState>,
    conversation_id: i64,
    message_id: i64,
) -> Result<usize, ToolError> {
    let vfs = crate::lock(&state.0);
    conversations::truncate_after(&vfs, conversation_id, message_id)
}

/// Start a run and persist its user message in one transaction.
#[tauri::command]
pub fn chat_run_start(
    state: State<'_, VfsState>,
    conversation_id: i64,
    trigger: String,
    model_entry: String,
    message: Option<conversations::NewMessage>,
) -> Result<runs::RunStart, ToolError> {
    let vfs = crate::lock(&state.0);
    runs::start(&vfs, conversation_id, &trigger, &model_entry, message)
}

/// Move a run between non-terminal states; illegal transitions are rejected.
#[tauri::command]
pub fn chat_run_transition(
    state: State<'_, VfsState>,
    run_id: i64,
    status: String,
) -> Result<runs::AgentRun, ToolError> {
    let vfs = crate::lock(&state.0);
    runs::transition(&vfs, run_id, &status)
}

/// Finish a run, storing the partial snapshot and progress counters.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn chat_run_finish(
    state: State<'_, VfsState>,
    run_id: i64,
    status: String,
    partial: Option<String>,
    error_code: Option<String>,
    step_count: i64,
    write_count: i64,
    last_seq: i64,
) -> Result<runs::AgentRun, ToolError> {
    let vfs = crate::lock(&state.0);
    runs::finish(
        &vfs,
        run_id,
        &status,
        partial,
        error_code,
        step_count,
        write_count,
        last_seq,
    )
}

/// Refresh progress counters without changing the run status.
#[tauri::command]
pub fn chat_run_touch(
    state: State<'_, VfsState>,
    run_id: i64,
    step_count: i64,
    write_count: i64,
    last_seq: i64,
) -> Result<(), ToolError> {
    let vfs = crate::lock(&state.0);
    runs::touch(&vfs, run_id, step_count, write_count, last_seq)
}

/// Active executor, latest run and pending queue for a conversation.
#[tauri::command]
pub fn chat_run_state(
    state: State<'_, VfsState>,
    conversation_id: i64,
) -> Result<runs::RunState, ToolError> {
    let vfs = crate::lock(&state.0);
    runs::state(&vfs, conversation_id)
}

/// Create a `resume` run; the caller decides whether to send the request.
#[tauri::command]
pub fn chat_run_resume(
    state: State<'_, VfsState>,
    conversation_id: i64,
    model_entry: String,
) -> Result<runs::RunStart, ToolError> {
    let vfs = crate::lock(&state.0);
    runs::start(&vfs, conversation_id, "resume", &model_entry, None)
}

/// Start a Rust-orchestrated run: validate the entry, persist run + user
/// message, then execute in the background. The `js` path keeps using
/// `chat_run_*` and `agent_stream`; this command is only used by `engine=rust`.
#[tauri::command]
pub fn agent_run_start(
    app: tauri::AppHandle,
    vfs_state: State<'_, VfsState>,
    agent_state: State<'_, AgentState>,
    conversation_id: i64,
    trigger: String,
    model_entry: String,
    message: Option<conversations::NewMessage>,
) -> Result<runs::RunStart, ToolError> {
    {
        let vfs = crate::lock(&vfs_state.0);
        model_store::cleanup_legacy(vfs.conn(), &agent_state.secrets);
        let entry = model_store::resolve(vfs.conn(), &model_entry)?;
        if !entry.kind.is_chat() {
            return Err(ToolError::invalid("该模型条目不是对话模型"));
        }
        if !agent_state.secrets.has(&entry.id) {
            return Err(ToolError::invalid(supervisor::error_copy("auth_missing")));
        }
    }
    let started = {
        let vfs = crate::lock(&vfs_state.0);
        runs::start(&vfs, conversation_id, &trigger, &model_entry, message)?
    };
    if started.run.status == "queued" {
        // A previous run owns the conversation; its supervisor pumps the queue.
        supervisor::mark_queued(&app, started.run.run_id)?;
    } else {
        supervisor::start(&app, &started.run, "running")?;
    }
    Ok(started)
}

/// Replay persisted boundary events after `after_seq`, then stream live until
/// the run reaches a terminal state. Returns when the channel closes or ends.
#[tauri::command]
pub async fn agent_run_attach(
    app: tauri::AppHandle,
    run_id: i64,
    after_seq: i64,
    on_event: Channel<events::RunEvent>,
) -> Result<(), ToolError> {
    {
        let vfs_state = app.state::<VfsState>();
        let vfs = crate::lock(&vfs_state.0);
        runs::get_run(vfs.conn(), run_id)?.ok_or_else(|| ToolError::NotFound {
            path: format!("run#{run_id}"),
        })?;
    }
    supervisor::attach(&app, run_id, after_seq, |event| {
        if let Err(e) = on_event.send(event) {
            log::warn!("run attach channel closed: {e}");
        }
    })
    .await;
    Ok(())
}

/// Cancel a run: queued runs finish immediately, running ones trip the token
/// and let the supervisor persist `partial` + `cancelled`.
#[tauri::command]
pub fn agent_run_cancel(
    app: tauri::AppHandle,
    vfs_state: State<'_, VfsState>,
    run_id: i64,
) -> Result<runs::AgentRun, ToolError> {
    let current = {
        let vfs = crate::lock(&vfs_state.0);
        runs::get_run(vfs.conn(), run_id)?.ok_or_else(|| ToolError::NotFound {
            path: format!("run#{run_id}"),
        })?
    };
    if matches!(
        current.status.as_str(),
        "succeeded" | "failed" | "cancelled" | "interrupted"
    ) {
        return Ok(current);
    }
    if current.status == "queued" {
        return supervisor::cancel_queued(&app, &current);
    }
    {
        let vfs = crate::lock(&vfs_state.0);
        if runs::transition(&vfs, run_id, "cancelling").is_ok() {
            supervisor::publish_state(&app, run_id, "cancelling")?;
        }
    }
    let hub = app.state::<supervisor::AgentRunHub>();
    if let Some(token) = hub.token(run_id) {
        token.cancel();
    }
    let vfs = crate::lock(&vfs_state.0);
    runs::get_run(vfs.conn(), run_id)?.ok_or_else(|| ToolError::NotFound {
        path: format!("run#{run_id}"),
    })
}

/// Cold reconnect: run row plus every boundary event after the cursor.
#[tauri::command]
pub fn agent_run_snapshot(
    state: State<'_, VfsState>,
    run_id: i64,
    after_seq: i64,
) -> Result<supervisor::RunSnapshot, ToolError> {
    let vfs = crate::lock(&state.0);
    supervisor::snapshot(&vfs, run_id, after_seq)
}

fn key_status(
    conn: &rusqlite::Connection,
    secrets: &crate::agent::secrets::SecretStore,
) -> Result<Vec<(String, bool)>, ToolError> {
    Ok(model_store::configs(conn)?
        .into_iter()
        .map(|entry| {
            let configured = secrets.has(&entry.id);
            (entry.id, configured)
        })
        .collect())
}

/// 读取模型列表：只返回“是否已配置 Key”，不返回内容。
#[tauri::command]
pub fn agent_settings(
    vfs_state: State<'_, VfsState>,
    agent_state: State<'_, AgentState>,
) -> Result<AgentSettings, ToolError> {
    let vfs = crate::lock(&vfs_state.0);
    model_store::cleanup_legacy(vfs.conn(), &agent_state.secrets);
    let keys = key_status(vfs.conn(), &agent_state.secrets)?;
    model_store::settings(vfs.conn(), &keys)
}

/// 新增或编辑模型条目。新增时 API Key 必填；编辑时留空表示保留旧 Key。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelSaveInput {
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
    #[serde(default)]
    pub api_key: Option<String>,
}

#[tauri::command]
pub fn agent_model_save(
    vfs_state: State<'_, VfsState>,
    agent_state: State<'_, AgentState>,
    input: ModelSaveInput,
) -> Result<ModelView, ToolError> {
    let new_key = validate_key(input.api_key.as_deref())?;
    let creating = input.id.trim().is_empty();
    if creating && new_key.is_none() {
        return Err(ToolError::invalid("API Key 必填"));
    }
    let vfs = crate::lock(&vfs_state.0);
    model_store::cleanup_legacy(vfs.conn(), &agent_state.secrets);
    let saved = model_store::save(
        vfs.conn(),
        ModelInput {
            id: input.id,
            label: input.label,
            format: input.format,
            base_url: input.base_url,
            model_id: input.model_id,
            full_url: input.full_url,
            kind: input.kind,
        },
    )?;
    if let Some(key) = new_key {
        if let Err(message) = agent_state.secrets.set(&saved.id, key) {
            // Do not leave a half-configured entry behind on creation.
            if creating {
                let _ = model_store::delete(vfs.conn(), &saved.id);
            }
            return Err(ToolError::Storage { message });
        }
    } else if !agent_state.secrets.has(&saved.id) {
        return Err(ToolError::invalid("API Key 未保存，请重新填写"));
    }
    let configured = agent_state.secrets.has(&saved.id);
    Ok(model_store::view(vfs.conn(), saved, configured))
}

/// 删除模型条目；密钥与参数随后清理，激活指针自动前移。
#[tauri::command]
pub fn agent_model_delete(
    vfs_state: State<'_, VfsState>,
    agent_state: State<'_, AgentState>,
    id: String,
) -> Result<(), ToolError> {
    let vfs = crate::lock(&vfs_state.0);
    model_store::delete(vfs.conn(), &id)?;
    if let Err(e) = agent_state.secrets.delete(&id) {
        log::warn!("model key cleanup failed for {id}: {e}");
    }
    if let Err(e) = params::remove(vfs.conn(), &id) {
        log::warn!("model params cleanup failed for {id}: {e}");
    }
    Ok(())
}

#[tauri::command]
pub fn agent_model_activate(state: State<'_, VfsState>, id: String) -> Result<(), ToolError> {
    let vfs = crate::lock(&state.0);
    model_store::set_active(vfs.conn(), &id)
}

/// 流式对话：`request` 与 pi-agent 内置 `streamProxy` 的入参同构，
/// 事件经 `Channel` 回到 WebView；返回时流已结束。
#[tauri::command]
pub async fn agent_stream(
    vfs_state: State<'_, VfsState>,
    state: State<'_, AgentState>,
    mut request: llm::ProxyRequest,
    on_event: Channel<llm::StreamEvent>,
) -> Result<(), ToolError> {
    // Trim first: the egress gate must judge exactly what would be sent.
    request.context.messages = llm::trim_messages(&request.context.messages);

    let (entry, params, snapshot) = {
        let vfs = crate::lock(&vfs_state.0);
        model_store::cleanup_legacy(vfs.conn(), &state.secrets);
        let entry = model_store::resolve(vfs.conn(), &request.model.provider)?;
        // Only chat entries can stream into the agent; media kinds stay inactive.
        if !entry.kind.is_chat() {
            return Err(ToolError::invalid("该模型条目不是对话模型"));
        }
        let params = params::get(vfs.conn(), &entry.id);
        // Labels + decrypted EDM values; loading here keeps the lock short.
        let snapshot = privacy::policy::Snapshot::load(vfs.conn(), &state.secrets)?;
        (entry, params, snapshot)
    };

    // The single egress gate: S0 and un-redacted S1 never reach the network.
    let decision = privacy::egress::guard(&request.context.messages, &snapshot);
    {
        let vfs = crate::lock(&vfs_state.0);
        if let Err(e) = privacy::egress::record_audit(vfs.conn(), &entry.id, "chat", &decision) {
            log::warn!("egress audit write failed: {e}");
        }
    }

    let request_id = request.request_id.clone();
    let cancel = state.register_cancel(&request_id);
    let emit = |event: llm::StreamEvent| {
        if let Err(e) = on_event.send(event) {
            log::warn!("agent stream channel closed: {e}");
        }
    };

    if decision.blocked() {
        let message = decision
            .message
            .clone()
            .unwrap_or_else(|| "隐私拦截：本次请求不允许发送到云端。".into());
        emit(llm::StreamEvent::Start);
        emit(llm::StreamEvent::Error {
            reason: "error".into(),
            error_message: message,
            usage: llm::Usage::default(),
        });
        state.clear_cancel(&request_id);
        return Ok(());
    }

    let result = llm::run(state.inner(), request, &entry, &params, cancel, &emit).await;
    state.clear_cancel(&request_id);
    result
}

/// 动态拉取模型列表。输入来自“添加模型”表单；Full URL 模式无法发现模型。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelDiscoveryInput {
    #[serde(default)]
    pub id: String,
    pub format: ApiFormat,
    #[serde(default)]
    pub base_url: String,
    #[serde(default)]
    pub full_url: bool,
    #[serde(default)]
    pub api_key: Option<String>,
}

#[tauri::command]
pub async fn agent_models_list(
    vfs_state: State<'_, VfsState>,
    state: State<'_, AgentState>,
    input: ModelDiscoveryInput,
) -> Result<Vec<String>, ToolError> {
    let base_url = model_store::validate_base_url(&input.base_url)?;
    let key = match validate_key(input.api_key.as_deref())? {
        Some(key) => key.to_string(),
        None => {
            let id = input.id.trim();
            if id.is_empty() {
                return Err(ToolError::invalid("请先填写 API Key 再拉取模型列表"));
            }
            let stored = {
                let vfs = crate::lock(&vfs_state.0);
                model_store::resolve(vfs.conn(), id)?
            };
            state
                .secrets
                .get(&stored.id)
                .map_err(|message| ToolError::Storage { message })?
                .ok_or_else(|| ToolError::invalid("请先填写 API Key 再拉取模型列表"))?
        }
    };
    discovery::fetch(state.inner(), input.format, &base_url, input.full_url, &key).await
}

/// 真实连通性测试：保存前后都可用；Key 不会被此路径持久化。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TestConnectionInput {
    #[serde(default)]
    pub id: String,
    pub format: ApiFormat,
    #[serde(default)]
    pub base_url: String,
    #[serde(default)]
    pub model_id: String,
    #[serde(default)]
    pub full_url: bool,
    #[serde(default)]
    pub api_key: Option<String>,
}

#[tauri::command]
pub async fn agent_test_connection(
    vfs_state: State<'_, VfsState>,
    state: State<'_, AgentState>,
    input: TestConnectionInput,
) -> Result<ConnectionTest, ToolError> {
    let entry = ModelEntry {
        id: if input.id.trim().is_empty() {
            "test".to_string()
        } else {
            input.id.trim().to_string()
        },
        label: "测试连接".to_string(),
        format: input.format,
        base_url: model_store::normalize_anthropic_base(
            model_store::validate_base_url(&input.base_url)?,
            input.format,
            input.full_url,
        ),
        full_url: input.full_url,
        model_id: input.model_id.trim().to_string(),
        kind: ModelKind::Chat,
    };
    if entry.model_id.is_empty() {
        return Err(ToolError::invalid("请先填写 Model ID"));
    }
    let key = match validate_key(input.api_key.as_deref())? {
        Some(key) => key.to_string(),
        None => {
            if input.id.trim().is_empty() {
                return Err(ToolError::invalid("请先填写 API Key"));
            }
            let stored_id = {
                let vfs = crate::lock(&vfs_state.0);
                model_store::resolve(vfs.conn(), entry.id.as_str())?.id
            };
            state
                .secrets
                .get(&stored_id)
                .map_err(|message| ToolError::Storage { message })?
                .ok_or_else(|| ToolError::invalid("请先填写 API Key"))?
        }
    };
    discovery::test_connection(state.inner(), &entry, &key).await
}

/// 读取某模型条目的参数配置；未保存过时返回空对象。
#[tauri::command]
pub fn agent_params_get(
    vfs_state: State<'_, VfsState>,
    model_entry_id: String,
) -> Result<LlmParams, ToolError> {
    let vfs = crate::lock(&vfs_state.0);
    model_store::resolve(vfs.conn(), &model_entry_id)?;
    Ok(params::get(vfs.conn(), &model_entry_id))
}

/// 保存某模型条目的参数配置；空对象等价于清除。
#[tauri::command]
pub fn agent_params_set(
    vfs_state: State<'_, VfsState>,
    model_entry_id: String,
    params: LlmParams,
) -> Result<(), ToolError> {
    let vfs = crate::lock(&vfs_state.0);
    model_store::resolve(vfs.conn(), &model_entry_id)?;
    params::save(vfs.conn(), &model_entry_id, &params)
}

/// 取消指定请求；下一次读到 chunk 时停止并回 `aborted`。
#[tauri::command]
pub fn agent_cancel(state: State<'_, AgentState>, request_id: String) -> Result<(), ToolError> {
    state.cancel(&request_id);
    Ok(())
}

fn validate_key(raw: Option<&str>) -> Result<Option<&str>, ToolError> {
    let Some(key) = raw.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    if key.len() > 4096 || key.chars().any(char::is_control) {
        return Err(ToolError::invalid("API Key 过长或包含控制字符"));
    }
    Ok(Some(key))
}
