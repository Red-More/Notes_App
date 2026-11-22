/**
 * Persisted configuration for Markdown syntax highlighting: a palette preset,
 * per-token color overrides (theme slots or custom hex), and switches that turn
 * individual token categories off.
 */

import { normalizeHexColor } from './color'

export type SyntaxToken =
  | 'heading1'
  | 'heading2'
  | 'heading3'
  | 'heading4'
  | 'heading5'
  | 'heading6'
  | 'strong'
  | 'emphasis'
  | 'strikethrough'
  | 'link'
  | 'code'
  | 'codeBlock'
  | 'quote'
  | 'list'
  | 'ordered'
  | 'task'
  | 'taskDone'
  | 'hr'
  | 'punctuation'

/** Theme-aware color slots; values resolve through CSS variables. */
export type SyntaxColorKey =
  | 'accent'
  | 'accentDeep'
  | 'info'
  | 'text'
  | 'text2'
  | 'text3'
  | 'h1'
  | 'h2'
  | 'h3'
  | 'h4'
  | 'h5'
  | 'h6'
  | 'strong'
  | 'emphasis'
  | 'strike'
  | 'link'
  | 'inlineCode'
  | 'inlineCodeBg'
  | 'codeBlock'
  | 'codeBlockBg'
  | 'quote'
  | 'quoteBg'
  | 'list'
  | 'ordered'
  | 'task'
  | 'taskDone'
  | 'hr'
  | 'punct'

/** A palette slot (theme-following) or a custom `#rrggbb` color. */
export type SyntaxColorValue = SyntaxColorKey | `#${string}`

export type SyntaxPaletteKey = 'default' | 'vivid' | 'muted' | 'contrast'

export interface SyntaxPrefs {
  palette: SyntaxPaletteKey
  /** Per-token overrides; a missing key follows the palette. */
  colors: Partial<Record<SyntaxToken, SyntaxColorValue>>
  /** Token categories rendered as plain text. */
  disabled: SyntaxToken[]
}

/**
 * Every theme-aware slot. The first six double as the picker's quick presets;
 * the rest carry the semantic default palette (VS Code Dark+ / deepened light).
 */
export const SYNTAX_COLORS: Array<{ key: SyntaxColorKey; label: string; css: string }> = [
  { key: 'accent', label: '主题色', css: 'var(--accent)' },
  { key: 'accentDeep', label: '深主题色', css: 'var(--accent-deep)' },
  { key: 'info', label: '信息蓝', css: 'var(--info)' },
  { key: 'text', label: '正文色', css: 'var(--text)' },
  { key: 'text2', label: '次要色', css: 'var(--text-2)' },
  { key: 'text3', label: '弱化色', css: 'var(--text-3)' },
  { key: 'h1', label: '一级标题色', css: 'var(--syntax-h1)' },
  { key: 'h2', label: '二级标题色', css: 'var(--syntax-h2)' },
  { key: 'h3', label: '三级标题色', css: 'var(--syntax-h3)' },
  { key: 'h4', label: '四级标题色', css: 'var(--syntax-h4)' },
  { key: 'h5', label: '五级标题色', css: 'var(--syntax-h5)' },
  { key: 'h6', label: '六级标题色', css: 'var(--syntax-h6)' },
  { key: 'strong', label: '加粗色', css: 'var(--syntax-strong)' },
  { key: 'emphasis', label: '斜体色', css: 'var(--syntax-emphasis)' },
  { key: 'strike', label: '删除线色', css: 'var(--syntax-strike)' },
  { key: 'link', label: '链接色', css: 'var(--syntax-link)' },
  { key: 'inlineCode', label: '行内代码色', css: 'var(--syntax-inline-code)' },
  { key: 'inlineCodeBg', label: '行内代码背景', css: 'var(--syntax-inline-code-bg)' },
  { key: 'codeBlock', label: '代码块文字色', css: 'var(--syntax-code-block)' },
  { key: 'codeBlockBg', label: '代码块背景色', css: 'var(--syntax-code-block-bg)' },
  { key: 'quote', label: '引用文字色', css: 'var(--syntax-quote)' },
  { key: 'quoteBg', label: '引用背景色', css: 'var(--syntax-quote-bg)' },
  { key: 'list', label: '无序列表色', css: 'var(--syntax-list)' },
  { key: 'ordered', label: '有序列表色', css: 'var(--syntax-ordered)' },
  { key: 'task', label: '待办未完成色', css: 'var(--syntax-task)' },
  { key: 'taskDone', label: '待办已完成色', css: 'var(--syntax-task-done)' },
  { key: 'hr', label: '水平线色', css: 'var(--syntax-hr)' },
  { key: 'punct', label: '语法符号色', css: 'var(--syntax-punct)' },
]

const PRESET_KEYS: SyntaxColorKey[] = ['accent', 'accentDeep', 'info', 'text', 'text2', 'text3']

