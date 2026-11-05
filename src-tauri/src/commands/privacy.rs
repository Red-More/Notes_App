//! Privacy commands: sensitivity labels, EDM entity vault, and egress audit.
//!
//! The WebView can read labels/aliases and audit rows, but never the entity
//! plaintext: values go straight into the OS secret store.

use tauri::State;

use crate::agent::AgentState;
use crate::privacy::egress::{self, AuditRecord};
use crate::privacy::entity::{self, EntityKind, EntityRecord};
use crate::privacy::policy::{self, Label};
use crate::vfs::error::ToolError;
use crate::vfs::VfsState;

#[tauri::command]
pub fn privacy_labels_list(state: State<'_, VfsState>) -> Result<Vec<Label>, ToolError> {
    let vfs = crate::lock(&state.0);
    policy::list_labels(vfs.conn())
}

#[tauri::command]
pub fn privacy_label_set(
    state: State<'_, VfsState>,
    path: String,
    level: i64,
) -> Result<Label, ToolError> {
    let vfs = crate::lock(&state.0);
    policy::set_label(vfs.conn(), &path, level)
}

#[tauri::command]
pub fn privacy_label_delete(state: State<'_, VfsState>, path: String) -> Result<(), ToolError> {
    let vfs = crate::lock(&state.0);
    policy::delete_label(vfs.conn(), &path)
}

#[tauri::command]
pub fn privacy_entities_list(state: State<'_, VfsState>) -> Result<Vec<EntityRecord>, ToolError> {
    let vfs = crate::lock(&state.0);
    entity::list(vfs.conn())
}

#[tauri::command]
pub fn privacy_entity_add(
    vfs_state: State<'_, VfsState>,
    agent_state: State<'_, AgentState>,
    kind: String,
    value: String,
) -> Result<EntityRecord, ToolError> {
    let kind = EntityKind::from_str(&kind).ok_or_else(|| ToolError::invalid("未知实体类型"))?;
    let vfs = crate::lock(&vfs_state.0);
    entity::add(vfs.conn(), &agent_state.secrets, kind, &value)
}

#[tauri::command]
pub fn privacy_entity_delete(
    vfs_state: State<'_, VfsState>,
    agent_state: State<'_, AgentState>,
    alias: String,
) -> Result<(), ToolError> {
    let vfs = crate::lock(&vfs_state.0);
    entity::remove(vfs.conn(), &agent_state.secrets, &alias)
}

#[tauri::command]
pub fn privacy_audit_list(
    state: State<'_, VfsState>,
    limit: Option<usize>,
) -> Result<Vec<AuditRecord>, ToolError> {
    let vfs = crate::lock(&state.0);
    Ok(egress::list_audit(vfs.conn(), limit.unwrap_or(20))?)
}
