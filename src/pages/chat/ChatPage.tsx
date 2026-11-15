//! 对话页：pi-agent 事件的流式渲染 + 工具卡片 + 会话管理。
//!
//! 渲染策略：按 part.type 分流——正文 text 走共享 Markdown 渲染器（原始 HTML
//! 关闭，模型输出不会成为可执行标记），工具调用/结果走摘要行，详情另开面板。

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { api, assetApi, chatApi } from '../../api'
import { assetDataUrl } from '../../assets'
import { clearDraft, loadDraft, saveDraft } from '../../chatDraft'
import type { AgentProfile } from '../../agent/runtime'
import { profileFromSettings } from '../../agent/runtime'
import type {
  AgentRuntime,
  QueueEntry,
  QueueEntryMode,
  RuntimeSnapshot,
} from '../../agent/AgentRuntime'
import { RuntimePool, SessionClosedError } from '../../agent/RuntimePool'
import { createRuntimeDeps } from '../../agent/runtimeDeps'
import {
  documentPaths,
  partialLength,
  toolChangeStats,
  turnFileChanges,
  type Bubble,
  type Item,
  type ToolCard,
  type TurnFileChange,
} from '../../agent/chatView'
import type {
  AgentModelInfo,
  AgentRun,
  AgentSettings,
  ChatConversation,
  MessageUsage,
} from '../../types'
import { bytesToBase64, formatDuration, friendlyError } from '../../utils'
import { toast } from '../../toast'
import { ActionSheet, ConfirmDialog, Modal, OverlayPortal } from '../../components/ui'
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
  IconRewind,
  IconSearch,
  IconSend,
  IconSettings,
  IconStop,
  IconTrash,
} from '../../components/Icons'
import MessageActions from './MessageActions'
import QueueStatusBar from './QueueStatusBar'
import ChatMarkdown from './ChatMarkdown'
import TraceDetailModal, { type TraceDetailTarget } from './TraceDetailModal'
import { usePhysicalBack } from '../../system/backButton'

interface Props {
  isActive: boolean
  onOpenSettings: () => void
}


/** One user turn listed in the rail's index popover. */
interface TurnPoint {
  id: string
  label: string
}

/**
 * Minimap geometry: dots keep a constant gap and the rail length is derived
 * from the dot count (pad * 2 + (n - 1) * gap) instead of being stretched.
 * A wider gap keeps the dots apart so each anchor is easier to target.
 */
const RAIL_DOT_GAP = 13
const RAIL_PAD = 10
const RAIL_MIN_DOTS = 4
const RAIL_MAX_DOTS = 16
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

/**
 * Duration chip shared by reasoning and tool rows. The fixed width keeps the
 * status badge in the same column; history without a measurement shows `--`
 * so the row never reflows.
 */
function TraceDuration({ ms }: { ms?: number }) {
  return (
    <time
      className="chat-tool-call-duration"
      dateTime={ms === undefined ? undefined : `PT${(ms / 1000).toFixed(3)}S`}
    >
      {ms === undefined ? '--' : formatDuration(ms)}
    </time>
  )
}

/** Fixed-width status pill; both trace rows share the same column. */
function TraceStatusBadge({ tone, label }: { tone: string; label: string }) {
  return (
    <span className={`chat-tool-call-badge ${tone}`} role="status">
      <span className={`chat-trace-status ${tone}`} />
      {label}
    </span>
  )
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

/** One collapsible process entry: reasoning or a tool invocation. */
type TraceEntry =
  | { kind: 'thinking'; id: string; text: string; durationMs?: number }
  | { kind: 'tool'; card: ToolCard }

interface UserBlock {
  kind: 'user'
  item: Bubble
  /** Files written by the Agent during this turn; drives the rollback action. */
  changes: TurnFileChange[]
}

interface AssistantBlock {
  kind: 'assistant'
  /** Null when a turn ends on a trace without a visible reply. */
  item: Bubble | null
  trace: TraceEntry[]
}

type ChatBlock = UserBlock | AssistantBlock

/**
 * Group reasoning and tool cards under the assistant reply they feed. The
 * grouping is presentation-only; items keep their original relative order.
 */
function buildChatBlocks(items: Item[]): ChatBlock[] {
  const blocks: ChatBlock[] = []
  let trace: TraceEntry[] = []
  const flush = () => {
    if (trace.length === 0) return
    blocks.push({ kind: 'assistant', item: null, trace })
    trace = []
  }
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]
    if (item.kind === 'user') {
      flush()
      blocks.push({ kind: 'user', item, changes: turnFileChanges(items, index) })
      continue
    }
    if (item.kind === 'tool') {
      trace.push({ kind: 'tool', card: item })
      continue
    }
    if ((item.thinking ?? '').trim() !== '') {
      trace.push({
        kind: 'thinking',
        id: item.id,
        text: item.thinking ?? '',
        durationMs: item.thinkingMs,
      })
    }
    if (item.text !== '' || item.isError) {
      blocks.push({ kind: 'assistant', item, trace })
      trace = []
    }
  }
  flush()
  return blocks
}

