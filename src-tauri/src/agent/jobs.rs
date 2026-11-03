//! Chat jobs: one model turn detached from the WebView lifecycle.
//!
//! A job is the unit `agent_stream` used to run inline: resolve the model entry,
//! apply the egress gate, stream one model turn and record its terminal state.
//! The difference is ownership. The command that starts a job only enqueues it;
//! a dispatcher executes it on a per-engine serial lane and every event is
//! persisted before it reaches any viewer. Switching pages therefore drops the
//! subscriber, not the generation.
//!
//! Persistence contract:
//! - `chat_jobs.status` is authoritative; in-memory queues only schedule work.
//! - `blocks` is a throttled snapshot (`last_seq` matches the applied events), so
//!   a viewer that subscribes late can rebuild the partial assistant message.
//! - A terminal status is written only from `running` / `cancelling`, and the
//!   job's cancel flag wins over a late `done` event.
//! - Jobs do not survive a process restart: queued/running/cancelling rows are
//!   failed with `error_code = 'interrupted'` and keep their partial blocks.

use std::collections::{BTreeMap, HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Manager};

use super::llm::{self, ProxyRequest};
use super::local_mnn::LocalMnnState;
use super::model_store::{ApiFormat, ModelEntry};
use super::request;
use super::AgentState;
use crate::vfs::error::ToolError;
use crate::vfs::VfsState;

const MAX_LIST: i64 = 200;
const MAX_PARAMS_BYTES: usize = 16 * 1024;
/// Snapshot flush cadence: enough to survive a page switch, cheap while decoding.
const FLUSH_INTERVAL: Duration = Duration::from_millis(250);
const FLUSH_BYTES: usize = 4096;
const EVENT_BUFFER: usize = 1024;
const INTERRUPTED: &str = "应用重启，生成已中断";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ChatJobStatus {
    Queued,
    Running,
    Cancelling,
    Done,
    Failed,
    Cancelled,
}

impl ChatJobStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::Running => "running",
            Self::Cancelling => "cancelling",
            Self::Done => "done",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
        }
    }

    pub fn is_terminal(self) -> bool {
        matches!(self, Self::Done | Self::Failed | Self::Cancelled)
    }

    fn parse(raw: &str) -> Result<Self, ToolError> {
        match raw {
            "queued" => Ok(Self::Queued),
            "running" => Ok(Self::Running),
            "cancelling" => Ok(Self::Cancelling),
            "done" => Ok(Self::Done),
            "failed" => Ok(Self::Failed),
            "cancelled" => Ok(Self::Cancelled),
            other => Err(ToolError::Storage {
                message: format!("未知作业状态：{other}"),
            }),
        }
    }
}

/// One content block of the in-flight assistant message.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum JobBlock {
    Text {
        #[serde(rename = "contentIndex")]
        content_index: usize,
        text: String,
    },
    Thinking {
        #[serde(rename = "contentIndex")]
        content_index: usize,
        thinking: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        signature: Option<String>,
    },
    ToolCall {
        #[serde(rename = "contentIndex")]
        content_index: usize,
        id: String,
        name: String,
        arguments: Value,
        /// Raw JSON delta stream; kept so a late viewer can show partial args.
        raw: String,
    },
}

/// Persisted job row, also the snapshot returned to viewers.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatJob {
    pub id: i64,
    pub conversation_id: i64,
    pub request_id: String,
    pub model_entry: String,
    pub status: ChatJobStatus,
    pub last_seq: i64,
    pub blocks: Vec<JobBlock>,
    pub usage: Option<Value>,
    /// Local engine tag (`llama` / `mnn`); `None` for cloud entries.
    pub engine: Option<String>,
    /// Last local engine metrics (TTFT, tokens, prefill); `None` before the first flush.
    pub metrics: Option<Value>,
    pub stop_reason: Option<String>,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
    pub created_at: String,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    pub updated_at: String,
}

/// A live event, already assigned its monotonic sequence number.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveEvent {
    pub seq: i64,
    pub event: llm::StreamEvent,
}

/// First message of `chat_job_watch`, then zero or more `Event`s.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ChatJobWatchEvent {
    Snapshot {
        // Boxed so the watch enum stays small; the snapshot is sent once per watch.
        job: Box<ChatJob>,
    },
    Event {
        #[serde(rename = "jobId")]
        job_id: i64,
        seq: i64,
        event: llm::StreamEvent,
    },
}

