import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_APP_PREFS, FONT_FINE_RANGE, parseAppPrefs } from './appPrefs'

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

describe('startup page preferences', () => {
  it('default to notes and reject unknown tabs', () => {
    expect(DEFAULT_APP_PREFS.startTab).toBe('notes')
    expect(parseAppPrefs(null).startTab).toBe('notes')
    expect(parseAppPrefs('{"startTab":"todos"}').startTab).toBe('todos')
    expect(parseAppPrefs('{"startTab":"settings"}').startTab).toBe('notes')
  })
})

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

describe('font scale preferences', () => {
  it('default to the M tier without fine tuning', () => {
    expect(DEFAULT_APP_PREFS.fontScale).toBe('m')
    expect(DEFAULT_APP_PREFS.fontFine).toBe(0)
    expect(parseAppPrefs(null)).toMatchObject({ fontScale: 'm', fontFine: 0 })
  })

  it('migrate the three legacy tier names and reject unknown ones', () => {
    expect(parseAppPrefs('{"fontScale":"standard"}').fontScale).toBe('m')
    expect(parseAppPrefs('{"fontScale":"large"}').fontScale).toBe('l')
    expect(parseAppPrefs('{"fontScale":"extra"}').fontScale).toBe('xl')
    expect(parseAppPrefs('{"fontScale":"xl"}').fontScale).toBe('xl')
    expect(parseAppPrefs('{"fontScale":"huge"}').fontScale).toBe('m')
  })

  it('round and clamp fine tuning into the allowed range', () => {
    expect(parseAppPrefs('{"fontFine":99}').fontFine).toBe(FONT_FINE_RANGE)
    expect(parseAppPrefs('{"fontFine":-99}').fontFine).toBe(-FONT_FINE_RANGE)
    expect(parseAppPrefs('{"fontFine":2.4}').fontFine).toBe(2)
    expect(parseAppPrefs('{"fontFine":"3"}').fontFine).toBe(0)
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

  it('keeps the stored fine tuning when a patch is not a number', async () => {
    vi.stubGlobal('localStorage', fakeStorage())
    // applyFontScale writes CSS variables through the document element.
    vi.stubGlobal('document', {
      documentElement: { style: { setProperty: vi.fn() }, dataset: {} },
    })
    const store = await import('./appPrefs')

    store.setAppPrefs({ fontFine: 3 })
    expect(store.getAppPrefs().fontFine).toBe(3)

    // Malformed values must not reset the stored offset; numeric ones clamp.
    store.setAppPrefs({ fontFine: '7' as unknown as number })
    expect(store.getAppPrefs().fontFine).toBe(3)
    store.setAppPrefs({ fontFine: 99 })
    expect(store.getAppPrefs().fontFine).toBe(FONT_FINE_RANGE)
  })
})
