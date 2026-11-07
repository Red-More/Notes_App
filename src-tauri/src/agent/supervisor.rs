//! Rust-side run orchestrator: DB transcript -> single LLM call -> persisted result.
//!
//! Phase P3 handles pure answers only. Tool calls are not executed yet; a model
//! that asks for one fails the run with `tool_not_supported` instead of having
//! the request silently dropped.

use std::collections::HashMap;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};
use tokio::sync::{broadcast, Semaphore};

use super::cancel::CancellationToken;
use super::conversations::{self, ChatMessage, MessageUsage, NewMessage};
use super::events::{self, RunEvent};
use super::llm::{self, ModelRef, Options, ProxyContext, ProxyRequest, StreamEvent, Usage};
use super::model_store;
use super::params;
use super::runs::{self, AgentRun};
use super::AgentState;
use crate::privacy;
use crate::vfs::error::ToolError;
use crate::vfs::{VfsState, VirtualFs};

/// Live channel capacity; a slow subscriber falls back to DB replay.
const LIVE_CAPACITY: usize = 256;

// ---------------------------------------------------------------------------
// Hub: cancel tokens, live channels, seq counters and the global slot
// ---------------------------------------------------------------------------

struct RunSlot {
    token: CancellationToken,
    sender: broadcast::Sender<RunEvent>,
    seq: AtomicI64,
}

impl RunSlot {
    fn new() -> Self {
        let (sender, _) = broadcast::channel(LIVE_CAPACITY);
        Self {
            token: CancellationToken::new(),
            sender,
            seq: AtomicI64::new(0),
        }
    }

    fn next_seq(&self) -> i64 {
        self.seq.fetch_add(1, Ordering::SeqCst) + 1
    }

    fn bump_seq(&self, value: i64) {
        self.seq.fetch_max(value, Ordering::SeqCst);
    }

    fn send(&self, event: RunEvent) {
        // No subscriber yet is normal: boundary events are also persisted.
        let _ = self.sender.send(event);
    }
}

/// Managed Tauri state for the Rust orchestrator.
pub struct AgentRunHub {
    slots: Mutex<HashMap<i64, Arc<RunSlot>>>,
    /// Minimal cross-conversation cap: one model call in flight at a time.
    permits: Semaphore,
}

impl AgentRunHub {
    pub fn new() -> Self {
        Self {
            slots: Mutex::new(HashMap::new()),
            permits: Semaphore::new(1),
        }
    }

    fn ensure(&self, run_id: i64) -> Arc<RunSlot> {
        let mut slots = self.slots.lock().expect("run hub poisoned");
        slots
            .entry(run_id)
            .or_insert_with(|| Arc::new(RunSlot::new()))
            .clone()
    }

    fn slot(&self, run_id: i64) -> Option<Arc<RunSlot>> {
        self.slots
            .lock()
            .expect("run hub poisoned")
            .get(&run_id)
            .cloned()
    }

    fn remove(&self, run_id: i64) {
        self.slots.lock().expect("run hub poisoned").remove(&run_id);
    }

    pub fn token(&self, run_id: i64) -> Option<CancellationToken> {
        self.slot(run_id).map(|slot| slot.token.clone())
    }

    fn subscribe(&self, run_id: i64) -> Option<broadcast::Receiver<RunEvent>> {
        self.slot(run_id).map(|slot| slot.sender.subscribe())
    }

    /// Acquire the single execution slot; cancellation aborts the wait.
    async fn acquire<'a>(
        &'a self,
        token: &CancellationToken,
    ) -> Option<tokio::sync::SemaphorePermit<'a>> {
        tokio::select! {
            biased;
            _ = token.cancelled() => None,
            permit = self.permits.acquire() => permit.ok(),
        }
    }
}

impl Default for AgentRunHub {
    fn default() -> Self {
        Self::new()
    }
}

// ---------------------------------------------------------------------------
// Stream accumulation and error mapping
// ---------------------------------------------------------------------------

