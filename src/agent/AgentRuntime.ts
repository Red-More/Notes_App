//! The single owner of a chat run.
//!
//! It holds the pi-agent `Agent`, the run status, the queue counters and the
//! persistence order. The page only renders `snapshot().items`, so every
//! transcript mutation (including cancel close-out) happens here.
//!
//! This interface is the contract the Rust orchestrator will implement later
//! (P3): keep its shape stable.

import type { Agent } from '@earendil-works/pi-agent-core'
import type { AgentMessage, AgentEvent, StreamFn } from '@earendil-works/pi-agent-core'
import type { ImageContent } from '@earendil-works/pi-ai'
import type {
  AgentRun,
  AgentRunStart,
  AgentRunState,
  AgentRunStatus,
  AgentRunTrigger,
  ChatConversation,
  ChatMessageRecord,
  McpToolInfo,
  NewChatMessage,
  QueuedRun,
  RustRunEvent,
  RustRunSnapshot,
  SkillSummary,
} from '../types'
import { buildSkillsIndex } from './skills'
import { createAgent, toAgentMessages, type AgentProfile } from './runtime'
import { classifyError, classifyFailure, errorText, type ErrorCode, type ErrorInfo } from './errors'
import {
  beginPrompt,
  createView,
  flushBuffer,
  nextItemId,
  projectHistory,
  reduceEvent,
  turnChanges,
  type Bubble,
  type ChatView,
  type ImageData,
  type Item,
  type ToolCard,
  type ViewEffect,
} from './chatView'

export type RuntimeStatus = 'idle' | 'running' | 'cancelling'

/** One image staged in the composer. */
export interface Attachment {
  assetId: number
  mime: string
  data: string
  dataUrl: string
}

export interface PromptInput {
  text: string
  attachments: Attachment[]
}

/** Everything the runtime needs from the outside; fakeable in tests. */
export interface AgentRuntimeDeps {
  loadMessages(conversationId: number): Promise<ChatMessageRecord[]>
  loadImages(records: ChatMessageRecord[]): Promise<Map<number, ImageData>>
  append(conversationId: number, messages: NewChatMessage[]): Promise<unknown>
  truncate(conversationId: number, messageId: number): Promise<void>
  loadSkills(): Promise<SkillSummary[]>
  loadMcpTools(): Promise<McpToolInfo[]>
  createConversation(title: string): Promise<ChatConversation>
  /** Run ledger: the database is the queue, so re-entry never loses work. */
  startRun(
    conversationId: number,
    trigger: AgentRunTrigger,
    modelEntry: string,
    message?: NewChatMessage | null,
  ): Promise<AgentRunStart>
  resumeRun(conversationId: number, modelEntry: string): Promise<AgentRunStart>
  transitionRun(runId: number, status: AgentRunStatus): Promise<AgentRun>
  finishRun(
    runId: number,
    status: AgentRunStatus,
    data: {
      partial: string | null
      errorCode: string | null
      stepCount: number
      writeCount: number
      lastSeq: number
    },
  ): Promise<unknown>
  touchRun(runId: number, stepCount: number, writeCount: number, lastSeq: number): Promise<unknown>
  loadRunState(conversationId: number): Promise<AgentRunState>
  /** Rust orchestrator (P3). Only used when `engine === 'rust'`. */
  startRustRun(
    conversationId: number,
    trigger: AgentRunTrigger,
    modelEntry: string,
    message?: NewChatMessage | null,
  ): Promise<AgentRunStart>
  /** Replay boundary events after `afterSeq`, then stream live until the run ends. */
  attachRustRun(
    runId: number,
    afterSeq: number,
    onEvent: (event: RustRunEvent) => void,
  ): Promise<void>
  cancelRustRun(runId: number): Promise<AgentRun>
  snapshotRustRun(runId: number, afterSeq: number): Promise<RustRunSnapshot>
}

export interface RuntimeSnapshot {
  conversationId: number | null
  status: RuntimeStatus
  /** Pending runs read from the ledger (survives page switches). */
  queued: number
  items: Item[]
  /** Executing run, if any; re-entry can render its status. */
  run: AgentRun | null
  /** Last interrupted run, for the "continue" banner. */
  interrupted: AgentRun | null
  /** Last failed/cancelled run; cleared when the next run starts. */
  error: ErrorInfo | null
  revision: number
}

export interface AgentRuntimeOptions {
  deps: AgentRuntimeDeps
  /** Injected by tests; defaults to the Tauri transport. */
  streamFn?: StreamFn
  /** Frame scheduler; defaults to requestAnimationFrame. */
  schedule?: (flush: () => void) => void
  /**
   * Execution engine. `js` keeps the pi-agent path (default, fully usable);
   * `rust` delegates to the new orchestration commands.
   */
  engine?: 'js' | 'rust'
}

/** Coalesce token deltas into one render per frame when the host offers rAF. */
function defaultSchedule(flush: () => void): void {
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(flush)
    return
  }
  setTimeout(flush, 0)
}

function assistantIndexes(records: ChatMessageRecord[]): number[] {
  const indexes: number[] = []
  records.forEach((record, index) => {
    if (record.role === 'assistant') indexes.push(index)
  })
  return indexes
}

