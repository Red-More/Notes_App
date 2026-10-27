import { describe, expect, it } from 'vitest'
import { describeMermaidError, mermaidCacheKey, renderMermaid } from './mermaid'

describe('mermaidCacheKey', () => {
  it('separates themes and normalizes outer whitespace', () => {
    expect(mermaidCacheKey(' graph TD ', 'light')).toBe(mermaidCacheKey('graph TD', 'light'))
    expect(mermaidCacheKey('graph TD', 'light')).not.toBe(
      mermaidCacheKey('graph TD', 'dark'),
    )
  })
})

describe('renderMermaid', () => {
  it('returns a friendly error for empty diagrams without loading the engine', async () => {
    await expect(renderMermaid('   ', 'light')).resolves.toEqual({
      error: '图表内容为空',
    })
  })
})

describe('describeMermaidError', () => {
  it('extracts messages from errors and raw values', () => {
    expect(describeMermaidError(new Error('bad syntax'))).toBe('bad syntax')
    expect(describeMermaidError('bad syntax')).toBe('bad syntax')
  })
})
