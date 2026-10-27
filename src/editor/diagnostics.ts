import type { EditorState } from '@codemirror/state'
import type { Diagnostic } from '@codemirror/lint'

/**
 * Real-time syntax hint: report an opening fenced code block that never gets a
 * closing fence. Matching follows CommonMark's "same character, at least as
 * long" rule closely enough for editor feedback.
 */
export function findUnclosedFence(state: EditorState): Diagnostic[] {
  let open: { pos: number; marker: string; size: number } | null = null
  for (let n = 1; n <= state.doc.lines; n++) {
    const line = state.doc.line(n)
    const match = /^ {0,3}(`{3,}|~{3,})/.exec(line.text)
    if (!match) continue
    if (!open) {
      open = { pos: line.from, marker: match[1][0], size: match[1].length }
    } else if (match[1][0] === open.marker && match[1].length >= open.size) {
      open = null
    }
  }
  if (!open) return []
  return [
    {
      from: open.pos,
      to: open.pos + open.size,
      severity: 'warning',
      message: '代码块未闭合：请补充结束围栏',
    },
  ]
}
