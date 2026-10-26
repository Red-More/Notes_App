import { useEffect, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
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
}

/** Bottom-sheet style modal dialog. */
export function Modal({ title, onClose, children, footer, headerAction }: ModalProps) {
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
        <div className="modal" onClick={(e) => e.stopPropagation()}>
          <div className="modal-header">
            <span className="modal-title">{title}</span>
            {headerAction ?? (
              <button type="button" className="icon-btn" onClick={onClose} aria-label="关闭">
                <IconClose size={20} />
              </button>
            )}
          </div>
          <div className="modal-body">{children}</div>
          {footer && <div className="modal-footer">{footer}</div>}
        </div>
      </div>
    </OverlayPortal>
  )
}

interface ConfirmProps {
  title: string
  message: string
  confirmText?: string
  danger?: boolean
  onConfirm: () => void
  onCancel: () => void
}

export function ConfirmDialog({
  title,
  message,
  confirmText = '确定',
  danger = false,
  onConfirm,
  onCancel,
}: ConfirmProps) {
  return (
    <OverlayPortal>
      <div className="modal-overlay" onClick={onCancel}>
        <div className="dialog" onClick={(e) => e.stopPropagation()}>
          <div className="dialog-title">{title}</div>
          <div className="dialog-message">{message}</div>
          <div className="dialog-actions">
            <button type="button" className="btn" onClick={onCancel}>
              取消
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
