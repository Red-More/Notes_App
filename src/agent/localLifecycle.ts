import { useEffect } from 'react'
import { localApi } from '../api'

/**
 * Local model lifecycle (phase B): foreground resumes enabled models,
 * background releases memory unless the user opted into residency.
 * WS visibility changes are the only reliable signal across desktop and Android
 * WebView; the Rust side re-checks thermal/battery before any decode.
 */
export function useLocalModelLifecycle() {
  useEffect(() => {
    const sync = () => {
      const call =
        document.visibilityState === 'hidden' ? localApi.pause() : localApi.resume()
      void call.catch(() => {
        // The runtime reports `unsupported` on builds without the engine.
      })
    }
    sync()
    document.addEventListener('visibilitychange', sync)
    return () => document.removeEventListener('visibilitychange', sync)
  }, [])
}
