import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SYNTAX_PREFS,
  parseSyntaxPrefs,
  resolveSyntaxColor,
  syntaxColorCss,
} from './syntaxPrefs'

describe('parseSyntaxPrefs', () => {
  it('falls back to defaults for missing or malformed values', () => {
    expect(parseSyntaxPrefs(null)).toEqual(DEFAULT_SYNTAX_PREFS)
    expect(parseSyntaxPrefs('')).toEqual(DEFAULT_SYNTAX_PREFS)
    expect(parseSyntaxPrefs('not json')).toEqual(DEFAULT_SYNTAX_PREFS)
    expect(parseSyntaxPrefs('{"palette":"neon"}')).toEqual(DEFAULT_SYNTAX_PREFS)
  })

  it('keeps known palette, color overrides and disabled tokens', () => {
    expect(
      parseSyntaxPrefs(
        '{"palette":"vivid","colors":{"heading1":"info","nope":"text"},"disabled":["quote","nope","quote"]}',
      ),
    ).toEqual({
      palette: 'vivid',
      colors: { heading1: 'info' },
      disabled: ['quote'],
    })
  })

  it('drops unknown color slots', () => {
    expect(parseSyntaxPrefs('{"colors":{"strong":"pink"}}').colors).toEqual({})
  })

  it('keeps custom hex colors and normalizes them', () => {
    expect(parseSyntaxPrefs('{"colors":{"strong":"#FF7A1A"}}').colors).toEqual({
      strong: '#ff7a1a',
    })
    expect(parseSyntaxPrefs('{"colors":{"strong":"#12"}}').colors).toEqual({})
  })
})

describe('resolveSyntaxColor', () => {
  it('follows the palette until an override exists', () => {
    expect(resolveSyntaxColor(DEFAULT_SYNTAX_PREFS, 'heading1')).toBe('h1')
    expect(
      resolveSyntaxColor({ ...DEFAULT_SYNTAX_PREFS, colors: { heading1: 'text3' } }, 'heading1'),
    ).toBe('text3')
  })

  it('uses each palette mapping', () => {
    expect(resolveSyntaxColor({ ...DEFAULT_SYNTAX_PREFS, palette: 'muted' }, 'heading1')).toBe(
      'text',
    )
    expect(resolveSyntaxColor({ ...DEFAULT_SYNTAX_PREFS, palette: 'contrast' }, 'link')).toBe(
      'info',
    )
  })
})

describe('syntaxColorCss', () => {
  it('maps slots onto theme variables', () => {
    expect(syntaxColorCss('accent')).toBe('var(--accent)')
    expect(syntaxColorCss('info')).toBe('var(--info)')
  })

  it('passes custom hex colors through', () => {
    expect(syntaxColorCss('#12ab34')).toBe('#12ab34')
  })
})