export class AgentRuntime {
  private readonly deps: AgentRuntimeDeps
  private readonly streamFn?: StreamFn
  private readonly schedule: (flush: () => void) => void
  private readonly engine: 'js' | 'rust'

  private agent: Agent | null = null
  private unsubscribe: (() => void) | null = null
  private conversation: ChatConversation | null = null
  private profile: AgentProfile | null = null
  private skillsIndex = ''
  private images: Map<number, ImageData> = new Map()

  private view: ChatView = createView([])
  private status: RuntimeStatus = 'idle'
  private lastError: ErrorInfo | null = null
  private revision = 0
  private scheduled = false

  private writing: Promise<void> = Promise.resolve()
  private runWriting: Promise<void> = Promise.resolve()
  private listeners = new Set<(snapshot: RuntimeSnapshot) => void>()

  /** Ledger state mirrored in memory; the DB stays authoritative. */
  private currentRun: AgentRun | null = null
  private interrupted: AgentRun | null = null
  private queue: QueuedRun[] = []
  private runSteps = 0
  private runWrites = 0
  /** Which quota blocked the last batch; surfaced as the run's error code. */
  private limit: 'steps' | 'writes' | null = null
  private cancelRequested = false
  private pumping = false
  /** In-flight `run_attach` channel; distinguishes rust cancellation. */
  private rustAttach: Promise<void> | null = null
  /** Steering texts already written; their pi user events must not duplicate. */
  private steering: { text: string; runId: number | null }[] = []

  constructor(options: AgentRuntimeOptions) {
    this.deps = options.deps
    this.streamFn = options.streamFn
    this.schedule = options.schedule ?? defaultSchedule
    this.engine = options.engine ?? 'js'
  }

  // ---------------------------------------------------------------- loading

  /** Load a conversation and build a fresh Agent. A running run is closed out first. */
  async open(conversation: ChatConversation, profile: AgentProfile | null): Promise<void> {
    await this.dispose()
    this.conversation = conversation
    this.profile = profile
    this.status = 'idle'
    this.lastError = null
    this.view = createView([])
    this.currentRun = null
    this.interrupted = null
    this.queue = []
    this.runSteps = 0
    this.runWrites = 0
    this.limit = null
    this.cancelRequested = false
    this.steering = []

    const records = await this.deps.loadMessages(conversation.id)
    this.images = await this.deps.loadImages(records).catch(() => new Map())
    this.view = createView(projectHistory(records, this.images))
    // Restore the ledger view: queued work and the interrupted banner survive
    // page switches because they are read from SQLite, not memory.
    const runState = await this.deps.loadRunState(conversation.id).catch(
      () => ({ active: null, latest: null, queued: [] }) as AgentRunState,
    )
    this.currentRun = runState.active
    this.queue = runState.queued
    this.interrupted = runState.latest?.status === 'interrupted' ? runState.latest : null

    if (this.engine === 'rust') {
      // Rust owns the request; only rebuild the projection from SQLite.
      if (runState.active) {
        this.status = runState.active.status === 'cancelling' ? 'cancelling' : 'running'
        void this.runRustRun(runState.active)
      }
    } else if (profile) {
      const skills = await this.deps.loadSkills().catch(() => [])
      const mcpTools = await this.deps.loadMcpTools().catch(() => [])
      this.skillsIndex = buildSkillsIndex(skills)
      const agent = await this.buildAgent(profile, records, skills, mcpTools)
      this.unsubscribe = agent.subscribe((event) => this.onEvent(event))
      this.agent = agent
    }
    this.emit()
  }

  private async buildAgent(
    profile: AgentProfile,
    records: ChatMessageRecord[],
    skills: SkillSummary[],
    mcpTools: McpToolInfo[],
  ): Promise<Agent> {
    return createAgent(
      profile,
      await toAgentMessages(records, profile, this.images),
      this.skillsIndex,
      skills,
      mcpTools,
      `conv_${this.conversation?.id ?? 0}`,
      this.streamFn,
      { blocked: (kind) => { this.limit = kind } },
    )
  }

  // ---------------------------------------------------------------- running

  async prompt(input: PromptInput): Promise<void> {
    const conversation = this.conversation
    if (!conversation || (this.engine === 'js' && !this.agent)) throw new Error('会话尚未就绪')
    if (this.engine === 'rust' && !this.profile) throw new Error('会话尚未就绪')
    if (this.status !== 'idle') throw new Error('上一条回复尚未结束')
    // The previous run may still be settling; a stale executor would make the
    // new run look queued even though nothing is running.
    await this.drainRunWrites()

    const text = input.text.trim()
    if (text === '' && input.attachments.length === 0) return
    const imageIds = input.attachments.map((file) => file.assetId)
    const dataUrls = input.attachments.map((file) => file.dataUrl)
    if (this.engine === 'rust' && imageIds.length > 0) {
      throw new Error('rust 引擎暂不支持图片输入')
    }

    // The ledger insert and the user message share one transaction.
    const started = await this.startRun(conversation, 'prompt', {
      role: 'user',
      content: text,
      imageAssetIds: imageIds.length > 0 ? JSON.stringify(imageIds) : null,
    })
    if (started.run.status !== 'running') {
      this.queue.push({ run: started.run, userMessage: started.message })
      this.addUserItem(started, text, imageIds, dataUrls)
      this.emit()
      return
    }
    this.beginRun(started)
    this.addUserItem(started, text, imageIds, dataUrls)
    this.emit()
    if (this.engine === 'rust') {
      await this.runRustRun(started.run)
      return
    }
    await this.runTurn(text, input.attachments)
  }

