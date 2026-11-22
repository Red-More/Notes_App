import { describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import { ensureSyntaxTree } from '@codemirror/language'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { syntaxMarksIn, type SyntaxMark } from './syntaxMarks'

function marksFor(doc: string): SyntaxMark[] {
  const state = EditorState.create({
    doc,
    extensions: [markdown({ base: markdownLanguage })],
  })
  ensureSyntaxTree(state, doc.length, 5000)
  return syntaxMarksIn(state, 0, doc.length)
}

function classAt(marks: SyntaxMark[], pos: number): string {
  return marks.find((mark) => pos >= mark.from && pos < mark.to)?.className ?? ''
}

describe('syntaxMarksIn', () => {
  const sample = [
    '# Title',
    '- a',
    '  - b',
    '    - [x] c',
    '> q',
    '>> qq',
  ].join('\n')
  const marks = marksFor(sample)

  it('marks headings with their level', () => {
    expect(classAt(marks, sample.indexOf('#'))).toContain('cm-md-heading-1')
  })

  it('marks unordered lists with a decreasing depth class', () => {
    const first = classAt(marks, sample.indexOf('- a'))
    const second = classAt(marks, sample.indexOf('- b'))
    const third = classAt(marks, sample.indexOf('- [x]'))
    expect(first).toContain('cm-md-list-mark')
    expect(first).toContain('cm-md-depth-1')
    expect(second).toContain('cm-md-depth-2')
    expect(third).toContain('cm-md-depth-3')
  })

  it('marks checked task boxes with the done class', () => {
    const task = classAt(marks, sample.indexOf('[x]'))
    expect(task).toContain('cm-md-task-mark')
    expect(task).toContain('cm-md-task-done')
    expect(task).toContain('cm-md-depth-3')
  })

  it('marks quote depth', () => {
    const first = classAt(marks, sample.indexOf('> q'))
    const nested = classAt(marks, sample.lastIndexOf('>>'))
    const inner = classAt(marks, sample.lastIndexOf('>>') + 1)
    expect(first).toContain('cm-md-quote-mark')
    expect(first).toContain('cm-md-depth-1')
    expect(nested).toContain('cm-md-depth-1')
    expect(inner).toContain('cm-md-depth-2')
  })

  it('separates ordered list marks from unordered ones', () => {
    const ordered = marksFor('1. one\n   1. two')
    const first = ordered.find((mark) => mark.from === 0)?.className ?? ''
    expect(first).toContain('cm-md-ordered-mark')
    expect(first).toContain('cm-md-depth-1')
    // The nested marker is the only ordered mark at depth 2.
    expect(
      ordered.some(
        (mark) =>
          mark.className.includes('cm-md-ordered-mark') &&
          mark.className.includes('cm-md-depth-2'),
      ),
    ).toBe(true)
  })
})
