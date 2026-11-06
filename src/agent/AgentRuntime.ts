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
  ChatConversation,
  ChatMessageRecord,
  McpToolInfo,
  NewChatMessage,
  SkillSummary,
} from '../types'
import { buildSkillsIndex } from './skills'
import { createAgent, toAgentMessages, type AgentProfile } from './runtime'
import { classifyError, classifyFailure, errorText, type ErrorInfo } from './errors'
import {
  beginPrompt,
  createView,
  flushBuffer,
  nextItemId,
  projectHistory,
  reduceEvent,
  type Bubble,
  type ChatView,
  type ImageData,
  type Item,
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
}

export interface RuntimeSnapshot {
  conversationId: number | null
  status: RuntimeStatus
  queued: number
  items: Item[]
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

export class AgentRuntime {
  private readonly deps: AgentRuntimeDeps
  private readonly streamFn?: StreamFn
  private readonly schedule: (flush: () => void) => void

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
  private listeners = new Set<(snapshot: RuntimeSnapshot) => void>()

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
    this.status = 'idle'
    this.lastError = null
    this.view = createView([])

    const records = await this.deps.loadMessages(conversation.id)
    this.images = await this.deps.loadImages(records).catch(() => new Map())
    this.view = createView(projectHistory(records, this.images))

    if (profile) {
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
    )
  }

  // ---------------------------------------------------------------- running

  async prompt(input: PromptInput): Promise<void> {
    const agent = this.agent
    const conversation = this.conversation
    if (!agent || !conversation) throw new Error('会话尚未就绪')
    if (this.status !== 'idle') throw new Error('上一条回复尚未结束')

    const text = input.text.trim()
    if (text === '' && input.attachments.length === 0) return
    const imageIds = input.attachments.map((file) => file.assetId)
    const dataUrls = input.attachments.map((file) => file.dataUrl)

    this.lastError = null
    this.status = 'running'
    this.view = beginPrompt(this.view)
    const generated = nextItemId(this.view, 'u')
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
    this.emit()

    this.enqueueWrite(conversation.id, [
      {
        role: 'user',
        content: text,
        imageAssetIds: imageIds.length > 0 ? JSON.stringify(imageIds) : null,
      },
    ])

    const images: ImageContent[] = input.attachments.map((file) => ({
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
      // Event callbacks may already have settled the run; TS cannot see that.
      if ((this.status as RuntimeStatus) !== 'idle') {
        this.status = 'idle'
        this.emit()
      }
    }
  }

  /** Inject guidance at the next turn boundary. */
  steer(text: string): void {
    const message = text.trim()
    if (!message || !this.agent) return
    this.agent.steer({ role: 'user', content: message, timestamp: Date.now() } as AgentMessage)
    this.emit()
  }

  /** Queue a message that starts after the current run finishes. */
  followUp(text: string): void {
    const message = text.trim()
    if (!message || !this.agent) return
    this.agent.followUp({ role: 'user', content: message, timestamp: Date.now() } as AgentMessage)
    this.emit()
  }

  /**
   * Stop the run and wait for the close-out to be persisted (P0-1/P0-2).
   * The partial answer stays in the transcript instead of being dropped.
   */
  async cancel(): Promise<void> {
    const agent = this.agent
    if (!agent || this.status === 'idle') return
    this.status = 'cancelling'
    // Drop queued guidance so stopping really stops the run.
    agent.clearAllQueues()
    agent.abort()
    await agent.waitForIdle()
    await this.drain()
    this.status = 'idle'
    this.emit()
  }

  /** Truncate to the user turn behind `messageKey` and continue from there. */
  async retry(messageKey: string): Promise<void> {
    const conversation = this.conversation
    const profile = this.profile
    if (!conversation || !profile || this.status !== 'idle') throw new Error('会话尚未就绪')

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
      // Event callbacks may already have settled the run; TS cannot see that.
      if ((this.status as RuntimeStatus) !== 'idle') {
        this.status = 'idle'
        this.emit()
      }
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
      return
    }
    if (this.status !== 'idle') {
      this.status = 'cancelling'
      agent.clearAllQueues()
      agent.abort()
      await agent.waitForIdle()
    }
    await this.drain()
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
      queued: this.queuedCount(),
      items: this.view.items,
      error: this.lastError,
      revision: this.revision,
    }
  }

  private queuedCount(): number {
    try {
      return this.agent?.peekQueuedMessages().length ?? 0
    } catch {
      return 0
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
      this.status = 'idle'
      this.lastError = this.pickError()
      this.emit()
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
    if (event.type === 'tool_execution_end') {
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
          },
        ])
        return
      }
      case 'persist-user': {
        this.enqueueWrite(conversationId, [{ role: 'user', content: effect.text }])
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

  /** A run that throws before any terminal event still leaves a visible bubble. */
  private handleThrown(error: unknown): void {
    const info = classifyError(error)
    this.lastError = info.code === 'cancelled' ? null : info
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
        { role: 'assistant', content: errorText(info), isError: true },
      ])
    }
    this.emit()
  }
}
