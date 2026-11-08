//! Production bindings for the runtime's storage/capability dependencies.
//!
//! Keeping these in one module lets tests substitute fakes without importing
//! Tauri at all.

import { chatApi, mcpApi, skillApi } from '../api'
import type { AgentRuntimeDeps } from './AgentRuntime'

export function createRuntimeDeps(): AgentRuntimeDeps {
  return {
    loadMessages: (conversationId) => chatApi.messages(conversationId),
    append: (conversationId, messages) => chatApi.append({ conversationId, messages }),
    truncate: async (conversationId, messageId) => {
      await chatApi.truncate({ conversationId, messageId })
    },
    loadSkills: () => skillApi.list(),
    loadMcpTools: () => mcpApi.tools(),
    createConversation: (title) => chatApi.create({ title }),
    startRun: (conversationId, trigger, modelEntry, message) =>
      chatApi.runStart({ conversationId, trigger, modelEntry, message: message ?? null }),
    resumeRun: (conversationId, modelEntry) =>
      chatApi.runResume({ conversationId, modelEntry }),
    transitionRun: (runId, status) => chatApi.runTransition({ runId, status }),
    finishRun: (runId, status, data) => chatApi.runFinish({ runId, status, ...data }),
    touchRun: (runId, stepCount, writeCount, lastSeq) =>
      chatApi.runTouch({ runId, stepCount, writeCount, lastSeq }),
    loadRunState: (conversationId) => chatApi.runState(conversationId),
  }
}