/// Terminal fields written exactly once, when the runner stops.
#[derive(Debug)]
pub struct Outcome {
    pub status: ChatJobStatus,
    pub usage: Option<Value>,
    pub stop_reason: Option<String>,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
}

impl Outcome {
    pub fn done(usage: Option<Value>, stop_reason: Option<String>) -> Self {
        Self {
            status: ChatJobStatus::Done,
            usage,
            stop_reason,
            error_code: None,
            error_message: None,
        }
    }

    pub fn failed(code: &str, message: String) -> Self {
        Self {
            status: ChatJobStatus::Failed,
            usage: None,
            stop_reason: None,
            error_code: Some(code.to_string()),
            error_message: Some(message),
        }
    }

    pub fn cancelled() -> Self {
        Self {
            status: ChatJobStatus::Cancelled,
            usage: None,
            stop_reason: None,
            error_code: None,
            error_message: None,
        }
    }
}

/// Snapshot fields written by the throttled flush.
struct Progress {
    last_seq: i64,
    blocks: String,
    usage: Option<String>,
    metrics: Option<String>,
    stop_reason: Option<String>,
    error_code: Option<String>,
    error_message: Option<String>,
}

#[derive(Default)]
struct JobBuffer {
    blocks: BTreeMap<usize, JobBlock>,
    last_seq: i64,
    usage: Option<Value>,
    metrics: Option<Value>,
    stop_reason: Option<String>,
    error_code: Option<String>,
    error_message: Option<String>,
    terminal: bool,
    pending_bytes: usize,
    last_flush: Option<Instant>,
}

impl JobBuffer {
    fn apply(&mut self, event: &llm::StreamEvent) -> i64 {
        self.last_seq += 1;
        self.pending_bytes += match event {
            llm::StreamEvent::TextDelta { delta, .. }
            | llm::StreamEvent::ThinkingDelta { delta, .. }
            | llm::StreamEvent::ToolCallDelta { delta, .. } => delta.len(),
            _ => 16,
        };
        match event {
            llm::StreamEvent::Start => {}
            llm::StreamEvent::TextStart { content_index } => {
                self.blocks.insert(
                    *content_index,
                    JobBlock::Text {
                        content_index: *content_index,
                        text: String::new(),
                    },
                );
            }
            llm::StreamEvent::TextDelta {
                content_index,
                delta,
            } => {
                if let Some(JobBlock::Text { text, .. }) = self.blocks.get_mut(content_index) {
                    text.push_str(delta);
                }
            }
            llm::StreamEvent::TextEnd { .. } => {}
            llm::StreamEvent::ThinkingStart { content_index } => {
                self.blocks.insert(
                    *content_index,
                    JobBlock::Thinking {
                        content_index: *content_index,
                        thinking: String::new(),
                        signature: None,
                    },
                );
            }
            llm::StreamEvent::ThinkingDelta {
                content_index,
                delta,
            } => {
                if let Some(JobBlock::Thinking { thinking, .. }) =
                    self.blocks.get_mut(content_index)
                {
                    thinking.push_str(delta);
                }
            }
            llm::StreamEvent::ThinkingEnd {
                content_index,
                signature,
            } => {
                if let Some(JobBlock::Thinking {
                    signature: slot, ..
                }) = self.blocks.get_mut(content_index)
                {
                    if signature.is_some() {
                        *slot = signature.clone();
                    }
                }
            }
            llm::StreamEvent::ToolCallStart {
                content_index,
                id,
                tool_name,
            } => {
                self.blocks.insert(
                    *content_index,
                    JobBlock::ToolCall {
                        content_index: *content_index,
                        id: id.clone(),
                        name: tool_name.clone(),
                        arguments: Value::Object(serde_json::Map::new()),
                        raw: String::new(),
                    },
                );
            }
            llm::StreamEvent::ToolCallDelta {
                content_index,
                delta,
            } => {
                if let Some(JobBlock::ToolCall { raw, .. }) = self.blocks.get_mut(content_index) {
                    raw.push_str(delta);
                }
            }
            llm::StreamEvent::ToolCallEnd {
                content_index,
                tool_call,
            } => {
                if let Some(JobBlock::ToolCall {
                    id,
                    name,
                    arguments,
                    ..
                }) = self.blocks.get_mut(content_index)
                {
                    *id = tool_call.id.clone();
                    *name = tool_call.name.clone();
                    *arguments = tool_call.arguments.clone();
                }
            }
            llm::StreamEvent::Metrics { metrics } => {
                self.metrics = serde_json::to_value(metrics).ok();
            }
            llm::StreamEvent::Done { reason, usage } => {
                self.usage = serde_json::to_value(usage).ok();
                self.stop_reason = Some(reason.clone());
                self.terminal = true;
            }
            llm::StreamEvent::Error {
                reason,
                error_message,
                usage,
            } => {
                self.usage = serde_json::to_value(usage).ok();
                self.error_code = Some(reason.clone());
                self.error_message = Some(error_message.clone());
                self.terminal = true;
            }
        }
        self.last_seq
    }

