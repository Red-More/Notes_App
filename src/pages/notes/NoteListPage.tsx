import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { save } from '@tauri-apps/plugin-dialog'
import { api, docApi } from '../../api'
import {
  useCollapsibleHeader,
  useDebouncedSearch,
  useElasticOverscroll,
  useLongPress,
} from '../../hooks'
import { exportTs, formatAmPmDateTime, friendlyError } from '../../utils'
import type { Doc, FolderStats, Note } from '../../types'
import { ConfirmDialog, Modal, OverlayPortal } from '../../components/ui'
import { toast } from '../../toast'
import {
  IconCheck,
  IconChevronDown,
  IconClose,
  IconExport,
  IconFolder,
  IconMove,
  IconNote,
  IconPin,
  IconSelectAll,
  IconSettings,
  IconSort,
  IconTrash,
} from '../../components/Icons'
import PageHeader from '../../components/PageHeader'
import FAB from '../../components/FAB'
import EmptyState from '../../components/EmptyState'

interface Props {
  isActive: boolean
  version: number
  onOpenSettings: () => void
  onOpenNote: (noteId: number | null, folderId: number | null) => void
  onOpenFolders: () => void
}

/** Tab filter: all notes, unclassified notes, or a specific note folder. */
type FolderFilter = 'all' | 'uncat' | number

/** System folders that can be browsed from the 全部 chip dropdown. */
const SYSTEM_FOLDERS = [
  { path: '/life/todos', label: '待办' },
  { path: '/life/diary', label: '日记' },
  { path: '/life/contacts', label: '联系人' },
  { path: '/life/agent', label: 'AI 工作区' },
] as const

const KIND_LABELS: Record<string, string> = {
  note: '笔记',
  diary: '日记',
  todo: '待办',
  contact: '联系人',
}

/** Path-aware label: Agent artifacts are not plain notes. */
function docKindLabel(doc: Doc): string {
  if (doc.path.startsWith('/life/agent/')) return 'AI 产物'
  return KIND_LABELS[doc.kind] ?? doc.kind
}

/** One rendered row: writable notes and browsed system docs share the card. */
interface Row {
  id: number
  title: string
  preview: string
  meta: string
  isPinned: number
  createdAt: string
  updatedAt: string
}

function noteRow(note: Note): Row {
  return {
    id: note.id,
    title: note.title,
    preview: note.content,
    meta: `${formatAmPmDateTime(note.updatedAt)} · ${note.content.length}字`,
    isPinned: note.isPinned,
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
  }
}

function docRow(doc: Doc): Row {
  return {
    id: doc.id,
    title: doc.title,
    preview: doc.content,
    meta: `${docKindLabel(doc)} · ${formatAmPmDateTime(doc.updatedAt)}`,
    isPinned: doc.pinned,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  }
}

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

/** Highlight the first case-insensitive occurrence of `needle` in `text`. */
function Highlight({ text, needle }: { text: string; needle: string }) {
  const query = needle.trim()
  if (!query) return <>{text}</>
  const index = text.toLowerCase().indexOf(query.toLowerCase())
  if (index < 0) return <>{text}</>
  return (
    <>
      {text.slice(0, index)}
      <mark className="search-hit">{text.slice(index, index + query.length)}</mark>
      {text.slice(index + query.length)}
    </>
  )
}

