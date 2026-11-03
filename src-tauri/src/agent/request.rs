//! Shared request preparation for `agent_stream` and the chat job runner.
//!
//! Both entry points must apply the same trim, model-entry resolution and
//! egress gate; keeping it here prevents the detached job path from drifting.

use super::llm::{self, ProxyRequest};
use super::model_store::{self, ModelEntry};
use super::params::{self, LlmParams};
use super::AgentState;
use crate::privacy;
use crate::vfs::error::ToolError;
use crate::vfs::VfsState;

/// A request that passed local validation and, for cloud entries, the gate.
pub(crate) struct PreparedRun {
    pub request: ProxyRequest,
    pub entry: ModelEntry,
    pub params: LlmParams,
    /// `None` for local entries; cloud entries carry the audit decision.
    pub decision: Option<privacy::egress::Decision>,
}

pub(crate) fn prepare(
    vfs_state: &VfsState,
    state: &AgentState,
    mut request: ProxyRequest,
) -> Result<PreparedRun, ToolError> {
    // Trim first: the egress gate must judge exactly what would be sent.
    request.context.messages = llm::trim_messages(&request.context.messages);

    let (entry, params, snapshot) = {
        let vfs = vfs_state.0.lock().unwrap();
        model_store::cleanup_legacy(vfs.conn(), &state.secrets);
        let entry = model_store::resolve(vfs.conn(), &request.model.provider)?;
        // Only chat entries can stream into the agent; media kinds stay inactive.
        if !entry.kind.is_chat() {
            return Err(ToolError::invalid("该模型条目不是对话模型"));
        }
        let params = params::get(vfs.conn(), &entry.id);
        // Local entries never leave the device, so the gate snapshot is skipped.
        let snapshot = if entry.format.is_local() {
            None
        } else {
            // Labels + decrypted EDM values; loading here keeps the lock short.
            Some(privacy::policy::Snapshot::load(vfs.conn(), &state.secrets)?)
        };
        (entry, params, snapshot)
    };

    // The single egress gate: S0 and un-redacted S1 never reach the network.
    let decision = match &snapshot {
        Some(snapshot) => {
            let decision = privacy::egress::guard(&request.context.messages, snapshot);
            let vfs = vfs_state.0.lock().unwrap();
            if let Err(e) = privacy::egress::record_audit(vfs.conn(), &entry.id, "chat", &decision)
            {
                log::warn!("egress audit write failed: {e}");
            }
            Some(decision)
        }
        None => None,
    };

    Ok(PreparedRun {
        request,
        entry,
        params,
        decision,
    })
}
