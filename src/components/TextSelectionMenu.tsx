import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { OverlayPortal } from './ui'
import { placeSelectionMenu, type MenuAnchor, type MenuPlacement } from '../editor/selectionMenu'

export interface TextMenuItem {
  label: string
  onClick: () => void
  /** Greyed out but still rendered, so the item set never shifts position. */
  disabled?: boolean
}

interface Props {
  /** Selection box (or bare press point) the bubble hangs off. */
  anchor: MenuAnchor
  items: TextMenuItem[]
  onClose: () => void
}

const samePlacement = (a: MenuPlacement | null, b: MenuPlacement) =>
  a !== null && a.left === b.left && a.top === b.top && a.above === b.above

/**
 * Text action bubble anchored to the selection, replacing the bottom sheet.
 *
 * The bubble floats next to the text it acts on, so the press point stays
 * visible while the menu is open. It never takes focus from CodeMirror
 * (`onPointerDown` is cancelled), which keeps the caret, the selection
 * highlight and any in-flight IME composition intact while the actions run.
 */
export default function TextSelectionMenu({ anchor, items, onClose }: Props) {
  const menuRef = useRef<HTMLDivElement>(null)
  const [placement, setPlacement] = useState<MenuPlacement | null>(null)

  // The bubble measures itself: its width depends on the item labels, and the
  // page cannot know that before it renders.
  const measure = useCallback(() => {
    const menu = menuRef.current
    if (!menu) return
    const rect = menu.getBoundingClientRect()
    // A soft keyboard can shrink the visual viewport without moving the layout
    // viewport, so clamp inside the visible area and add its offset back to get
    // fixed-position coordinates.
    const vv = window.visualViewport
    const placed = placeSelectionMenu(
      anchor,
      { width: rect.width, height: rect.height },
      { width: vv?.width ?? window.innerWidth, height: vv?.height ?? window.innerHeight },
    )
    const next = { ...placed, left: placed.left + (vv?.offsetLeft ?? 0), top: placed.top + (vv?.offsetTop ?? 0) }
    setPlacement((current) => (samePlacement(current, next) ? current : next))
  }, [anchor])

  useLayoutEffect(() => {
    measure()
    const vv = window.visualViewport
    vv?.addEventListener('resize', measure)
    window.addEventListener('resize', measure)
    return () => {
      vv?.removeEventListener('resize', measure)
      window.removeEventListener('resize', measure)
    }
  }, [measure])

  useEffect(() => {
    // The bubble never holds focus, so Escape has to be caught globally.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  const style: CSSProperties = {
    left: placement?.left ?? 0,
    top: placement?.top ?? 0,
    // Measuring happens in a layout effect, before the first paint, but keep it
    // invisible until the offsets are known so it never flashes at the origin.
    visibility: placement ? 'visible' : 'hidden',
  }

  return (
    <OverlayPortal>
      <div className="text-menu-backdrop" onPointerDown={onClose} />
      <div
        ref={menuRef}
        className={`text-menu ${placement?.above ? '' : 'below'}`}
        style={style}
        role="menu"
        aria-label="文本操作"
      >
        {items.map((item) => (
          <button
            key={item.label}
            type="button"
            role="menuitem"
            className="text-menu-item"
            disabled={item.disabled}
            // Keep the editor focused (and its selection visible) on press.
            onPointerDown={(e) => e.preventDefault()}
            onClick={() => {
              onClose()
              item.onClick()
            }}
          >
            {item.label}
          </button>
        ))}
      </div>
    </OverlayPortal>
  )
}
