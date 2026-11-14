//! 对话页：pi-agent 事件的流式渲染 + 工具卡片 + 会话管理。
//!
//! 渲染策略（D9）：流式阶段纯文本；`message_end` 后也只展示纯文本，
//! 不使用 `dangerouslySetInnerHTML`，模型输出不经过任何 HTML 解析。

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { api, assetApi, chatApi } from '../../api'
import { assetDataUrl } from '../../assets'
import { clearDraft, loadDraft, saveDraft } from '../../chatDraft'
import type { AgentProfile } from '../../agent/runtime'
import { profileFromSettings } from '../../agent/runtime'
import { AgentRuntime } from '../../agent/AgentRuntime'
import type { QueueEntry, QueueEntryMode } from '../../agent/AgentRuntime'
import { createRuntimeDeps } from '../../agent/runtimeDeps'
import {
  documentPath,
  partialLength,
  turnToolIds,
  type Bubble,
  type Item,
  type ToolCard,
} from '../../agent/chatView'
import type {
  AgentModelInfo,
  AgentRun,
  AgentSettings,
  ChatConversation,
  MessageUsage,
} from '../../types'
import { friendlyError, bytesToBase64 } from '../../utils'
import { toast } from '../../toast'
import { ActionSheet, Modal } from '../../components/ui'
import PageHeader from '../../components/PageHeader'
import EmptyState from '../../components/EmptyState'
import {
  IconBranch,
  IconChat,
  IconCollapse,
  IconCopy,
  IconEdit,
  IconExpand,
  IconEye,
  IconInfo,
  IconNote,
  IconPaperclip,
  IconPlus,
  IconRefresh,
  IconSearch,
  IconSend,
  IconSettings,
  IconStop,
  IconTrace,
  IconTrash,
} from '../../components/Icons'
import MessageActions from './MessageActions'
import QueueStatusBar from './QueueStatusBar'

interface Props {
  isActive: boolean
  onOpenSettings: () => void
}


interface DocPreview {
  path: string
  html: string
}

/** One user turn listed in the index popover. */
interface TurnPoint {
  id: string
  label: string
}

/**
 * Minimap geometry: dots keep a constant gap and the rail length is derived
 * from the dot count (pad * 2 + (n - 1) * gap) instead of being stretched.
 */
const RAIL_DOT_GAP = 9
const RAIL_PAD = 10
const RAIL_MIN_DOTS = 4
const RAIL_MAX_DOTS = 24
/** A turn becomes current once its bubble reaches this line below the top. */
const RAIL_ACTIVE_OFFSET = 28
/** Space kept above a bubble when the index list jumps to it. */
const NAV_JUMP_OFFSET = 12

/** Dot count follows the turns, clamped to [MIN, MAX] but never above turns. */
function navDotCount(total: number): number {
  if (total === 0) return 0
  return Math.min(total, Math.max(RAIL_MIN_DOTS, Math.min(RAIL_MAX_DOTS, total)))
}

/** Even thinning above MAX; the first and last turn are always kept. */
function sampleTurnIndices(total: number): number[] {
  const count = navDotCount(total)
  if (count >= total) return Array.from({ length: total }, (_, index) => index)
  const indices = new Set<number>([0, total - 1])
  for (let dot = 1; dot < count - 1; dot += 1) {
    indices.add(Math.round((dot * (total - 1)) / (count - 1)))
  }
  return [...indices].sort((a, b) => a - b)
}

/** Composer attachment: asset id, preview URL and byte size for the total check. */
interface Attachment {
  id: number
  url: string
  size: number
}

/** Mirrors the backend limits so oversize input fails with a readable message. */
const MAX_CHAT_IMAGES = 8
const MAX_CHAT_IMAGE_BYTES = 32 * 1024 * 1024
const MAX_CHAT_TOTAL_BYTES = 40 * 1024 * 1024

/**
 * 发送模式：`steer` 由 pi 在本批工具全部返回后、下一轮请求前注入（临时改道）；
 * `followUp` 等整个 Agent 循环结束，再由运行时开一条新 run（接续下一件事）。
 */
const QUEUE_MODE_KEY = 'notes:chat-queue-mode'
const QUEUE_GUIDE_KEY = 'notes:chat-queue-guide'
const QUEUE_MODES: Array<{ mode: QueueEntryMode; label: string; note: string }> = [
  { mode: 'steer', label: '插话（steer）', note: '本批工具结束后、下一轮请求前生效' },
  { mode: 'followUp', label: '排队（followUp）', note: '本轮彻底结束后再开始新一轮' },
]

/** Default steer; the last choice is remembered locally. */
function readQueueMode(): QueueEntryMode {
  try {
    return localStorage.getItem(QUEUE_MODE_KEY) === 'followUp' ? 'followUp' : 'steer'
  } catch {
    return 'steer'
  }
}

function vibrate(ms = 8): void {
  try {
    if (typeof navigator.vibrate === 'function') navigator.vibrate(ms)
  } catch {
    // Haptics are best effort.
  }
}

