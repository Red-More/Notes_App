//! 文档版本命令：blobs rev 的台账视图。

use tauri::State;

use crate::docs::types::{Doc, DocVersion};
use crate::docs::versions;
use crate::vfs::error::ToolError;
use crate::vfs::VfsState;

#[tauri::command]
pub fn version_list(
    state: State<'_, VfsState>,
    doc_id: i64,
    include_auto: Option<bool>,
) -> Result<Vec<DocVersion>, ToolError> {
    let vfs = crate::lock(&state.0);
    versions::list(&vfs, doc_id, include_auto.unwrap_or(false))
}

#[tauri::command]
pub fn version_content(state: State<'_, VfsState>, version_id: i64) -> Result<String, ToolError> {
    let vfs = crate::lock(&state.0);
    versions::content(&vfs, version_id)
}

#[tauri::command]
pub fn version_create(state: State<'_, VfsState>, doc_id: i64) -> Result<DocVersion, ToolError> {
    let mut vfs = crate::lock(&state.0);
    versions::create(&mut vfs, doc_id)
}

#[tauri::command]
pub fn version_restore(state: State<'_, VfsState>, version_id: i64) -> Result<Doc, ToolError> {
    let mut vfs = crate::lock(&state.0);
    versions::restore(&mut vfs, version_id)
}

#[tauri::command]
pub fn version_delete(state: State<'_, VfsState>, version_id: i64) -> Result<(), ToolError> {
    let mut vfs = crate::lock(&state.0);
    versions::delete(&mut vfs, version_id)
}
