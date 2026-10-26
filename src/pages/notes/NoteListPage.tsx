import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { save } from '@tauri-apps/plugin-dialog'
import { api } from '../../api'
import { useDebouncedSearch, useLongPress, useCollapsibleSearch } from '../../hooks'
import { exportTs, formatRelative, friendlyError } from '../../utils'
import type { FolderStats, Note } from '../../types'
import { ConfirmDialog, Modal } from '../../components/ui'
import { toast } from '../../toast'
import {
  IconCheck,
  IconExport,
  IconFolder,
  IconMove,
  IconNote,
  IconPin,
  IconSettings,
  IconSort,
  IconTrash,
} from '../../components/Icons'
import PageHeader from '../../components/PageHeader'
import FAB from '../../components/FAB'
import EmptyState from '../../components/EmptyState'
import ChipRow from '../../components/ChipRow'
import SettingsPage from '../settings/SettingsPage'

interface Props {
  isActive: boolean
  version: number
  onOpenNote: (noteId: number | null, folderId: number | null) => void
  onOpenFolders: () => void
}

/** Tab filter: all notes, unclassified notes, or a specific folder. */
type FolderFilter = 'all' | 'uncat' | number

/** Items rendered per batch before the sentinel triggers the next one. */
const PAGE = 50

/** Sort dimensions offered in the sort popover. */
type SortKey = 'updated' | 'created' | 'title' | 'size'
type SortDir = 'asc' | 'desc'

const SORT_DIMENSIONS: Array<{ key: SortKey; label: string }> = [
  { key: 'updated', label: '更新时间' },
  { key: 'created', label: '创建时间' },
  { key: 'title', label: '名称' },
  { key: 'size', label: '大小' },
]

/** Default direction per dimension, preserving the previous backend order. */
const SORT_DIR_DEFAULT: Record<SortKey, SortDir> = {
  updated: 'desc',
  created: 'desc',
  title: 'asc',
  size: 'desc',
}

