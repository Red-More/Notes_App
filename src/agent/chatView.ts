//! Pure projection layer for the chat transcript.
//!
//! `projectHistory` turns persisted records into items; `reduceEvent` folds one
//! agent event into the same item list. The runtime owns scheduling, the page
//! only renders `view.items`.

import type { AgentEvent } from '@earendil-works/pi-agent-core'
import type { ChatMessageRecord, MessageUsage } from '../types'
import { classifyFailure, errorText, type ErrorCode } from './errors'
import { extractAssistant, parseImageAssetIds } from './runtime'

export interface Bubble {
  id: string
  kind: 'user' | 'assistant'
  text: string
  isError?: boolean
  /** A cancelled reply keeps its partial text but is not a failure. */
  cancelled?: boolean
  errorCode?: ErrorCode
  streaming?: boolean
  /** Token usage of a settled assistant reply. */
  usage?: MessageUsage | null
  /** Reasoning text streamed before the visible answer. */
  thinking?: string | null
  thinkingSignature?: string | null
  /** Data URLs of images attached to a user turn. */
  images?: string[]
  imageAssetIds?: number[]
  /** Paths touched by this reply, cached when the reply settles. */
  changes?: string[]
}

export interface ToolCard {
  id: string
  kind: 'tool'
  toolName: string
  args: string
  status: 'running' | 'done' | 'error'
  text: string
  /** Wall-clock duration, only available for calls made in this session. */
  durationMs?: number
}

export type Item = Bubble | ToolCard

export type ImageData = { mime: string; data: string }

interface StreamBuffer {
  id: string
  text: string
  thinking: string
  tools: Map<string, { name: string; args: unknown }>
}

export interface ChatView {
  items: Item[]
  streamingId: string | null
  /** The prompt persisted by `prompt()` already has a bubble. */
  pendingInitialUser: boolean
  settled: boolean
  /** A terminal synthetic message is closing out the current partial. */
  closeOut: boolean
  nextId: number
  buffer: StreamBuffer | null
  toolStartedAt: Map<string, number>
}

/** Persistence requested by the reducer; executed serially by the runtime. */
export type ViewEffect =
  | {
      kind: 'persist-assistant'
      text: string
      toolCalls: string | null
      isError: boolean
      usage: MessageUsage | null
      thinking: string | null
      thinkingSignature: string | null
      /** stop | aborted | error; persisted for the cancelled banner. */
      stopReason: string | null
      isPartial: boolean
    }
  | {
      kind: 'persist-tool'
      toolCallId: string
      toolName: string
      text: string
      isError: boolean
      args: string
      durationMs?: number
    }
  | { kind: 'persist-user'; text: string }

export interface ReduceResult {
  view: ChatView
  effects: ViewEffect[]
}

function toolResultText(result: unknown): string {
  const value = result as { content?: Array<{ text?: string }> } | null
  if (!value?.content) return ''
  return value.content.map((block) => block.text ?? '').join('\n')
}

/** Plain text of a user message (string or content blocks). */
function userText(message: { content?: unknown }): string {
  const content = message.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter((block): block is { type: 'text'; text: string } => block?.type === 'text')
      .map((block) => block.text)
      .join('\n')
  }
  return ''
}

/** Read the token usage of a settled assistant message (zeros mean "unreported"). */
function usageFromMessage(message: {
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number }
}): MessageUsage | null {
  const usage = message.usage
  if (usage.totalTokens <= 0) return null
  return {
    input: usage.input,
    output: usage.output,
    totalTokens: usage.totalTokens,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
  }
}

/** True when a message carries anything the transcript can render. */
function hasRenderableContent(message: { content?: unknown }): boolean {
  const content = message.content
  if (typeof content === 'string') return content.trim() !== ''
  if (!Array.isArray(content)) return false
  return content.some((block) => {
    if (!block || typeof block !== 'object') return false
    const type = (block as { type?: string }).type
    if (type === 'text') return ((block as { text?: string }).text ?? '').trim() !== ''
    if (type === 'thinking') return ((block as { thinking?: string }).thinking ?? '').trim() !== ''
    // toolCall blocks are real content even without visible text.
    return type === 'toolCall'
  })
}

/**
 * pi-agent closes a failed/cancelled run with a fresh empty assistant message.
 * Detecting that shape lets the runtime close out the partial instead of
 * opening a second bubble (P0-1).
 */
function isTerminalSynthetic(message: { content?: unknown; stopReason?: string }): boolean {
  if (message.stopReason !== 'aborted' && message.stopReason !== 'error') return false
  return !hasRenderableContent(message)
}

