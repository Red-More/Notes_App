/**
 * Soft-keyboard viewport tracking.
 *
 * `#root` always follows the layout viewport (`window.innerHeight`) so a native
 * adjustResize keyboard shrinks the app exactly once. The remaining overlay
 * keyboard inset is exposed as `--kb-inset` for the chat composer only: the
 * tabbar is deliberately NOT lifted (it is covered by the keyboard and hidden
 * via `body.kb-open`), while the input area keeps its clearance.
 */

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
    // Overlay model: the layout viewport stays put while the visual viewport
    // shrinks; only this part needs explicit padding.
    const overlay = Math.max(0, Math.round(window.innerHeight - (vvHeight + vvOffsetTop)))
    // adjustResize model: the layout viewport itself shrinks. The root height
    // already follows innerHeight, so no extra padding is applied.
    const layoutShrink = Math.max(0, Math.round(tallInnerHeight - window.innerHeight))

    let inset = 0
    if (overlay > 0 && (overlay >= 150 || canHaveSoftKeyboard || nativeInset > 0)) {
      inset = overlay
    }
    inset = Math.max(inset, Math.round(nativeInset))
    // adjustResize already moved the layout viewport: adding the same inset
    // again would lift the composer twice.
    if (canHaveSoftKeyboard && layoutShrink > 100) inset = 0
    const keyboardOpen =
      inset > 0 || (canHaveSoftKeyboard && layoutShrink > 100)

    root.style.setProperty(APP_HEIGHT, `${Math.max(0, Math.round(window.innerHeight))}px`)
    root.style.setProperty(KB_INSET, `${inset}px`)
    document.body.classList.toggle('kb-open', keyboardOpen)
    // Re-baseline only once the keyboard is fully closed again.
    if (!keyboardOpen) tallInnerHeight = window.innerHeight
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
  if (typeof pending === 'number') {
    nativeInset = Math.max(0, pending / (window.devicePixelRatio || 1))
  }
  apply()

  return () => {
    vv?.removeEventListener('resize', apply)
    vv?.removeEventListener('scroll', apply)
    window.removeEventListener('resize', apply)
    window.removeEventListener('orientationchange', onOrientationChange)
    window.removeEventListener('notes-keyboard-inset', onNativeInset)
    root.style.removeProperty(APP_HEIGHT)
    root.style.removeProperty(KB_INSET)
    document.body.classList.remove('kb-open')
  }
}
