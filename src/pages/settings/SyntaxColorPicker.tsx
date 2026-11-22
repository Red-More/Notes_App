import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { IconClose } from '../../components/Icons'
import { cssColorToHex, hexToRgb, hsvToRgb, rgbToHex, rgbToHsv, type Hsv } from '../../editor/color'
import {
  SYNTAX_PRESETS,
  syntaxColorCss,
  type SyntaxColorKey,
  type SyntaxColorValue,
} from '../../editor/syntaxPrefs'
import { useSettingsOverlay } from './settingsOverlay'

interface Props {
  label: string
  value: SyntaxColorValue
  anchor: { left: number; top: number; right: number; bottom: number }
  onChange: (value: SyntaxColorValue) => void
  onReset: () => void
  onClose: () => void
}

const POPOVER_WIDTH = 300
const VIEWPORT_MARGIN = 8

/** Place the popover next to its button, clamped to the app shell. */
function placePopover(
  anchor: Props['anchor'],
  height: number,
): { left: number; top: number; width: number } {
  const shell = document.getElementById('root')?.getBoundingClientRect()
  const width = Math.min(POPOVER_WIDTH, window.innerWidth - VIEWPORT_MARGIN * 2)
  const minLeft = (shell?.left ?? 0) + VIEWPORT_MARGIN
  const maxLeft = (shell?.right ?? window.innerWidth) - width - VIEWPORT_MARGIN
  const center = anchor.left + (anchor.right - anchor.left) / 2
  const left = Math.min(Math.max(minLeft, center - width / 2), Math.max(minLeft, maxLeft))

  const minTop = (shell?.top ?? 0) + VIEWPORT_MARGIN
  const maxBottom = (shell?.bottom ?? window.innerHeight) - VIEWPORT_MARGIN
  const below = anchor.bottom + VIEWPORT_MARGIN
  const above = anchor.top - height - VIEWPORT_MARGIN
  const top = below + height <= maxBottom ? below : Math.max(minTop, above)
  return { left, top, width }
}

function presetOf(value: SyntaxColorValue): SyntaxColorKey | null {
  return SYNTAX_PRESETS.some((slot) => slot.key === value) ? (value as SyntaxColorKey) : null
}

/**
 * HSV color picker: hue ring plus saturation / brightness sliders, a hex input,
 * and the theme palette slots. Every change is applied immediately through
 * `onChange`, which persists the token override.
 */
