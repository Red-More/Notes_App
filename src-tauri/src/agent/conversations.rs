//! 会话与消息持久化：`life.db` 的 `conversations` / `messages` 表。
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
/// Per-message attachment cap; matches the chat composer guard.
const MAX_IMAGES_PER_MESSAGE: usize = 8;

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
    /// Last persisted message time; NULL means the conversation is still empty
    /// and must stay out of the list.
    pub last_message_at: Option<String>,
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
    /// Agent run that owns/produced this row.
    pub run_id: Option<i64>,
    /// JSON arguments of a tool call, kept so history can restore the card.
    pub tool_args: Option<String>,
    pub tool_duration_ms: Option<i64>,
    /// True when the reply was cut short by a cancel/interruption.
    pub is_partial: bool,
    /// stop | aborted | error, when recorded.
    pub stop_reason: Option<String>,
    /// Non-null marks this user row as guidance injected into that run.
    pub steer_of_run: Option<i64>,
    /// Image assets attached to a user message (empty for other rows).
    pub image_asset_ids: Vec<i64>,
    pub created_at: String,
}

/// 追加消息的入参。
#[derive(Debug, Clone, Default, Deserialize)]
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
    pub run_id: Option<i64>,
    #[serde(default)]
    pub tool_args: Option<String>,
    #[serde(default)]
    pub tool_duration_ms: Option<i64>,
    #[serde(default)]
    pub is_partial: bool,
    #[serde(default)]
    pub stop_reason: Option<String>,
    #[serde(default)]
    pub steer_of_run: Option<i64>,
    #[serde(default)]
    pub image_asset_ids: Vec<i64>,
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

/// 列出已有消息的会话，最近更新在前。
///
/// 空会话（创建后首条消息尚未落库）永远不进入列表，因此冷启动、杀进程
/// 或任意异常退出都不会留下占位项。
pub fn list(vfs: &VirtualFs) -> Result<Vec<Conversation>, ToolError> {
    let conn = vfs.conn();
    let mut stmt = conn.prepare(
        "SELECT c.id, c.title, c.provider, c.model, c.created_at, c.updated_at,
                c.last_message_at,
                (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id)
         FROM conversations c
         WHERE c.last_message_at IS NOT NULL
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
            last_message_at: r.get(6)?,
            message_count: r.get(7)?,
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
    insert_on(vfs.conn(), title, provider, model)
}

/// Insert a conversation row. Shared by `create` and the atomic
/// "first run + conversation" transaction in `runs::start_new`.
pub(crate) fn insert_on(
    conn: &Connection,
    title: Option<String>,
    provider: String,
    model: String,
) -> Result<Conversation, ToolError> {
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
    let id = conn.last_insert_rowid();
    Ok(Conversation {
        id,
        title,
        provider,
        model,
        created_at: at.clone(),
        updated_at: at,
        last_message_at: None,
        message_count: 0,
    })
}

/// Bind one conversation to another model entry (in-place model switching).
///
/// `updated_at` is left untouched: it orders the sidebar by activity, and a
/// model switch alone is not a transcript change.
pub fn set_model(vfs: &VirtualFs, id: i64, provider: &str) -> Result<Conversation, ToolError> {
    let conn = vfs.conn();
    let entry = crate::agent::model_store::resolve(conn, provider)?;
    let changed = conn.execute(
        "UPDATE conversations SET provider = ?1, model = ?2 WHERE id = ?3",
        params![entry.id, entry.model_id, id],
    )?;
    if changed == 0 {
        return Err(ToolError::NotFound {
            path: format!("conversation#{id}"),
        });
    }
    conversation_row(conn, id)
}

/// Read one conversation row; `last_message_at` stays NULL for empty drafts.
fn conversation_row(conn: &Connection, id: i64) -> Result<Conversation, ToolError> {
    conn.query_row(
        "SELECT c.id, c.title, c.provider, c.model, c.created_at, c.updated_at,
                c.last_message_at,
                (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id)
         FROM conversations c WHERE c.id = ?1",
        params![id],
        |r| {
            Ok(Conversation {
                id: r.get(0)?,
                title: r.get(1)?,
                provider: r.get(2)?,
                model: r.get(3)?,
                created_at: r.get(4)?,
                updated_at: r.get(5)?,
                last_message_at: r.get(6)?,
                message_count: r.get(7)?,
            })
        },
    )
    .optional()?
    .ok_or_else(|| ToolError::NotFound {
        path: format!("conversation#{id}"),
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

/// Columns selected for every `ChatMessage` read; keep in sync with `row_to_message`.
const MESSAGE_COLUMNS: &str = "id, role, content, tool_calls, tool_call_id, tool_name, is_error,
    created_at, usage_input, usage_output, usage_total, usage_cache_read, usage_cache_write,
    thinking, thinking_signature, run_id, tool_args, tool_duration_ms,
    is_partial, stop_reason, steer_of_run, image_asset_ids";

/// 读取一条会话的消息，按 id 升序。
pub fn messages(vfs: &VirtualFs, conversation_id: i64) -> Result<Vec<ChatMessage>, ToolError> {
    let conn = vfs.conn();
    ensure_exists(conn, conversation_id)?;
    let mut stmt = conn.prepare(&format!(
        "SELECT {MESSAGE_COLUMNS} FROM messages WHERE conversation_id = ?1 ORDER BY id ASC"
    ))?;
    let rows = stmt.query_map(params![conversation_id], row_to_message)?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

/// First user message owned by a run; used by the queue view.
pub fn message_for_run(conn: &Connection, run_id: i64) -> Result<Option<ChatMessage>, ToolError> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {MESSAGE_COLUMNS} FROM messages
         WHERE run_id = ?1 AND role = 'user' ORDER BY id ASC LIMIT 1"
    ))?;
    let row = stmt.query_row(params![run_id], row_to_message).optional()?;
    Ok(row)
}

/// Advance the conversation clocks after a message is written. A non-NULL
/// `last_message_at` is what makes the conversation visible in the list.
pub(crate) fn touch_message_clock(
    conn: &Connection,
    conversation_id: i64,
    at: &str,
) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE conversations SET updated_at = ?1, last_message_at = ?1 WHERE id = ?2",
        params![at, conversation_id],
    )?;
    Ok(())
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
    let tx = conn.unchecked_transaction()?;
    let mut inserted = Vec::new();
    for item in items {
        inserted.push(insert_message(&tx, conversation_id, item, &at)?);
    }
    touch_message_clock(&tx, conversation_id, &at)?;
    tx.commit()?;
    Ok(inserted)
}

