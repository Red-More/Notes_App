//! 远程 MCP（仅 HTTPS）：JSON-RPC 2.0 over Streamable HTTP。
//!
//! 安全边界：
//! - 只允许 HTTPS 公网地址（复用模型条目的 URL 校验），禁用重定向；
//! - 不启动本地进程（stdio MCP 永久排除），请求全部由 Rust 发出；
//! - 工具调用前会重新拉取 `tools/list`，只允许服务器实际声明的工具；
//! - 服务器 URL 与显示名存 `life.db`，访问令牌存 `SecretStore`，不进 SQLite/JS。

use std::time::Duration;

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::agent::model_store;
use crate::agent::secrets::SecretStore;
use crate::agent::AgentState;
use crate::vfs::error::ToolError;

const KEY_SERVERS: &str = "agent.mcp.v1";
const MAX_SERVERS: usize = 8;
const MAX_LABEL_CHARS: usize = 64;
const MAX_ID_CHARS: usize = 32;
const MAX_TOOL_NAME_CHARS: usize = 64;
const MAX_ARG_BYTES: usize = 64 * 1024;
const RPC_TIMEOUT: Duration = Duration::from_secs(45);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServer {
    pub id: String,
    pub label: String,
    pub url: String,
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerView {
    pub id: String,
    pub label: String,
    pub url: String,
    pub enabled: bool,
    pub configured: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerInput {
    #[serde(default)]
    pub id: String,
    pub label: String,
    pub url: String,
    #[serde(default = "default_enabled")]
    pub enabled: bool,
    /// Bearer token; an empty string clears the stored token.
    #[serde(default)]
    pub token: Option<String>,
}

fn default_enabled() -> bool {
    true
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpTool {
    pub server_id: String,
    pub server_label: String,
    pub name: String,
    /// Model-facing name; always starts with `mcp_` so Rust can allow it.
    pub qualified: String,
    pub description: String,
    pub input_schema: Value,
}

fn secret_key(id: &str) -> String {
    format!("mcp.{id}")
}

fn read_servers(conn: &Connection) -> Vec<McpServer> {
    read_setting(conn, KEY_SERVERS)
        .and_then(|raw| serde_json::from_str::<Vec<McpServer>>(&raw).ok())
        .unwrap_or_default()
        .into_iter()
        // Re-validate on read so a tampered settings row cannot redirect tool
        // calls to an internal/plaintext host (same rule as model entries).
        .filter(|server| crate::agent::model_store::validate_base_url(&server.url).is_ok())
        .collect()
}

fn write_servers(conn: &Connection, servers: &[McpServer]) -> Result<(), ToolError> {
    let body = serde_json::to_string(servers)
        .map_err(|e| ToolError::invalid(format!("MCP 配置序列化失败：{e}")))?;
    write_setting(conn, KEY_SERVERS, &body)
}

pub fn list(conn: &Connection, secrets: &SecretStore) -> Result<Vec<McpServerView>, ToolError> {
    Ok(read_servers(conn)
        .into_iter()
        .map(|server| McpServerView {
            configured: secrets.has(&secret_key(&server.id)),
            id: server.id,
            label: server.label,
            url: server.url,
            enabled: server.enabled,
        })
        .collect())
}

pub fn config(conn: &Connection, id: &str) -> Result<McpServer, ToolError> {
    read_servers(conn)
        .into_iter()
        .find(|server| server.id == id)
        .ok_or_else(|| ToolError::invalid(format!("未找到 MCP 服务器：{id}")))
}

/// Enabled servers only; the agent loader never touches disabled entries.
pub fn enabled_servers(conn: &Connection) -> Vec<McpServer> {
    read_servers(conn)
        .into_iter()
        .filter(|server| server.enabled)
        .collect()
}

pub fn token(secrets: &SecretStore, id: &str) -> Option<String> {
    secrets.get(&secret_key(id)).ok().flatten()
}

pub fn save(
    conn: &Connection,
    secrets: &SecretStore,
    input: McpServerInput,
) -> Result<McpServerView, ToolError> {
    let label = validate_label(&input.label)?;
    // Reuse the model-entry URL rules: HTTPS, public host, no credentials/query.
    let url = model_store::validate_base_url(&input.url)?;
    let mut servers = read_servers(conn);
    let existing = if input.id.trim().is_empty() {
        None
    } else {
        let id = validate_id(&input.id)?;
        servers
            .iter()
            .find(|server| server.id == id)
            .map(|server| server.id.clone())
    };
    if existing.is_none() && servers.len() >= MAX_SERVERS {
        return Err(ToolError::invalid(format!(
            "最多配置 {MAX_SERVERS} 个 MCP 服务器"
        )));
    }
    let id = match existing {
        Some(id) => id,
        None => next_id(&servers),
    };
    let view = McpServerView {
        configured: false,
        id: id.clone(),
        label: label.clone(),
        url: url.clone(),
        enabled: input.enabled,
    };
    let server = McpServer {
        id,
        label,
        url,
        enabled: input.enabled,
    };
    match servers.iter_mut().find(|item| item.id == server.id) {
        Some(slot) => *slot = server,
        None => servers.push(server),
    }
    write_servers(conn, &servers)?;
    apply_token(secrets, &view.id, input.token)?;
    Ok(McpServerView {
        configured: secrets.has(&secret_key(&view.id)),
        ..view
    })
}

pub fn delete(conn: &Connection, secrets: &SecretStore, id: &str) -> Result<(), ToolError> {
    let mut servers = read_servers(conn);
    let before = servers.len();
    servers.retain(|server| server.id != id);
    if servers.len() == before {
        return Err(ToolError::invalid(format!("未找到 MCP 服务器：{id}")));
    }
    write_servers(conn, &servers)?;
    let _ = secrets.delete(&secret_key(id));
    Ok(())
}

fn apply_token(secrets: &SecretStore, id: &str, token: Option<String>) -> Result<(), ToolError> {
    let Some(token) = token else {
        return Ok(());
    };
    if token.trim().is_empty() {
        secrets
            .delete(&secret_key(id))
            .map_err(|e| ToolError::Storage {
                message: format!("清除 MCP 令牌失败：{e}"),
            })?;
    } else {
        secrets
            .set(&secret_key(id), token.trim())
            .map_err(|e| ToolError::Storage {
                message: format!("保存 MCP 令牌失败：{e}"),
            })?;
    }
    Ok(())
}

fn validate_id(raw: &str) -> Result<String, ToolError> {
    let id = raw.trim();
    if id.is_empty() || id.chars().count() > MAX_ID_CHARS {
        return Err(ToolError::invalid("MCP 条目 id 为空或超过 32 字符"));
    }
    if !id
        .chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_')
    {
        return Err(ToolError::invalid(
            "MCP 条目 id 只能包含小写字母、数字、短横线和下划线",
        ));
    }
    Ok(id.to_string())
}

fn validate_label(raw: &str) -> Result<String, ToolError> {
    let label = raw.trim();
    if label.is_empty() || label.chars().count() > MAX_LABEL_CHARS {
        return Err(ToolError::invalid(format!(
            "MCP 显示名称必须为 1–{MAX_LABEL_CHARS} 字符"
        )));
    }
    if label.chars().any(char::is_control) {
        return Err(ToolError::invalid("MCP 显示名称包含控制字符"));
    }
    Ok(label.to_string())
}

fn next_id(servers: &[McpServer]) -> String {
    for n in 1..=u32::MAX {
        let candidate = format!("mcp_{n}");
        if !servers.iter().any(|server| server.id == candidate) {
            return candidate;
        }
    }
    "mcp_max".to_string()
}

fn read_setting(conn: &Connection, key: &str) -> Option<String> {
    conn.query_row(
        "SELECT value FROM settings WHERE key = ?1",
        params![key],
        |row| row.get(0),
    )
    .optional()
    .ok()
    .flatten()
}

fn write_setting(conn: &Connection, key: &str, value: &str) -> Result<(), ToolError> {
    conn.execute(
        "INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, datetime('now','localtime'))
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        params![key, value],
    )?;
    Ok(())
}

// ---------------------------------------------------------------------------
// JSON-RPC over Streamable HTTP
// ---------------------------------------------------------------------------

/// Accept either a plain JSON-RPC body or an SSE stream of `data:` events.
fn parse_rpc_payload(text: &str, id: u64) -> Result<Value, String> {
    let trimmed = text.trim();
    if trimmed.starts_with('{') {
        return serde_json::from_str(trimmed).map_err(|e| format!("MCP 响应不是合法 JSON：{e}"));
    }
    let mut last = None;
    for line in trimmed.lines() {
        let Some(data) = line.strip_prefix("data:") else {
            continue;
        };
        let Ok(value) = serde_json::from_str::<Value>(data.trim()) else {
            continue;
        };
        if value.get("id").and_then(Value::as_u64) == Some(id)
            && (value.get("result").is_some() || value.get("error").is_some())
        {
            last = Some(value);
        }
    }
    last.ok_or_else(|| "MCP 响应中没有匹配的 JSON-RPC 结果".to_string())
}

/// Short-lived session: initialize, then mark the client initialized.
async fn open(
    client: &reqwest::Client,
    url: &str,
    token: Option<&str>,
) -> Result<SessionOwned, String> {
    let mut session = SessionOwned::new(client, url, token);
    session
        .request(
            1,
            "initialize",
            json!({
                "protocolVersion": "2025-03-26",
                "capabilities": {},
                "clientInfo": { "name": "notes-app", "version": "0.1.0" },
            }),
        )
        .await?;
    session.notify("notifications/initialized", json!({})).await;
    Ok(session)
}

/// Owned-string variant so the session can outlive its constructor arguments.
struct SessionOwned {
    client: reqwest::Client,
    url: String,
    token: Option<String>,
    session_id: Option<String>,
}

impl SessionOwned {
    fn new(client: &reqwest::Client, url: &str, token: Option<&str>) -> Self {
        Self {
            client: client.clone(),
            url: url.to_string(),
            token: token.map(str::to_string),
            session_id: None,
        }
    }

    async fn request(&mut self, id: u64, method: &str, params: Value) -> Result<Value, String> {
        let body = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
        let mut request = self
            .client
            .post(&self.url)
            .header("content-type", "application/json")
            .header("accept", "application/json, text/event-stream")
            .timeout(RPC_TIMEOUT)
            .json(&body);
        if let Some(token) = &self.token {
            request = request.bearer_auth(token);
        }
        if let Some(session) = &self.session_id {
            request = request.header("mcp-session-id", session);
        }
        let response = request
            .send()
            .await
            .map_err(|e| format!("MCP 网络请求失败：{e}"))?;
        if let Some(session) = response
            .headers()
            .get("mcp-session-id")
            .and_then(|value| value.to_str().ok())
        {
            self.session_id = Some(session.to_string());
        }
        let status = response.status();
        let text = response
            .text()
            .await
            .map_err(|e| format!("读取 MCP 响应失败：{e}"))?;
        if !status.is_success() {
            let snippet: String = text.chars().take(200).collect();
            return Err(format!("MCP 服务器返回 HTTP {status}：{snippet}"));
        }
        let payload = parse_rpc_payload(&text, id)?;
        if let Some(error) = payload.get("error") {
            let message = error
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("未知错误");
            return Err(format!("MCP 错误：{message}"));
        }
        payload
            .get("result")
            .cloned()
            .ok_or_else(|| "MCP 响应缺少 result".to_string())
    }

    async fn notify(&mut self, method: &str, params: Value) {
        let body = json!({ "jsonrpc": "2.0", "method": method, "params": params });
        let mut request = self
            .client
            .post(&self.url)
            .header("content-type", "application/json")
            .header("accept", "application/json, text/event-stream")
            .timeout(RPC_TIMEOUT)
            .json(&body);
        if let Some(token) = &self.token {
            request = request.bearer_auth(token);
        }
        if let Some(session) = &self.session_id {
            request = request.header("mcp-session-id", session);
        }
        let _ = request.send().await;
    }
}

fn tools_from_result(result: &Value, server: &McpServer) -> Vec<McpTool> {
    let Some(items) = result.get("tools").and_then(Value::as_array) else {
        return Vec::new();
    };
    items
        .iter()
        .filter_map(|item| {
            let name = item.get("name").and_then(Value::as_str)?.trim();
            if name.is_empty() || name.chars().count() > MAX_TOOL_NAME_CHARS {
                return None;
            }
            Some(McpTool {
                server_id: server.id.clone(),
                server_label: server.label.clone(),
                name: name.to_string(),
                qualified: qualified_name(&server.id, name),
                description: item
                    .get("description")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
                input_schema: item
                    .get("inputSchema")
                    .cloned()
                    .unwrap_or_else(|| json!({ "type": "object", "properties": {} })),
            })
        })
        .collect()
}

fn qualified_name(server_id: &str, tool: &str) -> String {
    let server = server_id.replace('-', "_");
    let tool: String = tool
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '.' {
                c
            } else {
                '_'
            }
        })
        .collect();
    let name = format!("mcp_{server}_{tool}");
    name.chars().take(128).collect()
}

/// List tools from one server; used by the settings page and the agent loader.
pub async fn fetch_tools(
    state: &AgentState,
    server: &McpServer,
    token: Option<&str>,
) -> Result<Vec<McpTool>, String> {
    let Some(client) = &state.client else {
        return Err("HTTP 客户端初始化失败，请重启应用".to_string());
    };
    let mut session = open(client, &server.url, token).await?;
    let result = session.request(2, "tools/list", json!({})).await?;
    Ok(tools_from_result(&result, server))
}

/// Call one tool after verifying it is advertised by the server.
pub async fn call_tool(
    state: &AgentState,
    server: &McpServer,
    token: Option<&str>,
    tool: &str,
    arguments: &Value,
) -> Result<String, String> {
    let size = serde_json::to_vec(arguments)
        .map_err(|e| format!("MCP 参数序列化失败：{e}"))?
        .len();
    if size > MAX_ARG_BYTES {
        return Err(format!("MCP 参数超过 {MAX_ARG_BYTES} 字节"));
    }
    if !arguments.is_object() {
        return Err("MCP 参数必须是 JSON 对象".to_string());
    }
    let Some(client) = &state.client else {
        return Err("HTTP 客户端初始化失败，请重启应用".to_string());
    };
    let mut session = open(client, &server.url, token).await?;
    let listed = session.request(2, "tools/list", json!({})).await?;
    let tools = tools_from_result(&listed, server);
    if !tools.iter().any(|item| item.name == tool) {
        return Err(format!("MCP 服务器没有声明工具：{tool}"));
    }
    let result = session
        .request(
            3,
            "tools/call",
            json!({ "name": tool, "arguments": arguments }),
        )
        .await?;
    render_call_result(&result)
}

fn render_call_result(result: &Value) -> Result<String, String> {
    let mut parts: Vec<String> = Vec::new();
    if let Some(content) = result.get("content").and_then(Value::as_array) {
        for item in content {
            match item.get("type").and_then(Value::as_str).unwrap_or("") {
                "text" => {
                    if let Some(text) = item.get("text").and_then(Value::as_str) {
                        parts.push(text.to_string());
                    }
                }
                "image" => parts.push("[图片结果]".to_string()),
                other => parts.push(format!("[{other}]")),
            }
        }
    }
    if let Some(structured) = result.get("structuredContent") {
        parts.push(serde_json::to_string(structured).unwrap_or_default());
    }
    if parts.is_empty() {
        parts.push(serde_json::to_string(result).unwrap_or_default());
    }
    let text = parts.join("\n");
    if result.get("isError").and_then(Value::as_bool) == Some(true) {
        return Err(text);
    }
    Ok(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn qualified_names_are_sanitized_and_prefixed() {
        assert_eq!(
            qualified_name("mcp_1", "search docs"),
            "mcp_mcp_1_search_docs"
        );
        assert_eq!(qualified_name("srv-2", "a.b"), "mcp_srv_2_a.b");
    }

    #[test]
    fn sse_payload_picks_the_matching_response() {
        let body =
            "event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"ok\":true}}\n\n";
        let value = parse_rpc_payload(body, 1).unwrap();
        assert_eq!(value["result"]["ok"], true);
        assert!(parse_rpc_payload(body, 2).is_err());
    }

    #[test]
    fn call_results_join_text_and_flag_errors() {
        let ok = json!({"content": [{"type": "text", "text": "hello"}]});
        assert_eq!(render_call_result(&ok).unwrap(), "hello");
        let failed = json!({"content": [{"type": "text", "text": "bad"}], "isError": true});
        assert!(render_call_result(&failed).is_err());
    }
}
