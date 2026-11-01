import { describe, expect, it } from 'vitest'
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import { estimateMessageTokens, estimateTextTokens, trimContext } from './context'

function user(text: string): AgentMessage {
  return { role: 'user', content: text, timestamp: 0 } as unknown as AgentMessage
}

function assistant(text: string): AgentMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    timestamp: 0,
  } as unknown as AgentMessage
}

function toolResult(text: string): AgentMessage {
  return {
    role: 'toolResult',
    toolCallId: 'call-1',
    toolName: 'fs_read',
    content: [{ type: 'text', text }],
    isError: false,
    timestamp: 0,
  } as unknown as AgentMessage
}

describe('context budget', () => {
  it('estimates CJK closer to one token per character', () => {
    expect(estimateTextTokens('')).toBe(0)
    expect(estimateTextTokens('今天天气很好')).toBe(6)
    // ASCII: 3 chars per token.
    expect(estimateTextTokens('abcdef')).toBe(2)
  })

  it('counts text blocks and tool arguments', () => {
    expect(estimateMessageTokens(user('hello'))).toBe(2)
    expect(estimateMessageTokens(assistant('今天吃了拉面'))).toBe(6)
  })

  it('keeps the newest suffix starting at a user turn', () => {
    const history = [
      user('旧问题'.repeat(200)),
      assistant('旧回答'.repeat(200)),
      toolResult('旧工具结果'),
      user('新问题'),
      assistant('新回答'),
    ]
    const trimmed = trimContext(history, 1024)
    expect(trimmed[0]?.role).toBe('user')
    expect(trimmed.length).toBeLessThan(history.length)
    expect(trimmed[trimmed.length - 1]).toBe(history[history.length - 1])
  })

  it('keeps short histories intact and falls back to the last user turn', () => {
    const short = [user('你好'), assistant('你好')]
    expect(trimContext(short, 128000)).toEqual(short)

    const huge = [user('很长的历史'.repeat(5000)), assistant('回答'), user('最新问题')]
    const trimmed = trimContext(huge, 64)
    expect(trimmed).toEqual([huge[2]])
  })
})
