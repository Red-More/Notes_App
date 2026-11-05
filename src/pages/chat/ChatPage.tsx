//! 对话页：pi-agent 事件的流式渲染 + 工具卡片 + 会话管理。
//!
//! 渲染策略（D9）：流式阶段纯文本；`message_end` 后也只展示纯文本，
//! 不使用 `dangerouslySetInnerHTML`，模型输出不经过任何 HTML 解析。

import { useCallback, useEffect, useRef, useState } from 'react'
import { api, chatApi, mcpApi, mediaApi, skillApi } from '../../api'
import { createAgent, extractAssistant, parseImageAssetIds, profileFromSettings, toAgentMessages } from '../../agent/runtime'
import type { AgentProfile } from '../../agent/runtime'
import { buildSkillsIndex } from '../../agent/skills'
import type { AgentEvent } from '@earendil-works/pi-agent-core'
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type { AgentSettings, ChatConversation, ChatMessageRecord, MessageUsage, SkillSummary } from '../../types'
import { friendlyError, normalizeImage } from '../../utils'
import type { ImageContent } from '@earendil-works/pi-ai'
import { open as openDialog } from '@tauri-apps/plugin-dialog'
import { readFile } from '@tauri-apps/plugin-fs'
import { toast } from '../../toast'
import { Modal } from '../../components/ui'
import PageHeader from '../../components/PageHeader'
import EmptyState from '../../components/EmptyState'
import {
  IconChat,
  IconEdit,
  IconEye,
  IconImage,
  IconInfo,
  IconNote,
  IconPlus,
  IconSearch,
  IconSend,
  IconStop,
  IconTrash,
  IconUsers,
} from '../../components/Icons'
import DiffViewerModal from '../../components/DiffViewerModal'

interface Props {
  isActive: boolean
}

