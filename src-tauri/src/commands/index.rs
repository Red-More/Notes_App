//! 交叉索引查询命令。

use tauri::State;

use crate::docs::index;
use crate::docs::types::DocRef;
use crate::vfs::error::ToolError;
use crate::vfs::{fts, VfsState};

/// 按维度聚合文档：person / date / time / location / tag / type / due。
#[tauri::command]
pub fn index_query(
    state: State<'_, VfsState>,
    dimension: String,
    value: String,
    kind: Option<String>,
    limit: Option<usize>,
) -> Result<Vec<DocRef>, ToolError> {
    let vfs = state.0.lock().unwrap();
    index::query(&vfs, &dimension, &value, kind.as_deref(), limit)
}

/// 手动重建 FTS 检索索引（启动自愈之外的人工入口），返回重建的文档数。
#[tauri::command]
pub fn search_reindex(state: State<'_, VfsState>) -> Result<usize, ToolError> {
    let vfs = state.0.lock().unwrap();
    Ok(fts::rebuild_all(vfs.conn())?)
}
