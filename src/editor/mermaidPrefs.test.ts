import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_MERMAID_ENHANCE,
  MERMAID_ENHANCE_KEY,
  parseMermaidEnhance,
} from './mermaidPrefs'

function fakeStorage(initial?: Record<string, string>): Storage {
  const data = new Map(Object.entries(initial ?? {}))
  return {
    get length() {
      return data.size
    },
    clear: () => data.clear(),
    getItem: (key: string) => data.get(key) ?? null,
    key: (index: number) => Array.from(data.keys())[index] ?? null,
    removeItem: (key: string) => {
      data.delete(key)
    },
    setItem: (key: string, value: string) => {
      data.set(key, value)
    },
  }
}

describe('parseMermaidEnhance', () => {
  it('defaults to enabled when no value is stored', () => {
    expect(parseMermaidEnhance(null)).toBe(DEFAULT_MERMAID_ENHANCE)
  })

  it('only treats an explicit 0 as disabled', () => {
    expect(parseMermaidEnhance('0')).toBe(false)
    expect(parseMermaidEnhance('1')).toBe(true)
    expect(parseMermaidEnhance('<script>')).toBe(true)
    expect(parseMermaidEnhance('{"enabled":false}')).toBe(true)
  })
})

describe('mermaid enhancement store', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('persists changes and notifies once per real transition', async () => {
    const storage = fakeStorage()
    vi.stubGlobal('localStorage', storage)
    const store = await import('./mermaidPrefs')
    const listener = vi.fn()
    const unsubscribe = store.subscribeMermaidEnhance(listener)

    expect(store.getMermaidEnhance()).toBe(true)
    store.setMermaidEnhance(false)
    expect(storage.getItem(MERMAID_ENHANCE_KEY)).toBe('0')
    expect(listener).toHaveBeenCalledTimes(1)

    store.setMermaidEnhance(false)
    expect(listener).toHaveBeenCalledTimes(1)

    unsubscribe()
    store.setMermaidEnhance(true)
    expect(storage.getItem(MERMAID_ENHANCE_KEY)).toBe('1')
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('falls back to enabled when storage throws', async () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
    })
    const store = await import('./mermaidPrefs')
    expect(store.getMermaidEnhance()).toBe(true)
    expect(() => store.setMermaidEnhance(false)).not.toThrow()
  })
})
