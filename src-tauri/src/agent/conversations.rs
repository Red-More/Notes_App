//! 会话与消息持久化：`life.db` 的 `conversations` / `messages` 表（schema v3 起）。
//!
//! 只被 Agent 与设置页使用，不参与 VirtualFs 的五个工具。

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::vfs::error::ToolError;
use crate::vfs::VirtualFs;

const MAX_TITLE_CHARS: usize = 80;
const MAX_MESSAGE_BYTES: usize = 1024 * 1024;
const MAX_BATCH_MESSAGES: usize = 100;
const MAX_MODEL_CHARS: usize = 100;

/// 会话列表项。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Conversation {
    pub id: i64,
    pub title: String,
    pub provider: String,
    pub model: String,
    pub created_at: String,
    pub updated_at: String,
    pub message_count: i64,
}

/// Token usage for one assistant reply; `None` on older rows.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageUsage {
    pub input: i64,
    pub output: i64,
    pub total_tokens: i64,
    pub cache_read: i64,
    pub cache_write: i64,
}

/// 一条已落库的消息。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    pub id: i64,
    pub role: String,
    pub content: String,
    pub tool_calls: Option<String>,
    pub tool_call_id: Option<String>,
    pub tool_name: Option<String>,
    pub is_error: bool,
    pub usage: Option<MessageUsage>,
    /// Reasoning text and provider signature, when the model exposed them.
    pub thinking: Option<String>,
    pub thinking_signature: Option<String>,
    /// JSON array of media asset ids attached to this user message.
    pub image_asset_ids: Option<String>,
    /// Chat job that produced this assistant reply; `None` for legacy rows.
    pub job_id: Option<i64>,
    pub created_at: String,
}

/// 追加消息的入参。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewMessage {
    pub role: String,
    #[serde(default)]
    pub content: String,
    #[serde(default)]
    pub tool_calls: Option<String>,
    #[serde(default)]
    pub tool_call_id: Option<String>,
    #[serde(default)]
    pub tool_name: Option<String>,
    #[serde(default)]
    pub is_error: bool,
    #[serde(default)]
    pub usage: Option<MessageUsage>,
    #[serde(default)]
    pub thinking: Option<String>,
    #[serde(default)]
    pub thinking_signature: Option<String>,
    #[serde(default)]
    pub image_asset_ids: Option<String>,
    /// Only assistant rows carry a job id; the unique index keeps one row per job.
    #[serde(default)]
    pub job_id: Option<i64>,
}

fn now(conn: &Connection) -> Result<String, ToolError> {
    Ok(conn.query_row("SELECT datetime('now','localtime')", [], |r| r.get(0))?)
}

fn validate_title(title: &str) -> Result<String, ToolError> {
    let trimmed = title.trim();
    if trimmed.chars().count() > MAX_TITLE_CHARS {
        return Err(ToolError::invalid(format!(
            "会话标题超过 {MAX_TITLE_CHARS} 字"
        )));
    }
    Ok(trimmed.to_string())
}

fn validate_role(role: &str) -> Result<(), ToolError> {
    match role {
        "user" | "assistant" | "tool" => Ok(()),
        _ => Err(ToolError::invalid(format!("未知消息角色: {role}"))),
    }
}

/// 列出所有会话，最近更新在前。
pub fn list(vfs: &VirtualFs) -> Result<Vec<Conversation>, ToolError> {
    let conn = vfs.conn();
    let mut stmt = conn.prepare(
        "SELECT c.id, c.title, c.provider, c.model, c.created_at, c.updated_at,
                (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id)
         FROM conversations c
         ORDER BY c.updated_at DESC, c.id DESC",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(Conversation {
            id: r.get(0)?,
            title: r.get(1)?,
            provider: r.get(2)?,
            model: r.get(3)?,
            created_at: r.get(4)?,
            updated_at: r.get(5)?,
            message_count: r.get(6)?,
        })
    })?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

