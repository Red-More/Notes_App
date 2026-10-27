import { useEffect, useRef, useState } from 'react'
import {
  MAX_SPLIT_RATIO,
  MIN_SPLIT_RATIO,
  SPLIT_HANDLE_SIZE,
  clampSplitRatio,
  ratioFromPointer,
  toggleSplitRatio,
} from '../editor/layout'

interface SplitHandleProps {
  ratio: number
  /** Fired continuously while dragging (not persisted). */
  onChange: (ratio: number) => void
  /** Fired once when the drag / click ends (persisted by the parent). */
  onCommit: (ratio: number) => void
}

interface DragState {
  pointerId: number
  startY: number
  moved: boolean
  latestY: number
  top: number
  height: number
}

const DRAG_THRESHOLD = 4

/**
 * Horizontal divider between the editor and preview panes. Drag to resize,
 * tap to flip the dominant pane, arrow keys to nudge the ratio.
 */
export default function SplitHandle({ ratio, onChange, onCommit }: SplitHandleProps) {
  const [dragging, setDragging] = useState(false)
  const dragRef = useRef<DragState | null>(null)
  const frameRef = useRef(0)

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
      onChange(ratioFromPointer(drag.latestY, drag.top, drag.height, SPLIT_HANDLE_SIZE))
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

    if (drag.moved) {
      const next = ratioFromPointer(
        cancelled ? drag.latestY : clientY,
        drag.top,
        drag.height,
        SPLIT_HANDLE_SIZE,
      )
      onChange(next)
      onCommit(next)
      return
    }

    // A cancelled tap (e.g. the OS takes over the gesture) must not toggle.
    if (cancelled) return

    // A tap on the divider flips the dominant pane.
    const next = toggleSplitRatio(ratio)
    onChange(next)
    onCommit(next)
  }

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return
    const container = event.currentTarget.parentElement
    if (!container) return
    const rect = container.getBoundingClientRect()
    if (rect.height <= SPLIT_HANDLE_SIZE) return

    event.preventDefault()
    try {
      event.currentTarget.setPointerCapture?.(event.pointerId)
    } catch {
      // Synthetic or unsupported pointers cannot be captured; dragging still
      // works while the pointer stays over the divider.
    }
    dragRef.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      moved: false,
      latestY: event.clientY,
      top: rect.top,
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

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault()
      const next = clampSplitRatio(ratio + (event.key === 'ArrowUp' ? -5 : 5))
      onChange(next)
      onCommit(next)
      return
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      const next = toggleSplitRatio(ratio)
      onChange(next)
      onCommit(next)
    }
  }

  const rounded = Math.round(ratio)
  return (
    <div
      className={`split-handle ${dragging ? 'dragging' : ''}`}
      style={{ height: SPLIT_HANDLE_SIZE }}
      role="separator"
      aria-orientation="horizontal"
      aria-label="调整编辑区与预览区比例"
      aria-valuemin={MIN_SPLIT_RATIO}
      aria-valuemax={MAX_SPLIT_RATIO}
      aria-valuenow={rounded}
      aria-valuetext={`编辑区 ${rounded}%，预览区 ${100 - rounded}%`}
      tabIndex={0}
      title="拖拽调整比例，点击快速切换"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
      onKeyDown={handleKeyDown}
    />
  )
}
