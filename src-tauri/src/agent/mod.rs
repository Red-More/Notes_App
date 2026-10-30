//! Agent 运行时所需的 Rust 侧状态与协议。
//!
//! 边界：
//! - LLM 请求只从 Rust 发起；WebView 通过自研 `streamFn` 走 `agent_stream` 桥接。
//! - `agent_stream` 只接受 provider 枚举，不接受任意 URL / base_url / api_key。
//! - API Key 存在应用私有文件（0600），不进 SQLite、不进 JS、不进日志。
//! - 会话与消息落 `life.db`；模型可见的工具永远只有 5 个 `fs_*`。

pub mod conversations;
pub mod llm;
pub mod secrets;

use std::collections::HashMap;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// 支持的厂商。枚举之外的字符串一律拒绝，映射到固定 base URL。
/// `mock` 只在调试构建注册：release 包既不能选择，也不能被前端伪造调用。
#[cfg(debug_assertions)]
pub const PROVIDERS: &[&str] = &["openai", "anthropic", "google", "mock"];

#[cfg(not(debug_assertions))]
pub const PROVIDERS: &[&str] = &["openai", "anthropic", "google"];

/// 首次启动或配置损坏时的默认 provider。
#[cfg(debug_assertions)]
pub const DEFAULT_PROVIDER: &str = "mock";

#[cfg(not(debug_assertions))]
pub const DEFAULT_PROVIDER: &str = "openai";

/// 与默认 provider 配套的默认模型。
#[cfg(debug_assertions)]
pub const DEFAULT_MODEL: &str = "mock-fast";

#[cfg(not(debug_assertions))]
pub const DEFAULT_MODEL: &str = "gpt-4o-mini";

/// 模型可见的工具白名单，Rust 侧二次校验。
pub const TOOL_ALLOWLIST: [&str; 5] = ["fs_read", "fs_write", "fs_edit", "fs_glob", "fs_grep"];

/// Tauri 管理的 Agent 状态：HTTP 客户端、密钥文件、取消标记。
pub struct AgentState {
    pub secrets: secrets::SecretStore,
    /// 每个流式请求一个取消标记；`agent_cancel` 置位。
    pub cancels: Mutex<HashMap<String, Arc<AtomicBool>>>,
    /// 仅 HTTPS + 禁重定向 + 读超时的客户端；初始化失败时为 None，请求会报错而不是降级。
    pub client: Option<reqwest::Client>,
}

impl AgentState {
    pub fn new(secret_path: std::path::PathBuf) -> Self {
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

/// provider 是否在枚举内。
pub fn is_provider(value: &str) -> bool {
    PROVIDERS.contains(&value)
}
