//! 媒体作业队列：落库、状态迁移、取消与重启恢复。
//!
//! 本模块不执行任何厂商请求；它只保证作业状态可持久化，供后续
//! 图像/视频/TTS/分类适配器与后台 worker 复用。

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::agent::model_store::{self, ModelKind};
use crate::vfs::error::ToolError;

const MAX_PARAMS_BYTES: usize = 16 * 1024;
const MAX_LIST: i64 = 200;
const INTERRUPTED: &str = "应用重启，作业已中断";

/// Capability a job requests; maps 1:1 to a configured model kind.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum JobKind {
    Image,
    Video,
    Tts,
    Classify,
    Asr,
}

impl JobKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Image => "image",
            Self::Video => "video",
            Self::Tts => "tts",
            Self::Classify => "classify",
            Self::Asr => "asr",
        }
    }

    pub fn model_kind(self) -> ModelKind {
        match self {
            Self::Image => ModelKind::Image,
            Self::Video => ModelKind::Video,
            Self::Tts => ModelKind::Tts,
            Self::Classify => ModelKind::Classify,
            Self::Asr => ModelKind::Asr,
        }
    }

    fn parse(raw: &str) -> Result<Self, ToolError> {
        match raw {
            "image" => Ok(Self::Image),
            "video" => Ok(Self::Video),
            "tts" => Ok(Self::Tts),
            "classify" => Ok(Self::Classify),
            "asr" => Ok(Self::Asr),
            other => Err(ToolError::Storage {
                message: format!("未知作业类型：{other}"),
            }),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum JobStatus {
    Pending,
    Running,
    Succeeded,
    Failed,
    Cancelled,
}

impl JobStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Running => "running",
            Self::Succeeded => "succeeded",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
        }
    }

    pub fn is_terminal(self) -> bool {
        matches!(self, Self::Succeeded | Self::Failed | Self::Cancelled)
    }

    fn parse(raw: &str) -> Result<Self, ToolError> {
        match raw {
            "pending" => Ok(Self::Pending),
            "running" => Ok(Self::Running),
            "succeeded" => Ok(Self::Succeeded),
            "failed" => Ok(Self::Failed),
            "cancelled" => Ok(Self::Cancelled),
            other => Err(ToolError::Storage {
                message: format!("未知作业状态：{other}"),
            }),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    pub id: i64,
    pub kind: JobKind,
    pub model_entry: String,
    pub status: JobStatus,
    pub progress: u32,
    pub asset_id: Option<i64>,
    pub error: Option<String>,
    /// JSON answer for classification jobs; `None` for binary outputs.
    pub result: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewJob {
    pub kind: JobKind,
    pub model_entry: String,
    #[serde(default)]
    pub params: Value,
}

/// Persisted job row before enum parsing.
struct RawJob {
    id: i64,
    kind: String,
    model_entry: String,
    status: String,
    progress: i64,
    asset_id: Option<i64>,
    error: Option<String>,
    result: Option<String>,
    created_at: String,
    updated_at: String,
}

const SELECT_JOB: &str = "SELECT id, kind, model_entry, status, progress, asset_id, error, result, \
                          created_at, updated_at FROM media_jobs";

pub fn submit(conn: &Connection, input: NewJob) -> Result<Job, ToolError> {
    let entry = model_store::resolve(conn, &input.model_entry)?;
    if entry.kind != input.kind.model_kind() {
        return Err(ToolError::invalid("模型能力与作业类型不匹配"));
    }
    let params = match input.params {
        Value::Null => Value::Object(Map::new()),
        Value::Object(map) => Value::Object(map),
        _ => return Err(ToolError::invalid("作业参数必须是 JSON 对象")),
    };
    let body = serde_json::to_string(&params)
        .map_err(|e| ToolError::invalid(format!("作业参数序列化失败：{e}")))?;
    if body.len() > MAX_PARAMS_BYTES {
        return Err(ToolError::invalid(format!(
            "作业参数超过 {MAX_PARAMS_BYTES} 字节"
        )));
    }
    conn.execute(
        "INSERT INTO media_jobs
             (kind, model_entry, params, status, progress, created_at, updated_at)
         VALUES (?1, ?2, ?3, 'pending', 0, datetime('now','localtime'), datetime('now','localtime'))",
        params![input.kind.as_str(), entry.id, body],
    )?;
    get(conn, conn.last_insert_rowid())
}

pub fn get(conn: &Connection, id: i64) -> Result<Job, ToolError> {
    let raw = conn
        .query_row(
            &format!("{SELECT_JOB} WHERE id = ?1"),
            params![id],
            row_to_raw,
        )
        .optional()?;
    match raw {
        Some(raw) => job_from_raw(raw),
        None => Err(ToolError::invalid(format!("未找到作业：{id}"))),
    }
}

pub fn list(conn: &Connection, limit: i64) -> Result<Vec<Job>, ToolError> {
    let limit = limit.clamp(1, MAX_LIST);
    let mut stmt = conn.prepare(&format!(
        "{SELECT_JOB} ORDER BY id DESC LIMIT ?1"
    ))?;
    let rows = stmt.query_map(params![limit], row_to_raw)?;
    let mut jobs = Vec::new();
    for row in rows {
        jobs.push(job_from_raw(row?)?);
    }
    Ok(jobs)
}

/// Move a pending job to `running`. Used by the job runner.
pub fn mark_running(conn: &Connection, id: i64) -> Result<Job, ToolError> {
    let job = get(conn, id)?;
    if job.status != JobStatus::Pending {
        return Err(ToolError::invalid("只有排队中的作业可以开始执行"));
    }
    conn.execute(
        "UPDATE media_jobs
         SET status = 'running', progress = 0, error = NULL,
             updated_at = datetime('now','localtime')
         WHERE id = ?1",
        params![id],
    )?;
    get(conn, id)
}

/// Report 0–100 progress for a running job.
pub fn set_progress(conn: &Connection, id: i64, percent: u32) -> Result<Job, ToolError> {
    let job = get(conn, id)?;
    if job.status != JobStatus::Running {
        return Err(ToolError::invalid("只有执行中的作业可以更新进度"));
    }
    conn.execute(
        "UPDATE media_jobs SET progress = ?2, updated_at = datetime('now','localtime')
         WHERE id = ?1",
        params![id, i64::from(percent.min(100))],
    )?;
    get(conn, id)
}

/// Finish a running/pending job with a terminal status.
pub fn finish(
    conn: &Connection,
    id: i64,
    status: JobStatus,
    asset_id: Option<i64>,
    result: Option<&str>,
    error: Option<&str>,
) -> Result<Job, ToolError> {
    let job = get(conn, id)?;
    if job.status.is_terminal() {
        return Err(ToolError::invalid("作业已结束"));
    }
    if !status.is_terminal() {
        return Err(ToolError::invalid("必须使用终态结束作业"));
    }
    conn.execute(
        "UPDATE media_jobs
         SET status = ?2,
             progress = CASE WHEN ?2 = 'succeeded' THEN 100 ELSE progress END,
             asset_id = ?3, result = ?4, error = ?5,
             updated_at = datetime('now','localtime')
         WHERE id = ?1",
        params![id, status.as_str(), asset_id, result, error],
    )?;
    get(conn, id)
}

/// Cancel a pending/running job; the worker sees its flag and stops.
pub fn cancel(conn: &Connection, id: i64) -> Result<Job, ToolError> {
    let job = get(conn, id)?;
    if job.status.is_terminal() {
        return Err(ToolError::invalid("作业已结束，无法取消"));
    }
    conn.execute(
        "UPDATE media_jobs
         SET status = 'cancelled', error = NULL, updated_at = datetime('now','localtime')
         WHERE id = ?1",
        params![id],
    )?;
    get(conn, id)
}

/// Startup reconciliation: a job that was running when the app closed cannot
/// resume without its process state, so it is failed rather than left dangling.
pub fn recover(conn: &Connection) -> Result<usize, ToolError> {
    let changed = conn.execute(
        "UPDATE media_jobs
         SET status = 'failed', error = ?1, updated_at = datetime('now','localtime')
         WHERE status = 'running'",
        params![INTERRUPTED],
    )?;
    Ok(changed)
}

/// Raw job params for the executor; never exposed in job listings.
pub fn params(conn: &Connection, id: i64) -> Result<Value, ToolError> {
    let raw: Option<String> = conn
        .query_row(
            "SELECT params FROM media_jobs WHERE id = ?1",
            params![id],
            |row| row.get(0),
        )
        .optional()?;
    let raw = raw.ok_or_else(|| ToolError::invalid(format!("未找到作业：{id}")))?;
    serde_json::from_str(&raw).map_err(|e| ToolError::Storage {
        message: format!("作业参数解析失败：{e}"),
    })
}

fn row_to_raw(row: &rusqlite::Row<'_>) -> rusqlite::Result<RawJob> {
    Ok(RawJob {
        id: row.get(0)?,
        kind: row.get(1)?,
        model_entry: row.get(2)?,
        status: row.get(3)?,
        progress: row.get(4)?,
        asset_id: row.get(5)?,
        error: row.get(6)?,
        result: row.get(7)?,
        created_at: row.get(8)?,
        updated_at: row.get(9)?,
    })
}

fn job_from_raw(raw: RawJob) -> Result<Job, ToolError> {
    Ok(Job {
        id: raw.id,
        kind: JobKind::parse(&raw.kind)?,
        model_entry: raw.model_entry,
        status: JobStatus::parse(&raw.status)?,
        progress: u32::try_from(raw.progress).unwrap_or(0),
        asset_id: raw.asset_id,
        error: raw.error,
        result: raw.result,
        created_at: raw.created_at,
        updated_at: raw.updated_at,
    })
}
