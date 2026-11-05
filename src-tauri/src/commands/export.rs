//! 导出命令：把 VFS 文档写回真实文件系统（唯一允许触碰真实 FS 的出口）。
//!
//! 单文档 -> `.md`；多文档/文件夹 -> `.zip`。桌面端 dest_path 是普通路径，
//! Android 端 save 对话框返回 content:// URI，由 tauri-plugin-fs 解析。

use std::io::Write;
use std::str::FromStr;

use tauri::{AppHandle, Runtime, State};
use tauri_plugin_fs::{FilePath, FsExt, OpenOptions};

use crate::docs::export;
use crate::vfs::error::ToolError;
use crate::vfs::VfsState;

fn write_bytes<R: Runtime>(
    app: &AppHandle<R>,
    dest_path: &str,
    bytes: &[u8],
) -> Result<(), ToolError> {
    let mut options = OpenOptions::new();
    options.read(false).write(true).create(true).truncate(true);
    // FilePath 的解析错误类型是 Infallible，不存在失败分支。
    let path = FilePath::from_str(dest_path).unwrap();
    let mut file = app
        .fs()
        .open(path, options)
        .map_err(|e| ToolError::Storage {
            message: format!("无法创建导出文件 {dest_path}: {e}"),
        })?;
    file.write_all(bytes).map_err(|e| ToolError::Storage {
        message: format!("无法写入导出文件 {dest_path}: {e}"),
    })
}

/// 导出单文档为 Markdown（含 frontmatter）。
#[tauri::command]
pub fn export_doc<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VfsState>,
    doc_id: i64,
    dest_path: String,
) -> Result<(), ToolError> {
    let bytes = {
        let vfs = crate::lock(&state.0);
        export::markdown(&vfs, doc_id)?.into_bytes()
    };
    write_bytes(&app, &dest_path, &bytes)
}

/// 导出多个文档为 ZIP。
#[tauri::command]
pub fn export_docs<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VfsState>,
    ids: Vec<i64>,
    dest_path: String,
) -> Result<(), ToolError> {
    let bytes = {
        let vfs = crate::lock(&state.0);
        let entries = export::collect(&vfs, &ids)?;
        if entries.is_empty() {
            return Err(ToolError::invalid("没有可导出的笔记"));
        }
        export::zip_entries(&entries)?
    };
    write_bytes(&app, &dest_path, &bytes)
}

/// 导出文件夹内全部笔记为 ZIP。
#[tauri::command]
pub fn export_folder<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VfsState>,
    folder_id: i64,
    dest_path: String,
) -> Result<(), ToolError> {
    let bytes = {
        let vfs = crate::lock(&state.0);
        let entries = export::collect_folder(&vfs, folder_id)?;
        export::zip_entries(&entries)?
    };
    write_bytes(&app, &dest_path, &bytes)
}
