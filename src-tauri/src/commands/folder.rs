//! 文件夹命令：目录即文件夹，显示名存 meta.title。

use tauri::State;

use crate::docs::folders;
use crate::docs::types::{Folder, FolderStats};
use crate::vfs::error::ToolError;
use crate::vfs::VfsState;

#[tauri::command]
pub fn folder_list(state: State<'_, VfsState>) -> Result<FolderStats, ToolError> {
    let vfs = state.0.lock().unwrap();
    folders::list(&vfs)
}

#[tauri::command]
pub fn folder_create(state: State<'_, VfsState>, name: String) -> Result<Folder, ToolError> {
    let mut vfs = state.0.lock().unwrap();
    folders::create(&mut vfs, &name)
}

#[tauri::command]
pub fn folder_rename(
    state: State<'_, VfsState>,
    id: i64,
    name: String,
) -> Result<(), ToolError> {
    let mut vfs = state.0.lock().unwrap();
    folders::rename(&mut vfs, id, &name)
}

#[tauri::command]
pub fn folder_rename_default(
    state: State<'_, VfsState>,
    name: String,
) -> Result<(), ToolError> {
    let mut vfs = state.0.lock().unwrap();
    folders::rename_default(&mut vfs, &name)
}

#[tauri::command]
pub fn folder_delete(state: State<'_, VfsState>, id: i64) -> Result<(), ToolError> {
    let mut vfs = state.0.lock().unwrap();
    folders::delete(&mut vfs, id)
}

#[tauri::command]
pub fn folder_set_pinned(
    state: State<'_, VfsState>,
    id: i64,
    pinned: bool,
) -> Result<(), ToolError> {
    let mut vfs = state.0.lock().unwrap();
    folders::set_pinned(&mut vfs, id, pinned)
}
