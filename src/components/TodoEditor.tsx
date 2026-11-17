import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { formatDueLabel, friendlyError } from '../utils'
import type { Todo } from '../types'
import ReminderPicker, { REPEAT_OPTIONS, type RepeatValue } from './ReminderPicker'
import { OverlayPortal } from './ui'
import { IconCalendar, IconClock, IconCollapse, IconExpand } from './Icons'
import { toast } from '../toast'

interface Props {
  /** Existing todo to edit, or null to create one. */
  todo: Todo | null
  /** Pre-filled reminder time (local `YYYY-MM-DDTHH:mm`) for a new todo. */
  initialRemind?: string | null
  onClose: () => void
  onSaved: () => void | Promise<void>
}

/**
 * Compact bottom-sheet todo editor: content only. The text doubles as the
 * title, there is no category, and the reminder time is the only value that
 * notifies (the deadline is tracked separately and has no control here yet).
 * No header or close button — tapping the overlay dismisses it.
 */
export default function TodoEditor({ todo, initialRemind, onClose, onSaved }: Props) {
  const [content, setContent] = useState(todo?.title ?? '')
  // Only the reminder notifies; the deadline is a separate value with no UI yet.
  const [remind, setRemind] = useState<string | null>(todo?.remindAt ?? initialRemind ?? null)
  const [repeat, setRepeat] = useState<RepeatValue>(
    REPEAT_OPTIONS.some((o) => o.value === todo?.repeat)
      ? (todo?.repeat as RepeatValue)
      : 'none',
  )
  const [pickerOpen, setPickerOpen] = useState(false)
  /** Day file the todo belongs to; only editable for an existing todo. */
  const [day, setDay] = useState(todo?.date ?? '')
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
        await api.updateTodo(todo, { title, remindAt: remind, repeat })
        // The day is the file the todo lives in — an explicit move, never a
        // side effect of changing the reminder time.
        if (day && day !== todo.date) await api.moveTodoDate(todo, day)
      } else {
        await api.createTodo({ title, remindAt: remind, repeat })
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
            className={`todo-quick-time ${remind ? 'set' : ''}`}
            onClick={() => setPickerOpen(true)}
          >
            <IconClock size={16} />
            <span>{remind ? formatDueLabel(remind) : '设置提醒'}</span>
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
        {todo && (
          // Day file the entry lives in. Native date input keeps the picker
          // free; changing it moves the entry and keeps its id.
          <label
            className={`todo-quick-date ${day && day !== todo.date ? 'changed' : ''}`}
            title="改变归属日期会把这条待办移动到对应日期的文件"
          >
            <span>
              <IconCalendar size={14} /> 归属日期
            </span>
            <input
              type="date"
              value={day}
              onChange={(e) => setDay(e.target.value)}
              aria-label="归属日期"
            />
          </label>
        )}
      </div>

      {pickerOpen && (
        <ReminderPicker
          initial={remind}
          initialRepeat={repeat}
          onConfirm={(v, rp) => {
            setRemind(v)
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
