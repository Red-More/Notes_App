//! 本地模型配置、文件目录与生命周期状态机（阶段 B）。
//!
//! 状态机：`Unloaded → Loading → Ready ⇄ Generating`，`Suspended` 与 `Failed`
//! 可从任意加载态进入。手动关闭与后台暂停都回到 `Unloaded` / `Suspended`，
//! 并立即释放模型权重；生成中途暂停通过取消标记在一个 token 内退出。

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use super::gating::{self, GateDecision, GatePolicy};
use super::{LocalModelFile, LocalState, LocalStatus};
use crate::agent::inference::{
    EngineError, EngineInput, EngineKind, EngineMetrics, GenerateParams, InferenceEngine,
    LoadOptions, ModelAsset,
};
#[cfg(feature = "local-llm")]
use crate::agent::inference::EngineTurn;
use crate::vfs::error::ToolError;

const KEY_LOCAL: &str = "agent.local.v1";
const MAX_FILE_CHARS: usize = 120;
const MAX_THREADS: u32 = 8;
const MIN_CONTEXT: u32 = 2048;
const MIN_MAX_TOKENS: u32 = 32;
const MAX_MAX_TOKENS: u32 = 4096;
/// Prompt budget kept free when the output limit is checked against context.
const MIN_INPUT_TOKENS: u32 = 512;
/// 手动导入上限；阶段 D 的下载链路会做 sha256 与白名单校验。
pub const MAX_MODEL_BYTES: u64 = 3 * 1024 * 1024 * 1024;

/// 持久化的本地模型偏好；`0` 表示交给设备推荐值。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct LocalConfig {
    /// 模型目录内的 `.gguf` 文件名，不是路径。
    pub file: String,
    pub threads: u32,
    pub context_size: u32,
    /// 用户显式允许后台常驻；默认关闭。
    pub keep_alive: bool,
    /// 用户总开关；关闭后不再自动加载。
    pub enabled: bool,
    /// 单次回复的输出上限，作为未配置 `maxTokens` 时的兜底。
    pub max_tokens: u32,
}

impl Default for LocalConfig {
    fn default() -> Self {
        Self {
            file: String::new(),
            threads: 0,
            context_size: 0,
            keep_alive: false,
            enabled: false,
            max_tokens: 512,
        }
    }
}

impl LocalConfig {
    pub fn effective_threads(&self, recommended: u32) -> u32 {
        if self.threads == 0 {
            recommended.max(1)
        } else {
            self.threads.clamp(1, MAX_THREADS)
        }
    }

    /// `0` means "leave it to llama.cpp"; otherwise the user value with the
    /// minimum enforced. Large values are accepted with a UI warning instead of
    /// being rejected here.
    pub fn effective_context(&self) -> u32 {
        if self.context_size == 0 {
            0
        } else {
            self.context_size.max(MIN_CONTEXT)
        }
    }
}

