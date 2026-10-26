import { useCallback, useEffect, useRef, useState } from 'react'

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

/**
 * Long-press detection via pointer events (works for touch and mouse).
 * `bind(payload)` returns spreadable props for one pressable element; the
 * payload is handed back to `callback` when the press completes, so a list can
 * tell which item was held. `didLongPress` suppresses the click that follows a
 * completed long-press.
 */
export function useLongPress<T = undefined>(callback: (payload: T) => void, ms = 500) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const fired = useRef(false)
  const pos = useRef({ x: 0, y: 0 })

  const cancel = () => {
    if (timer.current) {
      clearTimeout(timer.current)
      timer.current = null
    }
  }

  const bind = (payload?: T) => ({
    onPointerDown: (e: React.PointerEvent) => {
      // Secondary mouse buttons open the context menu, never a selection.
      if (e.pointerType === 'mouse' && e.button !== 0) return
      fired.current = false
      pos.current = { x: e.clientX, y: e.clientY }
      cancel()
      timer.current = setTimeout(() => {
        timer.current = null
        fired.current = true
        callback(payload as T)
      }, ms)
    },
    onPointerUp: cancel,
    onPointerLeave: cancel,
    onPointerCancel: cancel,
    onPointerMove: (e: React.PointerEvent) => {
      // Cancel once the pointer drifts beyond a small slop radius.
      if (Math.abs(e.clientX - pos.current.x) > 10 || Math.abs(e.clientY - pos.current.y) > 10) {
        cancel()
      }
    },
    // Suppress the browser context menu triggered by long-press.
    onContextMenu: (e: React.MouseEvent) => e.preventDefault(),
  })

  return { bind, didLongPress: () => fired.current }
}

/**
 * Scroll-linked collapsing search bar: once the list scrolls past its top,
 * the search area progressively shrinks in height and fades out until fully
 * hidden; scrolling back up expands it in reverse.
 *
 * The collapse target is PageHeader's `.search-collapse` wrapper, which has no
 * padding or border, so its height can truly reach 0. The padded `.search-bar`
 * itself would stop shrinking at ~20px (box-sizing: border-box), leaving an
 * invisible strip behind.
 *
 * Returns a callback ref for the scroll container (React re-invokes it with
 * the new element whenever the host subtree remounts, e.g. after the settings
 * page closes, so the listener always targets the live element) and a ref for
 * the collapse wrapper to pass to PageHeader's `searchWrapRef`.
 */
export function useCollapsibleSearch() {
  const wrapRef = useRef<HTMLDivElement>(null)
  // The scroll container the collapse listens to, kept in sync by the callback
  // ref below. Callback-ref + state (instead of object ref + effect) stays
  // React-Compiler-friendly: no ref access during render, no deps-less effect.
  const [sc, setSc] = useState<HTMLElement | null>(null)
  const scrollRef = useCallback((el: HTMLElement | null) => setSc(el), [])

  useEffect(() => {
    const wrap = wrapRef.current
    if (!wrap || !sc) return
    const bar = wrap.firstElementChild as HTMLElement | null
    // The inner bar keeps its natural height while the wrapper is clipped, so
    // re-attaching (e.g. returning from settings) still yields the full travel.
    const full = bar?.offsetHeight || wrap.scrollHeight || 46
    const update = () => {
      // Clamp: iOS rubber-band overscroll can report a negative scrollTop.
      const p = Math.max(0, Math.min(1, sc.scrollTop / full))
      wrap.style.height = `${full * (1 - p)}px`
      wrap.style.opacity = String(1 - p)
      // A fully collapsed bar must not stay focusable or intercept taps.
      wrap.style.visibility = p >= 1 ? 'hidden' : ''
      // Dismiss the soft keyboard once the search bar is fully hidden.
      if (p >= 1 && wrap.contains(document.activeElement)) {
        ;(document.activeElement as HTMLElement).blur?.()
      }
    }
    // Update synchronously: scroll events fire before paint, so the bar keeps
    // exact pace with the list. Deferring to rAF adds a visible one-frame lag.
    const onScroll = () => update()
    sc.addEventListener('scroll', onScroll, { passive: true })
    // Sync immediately: the container can already be scrolled on re-attach.
    update()
    return () => {
      sc.removeEventListener('scroll', onScroll)
    }
  }, [sc])

  return { searchWrapRef: wrapRef, scrollRef }
}
