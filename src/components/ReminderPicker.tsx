import { useEffect, useMemo, useRef, useState } from 'react'
import { dateStr } from '../utils'
import { REPEAT_OPTIONS, type RepeatValue } from '../todos/repeat'
import { buildDateOptions } from './pickerDates'
import { OverlayPortal } from './ui'
import { IconChevronDown, IconCheck } from './Icons'

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

/** Wheel column geometry: one item per step, three rows visible. */
const ITEM_H = 52
const VISIBLE_ROWS = 3

interface PickerValue {
  date: string
  hour: number
  minute: number
}

interface Props {
  /** Initial `YYYY-MM-DDTHH:mm` value; defaults to now rounded up. */
  initial?: string | null
  /** Initial repeat interval. */
  initialRepeat?: RepeatValue
  /**
   * What the value means. A reminder notifies and can repeat; a deadline is a
   * plain timestamp that only drives the "已过期" badge, so it gets no repeat
   * row and can be cleared.
   */
  variant?: 'remind' | 'due'
  /** Resolves the picked local datetime and repeat interval. */
  onConfirm: (value: string, repeat: RepeatValue) => void
  /** Only offered in `due` mode: clears the value instead of picking one. */
  onClear?: () => void
  onCancel: () => void
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

function labelForDate(date: string): string {
  const d = new Date(`${date}T00:00:00`)
  return `${d.getMonth() + 1}月${d.getDate()}日 ${WEEKDAYS[d.getDay()]}`
}

/** Build the scrollable option lists for the three wheel columns. */
function buildColumns(initial: PickerValue) {
  const { dates, dateIndex } = buildDateOptions(dateStr(new Date()), initial.date)
  return {
    dates,
    dateIndex,
    hours: Array.from({ length: 24 }, (_, i) => i),
    minutes: Array.from({ length: 60 }, (_, i) => i),
  }
}

/**
 * One scroll-snap wheel column. The near-big-far-small effect is applied
 * imperatively inside the scroll handler (rAF batched) so it tracks the wheel
 * in real time with no settle delay or flicker; React state only carries the
 * settled value.
 */
function WheelColumn({
  options,
  index,
  className,
  onSettle,
  render,
}: {
  options: Array<number | string>
  index: number
  className?: string
  onSettle: (index: number) => void
  render: (option: number | string) => React.ReactNode
}) {
  const ref = useRef<HTMLDivElement>(null)
  const settleTimer = useRef<number | null>(null)
  const rafRef = useRef(0)

  /** Distance-to-center drives size / weight / color per item. */
  const applyProximity = () => {
    const el = ref.current
    if (!el) return
    const viewCenter = el.scrollTop + el.clientHeight / 2
    for (const child of Array.from(el.children)) {
      const item = child as HTMLElement
      const d = Math.abs(item.offsetTop + item.offsetHeight / 2 - viewCenter) / ITEM_H
      const prox = Math.max(0, 1 - d)
      item.style.setProperty('--prox', prox.toFixed(3))
      const pct = Math.round(Math.max(0, (prox - 0.4) / 0.6) * 100)
      item.style.color = `color-mix(in srgb, var(--accent) ${pct}%, var(--text-2))`
    }
  }

  // Jump to the initial selection, then paint the proximity gradient once.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.scrollTop = index * ITEM_H
    applyProximity()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleScroll = () => {
    if (rafRef.current === 0) {
      rafRef.current = window.requestAnimationFrame(() => {
        rafRef.current = 0
        applyProximity()
      })
    }
    const el = ref.current
    if (!el) return
    if (settleTimer.current !== null) window.clearTimeout(settleTimer.current)
    settleTimer.current = window.setTimeout(() => {
      const next = Math.round(el.scrollTop / ITEM_H)
      const clamped = Math.min(Math.max(next, 0), options.length - 1)
      if (el.scrollTop !== clamped * ITEM_H) {
        el.scrollTo({ top: clamped * ITEM_H, behavior: 'smooth' })
      }
      onSettle(clamped)
    }, 120)
  }

  return (
    <div
      className={`wheel-col ${className ?? ''}`}
      ref={ref}
      onScroll={handleScroll}
      style={{ '--wheel-item-h': `${ITEM_H}px` } as React.CSSProperties}
    >
      {options.map((option, i) => (
        <div
          key={String(option)}
          className={`wheel-item ${i === index ? 'selected' : ''}`}
          style={{ height: ITEM_H }}
          onClick={() => {
            const el = ref.current
            if (el) el.scrollTo({ top: i * ITEM_H, behavior: 'smooth' })
          }}
        >
          {render(option)}
        </div>
      ))}
    </div>
  )
}

/**
 * Wheel-style datetime picker (date / hour / minute columns), themed via CSS
 * variables. Resolves to a local `YYYY-MM-DDTHH:mm` string.
 *
 * Used for both the reminder and the deadline: the wheels are identical, but a
 * deadline has no repeat and can be cleared, so those controls only render in
 * the matching variant.
 */
export default function ReminderPicker({
  initial,
  initialRepeat = 'none',
  variant = 'remind',
  onConfirm,
  onClear,
  onCancel,
}: Props) {
  const seed = useMemo<PickerValue>(() => {
    if (initial) {
      const [date, time] = initial.split('T')
      const [h, m] = (time ?? '09:00').split(':')
      return { date, hour: Number(h) || 0, minute: Number(m) || 0 }
    }
    const now = new Date()
    return { date: dateStr(now), hour: now.getHours(), minute: now.getMinutes() }
  }, [initial])

  const columns = useMemo(() => buildColumns(seed), [seed])
  const [dateIndex, setDateIndex] = useState(columns.dateIndex)
  const [hour, setHour] = useState(seed.hour)
  const [minute, setMinute] = useState(seed.minute)
  const [repeat, setRepeat] = useState<RepeatValue>(
    REPEAT_OPTIONS.some((o) => o.value === initialRepeat) ? initialRepeat : 'none',
  )
  const [repeatOpen, setRepeatOpen] = useState(false)

  const selectedDate = columns.dates[dateIndex] ?? seed.date
  const subtitle = `${labelForDate(selectedDate)} ${pad(hour)}时${pad(minute)}分`

  const confirm = () => {
    onConfirm(`${selectedDate}T${pad(hour)}:${pad(minute)}`, repeat)
  }

  return (
    // Portal into the overlay layer so the dialog paints above the tabbar even
    // when opened from a page nested in the transformed pager track.
    <OverlayPortal>
      <div className="modal-overlay picker-overlay" onClick={onCancel}>
        <div className="picker-dialog" onClick={(e) => e.stopPropagation()}>
          <div className="picker-title">
            {variant === 'due' ? '截止时间' : '提醒时间'}
          </div>
          <div className="picker-subtitle">{subtitle}</div>

          <div className="wheel" style={{ height: ITEM_H * VISIBLE_ROWS }}>
            <div className="wheel-highlight" style={{ top: ITEM_H }} />
            <WheelColumn
              className="wheel-col-date"
              options={columns.dates}
              index={dateIndex}
              onSettle={setDateIndex}
              render={(option) => (
                <span className="wheel-label">{labelForDate(String(option))}</span>
              )}
            />
            <WheelColumn
              options={columns.hours}
              index={hour}
              onSettle={setHour}
              render={(option) => (
                <span className="wheel-label">
                  {pad(Number(option))}
                  <span className="wheel-unit">时</span>
                </span>
              )}
            />
            <WheelColumn
              options={columns.minutes}
              index={minute}
              onSettle={setMinute}
              render={(option) => (
                <span className="wheel-label">
                  {pad(Number(option))}
                  <span className="wheel-unit">分</span>
                </span>
              )}
            />
          </div>

          {/* A deadline is a single timestamp: repeating it is meaningless. */}
          {variant === 'remind' && (
            <div className="picker-repeat">
              <span className="picker-repeat-label">重复提醒</span>
              <div className="picker-repeat-anchor">
                <button
                  type="button"
                  className="picker-repeat-btn"
                  onClick={() => setRepeatOpen((v) => !v)}
                  aria-haspopup="menu"
                  aria-expanded={repeatOpen}
                >
                  <span>{REPEAT_OPTIONS.find((o) => o.value === repeat)?.label ?? '不重复'}</span>
                  <IconChevronDown size={14} />
                </button>
                {repeatOpen && (
                  <>
                    <div className="repeat-pop-backdrop" onClick={() => setRepeatOpen(false)} />
                    <div className="repeat-pop" role="menu">
                      {REPEAT_OPTIONS.map((option) => (
                        <button
                          key={option.value}
                          type="button"
                          role="menuitem"
                          className={`sort-option ${repeat === option.value ? 'active' : ''}`}
                          onClick={() => {
                            setRepeat(option.value)
                            setRepeatOpen(false)
                          }}
                        >
                          {option.label}
                          {repeat === option.value && <IconCheck size={16} />}
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </div>
            </div>
          )}

          <div className="picker-actions">
            <button type="button" className="btn picker-cancel" onClick={onCancel}>
              取消
            </button>
            {onClear && (
              <button type="button" className="btn picker-clear" onClick={onClear}>
                清除
              </button>
            )}
            <button type="button" className="btn picker-confirm" onClick={confirm}>
              确定
            </button>
          </div>
        </div>
      </div>
    </OverlayPortal>
  )
}