/** Directory stays muted and truncates; the filename keeps its full emphasis. */
function PathLabel({ path }: { path: string }) {
  const cut = path.lastIndexOf('/')
  const dir = cut >= 0 ? path.slice(0, cut + 1) : ''
  const name = cut >= 0 ? path.slice(cut + 1) : path
  return (
    <>
      {dir && <span className="chat-file-dir">{dir}</span>}
      <span className="chat-file-name">{name}</span>
    </>
  )
}

/** Impact preview shown before a turn rollback is confirmed. */
function UndoImpact({ changes }: { changes: TurnFileChange[] }) {
  const modified = changes.filter((change) => !change.created)
  const created = changes.filter((change) => change.created)
  const calls = changes.reduce((sum, change) => sum + change.calls, 0)
  return (
    <div className="undo-impact">
      <p className="undo-impact-summary">
        本轮共 {calls} 次写入工具调用，涉及 {changes.length} 个文件。
      </p>
      <UndoImpactFiles title={`修改 · ${modified.length}`} changes={modified} />
      <UndoImpactFiles title={`新建 · ${created.length}`} changes={created} />
      <p className="undo-impact-warning">
        确认后会同时清空这条消息及其之后的对话记录，并把原始输入回填到输入框。
      </p>
    </div>
  )
}

