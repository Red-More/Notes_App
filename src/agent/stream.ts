//! 原生 streamFn：把 pi-agent 内置 `streamProxy` 的 HTTP 传输换成 Tauri IPC。
//!
//! 每次模型轮次提交为一个后台作业（`chat_job_submit`），随后用
//! `chat_job_watch` 消费“快照 + 单调事件”。页面销毁只退订通道，作业仍在
//! Rust 侧继续；重新订阅时先应用快照，再按 `seq` 去重应用增量。
//!
//! 红线：`apiKey`、`baseUrl`、`signal` 都不会传进 Rust；取消走 `chat_job_cancel`。

import { Channel } from '@tauri-apps/api/core'
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai'
import type {
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  SimpleStreamOptions,
  ToolCall,
  Usage,
} from '@earendil-works/pi-ai'
import type { StreamFn } from '@earendil-works/pi-agent-core'
import { chatApi } from '../api'
import type { ChatJobSnapshot, ChatJobWatchEvent, MessageUsage } from '../types'
import { formatError, newPartial, processEvent, zeroUsage } from './protocol'
import type { ProxyEvent } from './protocol'

/** Last job submitted per conversation; assistant rows inherit this id. */
const lastJobByConversation = new Map<number, number>()

export function lastJobId(conversationId: number): number | undefined {
  return lastJobByConversation.get(conversationId)
}

function makeRequestId(): string {
  const cryptoObj = globalThis.crypto
  if (cryptoObj && typeof cryptoObj.randomUUID === 'function') return cryptoObj.randomUUID()
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function isTerminal(status: ChatJobSnapshot['status']): boolean {
  return status === 'done' || status === 'failed' || status === 'cancelled'
}

function jobUsage(raw: MessageUsage | null): Usage {
  const zero = zeroUsage()
  if (!raw) return zero
  return {
    ...zero,
    input: raw.input ?? 0,
    output: raw.output ?? 0,
    totalTokens: raw.totalTokens ?? 0,
    cacheRead: raw.cacheRead ?? 0,
    cacheWrite: raw.cacheWrite ?? 0,
  }
}

/** Replace the in-flight partial with the persisted snapshot (late subscriber). */
function rebuildPartial(partial: AssistantMessage, job: ChatJobSnapshot): void {
  partial.content = []
  for (const block of job.blocks) {
    if (block.type === 'text') {
      partial.content[block.contentIndex] = { type: 'text', text: block.text }
    } else if (block.type === 'thinking') {
      partial.content[block.contentIndex] = {
        type: 'thinking',
        thinking: block.thinking,
        thinkingSignature: block.signature ?? undefined,
      }
    } else {
      const call: ToolCall & { partialJson?: string } = {
        type: 'toolCall',
        id: block.id,
        name: block.name,
        arguments: (block.arguments ?? {}) as ToolCall['arguments'],
        partialJson: block.raw,
      }
      partial.content[block.contentIndex] = call
    }
  }
  partial.usage = jobUsage(job.usage)
}

/** Synthesize the terminal pi event for a job that ended while we were away. */
function terminalEvent(
  job: ChatJobSnapshot,
  partial: AssistantMessage,
): AssistantMessageEvent {
  partial.usage = jobUsage(job.usage)
  if (job.status === 'done') {
    const reason =
      job.stopReason === 'length' || job.stopReason === 'toolUse' ? job.stopReason : 'stop'
    partial.stopReason = reason
    return { type: 'done', reason, message: partial }
  }
  const aborted = job.status === 'cancelled' || job.errorCode === 'aborted'
  const reason = aborted ? 'aborted' : 'error'
  partial.stopReason = reason
  partial.errorMessage = job.errorMessage ?? (aborted ? undefined : '生成失败')
  return { type: 'error', reason, error: partial }
}

/**
 * Bind one conversation's stream to the job API. Each call consumes exactly
 * one model turn; the pi-agent tool loop calls it again for the next turn.
 */
export function makeStreamFn(conversationId: number): StreamFn {
  return (
    model,
    context,
    options?: SimpleStreamOptions,
  ): AssistantMessageEventStream => {
    const stream = createAssistantMessageEventStream()
    const partial = newPartial(model)
    const requestId = makeRequestId()
    let jobId: number | undefined
    let lastSeq = 0
    let terminal = false
    let aborted = false
    let resyncing = false

    const pushTerminal = (event: AssistantMessageEvent) => {
      if (terminal) return
      terminal = true
      stream.push(event)
    }

    const applySnapshot = (job: ChatJobSnapshot) => {
      jobId = job.id
      lastJobByConversation.set(conversationId, job.id)
      lastSeq = job.lastSeq
      rebuildPartial(partial, job)
      if (isTerminal(job.status)) pushTerminal(terminalEvent(job, partial))
    }

    // A gap means we missed events: rebuild from the persisted snapshot.
    const resync = async () => {
      if (resyncing || jobId === undefined || terminal) return
      resyncing = true
      try {
        applySnapshot(await chatApi.jobSnapshot(jobId))
      } catch {
        // The watch loop retries; a failed snapshot keeps the current partial.
      } finally {
        resyncing = false
      }
    }

    const channel = new Channel<ChatJobWatchEvent>()
    channel.onmessage = (message) => {
      if (terminal) return
      if (message.kind === 'snapshot') {
        applySnapshot(message.job)
        return
      }
      if (message.seq <= lastSeq) return
      if (message.seq !== lastSeq + 1) {
        void resync()
        return
      }
      lastSeq = message.seq
      const mapped = processEvent(message.event as ProxyEvent, partial)
      if (!mapped) return
      if (mapped.type === 'done' || mapped.type === 'error') terminal = true
      stream.push(mapped)
    }

    const signal = options?.signal
    const onAbort = () => {
      aborted = true
      if (jobId !== undefined) void chatApi.cancelJob(jobId).catch(() => {})
    }
    if (signal) signal.addEventListener('abort', onAbort)

    void (async () => {
      try {
        const job = await chatApi.submitJob(conversationId, {
          requestId,
          model: { id: model.id, provider: model.provider, api: model.api },
          context: { messages: context.messages },
          options: {
            temperature: options?.temperature,
            maxTokens: options?.maxTokens,
            toolChoice: options?.toolChoice,
            thinkingLevel: options?.reasoning,
            sessionId: options?.sessionId,
          },
        })
        jobId = job.id
        lastJobByConversation.set(conversationId, job.id)
        if (aborted) await chatApi.cancelJob(job.id).catch(() => {})

        // Re-watch a bounded number of times: a closed/lagged channel is
        // repaired by the snapshot, never by silently dropping events.
        for (let attempt = 0; attempt < 3 && !terminal; attempt += 1) {
          await chatApi.watchJob(job.id, channel, lastSeq)
          if (terminal) break
          const latest = await chatApi.jobSnapshot(job.id)
          applySnapshot(latest)
        }
      } catch (error) {
        if (!terminal) {
          const reason = signal?.aborted ? 'aborted' : 'error'
          partial.stopReason = reason
          partial.errorMessage = formatError(error)
          terminal = true
          stream.push({ type: 'error', reason, error: partial })
        }
      } finally {
        if (signal) signal.removeEventListener('abort', onAbort)
        if (!terminal) {
          partial.stopReason = 'error'
          partial.errorMessage = '流式响应在完成前结束'
          stream.push({ type: 'error', reason: 'error', error: partial })
          terminal = true
        }
        stream.end()
      }
    })()

    return stream
  }
}