/// Everything needed to turn one model call into run state.
#[derive(Debug, Default)]
pub struct Accumulator {
    text: String,
    thinking: String,
    thinking_signature: Option<String>,
    usage: Option<MessageUsage>,
    stop_reason: Option<String>,
    error_message: Option<String>,
    cancelled: bool,
    tool_calls: bool,
}

impl Accumulator {
    pub fn apply(&mut self, event: &StreamEvent) {
        match event {
            StreamEvent::Start | StreamEvent::TextStart { .. } => {}
            StreamEvent::TextDelta { delta, .. } => self.text.push_str(delta),
            StreamEvent::TextEnd { .. } => {}
            StreamEvent::ThinkingStart { .. } => {}
            StreamEvent::ThinkingDelta { delta, .. } => self.thinking.push_str(delta),
            StreamEvent::ThinkingEnd { signature, .. } => {
                if signature.is_some() {
                    self.thinking_signature = signature.clone();
                }
            }
            StreamEvent::ToolCallStart { .. } | StreamEvent::ToolCallDelta { .. } => {
                self.tool_calls = true;
            }
            StreamEvent::ToolCallEnd { .. } => self.tool_calls = true,
            StreamEvent::Done { reason, usage } => {
                self.stop_reason = Some(normalize_reason(reason));
                self.usage = Some(usage_of(usage));
            }
            StreamEvent::Error {
                reason,
                error_message,
                usage,
            } => {
                if reason == "aborted" {
                    self.cancelled = true;
                } else {
                    self.error_message = Some(error_message.clone());
                }
                self.stop_reason = Some(normalize_reason(reason));
                self.usage = Some(usage_of(usage));
            }
        }
    }
}

fn usage_of(usage: &Usage) -> MessageUsage {
    MessageUsage {
        input: usage.input,
        output: usage.output,
        total_tokens: usage.total_tokens,
        cache_read: usage.cache_read,
        cache_write: usage.cache_write,
    }
}

fn normalize_reason(reason: &str) -> String {
    match reason {
        "toolUse" | "tool_use" => "toolUse".to_string(),
        other => other.to_string(),
    }
}

/// One classified failure with the copy persisted into the transcript.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunFailure {
    pub code: String,
    pub message: String,
}

/// Terminal outcome of one model call.
#[derive(Debug, Clone)]
pub struct Outcome {
    pub text: String,
    pub thinking: Option<String>,
    pub thinking_signature: Option<String>,
    pub usage: Option<MessageUsage>,
    pub stop_reason: String,
    pub is_partial: bool,
    pub failure: Option<RunFailure>,
    pub status: String,
}

impl Outcome {
    pub fn from_accumulator(acc: Accumulator, cancelled: bool) -> Self {
        let cancelled = cancelled || acc.cancelled;
        if cancelled {
            return Self {
                text: acc.text,
                thinking: None,
                thinking_signature: None,
                usage: None,
                stop_reason: "aborted".into(),
                is_partial: true,
                failure: None,
                status: "cancelled".into(),
            };
        }
        // Pure-answer phase: never swallow a requested tool call.
        if acc.tool_calls {
            return Self::failed("tool_not_supported", None);
        }
        if let Some(message) = acc.error_message {
            return Self::failed_from_text(&message);
        }
        Self {
            text: acc.text,
            thinking: if acc.thinking.is_empty() {
                None
            } else {
                Some(acc.thinking)
            },
            thinking_signature: acc.thinking_signature,
            usage: acc.usage,
            stop_reason: acc.stop_reason.unwrap_or_else(|| "stop".into()),
            is_partial: false,
            failure: None,
            status: "succeeded".into(),
        }
    }

    fn failed(code: &str, detail: Option<&str>) -> Self {
        Self {
            text: String::new(),
            thinking: None,
            thinking_signature: None,
            usage: None,
            stop_reason: "error".into(),
            is_partial: false,
            failure: Some(failure_copy(code, detail)),
            status: "failed".into(),
        }
    }

