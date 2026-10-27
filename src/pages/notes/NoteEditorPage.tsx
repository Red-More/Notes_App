import { useCallback, useEffect, useRef, useState } from 'react'
import { save } from '@tauri-apps/plugin-dialog'
import { api } from '../../api'
import {
  computeKbInset,
  diffLines,
  formatAmPmDateTime,
  formatDateTime,
  fmtVersion,
  friendlyError,
  renderMarkdown,
  safeFileName,
} from '../../utils'
import type { Folder, NoteVersion } from '../../types'
import { ConfirmDialog, Modal } from '../../components/ui'
import { toast } from '../../toast'
import { getSaveStrategy } from '../../saveStrategy'
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

interface Props {
  noteId: number | null
  folderId: number | null
  onBack: () => void
}

type SaveState = 'clean' | 'dirty' | 'saving'

interface EditorSnapshot {
  title: string
  content: string
}

/** Undo history limits: depth, and the typing-burst window merged into one step. */
const UNDO_LIMIT = 100
const UNDO_MERGE_MS = 700

/** Prevent a bar action from stealing focus, so the IME and caret stay put. */
const keepFieldFocus = (e: React.PointerEvent<HTMLButtonElement>) => e.preventDefault()

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
  const [previewOpen, setPreviewOpen] = useState(false)

  // Edit mode: the draft is always mounted in place; tapping the title or the
  // body turns the bar on, dismissing the IME turns it off.
  const [editing, setEditing] = useState(false)
  const [canUndo, setCanUndo] = useState(false)
  const [canRedo, setCanRedo] = useState(false)

  // Keyboard-aware viewport state. `visualKbInset` comes from the visual
  // viewport (adjustResize / overlay models); `nativeKbInset` is forwarded by
  // the Android shell because edge-to-edge WebViews don't resize on IME.
  const [visualKbInset, setVisualKbInset] = useState(0)
  const [nativeKbInset, setNativeKbInset] = useState(0)
  const kbInset = Math.max(visualKbInset, nativeKbInset)
  const userScrollRef = useRef(false)
  const programmaticRef = useRef(false)
  const prevKbInsetRef = useRef(0)
  const prevContentRef = useRef('')

  const noteIdRef = useRef<number | null>(noteId)
  const lastSavedRef = useRef<{ title: string; content: string }>({
    title: '',
    content: '',
  })
  const bodyRef = useRef<HTMLDivElement>(null)
  const titleRef = useRef<HTMLInputElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const mirrorRef = useRef<HTMLDivElement>(null)

  // Edit-session state kept in refs so handlers never depend on render timing.
  const editingRef = useRef(false)
  const undoStackRef = useRef<EditorSnapshot[]>([])
  const redoStackRef = useRef<EditorSnapshot[]>([])
  const lastEditAtRef = useRef(0)

  // Ground-truth draft mirrored into a ref. Every write path updates it
  // synchronously, so the undo/redo stacks never snapshot a render closure that
  // may be behind the values currently on screen.
  const draftRef = useRef<EditorSnapshot>({ title: '', content: '' })

  const applyDraft = useCallback((next: EditorSnapshot) => {
    draftRef.current = next
    setTitle(next.title)
    setContent(next.content)
  }, [])

  // Load existing note and folder list on mount.
  useEffect(() => {
    void (async () => {
      try {
        const stats = await api.listFolders()
        setFolders(stats.folders)
        setDefaultFolderName(stats.defaultFolderName)
        if (noteIdRef.current != null) {
          const note = await api.getNote(noteIdRef.current)
          applyDraft({ title: note.title, content: note.content })
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
  }, [applyDraft])

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

  // ---- Edit mode: draft history + IME-driven enter / exit ----

  const syncHistoryState = useCallback(() => {
    setCanUndo(undoStackRef.current.length > 0)
    setCanRedo(redoStackRef.current.length > 0)
  }, [])

  /** Enter edit mode; each session starts with an empty undo/redo stack. */
  const enterEditing = useCallback(() => {
    if (editingRef.current) return
    editingRef.current = true
    setEditing(true)
    // Editing raw text requires leaving the rendered preview.
    setPreviewOpen(false)
    undoStackRef.current = []
    redoStackRef.current = []
    lastEditAtRef.current = 0
    // A keyboard that is still closing belongs to the previous session, so its
    // inset drop must not immediately end the session that just started.
    prevKbInsetRef.current = 0
    syncHistoryState()
  }, [syncHistoryState])

  /** Leave edit mode without discarding the draft; blurring hides the IME. */
  const exitEditing = useCallback(() => {
    if (!editingRef.current) return
    editingRef.current = false
    setEditing(false)
    lastEditAtRef.current = 0
    titleRef.current?.blur()
    textareaRef.current?.blur()
  }, [])

  /** Record the pre-edit draft; keystrokes within the merge window share a step. */
  const recordEdit = useCallback(
    (before: EditorSnapshot) => {
      const now = performance.now()
      const startsStep = now - lastEditAtRef.current > UNDO_MERGE_MS
      if (startsStep) {
        undoStackRef.current.push(before)
        if (undoStackRef.current.length > UNDO_LIMIT) undoStackRef.current.shift()
      }
      lastEditAtRef.current = now
      // Typing after an undo discards the redo branch.
      const hadRedo = redoStackRef.current.length > 0
      redoStackRef.current = []
      if (startsStep || hadRedo) syncHistoryState()
    },
    [syncHistoryState],
  )

  // Snapshots come from draftRef, not from the render closure: it always holds
  // the exact draft on screen, even if a state update is still settling.
  const undoEdit = useCallback(() => {
    const previous = undoStackRef.current.pop()
    if (!previous) return
    redoStackRef.current.push(draftRef.current)
    lastEditAtRef.current = 0
    applyDraft(previous)
    syncHistoryState()
  }, [applyDraft, syncHistoryState])

  const redoEdit = useCallback(() => {
    const next = redoStackRef.current.pop()
    if (!next) return
    undoStackRef.current.push(draftRef.current)
    if (undoStackRef.current.length > UNDO_LIMIT) undoStackRef.current.shift()
    lastEditAtRef.current = 0
    applyDraft(next)
    syncHistoryState()
  }, [applyDraft, syncHistoryState])

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

  // Track manual scrolling so caret auto-follow doesn't fight the user.
  useEffect(() => {
    const body = bodyRef.current
    if (!body) return
    const onScroll = () => {
      if (programmaticRef.current) {
        programmaticRef.current = false
        return
      }
      userScrollRef.current = true
    }
    body.addEventListener('scroll', onScroll, { passive: true })
    return () => body.removeEventListener('scroll', onScroll)
  }, [])

  // Measure the caret's vertical offset inside the textarea via a hidden
  // mirror that clones the text up to the cursor.
  const caretOffset = useCallback(() => {
    const ta = textareaRef.current
    const mirror = mirrorRef.current
    if (!ta || !mirror) return 0
    const cs = getComputedStyle(ta)
    mirror.style.cssText = [
      'position:fixed',
      'top:0',
      'left:0',
      'visibility:hidden',
      'pointer-events:none',
      'white-space:pre-wrap',
      'overflow-wrap:break-word',
      'word-break:break-word',
      `width:${ta.clientWidth}px`,
      `font:${cs.font}`,
      `line-height:${cs.lineHeight}`,
      `letter-spacing:${cs.letterSpacing}`,
      'border:0',
      'margin:0',
      'padding:0',
    ].join(';')
    mirror.innerHTML =
      ta.value
        .slice(0, ta.selectionStart)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/\n/g, '<br>') + '<span data-caret></span>'
    const caret = mirror.querySelector<HTMLElement>('[data-caret]')
    return caret ? caret.offsetTop : 0
  }, [])

  // Scroll the caret to a safe distance above the keyboard if it is hidden;
  // `force` bypasses the "user is reading" suppression.
  const scrollCaretIntoView = useCallback(
    (force: boolean) => {
      if (kbInset <= 0) return
      if (userScrollRef.current && !force) return
      const ta = textareaRef.current
      const body = bodyRef.current
      const vv = window.visualViewport
      if (!ta || !body || !vv) return
      const kbTop =
        visualKbInset > 0
          ? vv.offsetTop + vv.height
          : window.innerHeight - nativeKbInset
      const SAFE = 20
      const bodyRect = body.getBoundingClientRect()
      // The hidden mirror clones the textarea's content box (padding 0), so
      // caretOffset() is relative to the content start; subtracting the
      // textarea's own scrollTop yields the caret's offset inside its visible
      // box. For long notes the textarea is the primary scroll surface, so the
      // caret must first be brought into its viewport before the body can align
      // it above the keyboard.
      const cs = getComputedStyle(ta)
      const taPadTop = parseFloat(cs.paddingTop) || 0
      const contentVisible = ta.clientHeight - taPadTop
      let caretInView = caretOffset() - ta.scrollTop
      const clamped = Math.min(Math.max(caretInView, 0), contentVisible)
      if (clamped !== caretInView) {
        ta.scrollTop += clamped - caretInView
        caretInView = clamped
      }
      // Anchor on the textarea's real viewport top (which already accounts for
      // the title input above it and any body scroll) plus its padding.
      const taRect = ta.getBoundingClientRect()
      const caretScreenTop = taRect.top + taPadTop + caretInView
      const scrollBody = (delta: number) => {
        programmaticRef.current = true
        body.scrollTop += delta
        // If the assignment is clamped to the same value no scroll event fires,
        // so clear the flag via a timer instead of waiting for it.
        setTimeout(() => {
          programmaticRef.current = false
        }, 0)
      }
      if (caretScreenTop > kbTop - SAFE) {
        scrollBody(caretScreenTop - (kbTop - SAFE))
      } else if (caretScreenTop < bodyRect.top + 8) {
        scrollBody(-(bodyRect.top + 8 - caretScreenTop))
      }
    },
    [kbInset, caretOffset, visualKbInset, nativeKbInset],
  )

  // Re-follow the caret only when the keyboard actually appears; candidate-bar
  // height tweaks while it is already open must not yank the viewport away from
  // where the user is reading. A fall back to zero means the user dismissed the
  // IME, so edit mode ends together with the caret and the action bar.
  useEffect(() => {
    const wasOpen = prevKbInsetRef.current > 0
    const appeared = kbInset > 0 && !wasOpen
    prevKbInsetRef.current = kbInset
    if (appeared) {
      userScrollRef.current = false
      scrollCaretIntoView(true)
    } else if (wasOpen && kbInset === 0) {
      exitEditing()
    }
  }, [kbInset, scrollCaretIntoView, exitEditing])

  // Follow the caret on content edits and keyboard-geometry changes (candidate
  // bar). Only a content edit ends "reading mode"; an inset-only change must
  // not pull the viewport away from where the user is reading.
  useEffect(() => {
    const typed = content !== prevContentRef.current
    prevContentRef.current = content
    if (kbInset <= 0) return
    if (typed) userScrollRef.current = false
    scrollCaretIntoView(false)
  }, [content, kbInset, scrollCaretIntoView])

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
      applyDraft({ title: note.title, content: note.content })
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

  /** A tap on empty body space edits the body: focus and put the caret at the end. */
  const focusContent = () => {
    const ta = textareaRef.current
    if (!ta) return
    ta.focus()
    const end = ta.value.length
    ta.setSelectionRange(end, end)
  }

  const handleBodyClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (previewOpen) return
    // Taps inside a field are native and place the caret at the tap point.
    if ((e.target as HTMLElement).closest('input, textarea, button, a')) return
    focusContent()
  }

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
              onClick={undoEdit}
              onPointerDown={keepFieldFocus}
              aria-label="撤销"
              disabled={!canUndo}
            >
              <IconUndo size={22} />
            </button>
            <button
              type="button"
              className="edit-bar-btn"
              onClick={redoEdit}
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
            onClick={() => setPreviewOpen((v) => !v)}
            aria-label="预览"
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
            onClick={handleBodyClick}
            style={
              kbInset
                ? { paddingBottom: `calc(${kbInset}px + var(--safe-bottom))` }
                : undefined
            }
          >
            <input
              ref={titleRef}
              className="editor-title-input"
              value={title}
              onChange={(e) => {
                recordEdit(draftRef.current)
                applyDraft({ ...draftRef.current, title: e.target.value })
              }}
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
            {previewOpen ? (
              <div
                className="markdown-preview"
                dangerouslySetInnerHTML={{ __html: renderMarkdown(content) }}
              />
            ) : (
              <textarea
                ref={textareaRef}
                className="editor-content"
                value={content}
                onChange={(e) => {
                  recordEdit(draftRef.current)
                  applyDraft({ ...draftRef.current, content: e.target.value })
                }}
                onFocus={enterEditing}
                onSelect={() => {
                  if (kbInset > 0) {
                    userScrollRef.current = false
                    scrollCaretIntoView(true)
                  }
                }}
                placeholder="开始记录…"
              />
            )}
          </div>
          <div ref={mirrorRef} className="caret-mirror" aria-hidden="true" />
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
