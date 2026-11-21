import { useEffect, useRef, useState } from 'react'
import type { Folder } from '../types'
import { hapticTap } from '../system/haptics'

interface Props {
  /** Direct child folders of the current scope. */
  folders: Folder[]
  activeId: number | null
  onSelect: (id: number) => void
  /** Persist the new display order; called once after a drag finishes. */
  onReorder: (ids: number[]) => void
}

const HOLD_MS = 300
const SLOP = 8

/**
 * Child-folder chips with long-press drag reordering.
 *
 * The local order updates while dragging (real-time feedback); the parent
 * persists it on pointer-up. Short taps keep selecting the folder.
 */
export default function FolderChips({ folders, activeId, onSelect, onReorder }: Props) {
  const [items, setItems] = useState(folders)
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const refs = useRef<Array<HTMLButtonElement | null>>([])
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const start = useRef({ x: 0, y: 0 })
  const suppressClick = useRef(false)
  const reordered = useRef(false)

  // Refresh from the server unless a drag is in progress.
  useEffect(() => {
    if (dragIndex == null) setItems(folders)
  }, [folders, dragIndex])

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    [],
  )

  const clearTimer = () => {
    if (timer.current) {
      clearTimeout(timer.current)
      timer.current = null
    }
  }

  const onPointerDown = (e: React.PointerEvent<HTMLButtonElement>, index: number) => {
    // Reordering is a touch long-press gesture; a mouse drag is browser-like
    // and made chips feel freely movable, so it never arms the timer.
    if (e.pointerType === 'mouse') return
    clearTimer()
    start.current = { x: e.clientX, y: e.clientY }
    suppressClick.current = false
    reordered.current = false
    const element = e.currentTarget
    const pointerId = e.pointerId
    timer.current = setTimeout(() => {
      timer.current = null
      suppressClick.current = true
      hapticTap()
      setDragIndex(index)
      try {
        element.setPointerCapture(pointerId)
      } catch {
        // Synthetic pointers cannot be captured; dragging still reorders.
      }
    }, HOLD_MS)
  }

  const onPointerMove = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (dragIndex == null) {
      if (
        Math.abs(e.clientX - start.current.x) > SLOP ||
        Math.abs(e.clientY - start.current.y) > SLOP
      ) {
        clearTimer()
      }
      return
    }
    e.preventDefault()
    let target = dragIndex
    // Bound to the current items: stale refs from removed chips report a zero
    // rect and would otherwise capture the pointer position.
    for (let index = 0; index < items.length; index += 1) {
      const element = refs.current[index]
      if (!element) continue
      const rect = element.getBoundingClientRect()
      if (e.clientX > rect.left + rect.width / 2) target = index
    }
    if (target !== dragIndex) {
      reordered.current = true
      setItems((prev) => {
        const next = [...prev]
        const [moved] = next.splice(dragIndex, 1)
        next.splice(target, 0, moved)
        return next
      })
      setDragIndex(target)
    }
  }

  const finishDrag = () => {
    clearTimer()
    if (dragIndex == null) return
    const ids = items.map((folder) => folder.id)
    setDragIndex(null)
    if (reordered.current) onReorder(ids)
    // Drop the click that follows a completed long-press. The timeout also
    // covers touch sequences where no synthetic click is dispatched.
    if (suppressClick.current) {
      setTimeout(() => {
        suppressClick.current = false
      }, 300)
    }
  }

  return (
    <>
      {items.map((folder, index) => (
        <button
          key={folder.id}
          ref={(element) => {
            refs.current[index] = element
          }}
          type="button"
          className={`chip ${activeId === folder.id ? 'active' : ''} ${
            dragIndex === index ? 'dragging' : ''
          }`}
          onClick={() => {
            if (suppressClick.current) {
              suppressClick.current = false
              return
            }
            onSelect(folder.id)
          }}
          onPointerDown={(e) => onPointerDown(e, index)}
          onPointerMove={onPointerMove}
          onPointerUp={finishDrag}
          onPointerCancel={finishDrag}
          onContextMenu={(e) => e.preventDefault()}
        >
          {folder.name}
        </button>
      ))}
    </>
  )
}
