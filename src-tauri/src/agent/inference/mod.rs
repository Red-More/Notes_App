//! 统一推理引擎抽象：业务层只依赖本模块的 trait 与类型。
//!
//! 两个后端（llama.cpp 的 GGUF 单文件、MNN 的多文件 bundle）各自实现
//! [`InferenceEngine`]，Tauri 命令与聊天链路不再出现任何后端专属类型。
//! 未启用对应 feature 时，trait 与纯逻辑类型照常编译，默认桌面构建不受影响。

// 只有两端同时启用时，所有字段才会被两条实现读取；缺任一 feature 时，
// 另一方专属的类型/字段就会看起来未使用。
#![cfg_attr(
    not(all(feature = "local-llm", feature = "local-mnn")),
    allow(dead_code)
)]

use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use serde::Serialize;

// Pure Rust thread plumbing, so it compiles without any engine feature; this
// keeps the rebuild/crash tests runnable on hosts where MNN cannot link.
pub mod worker;

/// 引擎种类；命令与配置用它做选择，不直接暴露后端实现。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum EngineKind {
    LlamaCpp,
    Mnn,
}

impl EngineKind {
    /// 编译时是否包含该引擎。
    pub fn available(self) -> bool {
        match self {
            Self::LlamaCpp => cfg!(feature = "local-llm"),
            Self::Mnn => cfg!(feature = "local-mnn"),
        }
    }
}

/// 模型资产：GGUF 是单文件，MNN 是包含 `config.json` 与权重的目录。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ModelAsset {
    SingleFile { path: PathBuf },
    Bundle { dir: PathBuf },
}

impl ModelAsset {
    /// 用于状态展示的名字；不含目录路径。
    pub fn display_name(&self) -> String {
        match self {
            Self::SingleFile { path } => path
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_default(),
            Self::Bundle { dir } => dir
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_default(),
        }
    }
}

/// 加载参数；两边的可选字段互不冲突，适配器忽略自己不支持的项。
#[derive(Debug, Clone, Default)]
pub struct LoadOptions {
    /// `0` 表示交给引擎的默认值。
    pub threads: u32,
    /// `0` 表示交给引擎的默认值（仅 llama.cpp 使用）。
    pub context_size: u32,
}

/// 一条聊天消息；MNN 适配器会把它折叠成单轮 prompt。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EngineTurn {
    pub role: &'static str,
    pub content: String,
}

/// 生成输入：GGUF 侧需要结构化 turns 以套用模型模板，MNN 侧接受预渲染 prompt。
#[derive(Debug, Clone)]
pub enum EngineInput {
    Prompt(String),
    Turns(Vec<EngineTurn>),
}

/// 采样参数；由上层参数收敛而来，不携带厂商字段。
#[derive(Debug, Clone)]
pub struct GenerateParams {
    pub max_tokens: u32,
    pub temperature: f32,
    pub top_p: f32,
    pub top_k: u32,
    pub seed: u32,
    pub stop: Vec<String>,
}

impl Default for GenerateParams {
    fn default() -> Self {
        Self {
            max_tokens: 512,
            temperature: 0.7,
            top_p: 0.8,
            top_k: 20,
            seed: 0,
            stop: Vec::new(),
        }
    }
}

/// 生成结束原因；两个引擎的取值口径一致。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StopReason {
    Stop,
    Length,
    Cancel,
}

impl StopReason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Stop => "stop",
            Self::Length => "length",
            Self::Cancel => "cancel",
        }
    }
}

/// 统一指标：prefill / decode / TTFT / token 数，供命令、日志与对照实验复用。
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineMetrics {
    pub prompt_tokens: u32,
    pub output_tokens: u32,
    pub prefill_ms: u64,
    pub decode_ms: u64,
    /// 采样耗时；llama.cpp 内联采样，本项为 0。
    pub sample_ms: u64,
    /// 首 token 延迟（TTFT），从请求开始计时。
    pub first_chunk_ms: u64,
    pub decode_tok_s: f64,
    /// `stop` | `length` | `cancel`
    pub stop_reason: String,
}

/// 统一错误；序列化为 `{ code, message }`（`modelNotFound` 另带 `model`），
/// 与 VFS 的 `ToolError` 风格一致。`message` 始终存在，前端无需判空。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EngineError {
    /// 编译时未包含对应引擎，或平台不支持。
    Unsupported { message: String },
    /// 模型尚未加载完成。
    NotLoaded,
    /// 引擎正在执行另一轮生成。
    Busy,
    /// 参数不满足命令契约。
    InvalidArgument { message: String },
    /// 模型或 bundle 不存在、缺少必需文件。
    ModelNotFound { model: String },
    /// 路径存在但读写失败（权限、只读区、存储 IO）。
    Io { message: String },
    /// 权重格式不被当前引擎支持（例如 bundle 缺少 config/权重）。
    UnsupportedFormat { message: String },
    /// 原生层返回失败（创建、加载、配置、生成）。
    Engine { message: String },
    /// 阻塞任务调度失败（`spawn_blocking`）。
    Thread { message: String },
    /// 用户主动中止；仅 llama.cpp 适配器用错误表达取消。
    Cancelled,
}

impl EngineError {
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

