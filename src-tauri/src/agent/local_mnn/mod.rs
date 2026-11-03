//! Embedded MNN runtime (feature `local-mnn`), Android-first.
//!
//! Boundary: MNN's native LLM handle is `!Send`, so a dedicated worker thread
//! owns it and the Tauri side only talks to the worker through a request
//! channel. Without the feature the module still compiles and reports
//! `available=false`, which keeps the default desktop build free of NDK-built
//! archives.
//!
//! 与 llama.cpp 主线的差异：MNN 的 `max_tokens` 在高层 API 里是“每个解码 step
//! 的上限”，外层循环会一直跑到模型自然停止，因此实际输出可能超过传入值。
//! 本模块改用 `mnn-rs-sys` 每步生成一个 token，由 `step_decision` 累计截断。

// The pure helpers are covered by unit tests and used by the feature-gated
// engine path; without `local-mnn` they are intentionally unused at runtime.
#![cfg_attr(not(feature = "local-mnn"), allow(dead_code))]

pub mod error;

#[cfg(feature = "local-mnn")]
pub mod worker;

pub use error::MnnError;

use crate::agent::inference::{
    EngineError, EngineInput, EngineKind, EngineMetrics, GenerateParams, InferenceEngine,
    LoadOptions, ModelAsset, StopReason,
};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

/// MNN bundle 的入口配置；没有它原生层无法创建实例。
const BUNDLE_CONFIG: &str = "config.json";
/// 防御异常目录（例如误把整个模型仓库拷进模型根目录）。
const MAX_BUNDLE_FILES: usize = 1024;

/// 引擎阶段；`Generating` 期间只允许取消，不允许再次加载。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum MnnPhase {
    Unloaded,
    Loading,
    Ready,
    Generating,
    Failed,
}

impl MnnPhase {
    /// 权重是否驻留在内存中（含正在生成）。
    pub fn is_loaded(self) -> bool {
        matches!(self, Self::Ready | Self::Generating)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MnnEvent {
    LoadStart,
    LoadSucceeded,
    LoadFailed,
    GenerateStart,
    GenerateDone,
    Unload,
}

/// 纯状态机；非法事件保持原状态，由调用方在入口处拦截。
pub fn transition(phase: MnnPhase, event: MnnEvent) -> MnnPhase {
    use MnnEvent::*;
    use MnnPhase::*;
    match (phase, event) {
        (_, Unload) => Unloaded,
        (Unloaded | Ready | Failed, LoadStart) => Loading,
        (Loading, LoadSucceeded) => Ready,
        (Loading, LoadFailed) => Failed,
        (Ready, GenerateStart) => Generating,
        (Generating, GenerateDone) => Ready,
        _ => phase,
    }
}

/// 生成结束原因；与 llama.cpp 主线的 `reason` 取值保持一致。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MnnStopReason {
    Stop,
    Length,
    Cancel,
}

impl From<MnnStopReason> for StopReason {
    fn from(value: MnnStopReason) -> Self {
        match value {
            MnnStopReason::Stop => Self::Stop,
            MnnStopReason::Length => Self::Length,
            MnnStopReason::Cancel => Self::Cancel,
        }
    }
}

/// 决定是否还能再走一步 `generate_step`。
///
/// 取消优先于自然停止：用户主动中止时前端必须收到 `cancel`，而不是看起来
/// 像模型自己说完的 `stop`。达到 `max_tokens` 时返回 `length`，这是真正的
/// 累计上限，而不是“每步上限”。
pub fn step_decision(
    steps: u32,
    max_tokens: u32,
    cancelled: bool,
    stopped: bool,
) -> Option<MnnStopReason> {
    if cancelled {
        return Some(MnnStopReason::Cancel);
    }
    if stopped {
        return Some(MnnStopReason::Stop);
    }
    if steps >= max_tokens {
        return Some(MnnStopReason::Length);
    }
    None
}

/// 运行时状态快照；只含状态与模型名，不含 prompt。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalMnnStatus {
    pub available: bool,
    /// 统一引擎标识；新增字段，前端可忽略。
    pub engine: EngineKind,
    pub phase: MnnPhase,
    /// 兼容既有前端字段；始终等于 `phase.is_loaded()`。
    pub loaded: bool,
    pub model: Option<String>,
    pub threads: u32,
    /// 最近一轮的统一指标；新增字段，前端可忽略。
    pub metrics: Option<EngineMetrics>,
}

