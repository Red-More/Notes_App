//! 输入框上沿的排队状态栏。
//!
//! Collapsed: one fixed-height row with the count and the newest preview.
//! Expanded: one row per submission with type, preview, status, withdraw /
//! retry. Long-press shows when the item will take effect; a long-press on a
//! follow-up also starts a vertical drag that reorders the queue.

import { useCallback, useEffect, useRef, useState } from 'react'
import type { QueueEntry, QueueEntryMode } from '../../agent/AgentRuntime'

interface Props {
  items: QueueEntry[]
  /** Tool calls started in the current run; feeds the steer ETA copy. */
  stepCount: number
  expanded: boolean
  /** Items playing their "sucked into the transcript" exit animation. */
  leavingIds: Set<string>
  onToggle: () => void
  onRemove: (id: string) => void
  onRetry: (id: string) => void
  onMove: (id: string, targetIndex: number) => void
}

/** Must match `.chat-queue-item` height in index.css. */
const ROW_HEIGHT = 38
const LONG_PRESS_MS = 380

const STATUS_TEXT: Record<QueueEntry['status'], string> = {
  pending: '排队中',
  delivered: '已投递',
  consumed: '已投递',
  failed: '失败',
}

const MODE_TEXT: Record<QueueEntryMode, string> = {
  steer: '插话',
  followUp: '排队',
}

/** One press in progress; `index` is the follow-up ordinal, -1 for steer. */
interface PressState {
  id: string
  index: number
  startY: number
  followUp: boolean
}

interface DragState {
  id: string
  from: number
  dy: number
  to: number
}

function vibrate(ms = 8): void {
  try {
    if (typeof navigator.vibrate === 'function') navigator.vibrate(ms)
  } catch {
    // Haptics are best effort.
  }
}

/** Plain-language "when will this take effect" copy for the long-press hint. */
function queueEtaText(entry: QueueEntry, stepCount: number): string {
  if (entry.mode === 'followUp') return '将在当前任务结束后作为新一轮开始'
  if (entry.status === 'pending') return '正在投递，将在本轮结束、下一轮请求前注入'
  return stepCount > 0
    ? `将在第 ${stepCount} 个工具返回后注入`
    : '将在本轮结束、下一轮请求前注入'
}