    pub fn thread(message: impl Into<String>) -> Self {
        Self::Thread {
            message: message.into(),
        }
    }

    pub fn io(message: impl Into<String>) -> Self {
        Self::Io {
            message: message.into(),
        }
    }

    pub fn unsupported_format(message: impl Into<String>) -> Self {
        Self::UnsupportedFormat {
            message: message.into(),
        }
    }

    /// 机器可读判别值，与序列化后的 `code` 字段完全一致。
    pub fn code(&self) -> &'static str {
        match self {
            Self::Unsupported { .. } => "unsupported",
            Self::NotLoaded => "notLoaded",
            Self::Busy => "busy",
            Self::InvalidArgument { .. } => "invalidArgument",
            Self::ModelNotFound { .. } => "modelNotFound",
            Self::Io { .. } => "io",
            Self::UnsupportedFormat { .. } => "unsupportedFormat",
            Self::Engine { .. } => "engine",
            Self::Thread { .. } => "thread",
            Self::Cancelled => "cancelled",
        }
    }
}

impl std::fmt::Display for EngineError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unsupported { message } => write!(f, "{message}"),
            Self::NotLoaded => write!(f, "本地模型尚未加载"),
            Self::Busy => write!(f, "本地模型正忙，请稍后再试"),
            Self::InvalidArgument { message } => write!(f, "参数非法：{message}"),
            Self::ModelNotFound { model } => write!(f, "模型不存在：{model}"),
            Self::Io { message } => write!(f, "读写失败：{message}"),
            Self::UnsupportedFormat { message } => write!(f, "格式不支持：{message}"),
            Self::Engine { message } => write!(f, "引擎错误：{message}"),
            Self::Thread { message } => write!(f, "任务调度失败：{message}"),
            Self::Cancelled => write!(f, "已取消"),
        }
    }
}

impl std::error::Error for EngineError {}

/// Wire shape: `code` and `message` are always present, while `model` keeps the
/// field that `modelNotFound` already exposed to the frontend.
#[derive(Serialize)]
struct EngineErrorWire<'a> {
    code: &'static str,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    model: Option<&'a str>,
}

impl Serialize for EngineError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        EngineErrorWire {
            code: self.code(),
            message: self.to_string(),
            model: match self {
                Self::ModelNotFound { model } => Some(model.as_str()),
                _ => None,
            },
        }
        .serialize(serializer)
    }
}

/// 引擎契约。所有方法都可从任意线程调用；实现方自行串行化内部句柄。
pub trait InferenceEngine: Send + Sync {
    fn kind(&self) -> EngineKind;

    /// 加载模型；重复调用会先释放旧权重。
    fn load(&self, model: &ModelAsset, options: &LoadOptions) -> Result<(), EngineError>;

    /// 阻塞生成，逐块调用 `sink`，结束后返回统一指标。
    ///
    /// `sink` 必须可移动到引擎线程（MNN 的句柄 `!Send`），因此用 `Box` 而不是
    /// 借用；调用方通过 channel 接收 chunk 即可。
    fn generate(
        &self,
        input: EngineInput,
        params: &GenerateParams,
        cancel: &Arc<AtomicBool>,
        sink: Box<dyn FnMut(&str) + Send>,
    ) -> Result<EngineMetrics, EngineError>;

    /// 请求中止当前轮次；返回 `false` 表示没有正在执行的生成。
    fn cancel(&self) -> bool;

    fn unload(&self) -> Result<(), EngineError>;

    /// 最近一轮的指标；用于状态页与对照实验。
    fn metrics(&self) -> Option<EngineMetrics>;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn engine_kind_parses_known_names() {
        assert_eq!(
            EngineKind::LlamaCpp.available(),
            cfg!(feature = "local-llm")
        );
        assert_eq!(EngineKind::Mnn.available(), cfg!(feature = "local-mnn"));
    }

    #[test]
    fn model_asset_names_do_not_leak_directories() {
        let asset = ModelAsset::SingleFile {
            path: PathBuf::from("C:/models/qwen.gguf"),
        };
        assert_eq!(asset.display_name(), "qwen.gguf");
        let asset = ModelAsset::Bundle {
            dir: PathBuf::from("C:/models/qwen-0.6b"),
        };
        assert_eq!(asset.display_name(), "qwen-0.6b");
    }

    #[test]
    fn engine_errors_always_carry_code_and_message() {
        let missing = serde_json::to_value(EngineError::ModelNotFound {
            model: "qwen-0.6b".into(),
        })
        .unwrap();
        assert_eq!(missing["code"], "modelNotFound");
        assert_eq!(missing["model"], "qwen-0.6b");
        assert_eq!(missing["message"], "模型不存在：qwen-0.6b");

        let cancelled = serde_json::to_value(EngineError::Cancelled).unwrap();
        assert_eq!(cancelled["code"], "cancelled");
        assert_eq!(cancelled["message"], "已取消");
        assert!(cancelled.get("model").is_none());
    }

    #[test]
    fn stop_reason_and_metrics_share_one_shape() {
        assert_eq!(StopReason::Cancel.as_str(), "cancel");
        let metrics = EngineMetrics {
            stop_reason: StopReason::Length.as_str().to_string(),
            ..EngineMetrics::default()
        };
        assert_eq!(metrics.stop_reason, "length");
    }
}
