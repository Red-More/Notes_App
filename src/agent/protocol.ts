//! 纯函数：把 Rust 代理事件重建为 pi-ai 事件，并格式化 `ToolError`。
//!
//! 不依赖 Tauri / 浏览器，便于单测；`stream.ts` 只负责通道与取消。

import { parseStreamingJson } from '@earendil-works/pi-ai'
import type {
  AssistantMessage,
  AssistantMessageEvent,
  ToolCall,
  Usage,
} from '@earendil-works/pi-ai'

/** 与 pi-agent `proxy.d.ts` 的 `ProxyAssistantMessageEvent` 一致。 */
export type ProxyEvent =
  | { type: 'start' }
  | { type: 'text_start'; contentIndex: number }
  | { type: 'text_delta'; contentIndex: number; delta: string }
  | { type: 'text_end'; contentIndex: number; contentSignature?: string }
  | { type: 'toolcall_start'; contentIndex: number; id: string; toolName: string }
  | { type: 'toolcall_delta'; contentIndex: number; delta: string }
  | { type: 'toolcall_end'; contentIndex: number; toolCall: ToolCall }
  | { type: 'done'; reason: 'stop' | 'length' | 'toolUse'; usage: Usage }
  | { type: 'error'; reason: 'aborted' | 'error'; errorMessage?: string; usage: Usage }

export function zeroUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  }
}

export function newPartial(model: {
  api: string
  provider: string
  id: string
}): AssistantMessage {
  return {
    role: 'assistant',
    stopReason: 'pending',
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: zeroUsage(),
    timestamp: Date.now(),
  }
}

/**
 * 合并一条代理事件并产出 pi-ai 事件。
 * 与 pi-agent `proxy.js` 的 `processProxyEvent` 等价（仅保留文本与工具调用）。
 */
export function processEvent(
  event: ProxyEvent,
  partial: AssistantMessage,
): AssistantMessageEvent | undefined {
  switch (event.type) {
    case 'start':
      return { type: 'start', partial }
    case 'text_start':
      partial.content[event.contentIndex] = { type: 'text', text: '' }
      return { type: 'text_start', contentIndex: event.contentIndex, partial }
    case 'text_delta': {
      const block = partial.content[event.contentIndex]
      if (block?.type !== 'text') return undefined
      block.text += event.delta
      return {
        type: 'text_delta',
        contentIndex: event.contentIndex,
        delta: event.delta,
        partial,
      }
    }
    case 'text_end': {
      const block = partial.content[event.contentIndex]
      if (block?.type !== 'text') return undefined
      block.textSignature = event.contentSignature
      return {
        type: 'text_end',
        contentIndex: event.contentIndex,
        content: block.text,
        partial,
      }
    }
    case 'toolcall_start': {
      const block: ToolCall & { partialJson?: string } = {
        type: 'toolCall',
        id: event.id,
        name: event.toolName,
        arguments: {},
        partialJson: '',
      }
      partial.content[event.contentIndex] = block
      return { type: 'toolcall_start', contentIndex: event.contentIndex, partial }
    }
    case 'toolcall_delta': {
      const block = partial.content[event.contentIndex] as
        | (ToolCall & { partialJson?: string })
        | undefined
      if (block?.type !== 'toolCall') return undefined
      block.partialJson = (block.partialJson ?? '') + event.delta
      block.arguments = parseStreamingJson(block.partialJson) ?? {}
      partial.content[event.contentIndex] = { ...block }
      return {
        type: 'toolcall_delta',
        contentIndex: event.contentIndex,
        delta: event.delta,
        partial,
      }
    }
    case 'toolcall_end': {
      const block = partial.content[event.contentIndex] as
        | (ToolCall & { partialJson?: string })
        | undefined
      if (block?.type !== 'toolCall') return undefined
      Object.assign(block, event.toolCall)
      delete block.partialJson
      return {
        type: 'toolcall_end',
        contentIndex: event.contentIndex,
        toolCall: block,
        partial,
      }
    }
    case 'done':
      partial.stopReason = event.reason
      partial.usage = event.usage
      return { type: 'done', reason: event.reason, message: partial }
    case 'error':
      partial.stopReason = event.reason
      partial.errorMessage = event.errorMessage
      partial.usage = event.usage
      return { type: 'error', reason: event.reason, error: partial }
    default:
      return undefined
  }
}

/** Tauri command 抛出的 `ToolError` 是 `{ code, ... }`，这里转成可行动文案。 */
export function formatError(error: unknown): string {
  if (typeof error === 'string') return error
  if (error && typeof error === 'object') {
    const value = error as Record<string, unknown>
    switch (value.code) {
      case 'conflict':
        return `版本冲突：当前 rev=${String(value.current)}，期望 rev=${String(value.expect)}；请先 read 最新内容再重试`
      case 'alreadyExists':
        return `${String(value.path)} 已存在；write 只能新建，追加请先 read 再 edit`
      case 'noMatch':
        return `old_string 未命中：${String(value.hint)}`
      case 'pathEscape':
        return `路径越界：只允许 ${String(value.root)} 之下，收到 ${String(value.got)}`
      case 'invalidPath':
      case 'invalidArgument':
        return String(value.message ?? '参数非法')
      case 'storage':
        return `存储错误：${String(value.message)}`
      case 'notFound':
        return `未找到：${String(value.path)}`
      case 'readOnlyArea':
        return `${String(value.path)} 属于只读区，禁止写入`
      case 'contentTooLarge':
        return `内容过大：上限 ${String(value.limit)} 字节`
      case 'parentMissing':
        return `父目录不存在：${String(value.path)}`
      default:
        break
    }
    try {
      return JSON.stringify(value)
    } catch {
      return '未知错误'
    }
  }
  return String(error)
}
