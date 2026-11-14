//! Pure projection behaviour: close-out on cancel, tool cards, history folding.

import { describe, expect, it } from 'vitest'
import type { AgentEvent, AgentMessage } from '@earendil-works/pi-agent-core'
import type { AssistantMessage } from '@earendil-works/pi-ai'
import {
  beginPrompt,
  createView,
  documentPaths,
  documentRev,
  project,
  reduceEvent,
  turnFileChanges,
  type ChatView,
  type Bubble,
  type Item,
  type ToolCard,
  type ViewEffect,
} from './chatView'
import type { ChatMessageRecord } from '../types'

function assistant(text: string, stopReason: 'stop' | 'aborted' | 'error'): AssistantMessage {
  return {
    role: 'assistant',
    content: text === '' ? [] : [{ type: 'text', text }],
    api: 'openai-completions',
    provider: 'test',
    model: 'test-model',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: Date.now(),
  } as AssistantMessage
}

function user(text: string): AgentMessage {
  return {
    role: 'user',
    content: [{ type: 'text', text }],
    timestamp: Date.now(),
  } as AgentMessage
}

function fold(events: AgentEvent[], initial: ChatView = createView([])) {
  let view = initial
  const effects: ViewEffect[] = []
  for (const event of events) {
    const result = reduceEvent(view, event, () => 0)
    view = result.view
    effects.push(...result.effects)
  }
  return { view, effects }
}

function record(partial: Partial<ChatMessageRecord> & { id: number }): ChatMessageRecord {
  const base: ChatMessageRecord = {
    id: partial.id,
    role: 'user',
    content: '',
    toolCalls: null,
    toolCallId: null,
    toolName: null,
    isError: false,
    usage: null,
    thinking: null,
    thinkingSignature: null,
    runId: null,
    toolArgs: null,
    toolDurationMs: null,
    isPartial: false,
    stopReason: null,
    steerOfRun: null,
    imageAssetIds: [],
    createdAt: '2026-01-01 00:00:00',
  }
  return { ...base, ...partial }
}

describe('cancelled close-out', () => {
  it('settles the in-flight bubble instead of opening an empty one', () => {
    const delta: AgentEvent = {
      type: 'message_update',
      message: user('ignored'),
      assistantMessageEvent: {
        type: 'text_delta',
        contentIndex: 0,
        delta: '部分',
        partial: assistant('部分', 'stop'),
      },
    }

    const { view, effects } = fold(
      [
        { type: 'message_start', message: user('问') },
        { type: 'message_end', message: user('问') },
        { type: 'message_start', message: assistant('', 'stop') },
        delta,
        // Synthetic terminal message pi emits after an abort.
        { type: 'message_start', message: assistant('', 'aborted') },
        { type: 'message_end', message: assistant('', 'aborted') },
        { type: 'agent_end', messages: [] },
      ],
      beginPrompt(createView([])),
    )

    const replies = view.items.filter((item): item is Bubble => item.kind === 'assistant')
    expect(replies).toHaveLength(1)
    expect(replies[0].text).toBe('部分')
    expect(replies[0].streaming).toBe(false)
    expect(replies[0].cancelled).toBe(true)
    expect(view.streamingId).toBeNull()

    const persisted = effects.filter((effect) => effect.kind === 'persist-assistant')
    expect(persisted).toHaveLength(1)
    expect(persisted[0].kind === 'persist-assistant' && persisted[0].text).toBe('部分')
  })
})

