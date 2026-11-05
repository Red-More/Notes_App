//! 远程 MCP 命令：服务器配置与工具发现/调用。
//!
//! URL、显示名存 `life.db`；令牌在 `SecretStore`。所有网络请求留在 Rust。

use serde_json::Value;
use tauri::State;

use crate::agent::AgentState;
use crate::mcp::{self, McpServerInput, McpServerView, McpTool};
use crate::vfs::error::ToolError;
use crate::vfs::VfsState;

#[tauri::command]
pub fn mcp_server_list(
    vfs_state: State<'_, VfsState>,
    agent: State<'_, AgentState>,
) -> Result<Vec<McpServerView>, ToolError> {
    let vfs = crate::lock(&vfs_state.0);
    mcp::list(vfs.conn(), &agent.secrets)
}

#[tauri::command]
pub fn mcp_server_save(
    vfs_state: State<'_, VfsState>,
    agent: State<'_, AgentState>,
    input: McpServerInput,
) -> Result<McpServerView, ToolError> {
    let vfs = crate::lock(&vfs_state.0);
    mcp::save(vfs.conn(), &agent.secrets, input)
}

#[tauri::command]
pub fn mcp_server_delete(
    vfs_state: State<'_, VfsState>,
    agent: State<'_, AgentState>,
    id: String,
) -> Result<(), ToolError> {
    let vfs = crate::lock(&vfs_state.0);
    mcp::delete(vfs.conn(), &agent.secrets, &id)
}

/// Discover tools for one server (settings page test button).
#[tauri::command]
pub async fn mcp_server_tools(
    vfs_state: State<'_, VfsState>,
    agent: State<'_, AgentState>,
    id: String,
) -> Result<Vec<McpTool>, ToolError> {
    let server = {
        let vfs = crate::lock(&vfs_state.0);
        mcp::config(vfs.conn(), &id)?
    };
    let token = mcp::token(&agent.secrets, &id);
    mcp::fetch_tools(&agent, &server, token.as_deref())
        .await
        .map_err(ToolError::invalid)
}

/// All tools from enabled servers; one failing server never blocks the others.
#[tauri::command]
pub async fn mcp_all_tools(
    vfs_state: State<'_, VfsState>,
    agent: State<'_, AgentState>,
) -> Result<Vec<McpTool>, ToolError> {
    let servers = {
        let vfs = crate::lock(&vfs_state.0);
        mcp::enabled_servers(vfs.conn())
    };
    let mut tools: Vec<McpTool> = Vec::new();
    for server in servers {
        if tools.len() >= 32 {
            break;
        }
        let token = mcp::token(&agent.secrets, &server.id);
        match mcp::fetch_tools(&agent, &server, token.as_deref()).await {
            Ok(mut found) => tools.append(&mut found),
            Err(e) => log::warn!("mcp server {} unavailable: {e}", server.id),
        }
    }
    tools.truncate(32);
    Ok(tools)
}

#[tauri::command]
pub async fn mcp_tool_call(
    vfs_state: State<'_, VfsState>,
    agent: State<'_, AgentState>,
    server_id: String,
    tool: String,
    arguments: Value,
) -> Result<String, ToolError> {
    let server = {
        let vfs = crate::lock(&vfs_state.0);
        mcp::config(vfs.conn(), &server_id)?
    };
    if !server.enabled {
        return Err(ToolError::invalid("该 MCP 服务器已停用"));
    }
    let token = mcp::token(&agent.secrets, &server.id);
    mcp::call_tool(&agent, &server, token.as_deref(), &tool, &arguments)
        .await
        .map_err(ToolError::invalid)
}
