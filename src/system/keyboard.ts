/**
 * Soft-keyboard viewport tracking.
 *
 * `#root` sizes itself from `--app-height`, which follows the visual viewport
 * minus any keyboard inset. Two measurements are combined because Android
 * WebViews differ:
 * - overlay model: the layout viewport stays put while `visualViewport` shrinks;
 * - adjustResize model: `innerHeight` itself shrinks;
 * - edge-to-edge shells: a native `notes-keyboard-inset` event reports the IME
 *   height even when neither viewport changes.
 */

import { useEffect, useState } from 'react'

const APP_HEIGHT = '--app-height'
const KB_INSET = '--kb-inset'

type NativeInsetWindow = Window & { __notesKbInsetPx?: number }

export function installKeyboardViewport(): () => void {
  const root = document.documentElement
  let tallInnerHeight = window.innerHeight
  let nativeInset = 0
  const canHaveSoftKeyboard =
    window.matchMedia?.('(pointer: coarse)').matches || navigator.maxTouchPoints > 0

  const apply = () => {
    const vv = window.visualViewport
    const vvHeight = vv?.height ?? window.innerHeight
    const vvOffsetTop = vv?.offsetTop ?? 0
    const overlay = Math.max(0, Math.round(window.innerHeight - (vvHeight + vvOffsetTop)))
    let visualInset = 0
    if (overlay > 0) {
      // Small shinks outside touch environments are window resizes, not IMEs.
      if (overlay >= 150 || canHaveSoftKeyboard) visualInset = overlay
    } else if (canHaveSoftKeyboard) {
      visualInset = Math.max(0, Math.round(tallInnerHeight - window.innerHeight))
    }
    if (visualInset === 0) tallInnerHeight = window.innerHeight
    const inset = Math.max(visualInset, Math.round(nativeInset))
    const height = Math.max(0, Math.round(window.innerHeight - inset))
    root.style.setProperty(APP_HEIGHT, `${height}px`)
    root.style.setProperty(KB_INSET, `${inset}px`)
  }

  const onNativeInset = (event: Event) => {
    const px = (event as CustomEvent<unknown>).detail
    const value = typeof px === 'number' && Number.isFinite(px) ? px : 0
    nativeInset = Math.max(0, value / (window.devicePixelRatio || 1))
    apply()
  }

  const onOrientationChange = () => {
    tallInnerHeight = window.innerHeight
    apply()
  }

  const vv = window.visualViewport
  vv?.addEventListener('resize', apply)
  vv?.addEventListener('scroll', apply)
  window.addEventListener('resize', apply)
  window.addEventListener('orientationchange', onOrientationChange)
  window.addEventListener('notes-keyboard-inset', onNativeInset)
  // Consume a value emitted before this module mounted.
  const pending = (window as NativeInsetWindow).__notesKbInsetPx
  if (typeof pending === 'number') nativeInset = Math.max(0, pending / (window.devicePixelRatio || 1))
  apply()

  return () => {
    vv?.removeEventListener('resize', apply)
    vv?.removeEventListener('scroll', apply)
    window.removeEventListener('resize', apply)
    window.removeEventListener('orientationchange', onOrientationChange)
    window.removeEventListener('notes-keyboard-inset', onNativeInset)
    root.style.removeProperty(APP_HEIGHT)
    root.style.removeProperty(KB_INSET)
  }
}

/** Current keyboard inset in CSS pixels; 0 while the keyboard is closed. */
export function useKeyboardInset(): number {
  const [inset, setInset] = useState(0)
  useEffect(() => {
    const read = () => {
      const raw = getComputedStyle(document.documentElement).getPropertyValue(KB_INSET)
      const value = Number.parseFloat(raw)
      setInset(Number.isFinite(value) ? value : 0)
    }
    const vv = window.visualViewport
    read()
    vv?.addEventListener('resize', read)
    vv?.addEventListener('scroll', read)
    window.addEventListener('resize', read)
    window.addEventListener('notes-keyboard-inset', read)
    return () => {
      vv?.removeEventListener('resize', read)
      vv?.removeEventListener('scroll', read)
      window.removeEventListener('resize', read)
      window.removeEventListener('notes-keyboard-inset', read)
    }
  }, [])
  return inset
}
