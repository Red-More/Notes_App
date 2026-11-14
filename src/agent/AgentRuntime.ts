//! The single owner of a chat run.
//!
//! It holds the pi-agent `Agent`, the run status, the queue counters and the
//! persistence order. The page only renders `snapshot().items`, so every
//! transcript mutation (including cancel close-out) happens here.

import type { Agent } from '@earendil-works/pi-agent-core'
import type { AgentMessage, AgentEvent, StreamFn } from '@earendil-works/pi-agent-core'
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
  SkillSummary,
} from '../types'
import { buildSkillsIndex } from './skills'
import { createAgent, toAgentMessages, userContent, type AgentProfile, type ImageAttachment } from './runtime'
import { classifyError, classifyFailure, errorText, type ErrorInfo } from './errors'
import {
  beginPrompt,
  createView,
  flushBuffer,
  nextItemId,
  projectHistory,
  reduceEvent,
  userText,
  type Bubble,
  type ChatView,
  type Item,
  type ViewEffect,
} from './chatView'

export type RuntimeStatus = 'idle' | 'running' | 'cancelling'

/**
 * One composer submission that has not reached the transcript yet.
 *
 * `steer` is injected by pi after the current tool batch, before the next
 * request; `followUp` waits in the run ledger until the whole loop ends.
 */
export type QueueEntryMode = 'steer' | 'followUp'

/**
 * `pending`  = still waiting (deletable),
 * `delivered` = handed to the agent/ledger, waiting to be consumed,
 * `consumed` = the bubble is being rendered; the bar plays its exit animation,
 * `failed`   = rollback the composer text and offer a retry.
 */
export type QueueEntryStatus = 'pending' | 'delivered' | 'consumed' | 'failed'

export interface QueueEntry {
  id: string
  mode: QueueEntryMode
  text: string
  status: QueueEntryStatus
  /** Ledger run id for a follow-up; retry/withdraw target. */
  runId?: number
  error?: string
}

export interface PromptInput {
  text: string
  /** Image assets attached to this user turn (validated by the composer). */
  imageAssetIds?: number[]
}

/** Everything the runtime needs from the outside; fakeable in tests. */
export interface AgentRuntimeDeps {
  loadMessages(conversationId: number): Promise<ChatMessageRecord[]>
  append(conversationId: number, messages: NewChatMessage[]): Promise<unknown>
  truncate(conversationId: number, messageId: number): Promise<void>
  /** Delete `messageId` itself and everything newer (edit rewrites that turn). */
  truncateFrom(conversationId: number, messageId: number): Promise<void>
  /** Delete exactly one row; withdrawing a queued follow-up must not touch later rows. */
  deleteMessage(conversationId: number, messageId: number): Promise<void>
  loadSkills(): Promise<SkillSummary[]>
  loadMcpTools(): Promise<McpToolInfo[]>
  /** Bytes of one image asset, for replaying and sending user attachments. */
  loadAsset(id: number): Promise<{ data: string; mime: string }>
  createConversation(title: string): Promise<ChatConversation>
  /** Run ledger: the database is the queue, so re-entry never loses work. */
  startRun(
    conversationId: number | null,
    trigger: AgentRunTrigger,
    modelEntry: string,
    message?: NewChatMessage | null,
    title?: string,
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
}

export interface RuntimeSnapshot {
  conversationId: number | null
  /** Adopted conversation; NULL while the chat is still an unsaved draft. */
  conversation: ChatConversation | null
  status: RuntimeStatus
  /** Pending runs read from the ledger (survives page switches). */
  queued: number
  items: Item[]
  /** Composer submissions that have not reached the transcript yet. */
  queueItems: QueueEntry[]
  /** Tool calls started in the current run; drives the steer ETA copy. */
  stepCount: number
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

/** Short failure copy for the queue bar; the row itself stays actionable. */
function queueErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim() !== '') return error.message
  return '未发出，请重试'
}

/** Confirmation deadline for the optimistic queue entry. */
const QUEUE_CONFIRM_TIMEOUT_MS = 3000

