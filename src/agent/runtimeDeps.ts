//! Production bindings for the runtime's storage/capability dependencies.
//!
//! Keeping these in one module lets tests substitute fakes without importing
//! Tauri at all.

import { chatApi, mcpApi, mediaApi, skillApi } from '../api'
import { parseImageAssetIds } from './runtime'
import type { AgentRuntimeDeps } from './AgentRuntime'

/** Collect every image asset referenced by user turns and fetch its bytes. */
async function loadImages(
  records: Parameters<AgentRuntimeDeps['loadImages']>[0],
): Promise<Map<number, { mime: string; data: string }>> {
  const ids = new Set<number>()
  for (const record of records) {
    if (record.role !== 'user') continue
    for (const id of parseImageAssetIds(record.imageAssetIds)) ids.add(id)
  }
  const images = new Map<number, { mime: string; data: string }>()
  await Promise.all(
    [...ids].map(async (id) => {
      try {
        images.set(id, await mediaApi.assetData(id))
      } catch {
        // A purged asset must not keep the transcript from loading.
      }
    }),
  )
  return images
}

export function createRuntimeDeps(): AgentRuntimeDeps {
  return {
    loadMessages: (conversationId) => chatApi.messages(conversationId),
    loadImages,
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
    startRustRun: (conversationId, trigger, modelEntry, message) =>
      chatApi.runRustStart({ conversationId, trigger, modelEntry, message: message ?? null }),
    attachRustRun: (runId, afterSeq, onEvent) =>
      chatApi.runRustAttach({ runId, afterSeq }, onEvent),
    cancelRustRun: (runId) => chatApi.runRustCancel(runId),
    snapshotRustRun: (runId, afterSeq) => chatApi.runRustSnapshot(runId, afterSeq),
  }
}
