export interface DiffRow {
  type: 'same' | 'add' | 'del'
  text: string
  oldNo: number | null
  newNo: number | null
}

/**
 * Soft-keyboard inset for the editor, covering both Android models:
 * - overlay (adjustNothing/pan): the layout viewport stays put, the visual
 *   viewport shrinks → `innerHeight - (vvHeight + vvOffsetTop)`.
 * - adjustResize: the layout viewport itself shrinks → the delta from the last
 *   tall `innerHeight` is the inset.
 * On environments without a soft keyboard the inset is always 0 so a plain
 * window shrink (e.g. desktop resize) is never mistaken for a keyboard.
 */
export function computeKbInset(
  tallInnerHeight: number,
  innerHeight: number,
  vvHeight: number,
  vvOffsetTop: number,
  canHaveSoftKeyboard: boolean,
): number {
  const overlayInset = Math.max(0, Math.round(innerHeight - (vvHeight + vvOffsetTop)))
  // A large visual-viewport shrink is a keyboard signal even on WebViews that
  // report no touch capability (maxTouchPoints = 0); small shinks are ignored
  // outside touch environments so a desktop window resize is never mistaken
  // for a keyboard.
  if (overlayInset > 0) {
    if (overlayInset >= 150 || canHaveSoftKeyboard) return overlayInset
    return 0
  }
  if (!canHaveSoftKeyboard) return 0
  return Math.max(0, Math.round(tallInnerHeight - innerHeight))
}

/** Parse a SQLite local datetime string ("YYYY-MM-DD HH:MM:SS"). */
export function parseDbTime(s: string): Date {
  return new Date(s.replace(' ', 'T'))
}

/** Format as "YYYY-MM-DD HH:mm". */
export function formatDateTime(s: string): string {
  const d = parseDbTime(s)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** Format as "YYYY-MM-DD AM/PM hh:mm" (e.g. "2024-05-20 PM 03:45"). */
export function formatAmPmDateTime(s: string): string {
  const d = parseDbTime(s)
  const p = (n: number) => String(n).padStart(2, '0')
  const meridiem = d.getHours() < 12 ? 'AM' : 'PM'
  const hour12 = d.getHours() % 12 || 12
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${meridiem} ${p(hour12)}:${p(d.getMinutes())}`
}

/** Friendly relative time: 刚刚 / n分钟前 / n小时前 / 昨天 / M月d日 / yyyy年M月d日. */
export function formatRelative(s: string): string {
  const d = parseDbTime(s)
  const now = new Date()
  const diffMs = now.getTime() - d.getTime()
  if (diffMs < 60_000) return '刚刚'
  if (diffMs < 3_600_000) return `${Math.floor(diffMs / 60_000)}分钟前`
  if (diffMs < 86_400_000) return `${Math.floor(diffMs / 3_600_000)}小时前`
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const dayDiff = Math.floor((startOfDay(now) - startOfDay(d)) / 86_400_000)
  if (dayDiff === 1) return '昨天'
  if (dayDiff < 7) return `${dayDiff}天前`
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日`
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`
}

/** Local date string "YYYY-MM-DD". */
export function dateStr(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** "YYYYMMDD-HHmm" timestamp for export file names. */
export function exportTs(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`
}

/** Replace illegal filename chars /\\:*?"<>| and control chars with _, fallback on empty, truncate to 60 chars. */
export function safeFileName(name: string, fallback = '未命名'): string {
  // \p{Cc} covers control characters; literal control escapes trip no-control-regex.
  const cleaned = name.replace(/[\\/:*?"<>|\p{Cc}]/gu, '_').trim()
  const base = cleaned || fallback
  return base.slice(0, 60)
}

/**
 * Map a backend or unknown error to a friendly Chinese message.
 * Known friendly messages pass through unchanged.
 */
export function friendlyError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e)
  if (msg.includes('数据库错误')) return '操作失败，请重试'
  if (msg.includes('笔记不存在')) return '笔记不存在或已删除'
  if (msg.includes('没有可导出的笔记')) return '没有可导出的笔记'
  if (msg.includes('不能为空')) return msg
  return '操作失败，请稍后重试'
}

/** Local month string "YYYY-MM". */
export function monthStr(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}`
}

/** Format a sequential version number as v{major}.{minor}.{patch}. */
export function fmtVersion(n: number): string {
  return `v${Math.floor(n / 100)}.${Math.floor((n % 100) / 10)}.${n % 10}`
}

/** "HH:mm" from a "YYYY-MM-DD HH:MM[:SS]" string, or the raw value. */
export function shortTime(s: string | null | undefined): string {
  if (!s) return ''
  return s.length >= 16 ? s.slice(11, 16) : s
}

/**
 * Line-based diff between `oldText` and `newText` using LCS.
 * Rows are ordered for display: deletions before additions.
 */
export function diffLines(oldText: string, newText: string): DiffRow[] {
  const a = oldText.length ? oldText.split('\n') : []
  const b = newText.length ? newText.split('\n') : []
  const n = a.length
  const m = b.length

  // dp[i][j] = LCS length of a[i..] and b[j..]
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }

  const rows: DiffRow[] = []
  let i = 0
  let j = 0
  let oldNo = 0
  let newNo = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      oldNo++
      newNo++
      rows.push({ type: 'same', text: a[i], oldNo, newNo })
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      oldNo++
      rows.push({ type: 'del', text: a[i], oldNo, newNo: null })
      i++
    } else {
      newNo++
      rows.push({ type: 'add', text: b[j], oldNo: null, newNo })
      j++
    }
  }
  while (i < n) {
    oldNo++
    rows.push({ type: 'del', text: a[i], oldNo, newNo: null })
    i++
  }
  while (j < m) {
    newNo++
    rows.push({ type: 'add', text: b[j], oldNo: null, newNo })
    j++
  }
  return rows
}