/// 只接受模型目录内的安全文件名：无路径分隔符、以 `.gguf` 结尾。
pub fn is_valid_file_name(name: &str) -> bool {
    let trimmed = name.trim();
    !trimmed.is_empty()
        && trimmed.chars().count() <= MAX_FILE_CHARS
        && trimmed.to_ascii_lowercase().ends_with(".gguf")
        && trimmed
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

fn sanitize(mut config: LocalConfig) -> Result<LocalConfig, ToolError> {
    config.file = config.file.trim().to_string();
    if !config.file.is_empty() && !is_valid_file_name(&config.file) {
        return Err(ToolError::invalid("模型文件名只能是目录内的 .gguf 文件名"));
    }
    if config.threads > MAX_THREADS {
        return Err(ToolError::invalid(format!("线程数不能超过 {MAX_THREADS}")));
    }
    if config.context_size != 0 && config.context_size < MIN_CONTEXT {
        return Err(ToolError::invalid(format!(
            "上下文长度不能低于 {MIN_CONTEXT}；留空则交给 llama.cpp 自动决定"
        )));
    }
    if !(MIN_MAX_TOKENS..=MAX_MAX_TOKENS).contains(&config.max_tokens) {
        return Err(ToolError::invalid(format!(
            "输出上限必须在 {MIN_MAX_TOKENS}–{MAX_MAX_TOKENS} 之间"
        )));
    }
    if config.context_size != 0 {
        // The output limit is carved out of the same window, so it must leave
        // room for the prompt. Without this check a 512/512 pair only fails at
        // inference time with an opaque "context exceeded" error.
        let needed = config.max_tokens.saturating_add(MIN_INPUT_TOKENS);
        if config.context_size < needed {
            return Err(ToolError::invalid(format!(
                "上下文长度至少需要 {needed}（输出上限 {} + 预留输入 {MIN_INPUT_TOKENS}）",
                config.max_tokens
            )));
        }
    }
    Ok(config)
}

pub fn load_config(conn: &Connection) -> LocalConfig {
    let Some(raw) = read_setting(conn, KEY_LOCAL) else {
        return LocalConfig::default();
    };
    match serde_json::from_str::<LocalConfig>(&raw) {
        Ok(mut config) => match sanitize(config.clone()) {
            Ok(clean) => clean,
            Err(_) => {
                // Older configs may store a context smaller than the output limit.
                // Widen it instead of dropping the user's model choice and switches.
                config.context_size = config
                    .context_size
                    .max(config.max_tokens.saturating_add(MIN_INPUT_TOKENS))
                    .max(MIN_CONTEXT);
                sanitize(config).unwrap_or_default()
            }
        },
        Err(e) => {
            log::warn!("local model config JSON is invalid, using defaults: {e}");
            LocalConfig::default()
        }
    }
}

pub fn save_config(conn: &Connection, config: &LocalConfig) -> Result<LocalConfig, ToolError> {
    let clean = sanitize(config.clone())?;
    let body = serde_json::to_string(&clean)
        .map_err(|e| ToolError::invalid(format!("本地模型配置序列化失败：{e}")))?;
    conn.execute(
        "INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, datetime('now','localtime'))
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        params![KEY_LOCAL, body],
    )?;
    Ok(clean)
}

/// 扫描模型目录；只返回 `.gguf`，按文件名排序。
pub fn list_files(dir: &Path, max_model_mb: u64) -> Vec<LocalModelFile> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let limit = max_model_mb.saturating_mul(1024 * 1024);
    let mut files: Vec<LocalModelFile> = entries
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            if !is_valid_file_name(&name) {
                return None;
            }
            let bytes = entry.metadata().ok()?.len();
            Some(LocalModelFile {
                recommended: max_model_mb > 0 && bytes <= limit,
                name,
                bytes,
            })
        })
        .collect();
    files.sort_by(|a, b| a.name.cmp(&b.name));
    files.truncate(32);
    files
}

#[cfg(feature = "local-llm")]
type Loaded = super::engine::Engine;

#[cfg(not(feature = "local-llm"))]
struct Loaded;

#[derive(Clone)]
pub struct Runtime {
    inner: Arc<Inner>,
}

struct Inner {
    models_dir: PathBuf,
    status: Mutex<LocalStatus>,
    loaded: Mutex<Option<Loaded>>,
    config: Mutex<LocalConfig>,
    loading: AtomicBool,
    busy: AtomicBool,
    current_cancel: Mutex<Option<Arc<AtomicBool>>>,
    /// 最近一轮的统一指标，供状态页读取。
    last_metrics: Mutex<Option<EngineMetrics>>,
    /// 热压暂停后保持到温度回落到恢复阈值，避免在边界反复启停。
    gate_latched: AtomicBool,
    #[cfg(feature = "local-llm")]
    backend: std::sync::OnceLock<llama_cpp_2::llama_backend::LlamaBackend>,
}

