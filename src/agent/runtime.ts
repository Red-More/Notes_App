//! Agent 运行时装配：pi-agent 的 Agent + 自研 streamFn + 5 个 fs_* 工具。
//!
//! 会话持久化不进入 pi 的状态机：历史消息由本模块从 `ChatMessageRecord[]`
//! 还原成 pi 的 `AgentMessage[]`，新消息在事件回调里落库。

import { Agent } from '@earendil-works/pi-agent-core'
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type { AssistantMessage, Model, ToolCall, Usage } from '@earendil-works/pi-ai'
import { buildSystemPrompt } from './prompt'
import { nativeStreamFn } from './stream'
import { createTools } from './tools'
import type { ChatMessageRecord } from '../types'
import { parseDbTime } from '../utils'

const MAX_STEPS_PER_RUN = 12
const MAX_WRITES_PER_RUN = 8

export interface AgentProfile {
  provider: string
  model: string
}

const API_BY_PROVIDER: Record<string, string> = {
  openai: 'openai-completions',
  anthropic: 'anthropic-messages',
  google: 'google-generative-ai',
  mock: 'mock',
}

function zeroUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  }
}

/**
 * 为 pi 造一个「描述性」Model：真正的请求由 Rust 代理发出，
 * 这里只提供 pi-agent 需要的身份字段；`baseUrl` 不会被使用。
 */
export function createAppModel(profile: AgentProfile): Model<string> {
  return {
    id: profile.model,
    name: profile.model,
    api: API_BY_PROVIDER[profile.provider] ?? 'openai-completions',
    provider: profile.provider,
    baseUrl: '',
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 4096,
    reasoning: false,
  }
}

/** 把一条已落库的 assistant 消息还原成 pi 的 AssistantMessage。 */
function toAssistantMessage(record: ChatMessageRecord, profile: AgentProfile): AssistantMessage {
  const content: AssistantMessage['content'] = []
  if (record.content.trim() !== '') {
    content.push({ type: 'text', text: record.content })
  }
  if (record.toolCalls) {
    try {
      const calls = JSON.parse(record.toolCalls) as ToolCall[]
      if (Array.isArray(calls)) {
        for (const call of calls) {
          if (call?.type === 'toolCall') content.push(call)
        }
      }
    } catch {
      // 历史数据损坏时按纯文本处理，不让会话打不开。
    }
  }
  return {
    role: 'assistant',
    content,
    api: API_BY_PROVIDER[profile.provider] ?? 'openai-completions',
    provider: profile.provider,
    model: profile.model,
    usage: zeroUsage(),
    stopReason: 'stop',
    timestamp: parseDbTime(record.createdAt).getTime(),
  }
}

/** 数据库记录 → pi transcript。 */
export function toAgentMessages(
  records: ChatMessageRecord[],
  profile: AgentProfile,
): AgentMessage[] {
  const messages: AgentMessage[] = []
  for (const record of records) {
    const timestamp = parseDbTime(record.createdAt).getTime()
    if (record.role === 'user') {
      messages.push({ role: 'user', content: record.content, timestamp })
    } else if (record.role === 'assistant') {
      messages.push(toAssistantMessage(record, profile))
    } else {
      messages.push({
        role: 'toolResult',
        toolCallId: record.toolCallId ?? '',
        toolName: record.toolName ?? '',
        content: [{ type: 'text', text: record.content }],
        isError: record.isError,
        timestamp,
      })
    }
  }
  return messages
}

/** 用历史消息创建 Agent；system prompt 与工具在这里一次性装配。 */
export function createAgent(
  profile: AgentProfile,
  history: AgentMessage[],
  skillsIndex = '',
): Agent {
  return new Agent({
    initialState: {
      systemPrompt: buildSystemPrompt(skillsIndex),
      model: createAppModel(profile),
      thinkingLevel: 'off',
      tools: createTools(),
      messages: history,
    },
    streamFn: nativeStreamFn,
    // 读并行、写串行：写工具自身声明 executionMode: 'sequential'。
    toolExecution: 'parallel',
    // 配额硬限额：按“最近一条 user 消息之后”统计，避免模型循环调用拖垮设备。
    beforeToolCall: async ({ context }) => {
      let steps = 0
      let writes = 0
      for (let i = context.messages.length - 1; i >= 0; i -= 1) {
        const message = context.messages[i]
        if (message.role === 'user') break
        if (message.role === 'toolResult') {
          steps += 1
        } else if (message.role === 'assistant') {
          for (const block of message.content) {
            if (block.type === 'toolCall' && (block.name === 'fs_write' || block.name === 'fs_edit')) {
              writes += 1
            }
          }
        }
      }
      if (steps >= MAX_STEPS_PER_RUN) {
        return {
          block: true,
          reason: `单轮工具调用超过 ${MAX_STEPS_PER_RUN} 步，请先总结已获得的信息再继续`,
          terminate: true,
        }
      }
      // 写配额覆盖 fs_write 与 fs_edit：两者都算写入，达到上限后新建与编辑都拦截。
      if (writes >= MAX_WRITES_PER_RUN) {
        return {
          block: true,
          reason: `单轮文档写入超过 ${MAX_WRITES_PER_RUN} 次，请先合并内容再继续`,
        }
      }
      return undefined
    },
  })
}

/** 从 assistant 消息里抽出可落库的文本与工具调用 JSON。 */
export function extractAssistant(message: AssistantMessage): {
  text: string
  toolCalls: string | null
} {
  const texts: string[] = []
  const calls: ToolCall[] = []
  for (const block of message.content) {
    if (block.type === 'text') texts.push(block.text)
    else if (block.type === 'toolCall') calls.push(block)
  }
  return {
    text: texts.join('\n'),
    toolCalls: calls.length > 0 ? JSON.stringify(calls) : null,
  }
}
