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
// JSON-RPC over Streamable HTTP + legacy HTTP+SSE
// ---------------------------------------------------------------------------

/// Protocol version this client asks for; the server may negotiate another one.
const INITIALIZE_PROTOCOL_VERSION: &str = "2025-03-26";

/// Structured MCP failure. Keeping the HTTP status and whether the request was
/// session-bound lets retries target a forgotten session instead of guessing
/// from error text.
#[derive(Debug, Clone)]
struct McpError {
    message: String,
    status: Option<u16>,
    /// True after the session was established (a session id was issued, or the
    /// SSE endpoint handshake completed).
    session_bound: bool,
}

impl McpError {
    fn transport(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            status: None,
            session_bound: false,
        }
    }

    fn rpc(message: impl Into<String>, session_bound: bool) -> Self {
        Self {
            message: message.into(),
            status: None,
            session_bound,
        }
    }

    fn http(status: reqwest::StatusCode, text: &str, session_bound: bool) -> Self {
        Self {
            message: http_status_message(status, text),
            status: Some(status.as_u16()),
            session_bound,
        }
    }
}

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
        if rpc_id_matches(&value, id)
            && (value.get("result").is_some() || value.get("error").is_some())
        {
            last = Some(value);
        }
    }
    last.ok_or_else(|| "MCP 响应中没有匹配的 JSON-RPC 结果".to_string())
}

fn rpc_body(id: Option<u64>, method: &str, params: Value) -> Value {
    match id {
        Some(id) => json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }),
        None => json!({ "jsonrpc": "2.0", "method": method, "params": params }),
    }
}

/// JSON-RPC ids may be echoed back as numbers or strings; accept both.
fn rpc_id_matches(payload: &Value, id: u64) -> bool {
    match payload.get("id") {
        Some(value) => value.as_u64() == Some(id) || value.as_str() == Some(&id.to_string()),
        None => false,
    }
}

fn rpc_result(payload: Value, session_bound: bool) -> Result<Value, McpError> {
    if let Some(error) = payload.get("error") {
        let message = error
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("未知错误");
        return Err(McpError::rpc(format!("MCP 错误：{message}"), session_bound));
    }
    payload
        .get("result")
        .cloned()
        .ok_or_else(|| McpError::rpc("MCP 响应缺少 result", session_bound))
}

fn initialize_params() -> Value {
    json!({
        "protocolVersion": INITIALIZE_PROTOCOL_VERSION,
        "capabilities": {},
        "clientInfo": { "name": "notes-app", "version": "0.1.0" },
    })
}

/// Turn a non-success HTTP response into an actionable error. 410 usually means
/// the endpoint itself (often a signed or temporary URL) is no longer valid.
fn http_status_message(status: reqwest::StatusCode, text: &str) -> String {
    let snippet: String = text.chars().take(200).collect();
    if status == reqwest::StatusCode::GONE {
        return format!(
            "MCP 服务器返回 HTTP 410 Gone：{snippet}。该服务器地址可能已过期或已停用，请在服务提供方重新生成地址后，编辑该 MCP 服务器。"
        );
    }
    format!("MCP 服务器返回 HTTP {status}：{snippet}")
}

/// Only a 404/410 on a request that already carried a session can mean the
/// server forgot the session. Initialize failures are configuration errors.
fn is_retryable_session_error(error: &McpError) -> bool {
    error.session_bound && matches!(error.status, Some(404) | Some(410))
}

/// Legacy SSE endpoints (`.../sse`) expect GET + an `endpoint` event first.
fn uses_legacy_sse(url: &str) -> bool {
    url::Url::parse(url)
        .map(|parsed| {
            parsed
                .path()
                .trim_end_matches('/')
                .to_ascii_lowercase()
                .ends_with("/sse")
        })
        .unwrap_or(false)
}

/// A POST rejected with these statuses usually means the URL is an SSE endpoint.
fn should_fallback_to_sse(error: &McpError) -> bool {
    matches!(error.status, Some(405 | 406 | 415))
}