impl Runtime {
    pub fn new(models_dir: PathBuf) -> Self {
        if let Err(e) = std::fs::create_dir_all(&models_dir) {
            log::warn!("local model directory create failed: {e}");
        }
        let supported = EngineKind::LlamaCpp.available();
        Self {
            inner: Arc::new(Inner {
                models_dir,
                status: Mutex::new(LocalStatus::new(supported)),
                loaded: Mutex::new(None),
                config: Mutex::new(LocalConfig::default()),
                loading: AtomicBool::new(false),
                busy: AtomicBool::new(false),
                current_cancel: Mutex::new(None),
                last_metrics: Mutex::new(None),
                gate_latched: AtomicBool::new(false),
                #[cfg(feature = "local-llm")]
                backend: std::sync::OnceLock::new(),
            }),
        }
    }

    pub fn supported(&self) -> bool {
        EngineKind::LlamaCpp.available()
    }

    pub fn models_dir(&self) -> &Path {
        &self.inner.models_dir
    }

    pub fn status(&self) -> LocalStatus {
        self.inner.status.lock().unwrap().clone()
    }

    pub fn config(&self) -> LocalConfig {
        self.inner.config.lock().unwrap().clone()
    }

    pub fn set_config(&self, config: LocalConfig) {
        *self.inner.config.lock().unwrap() = config;
    }

    /// 加载或切换模型。阻塞调用，必须放在 `spawn_blocking` 上执行。
    pub fn load_blocking(&self, config: LocalConfig) -> Result<(), ToolError> {
        if !self.supported() {
            return Err(ToolError::invalid(
                "当前构建未启用本地模型（编译时未包含 local-llm）",
            ));
        }
        if self.inner.busy.load(Ordering::SeqCst) {
            return Err(ToolError::invalid("本地模型正在生成，请先停止"));
        }
        if self.inner.loading.swap(true, Ordering::SeqCst) {
            return Err(ToolError::invalid("本地模型正在加载"));
        }
        let _guard = FlagGuard(&self.inner.loading);
        self.load_inner(config)
    }

    fn load_inner(&self, config: LocalConfig) -> Result<(), ToolError> {
        let file = config.file.trim();
        if file.is_empty() {
            return Err(ToolError::invalid("请先选择要加载的 GGUF 文件"));
        }
        let path = self.inner.models_dir.join(file);
        if !path.is_file() {
            return Err(ToolError::invalid(format!("模型文件不存在：{file}")));
        }
        self.require_gate()?;
        let device = gating::device_profile();
        let threads = config.effective_threads(device.recommended_threads);
        let context = config.effective_context();

        // 先释放旧模型，切换时不会同时占用两份权重。
        // Release the old weights as soon as the lock yields them.
        self.inner.loaded.lock().unwrap().take();
        self.publish(LocalState::Loading, 0, threads, context, None, None);

        #[cfg(feature = "local-llm")]
        {
            let backend = match self.backend() {
                Ok(backend) => backend,
                Err(error) => {
                    let message = error.to_string();
                    self.publish(
                        LocalState::Failed,
                        0,
                        threads,
                        context,
                        Some(file.to_string()),
                        Some(message),
                    );
                    return Err(error);
                }
            };
            let load_started = std::time::Instant::now();
            match super::engine::Engine::load(backend, &path, context, threads) {
                Ok(engine) => {
                    let bytes = std::fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0);
                    log::info!(
                        "local perf: load_ms={} bytes={} context={} threads={}",
                        load_started.elapsed().as_millis(),
                        bytes,
                        context,
                        threads
                    );
                    *self.inner.loaded.lock().unwrap() = Some(engine);
                    self.publish(
                        LocalState::Ready,
                        bytes,
                        threads,
                        context,
                        Some(file.to_string()),
                        None,
                    );
                    Ok(())
                }
                Err(message) => {
                    let message = message.to_string();
                    self.publish(
                        LocalState::Failed,
                        0,
                        threads,
                        context,
                        Some(file.to_string()),
                        Some(message.clone()),
                    );
                    Err(ToolError::invalid(message))
                }
            }
        }

