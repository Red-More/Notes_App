import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { dateStr } from '../utils'

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

/** Wheel column geometry: one item per step, three rows visible. */
const ITEM_H = 52
const VISIBLE_ROWS = 3

/** How many days back / forward the date column offers. */
const DAYS_BACK = 7
const DAYS_FORWARD = 90

interface PickerValue {
  date: string
  hour: number
  minute: number
}

interface Props {
  /** Initial `YYYY-MM-DDTHH:mm` value; defaults to now rounded up. */
  initial?: string | null
  onConfirm: (value: string) => void
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
  const today = new Date(`${dateStr(new Date())}T00:00:00`)
  const dates: string[] = []
  for (let offset = -DAYS_BACK; offset <= DAYS_FORWARD; offset += 1) {
    const d = new Date(today)
    d.setDate(d.getDate() + offset)
    dates.push(dateStr(d))
  }
  return {
    dates,
    // Out-of-range initial dates (e.g. far past/future) fall back to today.
    dateIndex: (() => {
      const idx = dates.indexOf(initial.date === '' ? dateStr(new Date()) : initial.date)
      return idx >= 0 ? idx : dates.indexOf(dateStr(new Date()))
    })(),
    hours: Array.from({ length: 24 }, (_, i) => i),
    minutes: Array.from({ length: 60 }, (_, i) => i),
  }
}

/** One scroll-snap wheel column; reports the settled index upward. */
function WheelColumn({
  options,
  index,
  onSettle,
  render,
}: {
  options: Array<number | string>
  index: number
  onSettle: (index: number) => void
  render: (option: number | string, selected: boolean) => ReactNode
}) {
  const ref = useRef<HTMLDivElement>(null)
  const settleTimer = useRef<number | null>(null)

  // Jump to the initial selection once the element exists.
  useEffect(() => {
    const el = ref.current
    if (el) el.scrollTop = index * ITEM_H
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Snap to the nearest option after scrolling stops.
  const handleScroll = () => {
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
      className="wheel-col"
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
          {render(option, i === index)}
        </div>
      ))}
    </div>
  )
}

/**
 * Wheel-style reminder time picker (date / hour / minute columns), themed via
 * CSS variables. Resolves to a local `YYYY-MM-DDTHH:mm` string.
 */
export default function ReminderPicker({ initial, onConfirm, onCancel }: Props) {
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

  const selectedDate = columns.dates[dateIndex] ?? seed.date
  const subtitle = `${labelForDate(selectedDate)} ${pad(hour)}时${pad(minute)}分`

  const confirm = () => {
    onConfirm(`${selectedDate}T${pad(hour)}:${pad(minute)}`)
  }

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="picker-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="picker-title">提醒时间</div>
        <div className="picker-subtitle">{subtitle}</div>

        <div className="wheel" style={{ height: ITEM_H * VISIBLE_ROWS }}>
          <div className="wheel-highlight" style={{ top: ITEM_H }} />
          <WheelColumn
            options={columns.dates}
            index={dateIndex}
            onSettle={setDateIndex}
            render={(option, selected) => (
              <span className={selected ? 'accent' : ''}>{labelForDate(String(option))}</span>
            )}
          />
          <WheelColumn
            options={columns.hours}
            index={hour}
            onSettle={setHour}
            render={(option, selected) => (
              <span className={selected ? 'accent' : ''}>
                {pad(Number(option))}
                <span className="wheel-unit">时</span>
              </span>
            )}
          />
          <WheelColumn
            options={columns.minutes}
            index={minute}
            onSettle={setMinute}
            render={(option, selected) => (
              <span className={selected ? 'accent' : ''}>
                {pad(Number(option))}
                <span className="wheel-unit">分</span>
              </span>
            )}
          />
        </div>

        <div className="picker-actions">
          <button type="button" className="btn picker-cancel" onClick={onCancel}>
            取消
          </button>
          <button type="button" className="btn picker-confirm" onClick={confirm}>
            确定
          </button>
        </div>
      </div>
    </div>
  )
}