/// Resolve the message endpoint announced on the SSE stream and keep the same
/// SSRF boundary (HTTPS, public host, no credentials) while allowing the
/// session query string the server itself issued.
fn resolve_sse_endpoint(base: &str, endpoint: &str) -> Result<String, McpError> {
    let base_url =
        url::Url::parse(base).map_err(|e| McpError::transport(format!("MCP 地址解析失败：{e}")))?;
    let joined = base_url
        .join(endpoint.trim())
        .map_err(|e| McpError::transport(format!("MCP SSE 消息地址解析失败：{e}")))?;
    model_store::validate_public_https(&joined).map_err(|e| McpError::transport(e.to_string()))?;
    // Pin the message endpoint to the server's own host: an announced
    // cross-host URL would leak the bearer token to a third party.
    if joined.host_str() != base_url.host_str() {
        return Err(McpError::transport("MCP SSE 消息地址必须与服务器同主机"));
    }
    if joined.fragment().is_some() {
        return Err(McpError::transport("MCP SSE 消息地址不能包含片段"));
    }
    Ok(joined.to_string())
}

/// Pull one complete SSE event out of the byte buffer.
fn take_sse_event(buffer: &mut Vec<u8>) -> Option<(String, String)> {
    loop {
        let lf = buffer.windows(2).position(|w| w == b"\n\n".as_slice());
        let crlf = buffer.windows(4).position(|w| w == b"\r\n\r\n".as_slice());
        let (pos, separator) = match (lf, crlf) {
            (Some(a), Some(b)) => {
                if a <= b {
                    (a, 2)
                } else {
                    (b, 4)
                }
            }
            (Some(a), None) => (a, 2),
            (None, Some(b)) => (b, 4),
            (None, None) => return None,
        };
        let event_bytes: Vec<u8> = buffer.drain(..pos + separator).collect();
        let text = String::from_utf8_lossy(&event_bytes[..pos]);
        let mut event = "message".to_string();
        let mut data: Vec<String> = Vec::new();
        for line in text.lines() {
            let line = line.trim_end_matches('\r');
            if let Some(value) = line.strip_prefix("event:") {
                event = value.trim().to_string();
            } else if let Some(value) = line.strip_prefix("data:") {
                data.push(value.strip_prefix(' ').unwrap_or(value).to_string());
            }
        }
        if data.is_empty() {
            // Keep-alive comments have no data; skip and parse the next event.
            continue;
        }
        return Some((event, data.join("\n")));
    }
}

/// Streamable HTTP session: initialize, then send the follow-up request.
struct SessionOwned {
    client: reqwest::Client,
    url: String,
    token: Option<String>,
    session_id: Option<String>,
    protocol_version: String,
}

impl SessionOwned {
    fn new(client: &reqwest::Client, url: &str, token: Option<&str>) -> Self {
        Self {
            client: client.clone(),
            url: url.to_string(),
            token: token.map(str::to_string),
            session_id: None,
            protocol_version: String::new(),
        }
    }

    async fn open(
        client: &reqwest::Client,
        url: &str,
        token: Option<&str>,
    ) -> Result<Self, McpError> {
        let mut session = Self::new(client, url, token);
        let result = session
            .request(1, "initialize", initialize_params())
            .await?;
        session.protocol_version = result
            .get("protocolVersion")
            .and_then(Value::as_str)
            .unwrap_or(INITIALIZE_PROTOCOL_VERSION)
            .to_string();
        session.notify("notifications/initialized", json!({})).await;
        Ok(session)
    }

    fn apply_headers(&self, mut request: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        if let Some(token) = &self.token {
            request = request.bearer_auth(token);
        }
        if let Some(session) = &self.session_id {
            request = request.header("mcp-session-id", session);
        }
        if !self.protocol_version.is_empty() {
            request = request.header("mcp-protocol-version", &self.protocol_version);
        }
        request
    }

