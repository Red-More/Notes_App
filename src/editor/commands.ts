import {
  EditorSelection,
  type ChangeSpec,
  type EditorState,
  type SelectionRange,
} from '@codemirror/state'
import type { Command, EditorView } from '@codemirror/view'

export interface RangeEdit {
  changes: ChangeSpec
  range: SelectionRange
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
