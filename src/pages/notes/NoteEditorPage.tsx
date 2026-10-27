import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { save } from '@tauri-apps/plugin-dialog'
import { api } from '../../api'
import {
  computeKbInset,
  diffLines,
  formatAmPmDateTime,
  formatDateTime,
  fmtVersion,
  friendlyError,
  safeFileName,
} from '../../utils'
import type { Folder, NoteVersion } from '../../types'
import { ConfirmDialog, Modal } from '../../components/ui'
import { toast } from '../../toast'
import { getSaveStrategy } from '../../saveStrategy'
import { getEditorPrefs } from '../../editor/prefs'
import {
  SPLIT_HANDLE_SIZE,
  getLayoutPrefs,
  setLayoutPrefs,
  type LayoutPrefs,
} from '../../editor/layout'
import SplitHandle from '../../components/SplitHandle'
import {
  MarkdownEditor,
  type MarkdownEditorHandle,
} from '../../components/MarkdownEditor'
import type { MarkdownPreviewHandle } from '../../components/MarkdownPreview'
import {
  IconBack,
  IconCheck,
  IconClock,
  IconClose,
  IconCompare,
  IconExport,
  IconEye,
  IconFolder,
  IconPlus,
  IconRedo,
  IconRestore,
  IconSave,
  IconTrash,
  IconUndo,
} from '../../components/Icons'

// The preview carries markdown-it, KaTeX and highlight.js; load it only when
// the preview pane is actually shown.
const MarkdownPreview = lazy(() =>
  import('../../components/MarkdownPreview').then((module) => ({
    default: module.MarkdownPreview,
  })),
)

interface Props {
  noteId: number | null
  folderId: number | null
  onBack: () => void
}

type SaveState = 'clean' | 'dirty' | 'saving'

/** Prevent a bar action from stealing focus, so the IME and caret stay put. */
const keepFieldFocus = (e: React.PointerEvent<HTMLButtonElement>) => e.preventDefault()

/** How long a programmatic scroll suppresses the other pane's scroll events. */
const SYNC_GUARD_MS = 160

