//! Agent 运行时所需的 Rust 侧状态与协议。
//!
//! 边界：
//! - LLM 请求只从 Rust 发起；WebView 通过自研 `streamFn` 走 `agent_stream` 桥接。
//! - `agent_stream` 只接受模型条目 id，不接受任意 URL / base_url / api_key。
//! - API Key 存在 Keystore（Android）或 0600 私有文件（桌面），不进 SQLite、不进 JS、不进日志。
//! - 会话与消息落 `life.db`；模型可见工具为 5 个 `fs_*` + 1 个技能元工具 `load_skill`。

pub mod conversations;
pub mod discovery;
pub mod llm;
pub mod local;
pub mod model_store;
pub mod params;
pub mod secrets;

use std::collections::HashMap;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// 模型可见的工具白名单，Rust 侧二次校验。
/// 5 个 `fs_*` 之外只额外允许技能元工具 `load_skill`（不触达真实文件系统）。
pub const TOOL_ALLOWLIST: [&str; 6] = [
    "fs_read",
    "fs_write",
    "fs_edit",
    "fs_glob",
    "fs_grep",
    "load_skill",
];

/// Tauri 管理的 Agent 状态：HTTP 客户端、密钥文件、取消标记与本地运行时。
pub struct AgentState {
    pub secrets: secrets::SecretStore,
    /// 每个流式请求一个取消标记；`agent_cancel` 置位。
    pub cancels: Mutex<HashMap<String, Arc<AtomicBool>>>,
    /// 仅 HTTPS + 禁重定向 + 读超时的客户端；初始化失败时为 None，请求会报错而不是降级。
    pub client: Option<reqwest::Client>,
    /// 内嵌 llama.cpp 运行时；未启用 feature 时状态为 `unsupported`。
    pub local: local::runtime::Runtime,
}

impl AgentState {
    pub fn new(secret_path: std::path::PathBuf, models_dir: std::path::PathBuf) -> Self {
        let client = match reqwest::Client::builder()
            .https_only(true)
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(10))
            // 读超时兜底：厂商长时间不吐数据时取消仍能生效，避免命令永久挂起。
            .read_timeout(Duration::from_secs(120))
            .build()
        {
            Ok(client) => Some(client),
            Err(e) => {
                // 保持 fail-closed：宁可不发请求，也不换用丢失安全策略的裸 Client。
                log::error!("agent http client init failed: {e}");
                None
            }
        };
        Self {
            secrets: secrets::SecretStore::new(secret_path),
            cancels: Mutex::new(HashMap::new()),
            client,
            local: local::runtime::Runtime::new(models_dir),
        }
    }

    /// 注册取消标记；同一 requestId 重复调用会覆盖旧标记。
    pub fn register_cancel(&self, request_id: &str) -> Arc<AtomicBool> {
        let flag = Arc::new(AtomicBool::new(false));
        if let Ok(mut map) = self.cancels.lock() {
            map.insert(request_id.to_string(), flag.clone());
        }
        flag
    }

    pub fn clear_cancel(&self, request_id: &str) {
        if let Ok(mut map) = self.cancels.lock() {
            map.remove(request_id);
        }
    }

    pub fn cancel(&self, request_id: &str) {
        if let Ok(map) = self.cancels.lock() {
            if let Some(flag) = map.get(request_id) {
                flag.store(true, std::sync::atomic::Ordering::SeqCst);
            }
        }
    }
}
