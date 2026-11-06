import { useCallback, useEffect, useRef, useState } from 'react'
import { friendlyError } from '../../utils'

export type SaveState = 'idle' | 'saving' | 'saved' | 'error'

/**
 * Tracks a single row's persist lifecycle: saving -> saved (auto-clears) or
 * error with a retry action. The action is replayed verbatim on retry.
 */
export function useSettingSave(holdMs = 1800) {
  const [state, setState] = useState<SaveState>('idle')
  const [error, setError] = useState<string | null>(null)
  const lastAction = useRef<(() => void | Promise<void>) | null>(null)
  const timer = useRef<number | undefined>(undefined)

  const run = useCallback(
    async (action: () => void | Promise<void>) => {
      lastAction.current = action
      window.clearTimeout(timer.current)
      setState('saving')
      setError(null)
      try {
        await action()
        setState('saved')
        timer.current = window.setTimeout(() => setState('idle'), holdMs)
      } catch (e) {
        setState('error')
        setError(friendlyError(e))
      }
    },
    [holdMs],
  )

  const retry = useCallback(() => {
    if (lastAction.current) void run(lastAction.current)
  }, [run])

  useEffect(() => () => window.clearTimeout(timer.current), [])

  return { state, error, run, retry }
}
