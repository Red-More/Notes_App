import { describe, expect, it } from 'vitest'
import { formatError, newPartial, processEvent, zeroUsage } from './protocol'
import type { ProxyEvent } from './protocol'

function partial() {
  return newPartial({ api: 'openai-completions', provider: 'openai', id: 'gpt-4o-mini' })
}

function textOf(message: ReturnType<typeof partial>, index: number): string {
  const block = message.content[index]
  return block && block.type === 'text' ? block.text : ''
}

describe('agent protocol bridge', () => {
  it('rebuilds streamed text into the partial message', () => {
    const message = partial()
    const start = processEvent({ type: 'start' }, message)
    expect(start?.type).toBe('start')

    processEvent({ type: 'text_start', contentIndex: 0 }, message)
    processEvent({ type: 'text_delta', contentIndex: 0, delta: '今天' }, message)
    processEvent({ type: 'text_delta', contentIndex: 0, delta: '吃了拉面' }, message)
    const end = processEvent({ type: 'text_end', contentIndex: 0 }, message)

    expect(textOf(message, 0)).toBe('今天吃了拉面')
    expect(end?.type).toBe('text_end')
  })

  it('accumulates tool call arguments until toolcall_end', () => {
    const message = partial()
    processEvent(
      { type: 'toolcall_start', contentIndex: 0, id: 'c1', toolName: 'fs_write' },
      message,
    )
    processEvent({ type: 'toolcall_delta', contentIndex: 0, delta: '{"path":' }, message)
    processEvent(
      { type: 'toolcall_delta', contentIndex: 0, delta: '"/life/diary/x.md"}' },
      message,
    )
    const end = processEvent(
      {
        type: 'toolcall_end',
        contentIndex: 0,
        toolCall: {
          type: 'toolCall',
          id: 'c1',
          name: 'fs_write',
          arguments: { path: '/life/diary/x.md' },
        },
      },
      message,
    )

    const block = message.content[0]
    expect(block?.type).toBe('toolCall')
    if (block && block.type === 'toolCall') {
      expect(block.arguments).toEqual({ path: '/life/diary/x.md' })
      expect('partialJson' in block).toBe(false)
    }
    expect(end?.type).toBe('toolcall_end')
  })

  it('marks the partial message terminal on done and error', () => {
    const message = partial()
    const done = processEvent({ type: 'done', reason: 'toolUse', usage: zeroUsage() }, message)
    expect(done?.type).toBe('done')
    expect(message.stopReason).toBe('toolUse')

    const failed = partial()
    const error = processEvent(
      {
        type: 'error',
        reason: 'error',
        errorMessage: '未配置 Key',
        usage: zeroUsage(),
      },
      failed,
    )
    expect(error?.type).toBe('error')
    expect(failed.stopReason).toBe('error')
    expect(failed.errorMessage).toBe('未配置 Key')
  })

  it('ignores deltas for missing content blocks instead of crashing', () => {
    const message = partial()
    const event: ProxyEvent = { type: 'text_delta', contentIndex: 9, delta: 'x' }
    expect(processEvent(event, message)).toBeUndefined()
    expect(message.content.length).toBe(0)
  })
})

describe('tool error formatting', () => {
  it('turns backend codes into actionable text', () => {
    expect(formatError({ code: 'conflict', current: 3, expect: 2 })).toContain('版本冲突')
    expect(formatError({ code: 'alreadyExists', path: '/life/a.md' })).toContain(
      'write 只能新建',
    )
    expect(formatError({ code: 'readOnlyArea', path: '/life/.agents/x' })).toContain('只读区')
    expect(formatError('boom')).toBe('boom')
  })
})
