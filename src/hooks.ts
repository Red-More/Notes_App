import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { hapticTap } from './system/haptics'

/**
 * Debounced search state: returns the raw input value, its setter and a
 * debounced query that updates `delay` ms after the last change.
 */
export function useDebouncedSearch(
  initial = '',
  delay = 300,
): [string, (v: string) => void, string] {
  const [value, setValue] = useState(initial)
  const [query, setQuery] = useState(initial)
  useEffect(() => {
    const t = setTimeout(() => setQuery(value.trim()), delay)
    return () => clearTimeout(t)
  }, [value, delay])
  return [value, setValue, query]
}

/** Left-edge drag distance that counts as a back gesture, in CSS pixels. */
const EDGE_BACK_ZONE = 24
const EDGE_BACK_DISTANCE = 60

/**
 * Rightward swipe from the left screen edge pops one level (UX-09).
 *
 * Secondary pages mount this hook; the tab pager itself never pages from the
 * 24px edge zone, so the system back gesture keeps priority over horizontal
 * swipers. The Android hardware back key is bound separately and calls the
 * same handler.
 */
export function useEdgeBack(onBack: () => void, enabled = true): void {
  const handler = useRef(onBack)
  useEffect(() => {
    handler.current = onBack
  }, [onBack])

  useEffect(() => {
    if (!enabled) return
    let startX = 0
    let startY = 0
    let tracking = false

    const onStart = (event: TouchEvent) => {
      if (event.touches.length !== 1) {
        tracking = false
        return
      }
      const touch = event.touches[0]
      tracking = touch.clientX <= EDGE_BACK_ZONE
      startX = touch.clientX
      startY = touch.clientY
    }

    const onMove = (event: TouchEvent) => {
      if (!tracking) return
      const touch = event.touches[0]
      const dx = touch.clientX - startX
      const dy = touch.clientY - startY
      // A vertical gesture belongs to the page content, not to back.
      if (Math.abs(dy) > Math.abs(dx) * 1.15) {
        tracking = false
        return
      }
      if (dx > 0) event.preventDefault()
    }

    const onEnd = (event: TouchEvent) => {
      if (!tracking) return
      tracking = false
      const touch = event.changedTouches[0]
      if (!touch) return
      const dx = touch.clientX - startX
      const dy = touch.clientY - startY
      if (dx >= EDGE_BACK_DISTANCE && Math.abs(dy) <= Math.abs(dx)) handler.current()
    }

    const onCancel = () => {
      tracking = false
    }

    window.addEventListener('touchstart', onStart, { passive: true })
    window.addEventListener('touchmove', onMove, { passive: false })
    window.addEventListener('touchend', onEnd)
    window.addEventListener('touchcancel', onCancel)
    return () => {
      window.removeEventListener('touchstart', onStart)
      window.removeEventListener('touchmove', onMove)
      window.removeEventListener('touchend', onEnd)
      window.removeEventListener('touchcancel', onCancel)
    }
  }, [enabled])
}

/** Long-press detection via pointer events (works for touch and mouse).
 * `bind(payload)` returns spreadable props for one pressable element; the
 * payload is handed back to `callback` when the press completes, so a list can
 * tell which item was held. `didLongPress` suppresses the click that follows a
 * completed long-press.
 */
export function useLongPress<T = undefined>(
  callback: (payload: T) => void,
  ms = 500,
  options: { hapticOnPress?: boolean } = {},
) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const fired = useRef(false)
  const pos = useRef({ x: 0, y: 0 })
  /** Payload currently held down, used by callers to render the Pressed state. */
  const [pressing, setPressing] = useState<T | null>(null)

  const cancel = () => {
    if (timer.current) {
      clearTimeout(timer.current)
      timer.current = null
    }
  }

  const release = () => {
    cancel()
    setPressing(null)
  }

  const bind = (payload?: T) => ({
    onPointerDown: (e: React.PointerEvent) => {
      // Secondary mouse buttons open the context menu, never a selection.
      if (e.pointerType === 'mouse' && e.button !== 0) return
      fired.current = false
      pos.current = { x: e.clientX, y: e.clientY }
      cancel()
      setPressing(payload ?? null)
      if (options.hapticOnPress) hapticTap(8)
      timer.current = setTimeout(() => {
        timer.current = null
        fired.current = true
        // Commit leaves the Pressed state immediately; the item itself renders
        // the selected/commit style from here on.
        setPressing(null)
        callback(payload as T)
      }, ms)
    },
    onPointerUp: release,
    onPointerLeave: release,
    onPointerCancel: release,
    onPointerMove: (e: React.PointerEvent) => {
      // Cancel once the pointer drifts beyond a small slop radius.
      if (Math.abs(e.clientX - pos.current.x) > 10 || Math.abs(e.clientY - pos.current.y) > 10) {
        release()
      }
    },
    // Suppress the browser context menu triggered by long-press.
    onContextMenu: (e: React.MouseEvent) => e.preventDefault(),
  })

  return { bind, didLongPress: () => fired.current, pressing }
}

