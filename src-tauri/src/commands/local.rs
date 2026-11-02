//! 本地模型命令（阶段 B）：状态、配置、导入、加载/卸载与激活。
//!
//! 边界：
//! - WebView 只传模型目录内的文件名；导入路径需由系统文件选择器返回。
//! - 加载/推理都在 `spawn_blocking` 上执行，Tauri 异步线程不会被解码阻塞。
//! - 手动关闭与后台暂停都会释放权重；“允许后台常驻”是显式选项。

use std::io::Read;
use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::State;

use crate::agent::local::gating::{self, DeviceProfile, GateDecision, PowerSnapshot};
use crate::agent::local::runtime::{self, LocalConfig};
use crate::agent::local::{LocalModelFile, LocalStatus};
use crate::agent::model_store::{self, ApiFormat, ModelInput, ModelKind};
use crate::agent::AgentState;
use crate::vfs::error::ToolError;
use crate::vfs::VfsState;

/// 本地对话条目的固定 id，避免每次激活产生新的条目。
const LOCAL_ENTRY_ID: &str = "local_llama";
const COPY_BUFFER: usize = 1024 * 1024;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalSnapshot {
    pub supported: bool,
    pub status: LocalStatus,
    pub config: LocalConfig,
    pub files: Vec<LocalModelFile>,
    pub device: DeviceProfile,
    pub power: PowerSnapshot,
    /// `allow` 或暂停原因。
    pub gate: String,
}

#[tauri::command]
pub fn local_model_status(agent_state: State<'_, AgentState>) -> Result<LocalSnapshot, ToolError> {
    let device = gating::device_profile();
    let (power, decision) = agent_state.local.gate_snapshot();
    let gate = match decision {
        GateDecision::Allow => "allow".to_string(),
        GateDecision::Suspend { reason, .. } => reason,
    };
    let files = runtime::list_files(agent_state.local.models_dir(), device.max_model_mb);
    Ok(LocalSnapshot {
        supported: agent_state.local.supported(),
        status: agent_state.local.status(),
        config: agent_state.local.config(),
        files,
        device,
        power,
        gate,
    })
}

/// 只保存偏好；是否加载由 `local_model_load` 或前台恢复触发。
#[tauri::command]
pub fn local_model_config_set(
    vfs_state: State<'_, VfsState>,
    agent_state: State<'_, AgentState>,
    config: LocalConfig,
) -> Result<LocalConfig, ToolError> {
    let saved = {
        let vfs = vfs_state.0.lock().unwrap();
        runtime::save_config(vfs.conn(), &config)?
    };
    agent_state.local.set_config(saved.clone());
    if !saved.enabled {
        // Manual off must release memory immediately.
        agent_state.local.unload();
    }
    Ok(saved)
}

#[tauri::command]
pub async fn local_model_load(
    vfs_state: State<'_, VfsState>,
    agent_state: State<'_, AgentState>,
    config: Option<LocalConfig>,
) -> Result<(), ToolError> {
    let config = match config {
        Some(config) => {
            let saved = {
                let vfs = vfs_state.0.lock().unwrap();
                runtime::save_config(vfs.conn(), &config)?
            };
            if !saved.file.is_empty() {
                // Keep the active local entry in step with the loaded file.
                let vfs = vfs_state.0.lock().unwrap();
                sync_local_entry(vfs.conn(), &saved.file)?;
            }
            agent_state.local.set_config(saved.clone());
            saved
        }
        None => agent_state.local.config(),
    };
    let runtime = agent_state.local.clone();
    tauri::async_runtime::spawn_blocking(move || runtime.load_blocking(config))
        .await
        .map_err(|e| ToolError::Storage {
            message: format!("本地模型线程异常：{e}"),
        })?
}

#[tauri::command]
pub async fn local_model_unload(agent_state: State<'_, AgentState>) -> Result<(), ToolError> {
    let runtime = agent_state.local.clone();
    tauri::async_runtime::spawn_blocking(move || runtime.unload())
        .await
        .map_err(|e| ToolError::Storage {
            message: format!("本地模型线程异常：{e}"),
        })
}

/// 应用进入后台：默认释放内存；“允许后台常驻”开启时保持加载。
#[tauri::command]
pub async fn local_model_pause(agent_state: State<'_, AgentState>) -> Result<(), ToolError> {
    if agent_state.local.config().keep_alive {
        return Ok(());
    }
    let runtime = agent_state.local.clone();
    tauri::async_runtime::spawn_blocking(move || runtime.suspend("应用进入后台"))
        .await
        .map_err(|e| ToolError::Storage {
            message: format!("本地模型线程异常：{e}"),
        })
}

/// 应用回到前台：仅在用户启用且已选择模型时异步加载，不阻塞首屏。
#[tauri::command]
pub async fn local_model_resume(agent_state: State<'_, AgentState>) -> Result<(), ToolError> {
    let config = agent_state.local.config();
    if !config.enabled || config.file.trim().is_empty() {
        return Ok(());
    }
    if matches!(
        agent_state.local.status().state,
        crate::agent::local::LocalState::Ready | crate::agent::local::LocalState::Generating
    ) {
        return Ok(());
    }
    let runtime = agent_state.local.clone();
    tauri::async_runtime::spawn_blocking(move || runtime.load_blocking(config))
        .await
        .map_err(|e| ToolError::Storage {
            message: format!("本地模型线程异常：{e}"),
        })?
}

