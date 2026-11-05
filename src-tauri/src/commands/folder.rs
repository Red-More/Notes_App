//! 文件夹命令：目录即文件夹，显示名存 meta.title。

use tauri::State;

use crate::docs::folders;
use crate::docs::types::{Folder, FolderStats};
use crate::vfs::error::ToolError;
use crate::vfs::VfsState;

#[tauri::command]
pub fn folder_list(state: State<'_, VfsState>) -> Result<FolderStats, ToolError> {
    let vfs = crate::lock(&state.0);
    folders::list(&vfs)
}

#[tauri::command]
pub fn folder_create(state: State<'_, VfsState>, name: String) -> Result<Folder, ToolError> {
    let mut vfs = crate::lock(&state.0);
    folders::create(&mut vfs, &name)
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
