import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { diffLines, type DiffRow } from '../utils'
import { IconClose } from './Icons'

/**
 * Renders overlays into the layer created by main.tsx. The pager track is a
 * transformed stacking context, so overlays nested inside a page would paint
 * beneath the tabbar, which then wins the hit test and swallows their taps.
 */
export function OverlayPortal({ children }: { children: ReactNode }) {
  const layer = document.getElementById('overlay-layer')
  return layer ? createPortal(children, layer) : null
}

/** Global toast renderer; mount once in App. */
export function ToastHost() {
  const [msg, setMsg] = useState<string | null>(null)
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const handler = (e: Event) => {
      setMsg((e as CustomEvent<string>).detail)
      clearTimeout(timer)
      timer = setTimeout(() => setMsg(null), 2200)
    }
    window.addEventListener('app-toast', handler)
    return () => {
      window.removeEventListener('app-toast', handler)
      clearTimeout(timer)
    }
  }, [])
  if (!msg) return null
  return <div className="toast">{msg}</div>
}

interface ModalProps {
  title: string
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  /** Optional element rendered in the header's right side, replacing the close button. */
  headerAction?: ReactNode
  /** Wider sheet for reading-heavy content such as diffs and file bodies. */
  wide?: boolean
  /** Let the children own the scroll area instead of the sheet body. */
  fill?: boolean
  /** Extra class hook for fixed-height presets or per-surface overrides. */
  className?: string
}

/** Bottom-sheet style modal dialog. */
export function Modal({
  title,
  onClose,
  children,
  footer,
  headerAction,
  wide = false,
  fill = false,
  className,
}: ModalProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <OverlayPortal>
      <div className="modal-overlay" onClick={onClose}>
        <div
          className={`modal ${wide ? 'modal-wide' : ''} ${className ?? ''}`}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="modal-header">
            <span className="modal-title">{title}</span>
            {headerAction ?? (
              <button type="button" className="icon-btn" onClick={onClose} aria-label="关闭">
                <IconClose size={20} />
              </button>
            )}
          </div>
          <div className={`modal-body ${fill ? 'modal-body-fill' : ''}`}>{children}</div>
          {footer && <div className="modal-footer">{footer}</div>}
        </div>
      </div>
    </OverlayPortal>
  )
}

interface DiffViewProps {
  oldText: string
  newText: string
}

/** Added/removed counters rendered above a diff body. */
export function DiffStats({ rows }: { rows: DiffRow[] }) {
  const added = rows.filter((row) => row.type === 'add').length
  const removed = rows.filter((row) => row.type === 'del').length
  return (
    <div className="diff-stats">
      <span className="add">+{added} 行新增</span>
      <span className="del">-{removed} 行删除</span>
    </div>
  )
}

/** Diff rows only; the caller owns the surrounding scroll viewport. */
export function DiffBody({ rows }: { rows: DiffRow[] }) {
  return (
    <div className="diff-body">
      {rows.map((row, index) => (
        <div key={index} className={`diff-row ${row.type}`}>
          <span className="no">{row.type === 'add' ? row.newNo : (row.oldNo ?? '')}</span>
          <span>{row.text || ' '}</span>
        </div>
      ))}
    </div>
  )
}

/** Line diff shared by note version compare and chat file changes. */
export function DiffView({ oldText, newText }: DiffViewProps) {
  const rows = useMemo(() => diffLines(oldText, newText), [oldText, newText])
  return (
    <>
      <DiffStats rows={rows} />
      <DiffBody rows={rows} />
    </>
  )
}

interface ActionSheetItem {
  label: string
  onClick: () => void
  danger?: boolean
}

interface ActionSheetProps {
  title?: string
  items: ActionSheetItem[]
  onClose: () => void
}

/** Bottom action sheet with a cancel row; the backdrop also dismisses it. */
export function ActionSheet({ title, items, onClose }: ActionSheetProps) {
  return (
    <OverlayPortal>
      <div className="modal-overlay" onClick={onClose}>
        <div
          className="action-sheet"
          role="dialog"
          aria-modal="true"
          aria-label={title}
          onClick={(e) => e.stopPropagation()}
        >
          {title && <div className="action-sheet-title">{title}</div>}
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              className={`action-sheet-item ${item.danger ? 'danger' : ''}`}
              onClick={item.onClick}
            >
              {item.label}
            </button>
          ))}
          <button type="button" className="action-sheet-cancel" onClick={onClose}>
            取消
          </button>
        </div>
      </div>
    </OverlayPortal>
  )
}

interface ConfirmProps {
  title: string
  message: string
  confirmText?: string
  cancelText?: string
  danger?: boolean
  /** Optional glyph rendered in a tinted badge above the title. */
  icon?: ReactNode
  /** Optional rich row below the message, e.g. a link address card. */
  detail?: ReactNode
  onConfirm: () => void
  onCancel: () => void
}

export function ConfirmDialog({
  title,
  message,
  confirmText = '确定',
  cancelText = '取消',
  danger = false,
  icon,
  detail,
  onConfirm,
  onCancel,
}: ConfirmProps) {
  const titleId = useId()
  const dialogRef = useRef<HTMLDivElement>(null)
  const cancelRef = useRef(onCancel)

  useEffect(() => {
    cancelRef.current = onCancel
  }, [onCancel])

  // Capture phase so Escape only dismisses the top-most dialog.
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    dialogRef.current?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      cancelRef.current()
    }
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      previous?.focus?.()
    }
  }, [])

  return (
    <OverlayPortal>
      <div className="modal-overlay dialog-overlay" onClick={onCancel}>
        <div
          ref={dialogRef}
          className="dialog"
          role="alertdialog"
          aria-modal="true"
          aria-labelledby={titleId}
          tabIndex={-1}
          onClick={(event) => event.stopPropagation()}
        >
          <div className="dialog-header">
            {icon ? <div className="dialog-icon">{icon}</div> : null}
            <div className="dialog-title" id={titleId}>
              {title}
            </div>
          </div>
          <div className="dialog-message">{message}</div>
          {detail ? <div className="dialog-detail">{detail}</div> : null}
          <div className="dialog-actions">
            <button type="button" className="btn btn-plain" onClick={onCancel}>
              {cancelText}
            </button>
            <button
              type="button"
              className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`}
              onClick={onConfirm}
            >
              {confirmText}
            </button>
          </div>
        </div>
      </div>
    </OverlayPortal>
  )
}