function UndoImpactFiles({
  title,
  changes,
}: {
  title: string
  changes: TurnFileChange[]
}) {
  return (
    <section className="undo-impact-group">
      <span className="undo-impact-title">{title}</span>
      {changes.length === 0 ? (
        <span className="undo-impact-empty">无</span>
      ) : (
        <ul>
          {changes.map((change) => (
            <li key={change.path}>
              <span className="undo-impact-path">{change.path}</span>
              <span className="undo-impact-tools">
                {change.tools.join(' · ')} ×{change.calls}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function UndoImpactGroup({
  title,
  paths,
  empty = '无',
}: {
  title: string
  paths: string[]
  empty?: string
}) {
  return (
    <section className="undo-impact-group">
      <span className="undo-impact-title">{title}</span>
      {paths.length === 0 ? (
        <span className="undo-impact-empty">{empty}</span>
      ) : (
        <ul>
          {paths.map((path) => (
            <li key={path}>{path}</li>
          ))}
        </ul>
      )}
    </section>
  )
}

interface ThinkingTraceItemProps {
  id: string
  text: string
  /** Wall-clock reasoning time; absent for history loaded from disk. */
  durationMs?: number
  expanded: boolean
  /** The owning reply is still streaming, so the body should follow its tail. */
  live: boolean
  onToggle: (id: string) => void
  /** Opens the card modal with the full reasoning text. */
  onOpenDetail: () => void
}

/** Level-2 reasoning row: the row opens the card modal, the chevron toggles
 * the inline body. */
function ThinkingTraceItem({
  id,
  text,
  durationMs,
  expanded,
  live,
  onToggle,
  onOpenDetail,
}: ThinkingTraceItemProps) {
  const bodyRef = useRef<HTMLDivElement>(null)
  // Follow the streamed tail until the reader scrolls up; returning to the
  // bottom resumes following. The body hugs its content until the max-height
  // clamp, then scrolls internally.
  const followRef = useRef(true)
  useLayoutEffect(() => {
    const el = bodyRef.current
    if (el && live && followRef.current) el.scrollTop = el.scrollHeight
  }, [text, live])
  // A measure is recorded once reasoning ends, even while the answer streams.
  const running = live && durationMs === undefined
  return (
    <div className={`chat-trace-card thinking ${expanded ? 'open' : ''}`}>
      <div className="chat-trace-card-head">
        <button
          type="button"
          className="chat-trace-card-main"
          title="查看详情"
          onClick={onOpenDetail}
        >
          <span className="chat-trace-icon skill">
            <IconInfo size={14} />
          </span>
          <span className="chat-tool-call-meta">
            {/* Reasoning has no step number; the spacer keeps the column. */}
            <span className="chat-trace-step placeholder" aria-hidden="true" />
            <span className="chat-trace-label">思考</span>
            <TraceDuration ms={durationMs} />
            <TraceStatusBadge
              tone={running ? 'running' : 'done'}
              label={running ? '生成中' : '已完成'}
            />
          </span>
        </button>
        <button
          type="button"
          className="chat-trace-chevron-btn"
          aria-expanded={expanded}
          aria-label={expanded ? '收起思考内容' : '展开思考内容'}
          onClick={() => onToggle(id)}
        >
          <span className={`chat-trace-chevron ${expanded ? 'open' : ''}`}>▸</span>
        </button>
      </div>
      {expanded && (
        <div
          className="chat-trace-card-body thinking"
          ref={bodyRef}
          onScroll={(event) => {
            const el = event.currentTarget
            followRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= 16
          }}
        >
          {text}
        </div>
      )}
    </div>
  )
}

interface ToolTraceItemProps {
  card: ToolCard
  /** 1-based position in this transcript's invocation chain. */
  step: number
  onOpen: (card: ToolCard, path?: string) => void
}

/**
 * Level-2 tool row: a single-line meta header (name · duration · status) over
 * a lazily mounted summary. The chevron toggles the inline summary only; the
 * meta area opens the card modal with the full execution detail.
 */
function ToolTraceItem({ card, step, onOpen }: ToolTraceItemProps) {
  // Collapsed by default: the summary never renders until asked.
  const [open, setOpen] = useState(false)
  const files = documentPaths(card)
  // Write/edit rows summarize with line counters instead of the diff body.
  // Memoized: the LCS diff must not rerun on every streamed frame.
  const stats = useMemo(() => toolChangeStats(card), [card])
  const meta = TOOL_META[card.toolName] ?? {
    label: card.toolName,
    tone: 'other',
    Icon: IconInfo,
  }
  const Icon = meta.Icon
  // A finished result always wins over a stale orphan flag from old history.
  const finished = card.status === 'done' || card.status === 'error'
  const waiting = Boolean(card.unfinished) && !finished
  const state = waiting
    ? '未完成'
    : card.status === 'running'
      ? '执行中'
      : card.status === 'error'
        ? '失败'
        : '已完成'
  // Waiting (orphaned call), running, done and failed get their own badge color.
  const tone = waiting
    ? 'waiting'
    : card.status === 'running'
      ? 'running'
      : card.status === 'error'
        ? 'error'
        : 'done'
  const preview = card.text.split('\n')[0]?.trim() ?? ''
  const hasPayload = files.length > 0 || preview !== '' || stats !== null
  return (
    <div className={`chat-trace-card ${open ? 'open' : ''}`}>
      <div className="chat-trace-card-head">
        <button
          type="button"
          className="chat-trace-card-main"
          title="查看详情"
          onClick={() => onOpen(card)}
        >
          <span className={`chat-trace-icon ${meta.tone}`}>
            <Icon size={14} />
          </span>
          <span className="chat-tool-call-meta">
            <code className="chat-trace-step">#{step}</code>
            <span className="chat-trace-label">{meta.label}</span>
            <TraceDuration ms={card.durationMs} />
            <TraceStatusBadge tone={tone} label={state} />
          </span>
        </button>
        {hasPayload ? (
          <button
            type="button"
            className="chat-trace-chevron-btn"
            aria-expanded={open}
            aria-label={open ? '收起工具摘要' : '展开工具摘要'}
            onClick={() => setOpen((value) => !value)}
          >
            <span className={`chat-trace-chevron ${open ? 'open' : ''}`}>▸</span>
          </button>
        ) : (
          <span className="chat-trace-open-hint">›</span>
        )}
      </div>
      {/* Inline mode: summary only — the diff/body lives in the card modal. */}
      {open && hasPayload && (
        <div className="chat-trace-card-body chat-tool-call-payload">
          {stats && (
            <div className="chat-tool-call-diff">
              <span className="add">+{stats.added} 行新增</span>
              <span className="del">-{stats.removed} 行删除</span>
            </div>
          )}
          {files.map((path) => (
            <button
              key={path}
              type="button"
              className="chat-tool-call-file"
              title={path}
              onClick={() => onOpen(card, path)}
            >
              <span className="chat-tool-call-file-dot" />
              <span className="chat-trace-path">
                <PathLabel path={path} />
              </span>
            </button>
          ))}
          {files.length === 0 && preview !== '' && (
            <span className="chat-trace-preview">{preview}</span>
          )}
        </div>
      )}
    </div>
  )
}

interface TraceGroupProps {
  groupId: string
  entries: TraceEntry[]
  toolSteps: Map<string, number>
  open: boolean
  expandedThinking: Set<string>
  /** Assistant item still streaming; its reasoning body follows the tail. */
  liveTraceId: string | null
  onToggleAll: (id: string, expand: boolean) => void
  onToggleThinking: (id: string) => void
  onOpenTool: (card: ToolCard, path?: string) => void
  onOpenThinking: (entry: {
    id: string
    text: string
    durationMs?: number
    running: boolean
  }) => void
}

/** Level-1 container: expanding it also unfolds every reasoning body. */
function TraceGroup({
  groupId,
  entries,
  toolSteps,
  open,
  expandedThinking,
  liveTraceId,
  onToggleAll,
  onToggleThinking,
  onOpenTool,
  onOpenThinking,
}: TraceGroupProps) {
  // Header summary keeps only measurable facts: a reasoning block carries no
  // count of its own, so only tool calls and the running state show here.
  let toolCount = 0
  let running = false
  for (const entry of entries) {
    if (entry.kind !== 'tool') continue
    toolCount += 1
    if (entry.card.status === 'running') running = true
  }
  const meta = [toolCount > 0 && `${toolCount} 次工具调用`, running && '执行中']
    .filter(Boolean)
    .join(' · ')
  return (
    <div className="chat-trace-group">
      <div className="chat-trace-group-head">
        <button
          type="button"
          className="chat-trace-group-toggle"
          aria-expanded={open}
          onClick={() => onToggleAll(groupId, !open)}
        >
          <span className={`chat-trace-chevron ${open ? 'open' : ''}`}>▸</span>
          <span className="chat-trace-group-title">过程</span>
          {meta !== '' && <span className="chat-trace-group-meta">{meta}</span>}
        </button>
        <button
          type="button"
          className="chat-trace-group-all"
          onClick={() => onToggleAll(groupId, !open)}
        >
          {open ? '全部收起' : '全部展开'}
        </button>
      </div>
      {open && (
        <div className="chat-trace-group-body">
          {entries.map((entry) =>
            entry.kind === 'thinking' ? (
              <ThinkingTraceItem
                key={`think-${entry.id}`}
                id={entry.id}
                text={entry.text}
                durationMs={entry.durationMs}
                expanded={expandedThinking.has(entry.id)}
                live={entry.id === liveTraceId}
                onToggle={onToggleThinking}
                onOpenDetail={() =>
                  onOpenThinking({
                    id: entry.id,
                    text: entry.text,
                    durationMs: entry.durationMs,
                    running: entry.id === liveTraceId && entry.durationMs === undefined,
                  })
                }
              />
            ) : (
              <ToolTraceItem
                key={`tool-${entry.card.id}`}
                card={entry.card}
                step={toolSteps.get(entry.card.id) ?? 1}
                onOpen={onOpenTool}
              />
            ),
          )}
        </div>
      )}
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
  // Conversation list popover anchored to the header's list action.
  const [convAnchor, setConvAnchor] = useState<{ top: number; left: number } | null>(null)
  const [switchingModel, setSwitchingModel] = useState(false)
  const [renameId, setRenameId] = useState<number | null>(null)
  const [renameText, setRenameText] = useState('')
  const [loading, setLoading] = useState(true)
  const [expandedThinking, setExpandedThinking] = useState<Set<string>>(new Set())
  // Trace groups start collapsed; expansion is per level and per group.
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set())
  // Heavy tool content opens in its own sheet; `path` selects the active file.
  // Heavy trace content opens in its own sheet; inline rows stay summaries.
  const [detail, setDetail] = useState<TraceDetailTarget | null>(null)
  // Rollback is a two-step operation: preview impact, then execute.
  const [undoTarget, setUndoTarget] = useState<{
    item: Bubble
    changes: TurnFileChange[]
  } | null>(null)
  const [undoReceipt, setUndoReceipt] = useState<{
    restored: string[]
    removed: string[]
  } | null>(null)
  const [undoing, setUndoing] = useState(false)
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
  // Conversation popover: scroll container + edge-fade visibility.
  const convScrollRef = useRef<HTMLDivElement>(null)
  const [convEdges, setConvEdges] = useState({ top: false, bottom: false })
  // Model popover focus targets for keyboard navigation.
  const modelTriggerRef = useRef<HTMLButtonElement>(null)
  const modelPopoverRef = useRef<HTMLDivElement>(null)
  const convTriggerRef = useRef<HTMLButtonElement>(null)

  // Session isolation: one runtime per conversation. Only the active session
  // is rendered; the others keep generating and persisting in the background,
  // so switching transcripts can never abort a live answer.
  const pool = useMemo(
    () =>
      new RuntimePool(createRuntimeDeps(), {
        onAdopted: (adopted) => {
          setConversations((prev) =>
            prev.some((item) => item.id === adopted.id) ? prev : [adopted, ...prev],
          )
        },
      }),
    [],
  )
  const [runtime, setRuntime] = useState<AgentRuntime>(() => pool.initial())
  // Mirrors `runtime` synchronously: a late snapshot from the previous session
  // must not overwrite the transcript that is on screen now.
  const activeRuntimeRef = useRef(runtime)
  // Bumped per switch so a slow open cannot land after a newer one finished.
  const switchSeq = useRef(0)
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

  /** The floating button glides along the smooth scroll; motion prefs win. */
  const scrollToBottomSmooth = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    // Same defensive pattern as the editor: WebViews without matchMedia
    // fall back to the instant jump.
    const reduce =
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
    el.scrollTo({ top: el.scrollHeight, behavior: reduce ? 'auto' : 'smooth' })
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

  // One entry per user turn; the label feeds the rail's index popover.
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

  /** Visual position of the active dot inside the sampled rail. */
  const activeDotIndex = useMemo(
    () => railDots.indexOf(activeDotTurn),
    [railDots, activeDotTurn],
  )

  /** Scroll the chosen turn's bubble to the top of the viewport. */
  const jumpToTurn = useCallback(
    (turnIndex: number, behavior: ScrollBehavior = 'smooth') => {
      const el = scrollRef.current
      const turn = turns[turnIndex]
      const bubble = turn ? bubbleRefs.current.get(turn.id) : undefined
      if (!el || !bubble) return
      el.scrollTo({ top: Math.max(0, bubble.offsetTop - NAV_JUMP_OFFSET), behavior })
    },
    [turns],
  )

  /** Map a pointer position on the rail lane to the nearest sampled turn. */
  const railSeek = useCallback(
    (clientY: number, behavior: ScrollBehavior) => {
      const rail = railRef.current
      if (!rail || railDots.length === 0) return
      const offset = clientY - rail.getBoundingClientRect().top - RAIL_PAD
      const dot = Math.max(0, Math.min(railDots.length - 1, Math.round(offset / RAIL_DOT_GAP)))
      jumpToTurn(railDots[dot], behavior)
    },
    [jumpToTurn, railDots],
  )

  // Tap opens the index list (original behaviour); a vertical drag scrubs the
  // transcript. The 6px slop keeps a slightly shaky tap from becoming a seek.
  const railPress = useRef({ active: false, startY: 0, moved: false })
  const onRailPointerDown = useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return
    // Keep move/up on the rail for the whole drag gesture.
    event.currentTarget.setPointerCapture?.(event.pointerId)
    railPress.current = { active: true, startY: event.clientY, moved: false }
  }, [])
  const onRailPointerMove = useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      const press = railPress.current
      if (!press.active) return
      if (Math.abs(event.clientY - press.startY) <= 6) return
      press.moved = true
      // Dragging follows the finger instantly; scroll events keep the thumb in sync.
      railSeek(event.clientY, 'auto')
    },
    [railSeek],
  )
  const onRailPointerEnd = useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
    // The browser releases capture implicitly on pointerup, but a cancelled or
    // interrupted gesture should still hand the pointer back deterministically.
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    railPress.current.active = false
  }, [])
  const onRailClick = useCallback(() => {
    // The click synthesized after a drag must not toggle the list.
    if (railPress.current.moved) {
      railPress.current.moved = false
      return
    }
    setRailOpen((open) => !open)
  }, [])

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

  // Open the list around the current turn instead of its top edge.
  useLayoutEffect(() => {
    if (!railOpen) return
    const list = railListRef.current
    const active = list?.querySelector<HTMLElement>('.chat-index-item.active')
    if (!list || !active) return
    list.scrollTop = Math.max(0, active.offsetTop - list.clientHeight / 2 + active.offsetHeight / 2)
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

  // The active runtime owns every transcript mutation; the page renders it.
  const applySnapshot = useCallback((snapshot: RuntimeSnapshot) => {
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
  }, [])

  useEffect(() => {
    // `showRuntime` already paints the first frame; here we only follow events.
    activeRuntimeRef.current = runtime
    return runtime.subscribe((snapshot) => {
      // A session switched away from must not paint over the current one.
      if (activeRuntimeRef.current !== runtime) return
      applySnapshot(snapshot)
    })
  }, [runtime, applySnapshot])

  /** Point the page at a session; other sessions keep their runs untouched. */
  const showRuntime = useCallback(
    (next: AgentRuntime) => {
      activeRuntimeRef.current = next
      setRuntime(next)
      applySnapshot(next.snapshot())
    },
    [applySnapshot],
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
      const token = (switchSeq.current += 1)
      try {
        // 优先使用会话记录里的模型条目；该条目被删除后回退到当前激活模型。
        const current = settingsRef.current
        const baseProfile = current
          ? profileFromSettings(current, conv.provider, conv.model)
          : null
        const profile = baseProfile ? await withCapabilities(baseProfile) : null
        if (token !== switchSeq.current) return true
        if (profile) setContextWindow(profile.contextWindow ?? 128000)
        // The pool attaches to a live session instead of rebuilding it, so a
        // generation still running in this conversation is never aborted.
        const next = await pool.open(conv, profile)
        if (token !== switchSeq.current) return true
        showRuntime(next)
        return true
      } catch (e) {
        // Deleted or torn down while loading: nothing to show, nothing to say.
        if (e instanceof SessionClosedError) return false
        toast(friendlyError(e))
        return false
      } finally {
        if (token === switchSeq.current) {
          setLoading(false)
          stickToBottom.current = true
          scrollToBottom(true)
          setScrollBottomVisible(false)
        }
      }
    },
    [restoreDraft, pool, showRuntime, scrollToBottom],
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
    const token = (switchSeq.current += 1)
    try {
      const current = settingsRef.current
      const target = current ? profileFromSettings(current, undefined, undefined) : null
      const profile = target ? await withCapabilities(target) : null
      if (token !== switchSeq.current) return
      if (profile) setContextWindow(profile.contextWindow ?? 128000)
      const next = await pool.openDraft(profile)
      if (token !== switchSeq.current) return
      showRuntime(next)
    } catch (e) {
      // Deleted or torn down while loading: nothing to show, nothing to say.
      if (!(e instanceof SessionClosedError)) throw e
    } finally {
      if (token === switchSeq.current) setLoading(false)
    }
  }, [restoreDraft, pool, showRuntime])

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

  // Escape dismisses the conversation popover; the backdrop handles taps.
  // The popover only renders when both flags are truthy, so the listener must
  // follow the same condition and be torn down the moment either one clears.
  useEffect(() => {
    if (!drawerOpen || !convAnchor) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setDrawerOpen(false)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [drawerOpen, convAnchor])

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

  // 页面被编辑器/文件夹浮层替换时会卸载：会话池会先等取消收尾落库再退订。
  useEffect(() => () => void pool.disposeAll(), [pool])

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
          await pool.disposeAll()
          return
        }
        // A live session is re-attached by the pool, never rebuilt, so coming
        // back to the chat page no longer cancels a running answer.
        if (conv) await openConversation(conv)
        else await openDraft()
      } catch (e) {
        console.error('刷新 Agent 配置失败', e)
      }
    })()
    return () => {
      disposed = true
    }
  }, [isActive, openConversation, openDraft, pool])

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

  const toggleThinking = useCallback((id: string) => {
    setExpandedThinking((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  /** Full tool execution lives in the card modal, never in the inline row. */
  const openToolDetail = useCallback((card: ToolCard, path?: string) => {
    setDetail({ kind: 'tool', card, path })
  }, [])

  /** Reasoning detail entry for the card modal. */
  const openThinkingDetail = useCallback(
    (entry: { id: string; text: string; durationMs?: number; running: boolean }) => {
      setDetail({ kind: 'thinking', ...entry })
    },
    [],
  )

  /**
   * Bulk control: opening unfolds the group and every reasoning body by
   * default; collapsing also resets the reasoning bodies.
   */
  const toggleGroupAll = useCallback(
    (groupId: string, entries: TraceEntry[], expand: boolean) => {
      const thinkingIds = entries.flatMap((entry) => (entry.kind === 'thinking' ? [entry.id] : []))
      if (expand) {
        setExpandedThinking((prev) => {
          const next = new Set(prev)
          for (const id of thinkingIds) next.add(id)
          return next
        })
        setExpandedGroups((prev) => new Set(prev).add(groupId))
        return
      }
      setExpandedThinking((prev) => {
        const next = new Set(prev)
        for (const id of thinkingIds) next.delete(id)
        return next
      })
      setExpandedGroups((prev) => {
        const next = new Set(prev)
        next.delete(groupId)
        return next
      })
    },
    [],
  )

  /** Step one: show the impact surface instead of rolling back immediately. */
  const requestUndo = useCallback(
    (item: Bubble, changes: TurnFileChange[]) => {
      // The rewind needs a persisted message id; drafts have nothing to clear.
      if (
        changes.length === 0 ||
        !/^m-\d+$/.test(item.id) ||
        undoing ||
        streaming ||
        loading ||
        editBusy
      ) {
        return
      }
      setUndoTarget({ item, changes })
    },
    [editBusy, loading, streaming, undoing],
  )

  /**
   * Step two: restore every file, clear the turn and everything after it,
   * then put the original user input back into the composer.
   */
  const confirmUndo = useCallback(async () => {
    const target = undoTarget
    if (!target || undoing) return
    setUndoTarget(null)
    setUndoing(true)
    const restored: string[] = []
    const removed: string[] = []
    try {
      for (const change of target.changes) {
        if (change.created) {
          await api.trashDocByPath(change.path)
          removed.push(change.path)
        } else if (change.rev === null) {
          await api.restorePreviousDocRevision(change.path)
          restored.push(change.path)
        } else {
          await api.restoreDocRevision(change.path, change.rev)
          restored.push(change.path)
        }
      }
      await runtime.rewindTo(target.item.id)
      setItems(runtime.snapshot().items)
      setInput(target.item.text)
      // Refresh the drawer counts without blocking the receipt on failure.
      void chatApi.list().then(setConversations).catch(() => {})
      // Restore attachments too; a failed asset read must not block the receipt.
      const assetIds = target.item.imageAssetIds ?? []
      setAttachmentList([])
      if (assetIds.length > 0) {
        const urls = await Promise.all(assetIds.map((id) => assetDataUrl(id).catch(() => '')))
        setAttachmentList(
          assetIds.flatMap((id, index) => {
            const url = urls[index]
            return url ? [{ id, url, size: 0 }] : []
          }),
        )
      }
      setUndoReceipt({ restored, removed })
    } catch (error) {
      toast(friendlyError(error))
    } finally {
      setUndoing(false)
    }
  }, [runtime, setAttachmentList, undoing, undoTarget])

  /** Closing the receipt returns focus to the recalled input. */
  const closeUndoReceipt = useCallback(() => {
    setUndoReceipt(null)
    requestAnimationFrame(() => inputElRef.current?.focus())
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
        // Deleting is an explicit stop: close out the run (persisting its
        // partial answer) before the conversation rows disappear.
        await pool.close(id)
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
    [conversations, openConversation, openDraft, pool],
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

  /** Open the conversation list as a popover anchored to its header button. */
  const computeConvAnchor = useCallback((): { top: number; left: number } | null => {
    const trigger = convTriggerRef.current
    if (!trigger) return null
    const rect = trigger.getBoundingClientRect()
    const viewport = window.innerWidth
    const width = Math.min(340, viewport - 24)
    // The popover opens down-right from the button. Clamp the left edge so the
    // panel can never run off either side of the viewport (the old
    // right-anchored placement pushed the list past the left edge on phones).
    const left = Math.max(12, Math.min(rect.left, viewport - width - 12))
    return { top: rect.bottom + 8, left }
  }, [])

  const openConversationList = useCallback(() => {
    const anchor = computeConvAnchor()
    if (anchor) setConvAnchor(anchor)
    setDrawerOpen(true)
  }, [computeConvAnchor])

  // Keep the popover under its trigger when the viewport or keyboard changes.
  useEffect(() => {
    if (!drawerOpen) return
    const update = () => {
      const anchor = computeConvAnchor()
      if (anchor) setConvAnchor(anchor)
    }
    const vv = window.visualViewport
    window.addEventListener('resize', update)
    vv?.addEventListener('resize', update)
    return () => {
      window.removeEventListener('resize', update)
      vv?.removeEventListener('resize', update)
    }
  }, [drawerOpen, computeConvAnchor])

  // Hardware back dismisses the popover instead of leaving the page.
  usePhysicalBack(() => setDrawerOpen(false), drawerOpen)

  /** Fade only the edges that still hide content. */
  const syncConvEdges = useCallback(() => {
    const el = convScrollRef.current
    if (!el) {
      setConvEdges({ top: false, bottom: false })
      return
    }
    const top = el.scrollTop > 2
    const bottom = el.scrollTop + el.clientHeight < el.scrollHeight - 2
    setConvEdges((prev) => (prev.top === top && prev.bottom === bottom ? prev : { top, bottom }))
  }, [])

  // Re-measure the popover's scroll edges on open and whenever its content or
  // viewport changes (new rows, keyboard, rotation).
  useEffect(() => {
    if (!drawerOpen) return
    syncConvEdges()
    const el = convScrollRef.current
    if (!el) return
    const observer = new ResizeObserver(syncConvEdges)
    observer.observe(el)
    if (el.firstElementChild) observer.observe(el.firstElementChild)
    return () => observer.disconnect()
  }, [drawerOpen, conversations.length, syncConvEdges])

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
  const chatBusy = streaming || loading || editBusy || undoing

  // Stable 1-based numbering for the visible tool-call chain (trace audit).
  const toolSteps = new Map<string, number>()
  let toolStep = 0
  for (const item of items) {
    if (item.kind !== 'tool') continue
    toolStep += 1
    toolSteps.set(item.id, toolStep)
  }

  // The reply still receiving deltas; its reasoning body follows the tail.
  const liveTraceId =
    items.find((item) => item.kind === 'assistant' && item.streaming)?.id ?? null

  const blocks = useMemo(() => buildChatBlocks(items), [items])

  return (
    <div className={`page chat-page ${expanded ? 'expanded' : ''}`}>
      <PageHeader
        title="对话"
        actions={[
          {
            icon: <IconChat size={22} />,
            label: '会话列表',
            ref: convTriggerRef,
            onClick: openConversationList,
          },
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
            blocks.map((block) => {
              if (block.kind === 'user') {
                const item = block.item
                return (
                  <div key={item.id} className="chat-row user">
                    <div className="chat-row-body">
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
                            ...(block.changes.length > 0
                              ? [
                                  {
                                    key: 'undo',
                                    label: '撤回本轮改动',
                                    icon: <IconRewind size={15} />,
                                    disabled: chatBusy || !/^m-\d+$/.test(item.id),
                                    onClick: () => requestUndo(item, block.changes),
                                  },
                                ]
                              : []),
                          ]}
                        />
                      )}
                    </div>
                  </div>
                )
              }

              const item = block.item
              // Settled replies carry their usage and trace summary.
              const usage = item?.usage ?? null
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
              const firstTrace = block.trace[0]
              const traceKey = firstTrace
                ? firstTrace.kind === 'thinking'
                  ? firstTrace.id
                  : firstTrace.card.id
                : 'end'
              const groupId = item?.id ?? traceKey
              const groupOpen = expandedGroups.has(groupId)
              return (
                <div
                  key={item?.id ?? `trace-${traceKey}`}
                  className="chat-row assistant"
                >
                  <div className="chat-row-body">
                    {block.trace.length > 0 && (
                      <TraceGroup
                        groupId={groupId}
                        entries={block.trace}
                        toolSteps={toolSteps}
                        open={groupOpen}
                        expandedThinking={expandedThinking}
                        liveTraceId={liveTraceId}
                        onToggleAll={(id, expand) =>
                          toggleGroupAll(id, block.trace, expand)
                        }
                        onToggleThinking={toggleThinking}
                        onOpenTool={openToolDetail}
                        onOpenThinking={openThinkingDetail}
                      />
                    )}
                    {item && item.text !== '' && (
                      // 分流点：Bubble.text 是 text part，走 Markdown；工具
                      // 调用/结果在上面的 TraceGroup 分支，二者不混染。
                      <div
                        className={`chat-bubble assistant ${item.isError ? 'error' : ''} ${
                          item.isError ? '' : 'markdown'
                        }`}
                      >
                        {item.isError ? item.text : <ChatMarkdown text={item.text} />}
                      </div>
                    )}
                    {item && !item.streaming && item.text !== '' && (
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
                  </div>
                </div>
              )
            })
          )}
        </div>

        {turns.length > 0 && (
          // Tap opens the turn index; drag scrubs. The 44px lane is the touch
          // target, with the visible pill centered inside it.
          <button
            ref={railRef}
            type="button"
            className="chat-minimap"
            style={{ height: railHeight }}
            aria-label="消息索引"
            aria-haspopup="dialog"
            aria-expanded={railOpen}
            onClick={onRailClick}
            onPointerDown={onRailPointerDown}
            onPointerMove={onRailPointerMove}
            onPointerUp={onRailPointerEnd}
            onPointerCancel={onRailPointerEnd}
          >
            <div className="chat-minimap-track">
              {railDots.map((turnIndex, dotIndex) => (
                <span
                  key={turns[turnIndex].id}
                  className="chat-minimap-dot"
                  style={{ top: RAIL_PAD + dotIndex * RAIL_DOT_GAP }}
                />
              ))}
              {activeDotIndex >= 0 && (
                <span
                  className="chat-minimap-thumb"
                  style={{ top: RAIL_PAD + activeDotIndex * RAIL_DOT_GAP }}
                />
              )}
            </div>
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

        {/* Anchored to the transcript viewport: the composer, queue bar and
            tabbar live outside it, so they can never cover the button. */}
        {scrollBottomVisible && (
          <button
            type="button"
            className="chat-scroll-bottom"
            aria-label="回到底部"
            onClick={scrollToBottomSmooth}
          >
            ↓
          </button>
        )}
      </div>

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

      {drawerOpen && convAnchor && (
        // Portaled: the pager track is a transformed stacking context, so an
        // in-page popover would paint beneath the tabbar. Viewport coordinates
        // from the header button anchor it under that trigger.
        <OverlayPortal>
          <div className="popover-backdrop" onClick={() => setDrawerOpen(false)} />
          <div
            className="chat-conv-popover"
            role="dialog"
            aria-label="会话列表"
            style={
              {
                top: convAnchor.top,
                left: convAnchor.left,
                // The CSS max-height subtracts this anchor offset so the
                // popover always fits between the header and the safe area.
                '--conv-top': `${convAnchor.top}px`,
              } as React.CSSProperties
            }
          >
            <div className="chat-conv-popover-head">会话列表</div>
            <div className="chat-conv-body">
              <div
                className="chat-conv-scroll"
                ref={convScrollRef}
                onScroll={syncConvEdges}
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
            </div>
            {convEdges.top && <span className="chat-conv-fade top" aria-hidden="true" />}
            {convEdges.bottom && <span className="chat-conv-fade bottom" aria-hidden="true" />}
          </div>
        </div>
        </OverlayPortal>
      )}

      {detail && (
        <TraceDetailModal
          key={
            detail.kind === 'tool' ? `${detail.card.id}:${detail.path ?? ''}` : detail.id
          }
          target={detail}
          onClose={() => setDetail(null)}
        />
      )}

      {undoTarget && (
        <ConfirmDialog
          title="撤回本轮改动"
          message="文件会回滚到本轮开始前，随后清空这段对话历史。"
          confirmText="撤回并清空"
          danger
          icon={<IconRewind size={22} />}
          detail={<UndoImpact changes={undoTarget.changes} />}
          onConfirm={() => void confirmUndo()}
          onCancel={() => setUndoTarget(null)}
        />
      )}

      {undoReceipt && (
        <Modal
          title="撤回完成"
          onClose={closeUndoReceipt}
          footer={
            <button type="button" className="btn btn-primary" onClick={closeUndoReceipt}>
              好的
            </button>
          }
        >
          <div className="undo-receipt">
            <p className="undo-receipt-lead">
              本轮改动已回滚，对话历史已清空，原始输入已回填到输入框。
            </p>
            <UndoImpactGroup
              title={`已还原 · ${undoReceipt.restored.length}`}
              paths={undoReceipt.restored}
              empty="没有需要还原的文件"
            />
            <UndoImpactGroup
              title={`已移除新建 · ${undoReceipt.removed.length}`}
              paths={undoReceipt.removed}
              empty="没有新建文件"
            />
          </div>
        </Modal>
      )}
    </div>
  )
}
