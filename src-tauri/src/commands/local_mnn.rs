//! Tauri commands for the embedded MNN runtime (feature `local-mnn`).
//!
//! 只接受模型目录内的 bundle 名，不接受任意路径；加载与生成都放在阻塞线程，
//! 不占用 async 运行时，避免 ANR。错误统一为 `MnnError`（`{ code, ... }`），
//! 与 VFS 的 `ToolError` 序列化风格一致。
//!
//! `local_mnn_generate` 仍返回整段结果，但引擎侧已经按 chunk 回调实现；
//! 需要真流式时只在这里换成 `mpsc::Sender<String>` 或 `app.emit`，不改引擎。
//!
//! 生成超时：引擎侧提供三个闸（`firstToken` / `idle` / `total`，单位毫秒），
//! 由 chunk 心跳判定；默认全部关闭（`GenerateParams::timeout` 全 0），因此
//! 默认路径与既有的无超时行为一致，命令层暂未开放这三个参数，默认值待真机
//! 标定。开启后超时与用户取消共用同一条取消标记；若 native 不响应取消，
//! worker 线程会被隔离并重建，该轮返回 `code="timeout"`（带 `stage`，可与
//! `cancelled` 区分），后续任务不会永久堵在卡死轮次后面。

use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use tauri::State;

use crate::agent::inference::{
    EngineInput, GenerateParams, InferenceEngine, LoadOptions, ModelAsset,
};
use crate::agent::local_mnn::{
    LocalMnnModel, LocalMnnResult, LocalMnnState, LocalMnnStatus, MnnError,
};
use crate::agent::model_store::{self, ApiFormat, ModelInput, ModelKind};
use crate::agent::AgentState;
use crate::vfs::error::ToolError;
use crate::vfs::VfsState;

/// Stable model entry that binds a conversation to the MNN engine.
pub const LOCAL_MNN_ENTRY_ID: &str = "local_mnn";

const MAX_THREADS: u32 = 8;
const MAX_MAX_TOKENS: u32 = 1024;
/// prompt 只是单轮对话输入；超过该长度说明调用方把上下文拼错了。
const MAX_PROMPT_BYTES: usize = 16 * 1024;

fn validate_threads(threads: u32) -> Result<(), MnnError> {
    if (1..=MAX_THREADS).contains(&threads) {
        Ok(())
    } else {
        Err(MnnError::invalid(format!(
            "线程数必须在 1–{MAX_THREADS} 之间"
        )))
    }
}

fn validate_generate(prompt: &str, max_tokens: u32) -> Result<(), MnnError> {
    if prompt.trim().is_empty() {
        return Err(MnnError::invalid("prompt 不能为空"));
    }
    if prompt.len() > MAX_PROMPT_BYTES {
        return Err(MnnError::invalid(format!(
            "prompt 不能超过 {MAX_PROMPT_BYTES} 字节"
        )));
    }
    if (1..=MAX_MAX_TOKENS).contains(&max_tokens) {
        Ok(())
    } else {
        Err(MnnError::invalid(format!(
            "输出上限必须在 1–{MAX_MAX_TOKENS} 之间"
        )))
    }
}

#[tauri::command]
pub fn local_mnn_status(state: State<'_, LocalMnnState>) -> LocalMnnStatus {
    let mut status = state.status();
    status.engine = InferenceEngine::kind(&*state);
    status.metrics = InferenceEngine::metrics(&*state);
    status
}

#[tauri::command]
pub fn local_mnn_models(state: State<'_, LocalMnnState>) -> Vec<LocalMnnModel> {
    state.models()
}

/// Switching to MNN retires llama first; a running llama turn is never cut.
fn retire_llama(local: &crate::agent::local::runtime::Runtime) -> Result<(), String> {
    let outcome = super::local::unload_llama(local);
    if outcome.unloaded || !outcome.was_loaded {
        return Ok(());
    }
    Err(outcome
        .reason
        .unwrap_or_else(|| "llama 卸载失败".to_string()))
}

#[tauri::command]
pub async fn local_mnn_load(
    agent_state: State<'_, AgentState>,
    state: State<'_, LocalMnnState>,
    model: String,
    threads: u32,
) -> Result<(), MnnError> {
    validate_threads(threads)?;
    let switch_started = std::time::Instant::now();
    retire_llama(&agent_state.local).map_err(MnnError::invalid)?;
    let state = state.inner().clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let asset = ModelAsset::Bundle {
            dir: std::path::PathBuf::from(&model),
        };
        let options = LoadOptions {
            threads,
            context_size: 0,
        };
        InferenceEngine::load(&state, &asset, &options)
    })
    .await
    .map_err(|e| MnnError::thread(e.to_string()))?;
    log::info!(
        "engine switch to MNN completed in {} ms",
        switch_started.elapsed().as_millis()
    );
    result
}