describe('tool cards', () => {
  it('appends a new card without dropping earlier items', () => {
    const { view } = fold([
      { type: 'message_start', message: user('问') },
      { type: 'message_start', message: assistant('', 'stop') },
      { type: 'tool_execution_start', toolCallId: 'c1', toolName: 'fs_read', args: {} },
    ])

    expect(view.items.map((item) => item.kind)).toEqual(['user', 'assistant', 'tool'])
  })

  it('marks a failed tool and exposes the final text', () => {
    const { view, effects } = fold([
      { type: 'tool_execution_start', toolCallId: 'c1', toolName: 'fs_read', args: { path: '/life/a.md' } },
      {
        type: 'tool_execution_end',
        toolCallId: 'c1',
        toolName: 'fs_read',
        result: { content: [{ type: 'text', text: '路径越界' }], details: {} },
        isError: true,
      },
    ])

    const cards = view.items.filter((item) => item.kind === 'tool')
    expect(cards).toHaveLength(1)
    expect(cards[0].status).toBe('error')
    expect(cards[0].text).toBe('路径越界')
    expect(cards[0].durationMs).toBe(0)

    const persisted = effects.filter((effect) => effect.kind === 'persist-tool')
    expect(persisted).toHaveLength(1)
    expect(persisted[0].kind === 'persist-tool' && persisted[0].isError).toBe(true)
  })

  it('shows a completed card even when the start event was missed', () => {
    const { view } = fold([
      {
        type: 'tool_execution_end',
        toolCallId: 'c9',
        toolName: 'fs_write',
        result: { content: [{ type: 'text', text: '已写入' }], details: {} },
        isError: false,
      },
    ])

    const card = view.items.find((item) => item.kind === 'tool')
    expect(card?.kind === 'tool' && card.status).toBe('done')
    expect(card?.kind === 'tool' && card.text).toBe('已写入')
    expect(card?.kind === 'tool' && card.unfinished).toBeUndefined()
  })

  it('keeps a repeated provider call id in its own assistant round', () => {
    // Some providers synthesize `call_0` per response; the second round must
    // append a card instead of rewriting the first round's card in place.
    const { view } = fold([
      { type: 'message_start', message: user('问') },
      { type: 'message_start', message: assistant('', 'stop') },
      { type: 'tool_execution_start', toolCallId: 'call_0', toolName: 'fs_read', args: {} },
      {
        type: 'tool_execution_end',
        toolCallId: 'call_0',
        toolName: 'fs_read',
        result: { content: [{ type: 'text', text: '第一次' }], details: {} },
        isError: false,
      },
      { type: 'message_start', message: assistant('', 'stop') },
      { type: 'tool_execution_start', toolCallId: 'call_0', toolName: 'fs_read', args: {} },
      {
        type: 'tool_execution_end',
        toolCallId: 'call_0',
        toolName: 'fs_read',
        result: { content: [{ type: 'text', text: '第二次' }], details: {} },
        isError: false,
      },
    ])

    const cards = view.items.filter((item) => item.kind === 'tool')
    expect(cards).toHaveLength(2)
    expect(cards[0].kind === 'tool' && cards[0].text).toBe('第一次')
    expect(cards[1].kind === 'tool' && cards[1].text).toBe('第二次')
    expect(cards.every((card) => card.kind === 'tool' && card.status === 'done')).toBe(true)
  })

  it('keeps a reasoning-only reply instead of deleting the bubble', () => {
    const reply = assistant('', 'stop')
    reply.content = [{ type: 'thinking', thinking: '只思考' }]

    const { view } = fold([
      { type: 'message_start', message: user('问') },
      { type: 'message_start', message: reply },
      { type: 'message_end', message: reply },
    ])

    const replies = view.items.filter((item): item is Bubble => item.kind === 'assistant')
    expect(replies).toHaveLength(1)
    expect(replies[0].thinking).toBe('只思考')
    expect(replies[0].streaming).toBe(false)
  })
})

/** Minimal write/edit card carrying the same result text the tool persists. */
function writeCard(id: string, path: string, rev: number, toolName = 'fs_edit'): ToolCard {
  return {
    id,
    kind: 'tool',
    toolName,
    args: JSON.stringify({ path }),
    status: 'done',
    text: `已更新 ${path}（rev=${rev}）`,
  }
}

describe('turn file changes', () => {
  it('parses the revision from a persisted result', () => {
    expect(documentRev(writeCard('t1', '/life/a.md', 4))).toBe(4)
    expect(documentRev({ ...writeCard('t2', '/life/a.md', 4), text: '读取完成' })).toBeNull()
  })

  it('keeps the earliest revision per path and stops at the next turn', () => {
    const items: Item[] = [
      { id: 'u1', kind: 'user', text: '第一轮' },
      writeCard('t1', '/life/a.md', 5),
      writeCard('t2', '/life/b.md', 2),
      writeCard('t3', '/life/a.md', 6),
      { id: 'u2', kind: 'user', text: '第二轮' },
      writeCard('t4', '/life/c.md', 1, 'fs_write'),
    ]

    expect(turnFileChanges(items, 0)).toEqual([
      { path: '/life/a.md', rev: 5, created: false, calls: 2, tools: ['fs_edit'] },
      { path: '/life/b.md', rev: 2, created: false, calls: 1, tools: ['fs_edit'] },
    ])
    expect(turnFileChanges(items, 4)).toEqual([
      { path: '/life/c.md', rev: 1, created: true, calls: 1, tools: ['fs_write'] },
    ])
  })

  it('flags a document as created when any write in the turn created it', () => {
    const items: Item[] = [
      { id: 'u1', kind: 'user', text: '本轮新建后编辑' },
      // Card order can surface the edit first; the creation still belongs here.
      writeCard('t1', '/life/a.md', 2, 'fs_edit'),
      writeCard('t2', '/life/a.md', 1, 'fs_write'),
    ]
    expect(turnFileChanges(items, 0)).toEqual([
      { path: '/life/a.md', rev: 1, created: true, calls: 2, tools: ['fs_edit', 'fs_write'] },
    ])
  })
})

