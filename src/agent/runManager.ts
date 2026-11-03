//! Per-conversation run registry.
//!
//! A run owns the pi-agent instance and one persistent event subscription.
//! Persistence lives here so an unmounted ChatPage cannot lose the tail of a
//! turn; the page only registers a UI listener that can be attached/detached
//! freely (`detach` never aborts). Only an explicit stop or conversation
//! deletion aborts the agent.

import type { Agent, AgentEvent, AgentMessage } from '@earendil-works/pi-agent-core'
import type { AssistantMessage } from '@earendil-works/pi-ai'
import { chatApi } from '../api'
import type { MessageUsage } from '../types'
import { extractAssistant } from './runtime'
import { lastJobId } from './stream'

export interface Run {
  conversationId: number
  agent: Agent
  unsubscribe: () => void
  /** UI listener; `null` while the page is detached. Persistence keeps running. */
  handler: ((event: AgentEvent) => void) | null
  persistQueue: Promise<unknown>
  pendingInitialUser: boolean
  streaming: boolean
}

const runs = new Map<number, Run>()

function usageFromMessage(message: AssistantMessage): MessageUsage | null {
  const usage = message.usage
  if (!usage || usage.totalTokens <= 0) return null
  return {
    input: usage.input,
    output: usage.output,
    totalTokens: usage.totalTokens,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
  }
}

/** Plain text of a user message (string or content blocks). */
function userText(message: AgentMessage): string {
  const content = (message as { content?: unknown }).content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter((block): block is { type: 'text'; text: string } => block?.type === 'text')
      .map((block) => block.text)
      .join('\n')
  }
  return ''
}

function enqueue(run: Run, task: () => Promise<unknown>): void {
  const next = run.persistQueue.then(task)
  run.persistQueue = next.catch((error) => {
    console.error('保存 Agent 消息失败', error)
  })
}

/**
 * Persistence is independent of the UI: it runs for detached conversations
 * too, which is what makes switching pages non-destructive.
 */
function persistEvent(run: Run, event: AgentEvent): void {
  switch (event.type) {
    case 'message_end': {
      if (event.message.role === 'user') {
        if (run.pendingInitialUser) {
          // This pair belongs to the prompt submitPrompt already persisted.
          run.pendingInitialUser = false
          return
        }
        const text = userText(event.message)
        if (text.trim() === '') return
        enqueue(run, () =>
          chatApi.append({
            conversationId: run.conversationId,
            messages: [{ role: 'user', content: text }],
          }),
        )
        return
      }
      if (event.message.role !== 'assistant') return
      run.pendingInitialUser = false
      const { text, toolCalls, thinking, thinkingSignature } = extractAssistant(event.message)
      const failed =
        event.message.stopReason === 'error' || event.message.stopReason === 'aborted'
      const usage = failed ? null : usageFromMessage(event.message)
      const shown = failed
        ? event.message.stopReason === 'aborted'
          ? '已取消'
          : `回答失败：${event.message.errorMessage ?? '未知错误'}`
        : text
      if (shown.trim() === '' && toolCalls === null) return
      const jobId = lastJobId(run.conversationId) ?? null
      enqueue(run, () =>
        chatApi.append({
          conversationId: run.conversationId,
          messages: [
            {
              role: 'assistant',
              content: shown,
              toolCalls: failed ? null : toolCalls,
              isError: failed,
              usage,
              thinking,
              thinkingSignature: failed ? null : thinkingSignature,
              jobId,
            },
          ],
        }),
      )
      return
    }
    case 'tool_execution_end': {
      const value = event.result as { content?: Array<{ text?: string }> } | null
      const text = (value?.content ?? []).map((block) => block.text ?? '').join('\n')
      enqueue(run, () =>
        chatApi.append({
          conversationId: run.conversationId,
          messages: [
            {
              role: 'tool',
              content: text,
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              isError: event.isError,
            },
          ],
        }),
      )
      return
    }
    default:
      return
  }
}

function bind(run: Run): void {
  run.unsubscribe()
  run.unsubscribe = run.agent.subscribe((event) => {
    if (event.type === 'message_start' && event.message.role === 'assistant') {
      run.streaming = true
    }
    if (event.type === 'agent_end') {
      run.streaming = false
      run.pendingInitialUser = false
    }
    persistEvent(run, event)
    run.handler?.(event)
  })
}

export const runManager = {
  acquire(conversationId: number): Run | undefined {
    return runs.get(conversationId)
  },

  isStreaming(conversationId: number): boolean {
    return runs.get(conversationId)?.streaming ?? false
  },

  /** Create a run for a freshly built agent, replacing any idle predecessor. */
  attach(
    conversationId: number,
    agent: Agent,
    handler: (event: AgentEvent) => void,
  ): Run {
    const existing = runs.get(conversationId)
    if (existing) {
      existing.unsubscribe()
      runs.delete(conversationId)
    }
    const run: Run = {
      conversationId,
      agent,
      unsubscribe: () => {},
      handler,
      persistQueue: Promise.resolve(),
      pendingInitialUser: false,
      streaming: false,
    }
    runs.set(conversationId, run)
    bind(run)
    return run
  },

  /** Re-attach the page to a still-live run without touching the agent. */
  adopt(conversationId: number, handler: (event: AgentEvent) => void): Run | undefined {
    const run = runs.get(conversationId)
    if (run) run.handler = handler
    return run
  },

  /** Page left: stop UI updates, keep persistence and the agent alive. */
  detach(conversationId: number): void {
    const run = runs.get(conversationId)
    if (run) run.handler = null
  },

  /** Explicit stop: cancel queued work and abort the in-flight model turn. */
  stop(conversationId: number): void {
    const run = runs.get(conversationId)
    if (!run) return
    run.pendingInitialUser = false
    run.agent.clearAllQueues()
    run.agent.abort()
  },

  /** Conversation deletion / retry: abort and drop the run entirely. */
  dispose(conversationId: number): void {
    const run = runs.get(conversationId)
    if (!run) return
    run.handler = null
    run.unsubscribe()
    run.agent.abort()
    runs.delete(conversationId)
  },

  /** Free an idle run (for example when switching conversations). */
  releaseIfIdle(conversationId: number): void {
    const run = runs.get(conversationId)
    if (run && !run.streaming) runManager.dispose(conversationId)
  },

  /** A prompt aborted before emitting events; the run stays usable. */
  resetStreaming(conversationId: number): void {
    const run = runs.get(conversationId)
    if (!run) return
    run.streaming = false
    run.pendingInitialUser = false
  },

  /** A prompt is about to start; the first user pair is already persisted. */
  markPrompt(conversationId: number): void {
    const run = runs.get(conversationId)
    if (!run) return
    run.pendingInitialUser = true
    run.streaming = true
  },

  /** Retry / continue: no initial-user pair is pending. */
  markContinue(conversationId: number): void {
    const run = runs.get(conversationId)
    if (!run) return
    run.pendingInitialUser = false
    run.streaming = true
  },
}