    async fn request(&mut self, id: u64, method: &str, params: Value) -> Result<Value, McpError> {
        // Only requests that already carry a session id can reveal a session
        // the server has forgotten; initialize itself is always session-free.
        let session_bound = self.session_id.is_some();
        let body = rpc_body(Some(id), method, params);
        let request = self
            .client
            .post(&self.url)
            .header("content-type", "application/json")
            .header("accept", "application/json, text/event-stream")
            .timeout(RPC_TIMEOUT)
            .json(&body);
        let response = self
            .apply_headers(request)
            .send()
            .await
            .map_err(|e| McpError::transport(format!("MCP 网络请求失败：{e}")))?;
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
            .map_err(|e| McpError::transport(format!("读取 MCP 响应失败：{e}")))?;
        if !status.is_success() {
            return Err(McpError::http(status, &text, session_bound));
        }
        let payload = parse_rpc_payload(&text, id)
            .map_err(|message| McpError::rpc(message, session_bound))?;
        rpc_result(payload, session_bound)
    }

    async fn notify(&mut self, method: &str, params: Value) {
        let body = rpc_body(None, method, params);
        let request = self
            .client
            .post(&self.url)
            .header("content-type", "application/json")
            .header("accept", "application/json, text/event-stream")
            .timeout(RPC_TIMEOUT)
            .json(&body);
        let _ = self.apply_headers(request).send().await;
    }
}

/// Legacy HTTP+SSE session: GET the stream, read the announced endpoint, then
/// POST JSON-RPC messages there and read responses from the stream.
struct SseSession {
    client: reqwest::Client,
    response: reqwest::Response,
    buffer: Vec<u8>,
    post_url: String,
    token: Option<String>,
    protocol_version: String,
}

impl SseSession {
    async fn open(
        client: &reqwest::Client,
        url: &str,
        token: Option<&str>,
    ) -> Result<Self, McpError> {
        // No request timeout on the stream: reqwest's timeout covers the whole
        // body and would kill a healthy long-lived SSE connection. Idle time is
        // bounded per event inside `next_event` instead.
        let mut request = client
            .get(url)
            .header("accept", "text/event-stream");
        if let Some(token) = token {
            request = request.bearer_auth(token);
        }
        let response = request
            .send()
            .await
            .map_err(|e| McpError::transport(format!("MCP 网络请求失败：{e}")))?;
        let status = response.status();
        if !status.is_success() {
            let text = response.text().await.unwrap_or_default();
            return Err(McpError::http(status, &text, false));
        }
        let mut session = Self {
            client: client.clone(),
            response,
            buffer: Vec::new(),
            post_url: String::new(),
            token: token.map(str::to_string),
            protocol_version: String::new(),
        };
        let endpoint = session.read_endpoint().await?;
        session.post_url = resolve_sse_endpoint(url, &endpoint)?;
        Ok(session)
    }

    async fn next_event(&mut self) -> Result<Option<(String, String)>, McpError> {
        loop {
            if let Some(event) = take_sse_event(&mut self.buffer) {
                return Ok(Some(event));
            }
            let chunk = tokio::time::timeout(RPC_TIMEOUT, self.response.chunk())
                .await
                .map_err(|_| McpError::transport("MCP SSE 读取超时"))?
                .map_err(|e| McpError::transport(format!("读取 MCP SSE 响应失败：{e}")))?;
            match chunk {
                Some(bytes) => self.buffer.extend_from_slice(&bytes),
                None => return Ok(None),
            }
        }
    }

    async fn read_endpoint(&mut self) -> Result<String, McpError> {
        loop {
            let Some((event, data)) = self.next_event().await? else {
                return Err(McpError::transport("MCP SSE 连接在返回消息地址前已关闭"));
            };
            if event == "endpoint" {
                return Ok(data);
            }
        }
    }

    fn apply_headers(&self, mut request: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        if let Some(token) = &self.token {
            request = request.bearer_auth(token);
        }
        if !self.protocol_version.is_empty() {
            request = request.header("mcp-protocol-version", &self.protocol_version);
        }
        request
    }