#[tauri::command]
pub async fn local_mnn_generate(
    state: State<'_, LocalMnnState>,
    prompt: String,
    max_tokens: u32,
) -> Result<LocalMnnResult, MnnError> {
    validate_generate(&prompt, max_tokens)?;
    let state = state.inner().clone();
    let params = GenerateParams {
        max_tokens,
        ..GenerateParams::default()
    };
    let cancel = Arc::new(AtomicBool::new(false));
    // Chunks are forwarded through a channel so the engine can own the sink.
    let (tx, rx) = std::sync::mpsc::channel::<String>();
    let sink: Box<dyn FnMut(&str) + Send> = Box::new(move |chunk| {
        let _ = tx.send(chunk.to_string());
    });
    tauri::async_runtime::spawn_blocking(move || {
        let metrics =
            InferenceEngine::generate(&state, EngineInput::Prompt(prompt), &params, &cancel, sink)?;
        let text: String = rx.into_iter().collect();
        Ok(LocalMnnResult::from_metrics(text, metrics))
    })
    .await
    .map_err(|e| MnnError::thread(e.to_string()))?
}

/// 中止当前生成；返回 `false` 表示没有正在执行的轮次。
#[tauri::command]
pub fn local_mnn_cancel(state: State<'_, LocalMnnState>) -> bool {
    InferenceEngine::cancel(&*state)
}

#[tauri::command]
pub async fn local_mnn_unload(state: State<'_, LocalMnnState>) -> Result<(), MnnError> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let outcome = super::local::unload_mnn(&state);
        if outcome.unloaded || !outcome.was_loaded {
            return Ok(());
        }
        Err(MnnError::invalid(
            outcome.reason.unwrap_or_else(|| "MNN 卸载失败".to_string()),
        ))
    })
    .await
    .map_err(|e| MnnError::thread(e.to_string()))?
}

/// 把一个 bundle 绑定为稳定模型条目并立即加载；切换会话模型即可选择 MNN。
#[tauri::command]
pub async fn local_mnn_activate(
    vfs_state: State<'_, VfsState>,
    agent_state: State<'_, AgentState>,
    state: State<'_, LocalMnnState>,
    model: String,
) -> Result<(), ToolError> {
    let name = model.trim().to_string();
    if name.is_empty() {
        return Err(ToolError::invalid("请选择一个 MNN bundle"));
    }
    // Activating MNN retires llama first so the two weight sets never coexist.
    let switch_started = std::time::Instant::now();
    retire_llama(&agent_state.local).map_err(ToolError::invalid)?;
    // Persist the choice before loading so a failed load can be retried later.
    {
        let vfs = vfs_state.0.lock().unwrap();
        model_store::save(
            vfs.conn(),
            ModelInput {
                id: LOCAL_MNN_ENTRY_ID.to_string(),
                label: format!("MNN 本地 · {name}"),
                format: ApiFormat::LocalMnn,
                base_url: name.clone(),
                model_id: name.clone(),
                full_url: false,
                kind: ModelKind::Chat,
            },
        )?;
        model_store::set_active(vfs.conn(), LOCAL_MNN_ENTRY_ID)?;
    }

    let threads = crate::agent::local::gating::device_profile().recommended_threads;
    let state = state.inner().clone();
    let result = tauri::async_runtime::spawn_blocking(move || state.load(&name, threads))
        .await
        .map_err(|e| ToolError::invalid(format!("MNN 加载线程异常：{e}")))?
        .map_err(|e| ToolError::invalid(format!("MNN 加载失败：{e}")));
    log::info!(
        "engine switch to MNN completed in {} ms",
        switch_started.elapsed().as_millis()
    );
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn thread_whitelist_is_inclusive() {
        assert!(validate_threads(1).is_ok());
        assert!(validate_threads(MAX_THREADS).is_ok());
        assert!(matches!(
            validate_threads(0),
            Err(MnnError::InvalidArgument { .. })
        ));
        assert!(matches!(
            validate_threads(MAX_THREADS + 1),
            Err(MnnError::InvalidArgument { .. })
        ));
    }

    #[test]
    fn generate_whitelist_rejects_empty_long_and_zero() {
        assert!(validate_generate("你好", 1).is_ok());
        assert!(validate_generate("你好", MAX_MAX_TOKENS).is_ok());
        assert!(matches!(
            validate_generate("   ", 8),
            Err(MnnError::InvalidArgument { .. })
        ));
        assert!(matches!(
            validate_generate("你好", 0),
            Err(MnnError::InvalidArgument { .. })
        ));
        assert!(matches!(
            validate_generate("你好", MAX_MAX_TOKENS + 1),
            Err(MnnError::InvalidArgument { .. })
        ));
        let long = "a".repeat(MAX_PROMPT_BYTES + 1);
        assert!(matches!(
            validate_generate(&long, 8),
            Err(MnnError::InvalidArgument { .. })
        ));
    }
}
