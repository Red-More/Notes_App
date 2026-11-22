import {
  EditorSelection,
  type ChangeSpec,
  type EditorState,
  type Line,
  type SelectionRange,
} from '@codemirror/state'
import type { Command, EditorView } from '@codemirror/view'

export interface RangeEdit {
  changes: ChangeSpec
  range: SelectionRange
}

/** Existing ATX heading marker, including the required trailing space. */
const HEADING_PREFIX = /^(#{1,6}) /

/**
 * Lines covered by a selection. A selection ending exactly at a line start
 * does not include that line, so dragging down one line never touches the next.
 */
function selectedLines(state: EditorState, range: SelectionRange): Line[] {
  const first = state.doc.lineAt(range.from).number
  let last = state.doc.lineAt(range.to).number
  if (range.to === state.doc.line(last).from && last > first) last -= 1
  const lines: Line[] = []
  for (let number = first; number <= last; number += 1) lines.push(state.doc.line(number))
  return lines
}

/**
 * Toggle `prefix` on every selected line. Mixed selections only gain the
 * prefix where it is missing, so repeated markers can never stack up.
 * The caret goes after the prefix for a collapsed range, or to the end of the
 * last selected line for a multi-line selection.
 */
export function toggleLinePrefixRange(
  state: EditorState,
  range: SelectionRange,
  prefix: string,
): RangeEdit {
  const lines = selectedLines(state, range)
  const allPrefixed = lines.every((line) => line.text.startsWith(prefix))
  const changes: Array<{ from: number; to?: number; insert: string }> = []
  for (const line of lines) {
    if (allPrefixed) {
      changes.push({ from: line.from, to: line.from + prefix.length, insert: '' })
    } else if (!line.text.startsWith(prefix)) {
      changes.push({ from: line.from, insert: prefix })
    }
  }

  const last = lines[lines.length - 1]
  // Map through every line's edit: insertions on earlier lines shift the end
  // of the last line too. assoc = 1 keeps the caret after an inserted prefix.
  const changeSet = state.changes(changes)
  const caret = range.empty
    ? allPrefixed
      ? last.from
      : changeSet.mapPos(range.head, 1)
    : changeSet.mapPos(last.to, 1)
  return { changes, range: EditorSelection.cursor(caret) }
}

/**
 * Cycle ATX heading levels on the selected lines: none → H1 → … → H6 → none.
 * The first line is the baseline, so repeated taps advance predictably even
 * when the selected lines started at different levels.
 */
export function cycleHeadingRange(state: EditorState, range: SelectionRange): RangeEdit {
  const lines = selectedLines(state, range)
  const firstLevel = HEADING_PREFIX.exec(lines[0].text)?.[1].length ?? 0
  const target = firstLevel >= 6 ? 0 : firstLevel + 1
  const insert = target > 0 ? `${'#'.repeat(target)} ` : ''

  const changes = lines.map((line) => {
    const existing = HEADING_PREFIX.exec(line.text)?.[0].length ?? 0
    return { from: line.from, to: line.from + existing, insert }
  })

  const last = lines[lines.length - 1]
  const changeSet = state.changes(changes)
  // Map through all replacements so earlier lines' level changes shift the end
  // of the last line as well; assoc = 1 lands after the new marker.
  const caret = range.empty
    ? target === 0
      ? last.from
      : changeSet.mapPos(range.head, 1)
    : changeSet.mapPos(last.to, 1)
  return { changes, range: EditorSelection.cursor(caret) }
}

/**
 * Toggle inline markers around one selection range. Markers already sitting
 * directly outside the selection are removed, otherwise they are inserted with
 * the selection kept between them. Collapsed selections insert `****` and place
 * the caret in the middle.
 */
export function toggleInlineRange(
  state: EditorState,
  range: SelectionRange,
  marker: string,
): RangeEdit {
  const size = marker.length
  const from = range.from
  const to = range.to
  const text = state.sliceDoc(from, to)
  const before = state.sliceDoc(Math.max(0, from - size), from)
  const after = state.sliceDoc(to, Math.min(state.doc.length, to + size))

  if (before === marker && after === marker) {
    const start = from - size
    return {
      changes: { from: start, to: to + size, insert: text },
      range: EditorSelection.range(start, start + text.length),
    }
  }

  return {
    changes: { from, to, insert: marker + text + marker },
    range: EditorSelection.range(from + size, from + size + text.length),
  }
}

/** Wrap or unwrap the selection with an inline markdown marker. */
export function toggleInlineMarker(marker: string): Command {
  return (view: EditorView) => {
    const spec = view.state.changeByRange((range) =>
      toggleInlineRange(view.state, range, marker),
    )
    view.dispatch(spec, { userEvent: 'input.format' })
    return true
  }
}

/** Insert `[text](url)`, keeping the selected text as the label and selecting the URL. */
export const insertMarkdownLink: Command = (view: EditorView) => {
  const spec = view.state.changeByRange((range) => {
    const text = view.state.sliceDoc(range.from, range.to) || '链接文字'
    const insert = `[${text}](url)`
    return {
      changes: { from: range.from, to: range.to, insert },
      // Select the `url` placeholder so typing replaces it directly.
      range: EditorSelection.range(
        range.from + text.length + 3,
        range.from + insert.length - 1,
      ),
    }
  })
  view.dispatch(spec, { userEvent: 'input.format' })
  return true
}
