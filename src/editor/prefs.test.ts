import { describe, expect, it } from 'vitest'
import {
  DEFAULT_EDITOR_PREFS,
  indentUnitFor,
  parseEditorPrefs,
} from './prefs'

describe('parseEditorPrefs', () => {
  it('falls back to defaults for missing or malformed values', () => {
    expect(parseEditorPrefs(null)).toEqual(DEFAULT_EDITOR_PREFS)
    expect(parseEditorPrefs('')).toEqual(DEFAULT_EDITOR_PREFS)
    expect(parseEditorPrefs('not json')).toEqual(DEFAULT_EDITOR_PREFS)
    expect(parseEditorPrefs('null')).toEqual(DEFAULT_EDITOR_PREFS)
    expect(parseEditorPrefs('{"indentStyle":"weird","indentSize":3}')).toEqual(
      DEFAULT_EDITOR_PREFS,
    )
  })

  it('accepts supported combinations', () => {
    expect(parseEditorPrefs('{"indentStyle":"tabs","indentSize":4}')).toEqual({
      indentStyle: 'tabs',
      indentSize: 4,
    })
    expect(parseEditorPrefs('{"indentStyle":"spaces","indentSize":8}')).toEqual({
      indentStyle: 'spaces',
      indentSize: 8,
    })
  })

  it('keeps the valid half of a partially invalid value', () => {
    expect(parseEditorPrefs('{"indentStyle":"tabs","indentSize":3}')).toEqual({
      indentStyle: 'tabs',
      indentSize: DEFAULT_EDITOR_PREFS.indentSize,
    })
  })
})

describe('indentUnitFor', () => {
  it('returns a tab or the configured number of spaces', () => {
    expect(indentUnitFor({ indentStyle: 'tabs', indentSize: 4 })).toBe('\t')
    expect(indentUnitFor({ indentStyle: 'spaces', indentSize: 2 })).toBe('  ')
    expect(indentUnitFor({ indentStyle: 'spaces', indentSize: 4 })).toBe('    ')
  })
})
