import { lazy, Suspense, useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { convertFileSrc } from '@tauri-apps/api/core'
import { open as openDialog, save } from '@tauri-apps/plugin-dialog'
import { readFile } from '@tauri-apps/plugin-fs'
import { api, chatApi, mediaApi } from '../../api'
import {
  computeKbInset,
  diffLines,
  formatAmPmDateTime,
  formatDateTime,
  fmtVersion,
  friendlyError,
  safeFileName,
} from '../../utils'
import type { AgentModelInfo, Folder, MediaJob, MediaJobEvent, NoteVersion } from '../../types'
import { ConfirmDialog, Modal } from '../../components/ui'
import { toast } from '../../toast'
import { getSaveStrategy } from '../../saveStrategy'
import { getEditorPrefs } from '../../editor/prefs'
import {
  getMermaidEnhance,
  subscribeMermaidEnhance,
} from '../../editor/mermaidPrefs'
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
  IconImage,
  IconMic,
  IconPlus,
  IconRedo,
  IconRestore,
  IconSave,
  IconSpeaker,
  IconTrash,
  IconUndo,
  IconVideo,
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

/** Media jobs push status through a Channel; wait for the terminal snapshot. */
const JOB_TIMEOUT_MS = 10 * 60 * 1000

function submitAndWatch(
  input: Parameters<typeof mediaApi.submit>[0],
  onEvent?: (event: MediaJobEvent) => void,
  onSubmitted?: (job: MediaJob) => void,
): Promise<MediaJob> {
  return new Promise((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true
        reject(new Error('媒体作业超时，请稍后重试'))
      }
    }, JOB_TIMEOUT_MS)
    const finish = (job: MediaJob) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(job)
    }
    mediaApi
      .submit(input, (event) => {
        onEvent?.(event)
        if (
          event.status === 'succeeded' ||
          event.status === 'failed' ||
          event.status === 'cancelled'
        ) {
          mediaApi.get(event.jobId).then(finish).catch(reject)
        }
      })
      .then((job) => onSubmitted?.(job))
      .catch((error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(error)
      })
  })
}

/** OpenAI accepts 25MB per transcription request. */
const MAX_AUDIO_BYTES = 25 * 1024 * 1024

function audioMime(fileName: string): string {
  const ext = fileName.split('.').pop()?.toLowerCase() ?? ''
  switch (ext) {
    case 'wav':
      return 'audio/wav'
    case 'm4a':
    case 'mp4':
      return 'audio/mp4'
    case 'ogg':
    case 'opus':
      return 'audio/ogg'
    case 'webm':
      return 'audio/webm'
    case 'flac':
      return 'audio/flac'
    default:
      return 'audio/mpeg'
  }
}

