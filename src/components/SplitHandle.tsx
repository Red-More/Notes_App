import { useCallback, useEffect, useRef, useState } from 'react'
import {
  MAX_SPLIT_RATIO,
  MIN_SPLIT_RATIO,
  SPLIT_HANDLE_SIZE,
  clampSplitRatio,
  ratioFromDrag,
  snapSplitRatio,
} from '../editor/layout'

interface SplitHandleProps {
  /** Editor share of the split area, 0-100. */
  ratio: number
  /** Fired continuously while dragging (not persisted). */
  onChange: (ratio: number) => void
  /** Fired once when the drag / keyboard nudge ends (persisted by the parent). */
  onCommit: (ratio: number) => void
}

interface DragState {
  pointerId: number
  startY: number
  startRatio: number
  moved: boolean
  latestY: number
  height: number
}

const DRAG_THRESHOLD = 4
/** How close (px) a pointer must come before the resting divider wakes up. */
const WAKE_DISTANCE = 40
/** Idle time before the divider rolls back to its hidden state. */
const HIDE_DELAY = 1800

/**
 * Horizontal divider overlaid on the pane boundary. Drag to resize over the
 * full 0-100% range (either pane may be hidden completely), release near an
 * edge to snap onto it, arrow keys to nudge. The visual handle stays rolled up
 * out of sight until the pointer comes close, then unrolls like a scroll.
 */
export default function SplitHandle({ ratio, onChange, onCommit }: SplitHandleProps) {
  const [dragging, setDragging] = useState(false)
  const [awake, setAwake] = useState(false)
  const handleRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<DragState | null>(null)
  const frameRef = useRef(0)
  const hideTimerRef = useRef(0)

  /** Unroll the handle and arm the timer that rolls it back when idle. */
  const wake = useCallback(() => {
    setAwake(true)
    if (hideTimerRef.current) window.clearTimeout(hideTimerRef.current)
    hideTimerRef.current = window.setTimeout(() => {
      hideTimerRef.current = 0
      if (!dragRef.current) setAwake(false)
    }, HIDE_DELAY)
  }, [])

  // The hit area is only 24px tall, so proximity (not hover alone) is what
  // keeps the divider discoverable: moving or tapping near it wakes the handle.
  useEffect(() => {
    const handle = handleRef.current
    const container = handle?.parentElement
    if (!handle || !container) return

    const isNear = (clientY: number) => {
      const rect = handle.getBoundingClientRect()
      return Math.abs(clientY - (rect.top + rect.height / 2)) <= WAKE_DISTANCE
    }
    const onPointerMove = (event: PointerEvent) => {
      if (isNear(event.clientY)) wake()
    }
    const onPointerDown = (event: PointerEvent) => {
      if (isNear(event.clientY)) wake()
    }

    container.addEventListener('pointermove', onPointerMove, { passive: true })
    container.addEventListener('pointerdown', onPointerDown, { passive: true })
    // Announce the divider once when the split appears, then let it roll away.
    wake()
    return () => {
      container.removeEventListener('pointermove', onPointerMove)
      container.removeEventListener('pointerdown', onPointerDown)
      if (hideTimerRef.current) window.clearTimeout(hideTimerRef.current)
    }
  }, [wake])

  useEffect(
    () => () => {
      if (frameRef.current) cancelAnimationFrame(frameRef.current)
      document.body.classList.remove('split-resizing')
    },
    [],
  )

  const scheduleUpdate = () => {
    if (frameRef.current) return
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = 0
      const drag = dragRef.current
      if (!drag) return
      onChange(ratioFromDrag(drag.startRatio, drag.latestY - drag.startY, drag.height))
    })
  }

  const endDrag = (cancelled: boolean, clientY: number) => {
    const drag = dragRef.current
    if (!drag) return
    if (frameRef.current) {
      cancelAnimationFrame(frameRef.current)
      frameRef.current = 0
    }
    dragRef.current = null
    setDragging(false)
    document.body.classList.remove('split-resizing')
    wake()

    // A tap without movement only wakes the handle; it must not nudge a pane.
    if (!drag.moved) return

    // Releasing near an edge snaps that pane fully shut, never leaving a sliver.
    const next = snapSplitRatio(
      ratioFromDrag(drag.startRatio, (cancelled ? drag.latestY : clientY) - drag.startY, drag.height),
    )
    onChange(next)
    onCommit(next)
  }

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return
    const container = event.currentTarget.parentElement
    if (!container) return
    const rect = container.getBoundingClientRect()
    if (rect.height <= 0) return

    event.preventDefault()
    wake()
    // Start from the divider's on-screen position: if a one-second transition
    // is still running, this freezes the visual state instead of jumping to
    // the animation target when the transition is suspended below.
    const handleRect = event.currentTarget.getBoundingClientRect()
    const startRatio = clampSplitRatio(
      ((handleRect.top + handleRect.height / 2 - rect.top) / rect.height) * 100,
    )
    onChange(startRatio)
    try {
      event.currentTarget.setPointerCapture?.(event.pointerId)
    } catch {
      // Synthetic or unsupported pointers cannot be captured; dragging still
      // works while the pointer stays over the divider.
    }
    dragRef.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startRatio,
      moved: false,
      latestY: event.clientY,
      height: rect.height,
    }
    setDragging(true)
    document.body.classList.add('split-resizing')
  }

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    if (!drag.moved && Math.abs(event.clientY - drag.startY) < DRAG_THRESHOLD) return
    drag.moved = true
    drag.latestY = event.clientY
    scheduleUpdate()
  }

  const handlePointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    try {
      event.currentTarget.releasePointerCapture(event.pointerId)
    } catch {
      // Capture may already be released by the browser.
    }
    endDrag(false, event.clientY)
  }

  const handlePointerCancel = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    endDrag(true, drag.latestY)
  }

  const commitRatio = (next: number) => {
    wake()
    onChange(next)
    onCommit(next)
  }

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault()
      commitRatio(clampSplitRatio(ratio + (event.key === 'ArrowUp' ? -5 : 5)))
      return
    }
    if (event.key === 'Home') {
      event.preventDefault()
      commitRatio(MIN_SPLIT_RATIO)
      return
    }
    if (event.key === 'End') {
      event.preventDefault()
      commitRatio(MAX_SPLIT_RATIO)
    }
  }

  const rounded = Math.round(ratio)
  return (
    <div
      ref={handleRef}
      className={`split-handle${dragging ? ' dragging' : ''}${awake ? ' awake' : ''}`}
      style={{ top: `calc(${ratio}% - ${SPLIT_HANDLE_SIZE / 2}px)`, height: SPLIT_HANDLE_SIZE }}
      role="separator"
      aria-orientation="horizontal"
      aria-label="调整编辑区与预览区比例"
      aria-valuemin={MIN_SPLIT_RATIO}
      aria-valuemax={MAX_SPLIT_RATIO}
      aria-valuenow={rounded}
      aria-valuetext={`编辑区 ${rounded}%，预览区 ${100 - rounded}%`}
      tabIndex={0}
      title="拖拽调整比例，拖到边缘可完全收起"
      onFocus={wake}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
      onKeyDown={handleKeyDown}
    />
  )
}
