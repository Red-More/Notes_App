import { useState } from 'react'
import { api } from '../api'
import { formatDueLabel, friendlyError } from '../utils'
import type { Todo } from '../types'
import { Modal } from './ui'
import ReminderPicker from './ReminderPicker'
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
 * Content-only todo editor: the text doubles as the title, no category, and a
 * due time doubles as the reminder switch (set time = remind, clear = mute).
 */
export default function TodoEditor({ todo, initialDue, onClose, onSaved }: Props) {
  const [content, setContent] = useState(todo?.title ?? '')
  const [due, setDue] = useState<string | null>(todo?.dueDate ?? initialDue ?? null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [saving, setSaving] = useState(false)

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
        })
      } else {
        await api.createTodo({ title, dueDate: due, reminder: due != null })
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
    <Modal
      title={todo ? '编辑待办' : '新建待办'}
      onClose={onClose}
      footer={
        <button
          type="button"
          className="btn btn-primary"
          disabled={saving}
          onClick={() => void handleSave()}
        >
          {todo ? '保存' : '创建'}
        </button>
      }
    >
      <div className="form-field">
        <textarea
          className="form-textarea"
          rows={3}
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder="要做的事情…"
          autoFocus
        />
      </div>
      <div className="form-field">
        <span className="form-label">提醒时间</span>
        <div className="due-row">
          <span className={`due-value ${due ? '' : 'empty'}`}>
            {due ? formatDueLabel(due) : '未设置（不提醒）'}
          </span>
          <button type="button" className="btn btn-secondary" onClick={() => setPickerOpen(true)}>
            {due ? '修改' : '设置'}
          </button>
          {due && (
            <button
              type="button"
              className="btn btn-secondary danger-text"
              onClick={() => setDue(null)}
            >
              清除
            </button>
          )}
        </div>
      </div>

      {pickerOpen && (
        <ReminderPicker initial={due} onConfirm={(v) => { setDue(v); setPickerOpen(false) }} onCancel={() => setPickerOpen(false)} />
      )}
    </Modal>
  )
}
