//! Errors returned by the embedded MNN engine.
//!
//! Serialised as `{ code, message }` so the WebView can branch on `code`
//! instead of matching prose. Mirrors `vfs::error::ToolError` so that the
//! unified engine layer can lift both engines onto one error contract.

// `NotLoaded` / `Busy` are only constructed by the feature-gated engine path.
#![cfg_attr(not(feature = "local-mnn"), allow(dead_code))]

use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "code", rename_all = "camelCase")]
pub enum MnnError {
    /// 编译时未包含 `local-mnn`，或平台不支持。
    Unsupported { message: String },
    /// 模型尚未加载完成。
    NotLoaded,
    /// 引擎正在执行另一轮生成。
    Busy,
    /// 参数不满足命令契约。
    InvalidArgument { message: String },
    /// bundle 不存在或缺少必需文件。
    ModelNotFound { model: String },
    /// 原生层返回失败（创建、加载、配置、生成）。
    Engine { message: String },
    /// 阻塞任务调度失败（`spawn_blocking`）。
    Thread { message: String },
}

impl MnnError {
    pub fn invalid(message: impl Into<String>) -> Self {
        Self::InvalidArgument {
            message: message.into(),
        }
    }

    pub fn engine(message: impl Into<String>) -> Self {
        Self::Engine {
            message: message.into(),
        }
    }

    pub fn not_loaded() -> Self {
        Self::NotLoaded
    }

    /// 命令层把阻塞任务失败统一成 `Thread`，避免把 join 错误直接透给前端。
    pub fn thread(message: impl Into<String>) -> Self {
        Self::Thread {
            message: message.into(),
        }
    }
}

impl std::fmt::Display for MnnError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unsupported { message } => write!(f, "{message}"),
            Self::NotLoaded => write!(f, "本地模型尚未加载"),
            Self::Busy => write!(f, "本地模型正忙，请稍后再试"),
            Self::InvalidArgument { message } => write!(f, "参数非法：{message}"),
            Self::ModelNotFound { model } => write!(f, "模型不存在：{model}"),
            Self::Engine { message } => write!(f, "MNN 引擎错误：{message}"),
            Self::Thread { message } => write!(f, "任务调度失败：{message}"),
        }
    }
}

impl std::error::Error for MnnError {}
