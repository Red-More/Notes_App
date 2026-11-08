//! Agent run ledger: one row per prompt/steer/resume/retry attempt.
//!
//! The table is the source of truth for what is queued, running or interrupted,
//! so switching pages or restarting the app never loses the user's intent.

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

use super::conversations::{self, ChatMessage, NewMessage};
use crate::vfs::error::ToolError;
use crate::vfs::VirtualFs;

const MAX_PARTIAL_BYTES: usize = 1024 * 1024;

const RUN_COLUMNS: &str = "run_id, conversation_id, status, trigger, model_entry,
    step_count, write_count, last_seq, partial, error_code, resume_from_message_id,
    created_at, updated_at, ended_at";

/// One execution attempt with its progress counters.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRun {
    pub run_id: i64,
    pub conversation_id: i64,
    pub status: String,
    pub trigger: String,
    pub model_entry: String,
    pub step_count: i64,
    pub write_count: i64,
    pub last_seq: i64,
    pub partial: Option<String>,
    pub error_code: Option<String>,
    pub resume_from_message_id: Option<i64>,
    pub created_at: String,
    pub updated_at: String,
    pub ended_at: Option<String>,
}

/// A queued run plus the user message that will start it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueuedRun {
    pub run: AgentRun,
    pub user_message: Option<ChatMessage>,
}

/// Result of starting a run: the ledger row plus its persisted user message.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunStart {
    pub run: AgentRun,
    pub message: Option<ChatMessage>,
}

/// Everything the UI needs to render run state on (re)entry.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunState {
    pub active: Option<AgentRun>,
    pub latest: Option<AgentRun>,
    pub queued: Vec<QueuedRun>,
}

fn now(conn: &Connection) -> Result<String, ToolError> {
    Ok(conn.query_row("SELECT datetime('now','localtime')", [], |r| r.get(0))?)
}

fn is_terminal(status: &str) -> bool {
    matches!(status, "succeeded" | "failed" | "cancelled" | "interrupted")
}

/// Only these transitions are legal; terminal rows never move again.
fn allowed(from: &str, to: &str) -> bool {
    matches!(
        (from, to),
        ("queued", "running")
            | ("queued", "cancelled")
            | ("queued", "interrupted")
            | ("running", "cancelling")
            | ("running", "succeeded")
            | ("running", "failed")
            | ("running", "cancelled")
            | ("running", "interrupted")
            | ("cancelling", "cancelled")
            | ("cancelling", "failed")
            | ("cancelling", "interrupted")
    )
}

fn validate_trigger(trigger: &str) -> Result<(), ToolError> {
    if matches!(trigger, "prompt" | "steer" | "resume" | "retry") {
        Ok(())
    } else {
        Err(ToolError::invalid(format!("未知的运行触发类型：{trigger}")))
    }
}

fn has_executor(conn: &Connection, conversation_id: i64) -> Result<bool, ToolError> {
    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM agent_runs
         WHERE conversation_id = ?1 AND status IN ('running', 'cancelling')",
        params![conversation_id],
        |r| r.get(0),
    )?;
    Ok(count > 0)
}

/// Last row that must be kept when resuming; partial answers are dropped.
fn last_complete_id(conn: &Connection, conversation_id: i64) -> Result<Option<i64>, ToolError> {
    Ok(conn
        .query_row(
            "SELECT id FROM messages
         WHERE conversation_id = ?1 AND (is_partial IS NULL OR is_partial = 0)
         ORDER BY id DESC LIMIT 1",
            params![conversation_id],
            |r| r.get(0),
        )
        .optional()?)
}

fn get(conn: &Connection, run_id: i64) -> Result<Option<AgentRun>, ToolError> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {RUN_COLUMNS} FROM agent_runs WHERE run_id = ?1"
    ))?;
    Ok(stmt.query_row(params![run_id], row_to_run).optional()?)
}

fn row_to_run(r: &rusqlite::Row<'_>) -> rusqlite::Result<AgentRun> {
    Ok(AgentRun {
        run_id: r.get(0)?,
        conversation_id: r.get(1)?,
        status: r.get(2)?,
        trigger: r.get(3)?,
        model_entry: r.get(4)?,
        step_count: r.get(5)?,
        write_count: r.get(6)?,
        last_seq: r.get(7)?,
        partial: r.get(8)?,
        error_code: r.get(9)?,
        resume_from_message_id: r.get(10)?,
        created_at: r.get(11)?,
        updated_at: r.get(12)?,
        ended_at: r.get(13)?,
    })
}