/** Chunked conversion keeps large audio payloads from overflowing the stack. */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

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

  // Media dialogs: AI illustration and read-aloud.
  const [imageOpen, setImageOpen] = useState(false)
  const [imageModels, setImageModels] = useState<AgentModelInfo[]>([])
  const [imageModelId, setImageModelId] = useState('')
  const [imagePrompt, setImagePrompt] = useState('')
  const [imageBusy, setImageBusy] = useState(false)
  const [imageResult, setImageResult] = useState<{ url: string; alt: string } | null>(null)
  const [ttsOpen, setTtsOpen] = useState(false)
  const [ttsModels, setTtsModels] = useState<AgentModelInfo[]>([])
  const [ttsModelId, setTtsModelId] = useState('')
  const [ttsText, setTtsText] = useState('')
  const [ttsBusy, setTtsBusy] = useState(false)
  const [ttsUrl, setTtsUrl] = useState('')
  const [videoOpen, setVideoOpen] = useState(false)
  const [videoModels, setVideoModels] = useState<AgentModelInfo[]>([])
  const [videoModelId, setVideoModelId] = useState('')
  const [videoPrompt, setVideoPrompt] = useState('')
  const [videoBusy, setVideoBusy] = useState(false)
  const [videoUrl, setVideoUrl] = useState('')
  const [videoJobId, setVideoJobId] = useState<number | null>(null)
  const [videoProgress, setVideoProgress] = useState(0)
  const [videoStatus, setVideoStatus] = useState<MediaJob['status'] | ''>('')
  const [asrOpen, setAsrOpen] = useState(false)
  const [asrModels, setAsrModels] = useState<AgentModelInfo[]>([])
  const [asrModelId, setAsrModelId] = useState('')
  const [asrFileName, setAsrFileName] = useState('')
  const [asrMime, setAsrMime] = useState('audio/mpeg')
  const [asrData, setAsrData] = useState('')
  const [asrLanguage, setAsrLanguage] = useState('')
  const [asrBusy, setAsrBusy] = useState(false)
  const [asrText, setAsrText] = useState('')

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
  const mermaidEnhance = useSyncExternalStore(
    subscribeMermaidEnhance,
    getMermaidEnhance,
    getMermaidEnhance,
  )

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
        const receipt = await api.saveNote({
          id: noteIdRef.current,
          title: t,
          content: c,
          folderId: currentFolderId,
        })
        setUpdatedAt(receipt.updatedAt)
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

  const handleRestorePrevious = async () => {
    if (noteIdRef.current == null) return
    try {
      const note = await api.restorePreviousRevision(noteIdRef.current)
      setTitle(note.title)
      setContent(note.content)
      setCurrentFolderId(note.folderId)
      setCreatedAt(note.createdAt)
      setUpdatedAt(note.updatedAt)
      lastSavedRef.current = { title: note.title, content: note.content }
      setDirty(false)
      setSaveState('clean')
      toast('已恢复上一版')
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

  /** Version bodies are not part of the list; fetch one when it is shown. */
  const openVersionPreview = async (v: NoteVersion) => {
    setVersionsOpen(false)
    try {
      setPreviewVersion({ ...v, content: await api.getVersionContent(v.id) })
    } catch (e) {
      console.error(e)
      toast(friendlyError(e))
    }
  }

  const openVersionCompare = async (v: NoteVersion) => {
    try {
      setCompareVersion({ ...v, content: await api.getVersionContent(v.id) })
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
      const receipt = await api.saveNote({
        id: noteIdRef.current,
        title,
        content,
        folderId: fid,
      })
      setUpdatedAt(receipt.updatedAt)
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

  const openImageDialog = async () => {
    try {
      const settings = await chatApi.settings()
      const models = settings.models.filter((item) => item.kind === 'image' && item.configured)
      if (models.length === 0) {
        toast('请先在设置 → AI 助理中添加并配置图像模型')
        return
      }
      setImageModels(models)
      setImageModelId(models[0].id)
      setImagePrompt(title.trim() || content.trim().slice(0, 200))
      setImageResult(null)
      setImageOpen(true)
    } catch (e) {
      toast(friendlyError(e))
    }
  }

  const generateImage = async () => {
    const prompt = imagePrompt.trim()
    if (!prompt || !imageModelId) {
      toast('请填写提示词')
      return
    }
    setImageBusy(true)
    try {
      const done = await submitAndWatch({
        kind: 'image',
        modelEntry: imageModelId,
        params: { prompt },
      })
      if (done.status !== 'succeeded' || done.assetId == null) {
        toast(done.error || '图像生成失败')
        return
      }
      const path = await mediaApi.assetPath(done.assetId)
      setImageResult({ url: convertFileSrc(path), alt: prompt })
    } catch (e) {
      toast(friendlyError(e))
    } finally {
      setImageBusy(false)
    }
  }

  const insertGeneratedImage = () => {
    const result = imageResult
    if (!result) return
    const alt = result.alt.replace(/[[\]\n]/g, ' ').slice(0, 60)
    setContent((prev) => `${prev}${prev.trim() ? '\n\n' : ''}![${alt}](<${result.url}>)\n`)
    setImageOpen(false)
    setImageResult(null)
    toast('已插入图片')
  }

  const openTtsDialog = async () => {
    const body = content.trim()
    if (!body) {
      toast('当前笔记没有可朗读的内容')
      return
    }
    try {
      const settings = await chatApi.settings()
      const models = settings.models.filter((item) => item.kind === 'tts' && item.configured)
      if (models.length === 0) {
        toast('请先在设置 → AI 助理中添加并配置语音模型')
        return
      }
      setTtsModels(models)
      setTtsModelId(models[0].id)
      setTtsText(body.slice(0, 4000))
      setTtsUrl('')
      setTtsOpen(true)
    } catch (e) {
      toast(friendlyError(e))
    }
  }

  const generateSpeech = async () => {
    const text = ttsText.trim()
    if (!text || !ttsModelId) {
      toast('请填写朗读文本')
      return
    }
    setTtsBusy(true)
    try {
      const done = await submitAndWatch({
        kind: 'tts',
        modelEntry: ttsModelId,
        params: { text },
      })
      if (done.status !== 'succeeded' || done.assetId == null) {
        toast(done.error || '语音生成失败')
        return
      }
      const path = await mediaApi.assetPath(done.assetId)
      setTtsUrl(convertFileSrc(path))
    } catch (e) {
      toast(friendlyError(e))
    } finally {
      setTtsBusy(false)
    }
  }

  const openVideoDialog = async () => {
    try {
      const settings = await chatApi.settings()
      const models = settings.models.filter((item) => item.kind === 'video' && item.configured)
      if (models.length === 0) {
        toast('请先在设置 → AI 助理中添加并配置视频模型')
        return
      }
      setVideoModels(models)
      setVideoModelId(models[0].id)
      setVideoPrompt(title.trim() || content.trim().slice(0, 200))
      setVideoUrl('')
      setVideoOpen(true)
    } catch (e) {
      toast(friendlyError(e))
    }
  }

  const generateVideo = async () => {
    const prompt = videoPrompt.trim()
    if (!prompt || !videoModelId) {
      toast('请填写提示词')
      return
    }
    setVideoBusy(true)
    setVideoProgress(0)
    setVideoStatus('pending')
    try {
      const done = await submitAndWatch(
        {
          kind: 'video',
          modelEntry: videoModelId,
          params: { prompt },
        },
        (event) => {
          setVideoStatus(event.status)
          setVideoProgress(event.progress)
        },
        (job) => setVideoJobId(job.id),
      )
      if (done.status === 'cancelled') {
        toast('视频生成已取消')
        return
      }
      if (done.status !== 'succeeded' || done.assetId == null) {
        toast(done.error || '视频生成失败')
        return
      }
      const path = await mediaApi.assetPath(done.assetId)
      setVideoUrl(convertFileSrc(path))
    } catch (e) {
      toast(friendlyError(e))
    } finally {
      setVideoBusy(false)
      setVideoJobId(null)
    }
  }

  const cancelVideoJob = async () => {
    if (!videoJobId) return
    try {
      await mediaApi.cancel(videoJobId)
      toast('已请求取消视频任务')
    } catch (e) {
      toast(friendlyError(e))
    }
  }

  const openAsrDialog = async () => {
    try {
      const settings = await chatApi.settings()
      const models = settings.models.filter((item) => item.kind === 'asr' && item.configured)
      if (models.length === 0) {
        toast('请先在设置 → AI 助理中添加并配置语音转写模型')
        return
      }
      setAsrModels(models)
      setAsrModelId(models[0].id)
      setAsrFileName('')
      setAsrData('')
      setAsrLanguage('')
      setAsrText('')
      setAsrOpen(true)
    } catch (e) {
      toast(friendlyError(e))
    }
  }

  const pickAudioFile = async () => {
    try {
      const picked = await openDialog({
        multiple: false,
        filters: [
          { name: '音频', extensions: ['mp3', 'wav', 'm4a', 'ogg', 'opus', 'webm', 'flac'] },
        ],
      })
      if (typeof picked !== 'string') return
      const bytes = await readFile(picked)
      if (bytes.length > MAX_AUDIO_BYTES) {
        toast('音频超过 25MB，请先压缩或分段')
        return
      }
      const name = picked.split(/[\\/]/).pop() ?? 'audio'
      setAsrFileName(name)
      setAsrMime(audioMime(name))
      setAsrData(bytesToBase64(bytes))
      setAsrText('')
    } catch (e) {
      toast(friendlyError(e))
    }
  }

  const transcribeAudio = async () => {
    if (!asrData) {
      toast('请先选择音频文件')
      return
    }
    if (!asrModelId) return
    setAsrBusy(true)
    try {
      const asset = await mediaApi.storeAsset({ mime: asrMime, data: asrData })
      const params: Record<string, unknown> = { assetId: asset.id }
      const language = asrLanguage.trim()
      if (language) params.language = language
      const done = await submitAndWatch({
        kind: 'asr',
        modelEntry: asrModelId,
        params,
      })
      if (done.status !== 'succeeded' || !done.result) {
        toast(done.error || '语音转写失败')
        return
      }
      const parsed = JSON.parse(done.result) as { text?: string }
      if (!parsed.text) {
        toast('转写结果为空')
        return
      }
      setAsrText(parsed.text)
    } catch (e) {
      toast(friendlyError(e))
    } finally {
      setAsrBusy(false)
    }
  }

  const insertTranscript = () => {
    const text = asrText.trim()
    if (!text) return
    setContent((prev) => `${prev}${prev.trim() ? '\n\n' : ''}${text}\n`)
    setAsrOpen(false)
    setAsrText('')
    toast('转写已插入笔记')
  }

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
            onClick={() => void openImageDialog()}
            aria-label="AI 插图"
          >
            <IconImage size={20} />
          </button>
          <button
            type="button"
            className="icon-btn"
            onClick={() => void openTtsDialog()}
            aria-label="朗读笔记"
          >
            <IconSpeaker size={20} />
          </button>
          <button
            type="button"
            className="icon-btn"
            onClick={() => void openVideoDialog()}
            aria-label="AI 视频"
          >
            <IconVideo size={20} />
          </button>
          <button
            type="button"
            className="icon-btn"
            onClick={() => void openAsrDialog()}
            aria-label="语音转写"
          >
            <IconMic size={20} />
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
                    enhance={mermaidEnhance}
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
                          enhance={mermaidEnhance}
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
            <>
              <button
                type="button"
                className="icon-btn accent"
                onClick={() => void handleRestorePrevious()}
                aria-label="恢复上一版"
              >
                <IconRestore size={20} />
              </button>
              <button
                type="button"
                className="icon-btn accent"
                onClick={() => void handleCreateVersion()}
                aria-label="新建版本"
              >
                <IconPlus size={20} />
              </button>
            </>
          }
        >
          {versions.length === 0 && <div className="empty-state">暂无版本</div>}
          {versions.map((v) => (
            <div key={v.id} className="version-item">
              <div
                className="version-main"
                onClick={() => void openVersionPreview(v)}
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
                  onClick={() => void openVersionPreview(v)}
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
                  onClick={() => void openVersionCompare(v)}
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

      {imageOpen && (
        <Modal
          title="AI 插图"
          onClose={() => {
            if (!imageBusy) setImageOpen(false)
          }}
          footer={
            <div style={{ display: 'flex', gap: 10 }}>
              <button
                type="button"
                className="btn btn-plain"
                disabled={imageBusy}
                onClick={() => setImageOpen(false)}
              >
                取消
              </button>
              <button
                type="button"
                className="btn btn-plain"
                disabled={imageBusy || !imagePrompt.trim()}
                onClick={() => void generateImage()}
              >
                {imageBusy ? '生成中…' : imageResult ? '重新生成' : '生成'}
              </button>
              {imageResult && (
                <button type="button" className="btn btn-primary" onClick={insertGeneratedImage}>
                  插入图片
                </button>
              )}
            </div>
          }
        >
          <div className="form-field">
            <span className="form-label">图像模型</span>
            <select
              className="form-input"
              value={imageModelId}
              onChange={(e) => setImageModelId(e.target.value)}
            >
              {imageModels.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.label}
                </option>
              ))}
            </select>
          </div>
          <div className="form-field">
            <span className="form-label">提示词</span>
            <textarea
              className="form-input"
              rows={4}
              value={imagePrompt}
              onChange={(e) => setImagePrompt(e.target.value)}
              placeholder="描述想要的插图"
            />
          </div>
          {imageResult && (
            <img className="ai-image-preview" src={imageResult.url} alt={imageResult.alt} />
          )}
        </Modal>
      )}

      {ttsOpen && (
        <Modal
          title="朗读笔记"
          onClose={() => {
            if (!ttsBusy) setTtsOpen(false)
          }}
          footer={
            <div style={{ display: 'flex', gap: 10 }}>
              <button
                type="button"
                className="btn btn-plain"
                disabled={ttsBusy}
                onClick={() => setTtsOpen(false)}
              >
                关闭
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={ttsBusy || !ttsText.trim() || ttsText.length > 4000}
                onClick={() => void generateSpeech()}
              >
                {ttsBusy ? '合成中…' : ttsUrl ? '重新合成' : '合成语音'}
              </button>
            </div>
          }
        >
          <div className="form-field">
            <span className="form-label">语音模型</span>
            <select
              className="form-input"
              value={ttsModelId}
              onChange={(e) => setTtsModelId(e.target.value)}
            >
              {ttsModels.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.label}
                </option>
              ))}
            </select>
          </div>
          <div className="form-field">
            <span className="form-label">朗读文本（{ttsText.length}/4000）</span>
            <textarea
              className="form-input"
              rows={6}
              maxLength={4000}
              value={ttsText}
              onChange={(e) => setTtsText(e.target.value)}
            />
            <p className="settings-note">最多 4000 字，超出请先分段。</p>
          </div>
          {ttsUrl && <audio className="ai-audio-player" controls autoPlay src={ttsUrl} />}
        </Modal>
      )}

      {videoOpen && (
        <Modal
          title="AI 视频"
          onClose={() => {
            if (!videoBusy) setVideoOpen(false)
          }}
          footer={
            <div style={{ display: 'flex', gap: 10 }}>
              <button
                type="button"
                className="btn btn-plain"
                disabled={videoBusy}
                onClick={() => setVideoOpen(false)}
              >
                关闭
              </button>
              {videoBusy && (
                <button
                  type="button"
                  className="btn btn-plain"
                  disabled={!videoJobId}
                  onClick={() => void cancelVideoJob()}
                >
                  取消任务
                </button>
              )}
              <button
                type="button"
                className="btn btn-primary"
                disabled={videoBusy || !videoPrompt.trim()}
                onClick={() => void generateVideo()}
              >
                {videoBusy ? '生成中…' : videoUrl ? '重新生成' : '生成视频'}
              </button>
            </div>
          }
        >
          <div className="form-field">
            <span className="form-label">视频模型</span>
            <select
              className="form-input"
              value={videoModelId}
              onChange={(e) => setVideoModelId(e.target.value)}
            >
              {videoModels.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.label}
                </option>
              ))}
            </select>
          </div>
          <div className="form-field">
            <span className="form-label">提示词</span>
            <textarea
              className="form-input"
              rows={4}
              value={videoPrompt}
              onChange={(e) => setVideoPrompt(e.target.value)}
              placeholder="描述想要的视频画面"
            />
          </div>
          {videoBusy && (
            <div className="form-field">
              <span className="form-label">
                {videoStatus === 'pending' ? '排队中…' : `生成中 ${videoProgress}%`}
              </span>
              <div className="media-progress">
                <span style={{ width: `${Math.min(100, Math.max(0, videoProgress))}%` }} />
              </div>
            </div>
          )}
          {videoUrl && (
            <video className="ai-video-player" controls autoPlay src={videoUrl} />
          )}
          <p className="settings-note">视频生成通常需要数分钟；生成期间可取消任务。</p>
        </Modal>
      )}

      {asrOpen && (
        <Modal
          title="语音转写"
          onClose={() => {
            if (!asrBusy) setAsrOpen(false)
          }}
          footer={
            <div style={{ display: 'flex', gap: 10 }}>
              <button
                type="button"
                className="btn btn-plain"
                disabled={asrBusy}
                onClick={() => setAsrOpen(false)}
              >
                关闭
              </button>
              <button
                type="button"
                className="btn btn-plain"
                disabled={asrBusy || !asrData}
                onClick={() => void transcribeAudio()}
              >
                {asrBusy ? '转写中…' : asrText ? '重新转写' : '开始转写'}
              </button>
              {asrText && (
                <button type="button" className="btn btn-primary" onClick={insertTranscript}>
                  插入笔记
                </button>
              )}
            </div>
          }
        >
          <div className="form-field">
            <span className="form-label">转写模型</span>
            <select
              className="form-input"
              value={asrModelId}
              onChange={(e) => setAsrModelId(e.target.value)}
            >
              {asrModels.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.label}
                </option>
              ))}
            </select>
          </div>
          <div className="form-field">
            <span className="form-label">音频文件</span>
            <div className="chat-key-actions">
              <button
                type="button"
                className="restore-default"
                disabled={asrBusy}
                onClick={() => void pickAudioFile()}
              >
                选择音频文件
              </button>
              <span className="model-meta">{asrFileName || '未选择'}</span>
            </div>
            <p className="settings-note">支持 mp3/wav/m4a/ogg/webm/flac，单文件不超过 25MB。</p>
          </div>
          <div className="form-field">
            <span className="form-label">语言（选填，如 zh / en）</span>
            <input
              className="form-input"
              value={asrLanguage}
              onChange={(e) => setAsrLanguage(e.target.value)}
              placeholder="留空由模型自动识别"
              autoComplete="off"
            />
          </div>
          <div className="form-field">
            <span className="form-label">转写结果（可编辑后插入）</span>
            <textarea
              className="form-input"
              rows={6}
              value={asrText}
              onChange={(e) => setAsrText(e.target.value)}
              placeholder="转写完成后显示在这里"
            />
          </div>
        </Modal>
      )}
    </div>
  )
}
