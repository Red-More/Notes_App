//! Pool behaviour: switching conversations must never cancel a live run.

import { describe, expect, it } from 'vitest'
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai'
import type { AssistantMessage } from '@earendil-works/pi-ai'
import type { StreamFn } from '@earendil-works/pi-agent-core'
import { AgentRuntime, type AgentRuntimeDeps, type RuntimeSnapshot } from './AgentRuntime'
import { RuntimePool, SessionClosedError } from './RuntimePool'
import type {
  AgentRun,
  AgentRunStart,
  AgentRunState,
  AgentRunStatus,
  AgentRunTrigger,
  ChatConversation,
  ChatMessageRecord,
  NewChatMessage,
} from '../types'

const profile = {
  provider: 'test',
  model: 'test-model',
  api: 'openai-completions',
  contextWindow: 4096,
  maxTokens: 512,
}

/** Conversation id the fake backend assigns to a draft's first message. */
const ADOPTED_DRAFT_ID = 100

function conversation(id: number, title = `对话 ${id}`): ChatConversation {
  return {
    id,
    title,
    provider: profile.provider,
    model: profile.model,
    createdAt: '2026-01-01 00:00:00',
    updatedAt: '2026-01-01 00:00:00',
    lastMessageAt: '2026-01-01 00:00:00',
    messageCount: 0,
  }
}

