import { useCallback, useEffect, useState } from 'react'
import { api } from '../../api'
import { useDebouncedSearch } from '../../hooks'
import { parseDbTime } from '../../utils'
import type { Todo } from '../../types'
import { ConfirmDialog, Modal, toast } from '../../components/ui'
import { IconBell, IconCheck, IconTodo, IconTrash } from '../../components/Icons'
import PageHeader from '../../components/PageHeader'
import FAB from '../../components/FAB'
import EmptyState from '../../components/EmptyState'
import ChipRow from '../../components/ChipRow'

const PRESET_CATEGORIES = ['默认', '工作', '生活', '学习']

/** Format a due date as "M月d日 HH:mm" (or with year when not current year). */
function formatDue(s: string): string {
  const d = parseDbTime(s.replace('T', ' '))
  const p = (n: number) => String(n).padStart(2, '0')
  const hm = `${p(d.getHours())}:${p(d.getMinutes())}`
  if (d.getFullYear() === new Date().getFullYear()) {
    return `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`
  }
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`
}

interface TodoForm {
  title: string
  category: string
  dueDate: string
  reminder: boolean
}

const EMPTY_FORM: TodoForm = { title: '', category: '默认', dueDate: '', reminder: false }

export default function TodoPage() {
  const [todos, setTodos] = useState<Todo[]>([])
  const [searchInput, setSearchInput, query] = useDebouncedSearch()
  const [category, setCategory] = useState('全部')
  const [editOpen, setEditOpen] = useState(false)
  const [editing, setEditing] = useState<Todo | null>(null)
  const [form, setForm] = useState<TodoForm>(EMPTY_FORM)
  const [deleteConfirm, setDeleteConfirm] = useState<Todo | null>(null)

  const load = useCallback(async () => {
    try {
      setTodos(await api.listTodos(query || undefined))
    } catch (e) {
      console.error('加载待办失败', e)
    }
  }, [query])

  useEffect(() => {
    void load()
  }, [load])

  const categories = [
    '全部',
    ...PRESET_CATEGORIES,
    ...[...new Set(todos.map((t) => t.category))]
      .filter((c) => !PRESET_CATEGORIES.includes(c))
      .sort(),
  ]

  const visible = todos.filter((t) => category === '全部' || t.category === category)
  const active = visible.filter((t) => t.isCompleted === 0)
  const done = visible.filter((t) => t.isCompleted === 1)

  const openCreate = () => {
    setEditing(null)
    setForm(EMPTY_FORM)
    setEditOpen(true)
  }

  const openEdit = (t: Todo) => {
    setEditing(t)
    setForm({
      title: t.title,
      category: t.category,
      dueDate: t.dueDate ?? '',
      reminder: t.reminder === 1,
    })
    setEditOpen(true)
  }

  const handleSave = async () => {
    const title = form.title.trim()
    if (!title) {
      toast('请输入待办标题')
      return
    }
    try {
      const params = {
        title,
        category: form.category,
        dueDate: form.dueDate || null,
        reminder: form.reminder,
      }
      if (editing) {
        await api.updateTodo({ id: editing.id, ...params })
      } else {
        await api.createTodo(params)
      }
      setEditOpen(false)
      toast(editing ? '已保存' : '待办已创建')
      await load()
    } catch (e) {
      toast(String(e))
    }
  }

  const handleToggle = async (t: Todo) => {
    try {
      await api.toggleTodo(t.id)
      await load()
    } catch (e) {
      console.error(e)
      toast('操作失败')
    }
  }

  const handleDelete = async () => {
    const target = deleteConfirm
    setDeleteConfirm(null)
    if (!target) return
    try {
      await api.deleteTodo(target.id)
      toast('已删除')
      await load()
    } catch (e) {
      console.error(e)
      toast('删除失败')
    }
  }

  return (
    <div className="page">
      <PageHeader
        title="待办"
        search={{ placeholder: '搜索待办', value: searchInput, onChange: setSearchInput }}
      />

      <ChipRow
        items={categories.map((c) => ({ key: c, label: c }))}
        value={category}
        onChange={setCategory}
      />

      <div className="page-scroll">
        {visible.length === 0 && (
          <EmptyState
            icon={<IconTodo size={44} />}
            text={query || category !== '全部' ? '没有匹配的待办' : '还没有待办，点击 + 创建'}
          />
        )}

        {active.length > 0 && <div className="section-title">进行中 · {active.length}</div>}
        {active.map((t) => (
          <div key={t.id} className="todo-row" onClick={() => openEdit(t)}>
            <button
              type="button"
              className="todo-check"
              aria-label="完成"
              onClick={(e) => {
                e.stopPropagation()
                void handleToggle(t)
              }}
            />
            <div className="todo-main">
              <div className="todo-title">{t.title}</div>
              <div className="todo-meta">
                <span className="chip mini">{t.category}</span>
                {t.dueDate && <span>{formatDue(t.dueDate)}</span>}
                {t.reminder === 1 && (
                  <span className="bell">
                    <IconBell size={12} />
                  </span>
                )}
              </div>
            </div>
            <button
              type="button"
              className="icon-btn"
              aria-label="删除"
              onClick={(e) => {
                e.stopPropagation()
                setDeleteConfirm(t)
              }}
            >
              <IconTrash size={17} />
            </button>
          </div>
        ))}

        {done.length > 0 && <div className="section-title">已完成 · {done.length}</div>}
        {done.map((t) => (
          <div key={t.id} className="todo-row done" onClick={() => openEdit(t)}>
            <button
              type="button"
              className="todo-check"
              aria-label="取消完成"
              onClick={(e) => {
                e.stopPropagation()
                void handleToggle(t)
              }}
            >
              <IconCheck size={14} />
            </button>
            <div className="todo-main">
              <div className="todo-title">{t.title}</div>
              <div className="todo-meta">
                <span className="chip mini">{t.category}</span>
              </div>
            </div>
            <button
              type="button"
              className="icon-btn"
              aria-label="删除"
              onClick={(e) => {
                e.stopPropagation()
                setDeleteConfirm(t)
              }}
            >
              <IconTrash size={17} />
            </button>
          </div>
        ))}
      </div>

      <FAB label="新建待办" onClick={openCreate} />

      {deleteConfirm && (
        <ConfirmDialog
          title="删除待办"
          message={`确定删除"${deleteConfirm.title}"吗？`}
          confirmText="删除"
          danger
          onConfirm={() => void handleDelete()}
          onCancel={() => setDeleteConfirm(null)}
        />
      )}

      {editOpen && (
        <Modal
          title={editing ? '编辑待办' : '新建待办'}
          onClose={() => setEditOpen(false)}
          footer={
            <button type="button" className="btn btn-primary" onClick={() => void handleSave()}>
              {editing ? '保存' : '创建'}
            </button>
          }
        >
          <div className="form-field">
            <label className="form-label" htmlFor="todo-title">
              标题
            </label>
            <input
              id="todo-title"
              className="form-input"
              value={form.title}
              onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
              placeholder="要做的事情"
            />
          </div>
          <div className="form-field">
            <span className="form-label">分类</span>
            <ChipRow
              className="modal"
              items={[...new Set([...PRESET_CATEGORIES, form.category])].map((c) => ({
                key: c,
                label: c,
              }))}
              value={form.category}
              onChange={(c) => setForm((f) => ({ ...f, category: c }))}
            />
          </div>
          <div className="form-field">
            <label className="form-label" htmlFor="todo-due">
              截止时间（可选）
            </label>
            <input
              id="todo-due"
              type="datetime-local"
              className="form-input"
              value={form.dueDate}
              onChange={(e) => setForm((f) => ({ ...f, dueDate: e.target.value }))}
            />
          </div>
          <div className="form-field">
            <label className="form-label" htmlFor="todo-reminder" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input
                id="todo-reminder"
                type="checkbox"
                checked={form.reminder}
                onChange={(e) => setForm((f) => ({ ...f, reminder: e.target.checked }))}
                style={{ width: 17, height: 17, accentColor: '#ff7a1a' }}
              />
              开启提醒
            </label>
          </div>
        </Modal>
      )}
    </div>
  )
}
