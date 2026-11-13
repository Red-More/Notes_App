import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { formatDueLabel, friendlyError } from '../utils'
import type { Todo } from '../types'
import ReminderPicker, { REPEAT_OPTIONS, type RepeatValue } from './ReminderPicker'
import { OverlayPortal } from './ui'
import { IconClock, IconCollapse, IconExpand } from './Icons'
import { toast } from '../toast'

interface Props {
  /** Existing todo to edit, or null to create one. */
  todo: Todo | null
  /** Pre-filled due date (local `YYYY-MM-DDTHH:mm`) for a new todo. */
  initialDue?: string | null
  onClose: () => void
  onSaved: () => void | Promise<void>
}

/**
 * Compact bottom-sheet todo editor: content only. The text doubles as the
 * title, there is no category, and a due time doubles as the reminder switch
 * (set time = remind, clear = mute). No header or close button — tapping the
 * overlay dismisses it.
 */
export default function TodoEditor({ todo, initialDue, onClose, onSaved }: Props) {
  const [content, setContent] = useState(todo?.title ?? '')
  const [due, setDue] = useState<string | null>(todo?.dueDate ?? initialDue ?? null)
  const [repeat, setRepeat] = useState<RepeatValue>(
    REPEAT_OPTIONS.some((o) => o.value === todo?.repeat)
      ? (todo!.repeat as RepeatValue)
      : 'none',
  )
  const [pickerOpen, setPickerOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  // Elastic height: grow with the content in compact mode (capped), take most
  // of the sheet when expanded via the toggle button.
  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    if (expanded) {
      el.style.height = '38vh'
    } else {
      el.style.height = 'auto'
      el.style.height = `${Math.min(el.scrollHeight, 132)}px`
    }
  }, [content, expanded])

  const handleSave = async () => {
    const title = content.trim()
    if (!title) {
      toast('请输入待办内容')
      return
    }
    setSaving(true)
    try {
      if (todo) {
        await api.updateTodo({
          id: todo.id,
          title,
          // Preserve the legacy category field; the UI no longer exposes it.
          category: todo.category,
          dueDate: due,
          // Reminder follows the due time; no separate switch anymore.
          reminder: due != null,
          repeat,
        })
      } else {
        await api.createTodo({ title, dueDate: due, reminder: due != null, repeat })
      }
      toast(todo ? '已保存' : '待办已创建')
      await onSaved()
      onClose()
    } catch (e) {
      console.error(e)
      toast(friendlyError(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    // Portal into the overlay layer: inside the pager's transformed stacking
    // context the tabbar would paint over this card and swallow outside taps.
    <OverlayPortal>
      <div className="modal-overlay" onClick={onClose}>
      <div className="todo-quick" onClick={(e) => e.stopPropagation()}>
        <div className="todo-quick-inputwrap">
          <textarea
            ref={inputRef}
            className="todo-quick-input"
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder="要做的事情…"
            autoFocus
          />
          <button
            type="button"
            className="todo-quick-expand"
            onClick={() => setExpanded((v) => !v)}
            aria-label={expanded ? '收起输入框' : '展开输入框'}
          >
            {expanded ? <IconCollapse size={15} /> : <IconExpand size={15} />}
          </button>
        </div>
        <div className="todo-quick-actions">
          <button
            type="button"
            className={`todo-quick-time ${due ? 'set' : ''}`}
            onClick={() => setPickerOpen(true)}
          >
            <IconClock size={16} />
            <span>{due ? formatDueLabel(due) : '设置提醒'}</span>
          </button>
          <button
            type="button"
            className="todo-quick-save"
            disabled={saving}
            onClick={() => void handleSave()}
          >
            {todo ? '保存' : '创建'}
          </button>
        </div>
      </div>

      {pickerOpen && (
        <ReminderPicker
          initial={due}
          initialRepeat={repeat}
          onConfirm={(v, rp) => {
            setDue(v)
            setRepeat(rp)
            setPickerOpen(false)
          }}
          onCancel={() => setPickerOpen(false)}
        />
      )}
      </div>
    </OverlayPortal>
  )
}
