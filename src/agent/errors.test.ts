//! One code→copy table: classification must stay deterministic.

import { describe, expect, it } from 'vitest'
import { classifyError, classifyFailure, classifyMessage, errorText } from './errors'

describe('error classification', () => {
  it('maps provider and transport text to a single code', () => {
    expect(classifyMessage('尚未配置 API Key')).toBe('auth_missing')
    expect(classifyMessage('HTTP 401 Unauthorized')).toBe('auth_invalid')
    expect(classifyMessage('HTTP 429 rate limit')).toBe('rate_limited')
    expect(classifyMessage('request timed out')).toBe('timeout')
    expect(classifyMessage('fetch failed: connection reset')).toBe('network')
    expect(classifyMessage('模型返回格式无法解析')).toBe('protocol_changed')
    expect(classifyMessage('invalid JSON: unexpected token')).toBe('protocol_changed')
    expect(classifyMessage('HTTP 400 rejected')).toBe('provider_rejected')
    expect(classifyMessage('boom')).toBe('internal')
  })

  it('keeps Rust tool codes actionable', () => {
    expect(classifyError({ code: 'pathEscape', root: '/life', got: '/etc' }).code).toBe(
      'tool_path_escape',
    )
    expect(classifyError({ code: 'permissionDenied', path: '/life/x.md' }).code).toBe(
      'tool_permission_denied',
    )
    expect(classifyError({ code: 'unknownToolCode', path: '/life/x.md' }).code).toBe('tool_other')
    expect(classifyError(new Error('network down')).code).toBe('network')
  })

  it('treats an abort as cancelled, never as a failure', () => {
    expect(classifyFailure({ stopReason: 'aborted' })).toEqual({ code: 'cancelled', detail: '' })
    expect(classifyFailure({ stopReason: 'error', errorMessage: 'HTTP 429' }).code).toBe(
      'rate_limited',
    )
  })

  it('renders copy plus detail from the single table', () => {
    expect(errorText({ code: 'cancelled', detail: '' })).toBe('已取消')
    const text = errorText({ code: 'network', detail: 'fetch failed' })
    expect(text).toContain('网络连接失败')
    expect(text).toContain('fetch failed')
    // No duplicate composition when the detail equals the copy.
    expect(errorText({ code: 'internal', detail: '内部错误' })).toBe('内部错误')
  })
})