        #[cfg(not(feature = "local-llm"))]
        {
            let message = "当前构建未启用本地模型".to_string();
            self.publish(
                LocalState::Failed,
                0,
                threads,
                context,
                Some(file.to_string()),
                Some(message.clone()),
            );
            let _ = &path;
            Err(ToolError::invalid(message))
        }
    }

    /// 用户手动关闭：取消生成并释放权重。
    pub fn unload(&self) {
        self.cancel_current();
        // Release the old weights as soon as the lock yields them.
        self.inner.loaded.lock().unwrap().take();
        let (threads, context) = self.layout();
        self.publish(LocalState::Unloaded, 0, threads, context, None, None);
    }

    /// 暂停：后台、热压或低电量；保留用户设置，仅释放权重。
    pub fn suspend(&self, reason: &str) {
        self.cancel_current();
        // Release the old weights as soon as the lock yields them.
        self.inner.loaded.lock().unwrap().take();
        let (threads, context) = self.layout();
        self.publish(
            LocalState::Suspended,
            0,
            threads,
            context,
            None,
            Some(reason.to_string()),
        );
    }

    /// 阻塞生成；调用方负责把 chunk 转发到异步通道。
    pub fn generate_blocking(
        &self,
        input: EngineInput,
        params: &GenerateParams,
        cancel: &Arc<AtomicBool>,
        sink: &mut dyn FnMut(&str),
    ) -> Result<EngineMetrics, EngineError> {
        if !self.supported() {
            return Err(EngineError::Unsupported {
                message: "当前构建未启用本地模型（编译时未包含 local-llm）".to_string(),
            });
        }
        self.require_gate()
            .map_err(|e| EngineError::invalid(e.to_string()))?;
        // Resolve the backend before publishing state so an init failure cannot
        // leave the status stuck in `Generating`.
        #[cfg(feature = "local-llm")]
        let backend = self.backend().map_err(|e| EngineError::invalid(e.to_string()))?;
        // Reject input the backend cannot render before touching any state; an
        // early `return` afterwards would skip the `Generating` cleanup below.
        #[cfg(feature = "local-llm")]
        let turns: Vec<EngineTurn> = match input {
            EngineInput::Turns(turns) => turns,
            EngineInput::Prompt(_) => {
                return Err(EngineError::invalid(
                    "llama.cpp 引擎需要结构化消息，而不是预渲染 prompt",
                ))
            }
        };
        if self.inner.busy.swap(true, Ordering::SeqCst) {
            return Err(EngineError::Busy);
        }
        let _guard = FlagGuard(&self.inner.busy);
        *self.inner.current_cancel.lock().unwrap() = Some(cancel.clone());

        let status = self.status();
        let (threads, context, model, bytes) = (
            status.threads,
            status.context_size,
            status.model.clone(),
            status.model_bytes.unwrap_or(0),
        );
        self.publish(
            LocalState::Generating,
            bytes,
            threads,
            context,
            model.clone(),
            None,
        );

        #[cfg(feature = "local-llm")]
        let result = {
            let loaded = self.inner.loaded.lock().unwrap();
            match loaded.as_ref() {
                Some(engine) => engine.generate(backend, &turns, params, cancel, sink),
                None => Err(EngineError::invalid("本地模型未加载，请先在设置页加载")),
            }
        };

        #[cfg(not(feature = "local-llm"))]
        let result: Result<EngineMetrics, EngineError> = {
            let _ = (input, params, cancel, sink);
            Err(EngineError::Unsupported {
                message: "当前构建未启用本地模型".to_string(),
            })
        };

        if let Ok(metrics) = &result {
            *self.inner.last_metrics.lock().unwrap() = Some(metrics.clone());
        }
        self.inner.current_cancel.lock().unwrap().take();
        // A concurrent suspend/unload may have published its own state while
        // this turn was winding down; only restore Ready if we still own it.
        if !matches!(self.inner.status.lock().unwrap().state, LocalState::Generating) {
            return result;
        }
        self.publish(LocalState::Ready, bytes, threads, context, model, None);
        result
    }

    /// 读取实时功耗并更新热压锁存；设置页和加载路径共用同一状态。
    pub fn gate_snapshot(&self) -> (gating::PowerSnapshot, GateDecision) {
        let power = gating::power_snapshot();
        let latched = self.inner.gate_latched.load(Ordering::SeqCst);
        let decision = gating::evaluate(&power, &GatePolicy::default(), latched);
        let next_latched = matches!(&decision, GateDecision::Suspend { thermal: true, .. });
        self.inner
            .gate_latched
            .store(next_latched, Ordering::SeqCst);
        (power, decision)
    }

    fn require_gate(&self) -> Result<(), ToolError> {
        let (_, decision) = self.gate_snapshot();
        match decision {
            GateDecision::Allow => Ok(()),
            GateDecision::Suspend { reason, .. } => {
                self.suspend(&reason);
                Err(ToolError::invalid(format!(
                    "{reason}，本地模型已暂停；恢复后可重新加载"
                )))
            }
        }
    }

    fn layout(&self) -> (u32, u32) {
        let status = self.inner.status.lock().unwrap();
        (status.threads, status.context_size)
    }

    fn cancel_current(&self) -> bool {
        match self.inner.current_cancel.lock().unwrap().take() {
            Some(flag) => {
                flag.store(true, Ordering::SeqCst);
                true
            }
            None => false,
        }
    }

    #[cfg(feature = "local-llm")]
    fn backend(&self) -> Result<&llama_cpp_2::llama_backend::LlamaBackend, ToolError> {
        if self.inner.backend.get().is_none() {
            let backend = llama_cpp_2::llama_backend::LlamaBackend::init()
                .map_err(|e| ToolError::invalid(format!("llama.cpp 初始化失败：{e}")))?;
            let _ = self.inner.backend.set(backend);
        }
        self.inner
            .backend
            .get()
            .ok_or_else(|| ToolError::invalid("llama.cpp 后端不可用"))
    }

    fn publish(
        &self,
        state: LocalState,
        bytes: u64,
        threads: u32,
        context: u32,
        model: Option<String>,
        error: Option<String>,
    ) {
        let mut status = self.inner.status.lock().unwrap();
        status.state = state;
        status.model = model;
        status.model_bytes = if bytes == 0 { None } else { Some(bytes) };
        status.threads = threads;
        status.context_size = context;
        status.error = error;
    }
}