/** The subset shown as quick swatches inside the color picker. */
export const SYNTAX_PRESETS = SYNTAX_COLORS.filter((slot) => PRESET_KEYS.includes(slot.key))

export const SYNTAX_TOKENS: Array<{ key: SyntaxToken; label: string }> = [
  { key: 'heading1', label: '一级标题' },
  { key: 'heading2', label: '二级标题' },
  { key: 'heading3', label: '三级标题' },
  { key: 'heading4', label: '四级标题' },
  { key: 'heading5', label: '五级标题' },
  { key: 'heading6', label: '六级标题' },
  { key: 'strong', label: '加粗' },
  { key: 'emphasis', label: '斜体' },
  { key: 'strikethrough', label: '删除线' },
  { key: 'link', label: '链接 / 网址' },
  { key: 'code', label: '行内代码' },
  { key: 'codeBlock', label: '代码块' },
  { key: 'quote', label: '引用' },
  { key: 'list', label: '无序列表标记' },
  { key: 'ordered', label: '有序列表标记' },
  { key: 'task', label: '待办未完成' },
  { key: 'taskDone', label: '待办已完成' },
  { key: 'hr', label: '水平线' },
  { key: 'punctuation', label: 'Markdown 符号' },
]

export const SYNTAX_PALETTES: Array<{ key: SyntaxPaletteKey; label: string }> = [
  { key: 'default', label: '语义默认' },
  { key: 'vivid', label: '鲜明' },
  { key: 'muted', label: '柔和' },
  { key: 'contrast', label: '高对比' },
]

const PALETTE_COLORS: Record<SyntaxPaletteKey, Record<SyntaxToken, SyntaxColorKey>> = {
  default: {
    heading1: 'h1',
    heading2: 'h2',
    heading3: 'h3',
    heading4: 'h4',
    heading5: 'h5',
    heading6: 'h6',
    strong: 'strong',
    emphasis: 'emphasis',
    strikethrough: 'strike',
    link: 'link',
    code: 'inlineCode',
    codeBlock: 'codeBlock',
    quote: 'quote',
    list: 'list',
    ordered: 'ordered',
    task: 'task',
    taskDone: 'taskDone',
    hr: 'hr',
    punctuation: 'punct',
  },
  vivid: {
    heading1: 'accentDeep',
    heading2: 'accent',
    heading3: 'info',
    heading4: 'info',
    heading5: 'accent',
    heading6: 'text2',
    strong: 'accentDeep',
    emphasis: 'accent',
    strikethrough: 'text3',
    link: 'info',
    code: 'accent',
    codeBlock: 'accentDeep',
    quote: 'info',
    list: 'accentDeep',
    ordered: 'info',
    task: 'accent',
    taskDone: 'accentDeep',
    hr: 'text3',
    punctuation: 'text2',
  },
  muted: {
    heading1: 'text',
    heading2: 'text',
    heading3: 'text2',
    heading4: 'text2',
    heading5: 'text2',
    heading6: 'text3',
    strong: 'text',
    emphasis: 'text2',
    strikethrough: 'text3',
    link: 'text2',
    code: 'text2',
    codeBlock: 'text2',
    quote: 'text3',
    list: 'text2',
    ordered: 'text2',
    task: 'text',
    taskDone: 'text2',
    hr: 'text3',
    punctuation: 'text3',
  },
  contrast: {
    heading1: 'accentDeep',
    heading2: 'accentDeep',
    heading3: 'info',
    heading4: 'text',
    heading5: 'info',
    heading6: 'text',
    strong: 'text',
    emphasis: 'text',
    strikethrough: 'text2',
    link: 'info',
    code: 'accentDeep',
    codeBlock: 'accentDeep',
    quote: 'text',
    list: 'accent',
    ordered: 'info',
    task: 'text',
    taskDone: 'text',
    hr: 'text2',
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

/** Resolve the color a token renders with (custom hex beats palette). */
export function resolveSyntaxColor(prefs: SyntaxPrefs, token: SyntaxToken): SyntaxColorValue {
  return prefs.colors[token] ?? PALETTE_COLORS[prefs.palette][token]
}

/** CSS color expression: custom hex passes through, slots map to theme vars. */
export function syntaxColorCss(color: SyntaxColorValue): string {
  if (color.startsWith('#')) return color
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

  const colors: Partial<Record<SyntaxToken, SyntaxColorValue>> = {}
  const rawColors = record.colors
  if (rawColors && typeof rawColors === 'object') {
    for (const token of TOKEN_KEYS) {
      const value = (rawColors as Record<string, unknown>)[token]
      if (typeof value === 'string' && COLOR_KEYS.includes(value as SyntaxColorKey)) {
        colors[token] = value as SyntaxColorKey
        continue
      }
      const hex = normalizeHexColor(value)
      if (hex) colors[token] = hex
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