pub fn create(
    vfs: &VirtualFs,
    title: Option<String>,
    provider: String,
    model: String,
) -> Result<Conversation, ToolError> {
    if model.chars().count() > MAX_MODEL_CHARS || model.chars().any(char::is_control) {
        return Err(ToolError::invalid("模型名非法"));
    }
    let entry = crate::agent::model_store::resolve(vfs.conn(), &provider)?;
    if model != entry.model_id {
        return Err(ToolError::invalid("模型与会话配置不一致"));
    }
    let conn = vfs.conn();
    let title = match title {
        Some(t) => {
            let t = validate_title(&t)?;
            if t.is_empty() {
                "新对话".to_string()
            } else {
                t
            }
        }
        None => "新对话".to_string(),
    };
    let at = now(conn)?;
    conn.execute(
        "INSERT INTO conversations (title, provider, model, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?4)",
        params![title, provider, model, at],
    )?;
    let id: i64 = conn.last_insert_rowid();
    Ok(Conversation {
        id,
        title,
        provider,
        model,
        created_at: at.clone(),
        updated_at: at,
        message_count: 0,
    })
}

pub fn rename(vfs: &VirtualFs, id: i64, title: String) -> Result<(), ToolError> {
    let conn = vfs.conn();
    // 与 create 保持一致：空标题回退为默认标题，避免产生空白会话行。
    let mut title = validate_title(&title)?;
    if title.is_empty() {
        title = "新对话".to_string();
    }
    let at = now(conn)?;
    let changed = conn.execute(
        "UPDATE conversations SET title = ?1, updated_at = ?2 WHERE id = ?3",
        params![title, at, id],
    )?;
    if changed == 0 {
        return Err(ToolError::NotFound {
            path: format!("conversation#{id}"),
        });
    }
    Ok(())
}

pub fn delete(vfs: &VirtualFs, id: i64) -> Result<(), ToolError> {
    let conn = vfs.conn();
    let changed = conn.execute("DELETE FROM conversations WHERE id = ?1", params![id])?;
    if changed == 0 {
        return Err(ToolError::NotFound {
            path: format!("conversation#{id}"),
        });
    }
    Ok(())
}

