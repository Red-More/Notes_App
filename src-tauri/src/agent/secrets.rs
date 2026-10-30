//! API Key 的存储后端（M2-4b）。
//!
//! - **Android**：`android-native-keyring-store` 把密钥写进 SharedPreferences，
//!   加密密钥由 Android Keystore 生成且不可导出；JNI 线程附着由该 crate 处理。
//!   Tauri 的 tao 运行时已初始化 `ndk-context`，无需额外的 Kotlin 胶水。
//! - **桌面 / 开发机**：应用私有文件（Unix 0600，临时文件 + rename）。
//!
//! 安全策略是 **fail-closed**：Android 上 Keystore 初始化失败时，读写直接报错，
//! 绝不回退到明文文件。旧版本的 `agent-secrets.json` 会在 Android 首次启动时
//! 导入 Keystore，成功后删除原文件；导入失败则保留文件并记录告警。

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
#[cfg(not(target_os = "android"))]
use std::sync::Mutex;

/// 凭据 store 内的 service 名，与 `provider` 组合成唯一条目。
#[cfg(target_os = "android")]
const SERVICE: &str = "lifeos-agent";

trait Backend: Send + Sync {
    fn get(&self, provider: &str) -> Result<Option<String>, String>;
    fn set(&self, provider: &str, key: &str) -> Result<(), String>;
    fn delete(&self, provider: &str) -> Result<(), String>;
}

pub struct SecretStore {
    backend: Box<dyn Backend>,
}

impl SecretStore {
    pub fn new(path: PathBuf) -> Self {
        #[cfg(target_os = "android")]
        {
            let backend = AndroidBackend;
            migrate_legacy_file(&path, &backend);
            Self {
                backend: Box::new(backend),
            }
        }
        #[cfg(not(target_os = "android"))]
        {
            Self {
                backend: Box::new(FileBackend::new(path)),
            }
        }
    }

    pub fn get(&self, provider: &str) -> Result<Option<String>, String> {
        self.backend.get(provider)
    }

    /// 供设置页展示：只暴露是否存在，不返回内容；后端错误按未配置处理。
    pub fn has(&self, provider: &str) -> bool {
        match self.backend.get(provider) {
            Ok(value) => value.is_some_and(|k| !k.trim().is_empty()),
            Err(e) => {
                log::warn!("secret backend unavailable: {e}");
                false
            }
        }
    }

    pub fn set(&self, provider: &str, key: &str) -> Result<(), String> {
        self.backend.set(provider, key)
    }

    pub fn delete(&self, provider: &str) -> Result<(), String> {
        self.backend.delete(provider)
    }
}

// ---------------------------------------------------------------------------
// 桌面：应用私有文件（0600）
// ---------------------------------------------------------------------------

#[cfg(not(target_os = "android"))]
struct FileBackend {
    path: PathBuf,
    cache: Mutex<BTreeMap<String, String>>,
}

#[cfg(not(target_os = "android"))]
impl FileBackend {
    fn new(path: PathBuf) -> Self {
        let cache = match read_map(&path) {
            Ok(map) => map,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => BTreeMap::new(),
            Err(e) => {
                log::warn!("agent secret file unreadable: {e}");
                BTreeMap::new()
            }
        };
        Self {
            path,
            cache: Mutex::new(cache),
        }
    }
}

#[cfg(not(target_os = "android"))]
impl Backend for FileBackend {
    fn get(&self, provider: &str) -> Result<Option<String>, String> {
        let map = self.cache.lock().map_err(|e| e.to_string())?;
        Ok(map.get(provider).cloned())
    }

    fn set(&self, provider: &str, key: &str) -> Result<(), String> {
        let mut map = self.cache.lock().map_err(|e| e.to_string())?;
        // 先构造新状态并落盘，成功后才更新缓存，失败时内存与磁盘保持一致。
        let mut next = map.clone();
        if key.trim().is_empty() {
            next.remove(provider);
        } else {
            next.insert(provider.to_string(), key.trim().to_string());
        }
        persist(&self.path, &next).map_err(|e| format!("密钥写入失败：{e}"))?;
        *map = next;
        Ok(())
    }

