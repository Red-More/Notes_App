//! 远程 MCP 命令：服务器配置与工具发现/调用。
//!
//! URL、显示名存 `life.db`；令牌在 `SecretStore`。所有网络请求留在 Rust。

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde_json::Value;
use tauri::State;

use crate::agent::AgentState;
use crate::mcp::{self, McpServer, McpServerInput, McpServerView, McpTool};
use crate::vfs::error::ToolError;
use crate::vfs::VfsState;

/// Discovery must never stall chat startup: cap the per-server tools/list round trip.
const DISCOVERY_TIMEOUT: Duration = Duration::from_secs(8);
/// Tool lists change rarely; reuse a discovery for a short window across page activations.
const TOOLS_CACHE_TTL: Duration = Duration::from_secs(60);

struct CachedTools {
    fetched_at: Instant,
    tools: Vec<McpTool>,
}

fn tools_cache() -> &'static Mutex<HashMap<String, CachedTools>> {
    static CACHE: OnceLock<Mutex<HashMap<String, CachedTools>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Drop cached discoveries; call after server config or token changes.
fn invalidate_tools_cache() {
    crate::lock(tools_cache()).clear();
}

/// Store a discovery result, pruning expired entries on the way.
fn cache_tools(server_id: &str, tools: Vec<McpTool>) {
    let mut cache = crate::lock(tools_cache());
    cache.retain(|_, entry| entry.fetched_at.elapsed() < TOOLS_CACHE_TTL);
    cache.insert(
        server_id.to_string(),
        CachedTools {
            fetched_at: Instant::now(),
            tools,
        },
    );
}

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
    let saved = mcp::save(vfs.conn(), &agent.secrets, input)?;
    invalidate_tools_cache();
    Ok(saved)
}

#[tauri::command]
pub fn mcp_server_delete(
    vfs_state: State<'_, VfsState>,
    agent: State<'_, AgentState>,
    id: String,
) -> Result<(), ToolError> {
    let vfs = crate::lock(&vfs_state.0);
    mcp::delete(vfs.conn(), &agent.secrets, &id)?;
    invalidate_tools_cache();
    Ok(())
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
    let tools = mcp::fetch_tools(&agent, &server, token.as_deref())
        .await
        .map_err(ToolError::invalid)?;
    // A manual discovery is authoritative for the cache window.
    cache_tools(&id, tools.clone());
    Ok(tools)
}

/// All tools from enabled servers; discovery runs concurrently and unresponsive
/// servers are capped so one bad host cannot block the rest.
#[tauri::command]
pub async fn mcp_all_tools(
    vfs_state: State<'_, VfsState>,
    agent: State<'_, AgentState>,
) -> Result<Vec<McpTool>, ToolError> {
    let servers = {
        let vfs = crate::lock(&vfs_state.0);
        mcp::enabled_servers(vfs.conn())
    };
    let mut found: HashMap<String, Vec<McpTool>> = HashMap::new();
    let mut misses: Vec<McpServer> = Vec::new();
    {
        let cache = crate::lock(tools_cache());
        for server in &servers {
            match cache.get(&server.id) {
                Some(entry) if entry.fetched_at.elapsed() < TOOLS_CACHE_TTL => {
                    found.insert(server.id.clone(), entry.tools.clone());
                }
                _ => misses.push(server.clone()),
            }
        }
    }
    let state: &AgentState = &agent;
    let discovered = futures_util::future::join_all(misses.into_iter().map(|server| async move {
        let token = mcp::token(&state.secrets, &server.id);
        let tools = match tokio::time::timeout(
            DISCOVERY_TIMEOUT,
            mcp::fetch_tools(state, &server, token.as_deref()),
        )
        .await
        {
            Ok(Ok(tools)) => tools,
            Ok(Err(e)) => {
                log::warn!("mcp server {} unavailable: {e}", server.id);
                Vec::new()
            }
            Err(_) => {
                log::warn!(
                    "mcp server {} discovery timed out after {}s",
                    server.id,
                    DISCOVERY_TIMEOUT.as_secs()
                );
                Vec::new()
            }
        };
        (server.id, tools)
    }))
    .await;
    for (id, tools) in discovered {
        cache_tools(&id, tools.clone());
        found.insert(id, tools);
    }
    // Preserve the previous ordering: enabled servers first, capped at 32 tools.
    let mut tools: Vec<McpTool> = Vec::new();
    for server in &servers {
        if tools.len() >= 32 {
            break;
        }
        if let Some(list) = found.get(&server.id) {
            tools.extend(list.iter().cloned());
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
