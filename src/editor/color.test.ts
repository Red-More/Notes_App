import { describe, expect, it } from 'vitest'
import { hexToRgb, hsvToRgb, normalizeHexColor, rgbToHex, rgbToHsv } from './color'

describe('hexToRgb', () => {
  it('accepts short and long forms with or without a hash', () => {
    expect(hexToRgb('#ff7a1a')).toEqual({ r: 255, g: 122, b: 26 })
    expect(hexToRgb('f00')).toEqual({ r: 255, g: 0, b: 0 })
    expect(hexToRgb('#0F0')).toEqual({ r: 0, g: 255, b: 0 })
  })

  it('rejects malformed values', () => {
    expect(hexToRgb('#12')).toBeNull()
    expect(hexToRgb('pink')).toBeNull()
    expect(hexToRgb('#gggggg')).toBeNull()
  })
})

describe('normalizeHexColor', () => {
  it('returns a canonical lowercase hex', () => {
    expect(normalizeHexColor('#FF7A1A')).toBe('#ff7a1a')
    expect(normalizeHexColor('f00')).toBe('#ff0000')
  })

  it('drops non-colors', () => {
    expect(normalizeHexColor('var(--accent)')).toBeNull()
    expect(normalizeHexColor(12)).toBeNull()
  })
})

describe('hsv conversion', () => {
  it('round-trips primary colors', () => {
    for (const hex of ['#ff0000', '#00ff00', '#0000ff', '#ff7a1a', '#8b8d97']) {
      const rgb = hexToRgb(hex)!
      expect(rgbToHex(hsvToRgb(rgbToHsv(rgb)))).toBe(hex)
    }
  })

  it('maps pure red to hue 0 and full saturation/value', () => {
    const hsv = rgbToHsv({ r: 255, g: 0, b: 0 })
    expect(hsv.h).toBeCloseTo(0)
    expect(hsv.s).toBeCloseTo(100)
    expect(hsv.v).toBeCloseTo(100)
  })

  it('maps white to zero saturation', () => {
    const hsv = rgbToHsv({ r: 255, g: 255, b: 255 })
    expect(hsv.s).toBeCloseTo(0)
    expect(hsv.v).toBeCloseTo(100)
    expect(hsvToRgb(hsv)).toEqual({ r: 255, g: 255, b: 255 })
  })
})