/// 读取一条会话的消息，按 id 升序。
pub fn messages(vfs: &VirtualFs, conversation_id: i64) -> Result<Vec<ChatMessage>, ToolError> {
    let conn = vfs.conn();
    ensure_exists(conn, conversation_id)?;
    let mut stmt = conn.prepare(
        "SELECT id, role, content, tool_calls, tool_call_id, tool_name, is_error, created_at,
                usage_input, usage_output, usage_total, usage_cache_read, usage_cache_write,
                thinking, thinking_signature, image_asset_ids, job_id
         FROM messages WHERE conversation_id = ?1 ORDER BY id ASC",
    )?;
    let rows = stmt.query_map(params![conversation_id], row_to_message)?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

/// 批量追加消息，并推进会话的 updated_at。
pub fn append(
    vfs: &VirtualFs,
    conversation_id: i64,
    items: Vec<NewMessage>,
) -> Result<Vec<ChatMessage>, ToolError> {
    if items.len() > MAX_BATCH_MESSAGES {
        return Err(ToolError::invalid(format!(
            "单次最多追加 {MAX_BATCH_MESSAGES} 条消息"
        )));
    }
    let conn = vfs.conn();
    ensure_exists(conn, conversation_id)?;
    let at = now(conn)?;
    // 先整批校验，避免事务中途失败留下部分消息。
    for item in &items {
        validate_role(&item.role)?;
        if item.content.len() > MAX_MESSAGE_BYTES {
            return Err(ToolError::invalid("单条消息超过 1MB 上限"));
        }
        if let Some(calls) = &item.tool_calls {
            if calls.len() > MAX_MESSAGE_BYTES {
                return Err(ToolError::invalid("工具调用记录过大"));
            }
        }
    }
    // 整批插入 + updated_at 推进放在同一事务里，失败即整体回滚。
    let tx = conn.unchecked_transaction()?;
    let mut inserted = Vec::new();
    for item in items {
        // Only assistant rows own a job; tool rows share the turn but are many.
        let job_id = if item.role == "assistant" {
            item.job_id
        } else {
            None
        };
        tx.execute(
            "INSERT INTO messages
                 (conversation_id, role, content, tool_calls, tool_call_id, tool_name, is_error,
                  usage_input, usage_output, usage_total, usage_cache_read, usage_cache_write,
                  thinking, thinking_signature, image_asset_ids, created_at, job_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)",
            params![
                conversation_id,
                item.role,
                item.content,
                item.tool_calls,
                item.tool_call_id,
                item.tool_name,
                if item.is_error { 1 } else { 0 },
                item.usage.map(|usage| usage.input),
                item.usage.map(|usage| usage.output),
                item.usage.map(|usage| usage.total_tokens),
                item.usage.map(|usage| usage.cache_read),
                item.usage.map(|usage| usage.cache_write),
                item.thinking,
                item.thinking_signature,
                item.image_asset_ids,
                at,
                job_id
            ],
        )?;
        inserted.push(ChatMessage {
            id: tx.last_insert_rowid(),
            role: item.role,
            content: item.content,
            tool_calls: item.tool_calls,
            tool_call_id: item.tool_call_id,
            tool_name: item.tool_name,
            is_error: item.is_error,
            usage: item.usage,
            thinking: item.thinking,
            thinking_signature: item.thinking_signature,
            image_asset_ids: item.image_asset_ids,
            job_id,
            created_at: at.clone(),
        });
    }
    tx.execute(
        "UPDATE conversations SET updated_at = ?1 WHERE id = ?2",
        params![at, conversation_id],
    )?;
    tx.commit()?;
    Ok(inserted)
}

fn ensure_exists(conn: &Connection, id: i64) -> Result<(), ToolError> {
    let exists: Option<i64> = conn
        .query_row(
            "SELECT id FROM conversations WHERE id = ?1",
            params![id],
            |r| r.get(0),
        )
        .optional()?;
    if exists.is_none() {
        return Err(ToolError::NotFound {
            path: format!("conversation#{id}"),
        });
    }
    Ok(())
}

/// Delete every message newer than `message_id`; retry keeps the user turn intact.
pub fn truncate_after(
    vfs: &VirtualFs,
    conversation_id: i64,
    message_id: i64,
) -> Result<usize, ToolError> {
    let conn = vfs.conn();
    ensure_exists(conn, conversation_id)?;
    let at = now(conn)?;
    let tx = conn.unchecked_transaction()?;
    let removed = tx.execute(
        "DELETE FROM messages WHERE conversation_id = ?1 AND id > ?2",
        params![conversation_id, message_id],
    )?;
    tx.execute(
        "UPDATE conversations SET updated_at = ?1 WHERE id = ?2",
        params![at, conversation_id],
    )?;
    tx.commit()?;
    Ok(removed)
}

fn row_to_message(r: &rusqlite::Row<'_>) -> rusqlite::Result<ChatMessage> {
    let input: Option<i64> = r.get(8)?;
    let output: Option<i64> = r.get(9)?;
    let total_tokens: Option<i64> = r.get(10)?;
    let cache_read: Option<i64> = r.get(11)?;
    let cache_write: Option<i64> = r.get(12)?;
    Ok(ChatMessage {
        id: r.get(0)?,
        role: r.get(1)?,
        content: r.get(2)?,
        tool_calls: r.get(3)?,
        tool_call_id: r.get(4)?,
        tool_name: r.get(5)?,
        is_error: r.get::<_, i64>(6)? != 0,
        usage: input.map(|input| MessageUsage {
            input,
            output: output.unwrap_or(0),
            total_tokens: total_tokens.unwrap_or(0),
            cache_read: cache_read.unwrap_or(0),
            cache_write: cache_write.unwrap_or(0),
        }),
        thinking: r.get(13)?,
        thinking_signature: r.get(14)?,
        image_asset_ids: r.get(15)?,
        job_id: r.get(16)?,
        created_at: r.get(7)?,
    })
}
