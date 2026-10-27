export type LayoutMode = 'closed' | 'split' | 'preview'

export interface LayoutPrefs {
  /** Editor share of the split area when the preview is open, 10-90. */
  ratio: number
  /** Whether the preview pane is visible at all. */
  previewOpen: boolean
  /** Whether the open preview hides the editor (preview-only mode). */
  previewOnly: boolean
}

export const MIN_SPLIT_RATIO = 10
export const MAX_SPLIT_RATIO = 90
export const DEFAULT_SPLIT_RATIO = 55

/** Divider hit area height in CSS px; the page's flex math uses the same value. */
export const SPLIT_HANDLE_SIZE = 24

export const DEFAULT_LAYOUT_PREFS: LayoutPrefs = {
  ratio: DEFAULT_SPLIT_RATIO,
  previewOpen: false,
  previewOnly: false,
}

const STORAGE_KEY = 'notes:editor-layout'

/** Keep a ratio inside 10-90 and snap to whole percentages. */
export function clampSplitRatio(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_SPLIT_RATIO
  return Math.min(MAX_SPLIT_RATIO, Math.max(MIN_SPLIT_RATIO, Math.round(value)))
}

/** Parse persisted layout config; missing or invalid fields fall back to defaults. */
export function parseLayoutPrefs(raw: string | null): LayoutPrefs {
  let data: unknown = null
  try {
    data = raw ? JSON.parse(raw) : null
  } catch {
    data = null
  }
  const record = (data && typeof data === 'object' ? data : {}) as Partial<LayoutPrefs>
  return {
    ratio:
      typeof record.ratio === 'number'
        ? clampSplitRatio(record.ratio)
        : DEFAULT_LAYOUT_PREFS.ratio,
    previewOpen: record.previewOpen === true,
    previewOnly: record.previewOnly === true,
  }
}

export function getLayoutPrefs(): LayoutPrefs {
  return parseLayoutPrefs(localStorage.getItem(STORAGE_KEY))
}

export function setLayoutPrefs(prefs: LayoutPrefs): void {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      ratio: clampSplitRatio(prefs.ratio),
      previewOpen: prefs.previewOpen === true,
      previewOnly: prefs.previewOnly === true,
    }),
  )
}

/** Clear only the layout config; editor / save / theme prefs stay untouched. */
export function clearLayoutPrefs(): void {
  localStorage.removeItem(STORAGE_KEY)
}

export function layoutModeOf(prefs: LayoutPrefs): LayoutMode {
  if (!prefs.previewOpen) return 'closed'
  return prefs.previewOnly ? 'preview' : 'split'
}

/**
 * Switch the visible layout mode. Closing the preview keeps the preferred
 * preview mode, so the eye button can reopen the last used layout.
 */
export function withLayoutMode(prefs: LayoutPrefs, mode: LayoutMode): LayoutPrefs {
  if (mode === 'closed') return { ...prefs, previewOpen: false }
  return { ...prefs, previewOpen: true, previewOnly: mode === 'preview' }
}

/** Clicking the divider flips which pane dominates; exactly 50/50 jumps to 70. */
export function toggleSplitRatio(ratio: number): number {
  const clamped = clampSplitRatio(ratio)
  if (clamped >= 45 && clamped <= 55) return 70
  return clampSplitRatio(100 - clamped)
}

/**
 * Editor share from a pointer position inside the split container. The divider
 * is centred on the editor's bottom edge, so half of its height is subtracted.
 */
export function ratioFromPointer(
  clientY: number,
  containerTop: number,
  containerHeight: number,
  handleSize = SPLIT_HANDLE_SIZE,
): number {
  const usable = containerHeight - handleSize
  if (usable <= 0) return DEFAULT_SPLIT_RATIO
  return clampSplitRatio(((clientY - containerTop - handleSize / 2) / usable) * 100)
}
