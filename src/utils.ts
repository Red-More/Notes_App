export interface DiffRow {
  type: 'same' | 'add' | 'del'
  text: string
  oldNo: number | null
  newNo: number | null
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

/** Escape HTML special characters so rendered markdown cannot inject markup. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * Lightweight inline markdown over already-escaped text:
 * `code` spans first (so markers inside them stay literal), then **bold**,
 * *italic* and _italic_.
 */
function inlineMarkdown(s: string): string {
  const codes: string[] = []
  const text = s.replace(/`([^`]+)`/g, (_m: string, code: string) => {
    codes.push(code)
    return `\uE000${codes.length - 1}\uE000`
  })
  return text
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*\n]+)\*/g, '<em>$1</em>')
    .replace(/_([^_\n]+)_/g, '<em>$1</em>')
    .replace(/\uE000(\d+)\uE000/g, (_m: string, i: string) => `<code>${codes[Number(i)]}</code>`)
}

/**
 * Render a small markdown subset to safe HTML: `#`/`##`/`###` headings,
 * `-`/`*` list items, paragraphs with `<br>` line breaks, inline code,
 * bold and italic. The input is HTML-escaped first, so the output cannot
 * inject markup or scripts.
 */
export function renderMarkdown(md: string): string {
  const lines = escapeHtml(md).split('\n')
  const out: string[] = []
  let inList = false
  let para: string[] = []

  const flushPara = () => {
    if (para.length > 0) {
      out.push(`<p>${para.map(inlineMarkdown).join('<br>')}</p>`)
      para = []
    }
  }
  const closeList = () => {
    if (inList) {
      out.push('</ul>')
      inList = false
    }
  }

  for (const rawLine of lines) {
    const line = rawLine.trimEnd()
    if (!line.trim()) {
      closeList()
      flushPara()
      continue
    }
    const heading = line.match(/^(#{1,3})\s+(.*)$/)
    if (heading) {
      closeList()
      flushPara()
      const level = heading[1].length
      out.push(`<h${level}>${inlineMarkdown(heading[2])}</h${level}>`)
      continue
    }
    const item = line.match(/^[-*]\s+(.*)$/)
    if (item) {
      flushPara()
      if (!inList) {
        out.push('<ul>')
        inList = true
      }
      out.push(`<li>${inlineMarkdown(item[1])}</li>`)
      continue
    }
    closeList()
    para.push(line)
  }
  closeList()
  flushPara()
  return out.join('')
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
