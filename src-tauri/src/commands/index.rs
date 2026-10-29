//! 交叉索引查询命令。

use tauri::State;

use crate::docs::index;
use crate::docs::types::DocRef;
use crate::vfs::error::ToolError;
use crate::vfs::VfsState;

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
