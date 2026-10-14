import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { save } from '@tauri-apps/plugin-dialog'
import { api, type NoteSort } from '../../api'
import { useDebouncedSearch, useLongPress } from '../../hooks'
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
  IconTrash,
} from '../../components/Icons'
import PageHeader from '../../components/PageHeader'
import FAB from '../../components/FAB'
import EmptyState from '../../components/EmptyState'
import ChipRow from '../../components/ChipRow'
import SettingsPage from '../settings/SettingsPage'

interface Props {
  version: number
  onOpenNote: (noteId: number | null, folderId: number | null) => void
  onOpenFolders: () => void
}

/** Tab filter: all notes, unclassified notes, or a specific folder. */
type FolderFilter = 'all' | 'uncat' | number

/** Items rendered per batch before the sentinel triggers the next one. */
const PAGE = 50

const SORT_OPTIONS: Array<{ key: NoteSort; label: string }> = [
  { key: 'updated', label: '更新时间' },
  { key: 'created', label: '创建时间' },
  { key: 'title', label: '标题' },
]

export default function NoteListPage({ version, onOpenNote, onOpenFolders }: Props) {
  const [notes, setNotes] = useState<Note[]>([])
  const [stats, setStats] = useState<FolderStats | null>(null)
  const [filter, setFilter] = useState<FolderFilter>('all')
  const [searchInput, setSearchInput, query] = useDebouncedSearch()
  const [sort, setSort] = useState<NoteSort>('updated')
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
  const pullStartY = useRef(0)
  const pulling = useRef(false)
  const [pullDist, setPullDist] = useState(0)

  const load = useCallback(async () => {
    try {
      const list = await api.listNotes({
        folderId: typeof filter === 'number' ? filter : undefined,
        unclassified: filter === 'uncat' || undefined,
        search: query || undefined,
        sort,
      })
      setNotes(list)
      setStats(await api.listFolders())
    } catch (e) {
      console.error('加载笔记失败', e)
      toast(friendlyError(e))
    } finally {
      setLoading(false)
    }
  }, [filter, query, sort])

  useEffect(() => {
    let cancelled = false
    const run = async () => {
      try {
        const list = await api.listNotes({
          folderId: typeof filter === 'number' ? filter : undefined,
          unclassified: filter === 'uncat' || undefined,
          search: query || undefined,
          sort,
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
  }, [filter, query, sort, version])

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

  // ---- Pull to refresh ----
  const onTouchStart = (e: React.TouchEvent) => {
    if ((scrollRef.current?.scrollTop ?? 1) <= 0) {
      pullStartY.current = e.touches[0].clientY
      pulling.current = true
    }
  }
  const onTouchMove = (e: React.TouchEvent) => {
    if (!pulling.current) return
    const dy = e.touches[0].clientY - pullStartY.current
    if (dy > 0 && (scrollRef.current?.scrollTop ?? 1) <= 0) {
      setPullDist(Math.min(dy * 0.4, 64))
    }
  }
  const onTouchEnd = async () => {
    if (!pulling.current) return
    pulling.current = false
    if (pullDist > 45) {
      setRefreshing(true)
      await load()
      setRefreshing(false)
    }
    setPullDist(0)
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
      <PageHeader
        title="笔记"
        actions={[
          {
            icon: <IconSettings size={22} />,
            label: '设置',
            onClick: () => setSettingsOpen(true),
          },
          { icon: <IconFolder size={22} />, label: '文件夹管理', onClick: onOpenFolders },
        ]}
        search={{ placeholder: '搜索笔记标题和内容', value: searchInput, onChange: setSearchInput }}
      />

      <ChipRow items={tabs} value={filter} onChange={setFilter} />

      <ChipRow items={SORT_OPTIONS} value={sort} onChange={setSort} />

      <div
        className="page-scroll"
        ref={scrollRef}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
      >
        {(pullDist > 0 || refreshing) && (
          <div className="pull-indicator">
            {refreshing ? '正在刷新…' : pullDist > 45 ? '释放刷新' : '下拉刷新'}
          </div>
        )}
        {loading && notes.length === 0 ? (
          <div className="list-loading">加载中…</div>
        ) : notes.length === 0 ? (
          <EmptyState
            icon={<IconNote size={44} />}
            text={query ? '没有匹配的笔记' : '还没有笔记，点击 + 创建'}
          />
        ) : (
          <>
            {notes.slice(0, visible).map((note) => (
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