/** User attachment strip; a stale asset shows a visible placeholder. */
function BubbleImages({ ids }: { ids: number[] }) {
  const [urls, setUrls] = useState<Array<string | null | undefined>>([])
  useEffect(() => {
    let alive = true
    void Promise.all(ids.map((id) => assetDataUrl(id))).then((list) => {
      if (alive) setUrls(list)
    })
    return () => {
      alive = false
    }
  }, [ids])
  return (
    <div className="chat-bubble-images">
      {ids.map((id, index) => {
        const url = urls[index]
        if (url === undefined) return <span key={id} className="chat-bubble-image-loading" />
        if (url === null) {
          return (
            <span key={id} className="asset-missing">
              图片缺失
            </span>
          )
        }
        return <img key={id} src={url} alt={`用户图片 ${index + 1}`} />
      })}
    </div>
  )
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

/** Tone/icon hints only; the descriptor itself stays the English identifier. */
const TOOL_META: Record<
  string,
  { label: string; tone: string; Icon: typeof IconNote }
> = {
  fs_read: { label: 'fs_read', tone: 'read', Icon: IconEye },
  fs_write: { label: 'fs_write', tone: 'write', Icon: IconNote },
  fs_edit: { label: 'fs_edit', tone: 'edit', Icon: IconEdit },
  fs_glob: { label: 'fs_glob', tone: 'search', Icon: IconSearch },
  fs_grep: { label: 'fs_grep', tone: 'search', Icon: IconSearch },
  load_skill: { label: 'load_skill', tone: 'skill', Icon: IconInfo },
}

function formatDuration(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`
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
  /** 1-based position in this transcript's invocation chain. */
  step: number
  expanded: boolean
  onToggle: (id: string) => void
  onOpen: (path: string) => void
  onUndo: (path: string) => void
}

/** One Agent trace node: semantic icon, summary header and auditable detail. */
function ToolCardView({ card, step, expanded, onToggle, onOpen, onUndo }: ToolCardViewProps) {
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
  // A finished result always wins over a stale orphan flag from old history.
  const finished = card.status === 'done' || card.status === 'error'
  const waiting = Boolean(card.unfinished) && !finished
  const state = waiting
    ? '未完成'
    : card.status === 'running'
      ? '执行中…'
      : card.status === 'error'
        ? '失败'
        : '已完成'
  // Waiting (orphaned call), running, done and failed get their own dot color.
  const tone = waiting
    ? 'waiting'
    : card.status === 'running'
      ? 'running'
      : card.status === 'error'
        ? 'error'
        : 'done'
  return (
    <div className={`chat-trace-node ${meta.tone} ${card.status}`}>
      <div className={`chat-trace-icon ${meta.tone}`}>
        <Icon size={14} />
      </div>
      <div className="chat-trace-main">
        <div className="chat-trace-head">
          <span className="chat-trace-step">#{step}</span>
          <span className="chat-trace-label">{meta.label}</span>
          {card.durationMs !== undefined && (
            <span className="chat-trace-duration">{formatDuration(card.durationMs)}</span>
          )}
          <span className={`chat-trace-state ${tone}`}>
            <span className={`chat-trace-status ${tone}`} />
            {state}
          </span>
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
        {(path || card.text || waiting) && (
          <div className="chat-trace-summary">
            {path ? (
              <button type="button" className="chat-file-link" onClick={() => onOpen(path)}>
                {path}
              </button>
            ) : card.text ? (
              <span className="chat-trace-preview">{card.text.split('\n')[0]}</span>
            ) : (
              <span className="chat-trace-preview">调用已发出但未获得结果</span>
            )}
          </div>
        )}
        {expanded && (
          <div className="chat-trace-detail">
            <div className="chat-trace-audit">
              <span>callId</span>
              <code>{card.callId ?? card.id}</code>
            </div>
            <div className="chat-trace-section-title">arguments</div>
            <div className="chat-tool-args">{card.args || '{}'}</div>
            <div className="chat-trace-section-title">result</div>
            <div className="chat-tool-result">{card.text || '（无返回）'}</div>
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
      reasoning: params.thinkingMode === 'on',
      toolRounds: params.toolRounds,
    }
  } catch {
    // Capability hints are optional; a read failure must not block chat.
    return profile
  }
}

export default function ChatPage({ isActive, onOpenSettings }: Props) {
  const [settings, setSettings] = useState<AgentSettings | null>(null)
  // settings 的最新镜像：激活刷新 effect 只依赖 isActive，用 ref 读当前值，避免写回新对象触发依赖循环。
  const settingsRef = useRef<AgentSettings | null>(null)
  const [conversations, setConversations] = useState<ChatConversation[]>([])
  const [conversation, setConversation] = useState<ChatConversation | null>(null)
  const [items, setItems] = useState<Item[]>([])
  const [input, setInput] = useState('')
  // Composer attachments; `attachmentRef` mirrors it for async imports.
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const attachmentRef = useRef<Attachment[]>([])
  const imageInputRef = useRef<HTMLInputElement>(null)
  const cameraInputRef = useRef<HTMLInputElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const inputElRef = useRef<HTMLTextAreaElement>(null)
  const [attachMenuOpen, setAttachMenuOpen] = useState(false)
  // Expanded composer: fills the space between the nav bar and the keyboard.
  const [expanded, setExpanded] = useState(false)
  const [streaming, setStreaming] = useState(false)
  const [drawerOpen, setDrawerOpen] = useState(false)
  // Top-bar model popover and its in-flight switch guard.
  const [modelMenuOpen, setModelMenuOpen] = useState(false)
  const [switchingModel, setSwitchingModel] = useState(false)
  const [renameId, setRenameId] = useState<number | null>(null)
  const [renameText, setRenameText] = useState('')
  const [loading, setLoading] = useState(true)
  const [expandedTools, setExpandedTools] = useState<Set<string>>(new Set())
  const [expandedThinking, setExpandedThinking] = useState<Set<string>>(new Set())
  // While a run is active, the composer injects (steer) or queues (followUp).
  const [queueMode, setQueueMode] = useState<QueueEntryMode>(readQueueMode)
  const [modeMenuOpen, setModeMenuOpen] = useState(false)
  // Optimistic queue items rendered by the status bar above the composer.
  const [queueItems, setQueueItems] = useState<QueueEntry[]>([])
  const [queueExpanded, setQueueExpanded] = useState(false)
  const [leavingQueueIds, setLeavingQueueIds] = useState<Set<string>>(new Set())
  const [queueGuide, setQueueGuide] = useState(false)
  const [stepCount, setStepCount] = useState(0)
  // Last interrupted run, restored from the ledger after a restart.
  const [interrupted, setInterrupted] = useState<AgentRun | null>(null)
  const [docPreview, setDocPreview] = useState<DocPreview | null>(null)
  const [online, setOnline] = useState(() => navigator.onLine)
  // Set after a network-looking failure; WebView's online flag is unreliable.
  const [networkIssue, setNetworkIssue] = useState(false)
  const [contextWindow, setContextWindow] = useState(0)
  const [scrollBottomVisible, setScrollBottomVisible] = useState(false)
  // Minimap rail + index popover: dots are sampled turns, never scroll-scaled.
  const [turns, setTurns] = useState<TurnPoint[]>([])
  const [activeTurn, setActiveTurn] = useState(0)
  const [railOpen, setRailOpen] = useState(false)
  // Inline editing of one user turn; the row is replaced by a textarea.
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editText, setEditText] = useState('')
  const [editBusy, setEditBusy] = useState(false)
  // Expanded token-usage popover, keyed by the assistant item that owns the ring.
  const [contextOpenId, setContextOpenId] = useState<string | null>(null)
  // User bubbles keyed by item id, measured for jumps and the active turn.
  const bubbleRefs = useRef(new Map<string, HTMLDivElement>())
  const turnOffsets = useRef<number[]>([])
  const railRef = useRef<HTMLButtonElement>(null)
  const railPopoverRef = useRef<HTMLDivElement>(null)
  const railListRef = useRef<HTMLDivElement>(null)
  // Model popover focus targets for keyboard navigation.
  const modelTriggerRef = useRef<HTMLButtonElement>(null)
  const modelPopoverRef = useRef<HTMLDivElement>(null)

  // The runtime owns the Agent, the run status, the queue and write ordering.
  const runtime = useMemo(() => new AgentRuntime({ deps: createRuntimeDeps() }), [])
  const conversationRef = useRef<ChatConversation | null>(null)
  // Mirror of `online` for the snapshot listener (avoids re-subscribing).
  const onlineRef = useRef(navigator.onLine)
  const scrollRef = useRef<HTMLDivElement>(null)
  // Auto-follow only while the reader stays at the bottom; scrolling up must
  // detach immediately, otherwise the next streamed frame snaps back down.
  const stickToBottom = useRef(true)
  const touchStartY = useRef(0)
  const bootRef = useRef(false)
  // Iron rule: the composer text stays in the draft layer until the queue
  // entry is confirmed; failures restore it from the entry itself.
  const pendingSubmitText = useRef<string | null>(null)
  const handledQueueFailures = useRef<Set<string>>(new Set())
  const guideShownRef = useRef(false)
  const consumeTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>())

  const scrollToBottom = useCallback((force = false) => {
    const el = scrollRef.current
    if (!el) return
    if (!force && !stickToBottom.current) return
    el.scrollTop = el.scrollHeight
  }, [])

  /** The current turn is the last one whose bubble passed the top line. */
  const syncActiveTurn = useCallback(() => {
    const el = scrollRef.current
    const offsets = turnOffsets.current
    if (!el || offsets.length === 0) return
    const line = el.scrollTop + RAIL_ACTIVE_OFFSET
    let active = 0
    for (let index = 0; index < offsets.length; index += 1) {
      if (offsets[index] > line) break
      active = index
    }
    setActiveTurn(active)
  }, [])

  const handleScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight
    setScrollBottomVisible(distance > 90)
    // Hysteresis: only re-attach at the very bottom, detach on any real move.
    if (distance <= 2) stickToBottom.current = true
    else if (distance > 4) stickToBottom.current = false
    // Scrolling only moves the highlight; dot coordinates stay fixed.
    syncActiveTurn()
  }, [syncActiveTurn])

  // One entry per user turn; the label feeds the index popover.
  const userMessages = useMemo(
    () =>
      items.flatMap((item) =>
        item.kind === 'user'
          ? [{ id: item.id, label: item.text.trim().replace(/\s+/g, ' ') || '图片消息' }]
          : [],
      ),
    [items],
  )

  /**
   * Cache each turn's content offset and refresh the index. Runs only on
   * message and size changes, never on scroll, so the rail never drifts.
   */
  const measureRail = useCallback(() => {
    turnOffsets.current = userMessages.map(
      (message) => bubbleRefs.current.get(message.id)?.offsetTop ?? 0,
    )
    setTurns((prev) =>
      prev.length === userMessages.length &&
      prev.every((turn, index) => turn.id === userMessages[index].id)
        ? prev
        : userMessages,
    )
    if (userMessages.length === 0) setActiveTurn(0)
    syncActiveTurn()
  }, [syncActiveTurn, userMessages])

  // Remeasure on message changes, viewport resizes and row height changes
  // (late-loading images, expanded tool cards, streaming text).
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    measureRail()
    const observer = new ResizeObserver(() => measureRail())
    observer.observe(el)
    el.querySelectorAll('.chat-row').forEach((row) => observer.observe(row))
    return () => observer.disconnect()
  }, [measureRail])

  /** Sampled turn indices; their constant spacing drives the rail length. */
  const railDots = useMemo(() => sampleTurnIndices(turns.length), [turns.length])
  const railHeight = RAIL_PAD * 2 + Math.max(0, railDots.length - 1) * RAIL_DOT_GAP

  /** The dot at or before the current turn stays highlighted. */
  const activeDotTurn = useMemo(() => {
    let current = -1
    for (const turnIndex of railDots) {
      if (turnIndex > activeTurn) break
      current = turnIndex
    }
    return current
  }, [activeTurn, railDots])

  /** Smoothly scroll the chosen turn's bubble to the top of the viewport. */
  const jumpToTurn = useCallback(
    (turnIndex: number) => {
      const el = scrollRef.current
      const turn = turns[turnIndex]
      const bubble = turn ? bubbleRefs.current.get(turn.id) : undefined
      if (!el || !bubble) return
      el.scrollTo({ top: Math.max(0, bubble.offsetTop - NAV_JUMP_OFFSET), behavior: 'smooth' })
    },
    [turns],
  )

  // Close the index on an outside press or Escape, without blocking scrolling.
  useEffect(() => {
    if (!railOpen) return
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node
      if (railRef.current?.contains(target) || railPopoverRef.current?.contains(target)) return
      setRailOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setRailOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [railOpen])

  // Close the token-usage popover on any press outside its ring.
  useEffect(() => {
    if (!contextOpenId) return
    const onPointerDown = (event: PointerEvent) => {
      if ((event.target as HTMLElement).closest('.chat-context')) return
      setContextOpenId(null)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [contextOpenId])

  // Open the list around the current turn instead of its top edge.
  useLayoutEffect(() => {
    if (!railOpen) return
    const list = railListRef.current
    const active = list?.querySelector<HTMLElement>('.chat-index-item.active')
    if (!list || !active) return
    list.scrollTop = Math.max(0, active.offsetTop - list.clientHeight / 2 + active.offsetHeight / 2)
  }, [railOpen])

  const setAttachmentList = useCallback((next: Attachment[]) => {
    attachmentRef.current = next
    setAttachments(next)
  }, [])

  /** Restore a local draft (text + image ids) for one conversation key. */
  const restoreDraft = useCallback(
    (key: string) => {
      const draft = loadDraft(key)
      setInput(draft.text)
      // Clear immediately so a previous conversation's preview can never leak
      // into this one while the async asset URLs load.
      setAttachmentList([])
      if (draft.assetIds.length === 0) return
      void Promise.all(draft.assetIds.map((id) => assetDataUrl(id))).then((urls) => {
        // Drop assets that no longer exist instead of sending a broken id.
        setAttachmentList(
          draft.assetIds.flatMap((id, index) => {
            const url = urls[index]
            return url ? [{ id, url, size: 0 }] : []
          }),
        )
      })
    },
    [setAttachmentList],
  )

  // Drafts live only in localStorage until the first message is sent. While a
  // queue submission is unconfirmed the text stays here, not in the cleared
  // composer: clearing the input must never destroy it before the receipt.
  const draftKey = conversation ? String(conversation.id) : 'new'
  useEffect(() => {
    if (pendingSubmitText.current !== null) return
    saveDraft(draftKey, { text: input, assetIds: attachments.map((item) => item.id) })
  }, [draftKey, input, attachments])

  // The chat composer grows by whole wrapped lines (CJK/emoji included). The
  // elastic range comes from [2h0, 4h0] in CSS, so the visual height can be
  // tuned in one place without desynchronizing this measurement.
  useLayoutEffect(() => {
    const el = inputElRef.current
    if (!el) return
    if (expanded) {
      el.style.height = ''
      el.classList.remove('capped')
      return
    }
    el.style.height = 'auto'
    const styles = getComputedStyle(el)
    const line = parseFloat(styles.lineHeight) || 22
    const padding = (parseFloat(styles.paddingTop) || 0) + (parseFloat(styles.paddingBottom) || 0)
    const baseline = line + padding
    const min = parseFloat(styles.minHeight) || baseline * 2
    const max = parseFloat(styles.maxHeight) || baseline * 4
    const needed = el.scrollHeight
    const next = Math.min(Math.max(needed, min), max)
    el.style.height = `${next}px`
    // Internal scrolling starts only after the 4-line cap (UX-06).
    el.classList.toggle('capped', needed > max)
  }, [input, expanded])

  // Keep the latest turn visible whenever the viewport changes: the soft
  // keyboard shrinks either the layout viewport (adjustResize) or the visual
  // viewport (overlay), and both must re-anchor the transcript. visualViewport
  // can also scroll independently after the keyboard opens (no resize fires),
  // so the scroll event is tracked as well.
  useEffect(() => {
    const onViewportChange = () => scrollToBottom()
    const vv = window.visualViewport
    vv?.addEventListener('resize', onViewportChange)
    vv?.addEventListener('scroll', onViewportChange)
    window.addEventListener('resize', onViewportChange)
    return () => {
      vv?.removeEventListener('resize', onViewportChange)
      vv?.removeEventListener('scroll', onViewportChange)
      window.removeEventListener('resize', onViewportChange)
    }
  }, [scrollToBottom])

  // While expanded, the tabbar is hidden so the composer reaches the keyboard.
  useEffect(() => {
    if (!expanded) return
    document.body.classList.add('chat-expanded')
    return () => document.body.classList.remove('chat-expanded')
  }, [expanded])


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

  // The runtime owns every transcript mutation; the page renders its snapshot.
  useEffect(
    () =>
      runtime.subscribe((snapshot) => {
        setItems(snapshot.items)
        setStreaming(snapshot.status !== 'idle')
        setQueueItems(snapshot.queueItems)
        setStepCount(snapshot.stepCount)
        setInterrupted(snapshot.interrupted)
        // The picker and the expanded panel never outlive their trigger.
        if (snapshot.status === 'idle') setModeMenuOpen(false)
        if (snapshot.queueItems.length === 0) setQueueExpanded(false)
        // First queue item ever: explain the two modes once, then stop nagging.
        if (snapshot.queueItems.length > 0 && !guideShownRef.current) {
          guideShownRef.current = true
          try {
            if (localStorage.getItem(QUEUE_GUIDE_KEY) !== '1') setQueueGuide(true)
          } catch {
            setQueueGuide(true)
          }
        }
        // The first message of a draft adopts the conversation the backend
        // created atomically with it; mirror it into the list and page state.
        if (snapshot.conversation) {
          const adopted = snapshot.conversation
          if (conversationRef.current?.id !== adopted.id) {
            conversationRef.current = adopted
            setConversation(adopted)
          }
          setConversations((prev) => {
            const existing = prev.find((item) => item.id === adopted.id)
            if (
              existing &&
              existing.title === adopted.title &&
              existing.updatedAt === adopted.updatedAt
            ) {
              return prev
            }
            return [adopted, ...prev.filter((item) => item.id !== adopted.id)]
          })
        }
        if (snapshot.error) {
          setNetworkIssue(
            snapshot.error.code === 'network' ||
              snapshot.error.code === 'timeout' ||
              snapshot.error.code === 'rate_limited',
          )
        }
      }),
    [runtime],
  )

  // Follow the answer only after the DOM committed and only while the reader
  // is still near the bottom. Scrolling up detaches; returning re-attaches.
  useLayoutEffect(() => {
    if (!stickToBottom.current) return
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [items])

  // Confirmation arrived: the draft backup can be released. Failures are
  // rolled back by the effect below instead.
  useEffect(() => {
    const text = pendingSubmitText.current
    if (text === null) return
    const entry = [...queueItems].reverse().find((item) => item.text === text)
    if (!entry || entry.status === 'pending' || entry.status === 'failed') return
    pendingSubmitText.current = null
    saveDraft(draftKey, { text: input, assetIds: attachments.map((item) => item.id) })
  }, [queueItems, draftKey, input, attachments])

  // 失败回填：恢复原文（不覆盖用户新输入）并给出一行提示。
  useEffect(() => {
    const failed = queueItems.filter(
      (item) => item.status === 'failed' && !handledQueueFailures.current.has(item.id),
    )
    if (failed.length === 0) return
    for (const item of failed) handledQueueFailures.current.add(item.id)
    const latest = failed[failed.length - 1]
    if (pendingSubmitText.current === latest.text) pendingSubmitText.current = null
    setInput((prev) => (prev.trim() === '' ? latest.text : prev))
    toast('未发出，已放回输入框')
  }, [queueItems])

  // 被聊天流吸走：气泡渲染的同时播放退场动画，动画结束再移除条目。
  useEffect(() => {
    const consumed = queueItems.filter(
      (item) => item.status === 'consumed' && !consumeTimers.current.has(item.id),
    )
    if (consumed.length === 0) return
    for (const item of consumed) {
      setLeavingQueueIds((prev) => new Set(prev).add(item.id))
      const timer = setTimeout(() => {
        consumeTimers.current.delete(item.id)
        runtime.dismissQueueEntry(item.id)
        setLeavingQueueIds((prev) => {
          const next = new Set(prev)
          next.delete(item.id)
          return next
        })
      }, 280)
      consumeTimers.current.set(item.id, timer)
    }
  }, [queueItems, runtime])

  useEffect(
    () => () => {
      for (const timer of consumeTimers.current.values()) clearTimeout(timer)
      consumeTimers.current.clear()
    },
    [],
  )

  // 首次出现状态栏时解释两种模式，三秒后自动消失，看过不再弹。
  useEffect(() => {
    if (!queueGuide) return
    const timer = setTimeout(() => {
      setQueueGuide(false)
      try {
        localStorage.setItem(QUEUE_GUIDE_KEY, '1')
      } catch {
        // Ignore.
      }
    }, 3000)
    return () => clearTimeout(timer)
  }, [queueGuide])

  const openConversation = useCallback(
    async (conv: ChatConversation): Promise<boolean> => {
      conversationRef.current = conv
      setConversation(conv)
      setExpanded(false)
      setRailOpen(false)
      setEditingId(null)
      setContextOpenId(null)
      restoreDraft(String(conv.id))
      setLoading(true)
      try {
        // 优先使用会话记录里的模型条目；该条目被删除后回退到当前激活模型。
        const current = settingsRef.current
        const baseProfile = current
          ? profileFromSettings(current, conv.provider, conv.model)
          : null
        const profile = baseProfile ? await withCapabilities(baseProfile) : null
        if (profile) setContextWindow(profile.contextWindow ?? 128000)
        // Loading the transcript, building the Agent and closing out a previous
        // run all happen inside the runtime.
        await runtime.open(conv, profile)
        setItems(runtime.snapshot().items)
        return true
      } catch (e) {
        toast(friendlyError(e))
        return false
      } finally {
        setLoading(false)
        stickToBottom.current = true
        scrollToBottom(true)
        setScrollBottomVisible(false)
      }
    },
    [restoreDraft, runtime, scrollToBottom],
  )

  /** Prepare an unsaved chat: no conversation row is written until send. */
  const openDraft = useCallback(async () => {
    conversationRef.current = null
    setConversation(null)
    setItems([])
    setExpanded(false)
    setRailOpen(false)
    setEditingId(null)
    setContextOpenId(null)
    restoreDraft('new')
    setLoading(true)
    try {
      const current = settingsRef.current
      const target = current ? profileFromSettings(current, undefined, undefined) : null
      const profile = target ? await withCapabilities(target) : null
      if (profile) setContextWindow(profile.contextWindow ?? 128000)
      await runtime.openDraft(profile)
      setItems(runtime.snapshot().items)
    } finally {
      setLoading(false)
    }
  }, [restoreDraft, runtime])

  /** Switch the active model in place; an open conversation is rebound too. */
  const switchModel = useCallback(
    async (entry: AgentModelInfo) => {
      if (switchingModel) return
      if (streaming) {
        toast('回复进行中，暂不能切换模型')
        return
      }
      setModelMenuOpen(false)
      setSwitchingModel(true)
      try {
        await chatApi.activateModel(entry.id)
        const next = await chatApi.settings()
        setSettings(next)
        settingsRef.current = next
        const conv = conversationRef.current
        if (conv) {
          const updated = await chatApi.setConversationModel({
            conversationId: conv.id,
            modelEntry: entry.id,
          })
          conversationRef.current = updated
          setConversation(updated)
          setConversations((prev) =>
            prev.map((item) => (item.id === updated.id ? updated : item)),
          )
          // openConversation reports its own failure; do not claim success then.
          if (!(await openConversation(updated))) return
        } else {
          await openDraft()
        }
        toast(`已切换到 ${entry.label}`)
      } catch (error) {
        toast(friendlyError(error))
      } finally {
        setSwitchingModel(false)
      }
    },
    [openConversation, openDraft, streaming, switchingModel],
  )

  // Keyboard support: focus an option on open and let Escape close the menu.
  useEffect(() => {
    if (!modelMenuOpen) return
    const popover = modelPopoverRef.current
    const current = popover?.querySelector<HTMLButtonElement>('.chat-model-option.active')
    const first = popover?.querySelector<HTMLButtonElement>('.chat-model-option:not(:disabled)')
    ;(current && !current.disabled ? current : first)?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setModelMenuOpen(false)
      modelTriggerRef.current?.focus()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [modelMenuOpen])

  /** Arrow keys walk the model list; Enter keeps the button's default action. */
  const moveModelFocus = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    const options = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>('.chat-model-option:not(:disabled)'),
    )
    if (options.length === 0) return
    event.preventDefault()
    const index = options.indexOf(document.activeElement as HTMLButtonElement)
    const next =
      event.key === 'ArrowDown'
        ? options[(index + 1) % options.length]
        : options[index <= 0 ? options.length - 1 : index - 1]
    next?.focus()
  }, [])

  const bootstrap = useCallback(async () => {
    try {
      const [nextSettings, list] = await Promise.all([chatApi.settings(), chatApi.list()])
      setSettings(nextSettings)
      settingsRef.current = nextSettings
      setConversations(list)
      if (list[0]) await openConversation(list[0])
      else await openDraft()
    } catch (e) {
      toast(friendlyError(e))
    } finally {
      setLoading(false)
    }
  }, [openConversation, openDraft])

  useEffect(() => {
    if (bootRef.current) return
    bootRef.current = true
    void bootstrap()
  }, [bootstrap])

  // 页面被编辑器/文件夹浮层替换时会卸载：runtime 会先等取消收尾落库再退订。
  useEffect(() => () => void runtime.dispose(), [runtime])

  // 页面激活时刷新配置；模型变化则重建 Agent（历史保持）。
  // 只依赖 isActive：effect 内写回 settings 的新对象不会再触发自身，避免无限 IPC 循环。
  useEffect(() => {
    if (!isActive || !bootRef.current) return
    let disposed = false
    void (async () => {
      try {
        const next = await chatApi.settings()
        if (disposed) return
        setSettings(next)
        settingsRef.current = next
        // Rebuild on every activation so per-model capability edits are applied.
        const conv = conversationRef.current
        if (!next.activeId && next.models.length === 0) {
          await runtime.dispose()
          return
        }
        if (conv) await openConversation(conv)
        else await openDraft()
      } catch (e) {
        console.error('刷新 Agent 配置失败', e)
      }
    })()
    return () => {
      disposed = true
    }
  }, [isActive, openConversation, openDraft, runtime])

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

  /** Import picked/pasted images as assets; every limit failure is announced. */
  const addImageFiles = useCallback(
    async (files: File[]) => {
      if (streaming) {
        toast('当前回复进行中，暂不支持发送附件')
        return
      }
      if (files.length === 0) return
      let next = [...attachmentRef.current]
      let total = next.reduce((sum, item) => sum + item.size, 0)
      for (const file of files) {
        if (next.length >= MAX_CHAT_IMAGES) {
          toast(`单条消息最多 ${MAX_CHAT_IMAGES} 个附件`)
          break
        }
        if (file.type !== '' && !file.type.startsWith('image/')) {
          toast('暂不支持发送该类型文件，请选择图片')
          continue
        }
        if (file.size > MAX_CHAT_IMAGE_BYTES) {
          toast('单张图片不能超过 32MB')
          continue
        }
        if (total + file.size > MAX_CHAT_TOTAL_BYTES) {
          toast('图片总大小不能超过 40MB')
          break
        }
        try {
          const bytes = new Uint8Array(await file.arrayBuffer())
          const asset = await assetApi.import({ data: bytesToBase64(bytes), source: 'chat' })
          // Same image twice shares one asset id; keep a single preview.
          if (next.some((item) => item.id === asset.id)) continue
          const url = await assetDataUrl(asset.id)
          next = [...next, { id: asset.id, url: url ?? '', size: asset.size }]
          total += asset.size
        } catch (e) {
          toast(friendlyError(e))
        }
      }
      setAttachmentList(next)
    },
    [setAttachmentList, streaming],
  )

  const removeAttachment = useCallback(
    (id: number) => {
      setAttachmentList(attachmentRef.current.filter((item) => item.id !== id))
    },
    [setAttachmentList],
  )

  /** Pasting an image stores it as an asset and previews it in the composer. */
  const handleComposerPaste = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(event.clipboardData.items)
      .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
      .map((item) => item.getAsFile())
      .filter((file): file is File => file != null)
    if (files.length === 0) return
    event.preventDefault()
    void addImageFiles(files)
  }

  const submitPrompt = useCallback(
    async (text: string, imageAssetIds: number[]) => {
      if ((!text && imageAssetIds.length === 0) || streaming || loading) return
      // BUG-01: a draft chat no longer blocks on "会话尚未就绪". The first send
      // creates the conversation atomically in the backend.
      if (!settingsRef.current?.activeId) {
        toast('请先在设置 → AI 助理中添加并启用一个对话模型')
        return
      }
      const previous = attachmentRef.current
      const key = conversationRef.current ? String(conversationRef.current.id) : 'new'
      setInput('')
      setAttachmentList([])
      // A new turn always follows the answer down.
      stickToBottom.current = true
      if (conversationRef.current) void ensureTitle(text || '附件')
      try {
        // The runtime persists the user turn, runs the loop and writes results.
        await runtime.prompt({ text, imageAssetIds })
        clearDraft(key)
      } catch (e) {
        // Rejected before anything was written: keep the draft for a retry.
        setInput(text)
        setAttachmentList(previous)
        toast(friendlyError(e))
      }
    },
    [ensureTitle, loading, runtime, setAttachmentList, streaming],
  )

  const send = useCallback(() => {
    void submitPrompt(
      input.trim(),
      attachmentRef.current.map((item) => item.id),
    )
  }, [input, submitPrompt])

  /**
   * 流式回复中提交的补充消息：
   * - steer：pi 在本批工具全部返回后、下一轮请求前注入（改道）；
   * - followUp：等本轮彻底结束后由运行时开新一轮（接续）。
   * The input clears optimistically while the draft layer keeps the text until
   * the runtime confirms delivery; a failed entry restores it.
   */
  const queueMessage = useCallback(() => {
    const text = input.trim()
    if (!streaming || text === '') return
    stickToBottom.current = true
    pendingSubmitText.current = text
    setInput('')
    vibrate()
    if (queueMode === 'steer') runtime.steer(text)
    else void runtime.followUp(text)
  }, [input, queueMode, runtime, streaming])

  /** Remember the chosen mode locally; the first run defaults to steer. */
  const chooseQueueMode = useCallback((mode: QueueEntryMode) => {
    setQueueMode(mode)
    setModeMenuOpen(false)
    try {
      localStorage.setItem(QUEUE_MODE_KEY, mode)
    } catch {
      // Storage unavailable: the choice only lives for this session.
    }
  }, [])

  /**
   * Regenerate the reply to the user turn that produced `messageId`:
   * later messages are removed from both DB and UI, then `continue()` reuses
   * the kept user turn instead of inserting a duplicate prompt.
   */
  const retry = useCallback(
    async (messageId: string) => {
      if (!conversationRef.current || streaming) return
      try {
        stickToBottom.current = true
        await runtime.retry(messageId)
        setItems(runtime.snapshot().items)
      } catch (e) {
        toast(friendlyError(e))
      }
    },
    [runtime, streaming],
  )

  const toggleTool = useCallback((id: string) => {
    setExpandedTools((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  /** Expand/collapse every trace node of one assistant turn at once. */
  const toggleTrace = useCallback((ids: string[]) => {
    setExpandedTools((prev) => {
      const next = new Set(prev)
      const allOpen = ids.every((id) => next.has(id))
      for (const id of ids) {
        if (allOpen) next.delete(id)
        else next.add(id)
      }
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
      const result = await api.userRead({ path, includeMeta: true })
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

  const copyText = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      toast('已复制')
    } catch {
      toast('复制失败，请长按选择文本')
    }
  }, [])

  const startEdit = useCallback((item: Bubble) => {
    setEditingId(item.id)
    setEditText(item.text)
  }, [])

  const cancelEdit = useCallback(() => {
    setEditingId(null)
    setEditText('')
  }, [])

  /** Rewrite this turn: later messages are dropped before the new run starts. */
  const submitEdit = useCallback(
    async (item: Bubble) => {
      const text = editText.trim()
      if (!text || editBusy || streaming || loading) return
      setEditBusy(true)
      try {
        stickToBottom.current = true
        await runtime.editMessage(item.id, text, item.imageAssetIds ?? [])
        setEditingId(null)
        setEditText('')
      } catch (error) {
        toast(friendlyError(error))
      } finally {
        setEditBusy(false)
      }
    },
    [editBusy, editText, loading, runtime, streaming],
  )

  /** Continue an interrupted run: starts a `resume` ledger row, then asks. */
  const resumeRun = useCallback(() => {
    if (streaming) return
    stickToBottom.current = true
    void runtime.resume().catch((error) => toast(friendlyError(error)))
  }, [runtime, streaming])

  /** Fork the transcript at this message into a new conversation. */
  const forkConversation = useCallback(
    async (messageKey: string, text: string) => {
      try {
        const created = await runtime.fork(messageKey, text)
        setConversations((prev) => [created, ...prev])
        await openConversation(created)
        toast('已创建对话分支')
      } catch (error) {
        toast(friendlyError(error))
      }
    },
    [openConversation, runtime],
  )

  const stop = useCallback(() => {
    // The runtime closes out the partial answer and persists it before idle.
    void runtime.cancel()
  }, [runtime])

  /** Start an unsaved chat. Nothing is written until the first message sends. */
  const newConversation = useCallback(async () => {
    if (!settings?.activeId) {
      toast('请先在设置 → AI 助理中添加并启用一个对话模型')
      return
    }
    try {
      setDrawerOpen(false)
      setAttachMenuOpen(false)
      await openDraft()
    } catch (e) {
      toast(friendlyError(e))
    }
  }, [openDraft, settings])

  const removeConversation = useCallback(
    async (id: number) => {
      try {
        await chatApi.remove(id)
        const rest = conversations.filter((c) => c.id !== id)
        setConversations(rest)
        if (conversationRef.current?.id === id) {
          if (rest[0]) await openConversation(rest[0])
          else await openDraft()
        }
      } catch (e) {
        toast(friendlyError(e))
      }
    },
    [conversations, openConversation, openDraft],
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

  // Single source of truth: the conversation binding wins, active model is the
  // fallback. Never render two independent indicators for the same state.
  const modelEntries = settings?.models ?? []
  const activeModel =
    (conversation
      ? modelEntries.find((item) => item.id === conversation.provider)
      : undefined) ??
    modelEntries.find((item) => item.id === settings?.activeId) ??
    null
  const modelLabel = activeModel
    ? activeModel.label === activeModel.modelId
      ? activeModel.label
      : `${activeModel.label} · ${activeModel.modelId}`
    : '未添加模型'
  const hasModel = settings?.activeId != null
  // Anthropic reports cache tokens separately; OpenAI prompt tokens already
  // include the cached part, so summing them would double count.
  const usageIncludesCache = activeModel?.format === 'anthropic-messages'
  // Inline edit and branch mutations need a settled, fully loaded transcript.
  const chatBusy = streaming || loading || editBusy

  // Stable 1-based numbering for the visible tool-call chain (trace audit).
  const toolSteps = new Map<string, number>()
  let toolStep = 0
  for (const item of items) {
    if (item.kind !== 'tool') continue
    toolStep += 1
    toolSteps.set(item.id, toolStep)
  }

  return (
    <div className={`page chat-page ${expanded ? 'expanded' : ''}`}>
      <PageHeader
        title="对话"
        actions={[
          { icon: <IconChat size={22} />, label: '会话列表', onClick: () => setDrawerOpen(true) },
          {
            icon: <IconPlus size={22} />,
            label: '新建对话',
            onClick: () => void newConversation(),
          },
          { icon: <IconSettings size={22} />, label: '设置', onClick: onOpenSettings },
        ]}
      />

      <div className={`chat-model-bar ${online && !networkIssue ? '' : 'offline'}`}>
        <button
          ref={modelTriggerRef}
          type="button"
          className="chat-model-trigger"
          aria-haspopup="listbox"
          aria-expanded={modelMenuOpen}
          aria-controls="chat-model-options"
          disabled={switchingModel}
          onClick={() => setModelMenuOpen((open) => !open)}
          onKeyDown={(event) => {
            if (event.key !== 'ArrowDown') return
            event.preventDefault()
            setModelMenuOpen(true)
          }}
        >
          <span className="chat-model-dot" />
          <span className="chat-model-name">{modelLabel}</span>
          <span className="chat-model-caret">{modelMenuOpen ? '▴' : '▾'}</span>
        </button>
        {(!online || networkIssue) && (
          <span className="chat-model-note">
            {online ? '网络异常' : '离线模式'}，消息可能发送失败
          </span>
        )}
        {modelMenuOpen && (
          <>
            <div className="popover-backdrop" onClick={() => setModelMenuOpen(false)} />
            <div
              id="chat-model-options"
              ref={modelPopoverRef}
              className="chat-model-popover"
              role="listbox"
              aria-label="切换模型"
              onKeyDown={moveModelFocus}
            >
              <div className="chat-model-popover-title">切换模型</div>
              {modelEntries.length === 0 && (
                <p className="settings-note">还没有模型，请到设置中添加</p>
              )}
              {modelEntries.map((entry) => {
                const current = entry.id === activeModel?.id
                return (
                  <button
                    key={entry.id}
                    type="button"
                    role="option"
                    aria-selected={current}
                    className={`chat-model-option ${current ? 'active' : ''}`}
                    disabled={streaming || switchingModel}
                    onClick={() => void switchModel(entry)}
                  >
                    <span className="chat-model-option-name">{entry.label}</span>
                    {(entry.modelId !== entry.label || !entry.configured) && (
                      <span className="chat-model-option-meta">
                        {entry.modelId !== entry.label ? entry.modelId : ''}
                        {!entry.configured ? ' · 未配置 Key' : ''}
                      </span>
                    )}
                    {current && <span className="chat-model-option-check">✓</span>}
                  </button>
                )
              })}
            </div>
          </>
        )}
      </div>

      {/* Navigator and transcript share one box: the rail is a sibling of the
          scroll container, so its dots never scroll with the messages. */}
      <div className="chat-viewport">
        <div
          className="page-scroll chat-scroll"
          ref={scrollRef}
          onScroll={handleScroll}
          onWheel={(event) => {
            // Wheel-up is explicit reading intent: detach before the next frame.
            if (event.deltaY < 0) stickToBottom.current = false
          }}
          onTouchStart={(event) => {
            touchStartY.current = event.touches[0]?.clientY ?? 0
          }}
          onTouchMove={(event) => {
            const y = event.touches[0]?.clientY
            // Finger moving down scrolls the transcript back (reading up).
            if (y !== undefined && y > touchStartY.current + 4) {
              stickToBottom.current = false
            }
          }}
          onKeyDown={(event) => {
            if (event.key === 'PageUp' || event.key === 'ArrowUp' || event.key === 'Home') {
              stickToBottom.current = false
            }
          }}
        >
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
            items.map((item, index) => {
              // Settled replies carry their usage and trace summary.
              const usage = item.kind === 'assistant' ? item.usage : null
              const cost = usage ? usageCost(usage, activeModel) : null
              // Real prompt size of this reply, not a whole-transcript estimate.
              const usedTokens = usage
                ? usageIncludesCache
                  ? usage.input + usage.cacheRead + usage.cacheWrite
                  : usage.input
                : 0
              const contextPercent =
                usage && contextWindow > 0
                  ? Math.min(100, Math.round((usedTokens * 100) / contextWindow))
                  : 0
              const contextColor =
                contextPercent > 80 ? 'var(--danger)' : 'var(--accent)'
              const traceIds =
                item.kind === 'assistant' && !item.streaming ? turnToolIds(items, index) : []
              const traceExpanded =
                traceIds.length > 0 && traceIds.every((id) => expandedTools.has(id))
              return (
                <div key={item.id} className={`chat-row ${item.kind}`}>
                  <div className="chat-row-body">
                    {item.kind === 'tool' ? (
                      <ToolCardView
                        card={item}
                        step={toolSteps.get(item.id) ?? 1}
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
                        {item.kind === 'assistant' && item.text !== '' && (
                          <div className={`chat-bubble assistant ${item.isError ? 'error' : ''}`}>
                            {item.text}
                          </div>
                        )}
                        {item.kind === 'user' && (
                          <>
                            {editingId === item.id ? (
                              <div
                                className="chat-edit"
                                ref={(node) => {
                                  if (node) bubbleRefs.current.set(item.id, node)
                                  else bubbleRefs.current.delete(item.id)
                                }}
                              >
                                <textarea
                                  className="chat-edit-input"
                                  value={editText}
                                  rows={3}
                                  autoFocus
                                  onChange={(event) => setEditText(event.target.value)}
                                  onKeyDown={(event) => {
                                    if (event.key === 'Escape') cancelEdit()
                                    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                                      event.preventDefault()
                                      void submitEdit(item)
                                    }
                                  }}
                                />
                                <div className="chat-edit-actions">
                                  <button
                                    type="button"
                                    className="chat-edit-btn"
                                    disabled={editBusy}
                                    onClick={cancelEdit}
                                  >
                                    取消
                                  </button>
                                  <button
                                    type="button"
                                    className="chat-edit-btn primary"
                                    disabled={editBusy || editText.trim() === ''}
                                    onClick={() => void submitEdit(item)}
                                  >
                                    {editBusy ? '发送中…' : '重新发送'}
                                  </button>
                                </div>
                              </div>
                            ) : (
                              <div
                                className={`chat-bubble ${item.kind} ${item.isError ? 'error' : ''}`}
                                ref={(node) => {
                                  if (node) bubbleRefs.current.set(item.id, node)
                                  else bubbleRefs.current.delete(item.id)
                                }}
                              >
                                {item.imageAssetIds && <BubbleImages ids={item.imageAssetIds} />}
                                {item.text}
                              </div>
                            )}
                            {editingId !== item.id && (
                              <MessageActions
                                role="user"
                                actions={[
                                  {
                                    key: 'copy',
                                    label: '复制',
                                    icon: <IconCopy size={15} />,
                                    onClick: () => void copyText(item.text),
                                  },
                                  {
                                    key: 'edit',
                                    label: '编辑',
                                    icon: <IconEdit size={15} />,
                                    // Only rows already persisted can be rewritten.
                                    disabled: chatBusy || !/^m-\d+$/.test(item.id),
                                    onClick: () => startEdit(item),
                                  },
                                  {
                                    key: 'branch',
                                    label: '分支',
                                    icon: <IconBranch size={15} />,
                                    disabled: chatBusy,
                                    onClick: () => void forkConversation(item.id, item.text),
                                  },
                                ]}
                              />
                            )}
                          </>
                        )}
                        {item.kind === 'assistant' && !item.streaming && item.text !== '' && (
                          <MessageActions
                            role="assistant"
                            actions={[
                              {
                                key: 'copy',
                                label: '复制',
                                icon: <IconCopy size={15} />,
                                onClick: () => void copyText(item.text),
                              },
                              {
                                key: 'retry',
                                label: '重试',
                                icon: <IconRefresh size={15} />,
                                onClick: () => void retry(item.id),
                              },
                              {
                                key: 'branch',
                                label: '分支',
                                icon: <IconBranch size={15} />,
                                onClick: () => void forkConversation(item.id, item.text),
                              },
                              ...(traceIds.length > 0
                                ? [
                                    {
                                      key: 'trace',
                                      label: traceExpanded
                                        ? `收起本轮工具调用轨迹（${traceIds.length} 步）`
                                        : `展开本轮工具调用轨迹（${traceIds.length} 步）`,
                                      icon: <IconTrace size={15} />,
                                      onClick: () => toggleTrace(traceIds),
                                    },
                                  ]
                                : []),
                            ]}
                            trailing={
                              <>
                                {usage && (
                                  <span
                                    className="chat-usage"
                                    title={`输入 ${usage.input} · 输出 ${usage.output} · 缓存读 ${usage.cacheRead}`}
                                  >
                                    {formatTokens(usage.input)}↑ {formatTokens(usage.output)}↓
                                    {cost !== null && ` · $${cost.toFixed(4)}`}
                                  </span>
                                )}
                                {usage && contextWindow > 0 && (
                                  <span className="chat-context">
                                    <button
                                      type="button"
                                      className="chat-context-ring"
                                      aria-label="上下文用量"
                                      aria-expanded={contextOpenId === item.id}
                                      style={{
                                        background: `conic-gradient(${contextColor} ${contextPercent}%, var(--border) 0)`,
                                      }}
                                      onClick={() =>
                                        setContextOpenId((open) =>
                                          open === item.id ? null : item.id,
                                        )
                                      }
                                    >
                                      <span>{contextPercent}%</span>
                                    </button>
                                    {contextOpenId === item.id && (
                                      <span className="chat-context-popover" role="status">
                                        当前已使用 {usedTokens.toLocaleString()} tokens，上限{' '}
                                        {contextWindow.toLocaleString()}
                                      </span>
                                    )}
                                  </span>
                                )}
                              </>
                            }
                          />
                        )}
                      </>
                    )}
                  </div>
                </div>
              )
            })
          )}
        </div>

        {turns.length > 0 && (
          <button
            ref={railRef}
            type="button"
            className="chat-minimap"
            style={{ height: railHeight }}
            aria-label="消息索引"
            aria-expanded={railOpen}
            onClick={() => setRailOpen((open) => !open)}
          >
            {railDots.map((turnIndex, dotIndex) => (
              <span
                key={turns[turnIndex].id}
                className={`chat-minimap-dot ${turnIndex === activeDotTurn ? 'active' : ''}`}
                style={{ top: RAIL_PAD + dotIndex * RAIL_DOT_GAP }}
              />
            ))}
          </button>
        )}

        {railOpen && turns.length > 0 && (
          <div ref={railPopoverRef} className="chat-index" role="dialog" aria-label="消息索引">
            <div className="chat-index-head">消息索引</div>
            <div ref={railListRef} className="chat-index-list">
              {turns.map((turn, index) => (
                <button
                  key={turn.id}
                  type="button"
                  className={`chat-index-item ${index === activeTurn ? 'active' : ''}`}
                  onClick={() => {
                    jumpToTurn(index)
                    setRailOpen(false)
                  }}
                >
                  <span className="chat-index-no">{index + 1}</span>
                  <span className="chat-index-text">{turn.label}</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {scrollBottomVisible && (
        <button
          type="button"
          className="chat-scroll-bottom"
          aria-label="回到底部"
          onClick={() => scrollToBottom(true)}
        >
          ↓
        </button>
      )}

      <div className={`chat-composer ${expanded ? 'expanded' : ''}`}>
        <QueueStatusBar
          items={queueItems}
          stepCount={stepCount}
          expanded={queueExpanded}
          leavingIds={leavingQueueIds}
          onToggle={() => setQueueExpanded((open) => !open)}
          onRemove={(id) => void runtime.removeQueueEntry(id)}
          onRetry={(id) => runtime.retryQueueEntry(id)}
          onMove={(id, targetIndex) => runtime.moveQueueEntry(id, targetIndex)}
        />
        {queueGuide && (
          <div className="chat-queue-guide" role="note">
            插话＝立刻改道，排队＝忙完再说
          </div>
        )}
        {interrupted && !streaming && (
          <button type="button" className="chat-resume" onClick={resumeRun}>
            上次回答中断
            {interrupted.partial ? `（已保存 ${partialLength(interrupted.partial)} 字）` : ''}
            ，点击继续
          </button>
        )}
        {attachments.length > 0 && (
          <div className="chat-attachments">
            {attachments.map((attachment) => (
              <div className="chat-attachment" key={attachment.id}>
                {attachment.url ? (
                  <img src={attachment.url} alt="待发送图片" />
                ) : (
                  <span className="asset-missing">图片缺失</span>
                )}
                <button
                  type="button"
                  className="chat-attachment-remove"
                  aria-label="移除图片"
                  onClick={() => removeAttachment(attachment.id)}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="chat-composer-box">
          <div className="chat-input-wrap">
            <textarea
              ref={inputElRef}
              className="chat-input"
              value={input}
              rows={1}
              placeholder={hasModel ? '说点什么…' : '请先添加模型'}
              disabled={!hasModel || loading}
              onChange={(e) => setInput(e.target.value)}
              onPaste={handleComposerPaste}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  if (streaming) void queueMessage()
                  else void send()
                }
              }}
            />
          </div>
          <div className="chat-composer-actions">
            {!streaming && (
              <button
                type="button"
                className="chat-attach"
                aria-label="添加附件"
                title={hasModel ? '添加附件' : '请先在设置 → AI 助理中添加并启用一个模型'}
                disabled={!hasModel || loading}
                onClick={() => {
                  if (hasModel && !loading) setAttachMenuOpen(true)
                }}
              >
                <IconPaperclip size={19} />
              </button>
            )}
            {streaming && (
              <>
                {/* Split control: the label sends in the current mode, the
                    caret opens the mode picker. Idle runs show a plain send
                    button instead, so the caret disappears entirely. */}
                <div className={`chat-send-split ${input.trim() === '' ? 'disabled' : ''}`}>
                  <button
                    type="button"
                    className="chat-send-mode"
                    aria-label={queueMode === 'steer' ? '插话' : '排队'}
                    disabled={input.trim() === ''}
                    onClick={() => void queueMessage()}
                  >
                    {queueMode === 'steer' ? '插话' : '排队'}
                  </button>
                  <button
                    type="button"
                    className="chat-send-caret"
                    aria-label="切换插话或排队"
                    aria-haspopup="listbox"
                    aria-expanded={modeMenuOpen}
                    onClick={() => setModeMenuOpen((open) => !open)}
                  >
                    ▾
                  </button>
                </div>
                <button type="button" className="chat-send stop" aria-label="停止" onClick={stop}>
                  <IconStop size={19} />
                </button>
              </>
            )}
            {!streaming && (
              <button
                type="button"
                className="chat-send"
                aria-label="发送"
                disabled={(input.trim() === '' && attachments.length === 0) || !hasModel || loading}
                onClick={() => void send()}
              >
                <IconSend size={19} />
              </button>
            )}
          </div>
          {modeMenuOpen && streaming && (
            <>
              <div className="popover-backdrop" onClick={() => setModeMenuOpen(false)} />
              <div className="chat-queue-menu" role="listbox" aria-label="发送方式">
                <div className="chat-queue-menu-title">发送方式</div>
                {QUEUE_MODES.map((option) => (
                  <button
                    key={option.mode}
                    type="button"
                    role="option"
                    aria-selected={queueMode === option.mode}
                    className={`chat-queue-option ${queueMode === option.mode ? 'active' : ''}`}
                    onClick={() => chooseQueueMode(option.mode)}
                  >
                    <span className="chat-queue-option-row">
                      <span>{option.label}</span>
                      {queueMode === option.mode && (
                        <span className="chat-queue-option-check">✓</span>
                      )}
                    </span>
                    <span className="chat-queue-option-note">{option.note}</span>
                  </button>
                ))}
              </div>
            </>
          )}
          <button
            type="button"
            className={`chat-expand ${expanded ? 'active' : ''}`}
            aria-label={expanded ? '收起输入框' : '展开输入框'}
            aria-pressed={expanded}
            title={expanded ? '收起输入框' : '展开输入框'}
            onClick={() => setExpanded((prev) => !prev)}
          >
            {expanded ? <IconCollapse size={15} /> : <IconExpand size={15} />}
          </button>
        </div>
        <input
          ref={imageInputRef}
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp"
          multiple
          hidden
          onChange={(e) => {
            const files = Array.from(e.target.files ?? [])
            e.target.value = ''
            void addImageFiles(files)
          }}
        />
        {/* Camera capture and generic file picking share the same import path. */}
        <input
          ref={cameraInputRef}
          type="file"
          accept="image/*"
          capture="environment"
          hidden
          onChange={(e) => {
            const files = Array.from(e.target.files ?? [])
            e.target.value = ''
            void addImageFiles(files)
          }}
        />
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*,.pdf,.txt,.md,.csv,.json,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.mp3,.m4a,.wav,.mp4,.mov,.webm"
          multiple
          hidden
          onChange={(e) => {
            const files = Array.from(e.target.files ?? [])
            e.target.value = ''
            void addImageFiles(files)
          }}
        />
      </div>

      {attachMenuOpen && (
        <ActionSheet
          title="添加附件"
          onClose={() => setAttachMenuOpen(false)}
          items={[
            {
              label: '拍照',
              onClick: () => {
                setAttachMenuOpen(false)
                cameraInputRef.current?.click()
              },
            },
            {
              label: '相册',
              onClick: () => {
                setAttachMenuOpen(false)
                imageInputRef.current?.click()
              },
            },
            {
              label: '文件',
              onClick: () => {
                setAttachMenuOpen(false)
                fileInputRef.current?.click()
              },
            },
          ]}
        />
      )}

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