/** Find the document path touched by a tool card (args first, then result text). */
export function documentPath(card: ToolCard): string | null {
  try {
    const args = JSON.parse(card.args || '{}') as { path?: unknown }
    if (
      typeof args.path === 'string' &&
      args.path.startsWith('/life/') &&
      args.path.endsWith('.md')
    ) {
      return args.path
    }
  } catch {
    // Persisted cards have no args; fall back to the result text.
  }
  const match = card.text.match(/\/life\/[^\s，。；、"'<>（(）)]+\.md/)
  return match ? match[0] : null
}

/** Paths written by the tool turn that produced this assistant reply. */
export function turnChanges(items: Item[], assistantIndex: number): string[] {
  const paths: string[] = []
  for (let i = assistantIndex - 1; i >= 0; i -= 1) {
    const item = items[i]
    if (item.kind === 'user') break
    if (item.kind !== 'tool') continue
    if (item.status !== 'done') continue
    if (!['fs_write', 'fs_edit'].includes(item.toolName)) continue
    const path = documentPath(item)
    if (path && !paths.includes(path)) paths.unshift(path)
  }
  return paths
}

/** Insert or update a tool card without touching the rest of the transcript. */
function upsertToolCard(items: Item[], id: string, toolName: string, args: string): Item[] {
  if (!items.some((item) => item.id === id && item.kind === 'tool')) {
    return [...items, { id, kind: 'tool', toolName, args, status: 'running', text: '' }]
  }
  return items.map((item) =>
    item.id === id && item.kind === 'tool' ? { ...item, toolName, args } : item,
  )
}

/** Persisted records → items. Runs once per conversation load. */
export function projectHistory(
  records: ChatMessageRecord[],
  images: Map<number, ImageData>,
): Item[] {
  const items: Item[] = []
  for (const record of records) {
    if (record.role === 'user') {
      const ids = parseImageAssetIds(record.imageAssetIds)
      const dataUrls = ids
        .map((id) => images.get(id))
        .filter((image): image is ImageData => image !== undefined)
        .map((image) => `data:${image.mime};base64,${image.data}`)
      items.push({
        id: `m-${record.id}`,
        kind: 'user',
        text: record.content,
        images: dataUrls.length > 0 ? dataUrls : undefined,
        imageAssetIds: ids.length > 0 ? ids : undefined,
      })
    } else if (record.role === 'assistant') {
      if (record.content.trim() === '') continue
      items.push({
        id: `m-${record.id}`,
        kind: 'assistant',
        text: record.content,
        isError: record.isError,
        usage: record.usage,
        thinking: record.thinking,
        thinkingSignature: record.thinkingSignature,
        cancelled: record.stopReason === 'aborted' || record.isPartial,
      })
    } else {
      items.push({
        id: `m-${record.id}`,
        kind: 'tool',
        toolName: record.toolName ?? 'tool',
        args: record.toolArgs ?? '',
        status: record.isError ? 'error' : 'done',
        text: record.content,
        durationMs: record.toolDurationMs ?? undefined,
      })
    }
  }
  // Cache touched paths once per load; streaming renders only read them.
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]
    if (item.kind === 'assistant') item.changes = turnChanges(items, index)
  }
  return items
}

/** Character count of a run's JSON partial snapshot (`{text}`). */
export function partialLength(partial: string | null): number {
  if (!partial) return 0
  try {
    const value = JSON.parse(partial) as { text?: unknown }
    return typeof value.text === 'string' ? value.text.length : 0
  } catch {
    return 0
  }
}

/** Reference projection: records + events → items. Used by tests and tools. */
export function project(input: {
  records: ChatMessageRecord[]
  images: Map<number, ImageData>
  events: AgentEvent[]
  pendingInitialUser?: boolean
}): Item[] {
  let view = createView(projectHistory(input.records, input.images))
  if (input.pendingInitialUser) view = beginPrompt(view)
  for (const event of input.events) {
    view = flushBuffer(reduceEvent(view, event).view)
  }
  return flushBuffer(view).items
}

export function createView(items: Item[]): ChatView {
  return {
    items,
    streamingId: null,
    pendingInitialUser: false,
    settled: true,
    closeOut: false,
    nextId: 1,
    buffer: null,
    toolStartedAt: new Map(),
  }
}

/** Marks the prompt the runtime persisted itself; its message_start is skipped. */
export function beginPrompt(view: ChatView): ChatView {
  return { ...view, pendingInitialUser: true, settled: false, closeOut: false }
}