export class AgentRuntime {
  private readonly deps: AgentRuntimeDeps
  private readonly streamFn?: StreamFn
  private readonly schedule: (flush: () => void) => void

  private agent: Agent | null = null
  private unsubscribe: (() => void) | null = null
  private conversation: ChatConversation | null = null
  private profile: AgentProfile | null = null
  private skillsIndex = ''

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
  /** Steering texts already written; their pi user events must not duplicate. */
  private steering: { entryId: string; text: string; runId: number | null; consumed: boolean }[] = []
  /** Optimistic composer queue surfaced by the status bar. */
  private queueItems: QueueEntry[] = []
  private queueSeq = 0
  /** Entries the user withdrew while their submission was still in flight. */
  private cancelledQueue = new Set<string>()
  /** Confirmation deadlines, so a stuck write can never leave a gray dot forever. */
  private queueTimers = new Map<string, ReturnType<typeof setTimeout>>()

  constructor(options: AgentRuntimeOptions) {
    this.deps = options.deps
    this.streamFn = options.streamFn
    this.schedule = options.schedule ?? defaultSchedule
  }

  // ---------------------------------------------------------------- loading

  /** Load a conversation and build a fresh Agent. A running run is closed out first. */
  async open(conversation: ChatConversation, profile: AgentProfile | null): Promise<void> {
    await this.dispose()
    this.conversation = conversation
    this.profile = profile
    this.resetState()

    // Restore the ledger view: queued work and the interrupted banner survive
    // page switches because they are read from SQLite, not memory.
    const [records, runState] = await Promise.all([
      this.deps.loadMessages(conversation.id),
      this.deps.loadRunState(conversation.id).catch(
        () => ({ active: null, latest: null, queued: [] }) as AgentRunState,
      ),
    ])
    this.currentRun = runState.active
    this.queue = runState.queued
    this.interrupted = runState.latest?.status === 'interrupted' ? runState.latest : null
    // A queued follow-up is visible in the status bar, not in the transcript.
    // Its row exists already (the queue is the database), so hide it from both
    // the projected items and the replayed agent history until it starts.
    const queuedMessageIds = new Set(
      runState.queued
        .map((item) => item.userMessage?.id)
        .filter((id): id is number => typeof id === 'number'),
    )
    const history = records.filter((record) => !queuedMessageIds.has(record.id))
    this.view = createView(projectHistory(history))
    this.queueItems = runState.queued.map((item) => ({
      id: `restored-${item.run.runId}`,
      mode: 'followUp',
      text: item.userMessage?.content ?? '',
      status: 'pending',
      runId: item.run.runId,
    }))

    if (profile) {
      await this.attachAgent(profile, history)
    }
    this.emit()
  }

  /**
   * Prepare an unsaved draft: no conversation row exists yet. The first
   * `prompt` creates the conversation and persists its first message in one
   * transaction, so drafts never leave empty entries in the list.
   */
  async openDraft(profile: AgentProfile | null): Promise<void> {
    await this.dispose()
    this.conversation = null
    this.profile = profile
    this.resetState()
    if (profile) {
      await this.attachAgent(profile, [])
    }
    this.emit()
  }

  /** Clear per-conversation state without touching the shared Agent plumbing. */
  private resetState(): void {
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
    this.queueItems = []
    this.cancelledQueue.clear()
    for (const timer of this.queueTimers.values()) clearTimeout(timer)
    this.queueTimers.clear()
  }

  private async attachAgent(
    profile: AgentProfile,
    records: ChatMessageRecord[],
  ): Promise<void> {
    const skills = await this.deps.loadSkills().catch(() => [])
    const mcpTools = await this.deps.loadMcpTools().catch(() => [])
    this.skillsIndex = buildSkillsIndex(skills)
    const agent = await this.buildAgent(profile, records, skills, mcpTools)
    this.unsubscribe = agent.subscribe((event) => this.onEvent(event))
    this.agent = agent
  }

