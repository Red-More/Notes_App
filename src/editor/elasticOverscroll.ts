/**
 * Rubber-band overscroll for the editor scroller.
 *
 * The fixed tail is already part of the document (scroller padding). When a
 * touch drag pushes past the real top / bottom edge, the content and gutters
 * shift a little further and spring back on release. Native scrolling is left
 * untouched everywhere else.
 */

import type { EditorView } from '@codemirror/view'

const MAX_PULL = 80
const RESISTANCE = 0.55
const ACTIVATE_DISTANCE = 6
const SETTLE_MS = 440

export function attachElasticOverscroll(view: EditorView): () => void {
  const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
  if (reduceMotion) return () => {}

  const scroller = view.scrollDOM
  let startY = 0
  let edgeY = 0
  let tracking = false
  let active = false
  let edge: 'top' | 'bottom' | null = null
  let settleTimer = 0

  const setOffset = (value: number) => {
    scroller.style.setProperty('--md-overscroll', `${value}px`)
  }

  const atTop = () => scroller.scrollTop <= 0
  const atBottom = () => scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 1

  const stopSettling = () => {
    if (settleTimer) {
      window.clearTimeout(settleTimer)
      settleTimer = 0
    }
    scroller.classList.remove('md-overscroll-settling')
  }

  const reset = (animate: boolean) => {
    active = false
    edge = null
    if (!animate) {
      stopSettling()
      scroller.classList.remove('md-overscroll')
      setOffset(0)
      return
    }
    scroller.classList.add('md-overscroll-settling')
    setOffset(0)
    window.clearTimeout(settleTimer)
    settleTimer = window.setTimeout(() => {
      settleTimer = 0
      scroller.classList.remove('md-overscroll-settling', 'md-overscroll')
      setOffset(0)
    }, SETTLE_MS)
  }

  const onTouchStart = (event: TouchEvent) => {
    if (event.touches.length !== 1) {
      tracking = false
      return
    }
    // A fresh gesture takes over from a settling spring immediately.
    if (scroller.classList.contains('md-overscroll')) reset(false)
    stopSettling()
    startY = event.touches[0].clientY
    edgeY = startY
    tracking = true
    active = false
    edge = null
  }

  const onTouchMove = (event: TouchEvent) => {
    if (!tracking) return
    if (event.touches.length !== 1) {
      tracking = false
      if (active) reset(true)
      return
    }
    const y = event.touches[0].clientY

    if (!active) {
      const travel = y - startY
      if (Math.abs(travel) < ACTIVATE_DISTANCE) return
      if (travel > 0 && atTop()) edge = 'top'
      else if (travel < 0 && atBottom()) edge = 'bottom'
      else return
      active = true
      edgeY = y
      scroller.classList.add('md-overscroll')
    }

    event.preventDefault()
    const distance = edge === 'top' ? y - edgeY : edgeY - y
    if (distance <= 0) {
      setOffset(0)
      return
    }
    const pull = Math.min(MAX_PULL, distance * RESISTANCE)
    setOffset(edge === 'top' ? pull : -pull)
  }

  const onTouchEnd = () => {
    if (!tracking) return
    tracking = false
    if (active) reset(true)
  }

  scroller.addEventListener('touchstart', onTouchStart, { passive: true })
  scroller.addEventListener('touchmove', onTouchMove, { passive: false })
  scroller.addEventListener('touchend', onTouchEnd, { passive: true })
  scroller.addEventListener('touchcancel', onTouchEnd, { passive: true })

  return () => {
    scroller.removeEventListener('touchstart', onTouchStart)
    scroller.removeEventListener('touchmove', onTouchMove)
    scroller.removeEventListener('touchend', onTouchEnd)
    scroller.removeEventListener('touchcancel', onTouchEnd)
    stopSettling()
    scroller.classList.remove('md-overscroll')
    scroller.style.removeProperty('--md-overscroll')
  }
}
