//! 对话页：pi-agent 事件的流式渲染 + 工具卡片 + 会话管理。
//!
//! 渲染策略（D9）：流式阶段纯文本；`message_end` 后也只展示纯文本，
//! 不使用 `dangerouslySetInnerHTML`，模型输出不经过任何 HTML 解析。

import { useCallback, useEffect, useRef, useState } from 'react'
import { chatApi } from '../../api'
import { createAgent, extractAssistant, profileFromSettings, toAgentMessages } from '../../agent/runtime'
import type { AgentProfile } from '../../agent/runtime'
import type { AgentEvent } from '@earendil-works/pi-agent-core'
import type { AgentSettings, ChatConversation, ChatMessageRecord } from '../../types'
import { friendlyError } from '../../utils'
import { toast } from '../../toast'
import { Modal } from '../../components/ui'
import PageHeader from '../../components/PageHeader'
import EmptyState from '../../components/EmptyState'
import { IconChat, IconEdit, IconPlus, IconSend, IconStop, IconTrash } from '../../components/Icons'

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
}

type Item = Bubble | ToolCard

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
      items.push({ id: `m-${record.id}`, kind: 'assistant', text: record.content })
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

  const agentRef = useRef<ReturnType<typeof createAgent> | null>(null)
  const unsubscribeRef = useRef<(() => void) | null>(null)
  const conversationRef = useRef<ChatConversation | null>(null)
  const streamingIdRef = useRef<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const bootRef = useRef(false)
  // 落库串行化：assistant 消息必须先于其 toolResult 写入，否则历史无法还原。
  const persistQueueRef = useRef<Promise<unknown>>(Promise.resolve())

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [])

  const enqueuePersist = useCallback(<T,>(task: () => Promise<T>): Promise<T> => {
    const next = persistQueueRef.current.then(task)
    persistQueueRef.current = next.catch((e) => {
      console.error('保存 Agent 消息失败', e)
    })
    return next
  }, [])

  const persistAssistant = useCallback(
    (text: string, toolCalls: string | null) => {
      const convId = conversationRef.current?.id
      if (!convId) return
      if (text.trim() === '' && toolCalls === null) return
      void enqueuePersist(() =>
        chatApi.append({
          conversationId: convId,
          messages: [{ role: 'assistant', content: text, toolCalls }],
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
              : `回答失败：${message.errorMessage ?? '未知错误'}`
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
          if (!failed) persistAssistant(text, toolCalls)
          scrollToBottom()
          break
        }
        case 'tool_execution_start': {
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
          setItems((prev) =>
            prev.map((item) =>
              item.id === event.toolCallId && item.kind === 'tool'
                ? { ...item, status: event.isError ? 'error' : 'done', text }
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
        const agent = createAgent(activeProfile, toAgentMessages(records, activeProfile))
        unsubscribeRef.current = agent.subscribe((event) => {
          handleEvent(event)
        })
        agentRef.current = agent
      } catch (e) {
        toast(friendlyError(e))
      } finally {
        setLoading(false)
        scrollToBottom()
      }
    },
    [disposeAgent, handleEvent, scrollToBottom],
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
        const next = await chatApi.settings()
        if (disposed) return
        setSettings(next)
        settingsRef.current = next
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

  const send = useCallback(async () => {
    const text = input.trim()
    if (!text || streaming) return
    const agent = agentRef.current
    const conv = conversationRef.current
    if (!agent || !conv) {
      toast('会话尚未就绪')
      return
    }
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
      await agent.prompt(text)
    } catch (e) {
      setItems((prev) => [
        ...prev,
        {
          id: messageKey('e'),
          kind: 'assistant',
          text: `发送失败：${friendlyError(e)}`,
          isError: true,
        },
      ])
      setStreaming(false)
    }
  }, [enqueuePersist, ensureTitle, input, scrollToBottom, streaming])

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

      <div className="chat-status">{modelLabel}</div>

      <div className="page-scroll chat-scroll" ref={scrollRef}>
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
          items.map((item) =>
            item.kind === 'tool' ? (
              <div key={item.id} className={`chat-tool ${item.status}`}>
                <div className="chat-tool-head">
                  <span className="chat-tool-name">{item.toolName}</span>
                  <span className="chat-tool-state">
                    {item.status === 'running'
                      ? '执行中…'
                      : item.status === 'error'
                        ? '失败'
                        : '完成'}
                  </span>
                </div>
                {item.args && item.args !== '{}' && (
                  <div className="chat-tool-args">{item.args}</div>
                )}
                {item.text && <div className="chat-tool-result">{item.text}</div>}
              </div>
            ) : (
              <div
                key={item.id}
                className={`chat-bubble ${item.kind} ${item.isError ? 'error' : ''}`}
              >
                {item.text || (item.streaming ? '…' : '')}
              </div>
            ),
          )
        )}
      </div>

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
