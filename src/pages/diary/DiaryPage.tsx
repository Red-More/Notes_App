import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, docApi } from '../../api'
import { dateStr, formatDueLabel, friendlyError, monthStr, parseDbTime } from '../../utils'
import type { Note, Todo } from '../../types'
import { toast } from '../../toast'
import {
  IconCalendar,
  IconChevronLeft,
  IconChevronRight,
  IconCheck,
  IconSettings,
} from '../../components/Icons'
import PageHeader from '../../components/PageHeader'
import FAB from '../../components/FAB'
import TodoEditor from '../../components/TodoEditor'

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六']

interface Props {
  isActive: boolean
  version: number
  onOpenSettings: () => void
  /** Opens the shared note editor bound to this diary day (lazy-created). */
  onOpenDiary: (date: string, noteId: number | null) => void
}

export default function DiaryPage({ isActive, version, onOpenSettings, onOpenDiary }: Props) {
  const [viewMonth, setViewMonth] = useState(() => new Date())
  const [selectedDate, setSelectedDate] = useState(() => dateStr(new Date()))
  const [entry, setEntry] = useState<Note | null>(null)
  const [todos, setTodos] = useState<Todo[]>([])
  /** Days of the viewed month that already have a diary (calendar dot). */
  const [diaryDates, setDiaryDates] = useState<Set<string>>(new Set())
  const [editTodo, setEditTodo] = useState<Todo | null>(null)
  const [createTodoOpen, setCreateTodoOpen] = useState(false)
  const [loading, setLoading] = useState(true)

  const scrollRef = useRef<HTMLDivElement>(null)

  const load = useCallback(async () => {
    try {
      const [diaryEntry, todoList, monthDocs] = await Promise.all([
        api.getDiary(selectedDate),
        api.listTodos(),
        docApi.list({ kind: 'diary', month: monthStr(viewMonth), includeContent: false }),
      ])
      setEntry(diaryEntry)
      setTodos(todoList)
      setDiaryDates(new Set(monthDocs.map((doc) => (doc.fields.date as string)?.slice(0, 10) ?? doc.updatedAt.slice(0, 10))))
    } catch (e) {
      console.error('加载日记失败', e)
      toast(friendlyError(e))
    } finally {
      setLoading(false)
    }
  }, [selectedDate, viewMonth])

  // Refresh when the tab becomes active again, or after the editor closes.
  useEffect(() => {
    if (isActive) void load()
  }, [isActive, load, version])

  const changeMonth = (delta: number) => {
    setViewMonth((d) => new Date(d.getFullYear(), d.getMonth() + delta, 1))
  }

  const goToday = () => {
    const now = new Date()
    setViewMonth(new Date(now.getFullYear(), now.getMonth(), 1))
    setSelectedDate(dateStr(now))
  }

  // Calendar grid: leading empty cells + all days of the month.
  const days = useMemo(() => {
    const y = viewMonth.getFullYear()
    const m = viewMonth.getMonth()
    const firstWeekday = new Date(y, m, 1).getDay()
    const daysInMonth = new Date(y, m + 1, 0).getDate()
    return Array.from({ length: firstWeekday + daysInMonth }, (_, i) =>
      i < firstWeekday ? null : dateStr(new Date(y, m, i - firstWeekday + 1)),
    )
  }, [viewMonth])

  /** Todos scheduled on the selected day, sorted by time. Deadline wins. */
  const dayTodos = useMemo(() => {
    const when = (t: Todo) => t.dueDate ?? t.remindAt ?? ''
    return todos
      .filter((t) => when(t).slice(0, 10) === selectedDate)
      .sort((a, b) => when(a).localeCompare(when(b)))
  }, [todos, selectedDate])

  const today = dateStr(new Date())
  const now = Date.now()

  const handleToggle = async (t: Todo) => {
    try {
      await api.toggleTodo(t)
      await load()
    } catch (e) {
      console.error(e)
      toast(friendlyError(e))
    }
  }

  const monthLabel = `${viewMonth.getFullYear()}年${viewMonth.getMonth() + 1}月`
  const dayLabel = `${Number(selectedDate.slice(5, 7))}月${Number(selectedDate.slice(8))}日`

  return (
    <div className="page">
      <PageHeader
        title="日记"
        actions={[{ icon: <IconSettings size={22} />, label: '设置', onClick: onOpenSettings }]}
      />

      <div style={{ padding: '0 14px' }}>
        <div className="cal-header">
          <button
            type="button"
            className="icon-btn"
            onClick={() => changeMonth(-1)}
            aria-label="上个月"
          >
            <IconChevronLeft size={20} />
          </button>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span className="cal-title">{monthLabel}</span>
            <button type="button" className="chip" onClick={goToday}>
              今天
            </button>
          </div>
          <button
            type="button"
            className="icon-btn"
            onClick={() => changeMonth(1)}
            aria-label="下个月"
          >
            <IconChevronRight size={20} />
          </button>
        </div>

        <div className="cal-weekdays">
          {WEEKDAYS.map((w) => (
            <span key={w}>{w}</span>
          ))}
        </div>
        <div className="cal-grid">
          {days.map((d, i) =>
            d ? (
              <button
                key={d}
                type="button"
                className={`cal-cell ${d === today ? 'today' : ''} ${d === selectedDate ? 'selected' : ''}`}
                onClick={() => setSelectedDate(d)}
              >
                {Number(d.slice(8))}
                {(diaryDates.has(d) || dayTodos.some((t) => (t.dueDate ?? '').startsWith(d))) && (
                  <span className="cal-dot" />
                )}
              </button>
            ) : (
              <span key={`empty-${i}`} className="cal-cell empty" />
            ),
          )}
        </div>
      </div>

      <div className="page-scroll" ref={scrollRef} style={{ paddingTop: 18 }}>
        <div className="section-title">
          {selectedDate === today ? '今天' : dayLabel} · {entry ? '有日记' : '无日记'} ·{' '}
          {dayTodos.length} 个待办
        </div>
        {loading ? (
          <div className="list-loading">加载中…</div>
        ) : (
          <>
            {/* Diary of the selected day; empty state invites writing one. */}
            {entry ? (
              <div
                className="diary-entry-card"
                onClick={() => onOpenDiary(selectedDate, entry.id)}
              >
                <div className="diary-entry-title">
                  <IconCalendar size={15} />
                  <span>{entry.title}</span>
                </div>
                <div className="diary-entry-preview">
                  {entry.content.trim() ? entry.content.slice(0, 120) : '（空）'}
                </div>
              </div>
            ) : (
              <div
                className="diary-entry-card empty"
                onClick={() => onOpenDiary(selectedDate, null)}
              >
                <div className="diary-entry-title">
                  <IconCalendar size={15} />
                  <span>{dayLabel}还没有日记，点击写一篇</span>
                </div>
              </div>
            )}

            {/* Todos due that day: title, check state, due time, overdue flag. */}
            {dayTodos.length > 0 && (
              <div className="section-title">当日待办 · {dayTodos.length}</div>
            )}
            {dayTodos.map((t) => {
              const overdue =
                t.isCompleted === 0 && t.dueDate != null && parseDbTime(t.dueDate).getTime() < now
              return (
                <div key={t.id} className={`todo-row ${t.isCompleted === 1 ? 'done' : ''}`}>
                  <button
                    type="button"
                    className="todo-check"
                    aria-label="完成"
                    onClick={(e) => {
                      e.stopPropagation()
                      void handleToggle(t)
                    }}
                  >
                    {t.isCompleted === 1 && <IconCheck size={14} />}
                  </button>
                  <div className="todo-main" onClick={() => setEditTodo(t)}>
                    <div className="todo-title">{t.title}</div>
                    <div className="todo-meta">
                      {t.dueDate && (
                        <span className={overdue ? 'overdue' : ''}>{formatDueLabel(t.dueDate)}</span>
                      )}
                      {overdue && <span className="overdue-badge">已过期</span>}
                    </div>
                  </div>
                </div>
              )
            })}
            {dayTodos.length === 0 && (
              <div
                className="todo-row virtual-add"
                onClick={() => setCreateTodoOpen(true)}
              >
                <div className="todo-main">
                  <div className="todo-title add-hint">+ 当日待办（设置提醒时间后归入此日）</div>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      <FAB
        label={entry ? '编辑日记' : '写日记'}
        onClick={() => onOpenDiary(selectedDate, entry?.id ?? null)}
      />

      {editTodo && (
        <TodoEditor
          todo={editTodo}
          onClose={() => setEditTodo(null)}
          onSaved={load}
        />
      )}
      {createTodoOpen && (
        <TodoEditor
          todo={null}
          initialRemind={`${selectedDate}T09:00`}
          onClose={() => setCreateTodoOpen(false)}
          onSaved={load}
        />
      )}
    </div>
  )
}