    fn should_flush(&self, force: bool) -> bool {
        force
            || self.terminal
            || self.pending_bytes >= FLUSH_BYTES
            || self
                .last_flush
                .map(|at| at.elapsed() >= FLUSH_INTERVAL)
                .unwrap_or(true)
    }

    fn progress(&mut self) -> Progress {
        self.pending_bytes = 0;
        self.last_flush = Some(Instant::now());
        let blocks: Vec<&JobBlock> = self.blocks.values().collect();
        Progress {
            last_seq: self.last_seq,
            blocks: serde_json::to_string(&blocks).unwrap_or_else(|_| "[]".into()),
            usage: self.usage.as_ref().map(Value::to_string),
            metrics: self.metrics.as_ref().map(Value::to_string),
            stop_reason: self.stop_reason.clone(),
            error_code: self.error_code.clone(),
            error_message: self.error_message.clone(),
        }
    }

    fn terminal_outcome(&self, cancelled: bool) -> Outcome {
        if cancelled {
            return Outcome::cancelled();
        }
        match (&self.error_code, &self.stop_reason) {
            (Some(code), _) => Outcome::failed(
                code,
                self.error_message
                    .clone()
                    .unwrap_or_else(|| "生成失败".to_string()),
            ),
            (None, Some(reason)) => Outcome::done(self.usage.clone(), Some(reason.clone())),
            (None, None) => Outcome::failed("error", "流式响应在完成前结束".to_string()),
        }
    }
}

/// One running job with its multi-viewer event feed.
pub struct LiveJob {
    pub job_id: i64,
    pub cancel: Arc<AtomicBool>,
    events: tokio::sync::broadcast::Sender<LiveEvent>,
    buffer: Mutex<JobBuffer>,
}

impl LiveJob {
    fn new(job_id: i64) -> Self {
        let (events, _) = tokio::sync::broadcast::channel(EVENT_BUFFER);
        Self {
            job_id,
            cancel: Arc::new(AtomicBool::new(false)),
            events,
            buffer: Mutex::new(JobBuffer::default()),
        }
    }

    /// A new viewer starts from its snapshot and then consumes live events.
    pub fn subscribe(&self) -> tokio::sync::broadcast::Receiver<LiveEvent> {
        self.events.subscribe()
    }

    fn emit(&self, app: &AppHandle, event: llm::StreamEvent) {
        let (seq, progress) = {
            let mut buffer = self.buffer.lock().unwrap();
            let seq = buffer.apply(&event);
            let progress = if buffer.should_flush(false) {
                Some(buffer.progress())
            } else {
                None
            };
            (seq, progress)
        };
        if let Some(progress) = progress {
            persist(app, self.job_id, &progress);
        }
        // A missing receiver is normal: the WebView may have switched pages.
        let _ = self.events.send(LiveEvent { seq, event });
    }

    fn flush(&self, app: &AppHandle) {
        let progress = {
            let mut buffer = self.buffer.lock().unwrap();
            buffer.progress()
        };
        persist(app, self.job_id, &progress);
    }

    fn outcome(&self) -> Outcome {
        let buffer = self.buffer.lock().unwrap();
        buffer.terminal_outcome(self.cancel.load(Ordering::SeqCst))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum Lane {
    Local,
    Cloud,
}

impl Lane {
    const ALL: [Lane; 2] = [Lane::Local, Lane::Cloud];
}

fn lane_of(format: ApiFormat) -> Lane {
    if format.is_local() {
        Lane::Local
    } else {
        Lane::Cloud
    }
}

#[derive(Default)]
struct Inner {
    queue: HashMap<Lane, VecDeque<(i64, ProxyRequest)>>,
    running: HashMap<Lane, i64>,
    live: HashMap<i64, Arc<LiveJob>>,
}

/// Scheduling state shared by commands and the dispatcher.
pub struct ChatJobs {
    inner: Mutex<Inner>,
    notify: tokio::sync::Notify,
}

impl ChatJobs {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(Inner::default()),
            notify: tokio::sync::Notify::new(),
        }
    }