    fn delete(&self, provider: &str) -> Result<(), String> {
        let mut map = self.cache.lock().map_err(|e| e.to_string())?;
        let mut next = map.clone();
        next.remove(provider);
        persist(&self.path, &next).map_err(|e| format!("密钥删除失败：{e}"))?;
        *map = next;
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Android：Android Keystore（不可导出密钥 + SharedPreferences 密文）
// ---------------------------------------------------------------------------

#[cfg(target_os = "android")]
struct AndroidBackend;

#[cfg(target_os = "android")]
impl AndroidBackend {
    fn entry(provider: &str) -> Result<keyring_core::Entry, String> {
        use keyring_core::api::CredentialStoreApi;
        let store = android_native_keyring_store::Store::new()
            .map_err(|e| format!("Android Keystore 初始化失败：{e}"))?;
        store
            .build(SERVICE, provider, None)
            .map_err(|e| format!("Android Keystore 条目创建失败：{e}"))
    }
}

#[cfg(target_os = "android")]
impl Backend for AndroidBackend {
    fn get(&self, provider: &str) -> Result<Option<String>, String> {
        let entry = Self::entry(provider)?;
        match entry.get_password() {
            Ok(secret) => Ok(Some(secret)),
            Err(keyring_core::Error::NoEntry) => Ok(None),
            Err(e) => Err(format!("Android Keystore 读取失败：{e}")),
        }
    }

    fn set(&self, provider: &str, key: &str) -> Result<(), String> {
        let entry = Self::entry(provider)?;
        entry
            .set_password(key.trim())
            .map_err(|e| format!("Android Keystore 写入失败：{e}"))
    }

    fn delete(&self, provider: &str) -> Result<(), String> {
        let entry = Self::entry(provider)?;
        match entry.delete_credential() {
            Ok(()) | Err(keyring_core::Error::NoEntry) => Ok(()),
            Err(e) => Err(format!("Android Keystore 删除失败：{e}")),
        }
    }
}

/// 把旧版明文文件导入 Keystore，成功后删除；失败则保留并记录告警。
#[cfg(target_os = "android")]
fn migrate_legacy_file(path: &Path, backend: &AndroidBackend) {
    let map = match read_map(path) {
        Ok(map) => map,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return,
        Err(e) => {
            log::warn!("legacy agent secret file unreadable: {e}");
            return;
        }
    };
    let mut all_ok = true;
    for (provider, key) in &map {
        if let Err(e) = backend.set(provider, key) {
            log::warn!("legacy secret migration failed for {provider}: {e}");
            all_ok = false;
        }
    }
    if all_ok {
        match std::fs::remove_file(path) {
            Ok(()) => log::info!("legacy agent secret file migrated to Android Keystore"),
            Err(e) => log::warn!("legacy agent secret file could not be removed: {e}"),
        }
    }
}

// ---------------------------------------------------------------------------
// 共享文件工具（桌面后端与 Android 迁移都用）
// ---------------------------------------------------------------------------

fn read_map(path: &Path) -> std::io::Result<BTreeMap<String, String>> {
    let raw = std::fs::read_to_string(path)?;
    serde_json::from_str::<BTreeMap<String, String>>(&raw)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))
}

#[cfg(not(target_os = "android"))]
fn persist(path: &Path, map: &BTreeMap<String, String>) -> std::io::Result<()> {
    use std::io::Write;

    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("tmp");
    let body = serde_json::to_string(map)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    {
        let mut file = std::fs::File::create(&tmp)?;
        // Unix/Android：先收紧权限再写入，避免短暂的可读窗口。
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            file.set_permissions(std::fs::Permissions::from_mode(0o600))?;
        }
        file.write_all(body.as_bytes())?;
        file.sync_all()?;
    }
    std::fs::rename(&tmp, path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}