    async fn post(&self, body: &Value) -> Result<(reqwest::StatusCode, String), McpError> {
        let request = self
            .client
            .post(&self.post_url)
            .header("content-type", "application/json")
            .header("accept", "application/json, text/event-stream")
            .timeout(RPC_TIMEOUT)
            .json(body);
        let response = self
            .apply_headers(request)
            .send()
            .await
            .map_err(|e| McpError::transport(format!("MCP 网络请求失败：{e}")))?;
        let status = response.status();
        let text = response
            .text()
            .await
            .map_err(|e| McpError::transport(format!("读取 MCP 响应失败：{e}")))?;
        Ok((status, text))
    }

    async fn request(&mut self, id: u64, method: &str, params: Value) -> Result<Value, McpError> {
        // The SSE endpoint handshake already completed, so a 404/410 here is a
        // stale session URL that is worth one fresh handshake.
        let session_bound = true;
        let body = rpc_body(Some(id), method, params);
        let (status, text) = self.post(&body).await?;
        if !status.is_success() {
            return Err(McpError::http(status, &text, session_bound));
        }
        // Some servers reply inline; the legacy transport replies over the stream.
        if !text.trim().is_empty() {
            if let Ok(payload) = parse_rpc_payload(&text, id) {
                return rpc_result(payload, session_bound);
            }
        }
        loop {
            let Some((event, data)) = self.next_event().await? else {
                return Err(McpError::transport("MCP SSE 连接已关闭"));
            };
            if event != "message" {
                continue;
            }
            let Ok(payload) = serde_json::from_str::<Value>(&data) else {
                continue;
            };
            if rpc_id_matches(&payload, id) {
                return rpc_result(payload, session_bound);
            }
        }
    }

    async fn notify(&mut self, method: &str, params: Value) {
        let body = rpc_body(None, method, params);
        let _ = self.post(&body).await;
    }

    async fn initialize(&mut self) -> Result<(), McpError> {
        let result = self.request(1, "initialize", initialize_params()).await?;
        self.protocol_version = result
            .get("protocolVersion")
            .and_then(Value::as_str)
            .unwrap_or(INITIALIZE_PROTOCOL_VERSION)
            .to_string();
        self.notify("notifications/initialized", json!({})).await;
        Ok(())
    }
}

enum McpSession {
    Streamable(SessionOwned),
    Sse(SseSession),
}

impl McpSession {
    async fn open(
        client: &reqwest::Client,
        url: &str,
        token: Option<&str>,
    ) -> Result<Self, McpError> {
        if uses_legacy_sse(url) {
            let mut session = SseSession::open(client, url, token).await?;
            session.initialize().await?;
            return Ok(Self::Sse(session));
        }
        match SessionOwned::open(client, url, token).await {
            Ok(session) => Ok(Self::Streamable(session)),
            Err(error) if should_fallback_to_sse(&error) => {
                // A POST-rejected endpoint is often a legacy SSE one.
                let mut session = SseSession::open(client, url, token).await?;
                session.initialize().await?;
                Ok(Self::Sse(session))
            }
            Err(error) => Err(error),
        }
    }

