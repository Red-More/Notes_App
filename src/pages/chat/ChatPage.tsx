//! 对话页：pi-agent 事件的流式渲染 + 工具卡片 + 会话管理。
//!
//! 渲染策略（D9）：流式阶段纯文本；`message_end` 后也只展示纯文本，
//! 不使用 `dangerouslySetInnerHTML`，模型输出不经过任何 HTML 解析。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, chatApi } from '../../api'
import type { AgentProfile } from '../../agent/runtime'
import { profileFromSettings } from '../../agent/runtime'
import { AgentRuntime } from '../../agent/AgentRuntime'
import { createRuntimeDeps } from '../../agent/runtimeDeps'
import { documentPath, partialLength, type Item, type ToolCard } from '../../agent/chatView'
import type {
  AgentRun,
  AgentSettings,
  ChatConversation,
  MessageUsage,
} from '../../types'
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

interface DocPreview {
  path: string
  html: string
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
  // While a run is active, the composer enqueues instead of prompting.
  const [queueMode, setQueueMode] = useState<'steer' | 'followUp'>('steer')
  const [queuedCount, setQueuedCount] = useState(0)
  // Last interrupted run, restored from the ledger after a restart.
  const [interrupted, setInterrupted] = useState<AgentRun | null>(null)
  const [docPreview, setDocPreview] = useState<DocPreview | null>(null)
  const [online, setOnline] = useState(() => navigator.onLine)
  // Set after a network-looking failure; WebView's online flag is unreliable.
  const [networkIssue, setNetworkIssue] = useState(false)
  const [contextWindow, setContextWindow] = useState(0)
  const [scrollBottomVisible, setScrollBottomVisible] = useState(false)
  const [diffView, setDiffView] = useState<{ paths: string[]; title: string } | null>(null)
  // Maps an item id to its row so a timeline dot can scroll it into view.
  const rowRefs = useRef(new Map<string, HTMLDivElement>())

  // The runtime owns the Agent, the run status, the queue and write ordering.
  const runtime = useMemo(() => new AgentRuntime({ deps: createRuntimeDeps() }), [])
  const conversationRef = useRef<ChatConversation | null>(null)
  // Mirror of `online` for the snapshot listener (avoids re-subscribing).
  const onlineRef = useRef(navigator.onLine)
  const scrollRef = useRef<HTMLDivElement>(null)
  const bootRef = useRef(false)

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

  // The runtime owns every transcript mutation; the page renders its snapshot.
  useEffect(
    () =>
      runtime.subscribe((snapshot) => {
        setItems(snapshot.items)
        setStreaming(snapshot.status !== 'idle')
        setQueuedCount(snapshot.queued)
        setInterrupted(snapshot.interrupted)
        if (snapshot.error) {
          setNetworkIssue(
            snapshot.error.code === 'network' ||
              snapshot.error.code === 'timeout' ||
              snapshot.error.code === 'rate_limited',
          )
        }
        scrollToBottom()
      }),
    [runtime, scrollToBottom],
  )

  const openConversation = useCallback(
    async (conv: ChatConversation) => {
      conversationRef.current = conv
      setConversation(conv)
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
      } catch (e) {
        toast(friendlyError(e))
      } finally {
        setLoading(false)
        scrollToBottom()
        setScrollBottomVisible(false)
      }
    },
    [runtime, scrollToBottom],
  )

  const bootstrap = useCallback(async () => {
    try {
      const [nextSettings, list] = await Promise.all([chatApi.settings(), chatApi.list()])
      setSettings(nextSettings)
      settingsRef.current = nextSettings
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
        if (!conv) return
        if (!next.activeId && next.models.length === 0) {
          await runtime.dispose()
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
  }, [isActive, openConversation, runtime])

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
      if (!conversationRef.current) {
        toast('会话尚未就绪')
        return
      }
      setInput('')
      void ensureTitle(text)
      try {
        // The runtime persists the user turn, runs the loop and writes results.
        await runtime.prompt({ text })
      } catch (e) {
        // Rejected before anything was written: keep the draft for a retry.
        setInput((prev) => prev || text)
        toast(friendlyError(e))
      }
    },
    [ensureTitle, runtime, streaming],
  )

  const send = useCallback(() => {
    void submitPrompt(input.trim())
  }, [input, submitPrompt])

  /** Enqueue guidance while a run is active; the agent injects it at the next boundary. */
  const queueMessage = useCallback(() => {
    const text = input.trim()
    if (!streaming || text === '') return
    if (queueMode === 'steer') runtime.steer(text)
    else void runtime.followUp(text)
    setInput('')
    toast(queueMode === 'steer' ? '已追加，当前回复结束后生效' : '已排队，本轮结束后执行')
  }, [input, queueMode, runtime, streaming])

  /**
   * Regenerate the reply to the user turn that produced `messageId`:
   * later messages are removed from both DB and UI, then `continue()` reuses
   * the kept user turn instead of inserting a duplicate prompt.
   */
  const retry = useCallback(
    async (messageId: string) => {
      if (!conversationRef.current || streaming) return
      try {
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

  /** Continue an interrupted run: starts a `resume` ledger row, then asks. */
  const resumeRun = useCallback(() => {
    if (streaming) return
    void runtime.resume().catch((error) => toast(friendlyError(error)))
  }, [runtime, streaming])

  /** Fork the conversation up to the user turn that produced this reply. */
  const forkConversation = useCallback(
    async (assistantText: string) => {
      try {
        const created = await runtime.fork(assistantText)
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
            await runtime.dispose()
            setItems([])
            setConversation(null)
            await newConversation()
          }
        }
      } catch (e) {
        toast(friendlyError(e))
      }
    },
    [conversations, newConversation, openConversation, runtime],
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
                      {item.kind === 'user' && (
                        <div className={`chat-bubble ${item.kind} ${item.isError ? 'error' : ''}`}>
                          {item.text}
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
        {interrupted && !streaming && (
          <button type="button" className="chat-resume" onClick={resumeRun}>
            上次回答中断
            {interrupted.partial ? `（已保存 ${partialLength(interrupted.partial)} 字）` : ''}
            ，点击继续
          </button>
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
              disabled={input.trim() === '' || !hasModel}
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
