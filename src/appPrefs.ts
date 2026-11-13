export type FontScale = 'standard' | 'large' | 'extra'

export interface AppPrefs {
  /** Local-only display name; never leaves the device. */
  displayName: string
  /** Master switch for due reminders (todos). */
  remindersEnabled: boolean
  /** UI type scale; rem-based styles follow the root font size. */
  fontScale: FontScale
}

export const MAX_DISPLAY_NAME_LENGTH = 24

export const FONT_SCALE_OPTIONS: Array<{ key: FontScale; label: string; ratio: number }> = [
  { key: 'standard', label: '标准', ratio: 1 },
  { key: 'large', label: '大', ratio: 1.1 },
  { key: 'extra', label: '特大', ratio: 1.2 },
]

export const DEFAULT_APP_PREFS: AppPrefs = {
  displayName: '本机用户',
  remindersEnabled: true,
  fontScale: 'standard',
}

const STORAGE_KEY = 'notes:app-prefs'

function sanitizeDisplayName(value: unknown): string {
  if (typeof value !== 'string') return DEFAULT_APP_PREFS.displayName
  const name = value.trim().slice(0, MAX_DISPLAY_NAME_LENGTH)
  return name || DEFAULT_APP_PREFS.displayName
}

function isFontScale(value: unknown): value is FontScale {
  return FONT_SCALE_OPTIONS.some((option) => option.key === value)
}

/** Parse persisted preferences; unknown or malformed fields fall back to defaults. */
export function parseAppPrefs(raw: string | null): AppPrefs {
  let data: unknown = null
  try {
    data = raw ? JSON.parse(raw) : null
  } catch {
    data = null
  }
  const record = (data && typeof data === 'object' ? data : {}) as Partial<AppPrefs>
  return {
    displayName: sanitizeDisplayName(record.displayName),
    remindersEnabled:
      typeof record.remindersEnabled === 'boolean'
        ? record.remindersEnabled
        : DEFAULT_APP_PREFS.remindersEnabled,
    fontScale: isFontScale(record.fontScale) ? record.fontScale : DEFAULT_APP_PREFS.fontScale,
  }
}

let cached: AppPrefs | null = null
const listeners = new Set<() => void>()

export function getAppPrefs(): AppPrefs {
  if (!cached) cached = parseAppPrefs(localStorage.getItem(STORAGE_KEY))
  return cached
}

function fontRatio(scale: FontScale): number {
  return FONT_SCALE_OPTIONS.find((option) => option.key === scale)?.ratio ?? 1
}

/** Apply the type scale to the root element so rem-based UI follows it. */
export function applyFontScale(prefs: AppPrefs = getAppPrefs()): void {
  document.documentElement.style.setProperty('--font-scale', String(fontRatio(prefs.fontScale)))
  document.documentElement.dataset.fontScale = prefs.fontScale
}

/**
 * Persist a partial update, refresh the type scale when needed, and notify
 * subscribers so every settings row reflects the new value immediately.
 */
export function setAppPrefs(patch: Partial<AppPrefs>): AppPrefs {
  const current = getAppPrefs()
  const next: AppPrefs = {
    displayName:
      patch.displayName !== undefined ? sanitizeDisplayName(patch.displayName) : current.displayName,
    remindersEnabled: patch.remindersEnabled ?? current.remindersEnabled,
    fontScale: isFontScale(patch.fontScale) ? patch.fontScale : current.fontScale,
  }
  cached = next
  localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  if (patch.fontScale !== undefined) applyFontScale(next)
  for (const listener of listeners) listener()
  return next
}

export function subscribeAppPrefs(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
