/** Persisted switch for the enhanced Mermaid rendering preset. */
export const MERMAID_ENHANCE_KEY = 'notes:mermaid-enhance'

export const DEFAULT_MERMAID_ENHANCE = true

let cached: boolean | null = null
const listeners = new Set<() => void>()

/**
 * Only an explicit "0" disables the enhancement. Missing, malformed or tampered
 * values fall back to the default so storage can never inject markup.
 */
export function parseMermaidEnhance(raw: string | null): boolean {
  return raw !== '0'
}

/** Read once per session; localStorage access is lazy for test environments. */
export function getMermaidEnhance(): boolean {
  if (cached === null) {
    try {
      cached = parseMermaidEnhance(localStorage.getItem(MERMAID_ENHANCE_KEY))
    } catch {
      cached = DEFAULT_MERMAID_ENHANCE
    }
  }
  return cached
}

/** Persist and notify subscribers; no-op when the value is unchanged. */
export function setMermaidEnhance(value: boolean): void {
  const next = value === true
  if (getMermaidEnhance() === next) return
  cached = next
  try {
    localStorage.setItem(MERMAID_ENHANCE_KEY, next ? '1' : '0')
  } catch {
    // Storage can be unavailable (private mode / quota); keep the in-memory value.
  }
  for (const listener of listeners) listener()
}

export function subscribeMermaidEnhance(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
