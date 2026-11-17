import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../../api'
import { useCollapsibleHeader, useDebouncedSearch, useElasticOverscroll } from '../../hooks'
import { formatDueLabel, friendlyError, parseDbTime } from '../../utils'
import type { Todo } from '../../types'
import { ConfirmDialog } from '../../components/ui'
import { toast } from '../../toast'
import { IconCheck, IconPin, IconSettings, IconTodo, IconTrash } from '../../components/Icons'
import PageHeader from '../../components/PageHeader'
import FAB from '../../components/FAB'
import EmptyState from '../../components/EmptyState'
import TodoEditor from '../../components/TodoEditor'

/** Items rendered per batch before the sentinel triggers the next one. */
const PAGE = 50

interface Props {
  isActive: boolean
  onOpenSettings: () => void
}

export default function TodoPage({ isActive, onOpenSettings }: Props) {
  const [todos, setTodos] = useState<Todo[]>([])
  const [searchInput, setSearchInput, query] = useDebouncedSearch()
  const [editOpen, setEditOpen] = useState(false)
  const [editing, setEditing] = useState<Todo | null>(null)
  const [deleteConfirm, setDeleteConfirm] = useState<Todo | null>(null)
  const [loading, setLoading] = useState(true)
  const [visible, setVisible] = useState(PAGE)

  const sentinelRef = useRef<HTMLDivElement>(null)
  // Scroll-linked collapsing header (large title + search bar).
  const { largeTitleRef, searchWrapRef, scrollRef, contentShiftRef, scrollEl } =
    useCollapsibleHeader()
  // Same elastic overscroll as the notes page (no pull-to-refresh here).
  const { pullDist, springing } = useElasticOverscroll(scrollEl)

  const load = useCallback(async () => {
    try {
      setTodos(await api.listTodos(query || undefined))
    } catch (e) {
      console.error('加载待办失败', e)
      toast(friendlyError(e))
    } finally {
      setLoading(false)
    }
  }, [query])

  // Refresh data when the page becomes active again (stays mounted in the pager).
  const prevActiveRef = useRef(isActive)
  useEffect(() => {
    const wasActive = prevActiveRef.current
    prevActiveRef.current = isActive
    if (isActive && !wasActive) void load()
  }, [isActive, load])

  useEffect(() => {
    let cancelled = false
    const run = async () => {
      try {
        const todos = await api.listTodos(query || undefined)
        if (!cancelled) setTodos(todos)
        if (!cancelled) setVisible(PAGE)
      } catch (e) {
        console.error('加载待办失败', e)
        if (!cancelled) toast(friendlyError(e))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void run()
    return () => {
      cancelled = true
    }
  }, [query])

  const filtered = todos.filter(
    (t) => !query || t.title.includes(query),
  )
  const now = Date.now()
  const active = filtered.filter((t) => t.isCompleted === 0)
  const done = filtered.filter((t) => t.isCompleted === 1)

  // Grow the rendered slice when the sentinel scrolls into view.
  const hasMore = visible < active.length + done.length
  useEffect(() => {
    const el = sentinelRef.current
    if (!el) return
    const io = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting) setVisible((v) => v + PAGE)
    })
    io.observe(el)
    return () => io.disconnect()
  }, [active.length, done.length, hasMore])

  const handleToggle = async (t: Todo) => {
    try {
      await api.toggleTodo(t)
      await load()
    } catch (e) {
      console.error(e)
      toast(friendlyError(e))
    }
  }

  const handleTogglePin = async (t: Todo) => {
    try {
      await api.setTodoPinned(t, t.isPinned === 0)
      await load()
    } catch (e) {
      console.error(e)
      toast(friendlyError(e))
    }
  }

  const handleDelete = async () => {
    const target = deleteConfirm
    setDeleteConfirm(null)
    if (!target) return
    try {
      await api.deleteTodo(target)
      toast('已删除')
      await load()
    } catch (e) {
      console.error(e)
      toast(friendlyError(e))
    }
  }

  const rowMeta = (t: Todo) => {
    // Deadline first: it owns the "overdue" semantics.
    if (t.dueDate) {
      const overdue = t.isCompleted === 0 && parseDbTime(t.dueDate).getTime() < now
      return (
        <>
          <span className={overdue ? 'overdue' : ''}>{formatDueLabel(t.dueDate)}</span>
          {overdue && <span className="overdue-badge">已过期</span>}
        </>
      )
    }
    // No deadline: show when it will remind instead (a reminder can be in the past
    // without the todo being "overdue").
    if (t.remindAt) return <span>⏰ {formatDueLabel(t.remindAt)}</span>
    return null
  }

  const renderRow = (t: Todo) => (
    <div
      key={t.id}
      className={`todo-row ${t.isCompleted === 1 ? 'done' : ''}`}
      onClick={() => {
        setEditing(t)
        setEditOpen(true)
      }}
    >
      <button
        type="button"
        className="todo-check"
        aria-label={t.isCompleted === 1 ? '取消完成' : '完成'}
        onClick={(e) => {
          e.stopPropagation()
          void handleToggle(t)
        }}
      >
        {t.isCompleted === 1 && <IconCheck size={14} />}
      </button>
      <div className="todo-main">
        <div className="todo-title">
          {t.isPinned === 1 && <span className="pin-badge">📌</span>}
          {t.title}
        </div>
        {(t.dueDate || t.remindAt) && <div className="todo-meta">{rowMeta(t)}</div>}
      </div>
      <button
        type="button"
        className={`icon-btn todo-pin ${t.isPinned === 1 ? 'on' : ''}`}
        aria-label={t.isPinned === 1 ? '取消置顶' : '置顶'}
        onClick={(e) => {
          e.stopPropagation()
          void handleTogglePin(t)
        }}
      >
        <IconPin size={17} />
      </button>
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
  )

  return (
    <div className="page">
      <PageHeader
        title="待办"
        searchWrapRef={searchWrapRef}
        largeTitleRef={largeTitleRef}
        actions={[{ icon: <IconSettings size={22} />, label: '设置', onClick: onOpenSettings }]}
        search={{ placeholder: '搜索待办', value: searchInput, onChange: setSearchInput }}
      />

      <div className="page-scroll" ref={scrollRef}>
        <div className="scroll-shift" ref={contentShiftRef}>
          <div
            className={`scroll-content ${springing ? 'springing' : ''}`}
            style={pullDist ? { transform: `translateY(${pullDist}px)` } : undefined}
          >
            {loading && filtered.length === 0 ? (
              <div className="list-loading">加载中…</div>
            ) : (
              filtered.length === 0 && (
                <EmptyState
                  icon={<IconTodo size={44} />}
                  text={query ? '没有匹配的待办' : '还没有待办，点击 + 创建'}
                />
              )
            )}

            {active.length > 0 && <div className="section-title">进行中 · {active.length}</div>}
            {active.slice(0, visible).map(renderRow)}

            {done.length > 0 && <div className="section-title">已完成 · {done.length}</div>}
            {done.slice(0, visible).map(renderRow)}
            {hasMore && <div ref={sentinelRef} className="list-sentinel" />}
          </div>
        </div>
      </div>

      <FAB label="新建待办" onClick={() => { setEditing(null); setEditOpen(true) }} />

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
        <TodoEditor
          todo={editing}
          onClose={() => setEditOpen(false)}
          onSaved={load}
        />
      )}
    </div>
  )
}