export default function QueueStatusBar({
  items,
  stepCount,
  expanded,
  leavingIds,
  onToggle,
  onRemove,
  onRetry,
  onMove,
}: Props) {
  const [eta, setEta] = useState<{ id: string; text: string } | null>(null)
  const [drag, setDrag] = useState<DragState | null>(null)
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const etaTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const press = useRef<PressState | null>(null)
  // A completed long-press must not also fire the row's click (retry).
  const suppressClickUntil = useRef(0)

  const followUps = items.filter(
    (item) => item.mode === 'followUp' && item.status !== 'consumed',
  )

  const clearPressTimer = useCallback(() => {
    if (pressTimer.current) {
      clearTimeout(pressTimer.current)
      pressTimer.current = null
    }
  }, [])

  const showEta = useCallback((entry: QueueEntry) => {
    setEta({ id: entry.id, text: queueEtaText(entry, stepCount) })
    if (etaTimer.current) clearTimeout(etaTimer.current)
    etaTimer.current = setTimeout(() => setEta(null), 1800)
  }, [stepCount])

  const handlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>, entry: QueueEntry) => {
      if (event.pointerType === 'mouse' && event.button !== 0) return
      if ((event.target as HTMLElement).closest('.chat-queue-remove')) return
      clearPressTimer()
      // Keep move/up events on this row even when the finger leaves it.
      event.currentTarget.setPointerCapture?.(event.pointerId)
      const index = followUps.findIndex((item) => item.id === entry.id)
      press.current = {
        id: entry.id,
        index,
        startY: event.clientY,
        followUp: entry.mode === 'followUp' && index >= 0,
      }
      pressTimer.current = setTimeout(() => {
        pressTimer.current = null
        suppressClickUntil.current = performance.now() + 400
        vibrate()
        showEta(entry)
        if (press.current?.followUp) {
          setDrag({ id: entry.id, from: index, dy: 0, to: index })
        }
      }, LONG_PRESS_MS)
    },
    [clearPressTimer, followUps, showEta],
  )

  const handlePointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const current = press.current
      if (!current) return
      const dy = event.clientY - current.startY
      if (!drag) {
        // Moving before the long-press fires means the user is scrolling.
        if (Math.abs(dy) > 10) {
          clearPressTimer()
          press.current = null
        }
        return
      }
      if (drag.id !== current.id) return
      const to = Math.max(
        0,
        Math.min(followUps.length - 1, current.index + Math.round(dy / ROW_HEIGHT)),
      )
      setDrag({ ...drag, dy, to })
    },
    [clearPressTimer, drag, followUps.length],
  )

  const finishPress = useCallback(() => {
    clearPressTimer()
    const current = press.current
    press.current = null
    if (drag) {
      if (current && drag.id === current.id && drag.to !== drag.from) {
        onMove(drag.id, drag.to)
      }
      setDrag(null)
    }
  }, [clearPressTimer, drag, onMove])

  // Block page scrolling while a held row is being dragged.
  useEffect(() => {
    if (!drag) return
    const block = (event: TouchEvent) => event.preventDefault()
    document.addEventListener('touchmove', block, { passive: false })
    return () => document.removeEventListener('touchmove', block)
  }, [drag])

  useEffect(
    () => () => {
      clearPressTimer()
      if (etaTimer.current) clearTimeout(etaTimer.current)
    },
    [clearPressTimer],
  )

  if (items.length === 0) return null

  const latest = items[items.length - 1]
  const etaText = eta?.text ?? null

  return (
    <div className={`chat-queue-bar ${expanded ? 'expanded' : ''}`} aria-live="polite">
      {etaText && (
        <div className="chat-queue-eta" role="status">
          {etaText}
        </div>
      )}
      {expanded && (
        <div className="chat-queue-list" role="list">
          {items.map((entry) => {
            const leaving = leavingIds.has(entry.id)
            const dragging = drag?.id === entry.id
            // Only waiting entries can be withdrawn; a delivered steer is
            // already inside the model's next request.
            const canRemove = entry.status === 'pending' || entry.status === 'failed'
            return (
              <div
                key={entry.id}
                role="listitem"
                className={`chat-queue-item ${entry.mode} ${entry.status} ${
                  leaving ? 'leaving' : ''
                } ${dragging ? 'dragging' : ''}`}
                style={dragging ? { transform: `translateY(${drag.dy}px)` } : undefined}
                onPointerDown={(event) => handlePointerDown(event, entry)}
                onPointerMove={handlePointerMove}
                onPointerUp={finishPress}
                onPointerCancel={finishPress}
                onContextMenu={(event) => event.preventDefault()}
                onClick={() => {
                  if (performance.now() < suppressClickUntil.current) return
                  if (entry.status === 'failed') onRetry(entry.id)
                }}
              >
                <span className={`chat-queue-kind ${entry.mode}`}>{MODE_TEXT[entry.mode]}</span>
                <span className="chat-queue-text">{entry.text}</span>
                <span className={`chat-queue-state ${entry.status}`}>
                  <span className={`chat-queue-dot ${entry.status}`} />
                  {STATUS_TEXT[entry.status]}
                </span>
                <button
                  type="button"
                  className="chat-queue-remove"
                  aria-label={entry.status === 'failed' ? '移除' : '撤回'}
                  disabled={!canRemove}
                  onClick={(event) => {
                    event.stopPropagation()
                    onRemove(entry.id)
                  }}
                >
                  ×
                </button>
              </div>
            )
          })}
        </div>
      )}
      <button
        type="button"
        className="chat-queue-head"
        aria-expanded={expanded}
        onClick={onToggle}
      >
        <span className="chat-queue-count">{items.length} 条排队中</span>
        <span className="chat-queue-preview">{latest.text}</span>
        <span className={`chat-queue-caret ${expanded ? 'up' : 'down'}`} aria-hidden="true">
          {expanded ? '▴' : '▾'}
        </span>
      </button>
    </div>
  )
}
