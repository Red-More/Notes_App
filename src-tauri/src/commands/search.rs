//! 检索索引维护命令。

use tauri::State;

use crate::vfs::error::ToolError;
use crate::vfs::{fts, VfsState};

/// 手动重建 FTS 检索索引（启动自愈之外的人工入口），返回重建的文档数。
#[tauri::command]
pub fn search_reindex(state: State<'_, VfsState>) -> Result<usize, ToolError> {
    let vfs = crate::lock(&state.0);
    Ok(fts::rebuild_all(vfs.conn())?)
}