export function nextItemId(view: ChatView, prefix: 'u' | 'a' | 'e'): { view: ChatView; id: string } {
  const id = `${prefix}-${view.nextId}`
  return { view: { ...view, nextId: view.nextId + 1 }, id }
}

function bufferFor(view: ChatView, id: string, delta?: { text?: string; thinking?: string }): ChatView {
  const previous: StreamBuffer = view.buffer ?? { id, text: '', thinking: '', tools: new Map() }
  const buffer: StreamBuffer =
    previous.id === id
      ? {
          id,
          text: previous.text + (delta?.text ?? ''),
          thinking: previous.thinking + (delta?.thinking ?? ''),
          tools: previous.tools,
        }
      : { id, text: delta?.text ?? '', thinking: delta?.thinking ?? '', tools: new Map() }
  return { ...view, buffer }
}

/** Apply buffered deltas to items once per frame instead of once per token. */
export function flushBuffer(view: ChatView): ChatView {
  const buffer = view.buffer
  if (!buffer) return view
  let items = view.items
  if (buffer.text !== '' || buffer.thinking !== '') {
    items = items.map((item) => {
      if (item.id !== buffer.id || item.kind !== 'assistant') return item
      const next: Bubble = { ...item }
      if (buffer.text !== '') next.text = item.text + buffer.text
      if (buffer.thinking !== '') next.thinking = (item.thinking ?? '') + buffer.thinking
      return next
    })
  }
  for (const [callId, tool] of buffer.tools) {
    items = upsertToolCard(items, callId, tool.name, JSON.stringify(tool.args ?? {}))
  }
  return { ...view, items, buffer: null }
}