impl LocalMnnStatus {
    fn new(available: bool) -> Self {
        Self {
            available,
            engine: EngineKind::Mnn,
            phase: MnnPhase::Unloaded,
            loaded: false,
            model: None,
            threads: 0,
            metrics: None,
        }
    }

    fn apply(&mut self, phase: MnnPhase) {
        self.phase = phase;
        self.loaded = phase.is_loaded();
    }
}

/// 模型目录内的一个可加载 bundle（MNN 模型是多文件目录）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalMnnModel {
    pub name: String,
    pub bytes: u64,
}

/// 单次生成的结果与三段耗时，口径与 llama.cpp 的 `local perf` 对齐。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalMnnResult {
    pub text: String,
    pub prompt_tokens: u32,
    pub output_tokens: u32,
    pub prefill_ms: u64,
    pub decode_ms: u64,
    pub sample_ms: u64,
    pub decode_tok_s: f64,
    pub first_chunk_ms: u64,
    /// `stop` | `length` | `cancel`
    pub stop_reason: String,
}

impl LocalMnnResult {
    /// 命令层把流式文本与统一指标组装成既有返回结构，前端契约不变。
    pub fn from_metrics(text: String, metrics: EngineMetrics) -> Self {
        Self {
            text,
            prompt_tokens: metrics.prompt_tokens,
            output_tokens: metrics.output_tokens,
            prefill_ms: metrics.prefill_ms,
            decode_ms: metrics.decode_ms,
            sample_ms: metrics.sample_ms,
            decode_tok_s: metrics.decode_tok_s,
            first_chunk_ms: metrics.first_chunk_ms,
            stop_reason: metrics.stop_reason,
        }
    }
}

/// 只接受 bundle 目录名：无路径分隔符、不以点开头、仅 ASCII 安全字符。
pub fn is_valid_bundle_name(name: &str) -> bool {
    let trimmed = name.trim();
    !trimmed.is_empty()
        && trimmed.chars().count() <= 120
        && !trimmed.starts_with('.')
        && !trimmed.contains(['/', '\\'])
        && trimmed
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

/// bundle 盘点结果；只统计直接子文件，不递归。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BundleInfo {
    pub files: usize,
    pub bytes: u64,
}

/// 校验一个 bundle 目录是否可交给原生加载器。
///
/// 必需条件：`config.json` + 至少一个 `*.mnn` 权重文件。MNN 的 LLM bundle
/// 还会带 `*.mnn.weight`、`tokenizer.mtok`、`llm_config.json` 等，但不做强制。
pub fn validate_bundle(name: &str, dir: &Path) -> Result<BundleInfo, MnnError> {
    if !is_valid_bundle_name(name) {
        return Err(MnnError::invalid("模型名只能是模型目录内的 bundle 名称"));
    }
    if !dir.is_dir() {
        return Err(MnnError::ModelNotFound {
            model: name.trim().to_string(),
        });
    }
    if !dir.join(BUNDLE_CONFIG).is_file() {
        return Err(MnnError::invalid(format!(
            "{} 缺少 {BUNDLE_CONFIG}",
            dir.display()
        )));
    }

    let mut info = BundleInfo {
        files: 0,
        bytes: 0,
    };
    let mut has_weights = false;
    let entries = std::fs::read_dir(dir)
        .map_err(|e| MnnError::invalid(format!("读取 {} 失败：{e}", dir.display())))?;
    for entry in entries.flatten() {
        let Ok(meta) = entry.metadata() else { continue };
        if !meta.is_file() {
            continue;
        }
        info.files += 1;
        info.bytes = info.bytes.saturating_add(meta.len());
        if entry
            .file_name()
            .to_string_lossy()
            .to_ascii_lowercase()
            .ends_with(".mnn")
        {
            has_weights = true;
        }
    }
    if info.files > MAX_BUNDLE_FILES {
        return Err(MnnError::invalid(format!(
            "{} 文件过多（{} > {MAX_BUNDLE_FILES}）",
            dir.display(),
            info.files
        )));
    }
    if !has_weights {
        return Err(MnnError::invalid(format!(
            "{} 缺少 .mnn 权重文件",
            dir.display()
        )));
    }
    Ok(info)
}

