//! 工具参数的宽容归一化：弱模型常把数字/布尔写成字符串，或把枚举写成中文。
//!
//! 这些函数只做形状修正，不做业务判断；真正的边界仍由 Rust CapGate 与 schema 校验负责。

export type RawArgs = Record<string, unknown>

/** Tool calls occasionally arrive as a JSON string instead of an object. */
export function argsObject(raw: unknown): RawArgs {
  if (typeof raw === 'string') {
    try {
      const parsed: unknown = JSON.parse(raw)
      return parsed !== null && typeof parsed === 'object' ? { ...(parsed as RawArgs) } : {}
    } catch {
      return {}
    }
  }
  return raw !== null && typeof raw === 'object' ? { ...(raw as RawArgs) } : {}
}

export function argString(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return undefined
}

export function argNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

export function argBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (['true', '1', 'yes', 'on'].includes(normalized)) return true
    if (['false', '0', 'no', 'off'].includes(normalized)) return false
  }
  return undefined
}

/** Normalize a file extension: trim, drop leading dots, lowercase. */
export function argExtension(value: unknown): string | undefined {
  const raw = argString(value)
  if (!raw) return undefined
  const extension = raw.trim().replace(/^\.+/, '').trim().toLowerCase()
  return extension || undefined
}