  /** Inject guidance at the next turn boundary, persisted with its run marker. */
  steer(text: string): void {
    const message = text.trim()
    const conversation = this.conversation
    if (!message || !conversation) return
    if (this.engine === 'rust') {
      // No mid-request injection yet; persist it so the next run reads it.
      const runId = this.currentRun?.runId ?? null
      const steerOfRun = runId
      this.enqueueWrite(conversation.id, [
        { role: 'user', content: message, runId, steerOfRun },
      ])
      this.emit()
      return
    }
    if (!this.agent) return
    const runId = this.currentRun?.runId ?? null
    // Record the text so its pi user event does not persist a second row.
    this.steering.push({ text: message, runId })
    this.enqueueWrite(conversation.id, [
      { role: 'user', content: message, runId, steerOfRun: runId },
    ])
    this.agent.steer({ role: 'user', content: message, timestamp: Date.now() } as AgentMessage)
    this.emit()
  }

  /** Queue a run; it starts when the current one reaches a terminal state. */
  async followUp(text: string): Promise<void> {
    const message = text.trim()
    const conversation = this.conversation
    if (!message || !conversation) return
    const started = await this.startRun(conversation, 'prompt', {
      role: 'user',
      content: message,
    })
    if (started.run.status !== 'running') {
      this.queue.push({ run: started.run, userMessage: started.message })
      this.addUserItem(started, message, [], [])
      this.emit()
      return
    }
    // No executor was active, so the queued message starts immediately.
    this.beginRun(started)
    this.addUserItem(started, message, [], [])
    this.emit()
    if (this.engine === 'rust') {
      await this.runRustRun(started.run)
      return
    }
    await this.runTurn(message, [])
  }

  /** Both engines share the ledger; only the command differs. */
  private startRun(
    conversation: ChatConversation,
    trigger: AgentRunTrigger,
    message: NewChatMessage | null,
  ): Promise<AgentRunStart> {
    return this.engine === 'rust'
      ? this.deps.startRustRun(conversation.id, trigger, conversation.provider, message)
      : this.deps.startRun(conversation.id, trigger, conversation.provider, message)
  }

  private beginRun(started: AgentRunStart): void {
    this.currentRun = started.run
    this.runSteps = 0
    this.runWrites = 0
    this.limit = null
    this.cancelRequested = false
    this.lastError = null
    this.interrupted = null
    this.status = 'running'
    this.view = beginPrompt(this.view)
  }

  /** Append the optimistic user bubble; its row id comes from the ledger insert. */
  private addUserItem(
    started: AgentRunStart,
    text: string,
    imageIds: number[],
    dataUrls: string[],
  ): void {
    const generated = started.message
      ? { view: this.view, id: `m-${started.message.id}` }
      : nextItemId(this.view, 'u')
    this.view = {
      ...generated.view,
      items: [
        ...generated.view.items,
        {
          id: generated.id,
          kind: 'user',
          text,
          images: dataUrls.length > 0 ? dataUrls : undefined,
          imageAssetIds: imageIds.length > 0 ? imageIds : undefined,
        },
      ],
    }
  }

  private async runTurn(text: string, attachments: Attachment[]): Promise<void> {
    const agent = this.agent
    if (!agent) return
    const images: ImageContent[] = attachments.map((file) => ({
      type: 'image',
      data: file.data,
      mimeType: file.mime,
    }))
    try {
      if (images.length > 0) await agent.prompt(text || '请描述这些图片。', images)
      else await agent.prompt(text)
    } catch (error) {
      this.handleThrown(error)
    } finally {
      this.settleAfterRun()
    }
  }

  /** A thrown run has no `agent_end`; settle it as failed and clear the status. */
  private settleAfterRun(): void {
    if ((this.status as RuntimeStatus) !== 'idle') {
      this.status = 'idle'
      this.emit()
    }
    void this.settleRun('failed')
  }

  /**
   * Stop the run and wait for the close-out to be persisted (P0-1/P0-2).
   * The partial answer stays in the transcript instead of being dropped.
   */
  async cancel(): Promise<void> {
    if (this.engine === 'rust') {
      await this.cancelRust()
      return
    }
    const agent = this.agent
    if (!agent && !this.currentRun) return
    this.cancelRequested = true
    this.status = 'cancelling'
    this.emit()
    const runId = this.currentRun?.runId
    if (runId !== undefined) {
      try {
        this.currentRun = await this.deps.transitionRun(runId, 'cancelling')
      } catch (error) {
        console.error('标记运行取消失败', error)
      }
    }
    if (agent) {
      // Drop in-loop guidance so stopping really stops the run.
      agent.clearAllQueues()
      agent.abort()
      await agent.waitForIdle()
    }
    await this.drain()
    await this.settleRun('cancelled')
    await this.cancelQueued()
    await this.drainRunWrites()
    this.status = 'idle'
    this.emit()
  }

