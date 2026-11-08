//! Error taxonomy for one agent run.
//!
//! The runtime owns classification; the UI owns a single code→copy table.
//! Tool failures keep their actionable text so the model can recover, while
//! the transcript only ever shows `ErrorCode` based copy plus a short detail.

export type ErrorCode =
  | 'auth_missing'
  | 'auth_invalid'
  | 'rate_limited'
  | 'timeout'
  | 'network'
  | 'provider_rejected'
  | 'protocol_changed'
  | 'tool_conflict'
  | 'tool_path_escape'
  | 'tool_permission_denied'
  | 'tool_not_found'
  | 'tool_invalid'
  | 'tool_storage'
  | 'tool_other'
  | 'quota_steps'
  | 'quota_writes'
  | 'tool_not_supported'
  | 'internal'
  | 'cancelled'

export interface ErrorInfo {
  code: ErrorCode
  detail: string
}

/** The only user-facing copy table for run failures. */
export const ERROR_COPY: Record<ErrorCode, string> = {
  auth_missing: '尚未配置 API Key，请到设置 → AI 助理中填写',
  auth_invalid: 'API Key 无效或已过期，请更新后重试',
  rate_limited: '请求过于频繁，请稍后重试',
  timeout: '请求超时，请重试',
  network: '网络连接失败，请检查网络后重试',
  provider_rejected: '模型服务拒绝了本次请求',
  protocol_changed: '模型返回格式无法解析，请检查模型配置',
  tool_conflict: '文档状态已变化，请重新读取后再试',
  tool_path_escape: '路径越权：只能访问已授权目录',
  tool_permission_denied: '该路径未授权给 AI，请在设置中授权该文件夹',
  tool_not_found: '目标不存在',
  tool_invalid: '参数不合法',
  tool_storage: '本地存储出错',
  tool_other: '工具执行失败',
  quota_steps: '单轮工具调用步数超限，请先总结再继续',
  quota_writes: '单轮写入次数超限，请合并内容后再试',
  tool_not_supported: '当前版本暂不支持工具调用',
  internal: '内部错误',
  cancelled: '已取消',
}

const TOOL_CODES: Record<string, ErrorCode> = {
  pathEscape: 'tool_path_escape',
  invalidPath: 'tool_invalid',
  invalidArgument: 'tool_invalid',
  notFound: 'tool_not_found',
  notADirectory: 'tool_not_found',
  isDirectory: 'tool_not_found',
  alreadyExists: 'tool_conflict',
  parentMissing: 'tool_conflict',
  readOnlyArea: 'tool_permission_denied',
  permissionDenied: 'tool_permission_denied',
  conflict: 'tool_conflict',
  noMatch: 'tool_conflict',
  contentTooLarge: 'tool_invalid',
  storage: 'tool_storage',
}

/**
 * Map a serialized Rust `ToolError` (or any thrown value) to actionable text.
 * Shared by the model-facing tool layer and by `formatError`.
 */
export function describeToolError(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  if (!error || typeof error !== 'object') return String(error)
  const value = error as Record<string, unknown>
  const path = String(value.path ?? '')
  switch (value.code) {
    case 'conflict':
      return `版本冲突：当前 rev=${String(value.current)}，期望 rev=${String(value.expect)}；请先 read 最新内容再重试`
    case 'alreadyExists':
      return `${path} 已存在；write 只能新建，追加请先 read 再 edit`
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
      return `未找到：${path}`
    case 'notADirectory':
      return `不是目录：${path}`
    case 'isDirectory':
      return `目标是目录，不能按文件编辑：${path}`
    case 'readOnlyArea':
      return `${path} 属于只读区，禁止写入`
    case 'permissionDenied':
      return `该路径未授权给 AI（需要 ${String(value.permission ?? 'read')} 权限）：${path}；默认只能访问 /life/agent，请让用户在设置中授权该文件夹`
    case 'contentTooLarge':
      return `内容过大：上限 ${String(value.limit)} 字节`
    case 'parentMissing':
      return `父目录不存在：${path}`
    default:
      break
  }
  try {
    return JSON.stringify(value)
  } catch {
    return '未知错误'
  }
}

/** Single place that turns free-form provider/transport text into a code. */
export function classifyMessage(message: string | null | undefined): ErrorCode {
  const text = message ?? ''
  if (/尚未配置|未配置|missing api key/i.test(text)) return 'auth_missing'
  if (/HTTP\s*401|unauthorized|invalid api key|api key.*无效|未授权/i.test(text)) return 'auth_invalid'
  if (/HTTP\s*429|rate limit|too many requests|过于频繁/i.test(text)) return 'rate_limited'
  if (/timeout|timed out|超时/i.test(text)) return 'timeout'
  if (/network|网络|fetch|conn|dns|连接失败|error sending request/i.test(text)) return 'network'
  if (/解析|parse|unexpected token|invalid json|格式无法/i.test(text)) return 'protocol_changed'
  if (/HTTP\s*4\d\d|rejected|拒绝/i.test(text)) return 'provider_rejected'
  return 'internal'
}

/** Classify a thrown value; Rust `ToolError` objects keep their code. */
export function classifyError(error: unknown): ErrorInfo {
  if (error && typeof error === 'object' && !(error instanceof Error)) {
    const code = (error as { code?: unknown }).code
    if (typeof code === 'string') {
      return { code: TOOL_CODES[code] ?? 'tool_other', detail: describeToolError(error) }
    }
  }
  const text =
    error instanceof Error ? error.message : typeof error === 'string' ? error : describeToolError(error)
  return { code: classifyMessage(text), detail: text }
}

/**
 * Classify one finished assistant message. The Rust engine attaches a stable
 * `errorCode`, so the UI no longer has to guess from provider text (P0-3).
 */
export function classifyFailure(message: {
  stopReason?: string
  errorMessage?: string | null
  errorCode?: string | null
}): ErrorInfo {
  if (message.stopReason === 'aborted') return { code: 'cancelled', detail: '' }
  const text = message.errorMessage ?? ''
  if (message.errorCode) return { code: message.errorCode as ErrorCode, detail: text }
  return { code: classifyMessage(text), detail: text }
}

/** Copy plus a short detail; never exposes raw JSON as the whole message. */
export function errorText(info: ErrorInfo): string {
  const copy = ERROR_COPY[info.code]
  if (info.code === 'cancelled') return copy
  const detail = info.detail.trim()
  return detail && detail !== copy ? `${copy}（${detail}）` : copy
}
