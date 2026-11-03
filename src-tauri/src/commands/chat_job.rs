//! Chat job commands: submit, watch, snapshot, list, cancel.
//!
//! The legacy `agent_stream` / `agent_cancel` commands stay untouched. New
//! clients submit a job and watch it; a detached viewer UI may unsubscribe at
//! any time without cancelling the generation.

use std::sync::atomic::Ordering;
use std::sync::Arc;

use tauri::ipc::Channel;
use tauri::State;

use crate::agent::jobs::{self, ChatJob, ChatJobWatchEvent, ChatJobs};
use crate::agent::llm;
use crate::agent::model_store;
use crate::agent::AgentState;
use crate::vfs::error::ToolError;
use crate::vfs::VfsState;

/// Enqueue one model turn. Returns immediately with `status = queued`; the
/// dispatcher starts it as soon as the conversation's engine lane is free.
#[tauri::command]
pub fn chat_job_submit(
    vfs_state: State<'_, VfsState>,
    agent_state: State<'_, AgentState>,
    jobs: State<'_, Arc<ChatJobs>>,
    conversation_id: i64,
    request: llm::ProxyRequest,
) -> Result<ChatJob, ToolError> {
    let vfs = vfs_state.0.lock().unwrap();
    model_store::cleanup_legacy(vfs.conn(), &agent_state.secrets);
    let entry = model_store::resolve(vfs.conn(), &request.model.provider)?;
    if !entry.kind.is_chat() {
        return Err(ToolError::invalid("该模型条目不是对话模型"));
    }
    let job = jobs::submit(vfs.conn(), conversation_id, &entry, &request)?;
    jobs.enqueue_for(&entry, job.id, request);
    Ok(job)
}

/// Register a viewer. The first event is always the persisted snapshot, then
/// only events newer than it are forwarded, so a late subscriber never sees a
/// gap and a reconnect rebuilds from `blocks`.
#[tauri::command]
pub async fn chat_job_watch(
    vfs_state: State<'_, VfsState>,
    jobs: State<'_, Arc<ChatJobs>>,
    job_id: i64,
    after_seq: Option<i64>,
    on_event: Channel<ChatJobWatchEvent>,
) -> Result<(), ToolError> {
    // Subscribe before reading the snapshot: events emitted in between are
    // buffered and filtered by the snapshot's `last_seq`.
    let live = jobs.live(job_id);
    let mut receiver = live.as_ref().map(|live| live.subscribe());

    let job = {
        let vfs = vfs_state.0.lock().unwrap();
        jobs::get(vfs.conn(), job_id)?
    };
    if on_event
        .send(ChatJobWatchEvent::Snapshot { job: job.clone() })
        .is_err()
    {
        return Ok(());
    }
    if job.status.is_terminal() {
        return Ok(());
    }
    let Some(receiver) = receiver.as_mut() else {
        return Ok(());
    };
    let known = job.last_seq.max(after_seq.unwrap_or(0));
    loop {
        match receiver.recv().await {
            Ok(item) if item.seq > known => {
                if on_event
                    .send(ChatJobWatchEvent::Event {
                        job_id,
                        seq: item.seq,
                        event: item.event,
                    })
                    .is_err()
                {
                    break;
                }
            }
            // Already folded into the snapshot.
            Ok(_) => {}
            // The viewer is too slow; close so the client can resubscribe and
            // rebuild from a fresh snapshot instead of applying a gap.
            Err(tokio::sync::broadcast::error::RecvError::Lagged(skipped)) => {
                log::warn!("chat job {job_id} watch lagged {skipped} events");
                break;
            }
            Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
        }
    }
    Ok(())
}

#[tauri::command]
pub fn chat_job_snapshot(
    vfs_state: State<'_, VfsState>,
    job_id: i64,
) -> Result<ChatJob, ToolError> {
    let vfs = vfs_state.0.lock().unwrap();
    jobs::get(vfs.conn(), job_id)
}

#[tauri::command]
pub fn chat_job_list(
    vfs_state: State<'_, VfsState>,
    conversation_id: Option<i64>,
    limit: Option<i64>,
) -> Result<Vec<ChatJob>, ToolError> {
    let vfs = vfs_state.0.lock().unwrap();
    jobs::list(vfs.conn(), conversation_id, limit.unwrap_or(50))
}

/// Cancel a queued job outright, or flag a running one. The runner owns the
/// terminal write, so a cancellation racing a completion still wins.
#[tauri::command]
pub fn chat_job_cancel(
    vfs_state: State<'_, VfsState>,
    jobs: State<'_, Arc<ChatJobs>>,
    job_id: i64,
) -> Result<ChatJob, ToolError> {
    let vfs = vfs_state.0.lock().unwrap();
    if jobs::cancel_queued(vfs.conn(), job_id)? {
        return jobs::get(vfs.conn(), job_id);
    }
    if let Some(live) = jobs.live(job_id) {
        live.cancel.store(true, Ordering::SeqCst);
    }
    jobs::mark_cancelling(vfs.conn(), job_id)?;
    jobs::get(vfs.conn(), job_id)
}
