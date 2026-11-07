//! Runtime-level behaviour with an injected streamFn (no network, no Tauri).

import { describe, expect, it } from 'vitest'
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai'
import type { AssistantMessage } from '@earendil-works/pi-ai'
import type { StreamFn } from '@earendil-works/pi-agent-core'
import { AgentRuntime, type AgentRuntimeDeps, type RuntimeSnapshot } from './AgentRuntime'
import type { Bubble } from './chatView'
import fixtureRaw from './fixtures/pureAnswer.json?raw'
import type {
  AgentRun,
  AgentRunState,
  AgentRunStart,
  AgentRunStatus,
  AgentRunTrigger,
  ChatConversation,
  ChatMessageRecord,
  NewChatMessage,
  RustRunEvent,
  RustRunSnapshot,
} from '../types'

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

interface FinishCall {
  runId: number
  status: AgentRunStatus
  partial: string | null
  errorCode: string | null
  stepCount: number
  writeCount: number
}

/** In-memory stand-in for SQLite, including the run ledger. */
function memoryDeps(conversation: ChatConversation) {
  const rows = new Map<number, ChatMessageRecord[]>()
  const writes: { conversationId: number; messages: NewChatMessage[] }[] = []
  const runs: AgentRun[] = []
  const finishes: FinishCall[] = []
  const transitions: { runId: number; status: AgentRunStatus }[] = []
  const truncates: { conversationId: number; messageId: number }[] = []
  let nextId = 1
  let nextRunId = 1
  const stamp = () => new Date().toISOString()

  const insert = (conversationId: number, message: NewChatMessage): ChatMessageRecord => {
    const list = rows.get(conversationId) ?? []
    const record: ChatMessageRecord = {
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
      runId: message.runId ?? null,
      toolArgs: message.toolArgs ?? null,
      toolDurationMs: message.toolDurationMs ?? null,
      isPartial: message.isPartial ?? false,
      stopReason: message.stopReason ?? null,
      steerOfRun: message.steerOfRun ?? null,
      createdAt: stamp(),
    }
    rows.set(conversationId, [...list, record])
    return record
  }

  const executing = (conversationId: number) =>
    runs.some(
      (run) =>
        run.conversationId === conversationId &&
        (run.status === 'running' || run.status === 'cancelling'),
    )

  const startRun = async (
    conversationId: number,
    trigger: AgentRunTrigger,
    modelEntry: string,
    message?: NewChatMessage | null,
  ): Promise<AgentRunStart> => {
    const complete = [...(rows.get(conversationId) ?? [])].reverse().find((item) => !item.isPartial)
    const run: AgentRun = {
      runId: nextRunId++,
      conversationId,
      status: executing(conversationId) ? 'queued' : 'running',
      trigger,
      modelEntry,
      stepCount: 0,
      writeCount: 0,
      lastSeq: 0,
      partial: null,
      errorCode: null,
      resumeFromMessageId: trigger === 'resume' ? (complete?.id ?? null) : null,
      createdAt: stamp(),
      updatedAt: stamp(),
      endedAt: null,
    }
    runs.push(run)
    const record = message ? insert(conversationId, { ...message, runId: run.runId }) : null
    return { run: { ...run }, message: record }
  }

  /** Persisted boundary events and live subscribers, like the Rust supervisor. */
  const rustEvents = new Map<number, RustRunEvent[]>()
  const rustListeners = new Map<number, (event: RustRunEvent) => void>()
  const terminal = (status: AgentRunStatus) =>
    ['succeeded', 'failed', 'cancelled', 'interrupted'].includes(status)

  const recordRust = (event: RustRunEvent): void => {
    rustEvents.set(event.runId, [...(rustEvents.get(event.runId) ?? []), event])
    rustListeners.get(event.runId)?.(event)
  }

  const nextSeq = (runId: number) => (rustEvents.get(runId)?.at(-1)?.seq ?? 0) + 1

  const attachRustRun = async (
    runId: number,
    afterSeq: number,
    onEvent: (event: RustRunEvent) => void,
  ): Promise<void> => {
    const run = runs.find((item) => item.runId === runId)
    if (!run) throw new Error(`run ${runId} not found`)
    let ended = false
    for (const event of rustEvents.get(runId) ?? []) {
      if (event.seq > afterSeq) {
        onEvent(event)
        ended = ended || event.kind === 'end'
      }
    }
    if (ended || terminal(run.status)) return
    await new Promise<void>((resolve) => {
      rustListeners.set(runId, (event) => {
        onEvent(event)
        if (event.kind === 'end') {
          rustListeners.delete(runId)
          resolve()
        }
      })
    })
  }

  const deps: AgentRuntimeDeps = {
    loadMessages: async (conversationId) => [...(rows.get(conversationId) ?? [])],
    loadImages: async () => new Map(),
    append: async (conversationId, messages) => {
      writes.push({ conversationId, messages })
      for (const message of messages) insert(conversationId, message)
      return rows.get(conversationId) ?? []
    },
    truncate: async (conversationId, messageId) => {
      truncates.push({ conversationId, messageId })
      const list = rows.get(conversationId) ?? []
      const index = list.findIndex((record) => record.id === messageId)
      if (index >= 0) rows.set(conversationId, list.slice(0, index + 1))
    },
    loadSkills: async () => [],
    loadMcpTools: async () => [],
    createConversation: async (title) => ({ ...conversation, id: 2, title }),
    startRun,
    resumeRun: (conversationId, modelEntry) =>
      startRun(conversationId, 'resume', modelEntry, null),
    transitionRun: async (runId, status) => {
      const run = runs.find((item) => item.runId === runId)
      if (!run) throw new Error(`run ${runId} not found`)
      transitions.push({ runId, status })
      run.status = status
      run.updatedAt = stamp()
      return { ...run }
    },
    finishRun: async (runId, status, data) => {
      const run = runs.find((item) => item.runId === runId)
      if (!run) throw new Error(`run ${runId} not found`)
      finishes.push({ runId, status, ...data })
      run.status = status
      run.partial = data.partial
      run.errorCode = data.errorCode
      run.stepCount = data.stepCount
      run.writeCount = data.writeCount
      run.lastSeq = data.lastSeq
      run.updatedAt = stamp()
      run.endedAt = stamp()
    },
    touchRun: async (runId, stepCount, writeCount, lastSeq) => {
      const run = runs.find((item) => item.runId === runId)
      if (!run) return
      run.stepCount = stepCount
      run.writeCount = writeCount
      run.lastSeq = lastSeq
    },
    loadRunState: async (conversationId): Promise<AgentRunState> => {
      const list = runs.filter((run) => run.conversationId === conversationId)
      const active =
        [...list].reverse().find((run) => run.status === 'running' || run.status === 'cancelling') ??
        null
      const latest = list.length > 0 ? list[list.length - 1] : null
      const queued = list
        .filter((run) => run.status === 'queued')
        .map((run) => ({
          run: { ...run },
          userMessage:
            (rows.get(conversationId) ?? []).find(
              (record) => record.role === 'user' && record.runId === run.runId,
            ) ?? null,
        }))
      return {
        active: active ? { ...active } : null,
        latest: latest ? { ...latest } : null,
        queued,
      }
    },
    startRustRun: startRun,
    attachRustRun,
    cancelRustRun: async (runId) => {
      const run = runs.find((item) => item.runId === runId)
      if (!run) throw new Error(`run ${runId} not found`)
      recordRust({
        runId,
        seq: nextSeq(runId),
        kind: 'state',
        payload: { status: 'cancelling' },
      })
      run.status = 'cancelling'
      run.updatedAt = stamp()
      return { ...run }
    },
    snapshotRustRun: async (runId, afterSeq): Promise<RustRunSnapshot> => {
      const run = runs.find((item) => item.runId === runId)
      if (!run) throw new Error(`run ${runId} not found`)
      return {
        run: { ...run },
        events: (rustEvents.get(runId) ?? []).filter((event) => event.seq > afterSeq),
      }
    },
  }

  const assistantRows = (conversationId: number) =>
    (rows.get(conversationId) ?? []).filter((record) => record.role === 'assistant')

  return {
    deps,
    rows,
    writes,
    runs,
    finishes,
    transitions,
    truncates,
    assistantRows,
    insert,
    recordRust,
    rustListeners,
    rustEvents,
  }
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

/** A Rust-mode runtime whose supervisor is simulated through `recordRust`. */
function rustRuntime() {
  const store = memoryDeps(conversation())
  const runtime = new AgentRuntime({
    deps: store.deps,
    engine: 'rust',
    schedule: (flush) => flush(),
  })
  return { runtime, store }
}

interface ParityFixture {
  history: {
    role: 'user' | 'assistant'
    content: string
    stopReason?: string | null
    isPartial?: boolean
  }[]
  prompt: string
  answer: string
  expectedMessages: { role: string; content: string; stopReason?: string; isPartial?: boolean }[]
  expectedStatus: string
}

const parity: ParityFixture = JSON.parse(fixtureRaw) as ParityFixture

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

    // The ledger keeps the partial snapshot for the "continue" banner.
    const cancelled = store.finishes.filter((call) => call.status === 'cancelled')
    expect(cancelled).toHaveLength(1)
    expect(JSON.parse(cancelled[0].partial ?? '{}')).toEqual({ text: '半句' })
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

  it('persists a queued follow-up and restores it when the conversation reopens', async () => {
    const { streamFn, runs } = controlledStreamFn()
    const { runtime, store } = runtimeWith(streamFn)

    await runtime.open(conversation(), profile)
    const pending = runtime.prompt({ text: '第一问', attachments: [] })
    await waitFor(() => runs.length === 1)
    await waitFor(() => runtime.snapshot().items.some((item) => item.kind === 'assistant'))
    runs[0].delta('半句', '半句')
    await waitFor(() => (assistants(runtime.snapshot())[0]?.text ?? '').includes('半句'))

    await runtime.followUp('第二问')
    expect(runtime.snapshot().queued).toBe(1)
    expect(store.runs.filter((run) => run.status === 'queued')).toHaveLength(1)
    // The queued user message is written up front so re-entry can show it.
    expect((store.rows.get(1) ?? []).filter((row) => row.role === 'user').map((row) => row.content))
      .toEqual(['第一问', '第二问'])

    await runtime.dispose()
    await pending

    // Page switch: the queue is read back from the ledger, not rebuilt in memory.
    await runtime.open(conversation(), profile)
    expect(runtime.snapshot().queued).toBe(1)
    expect(
      runtime.snapshot().items.filter((item) => item.kind === 'user').map((item) => item.text),
    ).toEqual(['第一问', '第二问'])
  })

  it('starts a resume run from the user turn and drops the partial answer', async () => {
    const { streamFn, runs } = controlledStreamFn()
    const { runtime, store } = runtimeWith(streamFn)

    await runtime.open(conversation(), profile)
    const pending = runtime.prompt({ text: '写一段', attachments: [] })
    await waitFor(() => runs.length === 1)
    await waitFor(() => runtime.snapshot().items.some((item) => item.kind === 'assistant'))
    runs[0].delta('半句', '半句')
    await waitFor(() => (assistants(runtime.snapshot())[0]?.text ?? '').includes('半句'))
    await runtime.dispose()
    await pending

    // Simulate the startup reconcile: an executor row becomes interrupted.
    store.runs[0].status = 'interrupted'
    await runtime.open(conversation(), profile)
    expect(runtime.snapshot().interrupted?.runId).toBe(store.runs[0].runId)

    const resumed = runtime.resume()
    await waitFor(() => runs.length === 2)

    const resumeRun = store.runs.find((run) => run.trigger === 'resume')
    expect(resumeRun?.status).toBe('running')
    const userRow = (store.rows.get(1) ?? []).find((row) => row.role === 'user')
    expect(resumeRun?.resumeFromMessageId).toBe(userRow?.id)
    expect(store.truncates.at(-1)).toEqual({ conversationId: 1, messageId: userRow?.id })

    runs[1].finish('继续答')
    await resumed
    expect(store.finishes.some((call) => call.runId === resumeRun?.runId && call.status === 'succeeded'))
      .toBe(true)
  })

  it('rust engine renders boundary events without persisting transcript rows', async () => {
    const { runtime, store } = rustRuntime()
    await runtime.open(conversation(), profile)
    const pending = runtime.prompt({ text: '问', attachments: [] })
    await waitFor(() => store.runs.length === 1)
    const runId = store.runs[0].runId
    await waitFor(() => store.rustListeners.has(runId))

    store.recordRust({ runId, seq: 1, kind: 'state', payload: { status: 'running' } })
    store.recordRust({ runId, seq: 2, kind: 'delta', payload: { delta: '半' } })
    const row = store.insert(1, {
      role: 'assistant',
      content: '半句答复',
      runId,
      stopReason: 'stop',
    })
    store.recordRust({
      runId,
      seq: 3,
      kind: 'assistant',
      payload: { message: row, errorCode: null },
    })
    store.recordRust({ runId, seq: 4, kind: 'state', payload: { status: 'succeeded' } })
    store.recordRust({
      runId,
      seq: 5,
      kind: 'end',
      payload: { status: 'succeeded', errorCode: null, partial: null },
    })
    store.runs[0].status = 'succeeded'
    await pending

    expect(runtime.snapshot().items.map((item) => `${item.kind}:${item.text}`)).toEqual([
      'user:问',
      'assistant:半句答复',
    ])
    expect(runtime.snapshot().status).toBe('idle')
    // The Rust supervisor owns persistence; the runtime never writes rows.
    expect(store.writes).toHaveLength(0)
  })

  it('rust cancel waits for the terminal event and keeps the partial bubble', async () => {
    const { runtime, store } = rustRuntime()
    await runtime.open(conversation(), profile)
    const pending = runtime.prompt({ text: '写一段', attachments: [] })
    await waitFor(() => store.runs.length === 1)
    const runId = store.runs[0].runId
    await waitFor(() => store.rustListeners.has(runId))

    store.recordRust({ runId, seq: 1, kind: 'state', payload: { status: 'running' } })
    store.recordRust({ runId, seq: 2, kind: 'delta', payload: { delta: '半句' } })
    await waitFor(() => (assistants(runtime.snapshot())[0]?.text ?? '') === '半句')

    const cancelling = runtime.cancel()
    await waitFor(() => store.runs[0].status === 'cancelling')
    const row = store.insert(1, {
      role: 'assistant',
      content: '半句',
      runId,
      isPartial: true,
      stopReason: 'aborted',
    })
    store.recordRust({
      runId,
      seq: 3,
      kind: 'assistant',
      payload: { message: row, errorCode: null },
    })
    store.recordRust({ runId, seq: 4, kind: 'state', payload: { status: 'cancelled' } })
    store.recordRust({
      runId,
      seq: 5,
      kind: 'end',
      payload: { status: 'cancelled', errorCode: null, partial: '{"text":"半句"}' },
    })
    store.runs[0].status = 'cancelled'
    await cancelling
    await pending

    const replies = assistants(runtime.snapshot())
    expect(replies).toHaveLength(1)
    expect(replies[0].text).toBe('半句')
    expect(replies[0].cancelled).toBe(true)
    expect(replies[0].streaming).toBe(false)
    expect(runtime.snapshot().status).toBe('idle')
  })

  it('rust re-open re-attaches the active run and settles it on live events', async () => {
    const store = memoryDeps(conversation())
    const started = await store.deps.startRustRun(1, 'prompt', profile.provider, null)
    const runId = started.run.runId
    store.insert(1, { role: 'user', content: '问', runId })
    store.recordRust({ runId, seq: 1, kind: 'state', payload: { status: 'running' } })

    const runtime = new AgentRuntime({
      deps: store.deps,
      engine: 'rust',
      schedule: (flush) => flush(),
    })
    await runtime.open(conversation(), profile)
    expect(runtime.snapshot().status).toBe('running')
    await waitFor(() => store.rustListeners.has(runId))

    const row = store.insert(1, {
      role: 'assistant',
      content: '完成',
      runId,
      stopReason: 'stop',
    })
    store.recordRust({
      runId,
      seq: 2,
      kind: 'assistant',
      payload: { message: row, errorCode: null },
    })
    store.recordRust({ runId, seq: 3, kind: 'state', payload: { status: 'succeeded' } })
    store.recordRust({
      runId,
      seq: 4,
      kind: 'end',
      payload: { status: 'succeeded', errorCode: null, partial: null },
    })
    store.runs[0].status = 'succeeded'
    await waitFor(() => runtime.snapshot().status === 'idle')

    expect(runtime.snapshot().items.map((item) => `${item.kind}:${item.text}`)).toEqual([
      'user:问',
      'assistant:完成',
    ])
  })

  it('both engines agree on persisted messages and the final status', async () => {
    const seed = (store: ReturnType<typeof memoryDeps>) => {
      for (const item of parity.history) {
        store.insert(1, {
          role: item.role,
          content: item.content,
          stopReason: item.stopReason ?? null,
          isPartial: item.isPartial ?? false,
        })
      }
    }
    const shape = (store: ReturnType<typeof memoryDeps>) =>
      (store.rows.get(1) ?? []).map((row) => ({
        role: row.role,
        content: row.content,
        stopReason: row.stopReason,
        isPartial: row.isPartial,
      }))

    // JS engine: one stream call answers with the fixture text.
    const jsStore = memoryDeps(conversation())
    seed(jsStore)
    const jsRuntime = new AgentRuntime({
      deps: jsStore.deps,
      streamFn: instantStream(() => parity.answer),
      schedule: (flush) => flush(),
    })
    await jsRuntime.open(conversation(), profile)
    await jsRuntime.prompt({ text: parity.prompt, attachments: [] })

    // Rust engine: the supervisor persists the same row and emits boundaries.
    const rustStore = memoryDeps(conversation())
    seed(rustStore)
    const rust = new AgentRuntime({
      deps: rustStore.deps,
      engine: 'rust',
      schedule: (flush) => flush(),
    })
    await rust.open(conversation(), profile)
    const pending = rust.prompt({ text: parity.prompt, attachments: [] })
    await waitFor(() => rustStore.runs.length === 1)
    const runId = rustStore.runs[0].runId
    await waitFor(() => rustStore.rustListeners.has(runId))
    rustStore.recordRust({ runId, seq: 1, kind: 'state', payload: { status: 'running' } })
    const row = rustStore.insert(1, {
      role: 'assistant',
      content: parity.answer,
      runId,
      stopReason: 'stop',
    })
    rustStore.recordRust({
      runId,
      seq: 2,
      kind: 'assistant',
      payload: { message: row, errorCode: null },
    })
    rustStore.recordRust({
      runId,
      seq: 3,
      kind: 'end',
      payload: { status: 'succeeded', errorCode: null, partial: null },
    })
    rustStore.runs[0].status = 'succeeded'
    await pending

    expect(shape(rustStore)).toEqual(shape(jsStore))
    expect(shape(rustStore)).toEqual(
      parity.expectedMessages.map((item) => ({
        role: item.role,
        content: item.content,
        stopReason: item.stopReason ?? null,
        isPartial: item.isPartial ?? false,
      })),
    )
    expect(rust.snapshot().status).toBe('idle')
    expect(jsRuntime.snapshot().status).toBe('idle')
  })
})