  /** Cancel the in-flight Rust run, wait for its close-out, then cancel the queue. */
  private async cancelRust(): Promise<void> {
    const conversation = this.conversation
    if (!conversation) return
    this.cancelRequested = true
    this.status = 'cancelling'
    this.emit()

    const runId = this.currentRun?.runId
    if (runId !== undefined) {
      try {
        await this.deps.cancelRustRun(runId)
      } catch (error) {
        console.error('取消运行失败', error)
      }
    }
    // The attach loop resolves once the end boundary event is delivered.
    await this.rustAttach
    await this.drain()

    // Rust may have pumped the next queued run at the boundary; cancel it too.
    const state = await this.deps.loadRunState(conversation.id).catch(() => null)
    const remaining = [
      ...(state?.queued.map((item) => item.run.runId) ?? []),
      ...(state?.active ? [state.active.runId] : []),
    ]
    for (const id of remaining) {
      try {
        await this.deps.cancelRustRun(id)
      } catch (error) {
        console.error('取消排队运行失败', error)
      }
    }
    if (remaining.length > 0) await this.rustAttach

    this.currentRun = null
    this.queue = []
    this.cancelRequested = false
    this.status = 'idle'
    this.emit()
  }

  /** Reset the projection for a re-run (retry/resume) and mark it executing. */
  private beginRustReRun(run: AgentRun, records: ChatMessageRecord[]): void {
    this.currentRun = run
    this.runSteps = 0
    this.runWrites = 0
    this.limit = null
    this.cancelRequested = false
    this.lastError = null
    this.interrupted = null
    this.view = createView(projectHistory(records, this.images))
    this.view.settled = false
    this.status = 'running'
    this.emit()
  }

  /** Attach to a Rust run: replay its boundary events, then stream until `end`. */
  private async runRustRun(run: AgentRun): Promise<void> {
    const attach = this.deps.attachRustRun(run.runId, 0, (event) => this.onRustEvent(event))
    this.rustAttach = attach.catch((error) => {
      console.error('订阅运行事件失败', error)
    })
    try {
      await this.rustAttach
    } finally {
      this.rustAttach = null
      await this.drain()
      await this.refreshLedger()
    }
  }

  /** Re-read the ledger after a run ends so a pumped queued run gets attached. */
  private async refreshLedger(): Promise<void> {
    const conversationId = this.conversation?.id
    if (conversationId === undefined) return
    const state = await this.deps
      .loadRunState(conversationId)
      .catch((): AgentRunState => ({ active: null, latest: null, queued: [] }))
    this.queue = state.queued
    this.interrupted = state.latest?.status === 'interrupted' ? state.latest : null
    if (!state.active) {
      this.currentRun = null
      this.status = 'idle'
      this.emit()
      return
    }
    this.currentRun = state.active
    this.status = state.active.status === 'cancelling' ? 'cancelling' : 'running'
    this.emit()
    void this.runRustRun(state.active)
  }

  /** Fold one boundary event from the Rust supervisor into the projection. */
  private onRustEvent(event: RustRunEvent): void {
    if (this.currentRun !== null && event.runId !== this.currentRun.runId) return
    switch (event.kind) {
      case 'state': {
        const status = event.payload.status
        if (this.currentRun) this.currentRun = { ...this.currentRun, status }
        if (status === 'running') this.status = 'running'
        else if (status === 'cancelling') this.status = 'cancelling'
        this.emit()
        return
      }
      case 'delta': {
        this.appendRustDelta(event.payload.delta)
        this.scheduleFlush()
        return
      }
      case 'assistant': {
        this.applyRustAssistant(event.payload.message, event.payload.errorCode)
        this.emit()
        return
      }
      case 'tool': {
        this.applyRustTool(event.payload)
        this.emit()
        return
      }
      case 'error': {
        const code = event.payload.errorCode as ErrorCode
        this.lastError = code === 'cancelled' ? null : { code, detail: event.payload.message }
        this.emit()
        return
      }
      case 'end': {
        const status = event.payload.status
        const code = event.payload.errorCode as ErrorCode | null
        this.cancelRequested = false
        this.lastError = status === 'failed' && code !== null ? { code, detail: '' } : null
        this.currentRun = null
        this.status = 'idle'
        this.view = flushBuffer(this.view)
        this.view = {
          ...this.view,
          streamingId: null,
          settled: true,
          closeOut: false,
          pendingInitialUser: false,
          buffer: null,
        }
        this.emit()
        return
      }
    }
  }

  /** Live-only text: Rust owns persistence, so deltas never touch SQLite here. */
  private appendRustDelta(delta: string): void {
    if (delta === '') return
    const id = this.ensureRustBubble()
    const previous = this.view.buffer
    const buffer =
      previous !== null && previous.id === id
        ? { ...previous, text: previous.text + delta }
        : { id, text: delta, thinking: '', tools: new Map() }
    this.view = { ...this.view, buffer }
  }

