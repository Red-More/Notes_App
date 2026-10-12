import { useEffect, useRef, useState } from 'react'

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
 * Returns spreadable props and a guard to suppress the click that
 * follows a completed long-press.
 */
export function useLongPress(callback: () => void, ms = 500) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const fired = useRef(false)
  const pos = useRef({ x: 0, y: 0 })

  const cancel = () => {
    if (timer.current) {
      clearTimeout(timer.current)
      timer.current = null
    }
  }

  const longPressProps = {
    onPointerDown: (e: React.PointerEvent) => {
      fired.current = false
      pos.current = { x: e.clientX, y: e.clientY }
      cancel()
      timer.current = setTimeout(() => {
        timer.current = null
        fired.current = true
        callback()
      }, ms)
    },
    onPointerUp: cancel,
    onPointerLeave: cancel,
    onPointerCancel: cancel,
    onPointerMove: (e: React.PointerEvent) => {
      // Cancel once the pointer drifts beyond a small slop radius.
      if (
        Math.abs(e.clientX - pos.current.x) > 10 ||
        Math.abs(e.clientY - pos.current.y) > 10
      ) {
        cancel()
      }
    },
    // Suppress the browser context menu triggered by long-press.
    onContextMenu: (e: React.MouseEvent) => e.preventDefault(),
  }

  return { longPressProps, didLongPress: () => fired.current }
}
