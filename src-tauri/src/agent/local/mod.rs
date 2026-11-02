//! 内嵌 llama.cpp 本地运行时（阶段 B）。
//!
//! 边界：
//! - WebView 只能选择模型目录内的文件，不能传任意路径、prompt 或生成参数之外的开关；
//!   请求仍然走 `agent_stream` 的白名单校验。
//! - 推理在阻塞线程上执行，异步侧只搬运 chunk，复用现有 `StreamEvent` 契约。
//! - 热/电量门控在 Rust 侧、解码前强制检查，前端无法绕过。
//! - 未启用 `local-llm` feature 时模块照常编译，状态返回 `unsupported`，
//!   默认桌面构建因此不需要 clang/cmake。

// Always compiled so the budget tests run without the llama.cpp toolchain;
// only the feature-gated engine calls into it.
#[cfg_attr(not(feature = "local-llm"), allow(dead_code))]
pub mod budget;
pub mod gating;
pub mod runtime;

#[cfg(feature = "local-llm")]
mod engine;

use serde::Serialize;

/// 生命周期状态；`Unsupported` 表示当前构建不含本地推理引擎。
#[cfg_attr(not(feature = "local-llm"), allow(dead_code))]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum LocalState {
    Unsupported,
    Unloaded,
    Loading,
    Ready,
    Generating,
    Suspended,
    Failed,
}

/// 运行时快照；只含状态与文件信息，不含 prompt 或模型内容。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalStatus {
    pub state: LocalState,
    pub model: Option<String>,
    pub model_bytes: Option<u64>,
    pub threads: u32,
    pub context_size: u32,
    pub error: Option<String>,
}

impl LocalStatus {
    pub fn new(supported: bool) -> Self {
        Self {
            state: if supported {
                LocalState::Unloaded
            } else {
                LocalState::Unsupported
            },
            model: None,
            model_bytes: None,
            threads: 0,
            context_size: 0,
            error: None,
        }
    }
}

/// 模型文件；`recommended` 只用于 UI 提示，不触发自动下载。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalModelFile {
    pub name: String,
    pub bytes: u64,
    pub recommended: bool,
}