    /// Successful answer without reasoning; used by tests and the fixture.
    #[cfg(test)]
    pub fn success(text: impl Into<String>, usage: Option<MessageUsage>) -> Self {
        Self {
            text: text.into(),
            thinking: None,
            thinking_signature: None,
            usage,
            stop_reason: "stop".into(),
            is_partial: false,
            failure: None,
            status: "succeeded".into(),
        }
    }

    /// Cancelled run carrying the text received so far.
    #[cfg(test)]
    pub fn cancelled(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            thinking: None,
            thinking_signature: None,
            usage: None,
            stop_reason: "aborted".into(),
            is_partial: true,
            failure: None,
            status: "cancelled".into(),
        }
    }

    fn failed_from_text(detail: &str) -> Self {
        let code = classify_error(detail);
        Self::failed(&code, Some(detail))
    }
}

/// Map a provider error string to the shared error code used by the UI.
pub fn classify_error(text: &str) -> String {
    let lower = text.to_lowercase();
    if lower.contains("尚未配置")
        || lower.contains("未配置 api key")
        || lower.contains("missing api key")
    {
        return "auth_missing".into();
    }
    if lower.contains("http 401")
        || lower.contains("http 403")
        || lower.contains("unauthorized")
        || lower.contains("invalid api key")
        || lower.contains("未授权")
        || lower.contains("api key 无效")
    {
        return "auth_invalid".into();
    }
    if lower.contains("http 429")
        || lower.contains("rate limit")
        || lower.contains("too many requests")
        || lower.contains("过于频繁")
    {
        return "rate_limited".into();
    }
    if lower.contains("timeout") || lower.contains("timed out") || lower.contains("超时") {
        return "timeout".into();
    }
    if lower.contains("隐私") || lower.contains("privacy") || lower.contains("拦截") {
        return "privacy_blocked".into();
    }
    if lower.contains("网络")
        || lower.contains("network")
        || lower.contains("error sending request")
        || lower.contains("连接失败")
        || lower.contains("dns")
    {
        return "network".into();
    }
    if lower.contains("解析")
        || lower.contains("parse")
        || lower.contains("invalid json")
        || lower.contains("unexpected token")
        || lower.contains("不是合法 json")
    {
        return "protocol_changed".into();
    }
    if lower.contains("http 4") {
        return "provider_rejected".into();
    }
    "internal".into()
}

/// Stable user-facing copy per error code; mirrors the frontend `ERROR_COPY`.
pub fn error_copy(code: &str) -> &'static str {
    match code {
        "auth_missing" => "尚未配置 API Key，请到设置 → AI 助理中填写",
        "auth_invalid" => "API Key 无效或已过期，请更新后重试",
        "rate_limited" => "请求过于频繁，请稍后重试",
        "timeout" => "请求超时，请重试",
        "network" => "网络连接失败，请检查网络后重试",
        "provider_rejected" => "模型服务拒绝了本次请求",
        "protocol_changed" => "模型返回格式无法解析，请检查模型配置",
        "privacy_blocked" => "隐私策略拦截：本次内容不允许发送到云端",
        "tool_not_supported" => "当前版本暂不支持工具调用",
        "cancelled" => "已取消",
        _ => "内部错误",
    }
}

fn failure_copy(code: &str, detail: Option<&str>) -> RunFailure {
    let copy = error_copy(code);
    let message = match detail.map(str::trim) {
        Some(detail) if !detail.is_empty() && detail != copy => format!("{copy}（{detail}）"),
        _ => copy.to_string(),
    };
    RunFailure {
        code: code.to_string(),
        message,
    }
}

// ---------------------------------------------------------------------------
// Transcript: DB rows -> pi Message[]
// ---------------------------------------------------------------------------

