/**
 * Persisted configuration for Markdown syntax highlighting: a palette preset,
 * per-token color overrides drawn from the app's design tokens, and switches
 * that turn individual token categories off.
 */

export type SyntaxToken =
  | 'heading1'
  | 'heading2'
  | 'heading3'
  | 'heading4'
  | 'strong'
  | 'emphasis'
  | 'strikethrough'
  | 'link'
  | 'code'
  | 'quote'
  | 'list'
  | 'punctuation'

/** Theme-aware color slots; values resolve through CSS variables. */
export type SyntaxColorKey = 'accent' | 'accentDeep' | 'info' | 'text' | 'text2' | 'text3'

export type SyntaxPaletteKey = 'default' | 'vivid' | 'muted' | 'contrast'

export interface SyntaxPrefs {
  palette: SyntaxPaletteKey
  /** Per-token overrides; a missing key follows the palette. */
  colors: Partial<Record<SyntaxToken, SyntaxColorKey>>
  /** Token categories rendered as plain text. */
  disabled: SyntaxToken[]
}

export const SYNTAX_COLORS: Array<{ key: SyntaxColorKey; label: string; css: string }> = [
  { key: 'accent', label: '主题色', css: 'var(--accent)' },
  { key: 'accentDeep', label: '深主题色', css: 'var(--accent-deep)' },
  { key: 'info', label: '信息蓝', css: 'var(--info)' },
  { key: 'text', label: '正文色', css: 'var(--text)' },
  { key: 'text2', label: '次要色', css: 'var(--text-2)' },
  { key: 'text3', label: '弱化色', css: 'var(--text-3)' },
]

export const SYNTAX_TOKENS: Array<{ key: SyntaxToken; label: string }> = [
  { key: 'heading1', label: '一级标题' },
  { key: 'heading2', label: '二级标题' },
  { key: 'heading3', label: '三级标题' },
  { key: 'heading4', label: '四级及以下标题' },
  { key: 'strong', label: '加粗' },
  { key: 'emphasis', label: '斜体' },
  { key: 'strikethrough', label: '删除线' },
  { key: 'link', label: '链接 / 网址' },
  { key: 'code', label: '行内代码' },
  { key: 'quote', label: '引用' },
  { key: 'list', label: '列表标记' },
  { key: 'punctuation', label: 'Markdown 符号' },
]

export const SYNTAX_PALETTES: Array<{ key: SyntaxPaletteKey; label: string }> = [
  { key: 'default', label: '默认' },
  { key: 'vivid', label: '鲜明' },
  { key: 'muted', label: '柔和' },
  { key: 'contrast', label: '高对比' },
]

const PALETTE_COLORS: Record<SyntaxPaletteKey, Record<SyntaxToken, SyntaxColorKey>> = {
  default: {
    heading1: 'accentDeep',
    heading2: 'accent',
    heading3: 'info',
    heading4: 'text2',
    strong: 'text',
    emphasis: 'text2',
    strikethrough: 'text3',
    link: 'info',
    code: 'accentDeep',
    quote: 'text2',
    list: 'accent',
    punctuation: 'text3',
  },
  vivid: {
    heading1: 'accentDeep',
    heading2: 'accent',
    heading3: 'info',
    heading4: 'info',
    strong: 'accentDeep',
    emphasis: 'accent',
    strikethrough: 'text3',
    link: 'info',
    code: 'accent',
    quote: 'info',
    list: 'accentDeep',
    punctuation: 'text2',
  },
  muted: {
    heading1: 'text',
    heading2: 'text',
    heading3: 'text2',
    heading4: 'text2',
    strong: 'text',
    emphasis: 'text2',
    strikethrough: 'text3',
    link: 'text2',
    code: 'text2',
    quote: 'text3',
    list: 'text2',
    punctuation: 'text3',
  },
  contrast: {
    heading1: 'accentDeep',
    heading2: 'accentDeep',
    heading3: 'info',
    heading4: 'text',
    strong: 'text',
    emphasis: 'text',
    strikethrough: 'text2',
    link: 'info',
    code: 'accentDeep',
    quote: 'text',
    list: 'accent',
    punctuation: 'text2',
  },
}

