import { describe, expect, it } from 'vitest'
import { lineAtOffset, offsetForLine, type PreviewBlock } from './sync'

const BLOCKS: PreviewBlock[] = [
  { line: 1, top: 0, height: 20 },
  { line: 5, top: 80, height: 20 },
  { line: 10, top: 180, height: 40 },
]

describe('lineAtOffset', () => {
  it('maps the top of the preview to the first block', () => {
    expect(lineAtOffset(BLOCKS, 0)).toBe(1)
    expect(lineAtOffset(BLOCKS, -20)).toBe(1)
  })

  it('interpolates between blocks while scrolling', () => {
    expect(lineAtOffset(BLOCKS, 40)).toBe(3)
    expect(lineAtOffset(BLOCKS, 130)).toBe(8)
  })

  it('snaps to a block top exactly', () => {
    expect(lineAtOffset(BLOCKS, 80)).toBe(5)
    expect(lineAtOffset(BLOCKS, 180)).toBe(10)
  })

  it('returns the last block line below the content end', () => {
    expect(lineAtOffset(BLOCKS, 400)).toBe(10)
  })

  it('handles empty input and duplicate lines', () => {
    expect(lineAtOffset([], 10)).toBeNull()
    const nested: PreviewBlock[] = [
      { line: 2, top: 0, height: 30 },
      { line: 2, top: 0, height: 18 },
      { line: 4, top: 40, height: 18 },
    ]
    // Between two annotated blocks the line is interpolated.
    expect(lineAtOffset(nested, 10)).toBe(3)
    expect(lineAtOffset(nested, 40)).toBe(4)
  })
})

describe('offsetForLine', () => {
  it('finds the block containing a source line', () => {
    expect(offsetForLine(BLOCKS, 1)).toBe(0)
    expect(offsetForLine(BLOCKS, 5)).toBe(80)
    expect(offsetForLine(BLOCKS, 10)).toBe(180)
  })

  it('interpolates between block positions', () => {
    expect(offsetForLine(BLOCKS, 3)).toBe(40)
    expect(offsetForLine(BLOCKS, 7)).toBe(120)
  })

  it('clamps lines outside the mapped range', () => {
    expect(offsetForLine(BLOCKS, 0)).toBe(0)
    expect(offsetForLine(BLOCKS, 99)).toBe(180)
  })

  it('handles empty input', () => {
    expect(offsetForLine([], 3)).toBeNull()
  })

  it('round-trips a block boundary', () => {
    for (const block of BLOCKS) {
      const offset = offsetForLine(BLOCKS, block.line)
      expect(offset).toBe(block.top)
      expect(lineAtOffset(BLOCKS, offset ?? 0)).toBe(block.line)
    }
  })
})
