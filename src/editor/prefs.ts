export type IndentStyle = 'spaces' | 'tabs'

export interface EditorPrefs {
  indentStyle: IndentStyle
  indentSize: number
}

export const INDENT_SIZES = [2, 4, 8] as const

export const DEFAULT_EDITOR_PREFS: EditorPrefs = {
  indentStyle: 'spaces',
  indentSize: 2,
}

const STORAGE_KEY = 'notes:editor-prefs'

/** Parse persisted preferences; unknown or malformed values fall back to defaults. */
export function parseEditorPrefs(raw: string | null): EditorPrefs {
  let data: unknown = null
  try {
    data = raw ? JSON.parse(raw) : null
  } catch {
    data = null
  }
  const record = (data && typeof data === 'object' ? data : {}) as Partial<EditorPrefs>
  const indentStyle: IndentStyle =
    record.indentStyle === 'tabs' || record.indentStyle === 'spaces'
      ? record.indentStyle
      : DEFAULT_EDITOR_PREFS.indentStyle
  const indentSize =
    typeof record.indentSize === 'number' &&
    (INDENT_SIZES as readonly number[]).includes(record.indentSize)
      ? record.indentSize
      : DEFAULT_EDITOR_PREFS.indentSize
  return { indentStyle, indentSize }
}

/** Read the persisted editor preferences for a new editor session. */
export function getEditorPrefs(): EditorPrefs {
  return parseEditorPrefs(localStorage.getItem(STORAGE_KEY))
}

/** Persist editor preferences; the next opened note picks them up. */
export function setEditorPrefs(prefs: EditorPrefs): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs))
}

/** The literal inserted for one indentation unit. */
export function indentUnitFor(prefs: EditorPrefs): string {
  return prefs.indentStyle === 'tabs' ? '\t' : ' '.repeat(prefs.indentSize)
}
