import { describe, expect, it } from 'vitest'
import {
  DEFAULT_LAYOUT_PREFS,
  DEFAULT_SPLIT_RATIO,
  clampSplitRatio,
  parseLayoutPrefs,
  ratioFromDrag,
  snapSplitRatio,
} from './layout'

describe('parseLayoutPrefs', () => {
  it('falls back to defaults for missing or malformed values', () => {
    expect(parseLayoutPrefs(null)).toEqual(DEFAULT_LAYOUT_PREFS)
    expect(parseLayoutPrefs('')).toEqual(DEFAULT_LAYOUT_PREFS)
    expect(parseLayoutPrefs('not json')).toEqual(DEFAULT_LAYOUT_PREFS)
    expect(parseLayoutPrefs('{"ratio":"60"}')).toEqual(DEFAULT_LAYOUT_PREFS)
  })

  it('clamps persisted ratios into the 0-100 range', () => {
    expect(parseLayoutPrefs('{"ratio":200}').ratio).toBe(100)
    expect(parseLayoutPrefs('{"ratio":-5}').ratio).toBe(0)
    expect(parseLayoutPrefs('{"ratio":63.4}').ratio).toBe(63)
  })

  it('ignores the retired view-mode flags', () => {
    expect(
      parseLayoutPrefs('{"ratio":40,"previewOpen":true,"previewOnly":true}'),
    ).toEqual({ ratio: 40 })
  })

  it('defaults the divider to the editor-only position', () => {
    expect(DEFAULT_LAYOUT_PREFS.ratio).toBe(100)
    expect(DEFAULT_SPLIT_RATIO).toBe(100)
  })
})

describe('clampSplitRatio', () => {
  it('keeps values inside 0-100 and rounds', () => {
    expect(clampSplitRatio(0)).toBe(0)
    expect(clampSplitRatio(100)).toBe(100)
    expect(clampSplitRatio(55.6)).toBe(56)
    expect(clampSplitRatio(-5)).toBe(0)
    expect(clampSplitRatio(120)).toBe(100)
  })

  it('falls back for non-finite input', () => {
    expect(clampSplitRatio(Number.NaN)).toBe(DEFAULT_SPLIT_RATIO)
    expect(clampSplitRatio(Number.POSITIVE_INFINITY)).toBe(DEFAULT_SPLIT_RATIO)
  })
})

describe('snapSplitRatio', () => {
  it('collapses a released divider onto the nearest hidden pane', () => {
    expect(snapSplitRatio(3)).toBe(0)
    expect(snapSplitRatio(96)).toBe(100)
  })

  it('keeps the middle range untouched', () => {
    expect(snapSplitRatio(20)).toBe(20)
    expect(snapSplitRatio(50)).toBe(50)
    expect(snapSplitRatio(85)).toBe(85)
  })
})

describe('ratioFromDrag', () => {
  it('converts a vertical drag into the editor share', () => {
    expect(ratioFromDrag(50, 100, 400)).toBe(75)
    expect(ratioFromDrag(50, -100, 400)).toBe(25)
  })

  it('clamps to both edges', () => {
    expect(ratioFromDrag(10, -500, 400)).toBe(0)
    expect(ratioFromDrag(90, 500, 400)).toBe(100)
  })

  it('keeps the start ratio when the container has no height', () => {
    expect(ratioFromDrag(42, 100, 0)).toBe(42)
  })
})
