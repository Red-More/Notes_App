import { createContext, useContext, useEffect } from 'react'

/**
 * Lets a settings popover register its close handler with the page, so the
 * hardware back key and edge-swipe dismiss the popover before leaving settings.
 */
export type OverlayRegistrar = (close: () => void) => () => void

export const SettingsOverlayContext = createContext<OverlayRegistrar | null>(null)

export function useSettingsOverlay(close: () => void): void {
  const register = useContext(SettingsOverlayContext)
  useEffect(() => {
    if (!register) return
    return register(close)
  }, [register, close])
}
