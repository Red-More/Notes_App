//! Multi-round tool loop, decoupled from Tauri and SQLite so it stays testable.
//!
//! One round = one model call. Tool rounds are persisted incrementally:
//! the assistant `tool_calls` row first, then one `role=tool` row per result,
//! so a refresh (or a crash) never loses what the model already asked for.

use std::time::Instant;

use futures_util::future::BoxFuture;
use serde_json::{json, Value};

use super::conversations::MessageUsage;
use super::supervisor::{classify_error, failure_copy, RunFailure};
use super::tools::{ToolCall, ToolResult};
use crate::vfs::error::ToolError;

/// Provider identity copied into reconstructed assistant turns.
#[derive(Debug, Clone)]
pub struct ModelIds {
    pub api: String,
    pub provider: String,
    pub model: String,
}

/// Step / write caps; mirrors the frontend `beforeToolCall` rules.
#[derive(Debug, Clone, Copy)]
pub struct Limits {
    pub max_steps: i64,
    pub max_writes: i64,
}

/// One model call reduced to loop-relevant fields.
#[derive(Debug, Clone)]
pub struct Round {
    pub text: String,
    pub thinking: Option<String>,
    pub thinking_signature: Option<String>,
    pub usage: Option<MessageUsage>,
    pub stop_reason: String,
    pub calls: Vec<ToolCall>,
    pub error_message: Option<String>,
    pub cancelled: bool,
}

/// Assistant row persisted before its tools run.
#[derive(Debug, Clone)]
pub struct AssistantHeader {
    pub text: String,
    pub thinking: Option<String>,
    pub thinking_signature: Option<String>,
    pub usage: Option<MessageUsage>,
    pub stop_reason: String,
    pub calls: Vec<ToolCall>,
}

/// One persisted `role=tool` row.
#[derive(Debug, Clone)]
pub struct ToolRecord {
    pub call: ToolCall,
    pub text: String,
    pub is_error: bool,
    pub error_code: Option<String>,
    pub duration_ms: Option<i64>,
}

#[derive(Debug, Clone)]
pub enum Stop {
    /// Model answered without calling tools.
    Complete,
    /// Tool batch blocked because the run hit the step cap.
    StepLimit,
    /// User cancelled; `text` is not yet persisted when non-empty.
    Cancelled,
    Failed(RunFailure),
}

#[derive(Debug, Clone)]
pub struct LoopOutcome {
    pub stop: Stop,
    /// Final answer (Complete) or still-unpersisted partial text (Cancelled).
    pub text: String,
    /// Last assistant text already persisted by the loop itself.
    pub persisted_text: String,
    pub usage: Option<MessageUsage>,
    pub stop_reason: String,
    pub steps: i64,
    pub writes: i64,
}

/// Side effects the loop needs; the production host locks the DB per call only.
pub trait LoopHost {
    fn call_model<'a>(
        &'a mut self,
        messages: Vec<Value>,
    ) -> BoxFuture<'a, Result<Round, ToolError>>;
    fn run_tool<'a>(&'a mut self, call: ToolCall) -> BoxFuture<'a, ToolResult>;
    fn persist_assistant(&mut self, header: &AssistantHeader) -> Result<(), ToolError>;
    fn persist_tool(&mut self, record: &ToolRecord) -> Result<(), ToolError>;
    fn cancelled(&self) -> bool;
}