export default function NoteListPage({ isActive, version, onOpenNote, onOpenFolders }: Props) {
  const [notes, setNotes] = useState<Note[]>([])
  const [stats, setStats] = useState<FolderStats | null>(null)
  const [filter, setFilter] = useState<FolderFilter>('all')
  const [searchInput, setSearchInput, query] = useDebouncedSearch()
  const [sortKey, setSortKey] = useState<SortKey>('updated')
  const [sortDir, setSortDir] = useState<SortDir>('desc')
  const [sortOpen, setSortOpen] = useState(false)
  const [selectMode, setSelectMode] = useState(false)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [moveOpen, setMoveOpen] = useState(false)
  const [deleteConfirm, setDeleteConfirm] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [loading, setLoading] = useState(true)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [visible, setVisible] = useState(PAGE)

  const scrollRef = useRef<HTMLDivElement>(null)
  const sentinelRef = useRef<HTMLDivElement>(null)
  // Scroll-linked collapsing search bar (features spec: progressive shrink + fade).
  const { searchWrapRef, scrollRef: setScrollEl } = useCollapsibleSearch()
  // Keep the object ref (used by the elastic-overscroll effect) in sync with the
  // hook's callback ref, which is what actually targets the live scroll element.
  const attachScrollRef = useCallback(
    (el: HTMLDivElement | null) => {
      scrollRef.current = el
      setScrollEl(el)
    },
    [setScrollEl],
  )
  // Elastic overscroll: current downward offset and whether it is springing back.
  const [pullDist, setPullDist] = useState(0)
  const [springing, setSpringing] = useState(false)

  const load = useCallback(async () => {
    try {
      const list = await api.listNotes({
        folderId: typeof filter === 'number' ? filter : undefined,
        unclassified: filter === 'uncat' || undefined,
        search: query || undefined,
      })
      setNotes(list)
      setStats(await api.listFolders())
    } catch (e) {
      console.error('加载笔记失败', e)
      toast(friendlyError(e))
    } finally {
      setLoading(false)
    }
  }, [filter, query])

  // Refresh when the page becomes active again (the pager keeps it mounted,
  // so re-entering must still fetch fresh data like a remount used to).
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
        const list = await api.listNotes({
          folderId: typeof filter === 'number' ? filter : undefined,
          unclassified: filter === 'uncat' || undefined,
          search: query || undefined,
        })
        if (cancelled) return
        setNotes(list)
        setVisible(PAGE)
        if (cancelled) return
        setStats(await api.listFolders())
      } catch (e) {
        console.error('加载笔记失败', e)
        if (!cancelled) toast(friendlyError(e))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void run()
    return () => {
      cancelled = true
    }
  }, [filter, query, version])

  // Re-sort the current (already filtered/searched) result set on the client:
  // pinned notes stay on top, then the chosen dimension and direction apply.
  const sortedNotes = useMemo(() => {
    const arr = [...notes]
    arr.sort((a, b) => {
      if (a.isPinned !== b.isPinned) return b.isPinned - a.isPinned
      let cmp = 0
      switch (sortKey) {
        case 'title':
          cmp = a.title.localeCompare(b.title, undefined, { sensitivity: 'base' })
          break
        case 'created':
          cmp = a.createdAt.localeCompare(b.createdAt)
          break
        case 'size':
          cmp = a.content.length - b.content.length
          break
        default:
          cmp = a.updatedAt.localeCompare(b.updatedAt)
      }
      return sortDir === 'asc' ? cmp : -cmp
    })
    return arr
  }, [notes, sortKey, sortDir])

  // Grow the rendered slice when the sentinel scrolls into view.
  // Re-runs when the list (re)mounts — e.g. after closing the settings page.
  const hasMore = visible < notes.length
  useEffect(() => {
    const el = sentinelRef.current
    if (!el) return
    const io = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting) setVisible((v) => v + PAGE)
    })
    io.observe(el)
    return () => io.disconnect()
  }, [notes.length, hasMore, settingsOpen])

  const exitSelect = () => {
    setSelectMode(false)
    setSelected(new Set())
  }

  const { longPressProps, didLongPress } = useLongPress(() => {
    if (!selectMode) setSelectMode(true)
  })

  const toggleSelected = (id: number) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }

  const handleCardClick = (note: Note) => {
    if (didLongPress()) return
    if (selectMode) {
      toggleSelected(note.id)
    } else {
      onOpenNote(note.id, null)
    }
  }

  const selectedIds = useMemo(() => [...selected], [selected])
  const allSelected = notes.length > 0 && selected.size === notes.length
  const pinnedTarget = !notes.filter((n) => selected.has(n.id)).every((n) => n.isPinned === 1)

  const handlePin = async () => {
    if (!selected.size) return
    try {
      await api.setNotesPinned({ ids: selectedIds, pinned: pinnedTarget })
      toast(pinnedTarget ? '已置顶' : '已取消置顶')
      exitSelect()
      await load()
    } catch (e) {
      console.error(e)
      toast(friendlyError(e))
    }
  }

  const handleMove = async (folderId: number | null) => {
    setMoveOpen(false)
    try {
      await api.moveNotes({ ids: selectedIds, folderId })
      toast('已移动')
      exitSelect()
      await load()
    } catch (e) {
      console.error(e)
      toast(friendlyError(e))
    }
  }

  const handleDelete = async () => {
    setDeleteConfirm(false)
    try {
      await api.deleteNotes(selectedIds)
      toast('已移入回收站')
      exitSelect()
      await load()
    } catch (e) {
      console.error(e)
      toast(friendlyError(e))
    }
  }

  const handleExport = async () => {
    if (!selected.size) return
    try {
      const path = await save({
        defaultPath: `笔记导出-${exportTs()}.zip`,
        filters: [{ name: 'ZIP', extensions: ['zip'] }],
      })
      if (path == null) return
      await api.exportNotesTo({ ids: selectedIds, destPath: path })
      toast('已导出')
      exitSelect()
    } catch (e) {
      console.error(e)
      toast(friendlyError(e))
    }
  }

  // ---- Elastic overscroll (pull down past the top edge) ----
  // Native listeners with a non-passive touchmove so the default scroll can be
  // suppressed while the finger drags the content below scrollTop 0. On release
  // the offset springs back to 0; beyond the threshold it also refreshes.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    let startX = 0
    let startY = 0
    let active = false
    let dist = 0
    let springTimer: ReturnType<typeof setTimeout> | undefined
    // Suppresses the click synthesized after a pull so it cannot open a note.
    let clickGuardUntil = 0

    const springBack = () => {
      setSpringing(true)
      // Two frames later the transition class is committed; only then drop the offset.
      requestAnimationFrame(() => {
        requestAnimationFrame(() => setPullDist(0))
      })
      clearTimeout(springTimer)
      springTimer = setTimeout(() => setSpringing(false), 450)
    }

    const onTouchStart = (e: TouchEvent) => {
      if (el.scrollTop <= 0) {
        startX = e.touches[0].clientX
        startY = e.touches[0].clientY
        active = true
        // A new pull must not inherit the spring transition of a previous one.
        setSpringing(false)
      } else {
        active = false
      }
    }
    const onTouchMove = (e: TouchEvent) => {
      if (!active) return
      const dx = e.touches[0].clientX - startX
      const dy = e.touches[0].clientY - startY
      // A horizontal-dominant gesture belongs to the page pager; back off so
      // pull-to-refresh never fights a horizontal page swipe (1.15 mirrors the
      // pager's own angle threshold).
      if (Math.abs(dx) > Math.abs(dy) * 1.15) {
        active = false
        return
      }
      if (dy > 0 && el.scrollTop <= 0) {
        e.preventDefault()
        dist = Math.min(dy * 0.45, 90)
        setPullDist(dist)
      } else if (dy < 0) {
        active = false
      }
    }
    const onTouchEnd = () => {
      const shouldRefresh = active && dist > 45
      const hadPull = dist > 0
      active = false
      dist = 0
      if (hadPull) {
        // A drag that released over a card is not a tap: block the click that
        // the browser emits after touchend so the note does not pop open.
        clickGuardUntil = performance.now() + 300
        springBack()
      }
      if (shouldRefresh) {
        setRefreshing(true)
        void load().finally(() => setRefreshing(false))
      }
    }
    const onClickCapture = (e: MouseEvent) => {
      if (performance.now() < clickGuardUntil) {
        e.preventDefault()
        e.stopPropagation()
      }
    }

    el.addEventListener('touchstart', onTouchStart, { passive: true })
    el.addEventListener('touchmove', onTouchMove, { passive: false })
    el.addEventListener('touchend', onTouchEnd)
    el.addEventListener('touchcancel', onTouchEnd)
    el.addEventListener('click', onClickCapture, true)
    return () => {
      clearTimeout(springTimer)
      el.removeEventListener('touchstart', onTouchStart)
      el.removeEventListener('touchmove', onTouchMove)
      el.removeEventListener('touchend', onTouchEnd)
      el.removeEventListener('touchcancel', onTouchEnd)
      el.removeEventListener('click', onClickCapture, true)
    }
    // Re-bind after the settings page unmounts/remounts the scroll container.
  }, [load, settingsOpen])

  // ---- Sort popover ----
  const selectSortKey = (key: SortKey) => {
    setSortKey(key)
    setSortDir(SORT_DIR_DEFAULT[key])
    setSortOpen(false)
  }
  const selectSortDir = (dir: SortDir) => {
    setSortDir(dir)
    setSortOpen(false)
  }

  const tabs: Array<{ key: FolderFilter; label: string }> = [
    { key: 'all', label: '全部' },
    ...(stats?.folders.map((f) => ({
      key: f.id as FolderFilter,
      label: f.name,
    })) ?? []),
    { key: 'uncat', label: '默认' },
  ]

  const activeFolderId = typeof filter === 'number' ? filter : null

  if (settingsOpen) {
    return <SettingsPage onBack={() => setSettingsOpen(false)} />
  }

  return (
    <div className="page">
      <div className="note-header-wrap">
        <PageHeader
          title="笔记"
          searchWrapRef={searchWrapRef}
          actions={[
            {
              icon: <IconSettings size={22} />,
              label: '设置',
              onClick: () => setSettingsOpen(true),
            },
            { icon: <IconFolder size={22} />, label: '文件夹管理', onClick: onOpenFolders },
          ]}
          search={{
            placeholder: '搜索笔记标题和内容',
            value: searchInput,
            onChange: setSearchInput,
            action: (
              <button
                type="button"
                className={`icon-btn sort-trigger ${sortKey !== 'updated' || sortDir !== 'desc' ? 'active' : ''}`}
                onClick={() => setSortOpen((o) => !o)}
                aria-label="排序"
                aria-expanded={sortOpen}
              >
                <IconSort size={18} />
              </button>
            ),
          }}
        />
        {sortOpen && (
          <>
            <div className="popover-backdrop" onClick={() => setSortOpen(false)} />
            <div className="sort-popover">
              <div className="sort-popover-title">排序方式</div>
              {SORT_DIMENSIONS.map((d) => (
                <button
                  key={d.key}
                  type="button"
                  className={`sort-option ${sortKey === d.key ? 'active' : ''}`}
                  onClick={() => selectSortKey(d.key)}
                >
                  {d.label}
                  {sortKey === d.key && <IconCheck size={16} />}
                </button>
              ))}
              <div className="sort-popover-divider" />
              <div className="sort-popover-title">排序方向</div>
              <button
                type="button"
                className={`sort-option ${sortDir === 'asc' ? 'active' : ''}`}
                onClick={() => selectSortDir('asc')}
              >
                升序（A-Z / 旧 → 新）
                {sortDir === 'asc' && <IconCheck size={16} />}
              </button>
              <button
                type="button"
                className={`sort-option ${sortDir === 'desc' ? 'active' : ''}`}
                onClick={() => selectSortDir('desc')}
              >
                降序（Z-A / 新 → 旧）
                {sortDir === 'desc' && <IconCheck size={16} />}
              </button>
            </div>
          </>
        )}
      </div>

      <ChipRow items={tabs} value={filter} onChange={setFilter} />

      <div className="page-scroll" ref={attachScrollRef}>
        {(pullDist > 0 || refreshing) && (
          <div className="pull-indicator">
            {refreshing ? '正在刷新…' : pullDist > 45 ? '释放刷新' : '下拉刷新'}
          </div>
        )}
        <div
          className={`scroll-content ${springing ? 'springing' : ''}`}
          style={{ transform: pullDist > 0 ? `translateY(${pullDist}px)` : undefined }}
        >
          {loading && notes.length === 0 ? (
            <div className="list-loading">加载中…</div>
          ) : notes.length === 0 ? (
            <EmptyState
              icon={<IconNote size={44} />}
              text={query ? '没有匹配的笔记' : '还没有笔记，点击 + 创建'}
            />
          ) : (
            <>
              {sortedNotes.slice(0, visible).map((note) => (
                <div
                  key={note.id}
                  className={`note-card ${selectMode && selected.has(note.id) ? 'selected' : ''}`}
                  onClick={() => handleCardClick(note)}
                  {...longPressProps}
                >
                  {selectMode && (
                    <span className="check-dot">
                      {selected.has(note.id) && <IconCheck size={14} />}
                    </span>
                  )}
                  <div className="note-card-title">
                    {note.isPinned === 1 && <span className="pin-badge">📌</span>}
                    <span className="title-text">{note.title || '无标题'}</span>
                  </div>
                  {note.content && <div className="note-card-content">{note.content}</div>}
                  <div className="note-card-meta">
                    {note.folderName && <span className="chip mini">{note.folderName}</span>}
                    <span>{formatRelative(note.updatedAt)}</span>
                  </div>
                </div>
              ))}
              {hasMore && <div ref={sentinelRef} className="list-sentinel" />}
            </>
          )}
        </div>
      </div>

      <FAB label="新建笔记" onClick={() => onOpenNote(null, activeFolderId)} />

      {selectMode && (
        <div className="action-bar">
          <span className="action-bar-info">已选择 {selected.size} 项</span>
          <button
            type="button"
            className="action-bar-btn"
            onClick={() => setSelected(allSelected ? new Set() : new Set(notes.map((n) => n.id)))}
          >
            <IconCheck size={19} />
            {allSelected ? '全不选' : '全选'}
          </button>
          <button type="button" className="action-bar-btn" onClick={() => void handlePin()}>
            <IconPin size={19} />
            {pinnedTarget ? '置顶' : '取消置顶'}
          </button>
          <button type="button" className="action-bar-btn" onClick={() => setMoveOpen(true)}>
            <IconMove size={19} />
            移动到
          </button>
          <button type="button" className="action-bar-btn" onClick={() => void handleExport()}>
            <IconExport size={19} />
            导出
          </button>
          <button
            type="button"
            className="action-bar-btn danger"
            onClick={() => setDeleteConfirm(true)}
          >
            <IconTrash size={19} />
            删除
          </button>
          <button type="button" className="action-bar-btn" onClick={exitSelect}>
            取消
          </button>
        </div>
      )}

      {deleteConfirm && (
        <ConfirmDialog
          title="删除笔记"
          message={`确定删除选中的 ${selected.size} 篇笔记吗？将移入回收站，可从回收站恢复。`}
          confirmText="删除"
          danger
          onConfirm={() => void handleDelete()}
          onCancel={() => setDeleteConfirm(false)}
        />
      )}

      {moveOpen && stats && (
        <Modal title="移动到文件夹" onClose={() => setMoveOpen(false)}>
          <button type="button" className="option-row" onClick={() => void handleMove(null)}>
            默认
            <span className="count">{stats.unclassified} 篇</span>
          </button>
          {stats.folders.map((f) => (
            <button
              key={f.id}
              type="button"
              className="option-row"
              onClick={() => void handleMove(f.id)}
            >
              <IconFolder size={18} />
              {f.name}
              <span className="count">{f.noteCount} 篇</span>
            </button>
          ))}
        </Modal>
      )}
    </div>
  )
}