    fn enqueue(&self, lane: Lane, job_id: i64, request: ProxyRequest) {
        let mut inner = self.inner.lock().unwrap();
        inner
            .queue
            .entry(lane)
            .or_default()
            .push_back((job_id, request));
    }

    /// Enqueue on the lane implied by the model entry and wake the dispatcher.
    pub fn enqueue_for(&self, entry: &ModelEntry, job_id: i64, request: ProxyRequest) {
        self.enqueue(lane_of(entry.format), job_id, request);
        self.notify.notify_one();
    }

    fn notify(&self) {
        self.notify.notify_one();
    }

    /// Pop the oldest request from an idle lane. The DB conditional update
    /// still decides whether the job may actually start.
    fn take_ready(&self) -> Option<(Lane, i64, ProxyRequest)> {
        let mut inner = self.inner.lock().unwrap();
        for lane in Lane::ALL {
            if inner.running.contains_key(&lane) {
                continue;
            }
            if let Some((job_id, request)) = inner.queue.entry(lane).or_default().pop_front() {
                return Some((lane, job_id, request));
            }
        }
        None
    }

    fn attach(&self, job_id: i64, live: Arc<LiveJob>) {
        self.inner.lock().unwrap().live.insert(job_id, live);
    }

    fn detach(&self, job_id: i64) {
        self.inner.lock().unwrap().live.remove(&job_id);
    }

    fn start_lane(&self, lane: Lane, job_id: i64) {
        self.inner.lock().unwrap().running.insert(lane, job_id);
    }

    fn finish_lane(&self, lane: Lane, job_id: i64) {
        let mut inner = self.inner.lock().unwrap();
        if inner.running.get(&lane) == Some(&job_id) {
            inner.running.remove(&lane);
        }
        inner.live.remove(&job_id);
    }

    pub fn live(&self, job_id: i64) -> Option<Arc<LiveJob>> {
        self.inner.lock().unwrap().live.get(&job_id).cloned()
    }

    /// A local turn is decoding; background pause must not unload the weights.
    pub fn local_running(&self) -> bool {
        self.inner.lock().unwrap().running.contains_key(&Lane::Local)
    }
}

/// Start the single dispatcher. It runs forever and only reacts to `notify`.
pub fn spawn(app: AppHandle, jobs: Arc<ChatJobs>) {
    tauri::async_runtime::spawn(async move {
        loop {
            jobs.notify.notified().await;
            while let Some((lane, job_id, request)) = jobs.take_ready() {
                let live = Arc::new(LiveJob::new(job_id));
                // Attach before the conditional start so a concurrent cancel can
                // always find (and set) the job's cancel flag.
                jobs.attach(job_id, live.clone());
                if !start_job(&app, job_id) {
                    jobs.detach(job_id);
                    continue;
                }
                jobs.start_lane(lane, job_id);
                let task_app = app.clone();
                let task_jobs = jobs.clone();
                tauri::async_runtime::spawn(async move {
                    run_job(task_app, task_jobs.clone(), lane, job_id, request, live).await;
                });
            }
        }
    });
}

fn start_job(app: &AppHandle, job_id: i64) -> bool {
    let vfs = app.state::<VfsState>();
    let conn = vfs.0.lock().unwrap();
    match mark_running(conn.conn(), job_id) {
        Ok(started) => started,
        Err(e) => {
            log::warn!("chat job {job_id} start failed: {e}");
            false
        }
    }
}