export const DEFAULT_SYNTAX_PREFS: SyntaxPrefs = {
  palette: 'default',
  colors: {},
  disabled: [],
}

const STORAGE_KEY = 'notes:syntax-highlight'

const TOKEN_KEYS = SYNTAX_TOKENS.map((token) => token.key)
const COLOR_KEYS = SYNTAX_COLORS.map((color) => color.key)
const PALETTE_KEYS = SYNTAX_PALETTES.map((palette) => palette.key)

/** Resolve the color slot a token renders with (override beats palette). */
export function resolveSyntaxColor(prefs: SyntaxPrefs, token: SyntaxToken): SyntaxColorKey {
  return prefs.colors[token] ?? PALETTE_COLORS[prefs.palette][token]
}

/** CSS color expression for a slot, following the active light/dark theme. */
export function syntaxColorCss(color: SyntaxColorKey): string {
  return SYNTAX_COLORS.find((slot) => slot.key === color)?.css ?? 'var(--text)'
}

/**
 * Parse persisted prefs; unknown palette/token/color values are dropped so
 * storage can never inject arbitrary styles.
 */
export function parseSyntaxPrefs(raw: string | null): SyntaxPrefs {
  let data: unknown = null
  try {
    data = raw ? JSON.parse(raw) : null
  } catch {
    data = null
  }
  const record = (data && typeof data === 'object' ? data : {}) as Partial<SyntaxPrefs>
  const palette = PALETTE_KEYS.includes(record.palette as SyntaxPaletteKey)
    ? (record.palette as SyntaxPaletteKey)
    : DEFAULT_SYNTAX_PREFS.palette

  const colors: Partial<Record<SyntaxToken, SyntaxColorKey>> = {}
  const rawColors = record.colors
  if (rawColors && typeof rawColors === 'object') {
    for (const token of TOKEN_KEYS) {
      const value = (rawColors as Record<string, unknown>)[token]
      if (typeof value === 'string' && COLOR_KEYS.includes(value as SyntaxColorKey)) {
        colors[token] = value as SyntaxColorKey
      }
    }
  }

  const disabled: SyntaxToken[] = []
  if (Array.isArray(record.disabled)) {
    for (const token of TOKEN_KEYS) {
      if (record.disabled.includes(token)) disabled.push(token)
    }
  }

  return { palette, colors, disabled }
}

let cached: SyntaxPrefs | null = null
const listeners = new Set<() => void>()

/** Read once per session; localStorage access is lazy for test environments. */
export function getSyntaxPrefs(): SyntaxPrefs {
  if (cached === null) {
    try {
      cached = parseSyntaxPrefs(localStorage.getItem(STORAGE_KEY))
    } catch {
      cached = DEFAULT_SYNTAX_PREFS
    }
  }
  return cached
}

/** Persist and notify subscribers; no-op when nothing changed. */
export function setSyntaxPrefs(next: SyntaxPrefs): void {
  const normalized = parseSyntaxPrefs(JSON.stringify(next))
  if (JSON.stringify(normalized) === JSON.stringify(getSyntaxPrefs())) return
  cached = normalized
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized))
  } catch {
    // Storage can be unavailable (private mode / quota); keep the in-memory value.
  }
  for (const listener of listeners) listener()
}

/** Restore the default palette and drop every override / switch. */
export function resetSyntaxPrefs(): void {
  if (JSON.stringify(getSyntaxPrefs()) === JSON.stringify(DEFAULT_SYNTAX_PREFS)) return
  cached = DEFAULT_SYNTAX_PREFS
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {
    // Ignore unavailable storage; the in-memory default still applies.
  }
  for (const listener of listeners) listener()
}

export function subscribeSyntaxPrefs(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
