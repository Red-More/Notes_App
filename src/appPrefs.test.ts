import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_APP_PREFS, parseAppPrefs } from './appPrefs'

const STORAGE_KEY = 'notes:app-prefs'

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

describe('reminder preferences', () => {
  it('default to the built-in default tone without forced ringing', () => {
    expect(DEFAULT_APP_PREFS.reminderSound).toBe('default')
    expect(DEFAULT_APP_PREFS.forceReminder).toBe(false)
    expect(parseAppPrefs(null)).toEqual(DEFAULT_APP_PREFS)
  })

  it('keeps valid combinations and rejects unknown values independently', () => {
    expect(parseAppPrefs('{"reminderSound":"bell","forceReminder":true}')).toMatchObject({
      reminderSound: 'bell',
      forceReminder: true,
    })

    // A bad tone must not reset the unrelated force switch, and vice versa.
    expect(parseAppPrefs('{"reminderSound":"nope","forceReminder":true}')).toMatchObject({
      reminderSound: 'default',
      forceReminder: true,
    })
    expect(parseAppPrefs('{"reminderSound":"alarm","forceReminder":"yes"}')).toMatchObject({
      reminderSound: 'alarm',
      forceReminder: false,
    })
  })
})

describe('reminder preference persistence', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('persists the tone and the force switch without coupling them', async () => {
    const storage = fakeStorage()
    vi.stubGlobal('localStorage', storage)
    const store = await import('./appPrefs')

    store.setAppPrefs({ reminderSound: 'crisp' })
    expect(store.getAppPrefs().forceReminder).toBe(false)

    store.setAppPrefs({ forceReminder: true })
    expect(JSON.parse(storage.getItem(STORAGE_KEY) ?? '{}')).toMatchObject({
      reminderSound: 'crisp',
      forceReminder: true,
    })

    store.setAppPrefs({ reminderSound: 'bell' })
    expect(store.getAppPrefs()).toMatchObject({
      reminderSound: 'bell',
      forceReminder: true,
      remindersEnabled: true,
    })
  })
})
