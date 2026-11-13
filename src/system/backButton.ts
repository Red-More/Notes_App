/**
 * Android hardware back button binding.
 *
 * Pages call this with the same handler used by their on-screen back button and
 * edge-swipe gesture, so every entry point pops exactly one level. Outside
 * Tauri (browser preview) the import or listener fails silently and the system
 * keeps its default behaviour.
 */

import { useEffect, useRef } from 'react'

export function usePhysicalBack(handler: () => void): void {
  const latest = useRef(handler)
  useEffect(() => {
    latest.current = handler
  }, [handler])

  useEffect(() => {
    let unlisten: (() => void) | undefined
    let disposed = false
    void (async () => {
      try {
        const { onBackButtonPress } = await import('@tauri-apps/api/app')
        const listener = await onBackButtonPress(() => latest.current())
        if (disposed) void listener.unregister()
        else unlisten = () => void listener.unregister()
      } catch {
        // Browser preview or unsupported platform.
      }
    })()
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [])
}