  private ensureRustBubble(): string {
    const current = this.view.streamingId
    if (
      current !== null &&
      this.view.items.some((item) => item.id === current && item.kind === 'assistant')
    ) {
      return current
    }
    const generated = nextItemId(this.view, 'a')
    this.view = {
      ...generated.view,
      streamingId: generated.id,
      settled: false,
      closeOut: false,
      pendingInitialUser: false,
      buffer: null,
      items: [
        ...generated.view.items,
        { id: generated.id, kind: 'assistant', text: '', streaming: true },
      ],
    }
    return generated.id
  }

  /** Reconcile the live bubble with the row Rust already persisted. */
  private applyRustAssistant(message: ChatMessageRecord, errorCode: string | null): void {
    const flushed = flushBuffer(this.view)
    const bubbleId = flushed.streamingId ?? `m-${message.id}`
    const failed = message.isError
    const cancelled = message.isPartial || message.stopReason === 'aborted'
    const bubble: Bubble = {
      id: bubbleId,
      kind: 'assistant',
      text: message.content,
      isError: failed,
      cancelled,
      errorCode: failed && errorCode !== null ? (errorCode as ErrorCode) : undefined,
      usage: message.usage,
      thinking: message.thinking,
      thinkingSignature: message.thinkingSignature,
      streaming: false,
    }
    let items = flushed.items.some((item) => item.id === bubbleId)
      ? flushed.items.map((item) => (item.id === bubbleId ? bubble : item))
      : [...flushed.items, bubble]
    // Same projection as a reload: paths written by this turn's tool cards.
    const index = items.findIndex((item) => item.id === bubbleId && item.kind === 'assistant')
    if (index >= 0) {
      const changes = turnChanges(items, index)
      items = items.map((item, i) => (i === index ? { ...(item as Bubble), changes } : item))
    }
    this.view = {
      ...flushed,
      items,
      streamingId: null,
      settled: true,
      closeOut: false,
      pendingInitialUser: false,
      buffer: null,
    }
  }

  /** Fold a persisted tool row into the transcript (Rust owns execution). */
  private applyRustTool(message: ChatMessageRecord): void {
    const flushed = flushBuffer(this.view)
    const id = `m-${message.id}`
    const card: ToolCard = {
      id,
      kind: 'tool',
      toolName: message.toolName ?? 'tool',
      args: message.toolArgs ?? '',
      status: message.isError ? 'error' : 'done',
      text: message.content,
      durationMs: message.toolDurationMs ?? undefined,
    }
    const items = flushed.items.some((item) => item.id === id && item.kind === 'tool')
      ? flushed.items.map((item) => (item.id === id && item.kind === 'tool' ? card : item))
      : [...flushed.items, card]
    this.view = { ...flushed, items }
  }

  async retry(messageKey: string): Promise<void> {
    const conversation = this.conversation
    const profile = this.profile
    if (!conversation || !profile || this.status !== 'idle') throw new Error('会话尚未就绪')
    await this.drainRunWrites()

    const records = await this.deps.loadMessages(conversation.id)
    const match = /^m-(\d+)$/.exec(messageKey)
    let target = match ? records.findIndex((record) => record.id === Number(match[1])) : -1
    if (target < 0) {
      const indexes = assistantIndexes(records)
      target = indexes.length > 0 ? indexes[indexes.length - 1] : -1
    }
    let userIndex = target - 1
    while (userIndex >= 0 && records[userIndex].role !== 'user') userIndex -= 1
    if (userIndex < 0) throw new Error('没有可重试的回答')

    const keptRecords = records.slice(0, userIndex + 1)
    if (this.engine === 'rust') {
      // Truncate before starting: the supervisor reads the transcript immediately.
      await this.drain()
      await this.deps.truncate(conversation.id, records[userIndex].id)
      const started = await this.startRun(conversation, 'retry', null)
      if (started.run.status !== 'running') {
        await this.deps.finishRun(started.run.runId, 'cancelled', {
          partial: null,
          errorCode: 'cancelled',
          stepCount: 0,
          writeCount: 0,
          lastSeq: 0,
        })
        throw new Error('上一条回复尚未结束')
      }
      this.beginRustReRun(started.run, keptRecords)
      await this.runRustRun(started.run)
      return
    }

    const started = await this.deps.startRun(conversation.id, 'retry', profile.provider, null)
    if (started.run.status !== 'running') {
      await this.deps.finishRun(started.run.runId, 'cancelled', {
        partial: null,
        errorCode: 'cancelled',
        stepCount: 0,
        writeCount: 0,
        lastSeq: 0,
      })
      throw new Error('上一条回复尚未结束')
    }
    this.currentRun = started.run
    this.runSteps = 0
    this.runWrites = 0
    this.cancelRequested = false
    this.interrupted = null

    await this.drain()
    await this.deps.truncate(conversation.id, records[userIndex].id)

    const kept = records.slice(0, userIndex + 1)
    this.teardownAgent()
    this.view = createView(projectHistory(kept, this.images))
    this.lastError = null
    this.status = 'running'
    this.view.settled = false
    this.emit()

    try {
      const skills = await this.deps.loadSkills().catch(() => [])
      const mcpTools = await this.deps.loadMcpTools().catch(() => [])
      this.skillsIndex = buildSkillsIndex(skills)
      const agent = await this.buildAgent(profile, kept, skills, mcpTools)
      this.unsubscribe = agent.subscribe((event) => this.onEvent(event))
      this.agent = agent
      await agent.continue()
    } catch (error) {
      this.handleThrown(error)
    } finally {
      this.settleAfterRun()
    }
  }

