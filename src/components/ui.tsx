import { useEffect, useState, type ReactNode } from 'react'
import { IconClose } from './Icons'

/** Show a transient toast message from anywhere. */
export function toast(msg: string) {
  window.dispatchEvent(new CustomEvent('app-toast', { detail: msg }))
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
}

/** Bottom-sheet style modal dialog. */
export function Modal({ title, onClose, children, footer }: ModalProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-title">{title}</span>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="关闭">
            <IconClose size={20} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>
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
  )
}

interface ActionSheetProps {
  actions: Array<{ text: string; danger?: boolean; onClick: () => void }>
  onCancel: () => void
}

/** Bottom action sheet with a list of options. */
export function ActionSheet({ actions, onCancel }: ActionSheetProps) {
  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="action-sheet" onClick={(e) => e.stopPropagation()}>
        {actions.map((a) => (
          <button
            key={a.text}
            type="button"
            className={`action-sheet-item ${a.danger ? 'danger' : ''}`}
            onClick={() => {
              onCancel()
              a.onClick()
            }}
          >
            {a.text}
          </button>
        ))}
        <button type="button" className="action-sheet-cancel" onClick={onCancel}>
          取消
        </button>
      </div>
    </div>
  )
}