function assistantMessage(): AssistantMessage {
  return {
    role: 'assistant',
    content: [],
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

/** Minimal in-memory backend: per-conversation rows plus the run ledger. */
function fakeStore() {
  const rows = new Map<number, ChatMessageRecord[]>()
  const runs: AgentRun[] = []
  const finishes: { runId: number; status: AgentRunStatus }[] = []
  let nextMessageId = 1
  let nextRunId = 1

  const insert = (conversationId: number, message: NewChatMessage): ChatMessageRecord => {
    const record: ChatMessageRecord = {
      id: nextMessageId++,
      role: message.role,
      content: message.content,
      toolCalls: message.toolCalls ?? null,
      toolCallId: message.toolCallId ?? null,
      toolName: message.toolName ?? null,
      isError: message.isError ?? false,
      usage: message.usage ?? null,
      thinking: message.thinking ?? null,
      thinkingSignature: message.thinkingSignature ?? null,
      runId: message.runId ?? null,
      toolArgs: message.toolArgs ?? null,
      toolDurationMs: message.toolDurationMs ?? null,
      thinkingDurationMs: message.thinkingDurationMs ?? null,
      isPartial: message.isPartial ?? false,
      stopReason: message.stopReason ?? null,
      steerOfRun: message.steerOfRun ?? null,
      imageAssetIds: message.imageAssetIds ?? [],
      createdAt: '2026-01-01 00:00:00',
    }
    rows.set(conversationId, [...(rows.get(conversationId) ?? []), record])
    return record
  }

  // One executor per conversation, exactly like the SQLite ledger.
  const hasExecutor = (conversationId: number) =>
    runs.some(
      (run) =>
        run.conversationId === conversationId &&
        (run.status === 'running' || run.status === 'cancelling'),
    )

  const startRun = async (
    conversationId: number | null,
    trigger: AgentRunTrigger,
    modelEntry: string,
    message?: NewChatMessage | null,
  ): Promise<AgentRunStart> => {
    const target = conversationId ?? ADOPTED_DRAFT_ID
    const stamp = new Date().toISOString()
    const run: AgentRun = {
      runId: nextRunId++,
      conversationId: target,
      status: hasExecutor(target) ? 'queued' : 'running',
      trigger,
      modelEntry,
      stepCount: 0,
      writeCount: 0,
      lastSeq: 0,
      partial: null,
      errorCode: null,
      resumeFromMessageId: null,
      createdAt: stamp,
      updatedAt: stamp,
      endedAt: null,
    }
    runs.push(run)
    const record = message ? insert(target, { ...message, runId: run.runId }) : null
    return {
      run: { ...run },
      message: record,
      conversation: conversationId === null ? conversation(target) : null,
    }
  }

  // Load gate: lets a test delete a conversation while its open is in flight.
  let gateId: number | null = null
  let gateResolve: (() => void) | null = null
  let gate: Promise<void> = Promise.resolve()
  let gateStarted = false

  const holdOpen = (conversationId: number) => {
    gateId = conversationId
    gateStarted = false
    gate = new Promise((resolve) => {
      gateResolve = resolve
    })
    return {
      started: () => gateStarted,
      release: () => {
        gateId = null
        gateResolve?.()
        gateResolve = null
      },
    }
  }

  const deps: AgentRuntimeDeps = {
    loadMessages: async (conversationId) => {
      if (conversationId === gateId) {
        gateStarted = true
        await gate
      }
      return [...(rows.get(conversationId) ?? [])]
    },
    append: async (conversationId, messages) => {
      for (const message of messages) insert(conversationId, message)
      return rows.get(conversationId) ?? []
    },
    truncate: async () => {},
    truncateFrom: async () => {},
    deleteMessage: async (conversationId, messageId) => {
      rows.set(
        conversationId,
        (rows.get(conversationId) ?? []).filter((record) => record.id !== messageId),
      )
    },
    loadSkills: async () => [],
    loadMcpTools: async () => [],
    loadAsset: async () => ({ data: '', mime: 'image/png' }),
    createConversation: async (title) => conversation(ADOPTED_DRAFT_ID + 1, title),
    startRun,
    resumeRun: (conversationId, modelEntry) =>
      startRun(conversationId, 'resume', modelEntry, null),
    transitionRun: async (runId, status) => {
      const run = runs.find((item) => item.runId === runId)
      if (!run) throw new Error(`run ${runId} not found`)
      run.status = status
      return { ...run }
    },
    finishRun: async (runId, status) => {
      const run = runs.find((item) => item.runId === runId)
      if (!run) throw new Error(`run ${runId} not found`)
      finishes.push({ runId, status })
      run.status = status
    },
    touchRun: async () => {},
    loadRunState: async (conversationId): Promise<AgentRunState> => {
      const list = runs.filter((run) => run.conversationId === conversationId)
      const active =
        [...list].reverse().find((run) => run.status === 'running' || run.status === 'cancelling') ??
        null
      const latest = list.length > 0 ? list[list.length - 1] : null
      return {
        active: active ? { ...active } : null,
        latest: latest ? { ...latest } : null,
        queued: [],
      }
    },
  }

  return {
    deps,
    runs,
    finishes,
    holdOpen,
    insert,
    assistantRows: (conversationId: number) =>
      (rows.get(conversationId) ?? []).filter((record) => record.role === 'assistant'),
  }
}

interface ControlledRun {
  delta(chunk: string, accumulated: string): void
  finish(accumulated: string): void
}

/** A stream the test drives chunk by chunk; abort closes it like a provider. */
function controlledStreamFn() {
  const runs: ControlledRun[] = []
  const streamFn: StreamFn = (_model, _context, options) => {
    const stream = createAssistantMessageEventStream()
    const partial = assistantMessage()
    const respond = (stopReason: 'aborted' | 'stop', text: string) => {
      partial.content = text === '' ? [] : [{ type: 'text', text }]
      const final = { ...partial, stopReason } as AssistantMessage
      if (stopReason === 'aborted') {
        stream.push({ type: 'error', reason: 'aborted', error: final })
      } else {
        stream.push({ type: 'done', reason: 'stop', message: final })
      }
      stream.end(final)
    }
    options?.signal?.addEventListener('abort', () => respond('aborted', ''))
    runs.push({
      delta(chunk, accumulated) {
        partial.content = [{ type: 'text', text: accumulated }]
        stream.push({ type: 'text_delta', contentIndex: 0, delta: chunk, partial })
      },
      finish(accumulated) {
        respond('stop', accumulated)
      },
    })
    stream.push({ type: 'start', partial })
    return stream
  }
  return { streamFn, runs }
}

function poolWith(streamFn: StreamFn) {
  const store = fakeStore()
  const pool = new RuntimePool(store.deps, {
    createRuntime: (deps) =>
      new AgentRuntime({ deps, streamFn, schedule: (flush) => flush() }),
  })
  return { pool, store }
}

/** Counts dispose() calls so a test can prove late-attached agents are freed. */
class CountingRuntime extends AgentRuntime {
  disposeCalls = 0

  override dispose(): Promise<void> {
    this.disposeCalls += 1
    return super.dispose()
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('waitFor timeout')
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
}

function statusOf(runtime: AgentRuntime): RuntimeSnapshot['status'] {
  return runtime.snapshot().status
}

describe('RuntimePool', () => {
  it('keeps a conversation generating while another one is opened', async () => {
    const { streamFn, runs } = controlledStreamFn()
    const { pool, store } = poolWith(streamFn)

    const first = await pool.open(conversation(1), profile)
    const pending = first.prompt({ text: '第一问' })
    await waitFor(() => runs.length === 1)
    runs[0].delta('半', '半')

    // The user switches away mid-answer.
    const second = await pool.open(conversation(2), profile)
    expect(second).not.toBe(first)
    expect(statusOf(first)).toBe('running')
    expect(store.finishes.filter((item) => item.status === 'cancelled')).toHaveLength(0)

    runs[0].finish('半句话')
    await pending
    await waitFor(() => statusOf(first) === 'idle')
    expect(store.assistantRows(1).some((row) => row.content === '半句话')).toBe(true)
  })

  it('reopens a running conversation by attaching, not rebuilding', async () => {
    const { streamFn, runs } = controlledStreamFn()
    const { pool, store } = poolWith(streamFn)

    const first = await pool.open(conversation(1), profile)
    const pending = first.prompt({ text: '问' })
    await waitFor(() => runs.length === 1)

    await pool.open(conversation(2), profile)
    const again = await pool.open(conversation(1), profile)
    expect(again).toBe(first)
    expect(statusOf(first)).toBe('running')

    runs[0].finish('答')
    await pending
    expect(store.finishes.filter((item) => item.status === 'cancelled')).toHaveLength(0)
  })

  it('cancels only the deleted conversation', async () => {
    const { streamFn, runs } = controlledStreamFn()
    const { pool, store } = poolWith(streamFn)

    const a = await pool.open(conversation(1), profile)
    const pendingA = a.prompt({ text: 'A' })
    await waitFor(() => runs.length === 1)
    const b = await pool.open(conversation(2), profile)
    const pendingB = b.prompt({ text: 'B' })
    await waitFor(() => runs.length === 2)

    await pool.close(1)
    await pendingA
    expect(statusOf(a)).toBe('idle')
    expect(store.finishes.some((item) => item.status === 'cancelled')).toBe(true)
    expect(statusOf(b)).toBe('running')

    runs[1].finish('B 完成')
    await pendingB
    expect(store.assistantRows(2).some((row) => row.content === 'B 完成')).toBe(true)
  })

  it('starts a new draft without cancelling the draft that is still running', async () => {
    const { streamFn, runs } = controlledStreamFn()
    const { pool, store } = poolWith(streamFn)

    const draft = await pool.openDraft(profile)
    const pending = draft.prompt({ text: '草稿问题' })
    await waitFor(() => runs.length === 1)
    await waitFor(() => draft.snapshot().conversation !== null)

    const fresh = await pool.openDraft(profile)
    expect(fresh).not.toBe(draft)
    expect(statusOf(draft)).toBe('running')

    // The parked draft is reachable by the conversation it adopted.
    const adopted = await pool.open(conversation(ADOPTED_DRAFT_ID), profile)
    expect(adopted).toBe(draft)

    runs[0].finish('草稿回答')
    await pending
    await waitFor(() => statusOf(draft) === 'idle')
    expect(store.assistantRows(ADOPTED_DRAFT_ID).some((row) => row.content === '草稿回答')).toBe(
      true,
    )
  })

  it('reloads the transcript when an idle session is reopened', async () => {
    const { streamFn } = controlledStreamFn()
    const { pool, store } = poolWith(streamFn)

    const first = await pool.open(conversation(1), profile)
    expect(first.snapshot().items).toHaveLength(0)

    // A row landed in SQLite after the session was last loaded.
    store.insert(1, { role: 'user', content: '外部写入' })

    const again = await pool.open(conversation(1), profile)
    expect(again).toBe(first)
    expect(
      again.snapshot().items.some((item) => item.kind === 'user' && item.text === '外部写入'),
    ).toBe(true)
  })

  it('rejects an open whose session was closed mid-load', async () => {
    const { streamFn } = controlledStreamFn()
    const { pool, store } = poolWith(streamFn)

    const gate = store.holdOpen(1)
    const opening = pool.open(conversation(1), profile)
    await waitFor(gate.started)

    // Deleting the conversation while its transcript is still loading must not
    // hand a disposed runtime back to the page.
    const closing = pool.close(1)
    gate.release()
    await expect(opening).rejects.toBeInstanceOf(SessionClosedError)
    await closing
  })

  it('releases the agent attached after a close that raced the load', async () => {
    const { streamFn } = controlledStreamFn()
    const store = fakeStore()
    const created: CountingRuntime[] = []
    const pool = new RuntimePool(store.deps, {
      createRuntime: (deps) => {
        const runtime = new CountingRuntime({
          deps,
          streamFn,
          schedule: (flush) => flush(),
        })
        created.push(runtime)
        return runtime
      },
    })

    const gate = store.holdOpen(1)
    const opening = pool.open(conversation(1), profile)
    await waitFor(gate.started)

    // open() has no agent yet, so close()'s dispose cannot stop the in-flight
    // load: the transcript and a fresh agent still attach once the gate opens.
    await pool.close(1)
    gate.release()
    await expect(opening).rejects.toBeInstanceOf(SessionClosedError)

    // open's own dispose, close's dispose, then the pool releasing the late agent.
    expect(created[0]?.disposeCalls).toBe(3)
  })

  it('disposes every session on page teardown', async () => {
    const { streamFn, runs } = controlledStreamFn()
    const { pool, store } = poolWith(streamFn)

    const a = await pool.open(conversation(1), profile)
    const pendingA = a.prompt({ text: 'A' })
    await waitFor(() => runs.length === 1)
    const b = await pool.open(conversation(2), profile)
    const pendingB = b.prompt({ text: 'B' })
    await waitFor(() => runs.length === 2)

    await pool.disposeAll()
    await Promise.all([pendingA, pendingB])
    expect(statusOf(a)).toBe('idle')
    expect(statusOf(b)).toBe('idle')
    expect(store.finishes.filter((item) => item.status === 'cancelled').length).toBeGreaterThan(0)
  })
})