/// 从系统文件选择器返回的路径复制到模型目录；同名文件不覆盖。
#[tauri::command]
pub async fn local_model_import(
    agent_state: State<'_, AgentState>,
    path: String,
) -> Result<LocalModelFile, ToolError> {
    let source = PathBuf::from(path.trim());
    if !source.is_file() {
        return Err(ToolError::invalid("请选择一个存在的 GGUF 文件"));
    }
    let name = source
        .file_name()
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_default();
    if !runtime::is_valid_file_name(&name) {
        return Err(ToolError::invalid(
            "模型文件名需为 ASCII 且以 .gguf 结尾，不能包含路径分隔符",
        ));
    }
    let bytes = std::fs::metadata(&source)
        .map_err(|e| ToolError::Storage {
            message: format!("读取模型信息失败：{e}"),
        })?
        .len();
    if bytes == 0 || bytes > runtime::MAX_MODEL_BYTES {
        return Err(ToolError::invalid("模型文件为空或超过 3GB 上限"));
    }
    let dest = agent_state.local.models_dir().join(&name);
    if dest.exists() {
        return Err(ToolError::invalid(format!("同名模型已存在：{name}")));
    }
    let target = dest.clone();
    tauri::async_runtime::spawn_blocking(move || copy_model(&source, &target))
        .await
        .map_err(|e| ToolError::Storage {
            message: format!("导入线程异常：{e}"),
        })??;
    let device = gating::device_profile();
    Ok(LocalModelFile {
        recommended: device.max_model_mb > 0
            && bytes <= device.max_model_mb.saturating_mul(1024 * 1024),
        name,
        bytes,
    })
}

#[tauri::command]
pub fn local_model_remove(
    agent_state: State<'_, AgentState>,
    file: String,
) -> Result<(), ToolError> {
    let name = file.trim();
    if !runtime::is_valid_file_name(name) {
        return Err(ToolError::invalid("模型文件名非法"));
    }
    if agent_state.local.status().model.as_deref() == Some(name) {
        return Err(ToolError::invalid("该模型正在使用，请先卸载"));
    }
    let path = agent_state.local.models_dir().join(name);
    std::fs::remove_file(&path).map_err(|e| ToolError::Storage {
        message: format!("删除模型失败：{e}"),
    })
}

/// 把所选文件设为当前对话模型：写入稳定条目、持久化配置并异步加载。
#[tauri::command]
pub async fn local_model_activate(
    vfs_state: State<'_, VfsState>,
    agent_state: State<'_, AgentState>,
    file: String,
) -> Result<(), ToolError> {
    let name = file.trim();
    if !runtime::is_valid_file_name(name) {
        return Err(ToolError::invalid("模型文件名非法"));
    }
    if !agent_state.local.models_dir().join(name).is_file() {
        return Err(ToolError::invalid(format!("模型文件不存在：{name}")));
    }
    let stem: String = model_stem(name).chars().take(100).collect();
    if stem.is_empty() {
        return Err(ToolError::invalid("模型文件名缺少名称"));
    }
    let label: String = format!("本地模型 · {stem}").chars().take(64).collect();
    let entry = {
        let vfs = vfs_state.0.lock().unwrap();
        let entry = model_store::save(
            vfs.conn(),
            ModelInput {
                id: LOCAL_ENTRY_ID.to_string(),
                label,
                format: ApiFormat::LocalLlama,
                base_url: name.to_string(),
                model_id: stem,
                full_url: false,
                kind: ModelKind::Chat,
            },
        )?;
        model_store::set_active(vfs.conn(), &entry.id)?;
        entry
    };
    let mut config = agent_state.local.config();
    config.file = name.to_string();
    config.enabled = true;
    let saved = {
        let vfs = vfs_state.0.lock().unwrap();
        runtime::save_config(vfs.conn(), &config)?
    };
    agent_state.local.set_config(saved.clone());
    let runtime = agent_state.local.clone();
    let result = tauri::async_runtime::spawn_blocking(move || runtime.load_blocking(saved))
        .await
        .map_err(|e| ToolError::Storage {
            message: format!("本地模型线程异常：{e}"),
        })?;
    log::info!("local model entry activated: {}", entry.id);
    result
}

/// Keep the stable local entry pointing at the file that is actually loaded.
fn sync_local_entry(conn: &rusqlite::Connection, file: &str) -> Result<(), ToolError> {
    let Some(existing) = model_store::configs(conn)?
        .into_iter()
        .find(|entry| entry.id == LOCAL_ENTRY_ID)
    else {
        return Ok(());
    };
    let stem: String = model_stem(file).chars().take(100).collect();
    if stem.is_empty() {
        return Ok(());
    }
    model_store::save(
        conn,
        ModelInput {
            id: existing.id,
            label: existing.label,
            format: ApiFormat::LocalLlama,
            base_url: file.to_string(),
            model_id: stem,
            full_url: false,
            kind: ModelKind::Chat,
        },
    )?;
    Ok(())
}

fn copy_model(source: &Path, dest: &Path) -> Result<(), ToolError> {
    let part = dest.with_extension("gguf.part");
    let outcome = (|| -> std::io::Result<()> {
        let mut input = std::fs::File::open(source)?;
        let mut output = std::fs::File::create(&part)?;
        let mut buffer = vec![0u8; COPY_BUFFER];
        loop {
            let read = input.read(&mut buffer)?;
            if read == 0 {
                break;
            }
            std::io::Write::write_all(&mut output, &buffer[..read])?;
        }
        drop(output);
        std::fs::rename(&part, dest)
    })();
    if outcome.is_err() {
        let _ = std::fs::remove_file(&part);
    }
    outcome.map_err(|e| ToolError::Storage {
        message: format!("复制模型失败：{e}"),
    })
}

fn model_stem(name: &str) -> String {
    let lower = name.to_ascii_lowercase();
    match lower.rfind(".gguf") {
        Some(index) => name[..index].to_string(),
        None => name.to_string(),
    }
}