function hhmm(ts: number): string {
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export default function NoteEditorPage({ noteId, folderId, onBack }: Props) {
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [currentFolderId, setCurrentFolderId] = useState<number | null>(folderId)
  const [folders, setFolders] = useState<Folder[]>([])
  const [defaultFolderName, setDefaultFolderName] = useState('默认')
  const [saveState, setSaveState] = useState<SaveState>('clean')
  const [dirty, setDirty] = useState(false)
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null)
  const [createdAt, setCreatedAt] = useState<string | null>(null)
  const [updatedAt, setUpdatedAt] = useState<string | null>(null)
  const [hasNote, setHasNote] = useState(noteId != null)
  const [leaveConfirm, setLeaveConfirm] = useState(false)
  const [strategy] = useState(() => getSaveStrategy())

  // Version states
  const [versionsOpen, setVersionsOpen] = useState(false)
  const [versions, setVersions] = useState<NoteVersion[]>([])
  const [previewVersion, setPreviewVersion] = useState<NoteVersion | null>(null)
  const [compareVersion, setCompareVersion] = useState<NoteVersion | null>(null)
  const [restoreConfirm, setRestoreConfirm] = useState<NoteVersion | null>(null)
  const [deleteVersionConfirm, setDeleteVersionConfirm] = useState<NoteVersion | null>(null)

  const [folderModalOpen, setFolderModalOpen] = useState(false)
  // Layout config is persisted, so the split mode / ratio survives reloads.
  const [layout, setLayout] = useState<LayoutPrefs>(() => getLayoutPrefs())
  const [previewReady, setPreviewReady] = useState(false)
  const previewOpen = layout.previewOpen
  const previewOnly = layout.previewOnly
  const isSplit = previewOpen && !previewOnly

  // Edit mode: the draft is always mounted in place; tapping the title or the
  // body turns the bar on, dismissing the IME turns it off.
  const [editing, setEditing] = useState(false)
  const [canUndo, setCanUndo] = useState(false)
  const [canRedo, setCanRedo] = useState(false)
  const [editorPrefs] = useState(() => getEditorPrefs())

  // Keyboard-aware viewport state. `visualKbInset` comes from the visual
  // viewport (adjustResize / overlay models); `nativeKbInset` is forwarded by
  // the Android shell because edge-to-edge WebViews don't resize on IME.
  const [visualKbInset, setVisualKbInset] = useState(0)
  const [nativeKbInset, setNativeKbInset] = useState(0)
  const kbInset = Math.max(visualKbInset, nativeKbInset)
  const prevKbInsetRef = useRef(0)

  const noteIdRef = useRef<number | null>(noteId)
  const lastSavedRef = useRef<{ title: string; content: string }>({
    title: '',
    content: '',
  })
  const bodyRef = useRef<HTMLDivElement>(null)
  const titleRef = useRef<HTMLInputElement>(null)
  const editorRef = useRef<MarkdownEditorHandle>(null)
  const previewRef = useRef<MarkdownPreviewHandle>(null)

  // The lazy preview reports readiness through this callback ref; the scroll
  // alignment effect waits for it so the first split view starts in sync.
  const attachPreview = useCallback((handle: MarkdownPreviewHandle | null) => {
    previewRef.current = handle
    setPreviewReady(handle != null)
  }, [])

  const editingRef = useRef(false)
  // Scroll-sync guards: while one pane is driven programmatically, ignore the
  // scroll events it emits so the two panes never fight each other.
  const previewSyncIgnoreRef = useRef(0)
  const editorSyncIgnoreRef = useRef(0)

  // Load existing note and folder list on mount.
  useEffect(() => {
    void (async () => {
      try {
        const stats = await api.listFolders()
        setFolders(stats.folders)
        setDefaultFolderName(stats.defaultFolderName)
        if (noteIdRef.current != null) {
          const note = await api.getNote(noteIdRef.current)
          setTitle(note.title)
          setContent(note.content)
          setCurrentFolderId(note.folderId)
          setCreatedAt(note.createdAt)
          setUpdatedAt(note.updatedAt)
          lastSavedRef.current = {
            title: note.title,
            content: note.content,
          }
        }
      } catch (e) {
        console.error('加载笔记失败', e)
        toast(friendlyError(e))
      }
    })()
  }, [])

  // Skip saving a brand-new note that only contains whitespace.
  const isBlank = !title.trim() && !content.trim()

  /** Persist current edits; resolves false only when the write failed. */
  const doSave = useCallback(async () => {
    const t = title
    const c = content
    if (t === lastSavedRef.current.title && c === lastSavedRef.current.content) {
      // Nothing to write; fall back to "clean" if a save was pending.
      setSaveState((prev) => (prev === 'saving' ? 'clean' : prev))
      return true
    }
    if (noteIdRef.current == null && isBlank) return true
    setSaveState('saving')
    try {
      if (noteIdRef.current == null) {
        const note = await api.createNote({
          title: t,
          content: c,
          folderId: currentFolderId,
        })
        noteIdRef.current = note.id
        setHasNote(true)
        setCreatedAt(note.createdAt)
        setUpdatedAt(note.updatedAt)
      } else {
        const note = await api.saveNote({
          id: noteIdRef.current,
          title: t,
          content: c,
          folderId: currentFolderId,
        })
        setUpdatedAt(note.updatedAt)
      }
      lastSavedRef.current = { title: t, content: c }
      // The content may have changed again mid-write; reflect that state.
      setDirty(title !== t || content !== c)
      setSaveState(title === t && content === c ? 'clean' : 'dirty')
      setLastSavedAt(Date.now())
      return true
    } catch (e) {
      console.error('保存失败', e)
      setDirty(true)
      setSaveState('dirty')
      toast(friendlyError(e))
      return false
    }
  }, [title, content, isBlank, currentFolderId])

  // Mark edits as unsaved (except for a brand-new blank note).
  useEffect(() => {
    const matches = title === lastSavedRef.current.title && content === lastSavedRef.current.content
    setDirty(!matches)
    setSaveState((prev) => {
      // An in-flight save resolves its own final state on completion.
      if (prev === 'saving') return prev
      return matches ? 'clean' : 'dirty'
    })
  }, [title, content, isBlank])

  // ---- Strategy-driven auto-save ----

  // Real-time: short debounce write after typing stops.
  useEffect(() => {
    if (strategy.key !== 'realtime' || !dirty) return
    const t = setTimeout(() => void doSave(), 1200)
    return () => clearTimeout(t)
  }, [dirty, strategy.key, doSave])

  // Interval: write on the configured cadence.
  useEffect(() => {
    if (strategy.key !== 'interval' || !dirty) return
    const t = setTimeout(() => void doSave(), strategy.intervalMin * 60_000)
    return () => clearTimeout(t)
  }, [dirty, strategy.key, strategy.intervalMin, doSave])

  // Smart: edits only mark unsaved; a periodic fallback flushes them.
  useEffect(() => {
    if (strategy.key !== 'smart' || !dirty) return
    const t = setInterval(() => void doSave(), 30_000)
    return () => clearInterval(t)
  }, [dirty, strategy.key, doSave])

  // Every mode flushes once when the app hides / loses focus / is about to
  // unload, so an abrupt exit cannot lose the latest edits.
  useEffect(() => {
    const flush = () => {
      if (dirty) void doSave()
    }
    const onVisibility = () => {
      if (document.hidden) flush()
    }
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('blur', flush)
    window.addEventListener('pagehide', flush)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('blur', flush)
      window.removeEventListener('pagehide', flush)
    }
  }, [dirty, doSave])

  // Ctrl/Cmd+S always writes immediately.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        void doSave()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [doSave])

  // ---- Edit mode: focus-driven enter, IME-driven exit ----

  /** Enter edit mode. Undo history lives in CodeMirror, so nothing is reset. */
  const enterEditing = useCallback(() => {
    if (editingRef.current) return
    editingRef.current = true
    setEditing(true)
    // A keyboard that is still closing belongs to the previous session, so its
    // inset drop must not immediately end the session that just started.
    prevKbInsetRef.current = 0
  }, [])

  /** Leave edit mode without discarding the draft; blurring hides the IME. */
  const exitEditing = useCallback(() => {
    if (!editingRef.current) return
    editingRef.current = false
    setEditing(false)
    titleRef.current?.blur()
    editorRef.current?.blur()
  }, [])

  const handleHistoryChange = useCallback((undoAvailable: boolean, redoAvailable: boolean) => {
    setCanUndo(undoAvailable)
    setCanRedo(redoAvailable)
  }, [])

  const confirmEditing = useCallback(async () => {
    // A failed write keeps the user in edit mode so the draft is not lost.
    if (await doSave()) exitEditing()
  }, [doSave, exitEditing])

  // ---- Keyboard-aware editing viewport ----
  // Android edge-to-edge WebViews keep the layout/visual viewport unchanged
  // when the IME appears. MainActivity forwards WindowInsets.ime() in physical
  // pixels; convert it to CSS px and treat it as a keyboard inset.
  useEffect(() => {
    const apply = (px: unknown) => {
      const value = typeof px === 'number' && Number.isFinite(px) ? px : 0
      setNativeKbInset(Math.max(0, value / window.devicePixelRatio))
    }
    const onInset = (e: Event) => apply((e as CustomEvent).detail)
    window.addEventListener('notes-keyboard-inset', onInset)
    // Consume a value emitted before this listener mounted.
    apply((window as unknown as { __notesKbInsetPx?: number }).__notesKbInsetPx)
    return () => window.removeEventListener('notes-keyboard-inset', onInset)
  }, [])

  // On mobile the soft keyboard shrinks the visual viewport; expose its height
  // as bottom inset so the editor content can scroll above the keyboard.
  useEffect(() => {
    const vv = window.visualViewport
    if (!vv) return
    // The tallest layout-viewport height observed; in adjustResize mode the
    // keyboard shrinks it, so the delta is that model's keyboard inset.
    let tallInnerHeight = window.innerHeight
    // Only touch-capable environments can raise a soft keyboard; on desktop a
    // window shrink must never be mistaken for an inset.
    const canHaveSoftKeyboard =
      window.matchMedia?.('(pointer: coarse)').matches || navigator.maxTouchPoints > 0
    const update = () => {
      const inset = computeKbInset(
        tallInnerHeight,
        window.innerHeight,
        vv.height,
        vv.offsetTop,
        canHaveSoftKeyboard,
      )
      if (inset === 0) tallInnerHeight = window.innerHeight
      setVisualKbInset(inset)
    }
    const onOrientationChange = () => {
      // Rotation changes the available height without any keyboard; re-baseline.
      tallInnerHeight = window.innerHeight
      update()
    }
    update()
    vv.addEventListener('resize', update)
    vv.addEventListener('scroll', update)
    // Some webviews never fire visualViewport events when the soft keyboard
    // shows; a window resize is a reliable secondary signal to recompute.
    window.addEventListener('resize', update)
    window.addEventListener('orientationchange', onOrientationChange)
    return () => {
      vv.removeEventListener('resize', update)
      vv.removeEventListener('scroll', update)
      window.removeEventListener('resize', update)
      window.removeEventListener('orientationchange', onOrientationChange)
    }
  }, [])

  // A fall back to zero means the user dismissed the IME; edit mode ends with
  // it, so the caret and the edit bar disappear together. CodeMirror handles
  // caret scrolling when the keyboard appears (see MarkdownEditor's kbInset).
  useEffect(() => {
    const wasOpen = prevKbInsetRef.current > 0
    prevKbInsetRef.current = kbInset
    if (wasOpen && kbInset === 0) exitEditing()
  }, [kbInset, exitEditing])

  const handleBack = async () => {
    if (previewVersion) {
      setPreviewVersion(null)
      return
    }
    if (strategy.key === 'manual' && dirty) {
      setLeaveConfirm(true)
      return
    }
    // Stay on the page when the leave-save fails so edits are not lost.
    if (await doSave()) {
      onBack()
    }
  }

  const leaveSaving = async () => {
    // On failure keep the dialog open — the toast explains why.
    if (await doSave()) {
      setLeaveConfirm(false)
      onBack()
    }
  }

  const leaveDiscard = () => {
    setLeaveConfirm(false)
    onBack()
  }

  // ---- Version helpers ----
  const refreshVersions = async () => {
    if (noteIdRef.current == null) return
    setVersions(await api.listVersions(noteIdRef.current))
  }

  const openVersions = async () => {
    if (noteIdRef.current == null) {
      toast('请先输入内容以创建笔记')
      return
    }
    setVersionsOpen(true)
    try {
      await refreshVersions()
    } catch (e) {
      console.error(e)
      toast(friendlyError(e))
    }
  }

  const handleRestore = async (v: NoteVersion) => {
    setRestoreConfirm(null)
    try {
      const note = await api.restoreVersion(v.id)
      setTitle(note.title)
      setContent(note.content)
      setCurrentFolderId(note.folderId)
      setCreatedAt(note.createdAt)
      setUpdatedAt(note.updatedAt)
      lastSavedRef.current = { title: note.title, content: note.content }
      setDirty(false)
      setSaveState('clean')
      setPreviewVersion(null)
      toast(`已恢复到 ${fmtVersion(v.versionNumber)}`)
      await refreshVersions()
    } catch (e) {
      console.error(e)
      toast(friendlyError(e))
    }
  }

  const handleCreateVersion = async () => {
    if (noteIdRef.current == null) {
      toast('请先输入内容以创建笔记')
      return
    }
    try {
      await api.createVersion(noteIdRef.current)
      await refreshVersions()
      toast('版本已创建')
    } catch (e) {
      console.error(e)
      toast(friendlyError(e))
    }
  }

  const handleDeleteVersion = async (v: NoteVersion) => {
    setDeleteVersionConfirm(null)
    try {
      await api.deleteVersion(v.id)
      toast('版本已删除')
      await refreshVersions()
    } catch (e) {
      console.error(e)
      toast(friendlyError(e))
    }
  }

  const handleExport = async () => {
    if (noteIdRef.current == null) {
      toast('请先保存笔记')
      return
    }
    try {
      const path = await save({
        defaultPath: `${safeFileName(title || '未命名')}.md`,
        filters: [{ name: 'Markdown', extensions: ['md'] }],
      })
      if (path == null) return
      await api.exportNoteTo({ noteId: noteIdRef.current, destPath: path })
      toast('已导出')
    } catch (e) {
      console.error(e)
      toast(friendlyError(e))
    }
  }

  // ---- Folder selection ----
  const handleSelectFolder = async (fid: number | null) => {
    setFolderModalOpen(false)
    setCurrentFolderId(fid)
    if (noteIdRef.current == null) return
    try {
      // Folder-only change: persist the selection without touching the content.
      const note = await api.saveNote({
        id: noteIdRef.current,
        title,
        content,
        folderId: fid,
      })
      setUpdatedAt(note.updatedAt)
      lastSavedRef.current = { title, content }
      setDirty(false)
      setSaveState('clean')
    } catch (e) {
      console.error(e)
      toast(friendlyError(e))
    }
  }

  const folderName =
    folders.find((f) => f.id === currentFolderId)?.name ??
    (currentFolderId == null ? defaultFolderName : '')

  /** A tap on the editor pane outside the code surface focuses the body. */
  const handleEditorPaneClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement
    if (target.closest('input, textarea, button, a, .cm-editor')) return
    editorRef.current?.focus()
  }

  // ---- Layout: preview visibility, split mode and ratio ----

  const togglePreview = () => {
    const next = { ...layout, previewOpen: !layout.previewOpen }
    setLayout(next)
    setLayoutPrefs(next)
  }

  /** Live drag update: re-render the panes without touching localStorage. */
  const handleRatioChange = (ratio: number) => {
    setLayout((current) => (current.ratio === ratio ? current : { ...current, ratio }))
  }

  /** Drag / click finished: persist the final ratio. */
  const handleRatioCommit = (ratio: number) => {
    const next = { ...layout, ratio }
    setLayout(next)
    setLayoutPrefs(next)
  }

  // ---- Two-way editor <-> preview scroll sync ----
  // Each direction ignores the scroll events emitted by the pane it just
  // drove, so the two surfaces cannot oscillate against each other.
  const handleEditorScroll = (line: number) => {
    if (!isSplit) return
    const now = performance.now()
    if (now < editorSyncIgnoreRef.current) return
    previewSyncIgnoreRef.current = now + SYNC_GUARD_MS
    previewRef.current?.scrollToLine(line)
  }

  const handlePreviewScroll = (line: number) => {
    if (!isSplit) return
    const now = performance.now()
    if (now < previewSyncIgnoreRef.current) return
    editorSyncIgnoreRef.current = now + SYNC_GUARD_MS
    editorRef.current?.scrollToLine(line)
  }

  /** Tapping a preview block reveals its source line without opening the IME. */
  const handlePreviewSourceLine = (line: number) => {
    if (!isSplit) return
    editorRef.current?.revealLine(line)
  }

  // Align a newly opened split preview with the editor's current top line.
  useEffect(() => {
    if (!isSplit || !previewReady) return
    const frame = requestAnimationFrame(() => {
      previewSyncIgnoreRef.current = performance.now() + SYNC_GUARD_MS
      previewRef.current?.scrollToLine(editorRef.current?.getTopLine() ?? 1)
    })
    return () => cancelAnimationFrame(frame)
  }, [isSplit, previewReady])

  const wordCount = content.length
  const createdAtLabel = createdAt ? formatAmPmDateTime(createdAt) : '—'
  const updatedAtLabel = updatedAt ? formatAmPmDateTime(updatedAt) : '—'
  const diffRows = compareVersion ? diffLines(compareVersion.content, content) : []
  const diffAdd = diffRows.filter((r) => r.type === 'add').length
  const diffDel = diffRows.filter((r) => r.type === 'del').length

  const statusText =
    saveState === 'saving'
      ? '保存中…'
      : !hasNote
        ? '未创建'
        : saveState === 'dirty'
          ? '未保存'
          : strategy.key === 'interval' && lastSavedAt
            ? `已保存 ${hhmm(lastSavedAt)}`
            : '已保存'

  const statusClass =
    saveState === 'saving' ? 'saving' : saveState === 'dirty' ? 'dirty' : ''

  return (
    <div className="editor-page note-editor-page">
      {editing ? (
        // Edit bar: cancel on the left; undo / redo / confirm grouped right.
        // Pointer-down is default-prevented so taps never steal focus and the
        // IME stays open while the draft is manipulated.
        <div className="editor-topbar edit-topbar">
          <button
            type="button"
            className="edit-bar-btn"
            onClick={exitEditing}
            onPointerDown={keepFieldFocus}
            aria-label="取消编辑"
          >
            <IconClose size={22} />
          </button>
          <div className="edit-bar-actions">
            <button
              type="button"
              className="edit-bar-btn"
              onClick={() => editorRef.current?.undo()}
              onPointerDown={keepFieldFocus}
              aria-label="撤销"
              disabled={!canUndo}
            >
              <IconUndo size={22} />
            </button>
            <button
              type="button"
              className="edit-bar-btn"
              onClick={() => editorRef.current?.redo()}
              onPointerDown={keepFieldFocus}
              aria-label="恢复撤销"
              disabled={!canRedo}
            >
              <IconRedo size={22} />
            </button>
            <button
              type="button"
              className="edit-bar-btn accent"
              onClick={() => void confirmEditing()}
              onPointerDown={keepFieldFocus}
              aria-label="保存编辑"
            >
              <IconCheck size={22} />
            </button>
          </div>
        </div>
      ) : (
        <div className="editor-topbar">
          <button
            type="button"
            className="icon-btn"
            onClick={() => void handleBack()}
            aria-label="返回"
          >
            <IconBack size={22} />
          </button>
          <button
            type="button"
            className="editor-folder"
            onClick={() => setFolderModalOpen(true)}
          >
            <IconFolder size={15} />
            <span>{folderName || '选择文件夹'}</span>
          </button>
          <span className={`save-status ${statusClass}`}>
            {saveState === 'dirty' && <span className="dirty-dot" />}
            {statusText}
          </span>
          {strategy.key === 'manual' && (
            <button
              type="button"
              className="icon-btn"
              onClick={() => void doSave()}
              aria-label="保存"
              disabled={!dirty}
            >
              <IconSave size={20} />
            </button>
          )}
          <button
            type="button"
            className="icon-btn"
            onClick={() => void openVersions()}
            aria-label="历史版本"
          >
            <IconClock size={20} />
          </button>
          <button
            type="button"
            className="icon-btn"
            onClick={() => void handleExport()}
            aria-label="导出"
          >
            <IconExport size={20} />
          </button>
          <button
            type="button"
            className={`icon-btn ${previewOpen ? 'accent' : ''}`}
            onClick={togglePreview}
            aria-label={previewOpen ? '关闭预览' : '打开预览'}
          >
            <IconEye size={20} />
          </button>
        </div>
      )}

      {previewVersion ? (
        <>
          <div className="preview-banner">
            历史版本预览 · {fmtVersion(previewVersion.versionNumber)}
            {previewVersion.label ? ` · ${previewVersion.label}` : ''}
          </div>
          <div className="preview-content">
            <div className="preview-title">{previewVersion.title || '无标题'}</div>
            <div className="preview-text">{previewVersion.content || '（无内容）'}</div>
          </div>
          <div className="editor-bottombar">
            <span>{previewVersion.content.length} 字</span>
            <button
              type="button"
              className="btn btn-primary"
              style={{ flex: '0 0 auto', padding: '8px 22px' }}
              onClick={() => setRestoreConfirm(previewVersion)}
            >
              恢复版本
            </button>
          </div>
        </>
      ) : (
        <>
          <div
            className="editor-body"
            ref={bodyRef}
            style={
              kbInset
                ? { paddingBottom: `calc(${kbInset}px + var(--safe-bottom))` }
                : undefined
            }
          >
            {previewOpen && previewOnly ? (
              <div className="editor-preview preview-only" aria-label="Markdown 预览">
                <div className="preview-only-title">{title || '无标题'}</div>
                <Suspense fallback={<div className="preview-loading">正在加载预览…</div>}>
                  <MarkdownPreview
                    ref={attachPreview}
                    source={content}
                    onScrollLine={handlePreviewScroll}
                    onSourceLine={handlePreviewSourceLine}
                  />
                </Suspense>
              </div>
            ) : (
              <div className="editor-split">
                <div
                  className="editor-main"
                  style={
                    previewOpen
                      ? {
                          flex: `0 0 calc((100% - ${SPLIT_HANDLE_SIZE}px) * ${layout.ratio / 100})`,
                        }
                      : undefined
                  }
                  onClick={handleEditorPaneClick}
                >
                  <input
                    ref={titleRef}
                    className="editor-title-input"
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    onFocus={enterEditing}
                    placeholder="标题"
                  />
                  <div className="editor-meta">
                    <span className="editor-meta-item" title="创建时间">
                      {createdAtLabel}
                    </span>
                    <span className="editor-meta-sep" aria-hidden="true">
                      |
                    </span>
                    <span className="editor-meta-item" title="上次更新时间">
                      {updatedAtLabel}
                    </span>
                    <span className="editor-meta-sep" aria-hidden="true">
                      |
                    </span>
                    <span className="editor-meta-count" title="正文字数">
                      {wordCount}字
                    </span>
                  </div>
                  <div className="markdown-editor-host" onFocus={enterEditing}>
                    <MarkdownEditor
                      ref={editorRef}
                      value={content}
                      prefs={editorPrefs}
                      kbInset={kbInset}
                      onChange={setContent}
                      onHistoryChange={handleHistoryChange}
                      onScrollLine={handleEditorScroll}
                    />
                  </div>
                </div>
                {previewOpen && (
                  <>
                    <SplitHandle
                      ratio={layout.ratio}
                      onChange={handleRatioChange}
                      onCommit={handleRatioCommit}
                    />
                    <div className="editor-preview" aria-label="Markdown 预览">
                      <Suspense fallback={<div className="preview-loading">正在加载预览…</div>}>
                        <MarkdownPreview
                          ref={attachPreview}
                          source={content}
                          onScrollLine={handlePreviewScroll}
                          onSourceLine={handlePreviewSourceLine}
                        />
                      </Suspense>
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        </>
      )}

      {/* ---- Unsaved-changes leave interception (manual strategy) ---- */}
      {leaveConfirm && (
        <div className="modal-overlay" onClick={() => setLeaveConfirm(false)}>
          <div className="dialog" onClick={(e) => e.stopPropagation()}>
            <div className="dialog-title">未保存的更改</div>
            <div className="dialog-message">当前笔记有未保存的修改，离开前要保存吗？</div>
            <div className="dialog-actions" style={{ flexDirection: 'column' }}>
              <button type="button" className="btn btn-primary" onClick={() => void leaveSaving()}>
                保存并离开
              </button>
              <button type="button" className="btn btn-danger" onClick={leaveDiscard}>
                不保存
              </button>
              <button type="button" className="btn" onClick={() => setLeaveConfirm(false)}>
                取消
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ---- Folder selector ---- */}
      {folderModalOpen && (
        <Modal title="选择文件夹" onClose={() => setFolderModalOpen(false)}>
          <button
            type="button"
            className="option-row"
            onClick={() => void handleSelectFolder(null)}
          >
            {defaultFolderName}
            {currentFolderId == null && <span className="row-check">✓</span>}
          </button>
          {folders.map((f) => (
            <button
              key={f.id}
              type="button"
              className="option-row"
              onClick={() => void handleSelectFolder(f.id)}
            >
              <IconFolder size={18} />
              {f.name}
              {currentFolderId === f.id && <span className="row-check">✓</span>}
            </button>
          ))}
        </Modal>
      )}

      {/* ---- Version list ---- */}
      {versionsOpen && (
        <Modal
          title="历史版本"
          onClose={() => setVersionsOpen(false)}
          headerAction={
            <button
              type="button"
              className="icon-btn accent"
              onClick={() => void handleCreateVersion()}
              aria-label="新建版本"
            >
              <IconPlus size={20} />
            </button>
          }
        >
          {versions.length === 0 && <div className="empty-state">暂无版本</div>}
          {versions.map((v) => (
            <div key={v.id} className="version-item">
              <div
                className="version-main"
                onClick={() => {
                  setVersionsOpen(false)
                  setPreviewVersion(v)
                }}
              >
                <div className="version-head">
                  <span className="version-no">{fmtVersion(v.versionNumber)}</span>
                  {v.label && <span className="version-label">{v.label}</span>}
                </div>
                <div className="version-title">{v.title || '无标题'}</div>
                <div className="version-time">{formatDateTime(v.createdAt)}</div>
              </div>
              <div className="version-actions">
                <button
                  type="button"
                  className="icon-btn"
                  aria-label="预览"
                  onClick={() => {
                    setVersionsOpen(false)
                    setPreviewVersion(v)
                  }}
                >
                  <IconEye size={18} />
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  aria-label="恢复"
                  onClick={() => setRestoreConfirm(v)}
                >
                  <IconRestore size={18} />
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  aria-label="对比"
                  onClick={() => setCompareVersion(v)}
                >
                  <IconCompare size={18} />
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  aria-label="删除版本"
                  onClick={() => setDeleteVersionConfirm(v)}
                >
                  <IconTrash size={18} />
                </button>
              </div>
            </div>
          ))}
        </Modal>
      )}

      {/* ---- Version compare ---- */}
      {compareVersion && (
        <Modal
          title={`版本对比 · ${fmtVersion(compareVersion.versionNumber)} → 当前`}
          onClose={() => setCompareVersion(null)}
        >
          <div className="diff-stats">
            <span className="add">+{diffAdd} 行新增</span>
            <span className="del">-{diffDel} 行删除</span>
          </div>
          <div className="diff-body">
            {diffRows.map((row, idx) => (
              <div key={idx} className={`diff-row ${row.type}`}>
                <span className="no">{row.type === 'add' ? row.newNo : (row.oldNo ?? '')}</span>
                <span>{row.text || ' '}</span>
              </div>
            ))}
          </div>
        </Modal>
      )}

      {restoreConfirm && (
        <ConfirmDialog
          title="恢复版本"
          message={`确定要恢复到 ${fmtVersion(restoreConfirm.versionNumber)} 吗？当前内容将被覆盖，并自动创建一个"恢复自"版本。`}
          confirmText="恢复"
          onConfirm={() => void handleRestore(restoreConfirm)}
          onCancel={() => setRestoreConfirm(null)}
        />
      )}

      {deleteVersionConfirm && (
        <ConfirmDialog
          title="删除版本"
          message={`确定要删除 ${fmtVersion(deleteVersionConfirm.versionNumber)} 这个版本吗？此操作不可撤销。`}
          confirmText="删除"
          danger
          onConfirm={() => void handleDeleteVersion(deleteVersionConfirm)}
          onCancel={() => setDeleteVersionConfirm(null)}
        />
      )}
    </div>
  )
}