/**
 * Tracks a live scroll container through a callback ref. React re-invokes the
 * ref whenever the host subtree remounts (e.g. after the settings page closes),
 * so scroll behaviours always target the live element. The element itself is
 * exposed for behaviours that need the node.
 */
export function useScrollContainer() {
  const [scrollEl, setScrollEl] = useState<HTMLElement | null>(null)
  const scrollRef = useCallback((el: HTMLElement | null) => setScrollEl(el), [])
  return { scrollRef, scrollEl }
}

/**
 * Scroll-linked collapsing header: as the list scrolls past its top, the
 * large left-aligned title and then the search bar shrink in height and fade
 * out, and expand back in reverse when scrolling up.
 *
 * The centered title fades in as the large title collapses: it is hidden while
 * the large title is expanded and fully visible once the large title is gone, so
 * the two rows never compete for attention or show redundant text.
 *
 * The collapse targets are PageHeader's `.large-title-collapse` and
 * `.search-collapse` wrappers, which have no padding or border, so their height
 * can truly reach 0. The padded inner rows would stop shrinking at their own
 * padding (box-sizing: border-box), leaving an invisible strip behind.
 *
 * Shrinking the header also grows the list viewport by the same amount, so the
 * content would otherwise move at twice the finger speed and slide under the
 * header before it is fully hidden. The consumed scroll is therefore cancelled
 * 1:1 on the separate `.scroll-shift` wrapper: the list only follows the header
 * height change and starts scrolling once the header is collapsed.
 *
 * Returns refs for the two collapse wrappers (PageHeader's `largeTitleRef` /
 * `searchWrapRef`), a callback ref for the scroll container, a ref for the
 * `.scroll-shift` content wrapper (React re-invokes it with the live element
 * whenever the host subtree remounts, e.g. after the settings page closes), and
 * the scroll element itself for other scroll behaviours.
 */
