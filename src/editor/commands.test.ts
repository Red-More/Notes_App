import { describe, expect, it } from 'vitest'
import { EditorSelection, EditorState } from '@codemirror/state'
import {
  cycleHeadingRange,
  toggleInlineRange,
  toggleLinePrefixRange,
} from './commands'

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

function applyLineEdit(
  state: EditorState,
  edit: ReturnType<typeof toggleLinePrefixRange>,
): EditorState {
  return state.update({
    changes: edit.changes,
    selection: EditorSelection.create([edit.range]),
  }).state
}

describe('toggleLinePrefixRange', () => {
  it('puts the caret after the inserted prefix', () => {
    const state = stateWith('abc', 0)
    const next = applyLineEdit(
      state,
      toggleLinePrefixRange(state, state.selection.main, '- '),
    )
    expect(next.doc.toString()).toBe('- abc')
    expect(next.selection.main.head).toBe(2)
    expect(next.selection.main.empty).toBe(true)
  })

  it('removes an existing prefix and returns to the line start', () => {
    const state = stateWith('- abc', 2)
    const next = applyLineEdit(
      state,
      toggleLinePrefixRange(state, state.selection.main, '- '),
    )
    expect(next.doc.toString()).toBe('abc')
    expect(next.selection.main.head).toBe(0)
  })

  it('prefixes every selected line and ends at the last line text end', () => {
    const state = stateWith('a\nb', 0, 3)
    const next = applyLineEdit(
      state,
      toggleLinePrefixRange(state, state.selection.main, '- '),
    )
    expect(next.doc.toString()).toBe('- a\n- b')
    expect(next.selection.main.head).toBe(7)
  })

  it('removes prefixes from every line and ends at the last line text end', () => {
    const state = stateWith('- a\n- b', 0, 7)
    const next = applyLineEdit(
      state,
      toggleLinePrefixRange(state, state.selection.main, '- '),
    )
    expect(next.doc.toString()).toBe('a\nb')
    expect(next.selection.main.head).toBe(3)
  })

  it('never stacks a prefix on lines that already have one', () => {
    const state = stateWith('a\n- b', 0, 3)
    const next = applyLineEdit(
      state,
      toggleLinePrefixRange(state, state.selection.main, '- '),
    )
    expect(next.doc.toString()).toBe('- a\n- b')
    expect(next.selection.main.head).toBe(7)
  })

  it('excludes a line that the selection only touches at its start', () => {
    const state = stateWith('a\nb', 0, 2)
    const next = applyLineEdit(
      state,
      toggleLinePrefixRange(state, state.selection.main, '- '),
    )
    expect(next.doc.toString()).toBe('- a\nb')
  })
})

describe('cycleHeadingRange', () => {
  function cycle(doc: string, anchor: number, head = anchor, times = 1): EditorState {
    let state = stateWith(doc, anchor, head)
    for (let i = 0; i < times; i += 1) {
      state = applyLineEdit(state, cycleHeadingRange(state, state.selection.main))
    }
    return state
  }

  it('adds H1 first and keeps the caret after the marker', () => {
    const next = cycle('abc', 0)
    expect(next.doc.toString()).toBe('# abc')
    expect(next.selection.main.head).toBe(2)
  })

  it('advances one level per tap until H6, then clears it', () => {
    const next = cycle('abc', 0, 0, 6)
    expect(next.doc.toString()).toBe('###### abc')
    expect(next.selection.main.head).toBe(7)

    const cleared = cycle('abc', 0, 0, 7)
    expect(cleared.doc.toString()).toBe('abc')
    expect(cleared.selection.main.head).toBe(0)
  })

  it('normalizes a mixed selection to the first line level plus one', () => {
    const state = stateWith('## a\nb', 0, 6)
    const next = applyLineEdit(state, cycleHeadingRange(state, state.selection.main))
    expect(next.doc.toString()).toBe('### a\n### b')
    expect(next.selection.main.head).toBe(next.doc.length)
  })
})