  /**
   * Start a `resume` run after an interruption. The partial answer is dropped
   * and the model continues from the user turn; nothing auto-sends on startup.
   */
  async resume(): Promise<void> {
    const conversation = this.conversation
    const profile = this.profile
    if (!conversation || !profile || this.status !== 'idle') throw new Error('会话尚未就绪')
    await this.drainRunWrites()

    if (this.engine === 'rust') {
      const started = await this.startRun(conversation, 'resume', null)
      if (started.run.status !== 'running') {
        await this.deps.finishRun(started.run.runId, 'cancelled', {
          partial: null,
          errorCode: 'cancelled',
          stepCount: 0,
          writeCount: 0,
          lastSeq: 0,
        })
        throw new Error('上一条回复尚未结束')
      }
      await this.drain()
      const resumeFrom = started.run.resumeFromMessageId
      if (resumeFrom !== null) await this.deps.truncate(conversation.id, resumeFrom)
      const records = await this.deps.loadMessages(conversation.id)
      this.images = await this.deps.loadImages(records).catch(() => new Map())
      this.beginRustReRun(started.run, records)
      await this.runRustRun(started.run)
      return
    }

    const started = await this.deps.resumeRun(conversation.id, profile.provider)
    if (started.run.status !== 'running') {
      await this.deps.finishRun(started.run.runId, 'cancelled', {
        partial: null,
        errorCode: 'cancelled',
        stepCount: 0,
        writeCount: 0,
        lastSeq: 0,
      })
      throw new Error('上一条回复尚未结束')
    }
    this.currentRun = started.run
    this.runSteps = 0
    this.runWrites = 0
    this.cancelRequested = false
    this.lastError = null
    this.interrupted = null

    await this.drain()
    const resumeFrom = started.run.resumeFromMessageId
    if (resumeFrom !== null) await this.deps.truncate(conversation.id, resumeFrom)
    const records = await this.deps.loadMessages(conversation.id)
    this.images = await this.deps.loadImages(records).catch(() => new Map())

    this.teardownAgent()
    this.view = createView(projectHistory(records, this.images))
    this.view.settled = false
    this.status = 'running'
    this.emit()

    try {
      const skills = await this.deps.loadSkills().catch(() => [])
      const mcpTools = await this.deps.loadMcpTools().catch(() => [])
      this.skillsIndex = buildSkillsIndex(skills)
      const agent = await this.buildAgent(profile, records, skills, mcpTools)
      this.unsubscribe = agent.subscribe((event) => this.onEvent(event))
      this.agent = agent
      await agent.continue()
    } catch (error) {
      this.handleThrown(error)
    } finally {
      this.settleAfterRun()
    }
  }

  /** Copy the transcript up to the user turn that produced `assistantText`. */
  async fork(assistantText: string): Promise<ChatConversation> {
    const conversation = this.conversation
    if (!conversation) throw new Error('会话尚未就绪')
    const records = await this.deps.loadMessages(conversation.id)
    let index = -1
    for (let i = records.length - 1; i >= 0; i -= 1) {
      if (records[i].role === 'assistant' && records[i].content === assistantText) {
        index = i
        break
      }
    }
    let cutoff = records.length
    if (index >= 0) {
      let userIndex = index - 1
      while (userIndex >= 0 && records[userIndex].role !== 'user') userIndex -= 1
      cutoff = userIndex >= 0 ? userIndex + 1 : index + 1
    }
    const created = await this.deps.createConversation(`${conversation.title} · 分支`.slice(0, 80))
    if (cutoff > 0) {
      await this.deps.append(
        created.id,
        records.slice(0, cutoff).map((record) => ({
          role: record.role,
          content: record.content,
          toolCalls: record.toolCalls,
          toolCallId: record.toolCallId,
          toolName: record.toolName,
          isError: record.isError,
          usage: record.usage,
          thinking: record.thinking,
          thinkingSignature: record.thinkingSignature,
          imageAssetIds: record.imageAssetIds,
          toolArgs: record.toolArgs,
          toolDurationMs: record.toolDurationMs,
          isPartial: record.isPartial,
          stopReason: record.stopReason,
        })),
      )
    }
    return created
  }

  // ---------------------------------------------------------------- teardown

  /**
   * Order is load-bearing: await the abort close-out and its persistence
   * BEFORE unsubscribing, otherwise the final partial never reaches SQLite.
   */
  async dispose(): Promise<void> {
    if (this.engine === 'rust') {
      if (this.status !== 'idle' || this.currentRun !== null) await this.cancelRust()
      await this.drain()
      await this.drainRunWrites()
      this.teardownAgent()
      this.rustAttach = null
      this.currentRun = null
      this.queue = []
      this.status = 'idle'
      this.view = createView([])
      return
    }
    const agent = this.agent
    if (!agent) {
      await this.drain()
      await this.drainRunWrites()
      return
    }
    if (this.status !== 'idle') {
      this.cancelRequested = true
      this.status = 'cancelling'
      const runId = this.currentRun?.runId
      if (runId !== undefined) {
        try {
          this.currentRun = await this.deps.transitionRun(runId, 'cancelling')
        } catch (error) {
          console.error('标记运行取消失败', error)
        }
      }
      agent.clearAllQueues()
      agent.abort()
      await agent.waitForIdle()
    }
    await this.drain()
    await this.settleRun('cancelled')
    await this.drainRunWrites()
    this.teardownAgent()
    this.status = 'idle'
    this.view = createView([])
  }

