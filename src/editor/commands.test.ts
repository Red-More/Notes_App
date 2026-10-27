import { describe, expect, it } from 'vitest'
import { EditorSelection, EditorState } from '@codemirror/state'
import { toggleInlineRange } from './commands'

function stateWith(doc: string, anchor: number, head = anchor): EditorState {
  return EditorState.create({ doc, selection: { anchor, head } })
}

function apply(state: EditorState, marker: string): EditorState {
  const edit = toggleInlineRange(state, state.selection.main, marker)
  return state.update({
    changes: edit.changes,
    selection: EditorSelection.create([edit.range]),
  }).state
}

describe('toggleInlineRange', () => {
  it('wraps a non-empty selection', () => {
    const next = apply(stateWith('hello', 0, 5), '**')
    expect(next.doc.toString()).toBe('**hello**')
    expect(next.selection.main.from).toBe(2)
    expect(next.selection.main.to).toBe(7)
  })

  it('unwraps markers sitting outside the selection', () => {
    const next = apply(stateWith('**hello**', 2, 7), '**')
    expect(next.doc.toString()).toBe('hello')
    expect(next.selection.main.from).toBe(0)
    expect(next.selection.main.to).toBe(5)
  })

  it('inserts an empty pair for a collapsed cursor and keeps it between markers', () => {
    const next = apply(stateWith('ab', 1), '`')
    expect(next.doc.toString()).toBe('a``b')
    expect(next.selection.main.empty).toBe(true)
    expect(next.selection.main.head).toBe(2)
  })

  it('supports other markdown markers', () => {
    const next = apply(stateWith('text', 0, 4), '*')
    expect(next.doc.toString()).toBe('*text*')
    expect(next.selection.main.from).toBe(1)
    expect(next.selection.main.to).toBe(5)
  })
})
