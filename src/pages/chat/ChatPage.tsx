//! 对话页：pi-agent 事件的流式渲染 + 工具卡片 + 会话管理。
//!
//! 渲染策略（D9）：流式阶段纯文本；`message_end` 后也只展示纯文本，
//! 不使用 `dangerouslySetInnerHTML`，模型输出不经过任何 HTML 解析。

import { useCallback, useEffect, useRef, useState } from 'react'
import { api, chatApi, skillApi } from '../../api'
import { createAgent, extractAssistant, profileFromSettings, toAgentMessages } from '../../agent/runtime'
import type { AgentProfile } from '../../agent/runtime'
import { buildSkillsIndex } from '../../agent/skills'
import type { AgentEvent } from '@earendil-works/pi-agent-core'
import type { AgentSettings, ChatConversation, ChatMessageRecord, SkillSummary } from '../../types'
import { friendlyError } from '../../utils'
import { toast } from '../../toast'
import { Modal } from '../../components/ui'
import PageHeader from '../../components/PageHeader'
import EmptyState from '../../components/EmptyState'
import {
  IconChat,
  IconEdit,
  IconEye,
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

function recordsToItems(records: ChatMessageRecord[]): Item[] {
  const items: Item[] = []
  for (const record of records) {
    if (record.role === 'user') {
      items.push({ id: `m-${record.id}`, kind: 'user', text: record.content })
    } else if (record.role === 'assistant') {
      if (record.content.trim() === '') continue
      items.push({
        id: `m-${record.id}`,
        kind: 'assistant',
        text: record.content,
        isError: record.isError,
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
  return items
}

function toolResultText(result: unknown): string {
  const value = result as { content?: Array<{ text?: string }> } | null
  if (!value?.content) return ''
  return value.content.map((block) => block.text ?? '').join('\n')
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
  // Tool start timestamps for the trace duration badge.
  const toolStartRef = useRef(new Map<string, number>())
  const scrollRef = useRef<HTMLDivElement>(null)
  const bootRef = useRef(false)
  // 落库串行化：assistant 消息必须先于其 toolResult 写入，否则历史无法还原。
  const persistQueueRef = useRef<Promise<unknown>>(Promise.resolve())

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
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
    (text: string, toolCalls: string | null, isError = false) => {
      const convId = conversationRef.current?.id
      if (!convId) return
      if (text.trim() === '' && toolCalls === null) return
      void enqueuePersist(() =>
        chatApi.append({
          conversationId: convId,
          messages: [{ role: 'assistant', content: text, toolCalls, isError }],
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
          if (event.message.role !== 'assistant') return
          const id = messageKey('a')
          streamingIdRef.current = id
          setItems((prev) => [...prev, { id, kind: 'assistant', text: '', streaming: true }])
          scrollToBottom()
          break
        }
        case 'message_update': {
          if (event.assistantMessageEvent.type !== 'text_delta') return
          const id = streamingIdRef.current
          const delta = event.assistantMessageEvent.delta
          if (!id) return
          setItems((prev) =>
            prev.map((item) =>
              item.id === id && item.kind === 'assistant'
                ? { ...item, text: item.text + delta }
                : item,
            ),
          )
          scrollToBottom()
          break
        }
        case 'message_end': {
          if (event.message.role !== 'assistant') return
          const message = event.message
          const id = streamingIdRef.current
          const { text, toolCalls } = extractAssistant(message)
          const failed = message.stopReason === 'error' || message.stopReason === 'aborted'
          const shown = failed
            ? message.stopReason === 'aborted'
              ? '已取消'
              : `${onlineRef.current ? '' : '当前处于离线模式，'}回答失败：${message.errorMessage ?? '未知错误'}`
            : text
          setItems((prev) => {
            if (shown.trim() === '') return prev.filter((item) => item.id !== id)
            return prev.map((item) =>
              item.id === id && item.kind === 'assistant'
                ? { ...item, text: shown, streaming: false, isError: failed }
                : item,
            )
          })
          streamingIdRef.current = null
          settledRef.current = true
          if (failed) setNetworkIssue(networkFailure(message.errorMessage ?? ''))
          else setNetworkIssue(false)
          // Failure/cancel bubbles are persisted too, so reloads keep the last state.
          persistAssistant(failed ? shown : text, failed ? null : toolCalls, failed)
          scrollToBottom()
          break
        }
        case 'tool_execution_start': {
          toolStartRef.current.set(event.toolCallId, performance.now())
          setItems((prev) => [
            ...prev,
            {
              id: event.toolCallId,
              kind: 'tool',
              toolName: event.toolName,
              args: JSON.stringify(event.args ?? {}),
              status: 'running',
              text: '',
            },
          ])
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
          setStreaming(false)
          break
        }
        default:
          break
      }
    },
    [persistAssistant, persistTool, scrollToBottom],
  )

  const disposeAgent = useCallback(() => {
    agentRef.current?.abort()
    unsubscribeRef.current?.()
    unsubscribeRef.current = null
    agentRef.current = null
    // 中断旧流后立即复位发送状态：abort 产生的 agent_end 会因退订而丢失，不能再依赖它。
    streamingIdRef.current = null
    setStreaming(false)
  }, [])

  const openConversation = useCallback(
    async (conv: ChatConversation) => {
      disposeAgent()
      conversationRef.current = conv
      setConversation(conv)
      setLoading(true)
      try {
        const records = await chatApi.messages(conv.id)
        setItems(recordsToItems(records))
        // 优先使用会话记录里的模型条目；该条目被删除后回退到当前激活模型。
        const current = settingsRef.current
        const baseProfile = current
          ? profileFromSettings(current, conv.provider, conv.model)
          : null
        if (!baseProfile) {
          // 没有可用模型时仍可查看历史，只是不能发送。
          return
        }
        const activeProfile = await withCapabilities(baseProfile)
        setContextWindow(activeProfile.contextWindow ?? 128000)
        const agent = createAgent(
          activeProfile,
          toAgentMessages(records, activeProfile),
          buildSkillsIndex(skillsRef.current),
          skillsRef.current,
        )
        unsubscribeRef.current = agent.subscribe((event) => {
          handleEvent(event)
        })
        agentRef.current = agent
      } catch (e) {
        toast(friendlyError(e))
      } finally {
        setLoading(false)
        scrollToBottom()
        setScrollBottomVisible(false)
      }
    },
    [disposeAgent, handleEvent, scrollToBottom],
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
    async (text: string) => {
      if (!text || streaming) return
      const agent = agentRef.current
      const conv = conversationRef.current
      if (!agent || !conv) {
        toast('会话尚未就绪')
        return
      }
      settledRef.current = false
      setInput('')
      setItems((prev) => [...prev, { id: messageKey('u'), kind: 'user', text }])
      setStreaming(true)
      scrollToBottom()
      void ensureTitle(text)
      try {
        await enqueuePersist(() =>
          chatApi.append({
            conversationId: conv.id,
            messages: [{ role: 'user', content: text }],
          }),
        )
        // 技能正文由模型通过 load_skill 主动加载；用户消息不携带技能内容。
        await agent.prompt(text)
      } catch (e) {
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
    void submitPrompt(input.trim())
  }, [input, submitPrompt])

  const retry = useCallback(
    (messageId: string) => {
      const index = items.findIndex((item) => item.id === messageId)
      for (let i = index - 1; i >= 0; i -= 1) {
        const item = items[i]
        if (item.kind === 'user' && item.text.trim() !== '') {
          void submitPrompt(item.text)
          return
        }
      }
      toast('找不到上一条用户消息，无法重试')
    },
    [items, submitPrompt],
  )

  const toggleTool = useCallback((id: string) => {
    setExpandedTools((prev) => {
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
    agent.abort()
    void agent.waitForIdle().then(() => setStreaming(false))
  }, [])

  const newConversation = useCallback(async () => {
    if (!settings?.activeId) {
      toast('请先在设置 → AI 助理中添加并启用一个模型')
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
          items.map((item, index) => {
            const changes =
              item.kind === 'assistant' && !item.streaming ? turnChanges(items, index) : []
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
                      <div
                        className={`chat-bubble ${item.kind} ${item.isError ? 'error' : ''}`}
                      >
                        {item.text || (item.streaming ? '…' : '')}
                      </div>
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
                            onClick={() => retry(item.id)}
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
              void send()
            }
          }}
        />
        {streaming ? (
          <button type="button" className="chat-send stop" aria-label="停止" onClick={stop}>
            <IconStop size={20} />
          </button>
        ) : (
          <button
            type="button"
            className="chat-send"
            aria-label="发送"
            disabled={input.trim() === '' || !hasModel}
            onClick={() => void send()}
          >
            <IconSend size={20} />
          </button>
        )}
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
