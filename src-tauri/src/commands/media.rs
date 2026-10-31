//! 媒体命令：作业提交/查询/取消与资产元数据。
//!
//! 作业只落库，具体厂商执行由后续 worker 接入；与 Agent 会话命令互不影响。

use std::sync::atomic::Ordering;

use tauri::{AppHandle, State};

use crate::media::{assets, exec, jobs, MediaState};
use crate::vfs::error::ToolError;
use crate::vfs::VfsState;

#[tauri::command]
pub fn media_job_submit(
    app: AppHandle,
    vfs_state: State<'_, VfsState>,
    media: State<'_, MediaState>,
    input: jobs::NewJob,
) -> Result<jobs::Job, ToolError> {
    let job = {
        let vfs = vfs_state.0.lock().unwrap();
        jobs::submit(vfs.conn(), input)?
    };
    media.register_cancel(job.id);
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
    let vfs = vfs_state.0.lock().unwrap();
    jobs::list(vfs.conn(), limit.unwrap_or(50))
}

#[tauri::command]
pub fn media_job_get(vfs_state: State<'_, VfsState>, id: i64) -> Result<jobs::Job, ToolError> {
    let vfs = vfs_state.0.lock().unwrap();
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
    let vfs = vfs_state.0.lock().unwrap();
    let result = jobs::cancel(vfs.conn(), id);
    if result.is_err() {
        media.release(id);
    }
    Ok(result?)
}

#[tauri::command]
pub fn media_asset_get(vfs_state: State<'_, VfsState>, id: i64) -> Result<assets::Asset, ToolError> {
    let vfs = vfs_state.0.lock().unwrap();
    assets::get(vfs.conn(), id)
}

#[tauri::command]
pub fn media_asset_path(
    vfs_state: State<'_, VfsState>,
    media: State<'_, MediaState>,
    id: i64,
) -> Result<String, ToolError> {
    let vfs = vfs_state.0.lock().unwrap();
    let asset = assets::get(vfs.conn(), id)?;
    Ok(assets::path(&media.root, &asset).to_string_lossy().into_owned())
}