describe('reasoning timing', () => {
  it('measures how long the thinking block streamed', () => {
    let clock = 100
    let view = beginPrompt(createView([]))
    const apply = (event: AgentEvent) => {
      view = reduceEvent(view, event, () => clock).view
    }
    const think = (text: string): AssistantMessage =>
      ({
        ...assistant('', 'stop'),
        content: [{ type: 'thinking', thinking: text }],
      }) as AssistantMessage
    apply({ type: 'message_start', message: think('') })
    apply({
      type: 'message_update',
      message: think('想'),
      assistantMessageEvent: {
        type: 'thinking_delta',
        contentIndex: 0,
        delta: '想',
        partial: think('想'),
      },
    })
    clock = 1600
    apply({
      type: 'message_update',
      message: think('想完了'),
      assistantMessageEvent: {
        type: 'thinking_end',
        contentIndex: 0,
        content: '想',
        partial: think('想完了'),
      },
    })
    const bubble = view.items.find((item): item is Bubble => item.kind === 'assistant')
    expect(bubble?.thinkingMs).toBe(1500)
    expect(bubble?.thinking).toBe('想')
  })
})

describe('tool payload paths', () => {
  it('collects multi-file arguments without duplicates or content noise', () => {
    const card: ToolCard = {
      id: 't1',
      kind: 'tool',
      toolName: 'fs_edit',
      args: JSON.stringify({ paths: ['/life/a.md', '/life/b.md'] }),
      status: 'done',
      text: '已更新 /life/a.md，另见 /life/c.md',
    }
    expect(documentPaths(card)).toEqual(['/life/a.md', '/life/b.md'])
  })

  it('falls back to result text for searches and unparsable arguments', () => {
    const search: ToolCard = {
      id: 't2',
      kind: 'tool',
      toolName: 'fs_grep',
      args: '{}',
      status: 'done',
      text: '/life/a.md: 命中\n/life/b.md: 命中',
    }
    expect(documentPaths(search)).toEqual(['/life/a.md', '/life/b.md'])
    expect(documentPaths({ ...search, id: 't3', toolName: 'fs_read', args: 'not json' })).toEqual([
      '/life/a.md',
      '/life/b.md',
    ])
  })
})

