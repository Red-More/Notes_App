//! Display preferences for the shared Markdown renderer.
//!
//! One store backs the note preview and the agent bubbles: `html` enables raw
//! HTML (always allowlist-sanitized) and `breaks` turns single newlines into
//! line breaks. `useSyncExternalStore` keeps every mounted surface in sync.

import { useSyncExternalStore } from 'react'

export interface MarkdownDisplayPrefs {
  /** Render raw HTML embedded in Markdown (through the sanitizer). */
  html: boolean
  /** Convert single newlines into line breaks. */
  breaks: boolean
}

export const MARKDOWN_DISPLAY_KEY = 'notes:markdown-display'

/** Requested defaults: line breaks on, HTML on (sanitized on every render). */
export const DEFAULT_MARKDOWN_DISPLAY: MarkdownDisplayPrefs = { html: true, breaks: true }

let cached: MarkdownDisplayPrefs | null = null
const listeners = new Set<() => void>()

/** Missing or malformed fields fall back to their own default. */
export function parseMarkdownDisplay(raw: string | null): MarkdownDisplayPrefs {
  let data: unknown = null
  try {
    data = raw ? JSON.parse(raw) : null
  } catch {
    data = null
  }
  const record = (data && typeof data === 'object' ? data : {}) as Partial<MarkdownDisplayPrefs>
  return {
    html: typeof record.html === 'boolean' ? record.html : DEFAULT_MARKDOWN_DISPLAY.html,
    breaks: typeof record.breaks === 'boolean' ? record.breaks : DEFAULT_MARKDOWN_DISPLAY.breaks,
  }
}

/** Read once per session; storage access stays lazy for test environments. */
export function getMarkdownDisplay(): MarkdownDisplayPrefs {
  if (cached === null) {
    try {
      cached = parseMarkdownDisplay(localStorage.getItem(MARKDOWN_DISPLAY_KEY))
    } catch {
      cached = { ...DEFAULT_MARKDOWN_DISPLAY }
    }
  }
  return cached
}

/** Persist a partial change and notify every mounted surface. */
export function setMarkdownDisplay(patch: Partial<MarkdownDisplayPrefs>): void {
  const current = getMarkdownDisplay()
  const next = { ...current, ...patch }
  if (next.html === current.html && next.breaks === current.breaks) return
  cached = next
  try {
    localStorage.setItem(MARKDOWN_DISPLAY_KEY, JSON.stringify(next))
  } catch {
    // Storage can be unavailable (private mode / quota); keep the memory value.
  }
  for (const listener of listeners) listener()
}

export function subscribeMarkdownDisplay(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** React binding shared by the note preview and the chat bubbles. */
export function useMarkdownDisplay(): MarkdownDisplayPrefs {
  return useSyncExternalStore(subscribeMarkdownDisplay, getMarkdownDisplay, getMarkdownDisplay)
}
