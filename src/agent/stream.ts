//! 原生 streamFn：把 pi-agent 内置 `streamProxy` 的 HTTP 传输换成 Tauri IPC。
//!
//! pi-agent 只要求 streamFn 返回一个 `AssistantMessageEventStream`；
//! 这里把 Rust 端 `agent_stream` 发回的事件（与 `ProxyAssistantMessageEvent` 同构）
//! 重建为 pi-ai 事件，其余（工具循环、状态、事件）全部交给 pi-agent。
//!
//! 红线：`apiKey`、`baseUrl`、`signal` 都不会传进 Rust；取消走独立的 `agent_cancel`。

import { Channel, invoke } from '@tauri-apps/api/core'
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai'
import type {
  AssistantMessageEventStream,
  SimpleStreamOptions,
} from '@earendil-works/pi-ai'
import type { StreamFn } from '@earendil-works/pi-agent-core'
import { formatError, newPartial, processEvent } from './protocol'
import type { ProxyEvent } from './protocol'

function makeRequestId(): string {
  const cryptoObj = globalThis.crypto
  if (cryptoObj && typeof cryptoObj.randomUUID === 'function') return cryptoObj.randomUUID()
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

export const nativeStreamFn: StreamFn = (
  model,
  context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream => {
  const stream = createAssistantMessageEventStream()
  const partial = newPartial(model)
  const id = makeRequestId()
  let terminal = false

  const channel = new Channel<ProxyEvent>()
  channel.onmessage = (event) => {
    const mapped = processEvent(event, partial)
    if (!mapped) return
    if (mapped.type === 'done' || mapped.type === 'error') terminal = true
    stream.push(mapped)
  }

  const signal = options?.signal
  const onAbort = () => {
    void invoke('agent_cancel', { requestId: id }).catch(() => {})
  }
  if (signal) signal.addEventListener('abort', onAbort)

  void (async () => {
    try {
      await invoke('agent_stream', {
        request: {
          requestId: id,
          model: { id: model.id, provider: model.provider, api: model.api },
          context: { messages: context.messages },
          options: {
            temperature: options?.temperature,
            maxTokens: options?.maxTokens,
            toolChoice: options?.toolChoice,
          },
        },
        onEvent: channel,
      })
    } catch (error) {
      if (!terminal) {
        const reason = signal?.aborted ? 'aborted' : 'error'
        partial.stopReason = reason
        partial.errorMessage = formatError(error)
        stream.push({ type: 'error', reason, error: partial })
        terminal = true
      }
    } finally {
      if (signal) signal.removeEventListener('abort', onAbort)
      if (!terminal) {
        partial.stopReason = 'error'
        partial.errorMessage = '流式响应在完成前结束'
        stream.push({ type: 'error', reason: 'error', error: partial })
      }
      stream.end()
    }
  })()

  return stream
}
