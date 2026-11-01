//! 纯函数：上下文 token 估算与裁剪。
//!
//! `pi-ai` 的 `estimateContextTokens` 只从子路径导出，项目只允许根入口导入，
//! 因此这里用等价的启发式估算（CJK 约 1 字 1 token，其余约 3 字符 1 token）。
//! 裁剪以 user 回合为边界，避免把 toolResult 与其 toolCall 拆开。

import type { AgentMessage } from '@earendil-works/pi-agent-core'

const CJK = /[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef\u3000-\u303f]/

/** Rough token estimate for mixed CJK/ASCII text. */
export function estimateTextTokens(text: string): number {
  if (text === '') return 0
  let cjk = 0
  let other = 0
  for (const char of text) {
    if (CJK.test(char)) cjk += 1
    else other += 1
  }
  return cjk + Math.ceil(other / 3)
}

function estimateBlockTokens(block: {
  type?: string
  text?: string
  thinking?: string
  arguments?: unknown
}): number {
  switch (block.type) {
    case 'text':
      return estimateTextTokens(block.text ?? '')
    case 'thinking':
      return estimateTextTokens(block.thinking ?? '')
    case 'toolCall':
      return estimateTextTokens(JSON.stringify(block.arguments ?? {}))
    // A full-size image costs roughly 1600 tokens on common providers.
    case 'image':
      return 1600
    default:
      return 0
  }
}

/** Estimate the prompt tokens contributed by one agent message. */
export function estimateMessageTokens(message: AgentMessage): number {
  const content = (message as { content?: unknown }).content
  if (typeof content === 'string') return estimateTextTokens(content)
  if (Array.isArray(content)) {
    return content.reduce((sum, block) => sum + estimateBlockTokens(block as never), 0)
  }
  return 0
}

/**
 * Keep the newest transcript suffix that fits `contextWindow * ratio`.
 * The suffix always starts at a user turn so tool results stay with their calls.
 */
export function trimContext(
  messages: AgentMessage[],
  contextWindow: number,
  ratio = 0.75,
): AgentMessage[] {
  if (messages.length === 0 || contextWindow <= 0) return messages
  const budget = Math.max(1024, Math.floor(contextWindow * ratio))
  let total = 0
  let start = messages.length
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const cost = estimateMessageTokens(messages[i])
    if (total + cost > budget) break
    total += cost
    start = i
  }
  while (start > 0 && start < messages.length && messages[start].role !== 'user') {
    start += 1
  }
  if (start >= messages.length) {
    // The newest user turn alone exceeds the budget: keep it rather than drop all.
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (messages[i].role === 'user') return messages.slice(i)
    }
    return messages.slice(-1)
  }
  return messages.slice(start)
}