export default function SyntaxColorPicker({
  label,
  value,
  anchor,
  onChange,
  onReset,
  onClose,
}: Props) {
  // Probe the live theme color only once; later updates come from the picker.
  const [hexDraft, setHexDraft] = useState(() => cssColorToHex(syntaxColorCss(value)))
  const [hsv, setHsv] = useState<Hsv>(() => rgbToHsv(hexToRgb(hexDraft) ?? { r: 0, g: 0, b: 0 }))
  const hsvRef = useRef(hsv)
  const [preset, setPreset] = useState<SyntaxColorKey | null>(() => presetOf(value))
  const popoverRef = useRef<HTMLDivElement>(null)
  const ringRef = useRef<HTMLDivElement>(null)
  const draggingRef = useRef(false)
  const [position, setPosition] = useState(() => placePopover(anchor, 380))

  useSettingsOverlay(onClose)

  useLayoutEffect(() => {
    const element = popoverRef.current
    if (!element) return
    setPosition(placePopover(anchor, element.offsetHeight))
  }, [anchor])

  useEffect(() => {
    const element = popoverRef.current
    element?.focus()
    const onResize = () => {
      if (element) setPosition(placePopover(anchor, element.offsetHeight))
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [anchor])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const commit = (next: Hsv) => {
    hsvRef.current = next
    setHsv(next)
    const hex = rgbToHex(hsvToRgb(next))
    setHexDraft(hex)
    setPreset(null)
    onChange(hex)
  }

  const choosePreset = (slot: (typeof SYNTAX_PRESETS)[number]) => {
    const rgb = hexToRgb(cssColorToHex(slot.css)) ?? { r: 0, g: 0, b: 0 }
    const next = rgbToHsv(rgb)
    hsvRef.current = next
    setHsv(next)
    setHexDraft(rgbToHex(rgb))
    setPreset(slot.key)
    onChange(slot.key)
  }

  const hueFromPointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    const rect = ringRef.current?.getBoundingClientRect()
    if (!rect) return hsvRef.current.h
    const dx = event.clientX - (rect.left + rect.width / 2)
    const dy = event.clientY - (rect.top + rect.height / 2)
    return ((Math.atan2(dx, -dy) * 180) / Math.PI + 360) % 360
  }

  const ringPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
    draggingRef.current = true
    commit({ ...hsvRef.current, h: hueFromPointer(event) })
  }

  const ringPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return
    commit({ ...hsvRef.current, h: hueFromPointer(event) })
  }

  const ringPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    draggingRef.current = false
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  const ringKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 10 : 1
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    const delta = event.key === 'ArrowLeft' ? -step : step
    commit({ ...hsvRef.current, h: (hsvRef.current.h + delta + 360) % 360 })
  }

  const hexChanged = (raw: string) => {
    setHexDraft(raw)
    const rgb = hexToRgb(raw)
    if (!rgb) return
    const hex = rgbToHex(rgb)
    const next = rgbToHsv(rgb)
    hsvRef.current = next
    setHsv(next)
    setPreset(null)
    onChange(hex)
  }

  const hueRad = (hsv.h * Math.PI) / 180
  const pureHue = rgbToHex(hsvToRgb({ h: hsv.h, s: 100, v: 100 }))
  const saturationStart = rgbToHex(hsvToRgb({ h: hsv.h, s: 0, v: hsv.v }))
  const valueEnd = rgbToHex(hsvToRgb({ h: hsv.h, s: hsv.s, v: 100 }))
  const rgb = hsvToRgb(hsv)

  return (
    <>
      <div className="color-popover-overlay" onPointerDown={onClose} />
      <div
        ref={popoverRef}
        className="color-popover"
        role="dialog"
        aria-label={`${label}颜色`}
        tabIndex={-1}
        style={{ left: position.left, top: position.top, width: position.width }}
      >
        <div className="color-popover-head">
          <span className="color-popover-title">{label}</span>
          <span className="color-popover-current">{hexDraft.toUpperCase()}</span>
          <button
            type="button"
            className="color-popover-close"
            onClick={onClose}
            aria-label="关闭取色器"
          >
            <IconClose size={18} />
          </button>
        </div>

        <div
          ref={ringRef}
          className="color-hue-ring"
          onPointerDown={ringPointerDown}
          onPointerMove={ringPointerMove}
          onPointerUp={ringPointerUp}
          onPointerCancel={ringPointerUp}
          onKeyDown={ringKeyDown}
          aria-label="色相环"
          role="slider"
          aria-valuemin={0}
          aria-valuemax={360}
          aria-valuenow={Math.round(hsv.h)}
          tabIndex={0}
        >
          <span
            className="color-hue-knob"
            style={{
              left: `${50 + 43 * Math.sin(hueRad)}%`,
              top: `${50 - 43 * Math.cos(hueRad)}%`,
              background: pureHue,
            }}
          />
        </div>

        <label className="color-slider-row">
          <span>饱和度</span>
          <input
            type="range"
            min={0}
            max={100}
            value={Math.round(hsv.s)}
            style={{ background: `linear-gradient(to right, ${saturationStart}, ${pureHue})` }}
            onChange={(event) => commit({ ...hsvRef.current, s: Number(event.target.value) })}
            aria-label={`${label}饱和度`}
          />
          <span className="color-slider-value">{Math.round(hsv.s)}%</span>
        </label>

        <label className="color-slider-row">
          <span>明度</span>
          <input
            type="range"
            min={0}
            max={100}
            value={Math.round(hsv.v)}
            style={{ background: `linear-gradient(to right, #000000, ${valueEnd})` }}
            onChange={(event) => commit({ ...hsvRef.current, v: Number(event.target.value) })}
            aria-label={`${label}明度`}
          />
          <span className="color-slider-value">{Math.round(hsv.v)}%</span>
        </label>

        <div className="color-popover-values">
          <span className="color-hex-label">HEX</span>
          <input
            className="color-hex-input"
            value={hexDraft}
            onChange={(event) => hexChanged(event.target.value)}
            onBlur={() => {
              const rgb = hexToRgb(hexDraft)
              setHexDraft(rgb ? rgbToHex(rgb) : rgbToHex(hsvToRgb(hsvRef.current)))
            }}
            spellCheck={false}
            aria-label={`${label}十六进制颜色`}
          />
          <span className="color-rgb-readout">
            rgb({rgb.r}, {rgb.g}, {rgb.b})
          </span>
        </div>

        <div className="color-popover-presets" role="group" aria-label="预设颜色">
          {SYNTAX_PRESETS.map((slot) => (
            <button
              key={slot.key}
              type="button"
              className={`color-preset${preset === slot.key ? ' active' : ''}`}
              style={{ background: slot.css }}
              aria-label={slot.label}
              aria-pressed={preset === slot.key}
              onClick={() => choosePreset(slot)}
            />
          ))}
        </div>

        <div className="color-popover-actions">
          <button
            type="button"
            className="color-reset"
            onClick={() => {
              onReset()
              onClose()
            }}
          >
            跟随配色主题
          </button>
          <button type="button" className="color-done" onClick={onClose}>
            完成
          </button>
        </div>
      </div>
    </>
  )
}