/** Fold one agent event into the view. Persistence is returned as effects. */
export function reduceEvent(
  view: ChatView,
  event: AgentEvent,
  now: () => number = () => performance.now(),
): ReduceResult {
  const effects: ViewEffect[] = []

  switch (event.type) {
    case 'message_start': {
      if (event.message.role === 'user') {
        if (view.pendingInitialUser) return { view, effects }
        const text = userText(event.message)
        if (text.trim() === '') return { view, effects }
        const generated = nextItemId(view, 'u')
        return {
          view: {
            ...generated.view,
            items: [...generated.view.items, { id: generated.id, kind: 'user', text }],
          },
          effects,
        }
      }
      if (event.message.role !== 'assistant') return { view, effects }
      if (isTerminalSynthetic(event.message) && view.streamingId) {
        // Close-out for the in-flight partial: no second bubble.
        return { view: { ...view, closeOut: true }, effects }
      }
      const generated = nextItemId(view, 'a')
      return {
        view: {
          ...generated.view,
          streamingId: generated.id,
          closeOut: false,
          buffer: null,
          items: [...generated.view.items, { id: generated.id, kind: 'assistant', text: '', streaming: true }],
        },
        effects,
      }
    }

    case 'message_update': {
      const update = event.assistantMessageEvent
      const id = view.streamingId
      if (!id) return { view, effects }
      if (update.type === 'text_delta') {
        return { view: bufferFor(view, id, { text: update.delta }), effects }
      }
      if (update.type === 'thinking_delta') {
        return { view: bufferFor(view, id, { thinking: update.delta }), effects }
      }
      if (update.type === 'thinking_end') {
        const flushed = flushBuffer(view)
        const block = update.partial.content[update.contentIndex]
        const signature = block?.type === 'thinking' ? (block.thinkingSignature ?? null) : null
        return {
          view: {
            ...flushed,
            items: flushed.items.map((item) =>
              item.id === id && item.kind === 'assistant' && item.thinking
                ? { ...item, thinkingSignature: signature }
                : item,
            ),
          },
          effects,
        }
      }
      if (
        update.type === 'toolcall_start' ||
        update.type === 'toolcall_delta' ||
        update.type === 'toolcall_end'
      ) {
        const block = update.partial.content[update.contentIndex]
        if (block?.type !== 'toolCall') return { view, effects }
        if (update.type === 'toolcall_end') {
          // The end event carries authoritative arguments; it overwrites any
          // buffered frame through `upsertToolCard` below.
          const flushed = flushBuffer(view)
          return {
            view: {
              ...flushed,
              items: upsertToolCard(flushed.items, block.id, block.name, JSON.stringify(block.arguments ?? {})),
            },
            effects,
          }
        }
        const buffered: StreamBuffer = view.buffer ?? { id, text: '', thinking: '', tools: new Map() }
        const tools = new Map(buffered.tools)
        tools.set(block.id, { name: block.name, args: block.arguments ?? {} })
        return { view: { ...view, buffer: { ...buffered, id, tools } }, effects }
      }
      return { view, effects }
    }

    case 'message_end': {
      if (event.message.role === 'user') {
        if (view.pendingInitialUser) {
          return { view: { ...view, pendingInitialUser: false }, effects }
        }
        const text = userText(event.message)
        if (text.trim() === '') return { view, effects }
        effects.push({ kind: 'persist-user', text })
        return { view, effects }
      }
      if (event.message.role !== 'assistant') return { view, effects }

      const message = event.message
      const id = view.streamingId
      const flushed = flushBuffer(view)
      const current = id
        ? flushed.items.find((item): item is Bubble => item.id === id && item.kind === 'assistant')
        : undefined
      const { text, toolCalls, thinking, thinkingSignature } = extractAssistant(message)
      const failed = message.stopReason === 'error' || message.stopReason === 'aborted'
      const info = failed ? classifyFailure(message) : null
      const usage = failed ? null : usageFromMessage(message)
      const authoritative = text.trim() !== '' ? text : (current?.text ?? '')
      const shown = failed ? (authoritative.trim() !== '' ? authoritative : errorText(info!)) : text

      if (!failed && shown.trim() === '' && toolCalls === null) {
        return {
          view: {
            ...flushed,
            items: id ? flushed.items.filter((item) => item.id !== id) : flushed.items,
            streamingId: null,
            settled: true,
            closeOut: false,
            pendingInitialUser: false,
          },
          effects,
        }
      }

      let items = flushed.items
      if (id) {
        const index = items.findIndex((item) => item.id === id && item.kind === 'assistant')
        if (index >= 0) {
          const changes = turnChanges(items, index)
          const settled: Bubble = {
            ...(items[index] as Bubble),
            text: shown,
            streaming: false,
            isError: failed,
            cancelled: message.stopReason === 'aborted',
            errorCode: info?.code,
            usage,
            thinking: thinking ?? current?.thinking ?? null,
            thinkingSignature: failed ? null : thinkingSignature,
            changes,
          }
          items = items.map((item, i) => (i === index ? settled : item))
        }
      }

      effects.push({
        kind: 'persist-assistant',
        text: shown,
        toolCalls: failed ? null : toolCalls,
        isError: failed,
        usage,
        thinking: thinking ?? null,
        thinkingSignature: failed ? null : thinkingSignature,
        stopReason: message.stopReason ?? null,
        isPartial: message.stopReason === 'aborted',
      })
      return {
        view: {
          ...flushed,
          items,
          streamingId: null,
          settled: true,
          closeOut: false,
          pendingInitialUser: false,
        },
        effects,
      }
    }

    case 'tool_execution_start': {
      const startedAt = new Map(view.toolStartedAt)
      startedAt.set(event.toolCallId, now())
      const args = JSON.stringify(event.args ?? {})
      return {
        view: {
          ...view,
          toolStartedAt: startedAt,
          items: upsertToolCard(view.items, event.toolCallId, event.toolName, args).map((item) =>
            item.id === event.toolCallId && item.kind === 'tool' ? { ...item, status: 'running' } : item,
          ),
        },
        effects,
      }
    }

    case 'tool_execution_end': {
      const text = toolResultText(event.result)
      const card = view.items.find(
        (item): item is ToolCard => item.id === event.toolCallId && item.kind === 'tool',
      )
      const started = view.toolStartedAt.get(event.toolCallId)
      const startedAt = new Map(view.toolStartedAt)
      startedAt.delete(event.toolCallId)
      const durationMs = started === undefined ? undefined : now() - started
      effects.push({
        kind: 'persist-tool',
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        text,
        isError: event.isError,
        args: card?.args ?? '',
        durationMs,
      })
      return {
        view: {
          ...view,
          toolStartedAt: startedAt,
          items: view.items.map((item) =>
            item.id === event.toolCallId && item.kind === 'tool'
              ? { ...item, status: event.isError ? 'error' : 'done', text, durationMs }
              : item,
          ),
        },
        effects,
      }
    }

    case 'agent_end': {
      // Safety net: never leave a bubble stuck in streaming state (P0-1).
      const items = view.streamingId
        ? view.items.map((item) =>
            item.id === view.streamingId && item.kind === 'assistant'
              ? { ...item, streaming: false }
              : item,
          )
        : view.items
      return {
        view: {
          ...view,
          items,
          streamingId: null,
          closeOut: false,
          settled: true,
          pendingInitialUser: false,
          buffer: null,
          toolStartedAt: new Map(),
        },
        effects,
      }
    }

    default:
      return { view, effects }
  }
}
