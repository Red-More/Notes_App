//! 通用文档 CRUD 命令。

use tauri::State;

use crate::docs::{
    self,
    types::{Doc, DocFields, DocSaveReceipt, ListQuery},
};
use crate::vfs::error::ToolError;
use crate::vfs::VfsState;

/// 通用列表：kind / folder / 搜索 / 排序 / 回收站 / 标签 / 月份过滤。
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn doc_list(
    state: State<'_, VfsState>,
    kind: Option<String>,
    folder_id: Option<i64>,
    // Recursive virtual-directory scope, e.g. `/life/ai_default`.
    root: Option<String>,
    unclassified: Option<bool>,
    search: Option<String>,
    sort: Option<String>,
    deleted: Option<bool>,
    tag: Option<String>,
    month: Option<String>,
    limit: Option<usize>,
    // Lightweight mode: `false` skips document bodies.
    include_content: Option<bool>,
    // Body preview length in characters.
    preview_chars: Option<usize>,
    // Restrict to these virtual paths (search reuses `fs_grep` hits).
    paths: Option<Vec<String>>,
) -> Result<Vec<Doc>, ToolError> {
    let vfs = crate::lock(&state.0);
    docs::list(
        &vfs,
        ListQuery {
            kind,
            folder_id,
            root,
            unclassified,
            search,
            sort,
            deleted,
            tag,
            month,
            limit,
            include_content,
            preview_chars,
            paths,
        },
    )
}

#[tauri::command]
pub fn doc_get(
    state: State<'_, VfsState>,
    id: i64,
    include_deleted: Option<bool>,
) -> Result<Doc, ToolError> {
    let vfs = crate::lock(&state.0);
    docs::get(&vfs, id, include_deleted.unwrap_or(false))
}

/// 新建文档。kind 决定根目录；笔记可用 folder_id 指定文件夹。
#[tauri::command]
pub fn doc_create(
    state: State<'_, VfsState>,
    kind: String,
    title: String,
    content: String,
    folder_id: Option<i64>,
    fields: Option<DocFields>,
    ext: Option<String>,
) -> Result<Doc, ToolError> {
    let mut vfs = crate::lock(&state.0);
    docs::create_typed(
        &mut vfs,
        &kind,
        &title,
        &content,
        folder_id,
        fields,
        ext.as_deref(),
    )
}

/// 保存文档；字段用 null 表示清除。folder_id 仅对笔记生效：
/// Some(-1) 表示默认文件夹，None 表示不移动。
///
/// `rename` (base + ext) 与保存同一事务：改名和正文不会一半成功，
/// 因此联系人这类“名字即文件名”的编辑只需要一次调用。
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn doc_save(
    state: State<'_, VfsState>,
    id: i64,
    title: Option<String>,
    content: Option<String>,
    fields: Option<DocFields>,
    folder_id: Option<i64>,
    expect_rev: Option<i64>,
    rename_base: Option<String>,
    rename_ext: Option<String>,
) -> Result<DocSaveReceipt, ToolError> {
    let mut vfs = crate::lock(&state.0);
    // Both halves of a rename are required: a base without an extension would
    // silently drop the extension instead of keeping it.
    let rename = match (rename_base, rename_ext) {
        (Some(base), Some(ext)) => Some((base, ext)),
        (None, None) => None,
        _ => return Err(ToolError::invalid("改名需要同时提供文件名与扩展名")),
    };
    docs::save_document(
        &mut vfs,
        id,
        docs::SaveRequest {
            title,
            content,
            fields,
            rename,
            folder_id,
            expect_rev,
        },
    )
}

/// 批量移动到任意虚拟目录（长按菜单的“移动到”）。
#[tauri::command]
pub fn doc_move_path(
    state: State<'_, VfsState>,
    ids: Vec<i64>,
    dir: String,
) -> Result<(), ToolError> {
    let mut vfs = crate::lock(&state.0);
    docs::move_many_to_dir(&mut vfs, &ids, &dir)
}

/// 重命名文件：基名与扩展名分开传入，基名中的点号不会被当作扩展名分隔符。
#[tauri::command]
pub fn doc_rename(
    state: State<'_, VfsState>,
    id: i64,
    base: String,
    ext: String,
) -> Result<Doc, ToolError> {
    let mut vfs = crate::lock(&state.0);
    docs::rename_file(&mut vfs, id, &base, &ext)
}

#[tauri::command]
pub fn doc_delete(state: State<'_, VfsState>, ids: Vec<i64>) -> Result<(), ToolError> {
    let mut vfs = crate::lock(&state.0);
    docs::delete_many(&mut vfs, &ids)
}

#[tauri::command]
pub fn doc_restore(state: State<'_, VfsState>, ids: Vec<i64>) -> Result<(), ToolError> {
    let mut vfs = crate::lock(&state.0);
    docs::restore_many(&mut vfs, &ids)
}

#[tauri::command]
pub fn doc_purge(state: State<'_, VfsState>, ids: Vec<i64>) -> Result<(), ToolError> {
    let mut vfs = crate::lock(&state.0);
    docs::purge_many(&mut vfs, &ids)
}

#[tauri::command]
pub fn doc_empty_trash(state: State<'_, VfsState>) -> Result<(), ToolError> {
    let mut vfs = crate::lock(&state.0);
    docs::empty_trash(&mut vfs)
}

#[tauri::command]
pub fn doc_set_pinned(
    state: State<'_, VfsState>,
    ids: Vec<i64>,
    pinned: bool,
) -> Result<(), ToolError> {
    let mut vfs = crate::lock(&state.0);
    docs::set_pinned(&mut vfs, &ids, pinned)
}

/// 批量移动笔记。folder_id 为 null 表示默认文件夹。
#[tauri::command]
pub fn doc_move(
    state: State<'_, VfsState>,
    ids: Vec<i64>,
    folder_id: Option<i64>,
) -> Result<(), ToolError> {
    let mut vfs = crate::lock(&state.0);
    docs::move_many(&mut vfs, &ids, folder_id)
}