  private teardownAgent(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
    this.agent = null
  }

  // ---------------------------------------------------------------- observe

  subscribe(listener: (snapshot: RuntimeSnapshot) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  snapshot(): RuntimeSnapshot {
    return {
      conversationId: this.conversation?.id ?? null,
      status: this.status,
      queued: this.queue.length,
      items: this.view.items,
      run: this.currentRun,
      interrupted: this.interrupted,
      error: this.lastError,
      revision: this.revision,
    }
  }

  private emit(): void {
    this.flushNow()
  }

  private flushNow(): void {
    this.view = flushBuffer(this.view)
    this.revision += 1
    const snapshot = this.snapshot()
    for (const listener of this.listeners) listener(snapshot)
  }

  // ---------------------------------------------------------------- events

  private onEvent(event: AgentEvent): void {
    const { view, effects } = reduceEvent(this.view, event)
    this.view = view
    for (const effect of effects) this.applyEffect(effect)

    if (event.type === 'agent_start') {
      this.status = 'running'
      this.emit()
      return
    }
    if (event.type === 'agent_end') {
      const cancelled = this.cancelRequested
      this.cancelRequested = false
      this.status = 'idle'
      this.lastError = cancelled ? null : this.pickError()
      this.emit()
      // Settle the ledger row, then start the next queued run if any.
      void this.settleRun(
        cancelled ? 'cancelled' : this.lastError !== null ? 'failed' : 'succeeded',
        this.limit === 'steps' ? 'quota_steps' : null,
      ).then(() => {
        if (!cancelled) void this.pumpQueue()
      })
      return
    }
    if (event.type === 'message_end') {
      if (event.message.role === 'assistant') {
        const message = event.message
        if (message.stopReason === 'error' || message.stopReason === 'aborted') {
          const info = classifyFailure(message)
          this.lastError = info.code === 'cancelled' ? null : info
        } else {
          this.lastError = null
        }
      }
      this.emit()
      return
    }
    if (event.type === 'tool_execution_start') {
      this.runSteps += 1
      this.emit()
      return
    }
    if (event.type === 'tool_execution_end') {
      if (!event.isError && ['fs_write', 'fs_edit'].includes(event.toolName)) {
        this.runWrites += 1
      }
      void this.touchRun()
      this.emit()
      return
    }
    // Token deltas only fill the buffer; one render per frame.
    this.scheduleFlush()
  }

  /** Read the failure code the reducer attached to the last settled bubble. */
  private pickError(): ErrorInfo | null {
    for (let i = this.view.items.length - 1; i >= 0; i -= 1) {
      const item = this.view.items[i]
      if (item.kind !== 'assistant') continue
      if (!item.errorCode || item.errorCode === 'cancelled') return null
      const failed: Bubble = item
      return { code: failed.errorCode!, detail: '' }
    }
    return null
  }

  /** One scheduled flush per frame; token deltas only touch the buffer. */
  private scheduleFlush(): void {
    if (this.scheduled) return
    this.scheduled = true
    this.schedule(() => {
      this.scheduled = false
      this.flushNow()
    })
  }

  // ---------------------------------------------------------------- storage

  private applyEffect(effect: ViewEffect): void {
    const conversationId = this.conversation?.id
    if (!conversationId) return
    switch (effect.kind) {
      case 'persist-assistant': {
        if (effect.text.trim() === '' && effect.toolCalls === null) return
        this.enqueueWrite(conversationId, [
          {
            role: 'assistant',
            content: effect.text,
            toolCalls: effect.toolCalls,
            isError: effect.isError,
            usage: effect.usage,
            thinking: effect.thinking,
            thinkingSignature: effect.thinkingSignature,
            runId: this.currentRun?.runId ?? null,
            stopReason: effect.stopReason,
            isPartial: effect.isPartial,
          },
        ])
        return
      }
      case 'persist-tool': {
        this.enqueueWrite(conversationId, [
          {
            role: 'tool',
            content: effect.text,
            toolCallId: effect.toolCallId,
            toolName: effect.toolName,
            isError: effect.isError,
            toolArgs: effect.args || null,
            toolDurationMs: effect.durationMs ?? null,
            runId: this.currentRun?.runId ?? null,
          },
        ])
        return
      }
      case 'persist-user': {
        // Steering was written up front; its pi event must not duplicate it.
        const steerIndex = this.steering.findIndex((item) => item.text === effect.text)
        if (steerIndex >= 0) {
          this.steering.splice(steerIndex, 1)
          return
        }
        this.enqueueWrite(conversationId, [
          { role: 'user', content: effect.text, runId: this.currentRun?.runId ?? null },
        ])
        return
      }
      default:
        return
    }
  }

  /** Serialized writes: transcript order must match event order. */
  private enqueueWrite(conversationId: number, messages: NewChatMessage[]): void {
    this.writing = this.writing.then(
      () => this.deps.append(conversationId, messages).then(() => undefined),
      () => this.deps.append(conversationId, messages).then(() => undefined),
    )
    this.writing = this.writing.catch((error) => {
      console.error('保存 Agent 消息失败', error)
    })
  }

  /** Resolve once every queued write has settled. */
  private drain(): Promise<void> {
    return this.writing
  }

  // ---------------------------------------------------------------- run ledger

  private enqueueRunWrite(task: () => Promise<unknown>): void {
    this.runWriting = this.runWriting.then(
      () => task().then(() => undefined),
      () => task().then(() => undefined),
    )
    this.runWriting = this.runWriting.catch((error) => {
      console.error('保存运行状态失败', error)
    })
  }

  private drainRunWrites(): Promise<void> {
    return this.runWriting
  }

  /** Close the ledger row exactly once; later calls are no-ops. */
  private settleRun(
    status: 'succeeded' | 'failed' | 'cancelled',
    overrideCode: string | null = null,
  ): Promise<void> {
    const run = this.currentRun
    if (!run) return Promise.resolve()
    this.currentRun = null
    // Cancelled or failed runs keep whatever text was already shown.
    const partial = status === 'succeeded' ? null : this.lastPartialText()
    const payload = partial !== null ? JSON.stringify({ text: partial }) : null
    const errorCode =
      status === 'cancelled' ? 'cancelled' : (overrideCode ?? this.lastError?.code ?? null)
    this.enqueueRunWrite(() =>
      this.deps.finishRun(run.runId, status, {
        partial: payload,
        errorCode,
        stepCount: this.runSteps,
        writeCount: this.runWrites,
        lastSeq: this.revision,
      }),
    )
    return this.runWriting
  }

  /** Text already shown in the current (now closed) assistant bubble. */
  private lastPartialText(): string | null {
    for (let i = this.view.items.length - 1; i >= 0; i -= 1) {
      const item = this.view.items[i]
      // Never reach into a previous turn for the snapshot.
      if (item.kind === 'user') return null
      if (item.kind !== 'assistant') continue
      // An error notice is not saved answer text; a cancelled bubble is.
      if (item.isError && !item.cancelled) return null
      return item.text.trim() === '' ? null : item.text
    }
    return null
  }

  private touchRun(): Promise<void> {
    const run = this.currentRun
    if (!run) return Promise.resolve()
    this.enqueueRunWrite(() =>
      this.deps.touchRun(run.runId, this.runSteps, this.runWrites, this.revision),
    )
    return this.runWriting
  }

  /** Cancelling a run also cancels everything waiting behind it. */
  private async cancelQueued(): Promise<void> {
    const queued = [...this.queue]
    this.queue = []
    this.emit()
    for (const item of queued) {
      this.enqueueRunWrite(() =>
        this.deps.finishRun(item.run.runId, 'cancelled', {
          partial: null,
          errorCode: 'cancelled',
          stepCount: 0,
          writeCount: 0,
          lastSeq: 0,
        }),
      )
    }
    await this.drainRunWrites()
  }

  /** Start the oldest queued run after the previous one reached a terminal state. */
  private async pumpQueue(): Promise<void> {
    // Rust pumps queued runs itself; re-attaching happens in `refreshLedger`.
    if (this.engine === 'rust') return
    if (this.pumping || this.status !== 'idle' || !this.agent || this.queue.length === 0) return
    const next = this.queue[0]
    const text = next.userMessage?.content ?? ''
    if (text.trim() === '') {
      this.queue.shift()
      this.emit()
      return
    }
    this.pumping = true
    try {
      const run = await this.deps.transitionRun(next.run.runId, 'running')
      this.queue.shift()
      this.currentRun = run
      this.runSteps = 0
      this.runWrites = 0
      this.cancelRequested = false
      this.lastError = null
      this.interrupted = null
      this.view = beginPrompt(this.view)
      this.status = 'running'
      this.emit()
      await this.runTurn(text, [])
    } finally {
      this.pumping = false
      this.settleAfterRun()
      void this.pumpQueue()
    }
  }

  /** A run that throws before any terminal event still leaves a visible bubble. */
  private handleThrown(error: unknown): void {
    const info = classifyError(error)
    this.lastError = info.code === 'cancelled' ? null : info
    if (this.engine === 'rust') {
      // Rust owns persistence; never write a second error row.
      this.status = 'idle'
      this.emit()
      return
    }
    if (this.view.settled) return
    const generated = nextItemId(this.view, 'e')
    this.view = {
      ...generated.view,
      streamingId: null,
      settled: true,
      pendingInitialUser: false,
      closeOut: false,
      buffer: null,
      items: [
        ...generated.view.items,
        {
          id: generated.id,
          kind: 'assistant',
          text: errorText(info),
          isError: true,
          errorCode: info.code,
        },
      ],
    }
    const conversationId = this.conversation?.id
    if (conversationId) {
      this.enqueueWrite(conversationId, [
        {
          role: 'assistant',
          content: errorText(info),
          isError: true,
          runId: this.currentRun?.runId ?? null,
          stopReason: 'error',
        },
      ])
    }
    this.emit()
  }
}
