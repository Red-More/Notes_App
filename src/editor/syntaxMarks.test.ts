import { describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import { ensureSyntaxTree } from '@codemirror/language'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { syntaxLineMarksIn, syntaxMarksIn, type SyntaxMark } from './syntaxMarks'

function stateFor(doc: string): EditorState {
  const state = EditorState.create({
    doc,
    extensions: [markdown({ base: markdownLanguage })],
  })
  ensureSyntaxTree(state, doc.length, 5000)
  return state
}

function marksFor(doc: string): SyntaxMark[] {
  return syntaxMarksIn(stateFor(doc), 0, doc.length)
}

function classAt(marks: SyntaxMark[], pos: number): string {
  return marks.find((mark) => pos >= mark.from && pos < mark.to)?.className ?? ''
}

describe('syntaxMarksIn', () => {
  const sample = ['# Title', '- a', '  - b', '    - [x] c', '> q', '>> qq'].join('\n')
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
          mark.className.includes('cm-md-ordered-mark') && mark.className.includes('cm-md-depth-2'),
      ),
    ).toBe(true)
  })

  it('distinguishes inline code from code-block text', () => {
    const doc = '`inline`\n\n```js\nconst a = 1\n```\n\n> quote\n> more'
    const marks = marksFor(doc)
    expect(classAt(marks, doc.indexOf('inline'))).toContain('cm-md-inline-code')
    expect(classAt(marks, doc.indexOf('const'))).toContain('cm-md-codeblock-text')
  })
})

describe('syntaxLineMarksIn', () => {
  it('marks every code-block and quote line', () => {
    const doc = '`inline`\n\n```js\nconst a = 1\n```\n\n> quote\n> more'
    const state = stateFor(doc)
    const lines = syntaxLineMarksIn(state, 0, doc.length)
    const classAtLine = (lineNumber: number) =>
      lines.find((line) => line.from === state.doc.line(lineNumber).from)?.className ?? ''

    expect(classAtLine(3)).toContain('cm-md-code-line')
    expect(classAtLine(4)).toContain('cm-md-code-line')
    expect(classAtLine(5)).toContain('cm-md-code-line')
    expect(classAtLine(7)).toContain('cm-md-quote-line')
    expect(classAtLine(7)).toContain('cm-md-depth-1')
    expect(classAtLine(8)).toContain('cm-md-quote-line')
  })
})
