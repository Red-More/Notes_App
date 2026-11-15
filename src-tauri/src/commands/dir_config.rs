//! Directory configuration commands.
//!
//! Visibility (`.lifeos`) and model configuration (`.agent`) are exposed as
//! separate command families so the two systems cannot be mixed by callers.

use tauri::State;

use crate::directory_config::{
    self, AgentConfigInput, AgentConfigView, VisibilityInput, VisibilityView,
};
use crate::vfs::error::ToolError;
use crate::vfs::VfsState;

/// List every configurable directory with effective visibility.
#[tauri::command]
pub fn lifeos_list(state: State<'_, VfsState>) -> Result<Vec<VisibilityView>, ToolError> {
    let vfs = crate::lock(&state.0);
    directory_config::list_visibility(&vfs)
}

/// Read one directory's visibility configuration.
#[tauri::command]
pub fn lifeos_get(state: State<'_, VfsState>, path: String) -> Result<VisibilityView, ToolError> {
    let vfs = crate::lock(&state.0);
    directory_config::get_visibility(&vfs, &path)
}

/// Persist visibility for one directory.
#[tauri::command]
pub fn lifeos_save(
    state: State<'_, VfsState>,
    path: String,
    input: VisibilityInput,
) -> Result<VisibilityView, ToolError> {
    let mut vfs = crate::lock(&state.0);
    directory_config::save_visibility(&mut vfs, &path, input)
}

/// Read one directory's model configuration.
#[tauri::command]
pub fn agent_config_get(
    state: State<'_, VfsState>,
    path: String,
) -> Result<AgentConfigView, ToolError> {
    let vfs = crate::lock(&state.0);
    directory_config::get_agent_config(&vfs, &path)
}

/// Persist model configuration for one directory.
#[tauri::command]
pub fn agent_config_save(
    state: State<'_, VfsState>,
    path: String,
    input: AgentConfigInput,
) -> Result<AgentConfigView, ToolError> {
    let mut vfs = crate::lock(&state.0);
    directory_config::save_agent_config(&mut vfs, &path, input)
}