/// llama.cpp 适配器：对外只暴露统一 trait，业务层不接触 `Engine` 类型。
impl InferenceEngine for Runtime {
    fn kind(&self) -> EngineKind {
        EngineKind::LlamaCpp
    }

    fn load(&self, model: &ModelAsset, options: &LoadOptions) -> Result<(), EngineError> {
        let file = match model {
            ModelAsset::SingleFile { path } => path
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_default(),
            ModelAsset::Bundle { .. } => {
                return Err(EngineError::invalid("llama.cpp 需要单个 .gguf 文件"))
            }
        };
        if file.trim().is_empty() {
            return Err(EngineError::invalid("请先选择要加载的 GGUF 文件"));
        }
        let config = LocalConfig {
            file,
            threads: options.threads,
            context_size: options.context_size,
            ..LocalConfig::default()
        };
        self.load_blocking(config)
            .map_err(|e| EngineError::invalid(e.to_string()))
    }

    fn generate(
        &self,
        input: EngineInput,
        params: &GenerateParams,
        cancel: &Arc<AtomicBool>,
        mut sink: Box<dyn FnMut(&str) + Send>,
    ) -> Result<EngineMetrics, EngineError> {
        self.generate_blocking(input, params, cancel, &mut *sink)
    }

    fn cancel(&self) -> bool {
        self.cancel_current()
    }

    fn unload(&self) -> Result<(), EngineError> {
        Runtime::unload(self);
        Ok(())
    }

    fn metrics(&self) -> Option<EngineMetrics> {
        self.inner.last_metrics.lock().unwrap().clone()
    }
}

struct FlagGuard<'a>(&'a AtomicBool);

impl Drop for FlagGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

fn read_setting(conn: &Connection, key: &str) -> Option<String> {
    conn.query_row(
        "SELECT value FROM settings WHERE key = ?1",
        params![key],
        |row| row.get(0),
    )
    .optional()
    .ok()
    .flatten()
    .filter(|value: &String| !value.trim().is_empty())
}