describe('history projection', () => {
  it('folds records without inventing rows', () => {
    const records: ChatMessageRecord[] = [
      record({ id: 1, role: 'user', content: '看图' }),
      record({ id: 2, role: 'assistant', content: '' }),
      record({ id: 3, role: 'assistant', content: '这是图' }),
      record({ id: 4, role: 'tool', content: '读取完成', toolName: 'fs_read' }),
    ]

    const items = project({ records, events: [] })

    expect(items.map((item) => item.kind)).toEqual(['user', 'assistant', 'tool'])
    expect(items[0].kind === 'user' && items[0].text).toBe('看图')
    expect(items[1].kind === 'assistant' && items[1].text).toBe('这是图')
    expect(items[2].kind === 'tool' && items[2].status).toBe('done')
  })

  it('hydrates the assistant tool-call payload and merges its result row', () => {
    const records: ChatMessageRecord[] = [
      record({ id: 1, role: 'user', content: '改文件' }),
      record({
        id: 2,
        role: 'assistant',
        content: '',
        toolCalls: JSON.stringify([
          {
            type: 'toolCall',
            id: 'call_1',
            name: 'fs_read',
            arguments: { path: '/life/a.md' },
          },
        ]),
      }),
      record({
        id: 3,
        role: 'tool',
        content: '读取完成',
        toolCallId: 'call_1',
        toolName: 'fs_read',
        toolArgs: '{"path":"/life/a.md"}',
        toolDurationMs: 30,
      }),
      record({ id: 4, role: 'assistant', content: '完成' }),
    ]

    const items = project({ records, events: [] })
    expect(items.map((item) => item.kind)).toEqual(['user', 'tool', 'assistant'])
    const card = items[1]
    expect(card.kind === 'tool' && card.callId).toBe('call_1')
    expect(card.kind === 'tool' && card.status).toBe('done')
    expect(card.kind === 'tool' && card.args).toBe('{"path":"/life/a.md"}')
    expect(card.kind === 'tool' && card.unfinished).toBe(false)
  })

  it('keeps an invocation visible when its result row is missing', () => {
    const records: ChatMessageRecord[] = [
      record({ id: 1, role: 'user', content: '查一下' }),
      record({
        id: 2,
        role: 'assistant',
        content: '',
        toolCalls: JSON.stringify([
          { type: 'toolCall', id: 'call_2', name: 'fs_glob', arguments: {} },
        ]),
      }),
    ]

    const items = project({ records, events: [] })
    const card = items.find((item) => item.kind === 'tool')
    expect(card?.kind === 'tool' && card.callId).toBe('call_2')
    expect(card?.kind === 'tool' && card.status).toBe('running')
    expect(card?.kind === 'tool' && card.unfinished).toBe(true)
  })

  it('restores tool arguments and duration from persisted rows', () => {
    const records: ChatMessageRecord[] = [
      record({ id: 1, role: 'user', content: '改文件' }),
      record({
        id: 2,
        role: 'tool',
        content: '已写入',
        toolName: 'fs_write',
        toolArgs: '{"path":"/life/a.md"}',
        toolDurationMs: 1200,
      }),
      record({ id: 3, role: 'assistant', content: '改好了' }),
    ]

    const items = project({ records, events: [] })
    const card = items.find((item) => item.kind === 'tool')
    expect(card?.kind === 'tool' && card.args).toBe('{"path":"/life/a.md"}')
    expect(card?.kind === 'tool' && card.durationMs).toBe(1200)
  })

  it('pairs repeated provider call ids with their own result rows', () => {
    // Providers that omit ids get synthesized `call_0`-style ids, so the same
    // call id can appear in several turns; results must pair newest-first.
    const records: ChatMessageRecord[] = [
      record({ id: 1, role: 'user', content: '第一轮' }),
      record({
        id: 2,
        role: 'assistant',
        content: '',
        toolCalls: JSON.stringify([
          { type: 'toolCall', id: 'call_0', name: 'fs_write', arguments: { path: '/life/a.md' } },
        ]),
      }),
      record({
        id: 3,
        role: 'tool',
        content: '第一次完成',
        toolCallId: 'call_0',
        toolName: 'fs_write',
      }),
      record({ id: 4, role: 'assistant', content: '第一轮完成' }),
      record({ id: 5, role: 'user', content: '第二轮' }),
      record({
        id: 6,
        role: 'assistant',
        content: '',
        toolCalls: JSON.stringify([
          { type: 'toolCall', id: 'call_0', name: 'fs_write', arguments: { path: '/life/b.md' } },
        ]),
      }),
      record({
        id: 7,
        role: 'tool',
        content: '第二次完成',
        toolCallId: 'call_0',
        toolName: 'fs_write',
      }),
      record({ id: 8, role: 'assistant', content: '第二轮完成' }),
    ]

    const items = project({ records, events: [] })
    const cards = items.filter((item) => item.kind === 'tool')
    expect(cards).toHaveLength(2)
    expect(cards.every((card) => card.kind === 'tool' && card.status === 'done')).toBe(true)
    expect(cards.every((card) => card.kind === 'tool' && card.unfinished === false)).toBe(true)
    // Item ids stay unique even though the provider call id repeats.
    expect(new Set(items.map((item) => item.id)).size).toBe(items.length)
    expect(cards.map((card) => (card.kind === 'tool' ? card.text : ''))).toEqual([
      '第一次完成',
      '第二次完成',
    ])
  })

  it('pairs a result row persisted before its invocation', () => {
    const records: ChatMessageRecord[] = [
      record({ id: 1, role: 'user', content: '写文件' }),
      record({ id: 2, role: 'tool', content: '已写入', toolCallId: 'call_7', toolName: 'fs_write' }),
      record({
        id: 3,
        role: 'assistant',
        content: '',
        toolCalls: JSON.stringify([
          { type: 'toolCall', id: 'call_7', name: 'fs_write', arguments: { path: '/life/a.md' } },
        ]),
      }),
      record({ id: 4, role: 'assistant', content: '完成' }),
    ]

    const items = project({ records, events: [] })
    const cards = items.filter((item) => item.kind === 'tool')
    expect(cards).toHaveLength(1)
    expect(cards[0].kind === 'tool' && cards[0].status).toBe('done')
    expect(cards[0].kind === 'tool' && cards[0].unfinished).toBe(false)
    expect(cards[0].kind === 'tool' && cards[0].text).toBe('已写入')
  })
})

describe('tool duration', () => {
  it('reports whole milliseconds so the result row can be persisted', () => {
    let clock = 10.25
    const now = () => clock
    let view = createView([])
    view = reduceEvent(
      view,
      {
        type: 'tool_execution_start',
        toolCallId: 'c1',
        toolName: 'fs_read',
        args: { path: '/life/a.md' },
      },
      now,
    ).view
    clock = 10.9
    view = reduceEvent(
      view,
      {
        type: 'tool_execution_end',
        toolCallId: 'c1',
        toolName: 'fs_read',
        result: { content: [{ type: 'text', text: '读取完成' }], details: {} },
        isError: false,
      },
      now,
    ).view

    const card = view.items.find((item) => item.kind === 'tool')
    expect(card?.kind === 'tool' && card.durationMs).toBe(1)
  })
})