/// Insert the run row and its user message in one transaction.
///
/// A second prompt while another run is executing is stored as `queued`; the
/// partial unique index still guarantees at most one executor per conversation.
pub fn start(
    vfs: &VirtualFs,
    conversation_id: i64,
    trigger: &str,
    model_entry: &str,
    message: Option<NewMessage>,
) -> Result<RunStart, ToolError> {
    validate_trigger(trigger)?;
    let conn = vfs.conn();
    // Reuse the conversation check so a deleted conversation fails cleanly.
    conversations::messages(vfs, conversation_id)?;
    let at = now(conn)?;
    let status = if has_executor(conn, conversation_id)? {
        "queued"
    } else {
        "running"
    };
    let resume_from = if trigger == "resume" {
        last_complete_id(conn, conversation_id)?
    } else {
        None
    };

    let tx = conn.unchecked_transaction()?;
    tx.execute(
        "INSERT INTO agent_runs
             (conversation_id, status, trigger, model_entry, resume_from_message_id,
              created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
        params![
            conversation_id,
            status,
            trigger,
            model_entry,
            resume_from,
            at
        ],
    )?;
    let run_id = tx.last_insert_rowid();
    let inserted = match message {
        Some(mut item) => {
            item.run_id.get_or_insert(run_id);
            Some(conversations::insert_message(
                &tx,
                conversation_id,
                item,
                &at,
            )?)
        }
        None => None,
    };
    tx.execute(
        "UPDATE conversations SET updated_at = ?1 WHERE id = ?2",
        params![at, conversation_id],
    )?;
    tx.commit()?;

    let run = get(conn, run_id)?.ok_or_else(|| ToolError::Storage {
        message: "运行记录写入后未能读回".into(),
    })?;
    Ok(RunStart {
        run,
        message: inserted,
    })
}

/// Move a run to `status`, rejecting illegal or terminal transitions.
pub fn transition(vfs: &VirtualFs, run_id: i64, status: &str) -> Result<AgentRun, ToolError> {
    let conn = vfs.conn();
    let current = get(conn, run_id)?.ok_or_else(|| ToolError::NotFound {
        path: format!("run#{run_id}"),
    })?;
    if !allowed(&current.status, status) {
        return Err(ToolError::invalid(format!(
            "非法运行状态迁移：{} → {status}",
            current.status
        )));
    }
    let at = now(conn)?;
    let ended = if is_terminal(status) { Some(&at) } else { None };
    conn.execute(
        "UPDATE agent_runs SET status = ?1, updated_at = ?2, ended_at = ?3 WHERE run_id = ?4",
        params![status, at, ended, run_id],
    )?;
    get(conn, run_id)?.ok_or_else(|| ToolError::Storage {
        message: "运行记录更新后未能读回".into(),
    })
}

/// Finish a run with its partial snapshot and counters.
#[allow(clippy::too_many_arguments)]
pub fn finish(
    vfs: &VirtualFs,
    run_id: i64,
    status: &str,
    partial: Option<String>,
    error_code: Option<String>,
    step_count: i64,
    write_count: i64,
    last_seq: i64,
) -> Result<AgentRun, ToolError> {
    finish_on(
        vfs.conn(),
        run_id,
        status,
        partial,
        error_code,
        step_count,
        write_count,
        last_seq,
    )
}

/// Same as [`finish`], but usable inside an existing transaction.
#[allow(clippy::too_many_arguments)]
pub fn finish_on(
    conn: &Connection,
    run_id: i64,
    status: &str,
    partial: Option<String>,
    error_code: Option<String>,
    step_count: i64,
    write_count: i64,
    last_seq: i64,
) -> Result<AgentRun, ToolError> {
    if !is_terminal(status) {
        return Err(ToolError::invalid(format!(
            "finish 只接受终态，收到 {status}"
        )));
    }
    if let Some(value) = &partial {
        if value.len() > MAX_PARTIAL_BYTES {
            return Err(ToolError::invalid("中断快照超过 1MB 上限"));
        }
    }
    let current = get(conn, run_id)?.ok_or_else(|| ToolError::NotFound {
        path: format!("run#{run_id}"),
    })?;
    if !allowed(&current.status, status) {
        return Err(ToolError::invalid(format!(
            "非法运行状态迁移：{} → {status}",
            current.status
        )));
    }
    let at = now(conn)?;
    conn.execute(
        "UPDATE agent_runs
         SET status = ?1, updated_at = ?2, ended_at = ?2, partial = ?3, error_code = ?4,
             step_count = ?5, write_count = ?6, last_seq = ?7
         WHERE run_id = ?8",
        params![
            status,
            at,
            partial,
            error_code,
            step_count,
            write_count,
            last_seq,
            run_id
        ],
    )?;
    get(conn, run_id)?.ok_or_else(|| ToolError::Storage {
        message: "运行记录更新后未能读回".into(),
    })
}

/// Persist progress counters while a run is still executing.
pub fn touch(
    vfs: &VirtualFs,
    run_id: i64,
    step_count: i64,
    write_count: i64,
    last_seq: i64,
) -> Result<(), ToolError> {
    let conn = vfs.conn();
    let at = now(conn)?;
    conn.execute(
        "UPDATE agent_runs
         SET step_count = ?1, write_count = ?2, last_seq = ?3, updated_at = ?4
         WHERE run_id = ?5 AND status IN ('running', 'cancelling')",
        params![step_count, write_count, last_seq, at, run_id],
    )?;
    Ok(())
}

/// Mark rows left executing by a previous process as `interrupted`.
///
/// The last visible answer under the same run is copied into `partial`, so the
/// UI can still report how much text had been saved before the crash.
pub fn recover(conn: &Connection) -> Result<usize, ToolError> {
    let at = now(conn)?;
    let ids = {
        let mut stmt = conn
            .prepare("SELECT run_id FROM agent_runs WHERE status IN ('running', 'cancelling')")?;
        let rows = stmt.query_map([], |row| row.get::<_, i64>(0))?;
        rows.collect::<rusqlite::Result<Vec<i64>>>()?
    };
    for run_id in ids {
        if let Some(text) = last_answer(conn, run_id)? {
            let partial = serde_json::json!({ "text": text }).to_string();
            conn.execute(
                "UPDATE agent_runs SET partial = ?1 WHERE run_id = ?2",
                params![partial, run_id],
            )?;
        }
    }
    Ok(conn.execute(
        "UPDATE agent_runs
         SET status = 'interrupted', updated_at = ?1, ended_at = ?1
         WHERE status IN ('running', 'cancelling')",
        params![at],
    )?)
}

/// Last non-error assistant text produced by one run.
fn last_answer(conn: &Connection, run_id: i64) -> Result<Option<String>, ToolError> {
    let text: Option<String> = conn
        .query_row(
            "SELECT content FROM messages
             WHERE run_id = ?1 AND role = 'assistant' AND is_error = 0
             ORDER BY id DESC LIMIT 1",
            params![run_id],
            |row| row.get(0),
        )
        .optional()?;
    Ok(text.filter(|value| !value.trim().is_empty()))
}

/// Current executor, most recent run and the FIFO queue for one conversation.
pub fn state(vfs: &VirtualFs, conversation_id: i64) -> Result<RunState, ToolError> {
    let conn = vfs.conn();
    let active = conn
        .query_row(
            &format!(
                "SELECT {RUN_COLUMNS} FROM agent_runs
                 WHERE conversation_id = ?1 AND status IN ('running', 'cancelling')
                 ORDER BY run_id DESC LIMIT 1"
            ),
            params![conversation_id],
            row_to_run,
        )
        .optional()?;
    let latest = conn
        .query_row(
            &format!(
                "SELECT {RUN_COLUMNS} FROM agent_runs
                 WHERE conversation_id = ?1 ORDER BY run_id DESC LIMIT 1"
            ),
            params![conversation_id],
            row_to_run,
        )
        .optional()?;
    let mut stmt = conn.prepare(&format!(
        "SELECT {RUN_COLUMNS} FROM agent_runs
         WHERE conversation_id = ?1 AND status = 'queued' ORDER BY run_id ASC"
    ))?;
    let rows = stmt.query_map(params![conversation_id], row_to_run)?;
    let mut queued = Vec::new();
    for row in rows {
        let run = row?;
        let user_message = conversations::message_for_run(conn, run.run_id)?;
        queued.push(QueuedRun { run, user_message });
    }
    Ok(RunState {
        active,
        latest,
        queued,
    })
}