    async fn request(&mut self, id: u64, method: &str, params: Value) -> Result<Value, McpError> {
        match self {
            Self::Streamable(session) => session.request(id, method, params).await,
            Self::Sse(session) => session.request(id, method, params).await,
        }
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
    match fetch_tools_once(client, server, token).await {
        // Only a session-bound 404/410 can mean the server forgot the session;
        // initialize failures and non-HTTP errors are configuration problems.
        Err(error) if is_retryable_session_error(&error) => {
            log::warn!(
                "mcp server {} session expired, retrying: {}",
                server.id,
                error.message
            );
            fetch_tools_once(client, server, token)
                .await
                .map_err(|error| error.message)
        }
        result => result.map_err(|error| error.message),
    }
}

async fn fetch_tools_once(
    client: &reqwest::Client,
    server: &McpServer,
    token: Option<&str>,
) -> Result<Vec<McpTool>, McpError> {
    let mut session = McpSession::open(client, &server.url, token).await?;
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
    let mut session = McpSession::open(client, &server.url, token)
        .await
        .map_err(|error| error.message)?;
    let listed = session
        .request(2, "tools/list", json!({}))
        .await
        .map_err(|error| error.message)?;
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
        .await
        .map_err(|error| error.message)?;
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

    #[test]
    fn legacy_sse_urls_are_detected_by_path() {
        assert!(uses_legacy_sse("https://example.com/sse"));
        assert!(uses_legacy_sse("https://example.com/mcp/sse/"));
        assert!(!uses_legacy_sse("https://example.com/mcp"));
        assert!(!uses_legacy_sse("not a url"));
    }

    #[test]
    fn sse_events_parse_endpoint_and_crlf_bodies() {
        let mut buffer = b"event: endpoint\ndata: /messages?sessionId=abc\n\n".to_vec();
        assert_eq!(
            take_sse_event(&mut buffer),
            Some((
                "endpoint".to_string(),
                "/messages?sessionId=abc".to_string()
            ))
        );
        assert!(buffer.is_empty());

        // CRLF separators and multi-line data are both valid SSE framing.
        let mut crlf =
            b"event: message\r\ndata: {\"id\":1,\r\ndata: \"result\":{}}\r\n\r\n".to_vec();
        assert_eq!(
            take_sse_event(&mut crlf),
            Some((
                "message".to_string(),
                "{\"id\":1,\n\"result\":{}}".to_string()
            ))
        );
    }

    #[test]
    fn sse_message_endpoints_keep_the_public_https_boundary() {
        let resolved =
            resolve_sse_endpoint("https://mcp.example.com/sse", "/messages?sessionId=abc").unwrap();
        assert_eq!(resolved, "https://mcp.example.com/messages?sessionId=abc");
        assert!(
            resolve_sse_endpoint("https://mcp.example.com/sse", "http://localhost/messages")
                .is_err()
        );
        assert!(
            resolve_sse_endpoint("https://mcp.example.com/sse", "https://127.0.0.1/messages")
                .is_err()
        );
        // A cross-host announcement would leak the bearer token to a third party.
        assert!(
            resolve_sse_endpoint("https://mcp.example.com/sse", "https://evil.example/messages")
                .is_err()
        );
    }

    #[test]
    fn numeric_and_string_echoed_ids_both_match() {
        assert!(rpc_id_matches(&json!({ "id": 7 }), 7));
        assert!(rpc_id_matches(&json!({ "id": "7" }), 7));
        assert!(!rpc_id_matches(&json!({ "id": "8" }), 7));
        assert!(!rpc_id_matches(&json!({}), 7));
    }

    #[test]
    fn gone_responses_point_users_to_a_fresh_url() {
        let message = http_status_message(reqwest::StatusCode::GONE, "URL is Expired.");
        assert!(message.contains("HTTP 410 Gone"));
        assert!(message.contains("重新生成地址"));
    }

    #[test]
    fn retries_only_apply_to_session_bound_404_or_410() {
        // Initialize carries no session id: a 404 there is a configuration error.
        let initialize_404 = McpError::http(reqwest::StatusCode::NOT_FOUND, "missing", false);
        assert!(!is_retryable_session_error(&initialize_404));

        // A follow-up request that carried a session id may be recovered.
        let expired_session = McpError::http(reqwest::StatusCode::GONE, "gone", true);
        assert!(is_retryable_session_error(&expired_session));
        let forgotten_session = McpError::http(reqwest::StatusCode::NOT_FOUND, "gone", true);
        assert!(is_retryable_session_error(&forgotten_session));

        // Other statuses and plain text that merely mentions HTTP 404 never retry.
        let server_error = McpError::http(reqwest::StatusCode::INTERNAL_SERVER_ERROR, "boom", true);
        assert!(!is_retryable_session_error(&server_error));
        let misleading_text = McpError::transport("upstream said HTTP 404 for a tool");
        assert!(!is_retryable_session_error(&misleading_text));
    }
}
