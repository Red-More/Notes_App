//! Runtime-level behaviour with an injected streamFn (no network, no Tauri).

import { describe, expect, it } from 'vitest'
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai'
import type { AssistantMessage } from '@earendil-works/pi-ai'
import type { StreamFn } from '@earendil-works/pi-agent-core'
import { AgentRuntime, type AgentRuntimeDeps, type RuntimeSnapshot } from './AgentRuntime'
import type { Bubble } from './chatView'
import type { ChatConversation, ChatMessageRecord, NewChatMessage } from '../types'

const profile = {
  provider: 'test',
  model: 'test-model',
  api: 'openai-completions',
  contextWindow: 4096,
  maxTokens: 512,
}

function assistantMessage(text = ''): AssistantMessage {
  return {
    role: 'assistant',
    content: text === '' ? [] : [{ type: 'text', text }],
    api: 'openai-completions',
    provider: 'test',
    model: 'test-model',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp: Date.now(),
  } as AssistantMessage
}

/** In-memory stand-in for SQLite plus the other runtime dependencies. */
function memoryDeps(conversation: ChatConversation) {
  const rows = new Map<number, ChatMessageRecord[]>()
  const writes: { conversationId: number; messages: NewChatMessage[] }[] = []
  let nextId = 1

  const deps: AgentRuntimeDeps = {
    loadMessages: async (conversationId) => [...(rows.get(conversationId) ?? [])],
    loadImages: async () => new Map(),
    append: async (conversationId, messages) => {
      writes.push({ conversationId, messages })
      const list = rows.get(conversationId) ?? []
      for (const message of messages) {
        list.push({
          id: nextId++,
          role: message.role,
          content: message.content,
          toolCalls: message.toolCalls ?? null,
          toolCallId: message.toolCallId ?? null,
          toolName: message.toolName ?? null,
          isError: message.isError ?? false,
          usage: message.usage ?? null,
          thinking: message.thinking ?? null,
          thinkingSignature: message.thinkingSignature ?? null,
          imageAssetIds: message.imageAssetIds ?? null,
          createdAt: new Date().toISOString(),
        })
      }
      rows.set(conversationId, list)
      return list
    },
    truncate: async (conversationId, messageId) => {
      const list = rows.get(conversationId) ?? []
      const index = list.findIndex((record) => record.id === messageId)
      if (index >= 0) rows.set(conversationId, list.slice(0, index + 1))
    },
    loadSkills: async () => [],
    loadMcpTools: async () => [],
    createConversation: async (title) => ({ ...conversation, id: 2, title }),
  }

  const assistantRows = (conversationId: number) =>
    (rows.get(conversationId) ?? []).filter((record) => record.role === 'assistant')

  return { deps, rows, writes, assistantRows }
}

function conversation(id = 1, title = '测试对话'): ChatConversation {
  return {
    id,
    title,
    provider: profile.provider,
    model: profile.model,
    createdAt: '2026-01-01 00:00:00',
    updatedAt: '2026-01-01 00:00:00',
    messageCount: 0,
  } as unknown as ChatConversation
}

/** Streaming controller a test can drive event by event. */
interface ControlledRun {
  delta(chunk: string, accumulated: string): void
  finish(accumulated: string): void
  fail(message: string): void
}

function controlledStreamFn() {
  const runs: ControlledRun[] = []

  const streamFn: StreamFn = (_model, _context, options) => {
    const stream = createAssistantMessageEventStream()
    const partial = assistantMessage()
    let text = ''

    const respondError = (stopReason: 'error' | 'aborted', errorMessage?: string) => {
      const final = { ...partial, stopReason, errorMessage, content: partial.content } as AssistantMessage
      stream.push({ type: 'error', reason: stopReason, error: final })
      stream.end()
    }

    options?.signal?.addEventListener('abort', () => respondError('aborted'))

    runs.push({
      delta(chunk, accumulated) {
        text = accumulated
        partial.content = [{ type: 'text', text }]
        stream.push({ type: 'text_delta', contentIndex: 0, delta: chunk, partial })
      },
      finish(accumulated) {
        partial.content = [{ type: 'text', text: accumulated }]
        const final = { ...partial, content: partial.content, stopReason: 'stop' } as AssistantMessage
        stream.push({ type: 'done', reason: 'stop', message: final })
        stream.end(final)
      },
      fail(message) {
        partial.content = []
        respondError('error', message)
      },
    })

    stream.push({ type: 'start', partial })
    return stream
  }

  return { streamFn, runs }
}

/** Immediately answers with `reply` (one stream call per turn). */
function instantStream(reply: () => string): StreamFn {
  return () => {
    const stream = createAssistantMessageEventStream()
    const partial = assistantMessage()
    const text = reply()
    stream.push({ type: 'start', partial })
    const final = { ...partial, content: [{ type: 'text', text }] } as AssistantMessage
    stream.push({ type: 'done', reason: 'stop', message: final })
    stream.end(final)
    return stream
  }
}