interface Bubble {
  id: string
  kind: 'user' | 'assistant'
  text: string
  isError?: boolean
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

/** One image staged in the composer. */
interface Attachment {
  assetId: number
  mime: string
  data: string
  dataUrl: string
}

interface ToolCard {
  id: string
  kind: 'tool'
  toolName: string
  args: string
  status: 'running' | 'done' | 'error'
  text: string
  /** Wall-clock duration, only available for calls made in this session. */
  durationMs?: number
}

type Item = Bubble | ToolCard

interface DocPreview {
  path: string
  html: string
}

function messageKey(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`
}

/** Best-effort MIME for a picked file; normalizeImage re-encodes to JPEG anyway. */
function imageMime(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  if (ext === 'png') return 'image/png'
  if (ext === 'webp') return 'image/webp'
  if (ext === 'gif') return 'image/gif'
  return 'image/jpeg'
}

const MAX_ATTACHMENTS = 4
const MAX_INPUT_IMAGE_BYTES = 20 * 1024 * 1024

type ImageData = { mime: string; data: string }

/** Load attached image bytes for one conversation; failures drop that image. */
async function loadImageData(records: ChatMessageRecord[]): Promise<Map<number, ImageData>> {
  const ids = new Set<number>()
  for (const record of records) {
    if (record.role !== 'user') continue
    for (const id of parseImageAssetIds(record.imageAssetIds)) ids.add(id)
  }
  const pairs = await Promise.all(
    [...ids].slice(0, 16).map(async (id) => {
      try {
        return [id, await mediaApi.assetData(id)] as const
      } catch {
        return null
      }
    }),
  )
  return new Map(pairs.filter((pair): pair is readonly [number, ImageData] => pair !== null))
}

function recordsToItems(
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
      })
    } else {
      items.push({
        id: `m-${record.id}`,
        kind: 'tool',
        toolName: record.toolName ?? 'tool',
        args: '',
        status: record.isError ? 'error' : 'done',
        text: record.content,
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

/** Insert or update a tool card without touching the rest of the transcript. */
function upsertToolCard(items: Item[], id: string, toolName: string, args: string): Item[] {
  if (!items.some((item) => item.id === id && item.kind === 'tool')) {
    return [...items, { id, kind: 'tool', toolName, args, status: 'running', text: '' }]
  }
  return items.map((item) =>
    item.id === id && item.kind === 'tool' ? { ...item, toolName, args } : item,
  )
}

function toolResultText(result: unknown): string {
  const value = result as { content?: Array<{ text?: string }> } | null
  if (!value?.content) return ''
  return value.content.map((block) => block.text ?? '').join('\n')
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

/** Remove the YAML frontmatter so previews match what the editor renders. */
function stripFrontmatter(text: string): string {
  const normalized = text.replace(/\r\n/g, '\n')
  if (!normalized.startsWith('---\n')) return text
  const close = normalized.indexOf('\n---', 4)
  if (close < 0) return text
  const start = normalized.indexOf('\n', close + 4)
  return start < 0 ? '' : normalized.slice(start + 1)
}

/** Find the document path touched by a tool card (args first, then result text). */
function documentPath(card: ToolCard): string | null {
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

const NETWORK_ERROR = /timeout|超时|timed out|network|网络|fetch|conn/i

/** True when the error text looks like connectivity loss rather than a server reply. */
function networkFailure(detail: string): boolean {
  return NETWORK_ERROR.test(detail)
}

/** Paths changed by the tools between the previous user turn and this reply. */
function turnChanges(items: Item[], assistantIndex: number): string[] {
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

/** Human-readable failure text that distinguishes offline from other errors. */
function failureText(error: unknown, online: boolean): string {
  if (!online) return '当前处于离线模式，消息未发送；联网后点「重试」。'
  const detail = friendlyError(error)
  if (networkFailure(detail)) {
    return `网络异常：${detail}`
  }
  return `发送失败：${detail}`
}

const TOOL_META: Record<
  string,
  { label: string; tone: string; Icon: typeof IconNote }
> = {
  fs_read: { label: '读取', tone: 'read', Icon: IconEye },
  fs_write: { label: '写入', tone: 'write', Icon: IconNote },
  fs_edit: { label: '编辑', tone: 'edit', Icon: IconEdit },
  fs_glob: { label: '查找', tone: 'search', Icon: IconSearch },
  fs_grep: { label: '搜索', tone: 'search', Icon: IconSearch },
  load_skill: { label: '技能', tone: 'skill', Icon: IconInfo },
  think: { label: '思考', tone: 'think', Icon: IconInfo },
  subagent: { label: '子智能体', tone: 'agent', Icon: IconUsers },
}

function formatDuration(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`
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

function formatTokens(tokens: number): string {
  return tokens < 1000 ? String(tokens) : `${(tokens / 1000).toFixed(1)}k`
}

/** USD cost from prices stored as "per million tokens". */
function usageCost(usage: MessageUsage, model: { inputPrice?: number; outputPrice?: number } | null) {
  if (!model || model.inputPrice === undefined || model.outputPrice === undefined) return null
  const billedInput = usage.input + usage.cacheRead + usage.cacheWrite
  return (billedInput * model.inputPrice + usage.output * model.outputPrice) / 1_000_000
}

interface ToolCardViewProps {
  card: ToolCard
  expanded: boolean
  onToggle: (id: string) => void
  onOpen: (path: string) => void
  onUndo: (path: string) => void
}

/** One Agent trace node: semantic icon, summary header and collapsible detail. */
function ToolCardView({ card, expanded, onToggle, onOpen, onUndo }: ToolCardViewProps) {
  const path = documentPath(card)
  const meta = TOOL_META[card.toolName] ?? {
    label: card.toolName,
    tone: 'other',
    Icon: IconInfo,
  }
  const Icon = meta.Icon
  const canUndo =
    card.status === 'done' && path !== null && ['fs_write', 'fs_edit'].includes(card.toolName)
  const collapsible = card.args.length > 120 || card.text.length > 200
  const state = card.status === 'running' ? '执行中…' : card.status === 'error' ? '失败' : '完成'
  return (
    <div className={`chat-trace-node ${meta.tone} ${card.status}`}>
      <div className={`chat-trace-icon ${meta.tone}`}>
        <Icon size={14} />
      </div>
      <div className="chat-trace-main">
        <div className="chat-trace-head">
          <span className="chat-trace-label">{meta.label}</span>
          {card.durationMs !== undefined && (
            <span className="chat-trace-duration">{formatDuration(card.durationMs)}</span>
          )}
          <span className="chat-trace-state">{state}</span>
          {collapsible && (
            <button
              type="button"
              className="chat-trace-toggle"
              aria-expanded={expanded}
              onClick={() => onToggle(card.id)}
            >
              {expanded ? '收起' : '展开'}
            </button>
          )}
        </div>
        {(path || card.text) && (
          <div className="chat-trace-summary">
            {path ? (
              <button type="button" className="chat-file-link" onClick={() => onOpen(path)}>
                {path}
              </button>
            ) : (
              <span className="chat-trace-preview">{card.text.split('\n')[0]}</span>
            )}
          </div>
        )}
        {expanded && (
          <div className="chat-trace-detail">
            {card.args && card.args !== '{}' && (
              <div className="chat-tool-args">{card.args}</div>
            )}
            {card.text && <div className="chat-tool-result">{card.text}</div>}
          </div>
        )}
        {canUndo && path && (
          <div className="chat-tool-actions">
            <button type="button" className="chat-tool-action" onClick={() => onUndo(path)}>
              撤销
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

/** Merge persisted per-model capabilities into the pi profile. */
async function withCapabilities(profile: AgentProfile): Promise<AgentProfile> {
  try {
    const params = await chatApi.paramsGet(profile.provider)
    return {
      ...profile,
      contextWindow: params.contextWindowInput,
      maxTokens: params.contextWindowOutput ?? params.maxTokens,
      supportsImages: params.supportsImages ?? false,
      reasoning: params.thinkingMode === 'on',
      toolRounds: params.toolRounds,
    }
  } catch {
    // Capability hints are optional; a read failure must not block chat.
    return profile
  }
}

export default function ChatPage({ isActive }: Props) {
  const [settings, setSettings] = useState<AgentSettings | null>(null)
  // settings 的最新镜像：激活刷新 effect 只依赖 isActive，用 ref 读当前值，避免写回新对象触发依赖循环。
  const settingsRef = useRef<AgentSettings | null>(null)
  const [conversations, setConversations] = useState<ChatConversation[]>([])
  const [conversation, setConversation] = useState<ChatConversation | null>(null)
  const [items, setItems] = useState<Item[]>([])
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [renameId, setRenameId] = useState<number | null>(null)
  const [renameText, setRenameText] = useState('')
  const [loading, setLoading] = useState(true)
  const [expandedTools, setExpandedTools] = useState<Set<string>>(new Set())
  const [expandedThinking, setExpandedThinking] = useState<Set<string>>(new Set())
  const [attachments, setAttachments] = useState<Attachment[]>([])
  // While a run is active, the composer enqueues instead of prompting.
  const [queueMode, setQueueMode] = useState<'steer' | 'followUp'>('steer')
  const [queuedCount, setQueuedCount] = useState(0)
  const [docPreview, setDocPreview] = useState<DocPreview | null>(null)
  const [online, setOnline] = useState(() => navigator.onLine)
  // Set after a network-looking failure; WebView's online flag is unreliable.
  const [networkIssue, setNetworkIssue] = useState(false)
  const [contextWindow, setContextWindow] = useState(0)
  const [scrollBottomVisible, setScrollBottomVisible] = useState(false)
  const [diffView, setDiffView] = useState<{ paths: string[]; title: string } | null>(null)
  // Maps an item id to its row so a timeline dot can scroll it into view.
  const rowRefs = useRef(new Map<string, HTMLDivElement>())

  const agentRef = useRef<ReturnType<typeof createAgent> | null>(null)
  const unsubscribeRef = useRef<(() => void) | null>(null)
  const conversationRef = useRef<ChatConversation | null>(null)
  const skillsRef = useRef<SkillSummary[]>([])
  // Mirror of `online` for event handlers that must not rebuild the agent.
  const onlineRef = useRef(navigator.onLine)
  // True once `message_end` rendered this turn, so `send` must not duplicate it.
  const settledRef = useRef(true)
  const streamingIdRef = useRef<string | null>(null)
  // True until the first user event pair of a freshly submitted prompt is consumed,
  // so its already-persisted bubble is not duplicated.
  const pendingInitialUserRef = useRef(false)
  // Tool start timestamps for the trace duration badge.
  const toolStartRef = useRef(new Map<string, number>())
  const scrollRef = useRef<HTMLDivElement>(null)
  const bootRef = useRef(false)
  // 落库串行化：assistant 消息必须先于其 toolResult 写入，否则历史无法还原。
  const persistQueueRef = useRef<Promise<unknown>>(Promise.resolve())
  // Coalesced streaming state: text, reasoning, and tool-argument deltas
  // accumulate here and are applied once per animation frame instead of
  // re-rendering the list for every token. Tool arguments stay raw in the
  // buffer and are stringified a single time when the frame is flushed.
  const streamDeltaRef = useRef<{
    id: string
    text: string
    thinking: string
    tools: Map<string, { name: string; args: unknown }>
  } | null>(null)
  const streamFrameRef = useRef<number | null>(null)
  // Scroll writes from deltas ride along with the same frame's list update.
  const streamScrollRef = useRef(false)

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [])

  /** Buffer for the given assistant message, reset when another message starts. */
  const streamBufferFor = useCallback((id: string) => {
    const pending = streamDeltaRef.current
    if (pending && pending.id === id) return pending
    const fresh = {
      id,
      text: '',
      thinking: '',
      tools: new Map<string, { name: string; args: unknown }>(),
    }
    streamDeltaRef.current = fresh
    return fresh
  }, [])

  /** Apply all pending deltas and the scroll position in a single batched update. */
  const flushStreamFrame = useCallback(() => {
    streamFrameRef.current = null
    const pending = streamDeltaRef.current
    streamDeltaRef.current = null
    if (pending) {
      // Stringify each tool's final argument snapshot once per frame, not per delta.
      const toolArgs = new Map<string, { toolName: string; args: string }>()
      for (const [id, tool] of pending.tools) {
        toolArgs.set(id, { toolName: tool.name, args: JSON.stringify(tool.args ?? {}) })
      }
      setItems((prev) => {
        let next = prev
        if (pending.text || pending.thinking) {
          next = next.map((item) =>
            item.id === pending.id && item.kind === 'assistant'
              ? {
                  ...item,
                  text: pending.text ? item.text + pending.text : item.text,
                  thinking: pending.thinking
                    ? (item.thinking ?? '') + pending.thinking
                    : item.thinking,
                }
              : item,
          )
        }
        for (const [id, patch] of toolArgs) {
          next = upsertToolCard(next, id, patch.toolName, patch.args)
        }
        return next
      })
    }
    if (streamScrollRef.current) {
      streamScrollRef.current = false
      const el = scrollRef.current
      if (el) el.scrollTop = el.scrollHeight
    }
  }, [])

  /** Schedule one flush; further deltas in the same frame only extend the buffer. */
  const scheduleStreamFlush = useCallback(() => {
    if (streamFrameRef.current !== null) return
    streamFrameRef.current = requestAnimationFrame(flushStreamFrame)
  }, [flushStreamFrame])

  /** Drop buffered deltas; a queued frame must not touch state after teardown. */
  const cancelStreamFrame = useCallback(() => {
    if (streamFrameRef.current !== null) {
      cancelAnimationFrame(streamFrameRef.current)
      streamFrameRef.current = null
    }
    streamDeltaRef.current = null
    streamScrollRef.current = false
  }, [])

  const handleScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    setScrollBottomVisible(el.scrollHeight - el.scrollTop - el.clientHeight > 90)
  }, [])

  // Surface offline mode immediately and clear it when the network returns.
  useEffect(() => {
    const goOnline = () => {
      onlineRef.current = true
      setOnline(true)
      setNetworkIssue(false)
    }
    const goOffline = () => {
      onlineRef.current = false
      setOnline(false)
    }
    window.addEventListener('online', goOnline)
    window.addEventListener('offline', goOffline)
    return () => {
      window.removeEventListener('online', goOnline)
      window.removeEventListener('offline', goOffline)
    }
  }, [])

  const enqueuePersist = useCallback(<T,>(task: () => Promise<T>): Promise<T> => {
    const next = persistQueueRef.current.then(task)
    persistQueueRef.current = next.catch((e) => {
      console.error('保存 Agent 消息失败', e)
    })
    return next
  }, [])

  const persistAssistant = useCallback(
    (
      text: string,
      toolCalls: string | null,
      isError = false,
      usage: MessageUsage | null = null,
      thinking: string | null = null,
      thinkingSignature: string | null = null,
    ) => {
      const convId = conversationRef.current?.id
      if (!convId) return
      if (text.trim() === '' && toolCalls === null) return
      void enqueuePersist(() =>
        chatApi.append({
          conversationId: convId,
          messages: [
            { role: 'assistant', content: text, toolCalls, isError, usage, thinking, thinkingSignature },
          ],
        }),
      )
    },
    [enqueuePersist],
  )

  const persistTool = useCallback(
    (toolCallId: string, toolName: string, text: string, isError: boolean) => {
      const convId = conversationRef.current?.id
      if (!convId) return
      void enqueuePersist(() =>
        chatApi.append({
          conversationId: convId,
          messages: [{ role: 'tool', content: text, toolCallId, toolName, isError }],
        }),
      )
    },
    [enqueuePersist],
  )

  const handleEvent = useCallback(
    (event: AgentEvent) => {
      switch (event.type) {
        case 'message_start': {
          if (event.message.role === 'user') {
            // The initial prompt already has a bubble; queued messages appear here.
            if (pendingInitialUserRef.current) return
            const text = userText(event.message)
            if (text.trim() === '') return
            setItems((prev) => [...prev, { id: messageKey('u'), kind: 'user', text }])
            scrollToBottom()
            return
          }
          if (event.message.role !== 'assistant') return
          const id = messageKey('a')
          streamingIdRef.current = id
          setItems((prev) => [...prev, { id, kind: 'assistant', text: '', streaming: true }])
          scrollToBottom()
          break
        }
        case 'message_update': {
          const update = event.assistantMessageEvent
          if (update.type === 'text_delta') {
            const id = streamingIdRef.current
            if (!id) return
            streamBufferFor(id).text += update.delta
            streamScrollRef.current = true
            scheduleStreamFlush()
            return
          }
          // Reasoning streams before the visible answer; keep it collapsible.
          if (
            update.type === 'thinking_start' ||
            update.type === 'thinking_delta' ||
            update.type === 'thinking_end'
          ) {
            const id = streamingIdRef.current
            if (!id) return
            if (update.type === 'thinking_delta') {
              // Reasoning deltas share the text frame buffer to avoid one
              // re-render per token.
              streamBufferFor(id).thinking += update.delta
              streamScrollRef.current = true
              scheduleStreamFlush()
            } else if (update.type === 'thinking_end') {
              const block = update.partial.content[update.contentIndex]
              const signature = block?.type === 'thinking' ? (block.thinkingSignature ?? null) : null
              // Apply buffered reasoning first: a single-frame reasoning block
              // would otherwise miss the `item.thinking` check below.
              flushStreamFrame()
              setItems((prev) =>
                prev.map((item) =>
                  item.id === id && item.kind === 'assistant' && item.thinking
                    ? { ...item, thinkingSignature: signature }
                    : item,
                ),
              )
            }
            scrollToBottom()
            return
          }
          // Stream tool arguments ahead of execution so the card shows real params.
          if (
            update.type === 'toolcall_start' ||
            update.type === 'toolcall_delta' ||
            update.type === 'toolcall_end'
          ) {
            const block = update.partial.content[update.contentIndex]
            if (block?.type !== 'toolCall') return
            const id = streamingIdRef.current
            if (!id || update.type === 'toolcall_end') {
              // `toolcall_end` carries the authoritative arguments: apply it
              // now and drop any buffered arguments for this call.
              const pending = streamDeltaRef.current
              if (pending && pending.id === id) pending.tools.delete(block.id)
              const args = JSON.stringify(block.arguments ?? {})
              setItems((prev) => upsertToolCard(prev, block.id, block.name, args))
              scrollToBottom()
              return
            }
            // Keep raw arguments in the buffer; stringify once per frame.
            streamBufferFor(id).tools.set(block.id, { name: block.name, args: block.arguments ?? {} })
            streamScrollRef.current = true
            scheduleStreamFlush()
          }
          break
        }
        case 'message_end': {
          if (event.message.role === 'user') {
            if (pendingInitialUserRef.current) {
              // This pair belongs to the prompt persisted in submitPrompt.
              pendingInitialUserRef.current = false
              return
            }
            // Queued steer/follow-up messages are persisted when injected.
            const text = userText(event.message)
            const convId = conversationRef.current?.id
            if (text.trim() === '' || !convId) return
            void enqueuePersist(() =>
              chatApi.append({
                conversationId: convId,
                messages: [{ role: 'user', content: text }],
              }),
            )
            return
          }
          if (event.message.role !== 'assistant') return
          const message = event.message
          const id = streamingIdRef.current
          const { text, toolCalls, thinking, thinkingSignature } = extractAssistant(message)
          const failed = message.stopReason === 'error' || message.stopReason === 'aborted'
          const usage = failed ? null : usageFromMessage(message)
          const shown = failed
            ? message.stopReason === 'aborted'
              ? '已取消'
              : `${onlineRef.current ? '' : '当前处于离线模式，'}回答失败：${message.errorMessage ?? '未知错误'}`
            : text
          // The final message is authoritative: drop queued deltas so a late
          // frame cannot append already-settled text to this bubble.
          cancelStreamFrame()
          setItems((prev) => {
            if (shown.trim() === '') return prev.filter((item) => item.id !== id)
            const next = prev.map((item) =>
              item.id === id && item.kind === 'assistant'
                ? {
                    ...item,
                    text: shown,
                    streaming: false,
                    isError: failed,
                    usage,
                    thinking: thinking ?? item.thinking ?? null,
                    thinkingSignature: thinkingSignature ?? item.thinkingSignature ?? null,
                  }
                : item,
            )
            // Settled replies never change again: cache touched paths once here
            // instead of rescanning the transcript on every streaming frame.
            const index = next.findIndex((item) => item.id === id && item.kind === 'assistant')
            const settled = index >= 0 ? next[index] : null
            if (!settled || settled.kind !== 'assistant') return next
            const changes = turnChanges(next, index)
            return next.map((item, i) => (i === index ? { ...settled, changes } : item))
          })
          streamingIdRef.current = null
          settledRef.current = true
          if (failed) setNetworkIssue(networkFailure(message.errorMessage ?? ''))
          else setNetworkIssue(false)
          // Failure/cancel bubbles are persisted too, so reloads keep the last state.
          persistAssistant(
            failed ? shown : text,
            failed ? null : toolCalls,
            failed,
            usage,
            thinking,
            failed ? null : thinkingSignature,
          )
          scrollToBottom()
          break
        }
        case 'tool_execution_start': {
          toolStartRef.current.set(event.toolCallId, performance.now())
          const args = JSON.stringify(event.args ?? {})
          setItems((prev) => {
            // The streaming `toolcall_*` events already inserted this card.
            const exists = prev.some((item) => item.id === event.toolCallId && item.kind === 'tool')
            if (exists) {
              return prev.map((item) =>
                item.id === event.toolCallId && item.kind === 'tool'
                  ? { ...item, toolName: event.toolName, args, status: 'running' }
                  : item,
              )
            }
            return [
              ...prev,
              {
                id: event.toolCallId,
                kind: 'tool',
                toolName: event.toolName,
                args,
                status: 'running',
                text: '',
              },
            ]
          })
          scrollToBottom()
          break
        }
        case 'tool_execution_end': {
          const text = toolResultText(event.result)
          const started = toolStartRef.current.get(event.toolCallId)
          toolStartRef.current.delete(event.toolCallId)
          const durationMs = started === undefined ? undefined : performance.now() - started
          setItems((prev) =>
            prev.map((item) =>
              item.id === event.toolCallId && item.kind === 'tool'
                ? { ...item, status: event.isError ? 'error' : 'done', text, durationMs }
                : item,
            ),
          )
          persistTool(event.toolCallId, event.toolName, text, event.isError)
          scrollToBottom()
          break
        }
        case 'agent_end': {
          cancelStreamFrame()
          setStreaming(false)
          setQueuedCount(0)
          pendingInitialUserRef.current = false
          break
        }
        default:
          break
      }
    },
    [
      enqueuePersist,
      persistAssistant,
      persistTool,
      scrollToBottom,
      cancelStreamFrame,
      scheduleStreamFlush,
      streamBufferFor,
      flushStreamFrame,
    ],
  )

  const disposeAgent = useCallback(() => {
    agentRef.current?.abort()
    unsubscribeRef.current?.()
    unsubscribeRef.current = null
    agentRef.current = null
    // 中断旧流后立即复位发送状态：abort 产生的 agent_end 会因退订而丢失，不能再依赖它。
    streamingIdRef.current = null
    pendingInitialUserRef.current = false
    // Pending frames must not call setState after the transcript was replaced.
    cancelStreamFrame()
    setStreaming(false)
  }, [cancelStreamFrame])

  /** Build an Agent for the given transcript; returns null when no model is usable. */
  const buildAgent = useCallback(
    async (
      conv: ChatConversation,
      records: ChatMessageRecord[],
      imageData: Map<number, ImageData>,
    ) => {
      const current = settingsRef.current
      const baseProfile = current
        ? profileFromSettings(current, conv.provider, conv.model)
        : null
      if (!baseProfile) return null
      const activeProfile = await withCapabilities(baseProfile)
      // MCP discovery is optional; a failure must not block chat.
      const mcpTools = await mcpApi.tools().catch(() => [])
      const agent = createAgent(
        activeProfile,
        await toAgentMessages(records, activeProfile, imageData),
        buildSkillsIndex(skillsRef.current),
        skillsRef.current,
        mcpTools,
        `conv_${conv.id}`,
      )
      return { agent, profile: activeProfile }
    },
    [],
  )

  const openConversation = useCallback(
    async (conv: ChatConversation) => {
      disposeAgent()
      conversationRef.current = conv
      setConversation(conv)
      setLoading(true)
      try {
        const records = await chatApi.messages(conv.id)
        const imageData = await loadImageData(records)
        setItems(recordsToItems(records, imageData))
        // 优先使用会话记录里的模型条目；该条目被删除后回退到当前激活模型。
        const built = await buildAgent(conv, records, imageData)
        if (!built) {
          // 没有可用模型时仍可查看历史，只是不能发送。
          return
        }
        setContextWindow(built.profile.contextWindow ?? 128000)
        unsubscribeRef.current = built.agent.subscribe((event) => {
          handleEvent(event)
        })
        agentRef.current = built.agent
      } catch (e) {
        toast(friendlyError(e))
      } finally {
        setLoading(false)
        scrollToBottom()
        setScrollBottomVisible(false)
      }
    },
    [buildAgent, disposeAgent, handleEvent, scrollToBottom],
  )

  const bootstrap = useCallback(async () => {
    try {
      const [nextSettings, list, skills] = await Promise.all([
        chatApi.settings(),
        chatApi.list(),
        skillApi.list(),
      ])
      setSettings(nextSettings)
      settingsRef.current = nextSettings
      skillsRef.current = skills
      setConversations(list)
      let target = list[0]
      if (!target) {
        if (!nextSettings.activeId) {
          setLoading(false)
          return
        }
        target = await chatApi.create()
        setConversations([target])
      }
      await openConversation(target)
    } catch (e) {
      toast(friendlyError(e))
      setLoading(false)
    }
  }, [openConversation])

  useEffect(() => {
    if (bootRef.current) return
    bootRef.current = true
    void bootstrap()
  }, [bootstrap])

  // 页面被编辑器/文件夹浮层替换时会卸载：中断当前流并退订。
  useEffect(() => () => disposeAgent(), [disposeAgent])

  // 页面激活时刷新配置；模型变化则重建 Agent（历史保持）。
  // 只依赖 isActive：effect 内写回 settings 的新对象不会再触发自身，避免无限 IPC 循环。
  // openConversation 内部读 settingsRef，本身不随 settings 对象变化，可安全加入依赖。
  useEffect(() => {
    if (!isActive || !bootRef.current) return
    let disposed = false
    void (async () => {
      try {
        const [next, skills] = await Promise.all([chatApi.settings(), skillApi.list()])
        if (disposed) return
        setSettings(next)
        settingsRef.current = next
        skillsRef.current = skills
        // Rebuild on every activation so per-model capability edits are applied.
        const conv = conversationRef.current
        if (!conv) return
        if (!next.activeId && next.models.length === 0) {
          disposeAgent()
          return
        }
        await openConversation(conv)
      } catch (e) {
        console.error('刷新 Agent 配置失败', e)
      }
    })()
    return () => {
      disposed = true
    }
  }, [disposeAgent, isActive, openConversation])

  const ensureTitle = useCallback(async (text: string) => {
    const conv = conversationRef.current
    if (!conv || conv.title !== '新对话') return
    const title = text.slice(0, 20)
    try {
      await chatApi.rename({ id: conv.id, title })
      const updated = { ...conv, title }
      conversationRef.current = updated
      setConversation(updated)
      setConversations((prev) => prev.map((c) => (c.id === conv.id ? updated : c)))
    } catch (e) {
      console.error('会话改名失败', e)
    }
  }, [])

  const submitPrompt = useCallback(
    async (text: string, files: Attachment[] = []) => {
      if ((!text && files.length === 0) || streaming) return
      const agent = agentRef.current
      const conv = conversationRef.current
      if (!agent || !conv) {
        toast('会话尚未就绪')
        return
      }
      settledRef.current = false
      setInput('')
      setItems((prev) => [
        ...prev,
        {
          id: messageKey('u'),
          kind: 'user',
          text,
          images: files.length > 0 ? files.map((file) => file.dataUrl) : undefined,
          imageAssetIds: files.length > 0 ? files.map((file) => file.assetId) : undefined,
        },
      ])
      setAttachments([])
      setStreaming(true)
      scrollToBottom()
      void ensureTitle(text || '图片')
      try {
        await enqueuePersist(() =>
          chatApi.append({
            conversationId: conv.id,
            messages: [
              {
                role: 'user',
                content: text,
                imageAssetIds:
                  files.length > 0 ? JSON.stringify(files.map((file) => file.assetId)) : null,
              },
            ],
          }),
        )
        // 技能正文由模型通过 load_skill 主动加载；用户消息不携带技能内容。
        const promptText = text || '请描述这些图片。'
        const images: ImageContent[] = files.map((file) => ({
          type: 'image',
          data: file.data,
          mimeType: file.mime,
        }))
        // The prompt's own user events must not duplicate this bubble.
        pendingInitialUserRef.current = true
        if (images.length > 0) await agent.prompt(promptText, images)
        else await agent.prompt(text)
      } catch (e) {
        pendingInitialUserRef.current = false
        const shown = failureText(e, onlineRef.current)
        if (!onlineRef.current || networkFailure(friendlyError(e))) setNetworkIssue(true)
        // Only add a bubble when the stream never reached `message_end`,
        // which already renders and persists its own failure state.
        if (!settledRef.current) {
          const id = messageKey('e')
          streamingIdRef.current = null
          settledRef.current = true
          setItems((prev) => [...prev, { id, kind: 'assistant', text: shown, isError: true }])
          persistAssistant(shown, null, true)
        }
        // Keep the typed draft so the user can retry without retyping.
        setInput((prev) => prev || text)
        setStreaming(false)
      }
    },
    [enqueuePersist, ensureTitle, persistAssistant, scrollToBottom, streaming],
  )

  const send = useCallback(() => {
    void submitPrompt(input.trim(), attachments)
  }, [attachments, input, submitPrompt])

  /** Enqueue guidance while a run is active; the agent injects it at the next boundary. */
  const queueMessage = useCallback(() => {
    const text = input.trim()
    const agent = agentRef.current
    if (!streaming || text === '' || !agent) return
    const message = { role: 'user', content: text, timestamp: Date.now() } as AgentMessage
    if (queueMode === 'steer') agent.steer(message)
    else agent.followUp(message)
    setInput('')
    setQueuedCount(agent.peekQueuedMessages().length)
    toast(queueMode === 'steer' ? '已追加，当前回复结束后生效' : '已排队，本轮结束后执行')
  }, [input, queueMode, streaming])

  /**
   * Regenerate the reply to the user turn that produced `messageId`:
   * later messages are removed from both DB and UI, then `continue()` reuses
   * the kept user turn instead of inserting a duplicate prompt.
   */
  const retry = useCallback(
    async (messageId: string) => {
      const conv = conversationRef.current
      if (!conv || streaming) return
      try {
        const records = await chatApi.messages(conv.id)
        const match = /^m-(\d+)$/.exec(messageId)
        let targetIndex = match
          ? records.findIndex((record) => record.id === Number(match[1]))
          : -1
        if (targetIndex < 0) {
          // The bubble came from a failed in-session run; target the last reply.
          targetIndex = records.map((record) => record.role).lastIndexOf('assistant')
        }
        if (targetIndex < 0) {
          toast('没有可重试的回答')
          return
        }
        let userIndex = -1
        for (let i = targetIndex - 1; i >= 0; i -= 1) {
          if (records[i].role === 'user') {
            userIndex = i
            break
          }
        }
        if (userIndex < 0) {
          toast('找不到上一条用户消息，无法重试')
          return
        }
        const kept = records.slice(0, userIndex + 1)
        await chatApi.truncate({ conversationId: conv.id, messageId: kept[userIndex].id })
        const imageData = await loadImageData(kept)
        setItems((prev) => {
          const clicked = prev.findIndex((item) => item.id === messageId)
          const end = clicked >= 0 ? clicked : prev.length
          for (let i = end - 1; i >= 0; i -= 1) {
            if (prev[i].kind === 'user') return prev.slice(0, i + 1)
          }
          return prev
        })
        disposeAgent()
        const built = await buildAgent(conv, kept, imageData)
        if (!built) {
          toast('请先在设置中启用对话模型')
          return
        }
        setContextWindow(built.profile.contextWindow ?? 128000)
        unsubscribeRef.current = built.agent.subscribe((event) => handleEvent(event))
        agentRef.current = built.agent
        settledRef.current = false
        pendingInitialUserRef.current = false
        setStreaming(true)
        scrollToBottom()
        try {
          await built.agent.continue()
        } finally {
          setStreaming(false)
        }
      } catch (e) {
        setStreaming(false)
        toast(friendlyError(e))
      }
    },
    [buildAgent, disposeAgent, handleEvent, scrollToBottom, streaming],
  )

  const toggleTool = useCallback((id: string) => {
    setExpandedTools((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const toggleThinking = useCallback((id: string) => {
    setExpandedThinking((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const openDocPreview = useCallback(async (path: string) => {
    setDocPreview({ path, html: '' })
    try {
      const result = await api.fsRead({ path, includeMeta: true })
      if (result.kind !== 'file') throw new Error('该路径不是文件')
      const { renderMarkdownPreview } = await import('../../editor/markdown')
      setDocPreview({
        path,
        html: renderMarkdownPreview(stripFrontmatter(result.content)),
      })
    } catch (error) {
      setDocPreview(null)
      toast(friendlyError(error))
    }
  }, [])

  const undoWrite = useCallback(async (path: string) => {
    try {
      await api.restorePreviousDocRevision(path)
      toast('已撤销上一次修改')
    } catch (error) {
      toast(friendlyError(error))
    }
  }, [])

  const copyReply = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      toast('已复制')
    } catch {
      toast('复制失败，请长按选择文本')
    }
  }, [])

  const jumpToItem = useCallback((id: string) => {
    rowRefs.current.get(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [])

  /** Fork the conversation up to the user turn that produced this reply. */
  const forkConversation = useCallback(
    async (assistantText: string) => {
      const conv = conversationRef.current
      if (!conv) return
      try {
        const records = await chatApi.messages(conv.id)
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
        const created = await chatApi.create({
          title: `${conv.title} · 分支`.slice(0, 80),
        })
        if (cutoff > 0) {
          await chatApi.append({
            conversationId: created.id,
            messages: records.slice(0, cutoff).map((record) => ({
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
          })
        }
        setConversations((prev) => [created, ...prev])
        await openConversation(created)
        toast('已创建对话分支')
      } catch (error) {
        toast(friendlyError(error))
      }
    },
    [openConversation],
  )

  const stop = useCallback(() => {
    const agent = agentRef.current
    if (!agent) return
    // Drop queued guidance so stopping really stops the run.
    agent.clearAllQueues()
    setQueuedCount(0)
    agent.abort()
    void agent.waitForIdle().then(() => setStreaming(false))
  }, [])

  const newConversation = useCallback(async () => {
    if (!settings?.activeId) {
      toast('请先在设置 → AI 助理中添加并启用一个对话模型')
      return
    }
    try {
      const created = await chatApi.create()
      setConversations((prev) => [created, ...prev])
      setDrawerOpen(false)
      await openConversation(created)
    } catch (e) {
      toast(friendlyError(e))
    }
  }, [openConversation, settings])

  const removeConversation = useCallback(
    async (id: number) => {
      try {
        await chatApi.remove(id)
        const rest = conversations.filter((c) => c.id !== id)
        setConversations(rest)
        if (conversationRef.current?.id === id) {
          if (rest[0]) await openConversation(rest[0])
          else {
            disposeAgent()
            setItems([])
            setConversation(null)
            await newConversation()
          }
        }
      } catch (e) {
        toast(friendlyError(e))
      }
    },
    [conversations, disposeAgent, newConversation, openConversation],
  )

  const saveRename = useCallback(async () => {
    if (renameId === null) return
    const title = renameText.trim()
    if (!title) {
      setRenameId(null)
      return
    }
    try {
      await chatApi.rename({ id: renameId, title })
      setConversations((prev) => prev.map((c) => (c.id === renameId ? { ...c, title } : c)))
      if (conversationRef.current?.id === renameId) {
        const updated = { ...conversationRef.current, title }
        conversationRef.current = updated
        setConversation(updated)
      }
    } catch (e) {
      toast(friendlyError(e))
    } finally {
      setRenameId(null)
    }
  }, [renameId, renameText])

  const activeModel = settings?.models.find((item) => item.id === settings.activeId) ?? null
  const modelLabel = activeModel
    ? `${activeModel.label} · ${activeModel.modelId}`
    : '未添加模型'
  const hasModel = settings?.activeId != null

  const pickImages = useCallback(async () => {
    if (!activeModel?.supportsImages) {
      toast('当前模型未开启图片输入，请在设置 → AI 助理中启用')
      return
    }
    try {
      const picked = await openDialog({
        multiple: true,
        filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }],
      })
      const paths = typeof picked === 'string' ? [picked] : Array.isArray(picked) ? picked : []
      if (paths.length === 0) return
      let next = attachments
      for (const path of paths) {
        if (next.length >= MAX_ATTACHMENTS) {
          toast(`一次最多附带 ${MAX_ATTACHMENTS} 张图片`)
          break
        }
        const bytes = await readFile(path)
        if (bytes.length > MAX_INPUT_IMAGE_BYTES) {
          toast('图片超过 20MB，请先压缩')
          continue
        }
        const normalized = await normalizeImage(bytes, imageMime(path))
        if (!normalized.data) {
          toast('图片处理失败')
          continue
        }
        // Assets are deduplicated by content hash, so re-picking is free.
        const asset = await mediaApi.storeAsset({ mime: normalized.mime, data: normalized.data })
        next = [
          ...next,
          {
            assetId: asset.id,
            mime: normalized.mime,
            data: normalized.data,
            dataUrl: normalized.dataUrl,
          },
        ]
      }
      setAttachments(next)
    } catch (e) {
      toast(friendlyError(e))
    }
  }, [activeModel, attachments])

  const removeAttachment = useCallback((assetId: number) => {
    setAttachments((prev) => prev.filter((file) => file.assetId !== assetId))
  }, [])

  // Rough token estimate (CJK ~1 char/token, ASCII ~3 chars/token).
  const contextChars = items.reduce(
    (sum, item) => sum + item.text.length + (item.kind === 'tool' ? item.args.length : 0),
    0,
  )
  const contextPercent =
    contextWindow > 0
      ? Math.min(100, Math.round(((contextChars / 3) * 100) / contextWindow))
      : 0

  return (
    <div className="page chat-page">
      <PageHeader
        title="对话"
        actions={[
          { icon: <IconChat size={22} />, label: '会话列表', onClick: () => setDrawerOpen(true) },
          {
            icon: <IconPlus size={22} />,
            label: '新建对话',
            onClick: () => void newConversation(),
          },
        ]}
      />

      <div className={`chat-status ${online && !networkIssue ? '' : 'offline'}`}>
        {online && !networkIssue
          ? modelLabel
          : `${modelLabel} · ${online ? '网络异常' : '离线模式'}，消息可能发送失败`}
      </div>

      <div className="page-scroll chat-scroll" ref={scrollRef} onScroll={handleScroll}>
        {loading ? (
          <div className="list-loading">加载中…</div>
        ) : items.length === 0 ? (
          <EmptyState
            icon={<IconChat size={44} />}
            text={
              hasModel
                ? '说一句话就能记事：试试“记下今天吃了拉面”'
                : '请先在设置 → AI 助理中添加并启用一个模型'
            }
          />
        ) : (
          items.map((item) => {
            // Settled replies carry their touched paths computed at settle time.
            const changes = item.kind === 'assistant' && !item.streaming ? item.changes ?? [] : []
            const usage = item.kind === 'assistant' ? item.usage : null
            const cost = usage ? usageCost(usage, activeModel) : null
            return (
              <div
                key={item.id}
                className={`chat-row ${item.kind}`}
                ref={(node) => {
                  if (node) rowRefs.current.set(item.id, node)
                  else rowRefs.current.delete(item.id)
                }}
              >
                <div className="chat-rail">
                  {item.kind === 'user' && (
                    <button
                      type="button"
                      className="chat-anchor"
                      aria-label="定位到这条消息"
                      onClick={() => jumpToItem(item.id)}
                    />
                  )}
                </div>
                <div className="chat-row-body">
                  {item.kind === 'tool' ? (
                    <ToolCardView
                      card={item}
                      expanded={expandedTools.has(item.id)}
                      onToggle={toggleTool}
                      onOpen={(path) => void openDocPreview(path)}
                      onUndo={(path) => void undoWrite(path)}
                    />
                  ) : (
                    <>
                      {item.kind === 'assistant' && item.thinking && (
                        <div className="chat-thinking">
                          <button
                            type="button"
                            className="chat-thinking-toggle"
                            aria-expanded={expandedThinking.has(item.id)}
                            onClick={() => toggleThinking(item.id)}
                          >
                            {expandedThinking.has(item.id) ? '收起思考' : '思考'}
                          </button>
                          {expandedThinking.has(item.id) && (
                            <div className="chat-thinking-body">{item.thinking}</div>
                          )}
                        </div>
                      )}
                      {item.kind === 'user' && item.images && item.images.length > 0 && (
                        <div className="chat-bubble-images">
                          {item.images.map((src, imageIndex) => (
                            <img key={imageIndex} src={src} alt="附图" />
                          ))}
                        </div>
                      )}
                      {(!item.images || item.images.length === 0 || item.text) && (
                        <div
                          className={`chat-bubble ${item.kind} ${item.isError ? 'error' : ''}`}
                        >
                          {item.text || (item.streaming ? '…' : '')}
                        </div>
                      )}
                      {item.kind === 'assistant' && !item.streaming && (
                        <div className="chat-actions">
                          <button
                            type="button"
                            className="chat-action"
                            onClick={() => void copyReply(item.text)}
                          >
                            复制
                          </button>
                          <button
                            type="button"
                            className="chat-action"
                            onClick={() => void retry(item.id)}
                          >
                            重试
                          </button>
                          <button
                            type="button"
                            className="chat-action"
                            onClick={() => void forkConversation(item.text)}
                          >
                            分支
                          </button>
                          <button
                            type="button"
                            className="chat-action"
                            disabled={changes.length === 0}
                            onClick={() =>
                              setDiffView({
                                paths: changes,
                                title: item.text.slice(0, 40) || '本次变更',
                              })
                            }
                          >
                            变更{changes.length > 0 ? ` ${changes.length}` : ''}
                          </button>
                          {usage && (
                            <span
                              className="chat-usage"
                              title={`输入 ${usage.input} · 输出 ${usage.output} · 缓存读 ${usage.cacheRead}`}
                            >
                              {formatTokens(usage.input)}↑ {formatTokens(usage.output)}↓
                              {cost !== null && ` · $${cost.toFixed(4)}`}
                            </span>
                          )}
                          <span
                            className="chat-context-ring"
                            style={{
                              background: `conic-gradient(var(--accent) ${contextPercent}%, var(--border) 0)`,
                            }}
                            title={`上下文占用约 ${contextPercent}%`}
                          >
                            <span>{contextPercent}%</span>
                          </span>
                        </div>
                      )}
                    </>
                  )}
                </div>
              </div>
            )
          })
        )}
      </div>

      {scrollBottomVisible && (
        <button
          type="button"
          className="chat-scroll-bottom"
          aria-label="回到底部"
          onClick={scrollToBottom}
        >
          ↓
        </button>
      )}

      <div className="chat-composer">
        {attachments.length > 0 && (
          <div className="chat-attachments">
            {attachments.map((file) => (
              <div className="chat-attachment" key={file.assetId}>
                <img src={file.dataUrl} alt="待发送图片" />
                <button
                  type="button"
                  className="chat-attachment-remove"
                  aria-label="移除图片"
                  onClick={() => removeAttachment(file.assetId)}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="chat-composer-row">
          <textarea
            className="chat-input"
            value={input}
            rows={1}
            placeholder={hasModel ? '说点什么…' : '请先添加模型'}
            disabled={!hasModel}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                if (streaming) void queueMessage()
                else void send()
              }
            }}
          />
          {streaming && (
            <button
              type="button"
              className="chat-queue-mode"
              title="切换追加方式：追加立即注入，排队在本轮结束后执行"
              onClick={() => setQueueMode((prev) => (prev === 'steer' ? 'followUp' : 'steer'))}
            >
              {queueMode === 'steer' ? '追加' : '排队'}
              {queuedCount > 0 ? ` ${queuedCount}` : ''}
            </button>
          )}
          <button
            type="button"
            className="chat-attach"
            aria-label="添加图片"
            disabled={!hasModel || streaming}
            onClick={() => void pickImages()}
          >
            <IconImage size={20} />
          </button>
          {streaming ? (
            <>
              <button
                type="button"
                className="chat-send"
                aria-label={queueMode === 'steer' ? '追加指令' : '排队指令'}
                disabled={input.trim() === ''}
                onClick={() => void queueMessage()}
              >
                <IconSend size={20} />
              </button>
              <button type="button" className="chat-send stop" aria-label="停止" onClick={stop}>
                <IconStop size={20} />
              </button>
            </>
          ) : (
            <button
              type="button"
              className="chat-send"
              aria-label="发送"
              disabled={(input.trim() === '' && attachments.length === 0) || !hasModel}
              onClick={() => void send()}
            >
              <IconSend size={20} />
            </button>
          )}
        </div>
      </div>

      {docPreview && (
        <Modal
          title={docPreview.path}
          onClose={() => setDocPreview(null)}
          footer={
            <button type="button" className="btn btn-primary" onClick={() => setDocPreview(null)}>
              关闭
            </button>
          }
        >
          {docPreview.html ? (
            <div
              className="md-preview skill-preview-body"
              // Local document rendered with the same sanitized renderer as notes.
              dangerouslySetInnerHTML={{ __html: docPreview.html }}
            />
          ) : (
            <p className="settings-note">加载中…</p>
          )}
        </Modal>
      )}

      {diffView && (
        <DiffViewerModal
          paths={diffView.paths}
          title={diffView.title}
          onClose={() => setDiffView(null)}
        />
      )}

      {drawerOpen && (
        <Modal
          title="会话"
          onClose={() => setDrawerOpen(false)}
          footer={
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void newConversation()}
            >
              新建对话
            </button>
          }
        >
          <div className="chat-conv-list">
            {conversations.length === 0 && <p className="settings-note">还没有会话</p>}
            {conversations.map((conv) => (
              <div
                key={conv.id}
                className={`chat-conv-row ${conversation?.id === conv.id ? 'active' : ''}`}
              >
                {renameId === conv.id ? (
                  <input
                    className="form-input"
                    value={renameText}
                    autoFocus
                    onChange={(e) => setRenameText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void saveRename()
                      if (e.key === 'Escape') setRenameId(null)
                    }}
                    onBlur={() => void saveRename()}
                  />
                ) : (
                  <button
                    type="button"
                    className="chat-conv-main"
                    onClick={() => {
                      setDrawerOpen(false)
                      void openConversation(conv)
                    }}
                  >
                    <span className="chat-conv-title">{conv.title}</span>
                    <span className="chat-conv-meta">
                      {conv.messageCount} 条 · {conv.model}
                    </span>
                  </button>
                )}
                <button
                  type="button"
                  className="icon-btn"
                  aria-label="重命名"
                  onClick={() => {
                    setRenameId(conv.id)
                    setRenameText(conv.title)
                  }}
                >
                  <IconEdit size={17} />
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  aria-label="删除会话"
                  onClick={() => void removeConversation(conv.id)}
                >
                  <IconTrash size={17} />
                </button>
              </div>
            ))}
          </div>
        </Modal>
      )}
    </div>
  )
}