export default function NoteListPage({
  isActive,
  version,
  onOpenSettings,
  onOpenNote,
  onOpenFolders,
}: Props) {
  const [notes, setNotes] = useState<Row[]>([])
  const [stats, setStats] = useState<FolderStats | null>(null)
  const [filter, setFilter] = useState<FolderFilter>('all')
  /** Active system-folder browse scope; null means the normal note tabs. */
  const [browse, setBrowse] = useState<{ path: string; label: string } | null>(null)
  const [scopeOpen, setScopeOpen] = useState(false)
  const [searchInput, setSearchInput, query] = useDebouncedSearch()
  const [searchFallback, setSearchFallback] = useState(false)
  const [sortKey, setSortKey] = useState<SortKey>('updated')
  const [sortDir, setSortDir] = useState<SortDir>('desc')
  const [sortOpen, setSortOpen] = useState(false)
  const [selectMode, setSelectMode] = useState(false)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [moveOpen, setMoveOpen] = useState(false)
  const [deleteConfirm, setDeleteConfirm] = useState(false)
  const [loading, setLoading] = useState(true)
  const [visible, setVisible] = useState(PAGE)

  const sentinelRef = useRef<HTMLDivElement>(null)
  // Scroll-linked collapsing header (large title + search bar).
  const { largeTitleRef, searchWrapRef, scrollRef, contentShiftRef, scrollEl } =
    useCollapsibleHeader()

  // Note tabs: search goes through fs_grep (FTS5 with LIKE fallback); list mode
  // is a plain doc query. Browse mode: one recursive doc query on the root.
  const fetchRows = useCallback(async (): Promise<{ rows: Row[]; fallback: boolean }> => {
    const search = query.trim()
    if (browse) {
      const docs = await docApi.list({
        root: browse.path,
        search: search || undefined,
        previewChars: 120,
      })
      return { rows: docs.map(docRow), fallback: false }
    }
    const filters = {
      folderId: typeof filter === 'number' ? filter : undefined,
      unclassified: filter === 'uncat' || undefined,
    }
    if (search) {
      const result = await api.searchNotes({ search, ...filters })
      return { rows: result.notes.map(noteRow), fallback: result.fallback }
    }
    return { rows: (await api.listNotes(filters)).map(noteRow), fallback: false }
  }, [browse, filter, query])

  const load = useCallback(async () => {
    try {
      const result = await fetchRows()
      setNotes(result.rows)
      setSearchFallback(result.fallback)
      setStats(await api.listFolders())
    } catch (e) {
      console.error('加载笔记失败', e)
      toast(friendlyError(e))
    } finally {
      setLoading(false)
    }
  }, [fetchRows])

  // Elastic overscroll shared by every list; the notes list also refreshes.
  const { pullDist, springing, refreshing } = useElasticOverscroll(scrollEl, {
    onRefresh: load,
  })

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
        const result = await fetchRows()
        if (cancelled) return
        setNotes(result.rows)
        setSearchFallback(result.fallback)
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
  }, [fetchRows, version])

  // Re-sort the current (already filtered/searched) result set on the client:
  // pinned notes stay on top, then the chosen dimension and direction apply.
  const sortedRows = useMemo(() => {
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
          cmp = a.preview.length - b.preview.length
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
  }, [notes.length, hasMore])

  const exitSelect = () => {
    setSelectMode(false)
    setSelected(new Set())
  }

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

  const { bind, didLongPress } = useLongPress((row: Row) => {
    // A completed hold always acts on the pressed note: enter selection mode
    // with it selected, or toggle it when selection is already active.
    if (browse) return
    if (selectMode) {
      toggleSelected(row.id)
    } else {
      setSelectMode(true)
      setSelected(new Set([row.id]))
    }
  })

  const handleCardClick = (row: Row) => {
    if (didLongPress()) return
    if (!browse && selectMode) {
      toggleSelected(row.id)
    } else {
      // Every VFS document opens in the shared editor, editable in place.
      onOpenNote(row.id, null)
    }
  }

  /** Switch to a note tab (leaves any system-folder browse scope). */
  const selectFilter = (next: FolderFilter) => {
    setBrowse(null)
    setScopeOpen(false)
    setFilter(next)
    setSelectMode(false)
    setSelected(new Set())
    setNotes([])
    setLoading(true)
  }

  /** Browse one system folder (待办/日记/联系人/AI 工作区). */
  const selectScope = (scope: { path: string; label: string }) => {
    setScopeOpen(false)
    setBrowse(scope)
    setSelectMode(false)
    setSelected(new Set())
    setNotes([])
    setLoading(true)
  }

  const selectedIds = useMemo(() => [...selected], [selected])
  const allSelected = notes.length > 0 && selected.size === notes.length
  const pinnedTarget =
    selected.size === 0 || !notes.filter((n) => selected.has(n.id)).every((n) => n.isPinned === 1)

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

  const noteTabs: Array<{ key: FolderFilter; label: string }> = [
    ...(stats?.folders.map((f) => ({
      key: f.id as FolderFilter,
      label: f.name,
    })) ?? []),
    { key: 'uncat', label: stats?.defaultFolderName ?? '默认' },
  ]

  const activeFolderId = typeof filter === 'number' ? filter : null

  // Selection mode swaps only the title row: the search bar stays mounted so its
  // input value, focus, and scroll-collapse state survive.
  const selectionTitleRow = selectMode ? (
    <div className="selection-bar">
      <button type="button" className="icon-btn" onClick={exitSelect} aria-label="退出选择">
        <IconClose size={22} />
      </button>
      <span className="selection-count" aria-live="polite">
        已选择 {selected.size} 项
      </span>
      <button
        type="button"
        className={`icon-btn ${allSelected ? 'accent' : ''}`}
        onClick={() => setSelected(allSelected ? new Set() : new Set(notes.map((n) => n.id)))}
        aria-label={allSelected ? '取消全选' : '全选'}
        aria-pressed={allSelected}
      >
        <IconSelectAll size={22} />
      </button>
    </div>
  ) : undefined

  return (
    <div className="page">
      <div className="note-header-wrap">
        <PageHeader
          title="笔记"
          searchWrapRef={searchWrapRef}
          largeTitleRef={largeTitleRef}
          titleRow={selectionTitleRow}
          actions={[
            {
              icon: <IconSettings size={22} />,
              label: '设置',
              onClick: onOpenSettings,
            },
            { icon: <IconFolder size={22} />, label: '文件夹管理', onClick: onOpenFolders },
          ]}
          search={{
            placeholder: browse ? `搜索${browse.label}内容` : '搜索笔记标题和内容',
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

      <div className="chips">
        {/* 全部 carries a nested dropdown to browse sibling system folders. */}
        <div
          className={`chip chip-split ${!browse && filter === 'all' ? 'active' : ''}`}
        >
          <button type="button" className="chip-main" onClick={() => selectFilter('all')}>
            全部
          </button>
          <button
            type="button"
            className="chip-drop"
            onClick={() => setScopeOpen((o) => !o)}
            aria-label="切换文件夹范围"
            aria-expanded={scopeOpen}
          >
            <IconChevronDown size={14} />
          </button>
        </div>
        {browse && (
          <button type="button" className="chip active" onClick={() => selectScope(browse)}>
            {browse.label}
          </button>
        )}
        {noteTabs.map((tab) => (
          <button
            key={String(tab.key)}
            type="button"
            className={`chip ${!browse && filter === tab.key ? 'active' : ''}`}
            onClick={() => selectFilter(tab.key)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {scopeOpen && (
        <>
          <div className="popover-backdrop" onClick={() => setScopeOpen(false)} />
          <div className="scope-menu">
            <div className="sort-popover-title">浏览其他文件夹</div>
            {SYSTEM_FOLDERS.map((scope) => (
              <button
                key={scope.path}
                type="button"
                className={`sort-option ${browse?.path === scope.path ? 'active' : ''}`}
                onClick={() => selectScope(scope)}
              >
                {scope.label}
                {browse?.path === scope.path && <IconCheck size={16} />}
              </button>
            ))}
          </div>
        </>
      )}

      {query && searchFallback && (
        <div className="search-fallback-hint" role="status">
          检索索引未命中，本次结果来自回退扫描。
        </div>
      )}

      <div className="page-scroll" ref={scrollRef}>
        {(pullDist > 0 || refreshing) && (
          <div className="pull-indicator">
            {refreshing ? '正在刷新…' : pullDist > 45 ? '释放刷新' : '下拉刷新'}
          </div>
        )}
        <div className="scroll-shift" ref={contentShiftRef}>
          <div
            className={`scroll-content ${springing ? 'springing' : ''}`}
            style={pullDist ? { transform: `translateY(${pullDist}px)` } : undefined}
          >
            {loading && notes.length === 0 ? (
              <div className="list-loading">加载中…</div>
            ) : notes.length === 0 ? (
              <EmptyState
                icon={<IconNote size={44} />}
                text={
                  query
                    ? '没有匹配的内容'
                    : browse
                      ? `「${browse.label}」暂无文件`
                      : '还没有笔记，点击 + 创建'
                }
              />
            ) : (
              <>
                {sortedRows.slice(0, visible).map((row) => (
                  <div
                    key={row.id}
                    className={`note-card ${selectMode && selected.has(row.id) ? 'selected' : ''}`}
                    onClick={() => handleCardClick(row)}
                    {...(!browse ? bind(row) : {})}
                  >
                    {selectMode && (
                      <span className="check-dot">
                        {selected.has(row.id) && <IconCheck size={14} />}
                      </span>
                    )}
                    <div className="note-card-title">
                      {row.isPinned === 1 && <span className="pin-badge">📌</span>}
                      <span className="title-text">
                        <Highlight text={row.title} needle={query} />
                      </span>
                    </div>
                    <div className="note-card-content">
                      <Highlight text={row.preview} needle={query} />
                    </div>
                    <div className="note-card-meta">
                      <span className="note-card-time">{row.meta}</span>
                    </div>
                  </div>
                ))}
                {hasMore && <div ref={sentinelRef} className="list-sentinel" />}
              </>
            )}
          </div>
        </div>
      </div>

      {!browse && <FAB label="新建笔记" onClick={() => onOpenNote(null, activeFolderId)} />}

      {selectMode && isActive && (
        <OverlayPortal>
          <div className="action-bar selection-actions">
            <button
              type="button"
              className="action-bar-btn"
              onClick={() => void handlePin()}
              disabled={selected.size === 0}
            >
              <IconPin size={19} />
              {pinnedTarget ? '置顶' : '取消置顶'}
            </button>
            <button
              type="button"
              className="action-bar-btn"
              onClick={() => setMoveOpen(true)}
              disabled={selected.size === 0}
            >
              <IconMove size={19} />
              移动到
            </button>
            <button
              type="button"
              className="action-bar-btn"
              onClick={() => void handleExport()}
              disabled={selected.size === 0}
            >
              <IconExport size={19} />
              导出
            </button>
            <button
              type="button"
              className="action-bar-btn danger"
              onClick={() => setDeleteConfirm(true)}
              disabled={selected.size === 0}
            >
              <IconTrash size={19} />
              删除
            </button>
          </div>
        </OverlayPortal>
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
            {stats.defaultFolderName}
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
