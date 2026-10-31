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

/// 列出全部技能（含禁用项），只返回摘要。
#[tauri::command]
pub fn skill_list(state: State<'_, VfsState>) -> Result<Vec<SkillSummary>, ToolError> {
    let vfs = state.0.lock().unwrap();
    skills::list(&vfs)
}

/// 读取单个技能的完整正文，用于触发后的按需注入。
#[tauri::command]
pub fn skill_read(state: State<'_, VfsState>, id: String) -> Result<SkillDetail, ToolError> {
    let vfs = state.0.lock().unwrap();
    skills::read(&vfs, &id)
}

/// 新建或更新技能；id 为空时按名称生成。
#[tauri::command]
pub fn skill_save(
    state: State<'_, VfsState>,
    input: SkillInput,
) -> Result<SkillSummary, ToolError> {
    let mut vfs = state.0.lock().unwrap();
    skills::save(&mut vfs, input)
}

/// 启用/停用技能。
#[tauri::command]
pub fn skill_set_enabled(
    state: State<'_, VfsState>,
    id: String,
    enabled: bool,
) -> Result<(), ToolError> {
    let vfs = state.0.lock().unwrap();
    skills::set_enabled(&vfs, &id, enabled)
}

/// 卸载技能（物理删除技能目录）。
#[tauri::command]
pub fn skill_delete(state: State<'_, VfsState>, id: String) -> Result<(), ToolError> {
    let mut vfs = state.0.lock().unwrap();
    skills::delete(&mut vfs, &id)
}

/// 导入 zip/.skill 技能包：只读取根目录 SKILL.md。
#[tauri::command]
pub fn skill_import(
    state: State<'_, VfsState>,
    input: SkillImportInput,
) -> Result<SkillSummary, ToolError> {
    let mut vfs = state.0.lock().unwrap();
    skills::import_package(&mut vfs, &input.filename, &input.data)
}

/// 列出 `/life/agent/skills-drafts` 中等待用户审核的草稿。
#[tauri::command]
pub fn skill_draft_list(state: State<'_, VfsState>) -> Result<Vec<SkillSummary>, ToolError> {
    let vfs = state.0.lock().unwrap();
    skills::list_drafts(&vfs)
}

/// 预览草稿正文。
#[tauri::command]
pub fn skill_draft_read(state: State<'_, VfsState>, id: String) -> Result<SkillDetail, ToolError> {
    let vfs = state.0.lock().unwrap();
    skills::read_draft(&vfs, &id)
}

/// 用户审核后把草稿载入 `.agents/skills`。
#[tauri::command]
pub fn skill_draft_promote(
    state: State<'_, VfsState>,
    id: String,
) -> Result<SkillSummary, ToolError> {
    let mut vfs = state.0.lock().unwrap();
    skills::promote_draft(&mut vfs, &id)
}

/// 丢弃草稿。
#[tauri::command]
pub fn skill_draft_delete(state: State<'_, VfsState>, id: String) -> Result<(), ToolError> {
    let mut vfs = state.0.lock().unwrap();
    skills::delete_draft(&mut vfs, &id)
}
