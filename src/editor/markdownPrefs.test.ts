import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_MARKDOWN_DISPLAY,
  MARKDOWN_DISPLAY_KEY,
  parseMarkdownDisplay,
} from './markdownPrefs'

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

describe('parseMarkdownDisplay', () => {
  it('defaults both switches to on', () => {
    expect(DEFAULT_MARKDOWN_DISPLAY).toEqual({ html: true, breaks: true })
    expect(parseMarkdownDisplay(null)).toEqual(DEFAULT_MARKDOWN_DISPLAY)
  })

  it('accepts explicit booleans and rejects malformed values', () => {
    expect(parseMarkdownDisplay('{"html":false,"breaks":false}')).toEqual({
      html: false,
      breaks: false,
    })
    expect(parseMarkdownDisplay('{"html":"off"}')).toEqual(DEFAULT_MARKDOWN_DISPLAY)
    expect(parseMarkdownDisplay('<script>')).toEqual(DEFAULT_MARKDOWN_DISPLAY)
  })
})

describe('markdown display store', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('persists partial changes and notifies once per real transition', async () => {
    const storage = fakeStorage()
    vi.stubGlobal('localStorage', storage)
    const store = await import('./markdownPrefs')
    const listener = vi.fn()
    store.subscribeMarkdownDisplay(listener)

    store.setMarkdownDisplay({ html: false })
    expect(JSON.parse(storage.getItem(MARKDOWN_DISPLAY_KEY) ?? '{}')).toEqual({
      html: false,
      breaks: true,
    })
    expect(listener).toHaveBeenCalledTimes(1)

    store.setMarkdownDisplay({ html: false })
    expect(listener).toHaveBeenCalledTimes(1)

    store.setMarkdownDisplay({ breaks: false })
    expect(JSON.parse(storage.getItem(MARKDOWN_DISPLAY_KEY) ?? '{}')).toEqual({
      html: false,
      breaks: false,
    })
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('falls back to defaults when storage throws', async () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
    })
    const store = await import('./markdownPrefs')
    expect(store.getMarkdownDisplay()).toEqual(DEFAULT_MARKDOWN_DISPLAY)
    expect(() => store.setMarkdownDisplay({ html: false })).not.toThrow()
  })
})
