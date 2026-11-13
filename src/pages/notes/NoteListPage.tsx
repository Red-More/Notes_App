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
import type { Doc, Folder, FolderScope, FolderStats, Note } from '../../types'
import { NOTES_ROOT_SCOPE } from '../../types'
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
import FolderScopePicker from '../../components/FolderScopePicker'

interface Props {
  isActive: boolean
  version: number
  /** Folder the list is scoped to; any VFS directory is allowed. */
  scope: FolderScope
  onScopeChange: (scope: FolderScope) => void
  onOpenSettings: () => void
  onOpenNote: (noteId: number | null, folderId: number | null) => void
  onOpenFolders: () => void
}

/** One rendered row for a note document. */
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

/** Rows for arbitrary VFS folders (todos, diaries, agent notes…). */
function docRow(doc: Doc): Row {
  return {
    id: doc.id,
    title: doc.title,
    preview: doc.content,
    meta: `${formatAmPmDateTime(doc.updatedAt)} · ${doc.content.length}字`,
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

/** Segmented row: 全部 (recursive), one child folder, or the current level. */
type SegmentFilter = 'all' | 'self' | number

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
  scope,
  onScopeChange,
  onOpenSettings,
  onOpenNote,
  onOpenFolders,
}: Props) {
  const [notes, setNotes] = useState<Row[]>([])
  /** Root folder stats, kept only for the «移动到» dialog. */
  const [stats, setStats] = useState<FolderStats | null>(null)
  /** Direct child folders of the current scope, rendered as the segmented row. */
  const [childFolders, setChildFolders] = useState<Folder[]>([])
  const [filter, setFilter] = useState<SegmentFilter>('all')
  const [pickerOpen, setPickerOpen] = useState(false)
  const [pickerAnchor, setPickerAnchor] = useState<{ left: number; top: number } | null>(null)
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

  /** Notes-root scope → note APIs; other VFS folders → generic docs. */
  const inNotes = scope.path === '/life/notes' || scope.path.startsWith('/life/notes/')

  // Segmented control: the direct subfolders of the current scope.
  useEffect(() => {
    let cancelled = false
    const rootPath = scope.id == null ? '/life/notes' : '/life'
    void api
      .listFolders(scope.id, rootPath)
      .then((folders) => {
        if (!cancelled) setChildFolders(folders.folders)
      })
      .catch(() => {
        if (!cancelled) setChildFolders([])
      })
    return () => {
      cancelled = true
    }
  }, [scope.id, version])

  // A new namespace root always starts on the aggregate view.
  useEffect(() => {
    setFilter('all')
  }, [scope.id, scope.path])

  // 全部 aggregates recursively under the scope; a child / 本层 segment lists
  // one folder's direct documents. Note folders keep the FTS5 search path.
  const fetchRows = useCallback(async (): Promise<{ rows: Row[]; fallback: boolean }> => {
    const search = query.trim()
    if (filter === 'all') {
      const docs = await docApi.list({
        root: scope.path,
        search: search || undefined,
        previewChars: 120,
      })
      return { rows: docs.map(docRow), fallback: false }
    }

    if (inNotes) {
      const filters =
        filter === 'self'
          ? scope.id == null
            ? { unclassified: true }
            : { folderId: scope.id }
          : { folderId: filter }
      if (search) {
        const result = await api.searchNotes({ search, ...filters })
        return { rows: result.notes.map(noteRow), fallback: result.fallback }
      }
      return { rows: (await api.listNotes(filters)).map(noteRow), fallback: false }
    }

    const folderId = filter === 'self' ? scope.id : filter
    const docs = await docApi.list({
      folderId: folderId ?? undefined,
      search: search || undefined,
      previewChars: 120,
    })
    return { rows: docs.map(docRow), fallback: false }
  }, [scope.path, scope.id, inNotes, filter, query])

  const resetScope = useCallback(() => {
    if (scope.id != null) {
      setFilter('all')
      onScopeChange(NOTES_ROOT_SCOPE)
    }
  }, [scope.id, onScopeChange])

  const load = useCallback(async () => {
    try {
      const result = await fetchRows()
      setNotes(result.rows)
      setSearchFallback(result.fallback)
      setStats(await api.listFolders())
    } catch (e) {
      // A folder removed from the management page invalidates the scope.
      if ((e as { code?: string })?.code === 'notFound') {
        resetScope()
        return
      }
      console.error('加载笔记失败', e)
      toast(friendlyError(e))
    } finally {
      setLoading(false)
    }
  }, [fetchRows, resetScope])

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
        const folderStats = await api.listFolders()
        if (cancelled) return
        setStats(folderStats)
      } catch (e) {
        if (cancelled) return
        if ((e as { code?: string })?.code === 'notFound') {
          resetScope()
          return
        }
        console.error('加载笔记失败', e)
        toast(friendlyError(e))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void run()
    return () => {
      cancelled = true
    }
  }, [fetchRows, version, resetScope])

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
    // Selection actions only apply inside the notes namespace.
    if (!inNotes) return
    // A completed hold always acts on the pressed note: enter selection mode
    // with it selected, or toggle it when selection is already active.
    if (selectMode) {
      toggleSelected(row.id)
    } else {
      setSelectMode(true)
      setSelected(new Set([row.id]))
    }
  })

  const handleCardClick = (row: Row) => {
    if (didLongPress()) return
    if (selectMode) {
      toggleSelected(row.id)
    } else {
      // Every VFS document opens in the shared editor, editable in place.
      onOpenNote(row.id, null)
    }
  }

  const handleScopeSelect = (next: FolderScope) => {
    const scopeChanged = next.id !== scope.id || next.path !== scope.path
    if (!scopeChanged && next.name === scope.name) return
    if (scopeChanged) setFilter('all')
    setSelectMode(false)
    setSelected(new Set())
    setNotes([])
    setLoading(true)
    onScopeChange(next)
  }

  const openScopePicker = (e: React.MouseEvent<HTMLButtonElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    setPickerAnchor({ left: rect.left, top: rect.bottom })
    setPickerOpen(true)
  }

  /** Segmented row switch: 全部 / one child folder / the current level. */
  const selectFilter = (next: SegmentFilter) => {
    if (next === filter) return
    setFilter(next)
    setSelectMode(false)
    setSelected(new Set())
    setNotes([])
    setLoading(true)
  }

  const selfLabel = inNotes && scope.id == null ? (stats?.defaultFolderName ?? '默认') : '本层'
  const activeLabel =
    filter === 'all'
      ? scope.name
      : filter === 'self'
        ? selfLabel
        : (childFolders.find((folder) => folder.id === filter)?.name ?? scope.name)
  /** New notes land in the active child folder, else the namespace root. */
  const createFolderId = typeof filter === 'number' ? filter : scope.id

  // Clamp the picker to the viewport; it scrolls internally past 50vh.
  const pickerPos = useMemo(() => {
    if (!pickerAnchor) return undefined
    const WIDTH = 280
    const left = Math.min(Math.max(8, pickerAnchor.left), window.innerWidth - WIDTH - 8)
    const top = Math.min(pickerAnchor.top + 6, window.innerHeight - 160)
    return { left, top, width: WIDTH } as React.CSSProperties
  }, [pickerAnchor])

  const selectedIds = useMemo(() => [...selected], [selected])
  const canSelect = inNotes
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
          title={scope.name}
          searchWrapRef={searchWrapRef}
          largeTitleRef={largeTitleRef}
          titleRow={selectionTitleRow}
          onTitleClick={openScopePicker}
          titleTrailing={<IconChevronDown size={18} />}
          actions={[
            {
              icon: <IconSettings size={22} />,
              label: '设置',
              onClick: onOpenSettings,
            },
            ...(inNotes
              ? [{ icon: <IconFolder size={22} />, label: '文件夹管理', onClick: onOpenFolders }]
              : []),
          ]}
          search={{
            placeholder:
              filter === 'all' && inNotes && scope.id == null
                ? '搜索笔记标题和内容'
                : `搜索「${activeLabel}」内的内容`,
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

      {/* Segmented folder row: 全部 aggregate, direct subfolders, current level. */}
      <div className="chips">
        <button
          type="button"
          className={`chip ${filter === 'all' ? 'active' : ''}`}
          onClick={() => selectFilter('all')}
        >
          全部
        </button>
        {childFolders.map((folder) => (
          <button
            key={folder.id}
            type="button"
            className={`chip ${filter === folder.id ? 'active' : ''}`}
            onClick={() => selectFilter(folder.id)}
          >
            {folder.name}
          </button>
        ))}
        <button
          type="button"
          className={`chip ${filter === 'self' ? 'active' : ''}`}
          onClick={() => selectFilter('self')}
        >
          {selfLabel}
        </button>
      </div>

      {pickerOpen && (
        <FolderScopePicker
          rootLabel="全部文件"
          rootPath="/life"
          rootSelectable={false}
          value={scope.id}
          valuePath={scope.path}
          onSelect={handleScopeSelect}
          onClose={() => setPickerOpen(false)}
          style={pickerPos}
        />
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
                    : filter === 'all' && inNotes && scope.id == null
                      ? '还没有笔记，点击 + 创建'
                      : `「${activeLabel}」暂无内容`
                }
              />
            ) : (
              <>
                {sortedRows.slice(0, visible).map((row) => (
                  <div
                    key={row.id}
                    className={`note-card ${selectMode && selected.has(row.id) ? 'selected' : ''}`}
                    onClick={() => handleCardClick(row)}
                    {...(canSelect ? bind(row) : {})}
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

      {inNotes && <FAB label="新建笔记" onClick={() => onOpenNote(null, createFolderId)} />}

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
