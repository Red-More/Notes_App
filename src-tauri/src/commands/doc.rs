//! 通用文档 CRUD 命令。

use tauri::State;

use crate::docs::{
    self,
    types::{Doc, DocFields, ListQuery},
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
    unclassified: Option<bool>,
    search: Option<String>,
    sort: Option<String>,
    deleted: Option<bool>,
    tag: Option<String>,
    month: Option<String>,
    limit: Option<usize>,
) -> Result<Vec<Doc>, ToolError> {
    let vfs = crate::lock(&state.0);
    docs::list(
        &vfs,
        ListQuery {
            kind,
            folder_id,
            unclassified,
            search,
            sort,
            deleted,
            tag,
            month,
            limit,
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
) -> Result<Doc, ToolError> {
    let mut vfs = crate::lock(&state.0);
    docs::create(&mut vfs, &kind, &title, &content, folder_id, fields)
}

/// 保存文档；字段用 null 表示清除。folder_id 仅对笔记生效：
/// Some(-1) 表示默认文件夹，None 表示不移动。
#[tauri::command]
pub fn doc_save(
    state: State<'_, VfsState>,
    id: i64,
    title: Option<String>,
    content: Option<String>,
    fields: Option<DocFields>,
    folder_id: Option<i64>,
    expect_rev: Option<i64>,
) -> Result<Doc, ToolError> {
    let mut vfs = crate::lock(&state.0);
    docs::save(&mut vfs, id, title, content, fields, folder_id, expect_rev)
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
