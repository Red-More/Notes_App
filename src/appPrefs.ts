import {
  DEFAULT_REMINDER_SOUND,
  isReminderSoundId,
  type ReminderSoundId,
} from './reminders/ringtones'

export type FontScale = 's' | 'm' | 'l' | 'xl'

export interface AppPrefs {
  /** Local-only display name; never leaves the device. */
  displayName: string
  /** Master switch for due reminders (todos). */
  remindersEnabled: boolean
  /** Ringtone played when a todo reminder fires. */
  reminderSound: ReminderSoundId
  /**
   * Keep ringing on silent / do-not-disturb devices until the user dismisses
   * the alarm. Only meaningful while reminder notifications are enabled.
   */
  forceReminder: boolean
  /** UI type scale; rem-based styles follow the root font size. */
  fontScale: FontScale
  /** Percent offset (-range..+range) applied on top of the selected tier. */
  fontFine: number
  /**
   * 是否在日历上标出"没写日记"的日子。默认关闭：漏写一天不该变成压力，
   * 只有用户主动打开才用红点提醒。
   */
  markMissedDiary: boolean
}

export const MAX_DISPLAY_NAME_LENGTH = 24

/**
 * Tier ratios keep a visible gap (~10-12%) between neighbours, so every chip
 * click changes the rendered size at a glance instead of inching by 1-2%.
 */
export const FONT_SCALE_OPTIONS: Array<{ key: FontScale; label: string; ratio: number }> = [
  { key: 's', label: 'S', ratio: 0.9 },
  { key: 'm', label: 'M', ratio: 1 },
  { key: 'l', label: 'L', ratio: 1.12 },
  { key: 'xl', label: 'XL', ratio: 1.25 },
]

/** Fine-tune bounds in percent, applied around the selected tier. */
export const FONT_FINE_RANGE = 6

/** Defaults stored by older builds; map them to their nearest new tier. */
const LEGACY_FONT_SCALES: Record<string, FontScale> = {
  standard: 'm',
  large: 'l',
  extra: 'xl',
}

export const DEFAULT_APP_PREFS: AppPrefs = {
  displayName: '本机用户',
  remindersEnabled: true,
  reminderSound: DEFAULT_REMINDER_SOUND,
  forceReminder: false,
  fontScale: 'm',
  fontFine: 0,
  markMissedDiary: false,
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

/** Accept current tier keys and migrate the three legacy names in place. */
function sanitizeFontScale(value: unknown): FontScale {
  if (isFontScale(value)) return value
  if (
    typeof value === 'string' &&
    Object.prototype.hasOwnProperty.call(LEGACY_FONT_SCALES, value)
  ) {
    return LEGACY_FONT_SCALES[value]
  }
  return DEFAULT_APP_PREFS.fontScale
}

function sanitizeFontFine(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0
  return Math.max(-FONT_FINE_RANGE, Math.min(FONT_FINE_RANGE, Math.round(value)))
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
    reminderSound: isReminderSoundId(record.reminderSound)
      ? record.reminderSound
      : DEFAULT_APP_PREFS.reminderSound,
    forceReminder:
      typeof record.forceReminder === 'boolean'
        ? record.forceReminder
        : DEFAULT_APP_PREFS.forceReminder,
    fontScale: sanitizeFontScale(record.fontScale),
    fontFine: sanitizeFontFine(record.fontFine),
    markMissedDiary:
      typeof record.markMissedDiary === 'boolean'
        ? record.markMissedDiary
        : DEFAULT_APP_PREFS.markMissedDiary,
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

/** Effective ratio: tier ratio plus the fine offset, e.g. 1.12 * 1.02. */
function effectiveFontRatio(prefs: AppPrefs): number {
  return fontRatio(prefs.fontScale) * (1 + prefs.fontFine / 100)
}

/** Apply the type scale to the root element so rem-based UI follows it. */
export function applyFontScale(prefs: AppPrefs = getAppPrefs()): void {
  const ratio = Number(effectiveFontRatio(prefs).toFixed(4))
  document.documentElement.style.setProperty('--font-scale', String(ratio))
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
      patch.displayName !== undefined
        ? sanitizeDisplayName(patch.displayName)
        : current.displayName,
    remindersEnabled: patch.remindersEnabled ?? current.remindersEnabled,
    reminderSound: isReminderSoundId(patch.reminderSound)
      ? patch.reminderSound
      : current.reminderSound,
    forceReminder: patch.forceReminder ?? current.forceReminder,
    fontScale: isFontScale(patch.fontScale) ? patch.fontScale : current.fontScale,
    // Match the tier rule: a malformed patch keeps the stored value, while a
    // numeric patch is rounded and clamped into range.
    fontFine:
      typeof patch.fontFine === 'number' ? sanitizeFontFine(patch.fontFine) : current.fontFine,
    markMissedDiary: patch.markMissedDiary ?? current.markMissedDiary,
  }
  cached = next
  localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  if (patch.fontScale !== undefined || patch.fontFine !== undefined) applyFontScale(next)
  for (const listener of listeners) listener()
  return next
}

export function subscribeAppPrefs(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