/// 扫描模型根目录，只返回通过 `validate_bundle` 的子目录。
pub fn list_bundles(root: &Path) -> Vec<LocalMnnModel> {
    let Ok(entries) = std::fs::read_dir(root) else {
        return Vec::new();
    };
    let mut models: Vec<LocalMnnModel> = entries
        .flatten()
        .filter_map(|entry| {
            if !entry.file_type().ok()?.is_dir() {
                return None;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            if !is_valid_bundle_name(&name) {
                return None;
            }
            let info = validate_bundle(&name, &entry.path()).ok()?;
            Some(LocalMnnModel {
                name,
                bytes: info.bytes,
            })
        })
        .collect();
    models.sort_by(|a, b| a.name.cmp(&b.name));
    models.truncate(32);
    models
}

/// Tauri 管理的运行时句柄：worker 通道 + 状态 + 取消标记。
/// `Clone` 只是共享内部 `Arc`，用于把句柄搬进 `spawn_blocking`。
#[derive(Clone)]
pub struct LocalMnnState {
    inner: Arc<Inner>,
}

struct Inner {
    root: PathBuf,
    status: Mutex<LocalMnnStatus>,
    #[cfg(feature = "local-mnn")]
    worker: Mutex<Option<worker::MnnWorker>>,
    /// 当前生成轮的取消标记；`None` 表示没有正在执行的生成。
    cancel: Mutex<Option<Arc<AtomicBool>>>,
    /// 最近一轮的统一指标，供状态页读取。
    last_metrics: Mutex<Option<EngineMetrics>>,
}

impl LocalMnnState {
    pub fn new(root: PathBuf) -> Self {
        if let Err(e) = std::fs::create_dir_all(&root) {
            log::warn!("mnn model directory create failed: {e}");
        }
        let available = EngineKind::Mnn.available();
        Self {
            inner: Arc::new(Inner {
                root,
                status: Mutex::new(LocalMnnStatus::new(available)),
                #[cfg(feature = "local-mnn")]
                worker: Mutex::new(None),
                cancel: Mutex::new(None),
                last_metrics: Mutex::new(None),
            }),
        }
    }

    pub fn status(&self) -> LocalMnnStatus {
        self.inner.status.lock().unwrap().clone()
    }

    pub fn models(&self) -> Vec<LocalMnnModel> {
        list_bundles(&self.inner.root)
    }

    /// 解析并校验 bundle 目录；返回规范化后的绝对路径，拒绝越界访问。
    pub fn resolve_bundle(&self, name: &str) -> Result<PathBuf, MnnError> {
        if !is_valid_bundle_name(name) {
            return Err(MnnError::invalid("模型名只能是模型目录内的 bundle 名称"));
        }
        let clean = name.trim();
        let root = std::fs::canonicalize(&self.inner.root)
            .map_err(|e| MnnError::engine(format!("模型目录不可用：{e}")))?;
        let resolved = std::fs::canonicalize(root.join(clean)).map_err(|_| {
            MnnError::ModelNotFound {
                model: clean.to_string(),
            }
        })?;
        // `canonicalize` 会解开符号链接；前缀检查拦住指向根目录之外的链接。
        if !resolved.starts_with(&root) {
            return Err(MnnError::invalid("模型目录越界"));
        }
        validate_bundle(clean, &resolved)?;
        Ok(resolved)
    }

    /// 请求中止当前生成；返回 `false` 表示没有正在执行的轮次。
    pub fn cancel(&self) -> bool {
        match self.inner.cancel.lock().unwrap().as_ref() {
            Some(flag) => {
                flag.store(true, Ordering::SeqCst);
                true
            }
            None => false,
        }
    }

    /// 加载 bundle。`threads` 由命令层限定在 1..=8。
    pub fn load(&self, name: &str, threads: u32) -> Result<(), MnnError> {
        #[cfg(feature = "local-mnn")]
        {
            if self.inner.status.lock().unwrap().phase == MnnPhase::Generating {
                return Err(MnnError::Busy);
            }
            let path = self.resolve_bundle(name)?;
            let worker = self.worker()?;
            self.set_phase(MnnEvent::LoadStart);
            match worker.load(path, threads) {
                Ok(()) => {
                    let mut status = self.inner.status.lock().unwrap();
                    status.model = Some(name.trim().to_string());
                    status.threads = threads;
                    let next = transition(status.phase, MnnEvent::LoadSucceeded);
                    status.apply(next);
                    Ok(())
                }
                Err(error) => {
                    let mut status = self.inner.status.lock().unwrap();
                    status.model = None;
                    status.threads = 0;
                    let next = transition(status.phase, MnnEvent::LoadFailed);
                    status.apply(next);
                    Err(error)
                }
            }
        }

        #[cfg(not(feature = "local-mnn"))]
        {
            let _ = (name, threads);
            Err(MnnError::Unsupported {
                message: "当前构建未启用 MNN 本地模型（编译时未包含 local-mnn）".to_string(),
            })
        }
    }

    /// 流式生成；`sink` 在 worker 线程里逐块调用，结束后返回统一指标。
    ///
    /// `cancel` 同时保存到运行时槽位，命令层的 `local_mnn_cancel` 可在
    /// token 之间置位，无需再经 worker 队列。
    pub fn generate_stream<F>(
        &self,
        prompt: &str,
        max_tokens: u32,
        cancel: Arc<AtomicBool>,
        sink: F,
    ) -> Result<EngineMetrics, MnnError>
    where
        F: FnMut(&str) + Send + 'static,
    {
        if prompt.trim().is_empty() {
            return Err(MnnError::invalid("prompt 不能为空"));
        }
        if max_tokens == 0 {
            return Err(MnnError::invalid("输出上限必须大于 0"));
        }

        #[cfg(feature = "local-mnn")]
        {
            {
                let mut status = self.inner.status.lock().unwrap();
                match status.phase {
                    MnnPhase::Generating => return Err(MnnError::Busy),
                    MnnPhase::Ready => {}
                    _ => return Err(MnnError::not_loaded()),
                }
                let next = transition(status.phase, MnnEvent::GenerateStart);
                status.apply(next);
            }
            let cancel_for_slot = cancel.clone();
            *self.inner.cancel.lock().unwrap() = Some(cancel_for_slot);
            let result = self.worker().and_then(|worker| {
                worker.generate(prompt.to_string(), max_tokens, cancel, Box::new(sink))
            });
            *self.inner.cancel.lock().unwrap() = None;
            self.set_phase(MnnEvent::GenerateDone);
            // A failed turn produced no metrics; keeping the previous round's
            // numbers would make the status page report a turn that never finished.
            *self.inner.last_metrics.lock().unwrap() = match &result {
                Ok(metrics) => Some(metrics.clone()),
                Err(_) => None,
            };
            result
        }

        #[cfg(not(feature = "local-mnn"))]
        {
            let _ = (cancel, sink);
            Err(MnnError::Unsupported {
                message: "当前构建未启用 MNN 本地模型（编译时未包含 local-mnn）".to_string(),
            })
        }
    }

    pub fn unload(&self) -> Result<(), MnnError> {
        // Stop the decode loop first: the worker runs one job at a time, so the
        // unload job would otherwise wait for the whole turn to finish.
        self.cancel();
        #[cfg(feature = "local-mnn")]
        {
            let worker = self.inner.worker.lock().unwrap().clone();
            if let Some(worker) = worker {
                worker.unload()?;
            }
        }
        let mut status = self.inner.status.lock().unwrap();
        status.model = None;
        status.threads = 0;
        let next = transition(status.phase, MnnEvent::Unload);
        status.apply(next);
        Ok(())
    }

    #[cfg(feature = "local-mnn")]
    fn set_phase(&self, event: MnnEvent) {
        let mut status = self.inner.status.lock().unwrap();
        let next = transition(status.phase, event);
        status.apply(next);
    }

    #[cfg(feature = "local-mnn")]
    fn worker(&self) -> Result<worker::MnnWorker, MnnError> {
        let mut guard = self.inner.worker.lock().unwrap();
        if guard.is_none() {
            *guard = Some(worker::MnnWorker::spawn()?);
        }
        Ok(guard.as_ref().expect("worker just created").clone())
    }
}

/// MNN 适配器：对外只暴露统一 trait，业务层不接触原生句柄或 worker。
impl InferenceEngine for LocalMnnState {
    fn kind(&self) -> EngineKind {
        EngineKind::Mnn
    }

    fn load(&self, model: &ModelAsset, options: &LoadOptions) -> Result<(), EngineError> {
        if matches!(model, ModelAsset::SingleFile { .. }) {
            return Err(EngineError::invalid("MNN 需要多文件 bundle 目录"));
        }
        let name = model.display_name();
        if name.trim().is_empty() {
            return Err(EngineError::ModelNotFound {
                model: String::new(),
            });
        }
        self.load(&name, options.threads)
    }

    fn generate(
        &self,
        input: EngineInput,
        params: &GenerateParams,
        cancel: &Arc<AtomicBool>,
        sink: Box<dyn FnMut(&str) + Send>,
    ) -> Result<EngineMetrics, EngineError> {
        let prompt = match input {
            EngineInput::Prompt(prompt) => prompt,
            EngineInput::Turns(_) => {
                return Err(EngineError::invalid("MNN 只接受预渲染的 prompt"))
            }
        };
        self.generate_stream(&prompt, params.max_tokens, cancel.clone(), sink)
    }

    fn cancel(&self) -> bool {
        LocalMnnState::cancel(self)
    }

    fn unload(&self) -> Result<(), EngineError> {
        LocalMnnState::unload(self)
    }

    fn metrics(&self) -> Option<EngineMetrics> {
        self.inner.last_metrics.lock().unwrap().clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    fn scratch_dir(label: &str) -> PathBuf {
        static COUNTER: AtomicU32 = AtomicU32::new(0);
        let id = COUNTER.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!(
            "notes-mnn-test-{}-{label}-{id}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).expect("create scratch dir");
        dir
    }

    fn write_bundle(dir: &Path, with_weights: bool) {
        std::fs::write(dir.join("config.json"), "{}").expect("write config");
        if with_weights {
            std::fs::write(dir.join("llm.mnn"), "weights").expect("write weights");
            std::fs::write(dir.join("tokenizer.mtok"), "tok").expect("write tokenizer");
        }
    }

    #[test]
    fn bundle_name_rules() {
        for good in ["qwen-0.6b", "Qwen_1.7B.q4", "mnn"] {
            assert!(is_valid_bundle_name(good), "{good} should be accepted");
        }
        for bad in ["", "   ", ".hidden", "../escape", "a/b", "a\\b", "т"] {
            assert!(!is_valid_bundle_name(bad), "{bad:?} should be rejected");
        }
        assert!(!is_valid_bundle_name(&"a".repeat(121)));
    }

    #[test]
    fn validate_bundle_requires_config_and_weights() {
        let root = scratch_dir("validate");
        let empty = root.join("empty");
        std::fs::create_dir_all(&empty).unwrap();
        assert!(matches!(
            validate_bundle("empty", &empty),
            Err(MnnError::InvalidArgument { .. })
        ));

        let no_weights = root.join("no-weights");
        std::fs::create_dir_all(&no_weights).unwrap();
        write_bundle(&no_weights, false);
        assert!(matches!(
            validate_bundle("no-weights", &no_weights),
            Err(MnnError::InvalidArgument { .. })
        ));

        let valid = root.join("valid");
        std::fs::create_dir_all(&valid).unwrap();
        write_bundle(&valid, true);
        let info = validate_bundle("valid", &valid).expect("valid bundle");
        assert_eq!(info.files, 3);
        assert!(info.bytes > 0);

        assert!(matches!(
            validate_bundle("../etc", &valid),
            Err(MnnError::InvalidArgument { .. })
        ));
        assert!(matches!(
            validate_bundle("missing", &root.join("missing")),
            Err(MnnError::ModelNotFound { .. })
        ));
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn list_bundles_skips_invalid_directories() {
        let root = scratch_dir("list");
        for name in ["good", ".hidden", "no-config"] {
            std::fs::create_dir_all(root.join(name)).unwrap();
        }
        write_bundle(&root.join("good"), true);
        write_bundle(&root.join(".hidden"), true);
        std::fs::write(root.join("no-config/llm.mnn"), "weights").unwrap();
        std::fs::write(root.join("loose-file.mnn"), "x").unwrap();

        let models = list_bundles(&root);
        assert_eq!(models.len(), 1, "only the valid bundle should be listed");
        assert_eq!(models[0].name, "good");
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn resolve_bundle_rejects_escapes_and_accepts_valid_bundle() {
        let root = scratch_dir("resolve");
        std::fs::create_dir_all(root.join("good")).unwrap();
        write_bundle(&root.join("good"), true);
        let state = LocalMnnState::new(root.clone());

        let resolved = state.resolve_bundle("good").expect("valid bundle resolves");
        assert!(resolved.ends_with("good"));
        assert!(matches!(
            state.resolve_bundle("../escape"),
            Err(MnnError::InvalidArgument { .. })
        ));
        assert!(matches!(
            state.resolve_bundle("absent"),
            Err(MnnError::ModelNotFound { .. })
        ));
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn step_decision_caps_and_priorities() {
        assert_eq!(step_decision(0, 4, false, false), None);
        assert_eq!(step_decision(3, 4, false, false), None);
        assert_eq!(
            step_decision(4, 4, false, false),
            Some(MnnStopReason::Length)
        );
        assert_eq!(
            step_decision(0, 4, false, true),
            Some(MnnStopReason::Stop)
        );
        assert_eq!(
            step_decision(0, 4, true, false),
            Some(MnnStopReason::Cancel)
        );
        // Cancel wins over a stop that happened in the same iteration.
        assert_eq!(
            step_decision(0, 4, true, true),
            Some(MnnStopReason::Cancel)
        );
        assert_eq!(step_decision(0, 0, false, false), Some(MnnStopReason::Length));
    }

    #[test]
    fn phase_machine_transitions() {
        use MnnEvent::*;
        use MnnPhase::*;
        assert_eq!(transition(Unloaded, LoadStart), Loading);
        assert_eq!(transition(Loading, LoadSucceeded), Ready);
        assert_eq!(transition(Loading, LoadFailed), Failed);
        assert_eq!(transition(Failed, LoadStart), Loading);
        assert_eq!(transition(Ready, GenerateStart), Generating);
        assert_eq!(transition(Generating, GenerateDone), Ready);
        assert_eq!(transition(Generating, Unload), Unloaded);
        // Illegal events keep the current phase; entry points guard them.
        assert_eq!(transition(Unloaded, GenerateStart), Unloaded);
        assert_eq!(transition(Generating, LoadStart), Generating);
        assert!(Ready.is_loaded() && Generating.is_loaded());
        assert!(!Unloaded.is_loaded() && !Loading.is_loaded() && !Failed.is_loaded());
    }

    #[test]
    fn status_without_feature_is_unavailable() {
        let state = LocalMnnState::new(scratch_dir("status"));
        let status = state.status();
        assert_eq!(status.available, cfg!(feature = "local-mnn"));
        assert_eq!(status.phase, MnnPhase::Unloaded);
        assert!(!status.loaded);
        assert_eq!(
            state
                .generate_stream("hi", 4, Arc::new(AtomicBool::new(false)), |_| {})
                .unwrap_err()
                .to_string(),
            if cfg!(feature = "local-mnn") {
                "本地模型尚未加载".to_string()
            } else {
                "当前构建未启用 MNN 本地模型（编译时未包含 local-mnn）".to_string()
            }
        );
    }
}