export function useCollapsibleHeader() {
  const wrapRef = useRef<HTMLDivElement>(null)
  const largeRef = useRef<HTMLDivElement>(null)
  const shiftRef = useRef<HTMLDivElement>(null)
  // The scroll container the collapse listens to, kept in sync by the callback
  // ref. Callback-ref + state (instead of object ref + effect) stays
  // React-Compiler-friendly: no ref access during render, no deps-less effect.
  const { scrollRef, scrollEl } = useScrollContainer()

  // Layout effect: the collapsed geometry must be applied before the first
  // paint, otherwise a remount (e.g. returning from settings) flashes the
  // expanded header for one frame.
  useLayoutEffect(() => {
    const wrap = wrapRef.current
    const sc = scrollEl
    if (!wrap || !sc) return
    const header = wrap.parentElement
    const bar = wrap.firstElementChild as HTMLElement | null
    const largeWrap = largeRef.current
    const largeBar = largeWrap?.firstElementChild as HTMLElement | null
    // The inner rows keep their natural height while the wrappers are clipped,
    // so re-attaching (e.g. returning from settings) still yields full travel.
    const searchH = bar?.offsetHeight || wrap.scrollHeight || 46
    const largeH = largeWrap ? largeBar?.offsetHeight || largeWrap.scrollHeight || 0 : 0
    const totalH = largeH + searchH

    const update = () => {
      // Clamp: iOS rubber-band overscroll can report a negative scrollTop.
      const scrolled = Math.max(0, sc.scrollTop)
      // Stage 1: the large title collapses first while the centered title
      // crossfades in; the search bar stays fully expanded until it is gone.
      const lp = largeH > 0 ? Math.max(0, Math.min(1, scrolled / largeH)) : 1
      if (largeWrap) {
        largeWrap.style.height = `${largeH * (1 - lp)}px`
        // Fade out over the first three quarters of the collapse, so the row is
        // mostly transparent before the shrinking clip could cut the glyphs.
        largeWrap.style.opacity = String(Math.max(0, 1 - lp * (4 / 3)))
        largeWrap.style.visibility = lp >= 1 ? 'hidden' : ''
      }
      // The centered title fades in over the second half. The overlap is limited
      // to faint opacity, so the header never goes blank and the two rows never
      // read as competing titles. The var lives on .page-header so a remounted
      // title inherits the current mix immediately (see .page-title).
      const titleMix = largeH > 0 ? Math.max(0, Math.min(1, (lp - 0.5) * 2)) : 1
      header?.style.setProperty('--header-title-mix', String(titleMix))
      // Stage 2: the search bar collapses over the scroll range that follows.
      const sp = Math.max(0, Math.min(1, (scrolled - largeH) / searchH))
      wrap.style.height = `${searchH * (1 - sp)}px`
      wrap.style.opacity = String(1 - sp)
      // A fully collapsed bar must not stay focusable or intercept taps.
      wrap.style.visibility = sp >= 1 ? 'hidden' : ''
      // Cancel the scroll consumed by both collapse stages on the content, so
      // the list moves only with the header and never at double speed. Once
      // the header is hidden the offset stays pinned, which keeps the content
      // position continuous for the rest of the scroll range.
      const shift = Math.min(scrolled, totalH)
      if (shiftRef.current) {
        shiftRef.current.style.transform = `translate3d(0, ${shift}px, 0)`
      }
      // Dismiss the soft keyboard once the search bar is fully hidden.
      if (sp >= 1 && wrap.contains(document.activeElement)) {
        ;(document.activeElement as HTMLElement).blur?.()
      }
    }
    // Update synchronously: scroll events fire before paint, so the header
    // keeps exact pace with the list. Deferring to rAF adds a one-frame lag.
    const onScroll = () => update()
    sc.addEventListener('scroll', onScroll, { passive: true })
    // Sync immediately: the container can already be scrolled on re-attach.
    update()
    return () => {
      sc.removeEventListener('scroll', onScroll)
    }
  }, [scrollEl])

  return {
    largeTitleRef: largeRef,
    searchWrapRef: wrapRef,
    scrollRef,
    contentShiftRef: shiftRef,
    scrollEl,
  }
}

export interface ElasticOverscrollOptions {
  /** Pull-down at the top edge past the threshold triggers this (enables refresh). */
  onRefresh?: () => Promise<unknown> | void
  /** Pull distance (px) that arms `onRefresh`. */
  refreshThreshold?: number
}

export interface ElasticOverscrollState {
  /** Pull offset in px: positive at the top edge, negative at the bottom edge. */
  pullDist: number
  /** True while the release spring-back animation runs. */
  springing: boolean
  /** True while a pull-triggered refresh is in flight. */
  refreshing: boolean
}

/** Drag resistance and maximum travel of the elastic overscroll. */
const PULL_RESISTANCE = 0.45
const PULL_LIMIT = 90

/**
 * Elastic overscroll shared by every list: dragging past the top or the bottom
 * edge moves the content a damped distance and releasing springs it back with
 * the same transition everywhere. A pull-down at the top past the threshold can
 * additionally trigger `onRefresh` (only pages that pass it show the hint).
 *
 * The offset is exposed as state; consumers apply it to `.scroll-content` so
 * the transform lives on one wrapper and composes with the search collapse
 * shift applied separately to `.scroll-shift`.
 */