async fn run_job(
    app: AppHandle,
    jobs: Arc<ChatJobs>,
    lane: Lane,
    job_id: i64,
    request: ProxyRequest,
    live: Arc<LiveJob>,
) {
    let emit_live = live.clone();
    let emit_app = app.clone();
    let emit = move |event: llm::StreamEvent| emit_live.emit(&emit_app, event);

    let prepared = {
        let vfs_state = app.state::<VfsState>();
        let agent_state = app.state::<AgentState>();
        request::prepare(&vfs_state, agent_state.inner(), request)
    };

    match prepared {
        Err(e) => {
            emit(llm::StreamEvent::Error {
                reason: "error".into(),
                error_message: e.to_string(),
                usage: llm::Usage::default(),
            });
        }
        Ok(prepared) => {
            // Local entries carry no decision; only a present *blocked* decision
            // short-circuits, mirroring the `agent_stream` path.
            let block_message = prepared
                .decision
                .as_ref()
                .filter(|decision| decision.blocked())
                .map(|decision| {
                    decision
                        .message
                        .clone()
                        .unwrap_or_else(|| "隐私拦截：本次请求不允许发送到云端。".into())
                });
            match block_message {
                Some(message) => {
                    emit(llm::StreamEvent::Start);
                    emit(llm::StreamEvent::Error {
                        reason: "error".into(),
                        error_message: message,
                        usage: llm::Usage::default(),
                    });
                }
                None => {
                    let agent_state = app.state::<AgentState>();
                    let mnn_state = app.state::<LocalMnnState>();
                    let result = llm::run(
                        agent_state.inner(),
                        mnn_state.inner(),
                        prepared.request,
                        &prepared.entry,
                        &prepared.params,
                        live.cancel.clone(),
                        &emit,
                    )
                    .await;
                    if let Err(e) = result {
                        emit(llm::StreamEvent::Error {
                            reason: if live.cancel.load(Ordering::SeqCst) {
                                "aborted".into()
                            } else {
                                "error".into()
                            },
                            error_message: e.to_string(),
                            usage: llm::Usage::default(),
                        });
                    }
                }
            }
        }
    }

    // Last snapshot, then the terminal status. Order matters: a viewer that
    // reconnects after the lane slot is released must see the final blocks.
    live.flush(&app);
    let outcome = live.outcome();
    {
        let vfs = app.state::<VfsState>();
        let conn = vfs.0.lock().unwrap();
        if let Err(e) = finish(conn.conn(), job_id, &outcome) {
            log::warn!("chat job {job_id} finish failed: {e}");
        }
    }
    jobs.finish_lane(lane, job_id);
    jobs.notify();
}

