//! 媒体命令：作业提交/查询/取消与资产元数据。
//!
//! 作业只落库，具体厂商执行由后续 worker 接入；与 Agent 会话命令互不影响。

use std::sync::atomic::Ordering;

use base64::Engine;
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::{AppHandle, State};

use crate::agent::AgentState;
use crate::media::{assets, exec, jobs, MediaState};
use crate::privacy::{egress, policy};
use crate::vfs::error::ToolError;
use crate::vfs::VfsState;

#[tauri::command]
pub fn media_job_submit(
    app: AppHandle,
    vfs_state: State<'_, VfsState>,
    media: State<'_, MediaState>,
    agent: State<'_, AgentState>,
    input: jobs::NewJob,
    on_event: Channel<jobs::JobEvent>,
) -> Result<jobs::Job, ToolError> {
    let job = {
        let vfs = crate::lock(&vfs_state.0);
        // Media payloads carry note text/prompts to the vendor; run the same
        // egress gate as chat so S0/S1 content cannot leave un-judged.
        let snapshot = policy::Snapshot::load(vfs.conn(), &agent.secrets)?;
        let decision = egress::guard_text(&jobs::egress_text(&input.params), &snapshot);
        if let Err(e) = egress::record_audit(vfs.conn(), &input.model_entry, "media", &decision) {
            log::warn!("egress audit failed: {e}");
        }
        if decision.blocked() {
            let message = decision
                .message
                .unwrap_or_else(|| "隐私拦截：媒体请求包含敏感内容".to_string());
            return Err(ToolError::invalid(message));
        }
        jobs::submit(vfs.conn(), input)?
    };
    media.register_cancel(job.id);
    // Push status/progress through the channel instead of UI polling.
    media.watch(job.id, on_event);
    // Run outside this command so the UI gets the queue id immediately.
    let job_id = job.id;
    tauri::async_runtime::spawn(async move {
        exec::run(app, job_id).await;
    });
    Ok(job)
}

#[tauri::command]
pub fn media_job_list(
    vfs_state: State<'_, VfsState>,
    limit: Option<i64>,
) -> Result<Vec<jobs::Job>, ToolError> {
    let vfs = crate::lock(&vfs_state.0);
    jobs::list(vfs.conn(), limit.unwrap_or(50))
}

#[tauri::command]
pub fn media_job_get(vfs_state: State<'_, VfsState>, id: i64) -> Result<jobs::Job, ToolError> {
    let vfs = crate::lock(&vfs_state.0);
    jobs::get(vfs.conn(), id)
}

#[tauri::command]
pub fn media_job_cancel(
    vfs_state: State<'_, VfsState>,
    media: State<'_, MediaState>,
    id: i64,
) -> Result<jobs::Job, ToolError> {
    // Signal the runner first, then persist the terminal state.
    media.cancel_flag(id).store(true, Ordering::SeqCst);
    let job = {
        let vfs = crate::lock(&vfs_state.0);
        jobs::cancel(vfs.conn(), id)?
    };
    media.emit(id, jobs::JobEvent::from(&job));
    media.release(id);
    Ok(job)
}

#[tauri::command]
pub fn media_asset_get(vfs_state: State<'_, VfsState>, id: i64) -> Result<assets::Asset, ToolError> {
    let vfs = crate::lock(&vfs_state.0);
    assets::get(vfs.conn(), id)
}

#[tauri::command]
pub fn media_asset_path(
    vfs_state: State<'_, VfsState>,
    media: State<'_, MediaState>,
    id: i64,
) -> Result<String, ToolError> {
    let vfs = crate::lock(&vfs_state.0);
    let asset = assets::get(vfs.conn(), id)?;
    Ok(assets::path(&media.root, &asset).to_string_lossy().into_owned())
}

/// Base64 payload for one asset; used to rebuild image context after reload.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetData {
    pub mime: String,
    pub data: String,
}

#[tauri::command]
pub fn media_asset_data(
    vfs_state: State<'_, VfsState>,
    media: State<'_, MediaState>,
    id: i64,
) -> Result<AssetData, ToolError> {
    let (asset, path) = {
        let vfs = crate::lock(&vfs_state.0);
        let asset = assets::get(vfs.conn(), id)?;
        let path = assets::path(&media.root, &asset);
        (asset, path)
    };
    let bytes = std::fs::read(&path).map_err(|e| ToolError::Storage {
        message: format!("读取资产失败：{e}"),
    })?;
    Ok(AssetData {
        mime: asset.mime,
        data: base64::engine::general_purpose::STANDARD.encode(&bytes),
    })
}

/// Remove media assets no longer referenced by notes, messages or recent jobs.
#[tauri::command]
pub fn media_asset_gc(
    vfs_state: State<'_, VfsState>,
    media: State<'_, MediaState>,
    retention_days: Option<i64>,
) -> Result<assets::GcReport, ToolError> {
    let vfs = crate::lock(&vfs_state.0);
    assets::gc(vfs.conn(), &media.root, retention_days.unwrap_or(30))
}

/// Import a WebView-supplied audio payload into the asset library.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetStoreInput {
    pub mime: String,
    /// Base64 bytes; the caller must keep the payload within the audio limit.
    pub data: String,
}

#[tauri::command]
pub fn media_asset_store(
    vfs_state: State<'_, VfsState>,
    media: State<'_, MediaState>,
    input: AssetStoreInput,
) -> Result<assets::Asset, ToolError> {
    // Cheap pre-check on the encoded length so an oversized payload cannot be
    // materialised in memory before the asset-size limit is applied.
    let max_encoded = assets::MAX_ASSET_BYTES.saturating_mul(4) / 3 + 4;
    if input.data.len() > max_encoded {
        return Err(ToolError::invalid("音频数据超出大小上限"));
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(input.data.as_bytes())
        .map_err(|e| ToolError::invalid(format!("音频数据不是合法 base64：{e}")))?;
    let vfs = crate::lock(&vfs_state.0);
    assets::store(
        vfs.conn(),
        &media.root,
        &bytes,
        &input.mime,
        assets::AssetMeta::default(),
    )
}