  private async buildAgent(
    profile: AgentProfile,
    records: ChatMessageRecord[],
    skills: SkillSummary[],
    mcpTools: McpToolInfo[],
  ): Promise<Agent> {
    return createAgent(
      profile,
      await toAgentMessages(records, profile, async (id) => {
        const asset = await this.deps.loadAsset(id)
        return { data: asset.data, mimeType: asset.mime }
      }),
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
    if (!this.agent) throw new Error('会话尚未就绪')
    if (this.status !== 'idle') throw new Error('上一条回复尚未结束')
    // The previous run may still be settling; a stale executor would make the
    // new run look queued even though nothing is running.
    await this.drainRunWrites()

    const text = input.text.trim()
    const imageAssetIds = input.imageAssetIds ?? []
    if (text === '' && imageAssetIds.length === 0) return

    // The ledger insert and the user message share one transaction. For a
    // draft (conversation === null) the backend also creates the conversation
    // in that same transaction, so a failed first send leaves nothing behind.
    const started = await this.startRun(
      conversation,
      'prompt',
      {
        role: 'user',
        content: text,
        imageAssetIds,
      },
      text.slice(0, 20) || '附件',
    )
    if (started.conversation) this.conversation = started.conversation
    if (started.run.status !== 'running') {
      this.queue.push({ run: started.run, userMessage: started.message })
      this.addUserItem(started, text, imageAssetIds)
      this.emit()
      return
    }
    this.beginRun(started)
    this.addUserItem(started, text, imageAssetIds)
    this.emit()
    await this.runTurn(text, imageAssetIds)
  }

  /**
   * 插话（steer）：pi 只会在**本批工具调用全部返回后、下一轮请求发出前**
   * 通过 `getSteeringMessages` 抽取一次，所以它用来临时改道，而不是排队。
   * The composer adds an optimistic status-bar entry; it is confirmed only
   * after the guidance row is written, then injected into pi's steering queue.
   */
  steer(text: string): void {
    const message = text.trim()
    const entry = this.pushQueueEntry('steer', message)
    const conversation = this.conversation
    const runId = this.currentRun?.runId ?? null
    const agent = this.agent
    if (message === '') {
      this.failQueueEntry(entry.id, '内容为空')
      return
    }
    if (!conversation || !agent || runId === null || this.status === 'idle') {
      this.failQueueEntry(entry.id, '当前没有进行中的回复')
      return
    }
    // Record the text first so its pi user event does not persist a second row.
    const steering = { entryId: entry.id, text: message, runId, consumed: false }
    this.steering.push(steering)
    this.enqueueWriteTracked(conversation.id, [
      { role: 'user', content: message, runId, steerOfRun: runId },
    ]).then(
      () => {
        // Withdrawn, timed out, or the run changed while the row was written.
        const current = this.queueItems.find((item) => item.id === entry.id)
        if (this.cancelledQueue.has(entry.id) || !current || current.status === 'failed') {
          this.steering = this.steering.filter((item) => item !== steering)
          return
        }
        if (this.agent !== agent || this.currentRun?.runId !== runId) {
          this.steering = this.steering.filter((item) => item !== steering)
          this.failQueueEntry(entry.id, '回复已结束，插话未生效')
          return
        }
        agent.steer({ role: 'user', content: message, timestamp: Date.now() } as AgentMessage)
        this.updateQueueEntry(entry.id, { status: 'delivered' })
      },
      (error) => {
        this.steering = this.steering.filter((item) => item !== steering)
        this.failQueueEntry(entry.id, queueErrorMessage(error))
      },
    )
  }

  /**
   * 排队（followUp）：整个 agent 循环自然结束后，运行时再开一条**新的 run**
   * （不是插进当前循环），因此文本先落进运行账本，等 `pumpQueue` 启动时才渲染。
   */
  async followUp(text: string): Promise<void> {
    const message = text.trim()
    const entry = this.pushQueueEntry('followUp', message)
    const conversation = this.conversation
    if (message === '') {
      this.failQueueEntry(entry.id, '内容为空')
      return
    }
    if (!conversation) {
      this.failQueueEntry(entry.id, '会话尚未就绪')
      return
    }
    try {
      const started = await this.startRun(conversation, 'prompt', {
        role: 'user',
        content: message,
      })
      // Withdrawn or timed out while the ledger insert was in flight.
      const current = this.queueItems.find((item) => item.id === entry.id)
      if (this.cancelledQueue.has(entry.id) || !current || current.status === 'failed') {
        this.cancelledQueue.delete(entry.id)
        await this.discardRun(conversation.id, started)
        return
      }
      this.updateQueueEntry(entry.id, { runId: started.run.runId })
      if (started.run.status !== 'running') {
        // An executor owns the conversation; this run waits in the ledger and
        // stays in the status bar instead of the transcript.
        this.queue.push({ run: started.run, userMessage: started.message })
        this.emit()
        return
      }
      // No executor was active, so this message starts a fresh run now.
      this.beginRun(started)
      this.addUserItem(started, message)
      this.updateQueueEntry(entry.id, { status: 'delivered' })
      this.consumeQueueEntry(entry.id)
      this.emit()
      await this.runTurn(message)
    } catch (error) {
      this.failQueueEntry(entry.id, queueErrorMessage(error))
    }
  }

  private startRun(
    conversation: ChatConversation | null,
    trigger: AgentRunTrigger,
    message: NewChatMessage | null,
    title?: string,
  ): Promise<AgentRunStart> {
    const modelEntry = conversation?.provider ?? this.profile?.provider ?? ''
    return this.deps.startRun(
      conversation?.id ?? null,
      trigger,
      modelEntry,
      message,
      title,
    )
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
    started: { message: ChatMessageRecord | null },
    text: string,
    imageAssetIds: number[] = [],
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
          imageAssetIds: imageAssetIds.length > 0 ? imageAssetIds : undefined,
        },
      ],
    }
  }

  // ---------------------------------------------------------------- queue bar

  private pushQueueEntry(mode: QueueEntryMode, text: string): QueueEntry {
    const entry: QueueEntry = { id: `q-${(this.queueSeq += 1)}`, mode, text, status: 'pending' }
    this.queueItems = [...this.queueItems, entry]
    this.queueTimers.set(
      entry.id,
      setTimeout(() => {
        this.queueTimers.delete(entry.id)
        const current = this.queueItems.find((item) => item.id === entry.id)
        if (!current || current.status !== 'pending') return
        // A follow-up with a ledger row is confirmed even while it waits.
        if (current.mode === 'followUp' && current.runId !== undefined) return
        this.failQueueEntry(entry.id, '投递超时')
      }, QUEUE_CONFIRM_TIMEOUT_MS),
    )
    this.emit()
    return entry
  }

  private updateQueueEntry(id: string, patch: Partial<QueueEntry>): void {
    let changed = false
    this.queueItems = this.queueItems.map((item) => {
      if (item.id !== id) return item
      changed = true
      return { ...item, ...patch }
    })
    if (changed && patch.status && patch.status !== 'pending') {
      const timer = this.queueTimers.get(id)
      if (timer) {
        clearTimeout(timer)
        this.queueTimers.delete(id)
      }
    }
    if (changed) this.emit()
  }

  private failQueueEntry(id: string, error: string): void {
    this.updateQueueEntry(id, { status: 'failed', error })
  }

  /** The bubble is rendered: the bar plays its exit animation, then dismisses. */
  private consumeQueueEntry(id: string): void {
    this.updateQueueEntry(id, { status: 'consumed' })
  }

  /** Remove one item after its exit animation (or after an explicit delete). */
  dismissQueueEntry(id: string): void {
    if (!this.queueItems.some((item) => item.id === id)) return
    const timer = this.queueTimers.get(id)
    if (timer) {
      clearTimeout(timer)
      this.queueTimers.delete(id)
    }
    this.queueItems = this.queueItems.filter((item) => item.id !== id)
    this.cancelledQueue.delete(id)
    this.emit()
  }

  /** Withdraw a queued item; delivered steering can no longer be recalled. */
  async removeQueueEntry(id: string): Promise<void> {
    const entry = this.queueItems.find((item) => item.id === id)
    if (!entry || entry.status === 'delivered' || entry.status === 'consumed') return
    if (entry.mode === 'steer') {
      // Cancel the write/injection continuation still in flight. Order matters:
      // dismissing clears stale markers, so mark cancellation afterwards.
      this.steering = this.steering.filter((item) => item.entryId !== id)
      this.dismissQueueEntry(id)
      this.cancelledQueue.add(id)
      return
    }
    const conversationId = this.conversation?.id
    this.dismissQueueEntry(id)
    if (entry.runId === undefined) {
      // The ledger insert has not landed yet; the continuation discards it.
      this.cancelledQueue.add(id)
      return
    }
    const index = this.queue.findIndex((item) => item.run.runId === entry.runId)
    if (index >= 0) {
      const [queued] = this.queue.splice(index, 1)
      this.emit()
      if (conversationId && queued.userMessage) {
        await this.deps.deleteMessage(conversationId, queued.userMessage.id).catch((error) => {
          console.error('撤回排队消息失败', error)
        })
      }
    }
    this.enqueueRunWrite(() => this.finishRunSafely(entry.runId!))
    await this.drainRunWrites()
  }

  /** Re-submit a failed entry in its original mode. */
  retryQueueEntry(id: string): void {
    const entry = this.queueItems.find((item) => item.id === id)
    if (!entry || entry.status !== 'failed') return
    this.dismissQueueEntry(id)
    if (entry.mode === 'steer') this.steer(entry.text)
    else void this.followUp(entry.text)
  }

  /** Long-press drag reorder; only follow-ups are orderable (steer is recency). */
  moveQueueEntry(id: string, targetIndex: number): void {
    const followUps = this.queueItems.filter(
      (item) => item.mode === 'followUp' && item.status !== 'consumed',
    )
    const from = followUps.findIndex((item) => item.id === id)
    if (from < 0) return
    const to = Math.max(0, Math.min(followUps.length - 1, targetIndex))
    if (to === from) return
    const reordered = [...followUps]
    const [moved] = reordered.splice(from, 1)
    reordered.splice(to, 0, moved)
    // Rebuild the visible list; non-follow-up entries keep their positions.
    let cursor = 0
    this.queueItems = this.queueItems.map((item) => {
      if (item.mode !== 'followUp' || item.status === 'consumed') return item
      const next = reordered[cursor]
      cursor += 1
      return next
    })
    // Mirror the order onto the in-memory ledger queue; the DB order stays
    // run-id based, so a restart falls back to the original submission order.
    const byRun = new Map(this.queue.map((item) => [item.run.runId, item]))
    const ordered = reordered
      .map((item) => (item.runId === undefined ? undefined : byRun.get(item.runId)))
      .filter((item): item is QueuedRun => item !== undefined)
    const rest = this.queue.filter(
      (item) => !ordered.some((queued) => queued.run.runId === item.run.runId),
    )
    this.queue = [...ordered, ...rest]
    this.emit()
  }

  private clearQueueEntries(): void {
    if (this.queueItems.length === 0) return
    for (const item of this.queueItems) this.cancelledQueue.add(item.id)
    this.queueItems = []
    this.steering = []
    for (const timer of this.queueTimers.values()) clearTimeout(timer)
    this.queueTimers.clear()
    this.emit()
  }

  /** Close a not-yet-started ledger run and drop its withdrawn user row. */
  private async discardRun(conversationId: number, started: AgentRunStart): Promise<void> {
    if (started.message) {
      await this.deps.deleteMessage(conversationId, started.message.id).catch((error) => {
        console.error('删除撤回消息失败', error)
      })
    }
    await this.finishRunSafely(started.run.runId)
  }

  private finishRunSafely(runId: number): Promise<unknown> {
    return this.deps
      .finishRun(runId, 'cancelled', {
        partial: null,
        errorCode: 'cancelled',
        stepCount: 0,
        writeCount: 0,
        lastSeq: this.revision,
      })
      .catch((error) => {
        console.error('关闭排队运行失败', error)
      })
  }

  /** Read attachment bytes; a missing file fails the run with a readable error. */
  private async resolveAttachments(ids: number[]): Promise<ImageAttachment[]> {
    if (ids.length === 0) return []
    try {
      return await Promise.all(
        ids.map(async (id) => {
          const asset = await this.deps.loadAsset(id)
          return { data: asset.data, mimeType: asset.mime }
        }),
      )
    } catch {
      throw new Error('图片资产读取失败，请重新发送')
    }
  }

  private async runTurn(text: string, imageAssetIds: number[] = []): Promise<void> {
    const agent = this.agent
    if (!agent) return
    try {
      const images = await this.resolveAttachments(imageAssetIds)
      await agent.prompt({
        role: 'user',
        content: userContent(text, images),
        timestamp: Date.now(),
      } as AgentMessage)
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
    this.clearQueueEntries()
    await this.drainRunWrites()
    this.status = 'idle'
    this.emit()
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
    this.view = createView(projectHistory(kept))
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
   * Rewrite one user turn: drop it and every later message, rebuild the Agent
   * on the kept history, then run the edited prompt as a fresh turn.
   */
  async editMessage(
    messageKey: string,
    text: string,
    imageAssetIds: number[] = [],
  ): Promise<void> {
    const conversation = this.conversation
    const profile = this.profile
    const content = text.trim()
    if (!conversation || !profile || this.status !== 'idle') throw new Error('会话尚未就绪')
    if (content === '' && imageAssetIds.length === 0) return
    // Flush message writes before truncating so no late row lands after the edit.
    await this.drain()
    await this.drainRunWrites()

    const records = await this.deps.loadMessages(conversation.id)
    const match = /^m-(\d+)$/.exec(messageKey)
    const target = match
      ? records.findIndex((record) => record.id === Number(match[1]) && record.role === 'user')
      : -1
    if (target < 0) throw new Error('找不到要编辑的消息')

    await this.deps.truncateFrom(conversation.id, records[target].id)
    const kept = records.slice(0, target)

    await this.dispose()
    this.view = createView(projectHistory(kept))
    this.emit()
    await this.attachAgent(profile, kept)
    // prompt() creates the new run row and appends the edited user turn.
    await this.prompt({ text: content, imageAssetIds })
  }

  /**
   * Drop one user turn and everything after it without starting a new run.
   * Turn-level rollback restores files first, then calls this to clear history.
   */
  async rewindTo(messageKey: string): Promise<void> {
    const conversation = this.conversation
    const profile = this.profile
    if (!conversation || !profile || this.status !== 'idle') throw new Error('会话尚未就绪')
    await this.drain()
    await this.drainRunWrites()

    const records = await this.deps.loadMessages(conversation.id)
    const match = /^m-(\d+)$/.exec(messageKey)
    const target = match
      ? records.findIndex((record) => record.id === Number(match[1]) && record.role === 'user')
      : -1
    if (target < 0) throw new Error('找不到要撤回的消息')

    await this.deps.truncateFrom(conversation.id, records[target].id)
    const kept = records.slice(0, target)
    await this.dispose()
    // The banner belongs to the rows we just removed.
    this.interrupted = null
    this.view = createView(projectHistory(kept))
    this.emit()
    await this.attachAgent(profile, kept)
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

    this.teardownAgent()
    this.view = createView(projectHistory(records))
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

  /**
   * Copy the transcript up to `messageKey` into a new conversation. A user turn
   * forks right after itself; an assistant reply forks after its user turn.
   * `fallbackText` covers live items whose id is not a persisted row id yet.
   */
  async fork(messageKey: string, fallbackText = ''): Promise<ChatConversation> {
    const conversation = this.conversation
    if (!conversation) throw new Error('会话尚未就绪')
    const records = await this.deps.loadMessages(conversation.id)
    const match = /^m-(\d+)$/.exec(messageKey)
    let target = match ? records.findIndex((record) => record.id === Number(match[1])) : -1
    if (target < 0 && fallbackText.trim() !== '') {
      for (let i = records.length - 1; i >= 0; i -= 1) {
        if (records[i].content === fallbackText) {
          target = i
          break
        }
      }
    }
    let cutoff = records.length
    if (target >= 0) {
      const record = records[target]
      if (record.role === 'user') {
        cutoff = target + 1
      } else if (record.role === 'assistant') {
        let userIndex = target - 1
        while (userIndex >= 0 && records[userIndex].role !== 'user') userIndex -= 1
        cutoff = userIndex >= 0 ? userIndex + 1 : target + 1
      } else {
        cutoff = target + 1
      }
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
          thinkingDurationMs: record.thinkingDurationMs,
          toolArgs: record.toolArgs,
          toolDurationMs: record.toolDurationMs,
          isPartial: record.isPartial,
          stopReason: record.stopReason,
          imageAssetIds: record.imageAssetIds,
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
      conversation: this.conversation,
      status: this.status,
      queued: this.queue.length,
      items: this.view.items,
      queueItems: this.queueItems,
      stepCount: this.runSteps,
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
    // A steering row injected by pi is now rendered as a bubble: retire its
    // status-bar entry exactly when the transcript shows it.
    if (event.type === 'message_start' && event.message.role === 'user') {
      this.consumeRenderedSteer(userText(event.message))
    }
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
      // A steer that never reached a bubble expired with the run; surface it as
      // failed so the composer text can come back instead of staying ghosted.
      // Leftovers in pi's steering queue are dropped so they cannot leak into
      // the next run. A user-requested stop drops the whole queue instead.
      if (!cancelled) {
        const expired = this.queueItems.filter(
          (item) => item.mode === 'steer' && item.status === 'delivered',
        )
        if (expired.length > 0) {
          this.agent?.clearSteeringQueue()
          const ids = new Set(expired.map((item) => item.id))
          this.steering = this.steering.filter((item) => !ids.has(item.entryId))
          for (const item of expired) {
            this.failQueueEntry(item.id, '回复已结束，插话未生效')
          }
        }
      }
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

  /** A steering row surfaced in the transcript; the bar can now retire it. */
  private consumeRenderedSteer(text: string): void {
    const match = this.steering.find((item) => !item.consumed && item.text === text)
    if (!match) return
    match.consumed = true
    this.consumeQueueEntry(match.entryId)
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
            thinkingDurationMs: effect.thinkingMs ?? null,
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
    void this.enqueueWriteTracked(conversationId, messages)
  }

  /**
   * Same serialized chain, but the caller gets this batch's own settlement so
   * the composer can confirm (or roll back) the optimistic queue entry.
   */
  private enqueueWriteTracked(
    conversationId: number,
    messages: NewChatMessage[],
  ): Promise<void> {
    const write = this.writing.then(
      () => this.deps.append(conversationId, messages).then(() => undefined),
      () => this.deps.append(conversationId, messages).then(() => undefined),
    )
    this.writing = write.catch((error) => {
      console.error('保存 Agent 消息失败', error)
    })
    return write
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
    const conversationId = this.conversation?.id
    for (const item of queued) {
      // Withdraw the queued turn entirely: neither its run nor its user row
      // should survive a stop.
      if (conversationId && item.userMessage) {
        await this.deps.deleteMessage(conversationId, item.userMessage.id).catch((error) => {
          console.error('撤回排队消息失败', error)
        })
      }
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
    if (this.pumping || this.status !== 'idle' || !this.agent || this.queue.length === 0) return
    const next = this.queue[0]
    const text = next.userMessage?.content ?? ''
    const imageAssetIds = next.userMessage?.imageAssetIds ?? []
    if (text.trim() === '' && imageAssetIds.length === 0) {
      this.queue.shift()
      const empty = this.queueItems.find((item) => item.runId === next.run.runId)
      if (empty) this.dismissQueueEntry(empty.id)
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
      // The queued row becomes a bubble now; its status-bar item is retired in
      // the same frame so the two never coexist visually.
      this.addUserItem({ message: next.userMessage }, text, imageAssetIds)
      const entry = this.queueItems.find(
        (item) => item.runId === run.runId && item.status !== 'consumed',
      )
      if (entry) {
        this.updateQueueEntry(entry.id, { status: 'delivered' })
        this.consumeQueueEntry(entry.id)
      }
      this.emit()
      await this.runTurn(text, imageAssetIds)
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
    if (this.view.settled) return
    const generated = nextItemId(this.view, 'e')
    this.view = {
      ...generated.view,
      streamingId: null,
      thinkingStartedAt: null,
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
