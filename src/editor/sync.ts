export interface PreviewBlock {
  /** 1-based source line this block starts at. */
  line: number
  /** Offset relative to the preview scroll content, in CSS px. */
  top: number
  /** Block height, in CSS px. */
  height: number
}

/** Index of the last block whose top is at or before `offset`. */
function blockIndexAt(blocks: PreviewBlock[], offset: number): number {
  let low = 0
  let high = blocks.length - 1
  let found = 0
  while (low <= high) {
    const mid = (low + high) >> 1
    if (blocks[mid].top <= offset) {
      found = mid
      low = mid + 1
    } else {
      high = mid - 1
    }
  }
  return found
}

/**
 * Source line corresponding to a preview scroll offset. Interpolates between
 * the two surrounding blocks so slow scrolling maps smoothly instead of
 * snapping to a block boundary. Returns null when there is nothing to map.
 */
export function lineAtOffset(blocks: PreviewBlock[], offset: number): number | null {
  if (blocks.length === 0) return null
  if (offset <= blocks[0].top) return blocks[0].line
  const index = blockIndexAt(blocks, offset)
  const current = blocks[index]
  const next = blocks[index + 1]
  if (!next || offset >= next.top) return current.line
  const span = next.top - current.top
  if (span <= 0 || next.line === current.line) return current.line
  const progress = (offset - current.top) / span
  return Math.round(current.line + (next.line - current.line) * progress)
}

/**
 * Preview scroll offset that corresponds to a source line. Interpolates between
 * the block at or before the line and the next block, which keeps the preview
 * from jumping when the editor is scrolled continuously.
 */
export function offsetForLine(blocks: PreviewBlock[], line: number): number | null {
  if (blocks.length === 0) return null
  if (line <= blocks[0].line) return blocks[0].top

  let low = 0
  let high = blocks.length - 1
  let found = 0
  while (low <= high) {
    const mid = (low + high) >> 1
    if (blocks[mid].line <= line) {
      found = mid
      low = mid + 1
    } else {
      high = mid - 1
    }
  }

  const current = blocks[found]
  const next = blocks[found + 1]
  if (!next || next.line === current.line) return current.top
  const progress = (line - current.line) / (next.line - current.line)
  return Math.round(current.top + progress * (next.top - current.top))
}
