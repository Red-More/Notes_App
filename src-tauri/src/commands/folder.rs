//! 文件夹命令：目录即文件夹，显示名存 dir_titles。

use tauri::State;

use crate::docs::folders;
use crate::docs::types::{Folder, FolderCrumb, FolderStats};
use crate::vfs::error::ToolError;
use crate::vfs::VfsState;

#[tauri::command]
pub fn folder_list(
    state: State<'_, VfsState>,
    parent_id: Option<i64>,
    root: Option<String>,
    include_system: Option<bool>,
) -> Result<FolderStats, ToolError> {
    let vfs = crate::lock(&state.0);
    folders::list_scoped(
        &vfs,
        parent_id,
        root.as_deref(),
        include_system.unwrap_or(false),
    )
}

#[tauri::command]
pub fn folder_path(
    state: State<'_, VfsState>,
    id: Option<i64>,
    root: Option<String>,
) -> Result<Vec<FolderCrumb>, ToolError> {
    let vfs = crate::lock(&state.0);
    folders::path(&vfs, id, root.as_deref())
}

#[tauri::command]
pub fn folder_create(
    state: State<'_, VfsState>,
    name: String,
    parent_id: Option<i64>,
    root: Option<String>,
) -> Result<Folder, ToolError> {
    let mut vfs = crate::lock(&state.0);
    folders::create_scoped(&mut vfs, &name, parent_id, root.as_deref())
}

#[tauri::command]
pub fn folder_reorder(
    state: State<'_, VfsState>,
    parent_id: Option<i64>,
    root: Option<String>,
    ids: Vec<i64>,
) -> Result<(), ToolError> {
    let vfs = crate::lock(&state.0);
    folders::reorder(&vfs, parent_id, root.as_deref(), &ids)
}

#[tauri::command]
pub fn folder_rename(state: State<'_, VfsState>, id: i64, name: String) -> Result<(), ToolError> {
    let mut vfs = crate::lock(&state.0);
    folders::rename(&mut vfs, id, &name)
}

#[tauri::command]
pub fn folder_rename_default(state: State<'_, VfsState>, name: String) -> Result<(), ToolError> {
    let mut vfs = crate::lock(&state.0);
    folders::rename_default(&mut vfs, &name)
}

#[tauri::command]
pub fn folder_delete(state: State<'_, VfsState>, id: i64) -> Result<(), ToolError> {
    let mut vfs = crate::lock(&state.0);
    folders::delete(&mut vfs, id)
}

#[tauri::command]
pub fn folder_set_pinned(
    state: State<'_, VfsState>,
    id: i64,
    pinned: bool,
) -> Result<(), ToolError> {
    let mut vfs = crate::lock(&state.0);
    folders::set_pinned(&mut vfs, id, pinned)
}
