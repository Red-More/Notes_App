import { describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import { findUnclosedFence } from './diagnostics'

function diagnosticsFor(doc: string) {
  return findUnclosedFence(EditorState.create({ doc }))
}

describe('findUnclosedFence', () => {
  it('flags a fenced block without a closing fence', () => {
    const diagnostics = diagnosticsFor('```js\nconst a = 1\n')
    expect(diagnostics).toHaveLength(1)
    expect(diagnostics[0].severity).toBe('warning')
    expect(diagnostics[0].message).toContain('代码块未闭合')
    expect(diagnostics[0].from).toBe(0)
  })

  it('accepts a properly closed block', () => {
    expect(diagnosticsFor('```js\nconst a = 1\n```\n')).toEqual([])
  })

  it('accepts tilde fences and longer closers', () => {
    expect(diagnosticsFor('~~~~\ncode\n~~~~\n')).toEqual([])
    expect(diagnosticsFor('```\ncode\n`````\n')).toEqual([])
  })

  it('flags a mismatched closing marker', () => {
    expect(diagnosticsFor('```\ncode\n~~~\n')).toHaveLength(1)
  })

  it('ignores inline code and indented text', () => {
    expect(diagnosticsFor('使用 `code` 示例\n    indented\n')).toEqual([])
  })
})
