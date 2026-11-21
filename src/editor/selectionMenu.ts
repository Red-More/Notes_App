/**
 * Placement of the selection-anchored text menu.
 *
 * The long-press / right-click menu floats next to the text it acts on, so its
 * position is derived from the selection's client rect: centered under the
 * selection when there is room, flipped above it near the bottom edge, and
 * clamped so the bubble never leaves the viewport.
 */

/** Client-space rectangle of the anchor: a selection box or a bare press point. */
export interface MenuAnchor {
  left: number
  top: number
  right: number
  bottom: number
}

/** The part of CodeMirror's `coordsAtPos` result the anchor needs. */
export interface CoordsRect {
  left: number
  top: number
  right: number
  bottom: number
}

export interface Point {
  x: number
  y: number
}

export interface MenuSize {
  width: number
  height: number
}

export interface ViewportSize {
  width: number
  height: number
}

export interface MenuPlacement {
  /** Fixed-position offsets for the bubble, in client px. */
  left: number
  top: number
  /** True when the bubble sits above the anchor (drives the entry animation). */
  above: boolean
}

/** Distance kept between the selection and the bubble. */
export const MENU_GAP = 8

/** Smallest distance kept between the bubble and the viewport edges. */
export const MENU_MARGIN = 8

const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), max)

/**
 * Build the anchor for the menu.
 *
 * A selection is anchored on the union of its first and last character rects,
 * which keeps the bubble over the whole selected range even when it wraps. A
 * collapsed selection (caret only) yields the same rect twice, so the union
 * degenerates to the caret box. `coordsAtPos` returns null for text scrolled
 * out of view, in which case the one measurable end is used on its own; the
 * press point is only a last resort, because it can be far from the caret
 * after a programmatic edit.
 */
export function anchorFromCoords(
  from: CoordsRect | null,
  to: CoordsRect | null,
  press: Point | null,
): MenuAnchor {
  if (from && to) {
    return {
      left: Math.min(from.left, to.left),
      top: Math.min(from.top, to.top),
      right: Math.max(from.right, to.right),
      bottom: Math.max(from.bottom, to.bottom),
    }
  }
  const rect = from ?? to
  if (rect) {
    return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }
  }
  if (press) {
    return { left: press.x, top: press.y, right: press.x, bottom: press.y }
  }
  // Nothing measurable (the press landed outside the rendered text): fall back
  // to the origin, which the placement clamp turns into the top-left margin so
  // the menu is still reachable.
  return { left: 0, top: 0, right: 0, bottom: 0 }
}

/**
 * Compute the bubble offsets for `anchor`. The menu prefers the space above the
 * selection (the usual text-menu placement, where it never covers what was
 * selected); it flips below when the top edge is too tight, and only clamps
 * into the viewport when neither side fits.
 */
export function placeSelectionMenu(
  anchor: MenuAnchor,
  size: MenuSize,
  viewport: ViewportSize,
  gap: number = MENU_GAP,
  margin: number = MENU_MARGIN,
): MenuPlacement {
  // A viewport narrower than the bubble collapses the range; keeping max >= min
  // makes the clamp land on the left margin instead of returning NaN.
  const maxLeft = Math.max(margin, viewport.width - size.width - margin)
  const centered = (anchor.left + anchor.right) / 2 - size.width / 2
  const left = clamp(centered, margin, maxLeft)

  const aboveTop = anchor.top - gap - size.height
  const belowTop = anchor.bottom + gap
  const maxTop = Math.max(margin, viewport.height - size.height - margin)
  const above = aboveTop >= margin || belowTop > maxTop
  const top = clamp(above ? aboveTop : belowTop, margin, maxTop)

  return { left, top, above }
}
