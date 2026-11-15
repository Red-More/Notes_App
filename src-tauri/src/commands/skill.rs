//! 技能管理命令（M3-4）。技能的读写只走这些专用命令，不暴露给模型工具。

use serde::Deserialize;
use tauri::State;

use crate::skills::{self, SkillDetail, SkillInput, SkillSummary};
use crate::vfs::error::ToolError;
use crate::vfs::VfsState;

/// 技能包上传入参：文件名用于校验扩展名，data 为 base64 后的 zip/.skill。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillImportInput {
    pub filename: String,
    pub data: String,
}

/// 列出技能（含禁用项）；`scope` 省略时使用默认工作区。
#[tauri::command]
pub fn skill_list(
    state: State<'_, VfsState>,
    scope: Option<String>,
) -> Result<Vec<SkillSummary>, ToolError> {
    let vfs = crate::lock(&state.0);
    match scope.as_deref() {
        Some(path) => skills::list_for_scope(&vfs, path),
        None => skills::list(&vfs),
    }
}

/// 读取单个技能的完整正文；`scope` 决定父目录技能覆盖顺序。
#[tauri::command]
pub fn skill_read(
    state: State<'_, VfsState>,
    id: String,
    scope: Option<String>,
) -> Result<SkillDetail, ToolError> {
    let vfs = crate::lock(&state.0);
    match scope.as_deref() {
        Some(path) => skills::read_for_scope(&vfs, &id, path),
        None => skills::read(&vfs, &id),
    }
}

/// Agent 侧按作用域读取技能（`load_skill` 工具专用）。
///
/// `scope` 来自模型，因此这里强制走 `.lifeos` 鉴权并拒绝已停用技能；
/// 用户设置页仍走 `skill_read`，可直接预览任意技能。
#[tauri::command]
pub fn agent_skill_read(
    state: State<'_, VfsState>,
    id: String,
    scope: Option<String>,
) -> Result<SkillDetail, ToolError> {
    let vfs = crate::lock(&state.0);
    skills::read_for_agent(&vfs, &id, scope.as_deref())
}

/// 新建或更新技能；id 为空时按名称生成。
#[tauri::command]
pub fn skill_save(
    state: State<'_, VfsState>,
    input: SkillInput,
) -> Result<SkillSummary, ToolError> {
    let mut vfs = crate::lock(&state.0);
    skills::save(&mut vfs, input)
}

/// 启用/停用技能。
#[tauri::command]
pub fn skill_set_enabled(
    state: State<'_, VfsState>,
    id: String,
    enabled: bool,
) -> Result<(), ToolError> {
    let vfs = crate::lock(&state.0);
    skills::set_enabled(&vfs, &id, enabled)
}

/// 卸载技能（物理删除技能目录）。
#[tauri::command]
pub fn skill_delete(state: State<'_, VfsState>, id: String) -> Result<(), ToolError> {
    let mut vfs = crate::lock(&state.0);
    skills::delete(&mut vfs, &id)
}

/// 导入 zip/.skill 技能包：只读取根目录 SKILL.md。
#[tauri::command]
pub fn skill_import(
    state: State<'_, VfsState>,
    input: SkillImportInput,
) -> Result<SkillSummary, ToolError> {
    let mut vfs = crate::lock(&state.0);
    skills::import_package(&mut vfs, &input.filename, &input.data)
}

/// 列出 `/life/ai_default/skills-drafts` 中等待用户审核的草稿。
#[tauri::command]
pub fn skill_draft_list(state: State<'_, VfsState>) -> Result<Vec<SkillSummary>, ToolError> {
    let vfs = crate::lock(&state.0);
    skills::list_drafts(&vfs)
}

/// 预览草稿正文。
#[tauri::command]
pub fn skill_draft_read(state: State<'_, VfsState>, id: String) -> Result<SkillDetail, ToolError> {
    let vfs = crate::lock(&state.0);
    skills::read_draft(&vfs, &id)
}

/// 用户审核后把草稿载入 `.agent/skills`。
#[tauri::command]
pub fn skill_draft_promote(
    state: State<'_, VfsState>,
    id: String,
) -> Result<SkillSummary, ToolError> {
    let mut vfs = crate::lock(&state.0);
    skills::promote_draft(&mut vfs, &id)
}

/// 丢弃草稿。
#[tauri::command]
pub fn skill_draft_delete(state: State<'_, VfsState>, id: String) -> Result<(), ToolError> {
    let mut vfs = crate::lock(&state.0);
    skills::delete_draft(&mut vfs, &id)
}
