import { describe, expect, it } from 'vitest'
import {
  DEFAULT_LAYOUT_PREFS,
  DEFAULT_SPLIT_RATIO,
  SPLIT_HANDLE_SIZE,
  clampSplitRatio,
  layoutModeOf,
  parseLayoutPrefs,
  ratioFromPointer,
  toggleSplitRatio,
  withLayoutMode,
} from './layout'

describe('parseLayoutPrefs', () => {
  it('falls back to defaults for missing or malformed values', () => {
    expect(parseLayoutPrefs(null)).toEqual(DEFAULT_LAYOUT_PREFS)
    expect(parseLayoutPrefs('')).toEqual(DEFAULT_LAYOUT_PREFS)
    expect(parseLayoutPrefs('not json')).toEqual(DEFAULT_LAYOUT_PREFS)
    expect(parseLayoutPrefs('{"ratio":"60"}')).toEqual(DEFAULT_LAYOUT_PREFS)
  })

  it('clamps persisted ratios into the supported range', () => {
    expect(parseLayoutPrefs('{"ratio":200}').ratio).toBe(90)
    expect(parseLayoutPrefs('{"ratio":5}').ratio).toBe(10)
    expect(parseLayoutPrefs('{"ratio":63.4}').ratio).toBe(63)
  })

  it('reads layout mode flags', () => {
    expect(
      parseLayoutPrefs('{"ratio":40,"previewOpen":true,"previewOnly":true}'),
    ).toEqual({ ratio: 40, previewOpen: true, previewOnly: true })
  })
})

describe('clampSplitRatio', () => {
  it('keeps values inside 10-90 and rounds', () => {
    expect(clampSplitRatio(10)).toBe(10)
    expect(clampSplitRatio(90)).toBe(90)
    expect(clampSplitRatio(55.6)).toBe(56)
    expect(clampSplitRatio(-5)).toBe(10)
    expect(clampSplitRatio(120)).toBe(90)
  })

  it('falls back for non-finite input', () => {
    expect(clampSplitRatio(Number.NaN)).toBe(DEFAULT_SPLIT_RATIO)
    expect(clampSplitRatio(Number.POSITIVE_INFINITY)).toBe(DEFAULT_SPLIT_RATIO)
  })
})

describe('layoutModeOf / withLayoutMode', () => {
  it('derives the visible mode', () => {
    expect(layoutModeOf({ ratio: 55, previewOpen: false, previewOnly: false })).toBe('closed')
    expect(layoutModeOf({ ratio: 55, previewOpen: true, previewOnly: false })).toBe('split')
    expect(layoutModeOf({ ratio: 55, previewOpen: true, previewOnly: true })).toBe('preview')
  })

  it('applies a mode while remembering the preferred preview mode', () => {
    expect(withLayoutMode(DEFAULT_LAYOUT_PREFS, 'split')).toEqual({
      ratio: 55,
      previewOpen: true,
      previewOnly: false,
    })
    expect(withLayoutMode(DEFAULT_LAYOUT_PREFS, 'preview')).toEqual({
      ratio: 55,
      previewOpen: true,
      previewOnly: true,
    })
    expect(
      withLayoutMode({ ratio: 70, previewOpen: true, previewOnly: true }, 'closed'),
    ).toEqual({ ratio: 70, previewOpen: false, previewOnly: true })
  })
})

describe('toggleSplitRatio', () => {
  it('flips the dominant pane', () => {
    expect(toggleSplitRatio(65)).toBe(35)
    expect(toggleSplitRatio(30)).toBe(70)
    expect(toggleSplitRatio(10)).toBe(90)
    expect(toggleSplitRatio(90)).toBe(10)
  })

  it('jumps to an editor-major split near 50/50', () => {
    expect(toggleSplitRatio(50)).toBe(70)
    expect(toggleSplitRatio(46)).toBe(70)
    expect(toggleSplitRatio(54)).toBe(70)
  })
})

describe('ratioFromPointer', () => {
  it('maps the divider position to the editor share', () => {
    const containerTop = 100
    const containerHeight = 600
    const usable = containerHeight - SPLIT_HANDLE_SIZE
    const pointerFor = (ratio: number) =>
      containerTop + (ratio / 100) * usable + SPLIT_HANDLE_SIZE / 2

    expect(ratioFromPointer(pointerFor(55), containerTop, containerHeight)).toBe(55)
    expect(ratioFromPointer(pointerFor(20), containerTop, containerHeight)).toBe(20)
  })

  it('clamps to the 10-90 range', () => {
    expect(ratioFromPointer(0, 100, 600)).toBe(10)
    expect(ratioFromPointer(2000, 100, 600)).toBe(90)
  })

  it('falls back when there is no usable height', () => {
    expect(ratioFromPointer(100, 0, SPLIT_HANDLE_SIZE)).toBe(DEFAULT_SPLIT_RATIO)
  })
})
