export interface LayoutPrefs {
  /**
   * Divider position: the editor's share of the split area, 0-100. Persisted so
   * the next editor session restores the last position the user chose.
   */
  ratio: number
}

/** The divider can hide either pane completely: 0 = preview only, 100 = editor only. */
export const MIN_SPLIT_RATIO = 0
export const MAX_SPLIT_RATIO = 100

/** Default divider position: the preview is hidden and the editor fills the page. */
export const DEFAULT_SPLIT_RATIO = MAX_SPLIT_RATIO

/** A released divider this close to an edge collapses fully onto that edge. */
export const SPLIT_SNAP_RATIO = 8

/** Divider hit area height in CSS px; the handle overlays the pane boundary. */
export const SPLIT_HANDLE_SIZE = 24

export const DEFAULT_LAYOUT_PREFS: LayoutPrefs = {
  ratio: DEFAULT_SPLIT_RATIO,
}

const STORAGE_KEY = 'notes:editor-layout'

/** Keep a ratio inside 0-100 and snap to whole percentages. */
export function clampSplitRatio(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_SPLIT_RATIO
  return Math.min(MAX_SPLIT_RATIO, Math.max(MIN_SPLIT_RATIO, Math.round(value)))
}

/** Snap a released ratio onto the nearest fully hidden pane when close enough. */
export function snapSplitRatio(value: number): number {
  const clamped = clampSplitRatio(value)
  if (clamped <= SPLIT_SNAP_RATIO) return MIN_SPLIT_RATIO
  if (clamped >= MAX_SPLIT_RATIO - SPLIT_SNAP_RATIO) return MAX_SPLIT_RATIO
  return clamped
}

/**
 * Divider position after dragging `deltaY` px from `startRatio`. Using the
 * delta (instead of the absolute pointer position) keeps the grab offset, so
 * the divider never jumps when the user grabs the edge of its hit area.
 */
export function ratioFromDrag(
  startRatio: number,
  deltaY: number,
  containerHeight: number,
): number {
  if (!Number.isFinite(deltaY) || containerHeight <= 0) return clampSplitRatio(startRatio)
  return clampSplitRatio(startRatio + (deltaY / containerHeight) * 100)
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
  }
}

export function getLayoutPrefs(): LayoutPrefs {
  return parseLayoutPrefs(localStorage.getItem(STORAGE_KEY))
}

export function setLayoutPrefs(prefs: LayoutPrefs): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ ratio: clampSplitRatio(prefs.ratio) }))
}

/** Clear only the layout config; editor / save / theme prefs stay untouched. */
export function clearLayoutPrefs(): void {
  localStorage.removeItem(STORAGE_KEY)
}
