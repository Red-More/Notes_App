/**
 * Small, dependency-free color helpers shared by the syntax color picker.
 * Values are kept in 0-255 RGB and 0-360 / 0-100 HSV space; formatting and
 * clamping happen at the edges so picker interactions stay stable.
 */

export interface Rgb {
  r: number
  g: number
  b: number
}

export interface Hsv {
  h: number
  s: number
  v: number
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

const clampByte = (value: number) => Math.round(clamp(value, 0, 255))

/** Parse `#rgb` / `#rrggbb` (the leading `#` is optional). */
export function hexToRgb(hex: string): Rgb | null {
  const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim())
  if (!match) return null
  let value = match[1]
  if (value.length === 3) {
    value = value
      .split('')
      .map((char) => char + char)
      .join('')
  }
  return {
    r: Number.parseInt(value.slice(0, 2), 16),
    g: Number.parseInt(value.slice(2, 4), 16),
    b: Number.parseInt(value.slice(4, 6), 16),
  }
}

/** Canonical lowercase `#rrggbb`, or null when the input is not a hex color. */
export function normalizeHexColor(value: unknown): `#${string}` | null {
  if (typeof value !== 'string') return null
  const rgb = hexToRgb(value)
  if (!rgb) return null
  return rgbToHex(rgb)
}

export function isHexColor(value: unknown): value is `#${string}` {
  return normalizeHexColor(value) !== null
}

export function rgbToHex(rgb: Rgb): `#${string}` {
  const channel = (value: number) => clampByte(value).toString(16).padStart(2, '0')
  return `#${channel(rgb.r)}${channel(rgb.g)}${channel(rgb.b)}`
}

export function rgbToHsv(rgb: Rgb): Hsv {
  const r = clampByte(rgb.r) / 255
  const g = clampByte(rgb.g) / 255
  const b = clampByte(rgb.b) / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const delta = max - min

  let hue = 0
  if (delta !== 0) {
    if (max === r) hue = 60 * (((g - b) / delta) % 6)
    else if (max === g) hue = 60 * ((b - r) / delta + 2)
    else hue = 60 * ((r - g) / delta + 4)
  }
  if (hue < 0) hue += 360

  return {
    h: hue,
    s: max === 0 ? 0 : (delta / max) * 100,
    v: max * 100,
  }
}

export function hsvToRgb(hsv: Hsv): Rgb {
  const hue = ((hsv.h % 360) + 360) % 360
  const saturation = clamp(hsv.s, 0, 100) / 100
  const value = clamp(hsv.v, 0, 100) / 100
  const chroma = value * saturation
  const second = chroma * (1 - Math.abs(((hue / 60) % 2) - 1))
  const offset = value - chroma

  let r = 0
  let g = 0
  let b = 0
  if (hue < 60) [r, g] = [chroma, second]
  else if (hue < 120) [r, g] = [second, chroma]
  else if (hue < 180) [g, b] = [chroma, second]
  else if (hue < 240) [g, b] = [second, chroma]
  else if (hue < 300) [r, b] = [second, chroma]
  else [r, b] = [chroma, second]

  return {
    r: Math.round((r + offset) * 255),
    g: Math.round((g + offset) * 255),
    b: Math.round((b + offset) * 255),
  }
}

/**
 * Resolve a CSS color expression (including theme variables) to a hex value
 * the picker can edit. Theme variables need a live document; without one the
 * fallback is plain black.
 */
export function cssColorToHex(css: string): string {
  const direct = normalizeHexColor(css)
  if (direct) return direct
  if (typeof document === 'undefined') return '#000000'

  const probe = document.createElement('span')
  probe.style.color = css
  probe.style.position = 'absolute'
  probe.style.visibility = 'hidden'
  probe.style.pointerEvents = 'none'
  document.body.appendChild(probe)
  const computed = getComputedStyle(probe).color
  probe.remove()

  const match = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/.exec(computed)
  if (!match) return '#000000'
  return rgbToHex({ r: Number(match[1]), g: Number(match[2]), b: Number(match[3]) })
}