/// Run until the model answers, the run is cancelled, or a cap trips.
pub async fn run<H: LoopHost>(
    host: &mut H,
    mut messages: Vec<Value>,
    model: &ModelIds,
    limits: Limits,
) -> LoopOutcome {
    let mut steps = 0;
    let mut writes = 0;
    let mut persisted_text = String::new();
    let mut usage = None;
    let mut stop_reason = "stop".to_string();

    loop {
        let round = match host.call_model(messages.clone()).await {
            Ok(round) => round,
            Err(error) => {
                let detail = error.to_string();
                return finish(
                    Stop::Failed(failure_copy(&classify_error(&detail), Some(&detail))),
                    String::new(),
                    persisted_text,
                    usage,
                    stop_reason,
                    steps,
                    writes,
                );
            }
        };
        usage = round.usage;
        stop_reason = round.stop_reason.clone();

        if round.cancelled || host.cancelled() {
            return finish(
                Stop::Cancelled,
                round.text,
                persisted_text,
                usage,
                stop_reason,
                steps,
                writes,
            );
        }
        if let Some(detail) = &round.error_message {
            return finish(
                Stop::Failed(failure_copy(&classify_error(detail), Some(detail))),
                String::new(),
                persisted_text,
                usage,
                stop_reason,
                steps,
                writes,
            );
        }
        if round.calls.is_empty() {
            return finish(
                Stop::Complete,
                round.text,
                persisted_text,
                usage,
                stop_reason,
                steps,
                writes,
            );
        }

        let header = AssistantHeader {
            text: round.text.clone(),
            thinking: round.thinking.clone(),
            thinking_signature: round.thinking_signature.clone(),
            usage: round.usage,
            stop_reason: round.stop_reason.clone(),
            calls: round.calls.clone(),
        };
        if let Err(error) = host.persist_assistant(&header) {
            return finish(
                Stop::Failed(failure_copy("internal", Some(&error.to_string()))),
                String::new(),
                persisted_text,
                usage,
                stop_reason,
                steps,
                writes,
            );
        }
        persisted_text = header.text.clone();
        messages.push(assistant_message(&header, model));

        // Caps mirror the frontend: they are evaluated per batch from the rows
        // already persisted, so a batch never half-passes the check.
        let write_calls = header
            .calls
            .iter()
            .filter(|call| is_write(&call.name))
            .count() as i64;
        let step_blocked = steps >= limits.max_steps;
        let write_blocked = writes + write_calls >= limits.max_writes;
        let truncated = round.stop_reason == "length";

        for call in &header.calls {
            if host.cancelled() {
                return finish(
                    Stop::Cancelled,
                    String::new(),
                    persisted_text,
                    usage,
                    stop_reason,
                    steps,
                    writes,
                );
            }
            let mut duration_ms = None;
            let result = if step_blocked {
                ToolResult::fail_with(step_limit_copy(limits.max_steps), "step_limit_exceeded")
            } else if truncated {
                ToolResult::fail_with(
                    "上一次输出因达到长度上限被截断，本次工具调用的参数可能不完整，已按失败处理；请重新发起更小的调用。",
                    "truncated",
                )
            } else if write_blocked && is_write(&call.name) {
                ToolResult::fail_with(write_limit_copy(limits.max_writes), "write_limit_exceeded")
            } else {
                let started = Instant::now();
                let result = host.run_tool(call.clone()).await;
                duration_ms = Some(started.elapsed().as_millis() as i64);
                if host.cancelled() {
                    return finish(
                        Stop::Cancelled,
                        String::new(),
                        persisted_text,
                        usage,
                        stop_reason,
                        steps,
                        writes,
                    );
                }
                result
            };
            let record = ToolRecord {
                call: call.clone(),
                text: result.text,
                is_error: result.is_error,
                error_code: result.error_code,
                duration_ms,
            };
            if let Err(error) = host.persist_tool(&record) {
                return finish(
                    Stop::Failed(failure_copy("internal", Some(&error.to_string()))),
                    String::new(),
                    persisted_text,
                    usage,
                    stop_reason,
                    steps,
                    writes,
                );
            }
            steps += 1;
            messages.push(tool_message(&record));
        }
        writes += write_calls;

        if step_blocked {
            return finish(
                Stop::StepLimit,
                String::new(),
                persisted_text,
                usage,
                stop_reason,
                steps,
                writes,
            );
        }
    }
}

fn finish(
    stop: Stop,
    text: String,
    persisted_text: String,
    usage: Option<MessageUsage>,
    stop_reason: String,
    steps: i64,
    writes: i64,
) -> LoopOutcome {
    LoopOutcome {
        stop,
        text,
        persisted_text,
        usage,
        stop_reason,
        steps,
        writes,
    }
}

fn is_write(name: &str) -> bool {
    matches!(name, "fs_write" | "fs_edit")
}

/// Text matches the frontend `beforeToolCall` reasons verbatim.
fn step_limit_copy(max: i64) -> String {
    format!("单轮工具调用超过 {max} 步，请先总结已获得的信息再继续")
}

fn write_limit_copy(max: i64) -> String {
    format!("单轮文档写入超过 {max} 次，请先合并内容再继续")
}

/// Rebuild the assistant turn for the next request.
pub fn assistant_message(header: &AssistantHeader, model: &ModelIds) -> Value {
    let mut content: Vec<Value> = Vec::new();
    if let (Some(thinking), Some(signature)) = (&header.thinking, &header.thinking_signature) {
        content.push(json!({
            "type": "thinking",
            "thinking": thinking,
            "thinkingSignature": signature,
        }));
    }
    if !header.text.trim().is_empty() {
        content.push(json!({ "type": "text", "text": header.text }));
    }
    for call in &header.calls {
        content.push(call.to_json());
    }
    json!({
        "role": "assistant",
        "content": content,
        "api": model.api,
        "provider": model.provider,
        "model": model.model,
        "stopReason": header.stop_reason,
        "timestamp": 0,
    })
}

/// Rebuild the `toolResult` turn fed back to the model.
pub fn tool_message(record: &ToolRecord) -> Value {
    json!({
        "role": "toolResult",
        "toolCallId": record.call.id,
        "toolName": record.call.name,
        "content": [{ "type": "text", "text": record.text }],
        "isError": record.is_error,
        // Kept on the wire only; providers ignore unknown keys and the row
        // itself has no column for it.
        "errorCode": record.error_code,
        "timestamp": 0,
    })
}