/// Validate and insert one message. Shared by `append` and the run ledger.
pub fn insert_message(
    tx: &Connection,
    conversation_id: i64,
    item: NewMessage,
    at: &str,
) -> Result<ChatMessage, ToolError> {
    validate_role(&item.role)?;
    if item.content.len() > MAX_MESSAGE_BYTES {
        return Err(ToolError::invalid("单条消息超过 1MB 上限"));
    }
    if let Some(calls) = &item.tool_calls {
        if calls.len() > MAX_MESSAGE_BYTES {
            return Err(ToolError::invalid("工具调用记录过大"));
        }
    }
    if item.image_asset_ids.len() > MAX_IMAGES_PER_MESSAGE {
        return Err(ToolError::invalid(format!(
            "单条消息最多 {MAX_IMAGES_PER_MESSAGE} 张图片"
        )));
    }
    // Only user turns may carry images; assistant replies are text/tool only.
    if !item.image_asset_ids.is_empty() && item.role != "user" {
        return Err(ToolError::invalid("只有用户消息可以携带图片"));
    }
    let image_ids = if item.image_asset_ids.is_empty() {
        None
    } else {
        Some(serde_json::to_string(&item.image_asset_ids).map_err(|e| ToolError::Storage {
            message: format!("图片引用序列化失败：{e}"),
        })?)
    };
    tx.execute(
        "INSERT INTO messages
             (conversation_id, role, content, tool_calls, tool_call_id, tool_name, is_error,
              usage_input, usage_output, usage_total, usage_cache_read, usage_cache_write,
              thinking, thinking_signature, run_id, tool_args,
              tool_duration_ms, is_partial, stop_reason, steer_of_run, image_asset_ids,
              created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16,
                 ?17, ?18, ?19, ?20, ?21, ?22)",
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
            item.run_id,
            item.tool_args,
            item.tool_duration_ms,
            if item.is_partial { 1 } else { 0 },
            item.stop_reason,
            item.steer_of_run,
            image_ids,
            at
        ],
    )?;
    Ok(ChatMessage {
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
        run_id: item.run_id,
        tool_args: item.tool_args,
        tool_duration_ms: item.tool_duration_ms,
        is_partial: item.is_partial,
        stop_reason: item.stop_reason,
        steer_of_run: item.steer_of_run,
        image_asset_ids: item.image_asset_ids,
        created_at: at.to_string(),
    })
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
    delete_messages(vfs, conversation_id, message_id, false)
}

/// Delete `message_id` itself and every newer message; edit rewrites that turn.
pub fn truncate_from(
    vfs: &VirtualFs,
    conversation_id: i64,
    message_id: i64,
) -> Result<usize, ToolError> {
    delete_messages(vfs, conversation_id, message_id, true)
}

fn delete_messages(
    vfs: &VirtualFs,
    conversation_id: i64,
    message_id: i64,
    inclusive: bool,
) -> Result<usize, ToolError> {
    let conn = vfs.conn();
    ensure_exists(conn, conversation_id)?;
    let at = now(conn)?;
    let tx = conn.unchecked_transaction()?;
    let removed = if inclusive {
        tx.execute(
            "DELETE FROM messages WHERE conversation_id = ?1 AND id >= ?2",
            params![conversation_id, message_id],
        )?
    } else {
        tx.execute(
            "DELETE FROM messages WHERE conversation_id = ?1 AND id > ?2",
            params![conversation_id, message_id],
        )?
    };
    tx.execute(
        "UPDATE conversations
         SET updated_at = ?1,
             last_message_at = (SELECT MAX(created_at) FROM messages
                                WHERE conversation_id = ?2)
         WHERE id = ?2",
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
        run_id: r.get(15)?,
        tool_args: r.get(16)?,
        tool_duration_ms: r.get(17)?,
        is_partial: r.get::<_, Option<i64>>(18)?.unwrap_or(0) != 0,
        stop_reason: r.get(19)?,
        steer_of_run: r.get(20)?,
        image_asset_ids: r
            .get::<_, Option<String>>(21)?
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_default(),
        created_at: r.get(7)?,
    })
}