function runtimeWith(streamFn: StreamFn) {
  const store = memoryDeps(conversation())
  const runtime = new AgentRuntime({ deps: store.deps, streamFn, schedule: (flush) => flush() })
  return { runtime, store }
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('waitFor timeout')
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
}

function assistants(snapshot: RuntimeSnapshot): Bubble[] {
  return snapshot.items.filter((item): item is Bubble => item.kind === 'assistant')
}

describe('AgentRuntime', () => {
  it('runs multiple turns and persists one row per message', async () => {
    const replies = ['第一答', '第二答']
    let call = 0
    const { runtime, store } = runtimeWith(instantStream(() => replies[call++] ?? '空'))

    await runtime.open(conversation(), profile)
    await runtime.prompt({ text: '第一问', attachments: [] })
    await runtime.prompt({ text: '第二问', attachments: [] })

    const items = runtime.snapshot().items
    expect(items.map((item) => `${item.kind}:${item.text}`)).toEqual([
      'user:第一问',
      'assistant:第一答',
      'user:第二问',
      'assistant:第二答',
    ])
    expect(runtime.snapshot().status).toBe('idle')

    const rows = store.rows.get(1) ?? []
    expect(rows.map((record) => `${record.role}:${record.content}`)).toEqual([
      'user:第一问',
      'assistant:第一答',
      'user:第二问',
      'assistant:第二答',
    ])
  })

  it('closes a cancelled run as one assistant row that keeps the partial text', async () => {
    const { streamFn, runs } = controlledStreamFn()
    const { runtime, store } = runtimeWith(streamFn)

    await runtime.open(conversation(), profile)
    const pending = runtime.prompt({ text: '写一段', attachments: [] })

    await waitFor(() => runs.length === 1)
    await waitFor(() => runtime.snapshot().items.some((item) => item.kind === 'assistant'))
    runs[0].delta('半句', '半句')
    await waitFor(() => {
      const reply = assistants(runtime.snapshot())[0]
      return reply !== undefined && reply.text.includes('半句')
    })

    await runtime.cancel()
    await pending

    const replies = assistants(runtime.snapshot())
    expect(replies).toHaveLength(1)
    expect(replies[0].text).toBe('半句')
    expect(replies[0].streaming).toBe(false)
    expect(replies[0].cancelled).toBe(true)

    const rows = store.assistantRows(1)
    expect(rows).toHaveLength(1)
    expect(rows[0].content).toBe('半句')
    expect(store.writes.filter((write) => write.messages[0].role === 'assistant')).toHaveLength(1)
  })

  it('waits for the close-out write before disposing (page switch loses nothing)', async () => {
    const { streamFn, runs } = controlledStreamFn()
    const { runtime, store } = runtimeWith(streamFn)

    await runtime.open(conversation(), profile)
    const pending = runtime.prompt({ text: '写一段', attachments: [] })
    await waitFor(() => runs.length === 1)
    await waitFor(() => runtime.snapshot().items.some((item) => item.kind === 'assistant'))
    runs[0].delta('切页前', '切页前')
    await waitFor(() => {
      const reply = assistants(runtime.snapshot())[0]
      return reply !== undefined && reply.text.includes('切页前')
    })

    await runtime.dispose()
    await pending

    // The partial answer reached storage exactly once, before unsubscribing.
    const rows = store.rows.get(1) ?? []
    expect(rows.filter((record) => record.role === 'user')).toHaveLength(1)
    const replies = store.assistantRows(1)
    expect(replies).toHaveLength(1)
    expect(replies[0].content).toBe('切页前')
    expect(store.writes.filter((write) => write.messages[0].role === 'assistant')).toHaveLength(1)

    // Reopening must not duplicate the turn.
    await runtime.open(conversation(), profile)
    expect(assistants(runtime.snapshot())).toHaveLength(1)
    expect(store.assistantRows(1)).toHaveLength(1)
  })

  it('maps a provider failure to a single ErrorCode bubble', async () => {
    const { streamFn, runs } = controlledStreamFn()
    const { runtime } = runtimeWith(streamFn)

    await runtime.open(conversation(), profile)
    const pending = runtime.prompt({ text: '问', attachments: [] })
    await waitFor(() => runs.length === 1)
    await waitFor(() => runtime.snapshot().items.some((item) => item.kind === 'assistant'))
    runs[0].fail('HTTP 429 rate limit exceeded')
    await pending

    const replies = assistants(runtime.snapshot())
    expect(replies).toHaveLength(1)
    expect(replies[0].isError).toBe(true)
    expect(replies[0].errorCode).toBe('rate_limited')
    expect(replies[0].text).toContain('请求过于频繁')
    expect(runtime.snapshot().error?.code).toBe('rate_limited')
  })
})
