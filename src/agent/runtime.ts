//! Agent 运行时装配：pi-agent 的 Agent + 自研 streamFn + 5 个 fs_* 工具。
//!
//! 会话持久化不进入 pi 的状态机：历史消息由本模块从 `ChatMessageRecord[]`
//! 还原成 pi 的 `AgentMessage[]`，新消息在事件回调里落库。

import { Agent } from '@earendil-works/pi-agent-core'
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type { AssistantMessage, ImageContent, Model, ToolCall, Usage } from '@earendil-works/pi-ai'
import { buildSystemPrompt } from './prompt'
import { trimContext } from './context'
import { nativeStreamFn } from './stream'
import { createTools } from './tools'
import type { ChatMessageRecord, AgentSettings, ModelApiFormat, SkillSummary } from '../types'
import { parseDbTime } from '../utils'

const DEFAULT_TOOL_ROUNDS = 500
const MAX_STEPS_PER_RUN = 500
const MAX_WRITES_PER_RUN = 8

export interface AgentProfile {
  /** Model entry id; the Rust proxy resolves the real endpoint from it. */
  provider: string
  /** Model ID sent to the provider. */
  model: string
  /** pi-ai api kind derived from the stored model format. */
  api: string
  /** Optional capability hints persisted per model. */
  contextWindow?: number
  maxTokens?: number
  supportsImages?: boolean
  reasoning?: boolean
  toolRounds?: number
}

/** Map the stored wire format to the pi-ai api descriptor. */
export function apiForFormat(format: ModelApiFormat | undefined): string {
  switch (format) {
    case 'anthropic-messages':
      return 'anthropic-messages'
    case 'openai-responses':
      return 'openai-responses'
    default:
      return 'openai-completions'
  }
}

/**
 * Build a profile for a conversation. The requested entry wins; a deleted
 * entry falls back to the active model. `null` means the user has no model yet.
 */
export function profileFromSettings(
  settings: AgentSettings,
  entryId: string | undefined,
  model: string | undefined,
): AgentProfile | null {
  // Only chat entries can back the agent; media kinds stay out of the transcript.
  const chatModels = settings.models.filter((item) => item.kind === 'chat')
  const entry =
    chatModels.find((item) => item.id === entryId) ??
    chatModels.find((item) => item.id === settings.activeId)
  if (!entry) return null
  return {
    provider: entry.id,
    // The saved entry is authoritative: editing its Model ID applies to old
    // conversations as well.
    model: entry.modelId || (model ?? ''),
    api: apiForFormat(entry.format),
  }
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
    api: profile.api,
    provider: profile.provider,
    baseUrl: '',
    input: profile.supportsImages ? ['text', 'image'] : ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: profile.contextWindow ?? 128000,
    maxTokens: profile.maxTokens ?? 4096,
    reasoning: profile.reasoning ?? false,
  }
}

/** 把一条已落库的 assistant 消息还原成 pi 的 AssistantMessage。 */
function toAssistantMessage(record: ChatMessageRecord, profile: AgentProfile): AssistantMessage {
  const content: AssistantMessage['content'] = []
  if (record.thinking) {
    content.push({
      type: 'thinking',
      thinking: record.thinking,
      thinkingSignature: record.thinkingSignature ?? undefined,
    })
  }
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
    api: profile.api,
    provider: profile.provider,
    model: profile.model,
    usage: record.usage
      ? {
          input: record.usage.input,
          output: record.usage.output,
          cacheRead: record.usage.cacheRead,
          cacheWrite: record.usage.cacheWrite,
          totalTokens: record.usage.totalTokens,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        }
      : zeroUsage(),
    stopReason: 'stop',
    timestamp: parseDbTime(record.createdAt).getTime(),
  }
}

/** Parse the asset-id JSON stored on a user message; bad data becomes empty. */
export function parseImageAssetIds(raw: string | null | undefined): number[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter((id): id is number => Number.isInteger(id) && id > 0)
  } catch {
    return []
  }
}

/** 数据库记录 → pi transcript。 */
export async function toAgentMessages(
  records: ChatMessageRecord[],
  profile: AgentProfile,
  images: Map<number, { mime: string; data: string }> = new Map(),
): Promise<AgentMessage[]> {
  const messages: AgentMessage[] = []
  for (const record of records) {
    const timestamp = parseDbTime(record.createdAt).getTime()
    if (record.role === 'user') {
      const imageIds = parseImageAssetIds(record.imageAssetIds)
      const imageBlocks: ImageContent[] = imageIds
        .map((id) => images.get(id))
        .filter((image): image is { mime: string; data: string } => image !== undefined)
        .map((image) => ({ type: 'image', data: image.data, mimeType: image.mime }))
      const content =
        imageBlocks.length === 0
          ? record.content
          : [
              ...(record.content.trim() === ''
                ? []
                : [{ type: 'text' as const, text: record.content }]),
              ...imageBlocks,
            ]
      messages.push({ role: 'user', content, timestamp })
    } else if (record.role === 'assistant') {
      // Failure/cancel bubbles are UI state, not model context.
      if (record.isError) continue
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
  skills: SkillSummary[] = [],
): Agent {
  return new Agent({
    initialState: {
      systemPrompt: buildSystemPrompt(skillsIndex),
      model: createAppModel(profile),
      thinkingLevel: profile.reasoning ? 'medium' : 'off',
      tools: createTools(skills),
      messages: history,
    },
    streamFn: nativeStreamFn,
    // 按 token 预算裁剪：Rust 的 200 条上限只作兜底，避免长会话撑爆上下文。
    transformContext: async (messages) =>
      trimContext(messages, profile.contextWindow ?? 128000),
    // 读并行、写串行：写工具自身声明 executionMode: 'sequential'。
    toolExecution: 'parallel',
    // 配额硬限额：按“最近一条 user 消息之后”统计，避免模型循环调用拖垮设备。
    beforeToolCall: async ({ context }) => {
      const maxSteps = Math.min(profile.toolRounds ?? DEFAULT_TOOL_ROUNDS, MAX_STEPS_PER_RUN)
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
      if (steps >= maxSteps) {
        return {
          block: true,
          reason: `单轮工具调用超过 ${maxSteps} 步，请先总结已获得的信息再继续`,
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

/** 从 assistant 消息里抽出可落库的文本、思考与工具调用 JSON。 */
export function extractAssistant(message: AssistantMessage): {
  text: string
  toolCalls: string | null
  thinking: string | null
  thinkingSignature: string | null
} {
  const texts: string[] = []
  const thoughts: string[] = []
  const calls: ToolCall[] = []
  let thinkingSignature: string | null = null
  for (const block of message.content) {
    if (block.type === 'text') texts.push(block.text)
    else if (block.type === 'thinking') {
      thoughts.push(block.thinking)
      if (block.thinkingSignature) thinkingSignature = block.thinkingSignature
    } else if (block.type === 'toolCall') calls.push(block)
  }
  return {
    text: texts.join('\n'),
    toolCalls: calls.length > 0 ? JSON.stringify(calls) : null,
    thinking: thoughts.length > 0 ? thoughts.join('\n') : null,
    thinkingSignature,
  }
}