fn persist(app: &AppHandle, job_id: i64, progress: &Progress) {
    let vfs = app.state::<VfsState>();
    let conn = vfs.0.lock().unwrap();
    if let Err(e) = conn.conn().execute(
        "UPDATE chat_jobs
         SET last_seq = ?2, blocks = ?3, usage = ?4, metrics = ?5, stop_reason = ?6,
             error_code = ?7, error_message = ?8,
             updated_at = datetime('now','localtime')
         WHERE id = ?1",
        params![
            job_id,
            progress.last_seq,
            progress.blocks,
            progress.usage,
            progress.metrics,
            progress.stop_reason,
            progress.error_code,
            progress.error_message
        ],
    ) {
        log::warn!("chat job {job_id} snapshot write failed: {e}");
    }
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

const SELECT_JOB: &str =
    "SELECT id, conversation_id, request_id, model_entry, status, last_seq, blocks, \
            usage, stop_reason, error_code, error_message, created_at, started_at, \
            finished_at, updated_at, engine, metrics FROM chat_jobs";

struct RawJob {
    id: i64,
    conversation_id: i64,
    request_id: String,
    model_entry: String,
    status: String,
    last_seq: i64,
    blocks: String,
    usage: Option<String>,
    stop_reason: Option<String>,
    error_code: Option<String>,
    error_message: Option<String>,
    created_at: String,
    started_at: Option<String>,
    finished_at: Option<String>,
    updated_at: String,
    engine: Option<String>,
    metrics: Option<String>,
}

fn row_to_raw(row: &rusqlite::Row<'_>) -> rusqlite::Result<RawJob> {
    Ok(RawJob {
        id: row.get(0)?,
        conversation_id: row.get(1)?,
        request_id: row.get(2)?,
        model_entry: row.get(3)?,
        status: row.get(4)?,
        last_seq: row.get(5)?,
        blocks: row.get(6)?,
        usage: row.get(7)?,
        stop_reason: row.get(8)?,
        error_code: row.get(9)?,
        error_message: row.get(10)?,
        created_at: row.get(11)?,
        started_at: row.get(12)?,
        finished_at: row.get(13)?,
        updated_at: row.get(14)?,
        engine: row.get(15)?,
        metrics: row.get(16)?,
    })
}

fn job_from_raw(raw: RawJob) -> Result<ChatJob, ToolError> {
    let usage = match raw.usage {
        Some(text) => serde_json::from_str(&text).ok(),
        None => None,
    };
    let blocks = match serde_json::from_str::<Vec<JobBlock>>(&raw.blocks) {
        Ok(blocks) => blocks,
        Err(e) => {
            // A corrupt snapshot must not hide the job; start from empty blocks.
            log::warn!("chat job {} blocks parse failed: {e}", raw.id);
            Vec::new()
        }
    };
    Ok(ChatJob {
        id: raw.id,
        conversation_id: raw.conversation_id,
        request_id: raw.request_id,
        model_entry: raw.model_entry,
        status: ChatJobStatus::parse(&raw.status)?,
        last_seq: raw.last_seq,
        blocks,
        usage,
        engine: raw.engine,
        metrics: raw.metrics.and_then(|text| serde_json::from_str(&text).ok()),
        stop_reason: raw.stop_reason,
        error_code: raw.error_code,
        error_message: raw.error_message,
        created_at: raw.created_at,
        started_at: raw.started_at,
        finished_at: raw.finished_at,
        updated_at: raw.updated_at,
    })
}

pub fn get(conn: &Connection, id: i64) -> Result<ChatJob, ToolError> {
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

pub fn active(conn: &Connection, conversation_id: i64) -> Result<Option<ChatJob>, ToolError> {
    let raw = conn
        .query_row(
            &format!(
                "{SELECT_JOB} WHERE conversation_id = ?1 \
                 AND status IN ('queued', 'running', 'cancelling') LIMIT 1"
            ),
            params![conversation_id],
            row_to_raw,
        )
        .optional()?;
    raw.map(job_from_raw).transpose()
}

pub fn submit(
    conn: &Connection,
    conversation_id: i64,
    entry: &ModelEntry,
    request: &ProxyRequest,
) -> Result<ChatJob, ToolError> {
    if let Some(active) = active(conn, conversation_id)? {
        return Err(ToolError::invalid(format!(
            "该会话已有生成任务（{}）",
            active.status.as_str()
        )));
    }
    let params = serde_json::to_string(&request.options).unwrap_or_else(|_| "{}".into());
    if params.len() > MAX_PARAMS_BYTES {
        return Err(ToolError::invalid(format!(
            "作业参数超过 {MAX_PARAMS_BYTES} 字节"
        )));
    }
    // The UNIQUE index turns a concurrent double submit into a storage error;
    // the pre-check above covers the common path with a readable message.
    conn.execute(
        "INSERT INTO chat_jobs
             (conversation_id, request_id, model_entry, params, status, engine, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, 'queued', ?5, datetime('now','localtime'), datetime('now','localtime'))",
        params![
            conversation_id,
            request.request_id,
            entry.id,
            params,
            entry.format.engine_tag()
        ],
    )?;
    get(conn, conn.last_insert_rowid())
}

pub fn list(
    conn: &Connection,
    conversation_id: Option<i64>,
    limit: i64,
) -> Result<Vec<ChatJob>, ToolError> {
    let limit = limit.clamp(1, MAX_LIST);
    let mut jobs = Vec::new();
    match conversation_id {
        Some(id) => {
            let mut stmt = conn.prepare(&format!(
                "{SELECT_JOB} WHERE conversation_id = ?1 ORDER BY id DESC LIMIT ?2"
            ))?;
            let rows = stmt.query_map(params![id, limit], row_to_raw)?;
            for row in rows {
                jobs.push(job_from_raw(row?)?);
            }
        }
        None => {
            let mut stmt = conn.prepare(&format!("{SELECT_JOB} ORDER BY id DESC LIMIT ?1"))?;
            let rows = stmt.query_map(params![limit], row_to_raw)?;
            for row in rows {
                jobs.push(job_from_raw(row?)?);
            }
        }
    }
    Ok(jobs)
}

/// Conditional dequeue: `false` means the row was cancelled while queued.
pub fn mark_running(conn: &Connection, id: i64) -> Result<bool, ToolError> {
    let changed = conn.execute(
        "UPDATE chat_jobs
         SET status = 'running', started_at = datetime('now','localtime'),
             updated_at = datetime('now','localtime')
         WHERE id = ?1 AND status = 'queued'",
        params![id],
    )?;
    Ok(changed > 0)
}

pub fn cancel_queued(conn: &Connection, id: i64) -> Result<bool, ToolError> {
    let changed = conn.execute(
        "UPDATE chat_jobs
         SET status = 'cancelled', finished_at = datetime('now','localtime'),
             updated_at = datetime('now','localtime')
         WHERE id = ?1 AND status = 'queued'",
        params![id],
    )?;
    Ok(changed > 0)
}

pub fn mark_cancelling(conn: &Connection, id: i64) -> Result<bool, ToolError> {
    let changed = conn.execute(
        "UPDATE chat_jobs
         SET status = 'cancelling', updated_at = datetime('now','localtime')
         WHERE id = ?1 AND status = 'running'",
        params![id],
    )?;
    Ok(changed > 0)
}

/// Terminal write is allowed only from an active status, so a late completion
/// cannot resurrect a cancelled job or overwrite a finished one.
pub fn finish(conn: &Connection, id: i64, outcome: &Outcome) -> Result<ChatJob, ToolError> {
    if !outcome.status.is_terminal() {
        return Err(ToolError::invalid("必须使用终态结束作业"));
    }
    let usage = outcome.usage.as_ref().map(Value::to_string);
    conn.execute(
        "UPDATE chat_jobs
         SET status = ?2, usage = ?3, stop_reason = ?4, error_code = ?5, error_message = ?6,
             finished_at = datetime('now','localtime'), updated_at = datetime('now','localtime')
         WHERE id = ?1 AND status IN ('running', 'cancelling')",
        params![
            id,
            outcome.status.as_str(),
            usage,
            outcome.stop_reason,
            outcome.error_code,
            outcome.error_message
        ],
    )?;
    get(conn, id)
}

/// Startup reconciliation: no request payload survives a restart, so an active
/// row becomes a failed, retryable job instead of a dangling `running`.
pub fn recover(conn: &Connection) -> Result<usize, ToolError> {
    let changed = conn.execute(
        "UPDATE chat_jobs
         SET status = 'failed', error_code = 'interrupted', error_message = ?1,
             finished_at = datetime('now','localtime'), updated_at = datetime('now','localtime')
         WHERE status IN ('queued', 'running', 'cancelling')",
        params![INTERRUPTED],
    )?;
    Ok(changed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::llm::{ModelRef, Options, ProxyContext};
    use crate::agent::model_store::ModelKind;
    use crate::db;

    fn conn() -> Connection {
        let mut conn = Connection::open_in_memory().unwrap();
        db::schema::migrate(&mut conn).unwrap();
        conn.execute(
            "INSERT INTO conversations (title, provider, model, created_at, updated_at)
             VALUES ('t', 'p', 'm', datetime('now','localtime'), datetime('now','localtime'))",
            [],
        )
        .unwrap();
        conn
    }

    fn add_conversation(conn: &Connection) -> i64 {
        conn.execute(
            "INSERT INTO conversations (title, provider, model, created_at, updated_at)
             VALUES ('t', 'p', 'm', datetime('now','localtime'), datetime('now','localtime'))",
            [],
        )
        .unwrap();
        conn.last_insert_rowid()
    }

    fn entry() -> ModelEntry {
        ModelEntry {
            id: "local_llama".into(),
            label: "local".into(),
            format: ApiFormat::LocalLlama,
            base_url: "m.gguf".into(),
            full_url: false,
            model_id: "m".into(),
            kind: ModelKind::Chat,
        }
    }

    fn request(id: &str) -> ProxyRequest {
        ProxyRequest {
            request_id: id.into(),
            model: ModelRef {
                id: "m".into(),
                provider: "local_llama".into(),
                api: "openai-completions".into(),
            },
            context: ProxyContext::default(),
            options: Options::default(),
        }
    }

    #[test]
    fn status_moves_queued_running_done() {
        let conn = conn();
        let job = submit(&conn, 1, &entry(), &request("r1")).unwrap();
        assert_eq!(job.status, ChatJobStatus::Queued);
        assert!(mark_running(&conn, job.id).unwrap());
        assert_eq!(get(&conn, job.id).unwrap().status, ChatJobStatus::Running);
        let outcome = Outcome::done(None, Some("stop".into()));
        let job = finish(&conn, job.id, &outcome).unwrap();
        assert_eq!(job.status, ChatJobStatus::Done);
        assert_eq!(job.stop_reason.as_deref(), Some("stop"));
        assert!(job.started_at.is_some());
        assert!(job.finished_at.is_some());
    }

    #[test]
    fn conditional_start_skips_cancelled_row() {
        let conn = conn();
        let job = submit(&conn, 1, &entry(), &request("r2")).unwrap();
        assert!(cancel_queued(&conn, job.id).unwrap());
        assert!(!mark_running(&conn, job.id).unwrap());
        assert_eq!(get(&conn, job.id).unwrap().status, ChatJobStatus::Cancelled);
    }

    #[test]
    fn terminal_state_is_write_protected() {
        let conn = conn();
        let job = submit(&conn, 1, &entry(), &request("r3")).unwrap();
        mark_running(&conn, job.id).unwrap();
        finish(&conn, job.id, &Outcome::done(None, Some("stop".into()))).unwrap();
        // Second completion must not change the terminal status or fields.
        finish(&conn, job.id, &Outcome::failed("error", "late".into())).unwrap();
        let job = get(&conn, job.id).unwrap();
        assert_eq!(job.status, ChatJobStatus::Done);
        assert!(job.error_code.is_none());
        assert!(!mark_running(&conn, job.id).unwrap());
        assert!(!cancel_queued(&conn, job.id).unwrap());
    }

    #[test]
    fn cancelling_still_accepts_cancelled_terminal() {
        let conn = conn();
        let job = submit(&conn, 1, &entry(), &request("r4")).unwrap();
        mark_running(&conn, job.id).unwrap();
        assert!(mark_cancelling(&conn, job.id).unwrap());
        assert_eq!(
            get(&conn, job.id).unwrap().status,
            ChatJobStatus::Cancelling
        );
        let job = finish(&conn, job.id, &Outcome::cancelled()).unwrap();
        assert_eq!(job.status, ChatJobStatus::Cancelled);
    }

    #[test]
    fn second_active_job_is_rejected() {
        let conn = conn();
        submit(&conn, 1, &entry(), &request("r5")).unwrap();
        let err = submit(&conn, 1, &entry(), &request("r6")).unwrap_err();
        assert!(matches!(err, ToolError::InvalidArgument { .. }));
        // A terminal first job releases the conversation slot.
        let first = active(&conn, 1).unwrap().unwrap();
        mark_running(&conn, first.id).unwrap();
        finish(&conn, first.id, &Outcome::done(None, Some("stop".into()))).unwrap();
        submit(&conn, 1, &entry(), &request("r7")).unwrap();
    }

    #[test]
    fn recover_marks_every_active_state_interrupted() {
        let conn = conn();
        let queued = submit(&conn, 1, &entry(), &request("r8")).unwrap();
        let other = add_conversation(&conn);
        let running = submit(&conn, other, &entry(), &request("r9")).unwrap();
        mark_running(&conn, running.id).unwrap();
        let done = submit(&conn, add_conversation(&conn), &entry(), &request("r10")).unwrap();
        mark_running(&conn, done.id).unwrap();
        finish(&conn, done.id, &Outcome::done(None, Some("stop".into()))).unwrap();

        assert_eq!(recover(&conn).unwrap(), 2);
        for id in [queued.id, running.id] {
            let job = get(&conn, id).unwrap();
            assert_eq!(job.status, ChatJobStatus::Failed);
            assert_eq!(job.error_code.as_deref(), Some("interrupted"));
            assert!(job.finished_at.is_some());
        }
        assert_eq!(get(&conn, done.id).unwrap().status, ChatJobStatus::Done);
    }

    #[test]
    fn blocks_snapshot_tracks_deltas_and_gap_free_sequences() {
        let mut buffer = JobBuffer::default();
        let events = [
            llm::StreamEvent::Start,
            llm::StreamEvent::TextStart { content_index: 0 },
            llm::StreamEvent::TextDelta {
                content_index: 0,
                delta: "he".into(),
            },
            llm::StreamEvent::TextDelta {
                content_index: 0,
                delta: "llo".into(),
            },
            llm::StreamEvent::TextEnd { content_index: 0 },
            llm::StreamEvent::Done {
                reason: "stop".into(),
                usage: llm::Usage::default(),
            },
        ];
        for event in &events {
            let seq = buffer.apply(event);
            assert_eq!(seq, buffer.last_seq);
        }
        assert_eq!(buffer.last_seq, 6);
        let progress = buffer.progress();
        let blocks: Vec<JobBlock> = serde_json::from_str(&progress.blocks).unwrap();
        match &blocks[0] {
            JobBlock::Text { text, .. } => assert_eq!(text, "hello"),
            other => panic!("unexpected block: {other:?}"),
        }
        assert!(buffer.terminal);
    }
}