/// Build the request transcript from persisted rows. DB is the only truth.
pub fn build_transcript(
    rows: &[ChatMessage],
    provider: &str,
    model_id: &str,
    api: &str,
) -> Vec<Value> {
    let mut out = Vec::new();
    for row in rows {
        match row.role.as_str() {
            "user" => {
                out.push(json!({
                    "role": "user",
                    "content": row.content,
                    "timestamp": row.created_at,
                }));
            }
            // Partial answers belong to an unfinished run; never replay them.
            "assistant" if !row.is_error && !row.is_partial && !row.content.is_empty() => {
                out.push(json!({
                    "role": "assistant",
                    "content": [{ "type": "text", "text": row.content }],
                    "api": api,
                    "provider": provider,
                    "model": model_id,
                    "stopReason": row.stop_reason.clone().unwrap_or_else(|| "stop".into()),
                    "timestamp": row.created_at,
                }));
            }
            // Error notices and tool rows are UI artifacts, not model turns.
            _ => {}
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

pub struct Finalized {
    pub run: AgentRun,
    /// Persisted assistant row; tests inspect it directly, callers use events.
    #[allow(dead_code)]
    pub message: Option<ChatMessage>,
    pub events: Vec<RunEvent>,
}

fn timestamp(conn: &rusqlite::Connection) -> Result<String, ToolError> {
    Ok(conn.query_row("SELECT datetime('now','localtime')", [], |row| row.get(0))?)
}

/// Persist the assistant row, the run row and every boundary event atomically.
///
/// `start_seq` must be allocated by the hub before this call; deltas consumed
/// the seqs below it, so the returned events never collide with live ones.
pub fn finalize(
    vfs: &VirtualFs,
    run: &AgentRun,
    outcome: &Outcome,
    start_seq: i64,
) -> Result<Finalized, ToolError> {
    let conn = vfs.conn();
    let at = timestamp(conn)?;
    let is_failed = outcome.status == "failed";
    let content = if is_failed {
        outcome
            .failure
            .as_ref()
            .map(|failure| failure.message.clone())
            .unwrap_or_default()
    } else {
        outcome.text.clone()
    };
    let should_write = !content.is_empty() || is_failed;
    let partial = if outcome.is_partial && !outcome.text.is_empty() {
        Some(json!({ "text": outcome.text }).to_string())
    } else {
        None
    };

    let mut seq = start_seq;
    let mut events = Vec::new();
    let tx = conn.unchecked_transaction()?;
    let message = if should_write {
        let item = NewMessage {
            role: "assistant".into(),
            content: content.clone(),
            is_error: is_failed,
            usage: if is_failed { None } else { outcome.usage },
            thinking: if is_failed {
                None
            } else {
                outcome.thinking.clone()
            },
            thinking_signature: if is_failed {
                None
            } else {
                outcome.thinking_signature.clone()
            },
            run_id: Some(run.run_id),
            is_partial: outcome.is_partial,
            stop_reason: Some(outcome.stop_reason.clone()),
            ..Default::default()
        };
        let message = conversations::insert_message(&tx, run.conversation_id, item, &at)?;
        events.push(RunEvent::new(
            run.run_id,
            seq,
            events::ASSISTANT,
            serde_json::to_value(&message).map_err(|e| ToolError::Storage {
                message: format!("消息序列化失败：{e}"),
            })?,
        ));
        seq += 1;
        Some(message)
    } else {
        None
    };

    if let Some(failure) = &outcome.failure {
        events.push(RunEvent::new(
            run.run_id,
            seq,
            events::ERROR,
            json!({ "errorCode": failure.code, "message": failure.message }),
        ));
        seq += 1;
    }

    events.push(RunEvent::new(
        run.run_id,
        seq,
        events::STATE,
        json!({ "status": outcome.status }),
    ));
    seq += 1;

    let last_seq = seq;
    events.push(RunEvent::new(
        run.run_id,
        last_seq,
        events::END,
        json!({
            "status": outcome.status,
            "errorCode": outcome.failure.as_ref().map(|f| f.code.clone()),
            "partial": partial,
        }),
    ));

    let finished = runs::finish_on(
        &tx,
        run.run_id,
        &outcome.status,
        partial,
        outcome.failure.as_ref().map(|f| f.code.clone()),
        1,
        0,
        last_seq,
    )?;
    for event in &events {
        events::append(&tx, event)?;
    }
    tx.commit()?;

    Ok(Finalized {
        run: finished,
        message,
        events,
    })
}

fn is_terminal(status: &str) -> bool {
    matches!(status, "succeeded" | "failed" | "cancelled" | "interrupted")
}

// ---------------------------------------------------------------------------
// Live orchestration
// ---------------------------------------------------------------------------

/// Finish a queued run immediately and publish its terminal boundary events.
pub fn cancel_queued(app: &AppHandle, run: &AgentRun) -> Result<AgentRun, ToolError> {
    let hub = app.state::<AgentRunHub>();
    let slot = hub.ensure(run.run_id);
    seed_seq(app, run.run_id, &slot)?;
    let seq = slot.next_seq();
    let end_seq = seq + 1;
    let events = vec![
        RunEvent::new(
            run.run_id,
            seq,
            events::STATE,
            json!({ "status": "cancelled" }),
        ),
        RunEvent::new(
            run.run_id,
            end_seq,
            events::END,
            json!({ "status": "cancelled", "errorCode": null, "partial": null }),
        ),
    ];
    let finished = {
        let vfs_state = app.state::<VfsState>();
        let vfs = crate::lock(&vfs_state.0);
        let tx = vfs.conn().unchecked_transaction()?;
        let finished = runs::finish_on(&tx, run.run_id, "cancelled", None, None, 0, 0, end_seq)?;
        for event in &events {
            events::append(&tx, event)?;
        }
        tx.commit()?;
        finished
    };
    slot.bump_seq(end_seq);
    for event in events {
        slot.send(event);
    }
    hub.remove(run.run_id);
    Ok(finished)
}

/// Register the run, persist its initial state event and spawn the supervisor.
pub fn start(app: &AppHandle, run: &AgentRun, status: &str) -> Result<(), ToolError> {
    let hub = app.state::<AgentRunHub>();
    hub.ensure(run.run_id);
    publish_state(app, run.run_id, status)?;
    spawn(app.clone(), run.run_id);
    Ok(())
}

/// Register a queued run without spawning it: the previous run pumps the queue.
pub fn mark_queued(app: &AppHandle, run_id: i64) -> Result<(), ToolError> {
    let hub = app.state::<AgentRunHub>();
    hub.ensure(run_id);
    publish_state(app, run_id, "queued")
}

pub fn spawn(app: AppHandle, run_id: i64) {
    tauri::async_runtime::spawn(async move {
        if let Err(e) = execute(app, run_id).await {
            log::warn!("run {run_id} supervisor failed: {e}");
        }
    });
}

/// Persist and broadcast one non-terminal state boundary event.
pub fn publish_state(app: &AppHandle, run_id: i64, status: &str) -> Result<(), ToolError> {
    let hub = app.state::<AgentRunHub>();
    let slot = hub.ensure(run_id);
    seed_seq(app, run_id, &slot)?;
    let seq = slot.next_seq();
    let event = RunEvent::new(run_id, seq, events::STATE, json!({ "status": status }));
    {
        let vfs_state = app.state::<VfsState>();
        let vfs = crate::lock(&vfs_state.0);
        events::append(vfs.conn(), &event)?;
    }
    slot.send(event);
    Ok(())
}

/// Continue the counter after any events persisted before this slot existed.
fn seed_seq(app: &AppHandle, run_id: i64, slot: &RunSlot) -> Result<(), ToolError> {
    let max = {
        let vfs_state = app.state::<VfsState>();
        let vfs = crate::lock(&vfs_state.0);
        events::max_seq(vfs.conn(), run_id)?
    };
    slot.bump_seq(max);
    Ok(())
}

async fn execute(app: AppHandle, run_id: i64) -> Result<(), ToolError> {
    let hub = app.state::<AgentRunHub>();
    let slot = hub.ensure(run_id);
    let token = slot.token.clone();

    let run = {
        let vfs_state = app.state::<VfsState>();
        let vfs = crate::lock(&vfs_state.0);
        runs::get_run(vfs.conn(), run_id)?
    };
    let Some(run) = run else { return Ok(()) };
    if run.status != "running" {
        return Ok(());
    }

    // Cross-conversation calls are serialized by the single permit.
    let Some(_permit) = hub.acquire(&token).await else {
        let outcome = Outcome::from_accumulator(Accumulator::default(), true);
        return finalize_and_pump(&app, &run, &slot, outcome);
    };

    let (entry, params, snapshot, transcript) = {
        let vfs_state = app.state::<VfsState>();
        let vfs = crate::lock(&vfs_state.0);
        let agent = app.state::<AgentState>();
        let entry = model_store::resolve(vfs.conn(), &run.model_entry)?;
        if !entry.kind.is_chat() {
            return Err(ToolError::invalid("该模型条目不是对话模型"));
        }
        let params = params::get(vfs.conn(), &entry.id);
        let rows = conversations::messages(&vfs, run.conversation_id)?;
        let transcript = build_transcript(&rows, &entry.id, &entry.model_id, entry.format.pi_api());
        let snapshot = privacy::policy::Snapshot::load(vfs.conn(), &agent.secrets)?;
        (entry, params, snapshot, transcript)
    };

    let transcript = llm::trim_messages(&transcript);
    let decision = privacy::egress::guard(&transcript, &snapshot);
    {
        let vfs_state = app.state::<VfsState>();
        let vfs = crate::lock(&vfs_state.0);
        if let Err(e) = privacy::egress::record_audit(vfs.conn(), &entry.id, "run", &decision) {
            log::warn!("egress audit write failed: {e}");
        }
    }
    if decision.blocked() {
        let detail = decision.message.clone().unwrap_or_default();
        let outcome = Outcome::failed("privacy_blocked", Some(&detail));
        return finalize_and_pump(&app, &run, &slot, outcome);
    }

    let request = ProxyRequest {
        request_id: format!("run-{run_id}"),
        model: ModelRef {
            id: entry.model_id.clone(),
            provider: entry.id.clone(),
            api: entry.format.pi_api().to_string(),
        },
        context: ProxyContext {
            messages: transcript,
        },
        options: Options {
            session_id: Some(format!("conv-{}", run.conversation_id)),
            ..Default::default()
        },
    };

    let accumulator = Mutex::new(Accumulator::default());
    let emit = |event: StreamEvent| {
        let mut acc = accumulator.lock().expect("accumulator poisoned");
        acc.apply(&event);
        let delta = match &event {
            StreamEvent::TextDelta { delta, .. } => Some(delta.clone()),
            _ => None,
        };
        drop(acc);
        if let Some(delta) = delta {
            let seq = slot.next_seq();
            slot.send(RunEvent::new(
                run_id,
                seq,
                "delta",
                json!({ "delta": delta }),
            ));
        }
    };

    let agent = app.state::<AgentState>();
    let result = llm::run(&agent, request, &entry, &params, token.clone(), &emit).await;
    let mut outcome =
        Outcome::from_accumulator(replace_accumulator(&accumulator), token.is_cancelled());
    if let Err(error) = result {
        // Setup failures never produced a stream; surface them as a failure.
        if outcome.status != "cancelled" {
            outcome = Outcome::failed_from_text(&error.to_string());
        }
    }
    finalize_and_pump(&app, &run, &slot, outcome)
}

fn replace_accumulator(slot: &Mutex<Accumulator>) -> Accumulator {
    std::mem::take(&mut *slot.lock().expect("accumulator poisoned"))
}

fn finalize_and_pump(
    app: &AppHandle,
    run: &AgentRun,
    slot: &RunSlot,
    outcome: Outcome,
) -> Result<(), ToolError> {
    // Cancellation always walks running -> cancelling -> cancelled.
    if outcome.status == "cancelled" {
        let transitioned = {
            let vfs_state = app.state::<VfsState>();
            let vfs = crate::lock(&vfs_state.0);
            runs::transition(&vfs, run.run_id, "cancelling").is_ok()
        };
        if transitioned {
            publish_state(app, run.run_id, "cancelling")?;
        }
    }
    let start_seq = slot.next_seq();
    let finalized = {
        let vfs_state = app.state::<VfsState>();
        let vfs = crate::lock(&vfs_state.0);
        finalize(&vfs, run, &outcome, start_seq)?
    };
    slot.bump_seq(finalized.run.last_seq);
    for event in &finalized.events {
        slot.send(event.clone());
    }
    let hub = app.state::<AgentRunHub>();
    hub.remove(run.run_id);
    pump_next(app, run.conversation_id)
}

/// Start the oldest queued run of the same conversation after a terminal state.
fn pump_next(app: &AppHandle, conversation_id: i64) -> Result<(), ToolError> {
    let next = {
        let vfs_state = app.state::<VfsState>();
        let vfs = crate::lock(&vfs_state.0);
        runs::next_queued(vfs.conn(), conversation_id)?
    };
    let Some(next) = next else { return Ok(()) };
    {
        let vfs_state = app.state::<VfsState>();
        let vfs = crate::lock(&vfs_state.0);
        runs::transition(&vfs, next.run_id, "running")?;
    }
    start(app, &next, "running")
}

// ---------------------------------------------------------------------------
// Attach / snapshot
// ---------------------------------------------------------------------------

/// Replay boundary events after `after_seq`, then stream live until the run ends.
pub async fn attach(app: &AppHandle, run_id: i64, after_seq: i64, on_event: impl Fn(RunEvent)) {
    let hub = app.state::<AgentRunHub>();
    // Subscribe before replay so no live event falls into the gap.
    let receiver = hub.subscribe(run_id);
    let mut seen = after_seq;
    let (replayed, status) = {
        let vfs_state = app.state::<VfsState>();
        let vfs = crate::lock(&vfs_state.0);
        let events = events::replay(vfs.conn(), run_id, after_seq).unwrap_or_default();
        let status = runs::get_run(vfs.conn(), run_id)
            .ok()
            .flatten()
            .map(|run| run.status)
            .unwrap_or_else(|| "interrupted".into());
        (events, status)
    };
    for event in replayed {
        seen = seen.max(event.seq);
        on_event(event);
    }
    if is_terminal(&status) {
        return;
    }
    let Some(mut receiver) = receiver else { return };
    loop {
        match receiver.recv().await {
            Ok(event) => {
                if event.seq > seen {
                    seen = event.seq;
                    let ended = event.kind == events::END;
                    on_event(event);
                    if ended {
                        return;
                    }
                }
            }
            Err(broadcast::error::RecvError::Lagged(_)) => {
                // A slow subscriber rebuilds from persisted boundaries.
                let replayed = {
                    let vfs_state = app.state::<VfsState>();
                    let vfs = crate::lock(&vfs_state.0);
                    events::replay(vfs.conn(), run_id, seen).unwrap_or_default()
                };
                let ended = replayed.iter().any(|event| event.kind == events::END);
                for event in replayed {
                    seen = seen.max(event.seq);
                    on_event(event);
                }
                if ended {
                    return;
                }
            }
            Err(broadcast::error::RecvError::Closed) => return,
        }
    }
}

/// Cold snapshot: run row plus every boundary event after the cursor.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunSnapshot {
    pub run: AgentRun,
    pub events: Vec<RunEvent>,
}

pub fn snapshot(vfs: &VirtualFs, run_id: i64, after_seq: i64) -> Result<RunSnapshot, ToolError> {
    let run = runs::get_run(vfs.conn(), run_id)?.ok_or_else(|| ToolError::NotFound {
        path: format!("run#{run_id}"),
    })?;
    let events = events::replay(vfs.conn(), run_id, after_seq)?;
    Ok(RunSnapshot { run, events })
}
