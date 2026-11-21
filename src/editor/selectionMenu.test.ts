import { describe, expect, it } from 'vitest'
import { MENU_GAP, MENU_MARGIN, anchorFromCoords, placeSelectionMenu } from './selectionMenu'

const viewport = { width: 400, height: 800 }
const menu = { width: 160, height: 48 }

/** A selection sitting mid-screen, wide enough to center the bubble on. */
const middleAnchor = { left: 100, top: 300, right: 300, bottom: 320 }

describe('placeSelectionMenu', () => {
  it('sits above the selection, centered on it', () => {
    const placement = placeSelectionMenu(middleAnchor, menu, viewport)
    expect(placement.above).toBe(true)
    expect(placement.top).toBe(300 - MENU_GAP - menu.height)
    expect(placement.left).toBe((100 + 300) / 2 - menu.width / 2)
  })

  it('flips below when the selection is near the top edge', () => {
    const placement = placeSelectionMenu({ left: 100, top: 4, right: 300, bottom: 20 }, menu, viewport)
    expect(placement.above).toBe(false)
    expect(placement.top).toBe(20 + MENU_GAP)
  })

  it('keeps the bubble above when the bottom edge has no room either', () => {
    // The selection fills the viewport: below would overflow, so it stays above
    // and clamps against the top margin.
    const placement = placeSelectionMenu({ left: 0, top: 0, right: 400, bottom: 800 }, menu, viewport)
    expect(placement.above).toBe(true)
    expect(placement.top).toBe(MENU_MARGIN)
  })

  it('clamps horizontally against both edges', () => {
    expect(placeSelectionMenu({ left: 0, top: 300, right: 10, bottom: 320 }, menu, viewport).left).toBe(
      MENU_MARGIN,
    )
    expect(
      placeSelectionMenu({ left: 390, top: 300, right: 400, bottom: 320 }, menu, viewport).left,
    ).toBe(viewport.width - menu.width - MENU_MARGIN)
  })

  it('anchors a bare press point (zero-size rect) on its center', () => {
    const placement = placeSelectionMenu({ left: 200, top: 400, right: 200, bottom: 400 }, menu, viewport)
    expect(placement.left).toBe(200 - menu.width / 2)
    expect(placement.above).toBe(true)
    expect(placement.top).toBe(400 - MENU_GAP - menu.height)
  })

  it('never returns offsets outside the viewport', () => {
    const tiny = { width: 80, height: 40 }
    const placement = placeSelectionMenu(middleAnchor, menu, tiny)
    expect(placement.left).toBeGreaterThanOrEqual(0)
    expect(placement.top).toBeGreaterThanOrEqual(0)
  })

  it('honours custom gap and margin', () => {
    const placement = placeSelectionMenu(middleAnchor, menu, viewport, 20, 4)
    expect(placement.top).toBe(300 - 20 - menu.height)
    expect(placeSelectionMenu({ left: 0, top: 300, right: 0, bottom: 300 }, menu, viewport, 20, 4).left).toBe(4)
  })
})

describe('anchorFromCoords', () => {
  const first = { left: 100, top: 300, right: 108, bottom: 320 }
  const last = { left: 60, top: 340, right: 90, bottom: 360 }

  it('unions the first and last character rects', () => {
    expect(anchorFromCoords(first, last, null)).toEqual({
      left: 60,
      top: 300,
      right: 108,
      bottom: 360,
    })
  })

  it('uses the press point when nothing is measurable', () => {
    expect(anchorFromCoords(null, null, { x: 120, y: 400 })).toEqual({
      left: 120,
      top: 400,
      right: 120,
      bottom: 400,
    })
  })

  it('prefers the one measurable rect over the press point', () => {
    // `coordsAtPos` returns null for positions scrolled out of the viewport;
    // the visible end still describes where the text is, the press point does
    // not, so the rect wins.
    expect(anchorFromCoords(first, null, { x: 5, y: 6 })).toEqual({
      left: 100,
      top: 300,
      right: 108,
      bottom: 320,
    })
    expect(anchorFromCoords(null, first, { x: 5, y: 6 })).toEqual({
      left: 100,
      top: 300,
      right: 108,
      bottom: 320,
    })
  })

  it('returns the origin when nothing resolved at all', () => {
    expect(anchorFromCoords(null, null, null)).toEqual({ left: 0, top: 0, right: 0, bottom: 0 })
  })
})
