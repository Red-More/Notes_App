//! Tauri commands for the embedded MNN runtime (feature `local-mnn`).
//!
//! 只接受模型目录内的 bundle 名，不接受任意路径；加载与生成都放在阻塞线程，
//! 不占用 async 运行时，避免 ANR。错误统一为 `MnnError`（`{ code, ... }`），
//! 与 VFS 的 `ToolError` 序列化风格一致。
//!
//! `local_mnn_generate` 仍返回整段结果，但引擎侧已经按 chunk 回调实现；
//! 需要真流式时只在这里换成 `mpsc::Sender<String>` 或 `app.emit`，不改引擎。

use tauri::State;

use crate::agent::local_mnn::{
    LocalMnnModel, LocalMnnResult, LocalMnnState, LocalMnnStatus, MnnError,
};

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
    state.status()
}

#[tauri::command]
pub fn local_mnn_models(state: State<'_, LocalMnnState>) -> Vec<LocalMnnModel> {
    state.models()
}

#[tauri::command]
pub async fn local_mnn_load(
    state: State<'_, LocalMnnState>,
    model: String,
    threads: u32,
) -> Result<(), MnnError> {
    validate_threads(threads)?;
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || state.load(&model, threads))
        .await
        .map_err(|e| MnnError::thread(e.to_string()))?
}

#[tauri::command]
pub async fn local_mnn_generate(
    state: State<'_, LocalMnnState>,
    prompt: String,
    max_tokens: u32,
) -> Result<LocalMnnResult, MnnError> {
    validate_generate(&prompt, max_tokens)?;
    let state = state.inner().clone();
    // Chunks are not forwarded yet; the sink is wired so the streaming
    // command can subscribe without touching the engine.
    tauri::async_runtime::spawn_blocking(move || state.generate_stream(&prompt, max_tokens, |_| {}))
        .await
        .map_err(|e| MnnError::thread(e.to_string()))?
}

/// 中止当前生成；返回 `false` 表示没有正在执行的轮次。
#[tauri::command]
pub fn local_mnn_cancel(state: State<'_, LocalMnnState>) -> bool {
    state.cancel()
}

#[tauri::command]
pub async fn local_mnn_unload(state: State<'_, LocalMnnState>) -> Result<(), MnnError> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || state.unload())
        .await
        .map_err(|e| MnnError::thread(e.to_string()))?
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