export function useElasticOverscroll(
  scrollEl: HTMLElement | null,
  { onRefresh, refreshThreshold = 45 }: ElasticOverscrollOptions = {},
): ElasticOverscrollState {
  const [pullDist, setPullDist] = useState(0)
  const [springing, setSpringing] = useState(false)
  const [refreshing, setRefreshing] = useState(false)

  useEffect(() => {
    const el = scrollEl
    if (!el) return
    let startX = 0
    let startY = 0
    // A single-finger vertical gesture is tracked / dragging past an edge.
    let tracking = false
    let pulling = false
    // 1: top edge (content follows the finger down), -1: bottom edge (up).
    let dir: 1 | -1 = 1
    let dist = 0
    let springTimer: ReturnType<typeof setTimeout> | undefined
    // Suppresses the click synthesized after a pull so it cannot open an item.
    let clickGuardUntil = 0

    const atBottom = () => el.scrollTop + el.clientHeight >= el.scrollHeight - 1

    const springBack = () => {
      setSpringing(true)
      // Two frames later the transition class is committed; only then drop the offset.
      requestAnimationFrame(() => {
        requestAnimationFrame(() => setPullDist(0))
      })
      clearTimeout(springTimer)
      springTimer = setTimeout(() => setSpringing(false), 450)
    }

    const releasePull = () => {
      pulling = false
      dist = 0
      springBack()
    }

    const onTouchStart = (e: TouchEvent) => {
      // A second finger (e.g. a pinch) cancels an in-flight pull cleanly.
      if (e.touches.length !== 1) {
        tracking = false
        if (pulling) releasePull()
        return
      }
      startX = e.touches[0].clientX
      startY = e.touches[0].clientY
      tracking = true
      pulling = false
      dist = 0
      // A new pull must not inherit the spring transition of a previous one.
      setSpringing(false)
    }

    const onTouchMove = (e: TouchEvent) => {
      if (!tracking) return
      const touch = e.touches[0]
      const dx = touch.clientX - startX
      const dy = touch.clientY - startY
      // A horizontal-dominant gesture belongs to the page pager; back off so
      // the elastic overscroll never fights a horizontal page swipe.
      if (Math.abs(dx) > Math.abs(dy) * 1.15) {
        tracking = false
        if (pulling) releasePull()
        return
      }
      if (!pulling) {
        // Only start pulling when the list is pinned at an edge in the drag
        // direction; otherwise the browser keeps scrolling natively.
        if (dy > 0 && el.scrollTop <= 0) {
          dir = 1
        } else if (dy < 0 && atBottom()) {
          dir = -1
        } else {
          return
        }
        pulling = true
        // Re-base at the edge so the offset starts at 0 instead of jumping by
        // the distance consumed while the list was still scrolling.
        startX = touch.clientX
        startY = touch.clientY
      }
      const raw = (touch.clientY - startY) * PULL_RESISTANCE
      const next =
        dir === 1 ? Math.max(0, Math.min(raw, PULL_LIMIT)) : Math.min(0, Math.max(raw, -PULL_LIMIT))
      // Suppress native scrolling while the content is dragged past the edge.
      e.preventDefault()
      if (next !== dist) {
        dist = next
        setPullDist(next)
      }
    }

    const finish = (allowRefresh: boolean) => {
      if (!tracking) return
      const hadPull = dist !== 0
      const shouldRefresh =
        allowRefresh && dir === 1 && dist > refreshThreshold && onRefresh != null
      tracking = false
      pulling = false
      dist = 0
      if (hadPull) {
        // A drag that released over an item is not a tap: block the click that
        // the browser emits after touchend.
        clickGuardUntil = performance.now() + 300
        springBack()
      }
      if (shouldRefresh) {
        setRefreshing(true)
        void Promise.resolve(onRefresh?.()).finally(() => setRefreshing(false))
      }
    }

    const onTouchEnd = () => finish(true)
    // A cancelled gesture (e.g. the OS took over) must not trigger a refresh.
    const onTouchCancel = () => finish(false)
    const onClickCapture = (e: MouseEvent) => {
      if (performance.now() < clickGuardUntil) {
        e.preventDefault()
        e.stopPropagation()
      }
    }

    el.addEventListener('touchstart', onTouchStart, { passive: true })
    el.addEventListener('touchmove', onTouchMove, { passive: false })
    el.addEventListener('touchend', onTouchEnd)
    el.addEventListener('touchcancel', onTouchCancel)
    el.addEventListener('click', onClickCapture, true)
    return () => {
      clearTimeout(springTimer)
      el.removeEventListener('touchstart', onTouchStart)
      el.removeEventListener('touchmove', onTouchMove)
      el.removeEventListener('touchend', onTouchEnd)
      el.removeEventListener('touchcancel', onTouchCancel)
      el.removeEventListener('click', onClickCapture, true)
    }
  }, [scrollEl, onRefresh, refreshThreshold])

  return { pullDist, springing, refreshing }
}
