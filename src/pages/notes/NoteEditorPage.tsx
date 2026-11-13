import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { save } from '@tauri-apps/plugin-dialog'
import { api, assetApi, docApi } from '../../api'
import {
  bytesToBase64,
  computeKbInset,
  diffLines,  
  formatAmPmDateTime,
  formatDateTime,
  fmtVersion,
  friendlyError,
  safeFileName,
} from '../../utils'
import { hasAssetRefs } from '../../assets'
import type { Doc, Folder, NoteVersion } from '../../types'
import { ConfirmDialog, Modal } from '../../components/ui'
import { toast } from '../../toast'
import { useEdgeBack } from '../../hooks'
import { usePhysicalBack } from '../../system/backButton'
import { getSaveStrategy } from '../../saveStrategy'
import { getEditorPrefs } from '../../editor/prefs'
import {
  getMermaidEnhance,
  subscribeMermaidEnhance,
} from '../../editor/mermaidPrefs'
import {
  MAX_SPLIT_RATIO,
  MIN_SPLIT_RATIO,
  getLayoutPrefs,
  setLayoutPrefs,
} from '../../editor/layout'
import SplitHandle from '../../components/SplitHandle'
import ImageZoom from '../../components/ImageZoom'
import { subscribeImageZoom, type ZoomImage } from '../../system/imageZoom'
import {
  MarkdownEditor,
  type MarkdownEditorHandle,
} from '../../components/MarkdownEditor'
import type { MarkdownPreviewHandle } from '../../components/MarkdownPreview'
import {
  IconBack,
  IconCalendar,
  IconCheck,
  IconClock,
  IconClose,
  IconCompare,
  IconExport,
  IconEye,
  IconFolder,
  IconImage,
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
  /** Notes folder for a brand-new note; undefined/null means the default. */
  folderId?: number | null
  /** Which domain document this editor is bound to; diary reuses it verbatim. */
  mode?: 'note' | 'diary'
  /** Target day when `mode` is `diary` and a new scaffold is created. */
  diaryDate?: string
  onBack: () => void
}

type SaveState = 'clean' | 'dirty' | 'saving'

/** Prevent a bar action from stealing focus, so the IME and caret stay put. */
const keepFieldFocus = (e: React.PointerEvent<HTMLButtonElement>) => e.preventDefault()

/** How long a programmatic scroll suppresses the other pane's scroll events. */
const SYNC_GUARD_MS = 160

/** Scroll idle time before a partially collapsed metadata head snaps shut/open. */
const META_SNAP_IDLE_MS = 120

/** Duration of the eased snap that finishes a partially collapsed head. */
const META_SNAP_MS = 220

/** Position/opacity transition of the split panes (kept in sync with index.css). */
const PREVIEW_ANIM_MS = 1000

/** Quick-syntax actions offered by the bar above the soft keyboard. */
type QuickAction =
  | 'heading'
  | 'bold'
  | 'italic'
  | 'list'
  | 'task'
  | 'quote'
  | 'code'
  | 'link'
  | 'image'

const QUICK_ACTIONS: Array<{ action: QuickAction; label: string }> = [
  { action: 'heading', label: '标题' },
  { action: 'bold', label: '加粗' },
  { action: 'italic', label: '斜体' },
  { action: 'list', label: '列表' },
  { action: 'task', label: '待办' },
  { action: 'quote', label: '引用' },
  { action: 'code', label: '代码' },
  { action: 'link', label: '链接' },
  { action: 'image', label: '图片' },
]

/** Space reserved below the editor content so the quick bar never covers text. */
const QUICK_BAR_SPACE = 60

function hhmm(ts: number): string {
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** Render a document's full frontmatter as read-only YAML lines. */
function docMetaYaml(doc: Doc): string {
  const lines = [
    `kind: ${doc.kind}`,
    `title: ${doc.title}`,
    `created_at: ${doc.createdAt}`,
    `updated_at: ${doc.updatedAt}`,
  ]
  for (const [k, v] of Object.entries(doc.fields)) {
    if (v === null || v === undefined || v === '') continue
    const text =
      typeof v === 'boolean'
        ? v
          ? 'true'
          : 'false'
        : Array.isArray(v)
          ? v.join(', ')
          : String(v)
    lines.push(`${k}: ${text}`)
  }
  return lines.join('\n')
}

export default function NoteEditorPage({
  noteId,
  folderId = null,
  mode = 'note',
  diaryDate,
  onBack,
}: Props) {
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [currentFolderId, setCurrentFolderId] = useState<number | null>(folderId)
  const [folders, setFolders] = useState<Folder[]>([])
  const [defaultFolderName, setDefaultFolderName] = useState('默认')
  const [folderMenuOpen, setFolderMenuOpen] = useState(false)
  /** Anchor rect of the folder button, captured when the popover opens. */
  const [folderAnchor, setFolderAnchor] = useState<{ left: number; top: number } | null>(null)
  /** Path / kind / generated frontmatter of the bound doc (empty for new docs). */
  const [docPath, setDocPath] = useState('')
  const [metaYaml, setMetaYaml] = useState('')
  const [saveState, setSaveState] = useState<SaveState>('clean')
  const [dirty, setDirty] = useState(false)
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null)
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

  const [zoomImage, setZoomImage] = useState<ZoomImage | null>(null)

  // The divider position is persisted, but the preview always starts closed:
  // the editor is the default view and the eye button renders the preview on
  // demand. A closed preview renders the editor at the full 100% share.
  const [splitRatio, setSplitRatio] = useState(() => getLayoutPrefs().ratio)
  /** Editor share currently rendered; 100% while the preview is rolled away. */
  const [renderedRatio, setRenderedRatio] = useState(MAX_SPLIT_RATIO)
  const [previewOpen, setPreviewOpen] = useState(false)
  const [previewMounted, setPreviewMounted] = useState(false)
  const [previewReady, setPreviewReady] = useState(false)
  const isSplit = previewMounted
  const previewOpenRef = useRef(false)
  const previewCloseTimerRef = useRef(0)
  const previewOpenFramesRef = useRef<number[]>([])

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
  /**
   * Collapsible metadata head: the wrapper is clipped to the live collapse
   * height while the inner block keeps its natural height for measurement.
   */
  const metaWrapRef = useRef<HTMLDivElement>(null)
  const metaInnerRef = useRef<HTMLDivElement>(null)
  const metaHeightRef = useRef(0)
  const metaExpandedRef = useRef(false)
  const [metaExpanded, setMetaExpanded] = useState(false)
  /** Imperative toggle exposed by the collapse controller for the head button. */
  const metaToggleRef = useRef<(() => void) | null>(null)
  const lastSavedRef = useRef<{ title: string; content: string }>({
    title: '',
    content: '',
  })
  const bodyRef = useRef<HTMLDivElement>(null)
  const titleRef = useRef<HTMLInputElement>(null)
  const editorRef = useRef<MarkdownEditorHandle>(null)
  const previewRef = useRef<MarkdownPreviewHandle>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

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

  // Load the bound document plus the folder list on mount; any VFS doc opens
  // here and new diary days start from the date title.
  useEffect(() => {
    void (async () => {
      try {
        const stats = await api.listFolders()
        setFolders(stats.folders)
        setDefaultFolderName(stats.defaultFolderName)
        if (noteIdRef.current != null) {
          // Generic doc load: every kind opens editable, frontmatter stays
          // system-owned and is rendered read-only below the toolbar.
          const doc = await docApi.get(noteIdRef.current)
          setTitle(doc.title)
          setContent(doc.content)
          setCurrentFolderId(doc.folderId)
          setUpdatedAt(doc.updatedAt)
          setDocPath(doc.path)
          setMetaYaml(docMetaYaml(doc))
          lastSavedRef.current = {
            title: doc.title,
            content: doc.content,
          }
        } else if (mode === 'diary' && diaryDate) {
          setTitle(diaryDate)
        }
      } catch (e) {
        console.error('加载文档失败', e)
        toast(friendlyError(e))
      }
    })()
  }, [mode, diaryDate])

  // Skip saving a brand-new note that only contains whitespace.
  const isBlank = !title.trim() && !content.trim()

  // Pictures rendered inside the preview and the CodeMirror widgets ask for the
  // enlarged viewer through a window event (they are outside this React tree).
  useEffect(() => subscribeImageZoom(setZoomImage), [])

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
        const note =
          mode === 'diary' && diaryDate
            ? await api.createDiary({ date: diaryDate, title: t, content: c })
            : await api.createNote({ title: t, content: c, folderId: currentFolderId })
        noteIdRef.current = note.id
        setHasNote(true)
        setUpdatedAt(note.updatedAt)
      } else if (mode === 'diary') {
        const receipt = await api.saveDiary({ id: noteIdRef.current, title: t, content: c })
        setUpdatedAt(receipt.updatedAt)
      } else {
        // Generic save: folderId semantics only apply to notes; other kinds
        // keep their path and system-owned frontmatter untouched.
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
  }, [title, content, isBlank, mode, diaryDate, currentFolderId])

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

  // ---- Scroll-driven collapsible metadata head ----
  // The head sits above the title in normal flow and starts fully collapsed.
  // Its height maps 1:1 to the active scroller's offset over the first H px;
  // the rest of the delta passes through to the document. Each scroller gets a
  // matching top inset, so the text stays locked while the head collapses
  // instead of moving at double speed (same idea as useCollapsibleHeader).
  useLayoutEffect(() => {
    const body = bodyRef.current
    const wrap = metaWrapRef.current
    const inner = metaInnerRef.current
    if (!body || !wrap || !inner) return
    // The inner block keeps its natural height while the wrapper is clipped.
    const height = Math.max(0, inner.offsetHeight)
    metaHeightRef.current = height
    if (height <= 0) return

    const reduceMotion =
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
    const bound = new Set<HTMLElement>()
    let primary: HTMLElement | null = null
    let last: HTMLElement | null = null
    let frame = 0
    let idleTimer = 0
    let animating = false
    let touching = false
    let disposed = false

    /** Paint the head and the scroll inset for one raw scroll offset. */
    const apply = (scroller: HTMLElement, rawTop: number) => {
      const consumed = Math.min(Math.max(0, rawTop), height)
      const progress = 1 - consumed / height
      // The inset cancels the consumed offset so the text does not move twice.
      scroller.style.paddingTop = `${consumed}px`
      // A collapsed head must truly disappear: no height, no hit area.
      wrap.style.height = `${height * progress}px`
      wrap.style.opacity = String(progress)
      wrap.style.pointerEvents = progress > 0 ? 'auto' : 'none'
      const expanded = progress > 0.5
      if (metaExpandedRef.current !== expanded) {
        metaExpandedRef.current = expanded
        setMetaExpanded(expanded)
      }
    }

    const stopSnap = () => {
      if (frame) cancelAnimationFrame(frame)
      frame = 0
      animating = false
    }

    /** Ease-out scroll so a released head never rests between states. */
    const animateTo = (scroller: HTMLElement, target: number) => {
      stopSnap()
      if (reduceMotion || Math.abs(scroller.scrollTop - target) < 1) {
        scroller.scrollTop = target
        // Read back: a short document clamps the offset before the head's full
        // travel, and the painted state must follow the real position.
        apply(scroller, scroller.scrollTop)
        return
      }
      const from = scroller.scrollTop
      const start = performance.now()
      animating = true
      const step = (now: number) => {
        const t = Math.min(1, (now - start) / META_SNAP_MS)
        const eased = 1 - Math.pow(1 - t, 3)
        const value = from + (target - from) * eased
        scroller.scrollTop = value
        apply(scroller, scroller.scrollTop)
        if (t < 1) {
          frame = requestAnimationFrame(step)
        } else {
          frame = 0
          animating = false
        }
      }
      frame = requestAnimationFrame(step)
    }

    const snap = () => {
      if (!last || animating) return
      const top = last.scrollTop
      if (top <= 0 || top >= height) return
      // The head only moves with real scroller offsets, so focusing the title
      // (or the IME / a selection drag) can never collapse it on its own.
      animateTo(last, top < height / 2 ? 0 : height)
    }

    const scheduleSnap = () => {
      if (idleTimer) window.clearTimeout(idleTimer)
      idleTimer = window.setTimeout(() => {
        idleTimer = 0
        snap()
      }, META_SNAP_IDLE_MS)
    }

    const onScroll = (event: Event) => {
      const scroller = event.target
      if (!(scroller instanceof HTMLElement)) return
      last = scroller
      apply(scroller, scroller.scrollTop)
      if (!animating && !touching) scheduleSnap()
    }

    const onTouchStart = () => {
      touching = true
      if (idleTimer) window.clearTimeout(idleTimer)
      idleTimer = 0
      stopSnap()
    }

    const onTouchEnd = () => {
      touching = false
      scheduleSnap()
    }

    const placeCollapsed = (scroller: HTMLElement) => {
      scroller.style.paddingTop = `${height}px`
      scroller.scrollTop = height
      apply(scroller, scroller.scrollTop)
    }

    const bind = (scroller: HTMLElement) => {
      if (bound.has(scroller)) return
      bound.add(scroller)
      if (!primary || !primary.isConnected) primary = scroller
      scroller.style.overflowAnchor = 'none'
      // Reserve the head's travel, so even a short document can scroll it away.
      const content = scroller.querySelector<HTMLElement>('.cm-content')
      if (content) content.style.minHeight = `calc(100% + ${height}px)`
      scroller.addEventListener('scroll', onScroll, { passive: true })
      placeCollapsed(scroller)
      last = scroller
      // CodeMirror may restore its scroll offset right after a doc load; make
      // sure the head still starts collapsed once the layout settles.
      requestAnimationFrame(() => {
        if (!disposed && scroller.scrollTop === 0) placeCollapsed(scroller)
      })
    }

    const toggle = () => {
      const scroller = primary?.isConnected
        ? primary
        : last?.isConnected
          ? last
          : null
      if (!scroller) return
      animateTo(scroller, scroller.scrollTop < height / 2 ? height : 0)
    }
    metaToggleRef.current = toggle

    const bindScrollers = () => {
      // Only the source pane drives the head: the preview pane mounts with its
      // own scroll position (and synced line jumps), which must never pop the
      // metadata head open when the preview button is pressed.
      body.querySelectorAll<HTMLElement>('.cm-scroller').forEach(bind)
    }
    bindScrollers()
    // CodeMirror mounts after this effect; rescan the body for its scroller.
    const observer = new MutationObserver(bindScrollers)
    observer.observe(body, { childList: true, subtree: true })
    body.addEventListener('touchstart', onTouchStart, { passive: true })
    body.addEventListener('touchend', onTouchEnd, { passive: true })
    body.addEventListener('touchcancel', onTouchEnd, { passive: true })
    // Any fresh user gesture takes over from a running snap.
    body.addEventListener('wheel', stopSnap, { passive: true })

    return () => {
      disposed = true
      observer.disconnect()
      body.removeEventListener('touchstart', onTouchStart)
      body.removeEventListener('touchend', onTouchEnd)
      body.removeEventListener('touchcancel', onTouchEnd)
      body.removeEventListener('wheel', stopSnap)
      bound.forEach((scroller) => scroller.removeEventListener('scroll', onScroll))
      if (idleTimer) window.clearTimeout(idleTimer)
      stopSnap()
      metaToggleRef.current = null
    }
  }, [metaYaml, previewVersion])

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

  /** Import images as assets and insert Markdown references at the caret. */
  const insertImages = useCallback(async (files: File[]) => {
    for (const file of files) {
      try {
        const bytes = new Uint8Array(await file.arrayBuffer())
        const asset = await assetApi.import({ data: bytesToBase64(bytes), source: 'note' })
        editorRef.current?.insertAtCursor(`\n![图片](asset:${asset.id})\n`)
      } catch (e) {
        console.error('插入图片失败', e)
        toast(friendlyError(e))
        return
      }
    }
  }, [])

  /** Apply one quick-syntax button from the bar above the keyboard. */
  const handleQuickAction = (action: QuickAction) => {
    const editor = editorRef.current
    switch (action) {
      case 'heading':
        editor?.toggleLinePrefix('# ')
        break
      case 'bold':
        editor?.toggleInline('**')
        break
      case 'italic':
        editor?.toggleInline('*')
        break
      case 'list':
        editor?.toggleLinePrefix('- ')
        break
      case 'task':
        editor?.toggleLinePrefix('- [ ] ')
        break
      case 'quote':
        editor?.toggleLinePrefix('> ')
        break
      case 'code':
        editor?.insertAtCursor('```\n\n```', 4)
        break
      case 'link':
        editor?.insertLink()
        break
      case 'image':
        fileInputRef.current?.click()
        break
    }
  }

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

  // Edge swipe and Android back key use the same guarded back path (save /
  // leave-confirm) as the toolbar button.
  useEdgeBack(() => void handleBack())
  usePhysicalBack(() => void handleBack())

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
      toast('请先输入内容以创建文档')
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

  // ---- Folder selection (notes only; other kinds keep their fixed path) ----
  const openFolderMenu = (e: React.MouseEvent<HTMLButtonElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    setFolderAnchor({ left: rect.left, top: rect.bottom })
    setFolderMenuOpen(true)
  }

  // Popover placement: clamp to the horizontal viewport and flip above the
  // anchor when the list would overflow the bottom edge.
  const folderMenuPos = useMemo(() => {
    if (!folderAnchor) return undefined
    const WIDTH = 220
    const estHeight = 46 * (folders.length + 1) + 20
    const left = Math.min(Math.max(8, folderAnchor.left), window.innerWidth - WIDTH - 8)
    let top = folderAnchor.top + 6
    if (top + estHeight > window.innerHeight - 8) {
      top = Math.max(8, folderAnchor.top - estHeight - 50)
    }
    return { left, top, width: WIDTH } as React.CSSProperties
  }, [folderAnchor, folders.length])

  const handleSelectFolder = async (fid: number | null) => {
    setFolderMenuOpen(false)
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

  /** Loaded doc is a plain note (or a brand-new note) → folder picker applies. */
  const isNoteDoc = mode === 'note' && (!docPath || docPath.startsWith('/life/notes/'))

  const handleCreateVersion = async () => {
    if (noteIdRef.current == null) {
      toast('请先输入内容以创建文档')
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
      toast('请先保存文档')
      return
    }
    try {
      // Notes with images export as a ZIP so the Markdown and its images stay
      // together; plain Markdown stays a single `.md` file.
      const withImages = hasAssetRefs(content)
      const path = await save({
        defaultPath: `${safeFileName(title || '未命名')}.${withImages ? 'zip' : 'md'}`,
        filters: [
          withImages
            ? { name: 'ZIP（含图片）', extensions: ['zip'] }
            : { name: 'Markdown', extensions: ['md'] },
        ],
      })
      if (path == null) return
      await api.exportNoteTo({
        noteId: noteIdRef.current,
        destPath: path,
        withAssets: withImages,
      })
      toast(withImages ? '已导出（图片随包）' : '已导出')
    } catch (e) {
      console.error(e)
      toast(friendlyError(e))
    }
  }

  /** A tap on the editor pane outside the code surface focuses the body. */
  const handleEditorPaneClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement
    if (target.closest('input, textarea, button, a, .cm-editor')) return
    editorRef.current?.focus()
  }

  // ---- Layout: preview visibility and divider position ----

  /**
   * Unroll the preview: mount it at 0% and then animate to the remembered
   * divider position over one second. A divider remembered at 100% (preview
   * hidden) opens the full preview instead of staying invisible.
   */
  const openPreview = () => {
    if (previewCloseTimerRef.current) {
      window.clearTimeout(previewCloseTimerRef.current)
      previewCloseTimerRef.current = 0
    }
    previewOpenFramesRef.current.forEach((id) => cancelAnimationFrame(id))
    const target = splitRatio >= MAX_SPLIT_RATIO ? MIN_SPLIT_RATIO : splitRatio
    if (target !== splitRatio) {
      setSplitRatio(target)
      setLayoutPrefs({ ratio: target })
    }
    previewOpenRef.current = true
    setPreviewOpen(true)
    setPreviewMounted(true)
    setRenderedRatio(MAX_SPLIT_RATIO)
    // Let the zero-height pane paint once, then run the one-second unroll.
    previewOpenFramesRef.current = [
      requestAnimationFrame(() => {
        previewOpenFramesRef.current = [
          requestAnimationFrame(() => {
            previewOpenFramesRef.current = []
            if (previewOpenRef.current) setRenderedRatio(target)
          }),
        ]
      }),
    ]
  }

  /** Roll the preview back over one second, then unmount it. */
  const closePreview = () => {
    previewOpenFramesRef.current.forEach((id) => cancelAnimationFrame(id))
    previewOpenFramesRef.current = []
    previewOpenRef.current = false
    setPreviewOpen(false)
    setRenderedRatio(MAX_SPLIT_RATIO)
    if (previewCloseTimerRef.current) window.clearTimeout(previewCloseTimerRef.current)
    previewCloseTimerRef.current = window.setTimeout(() => {
      previewCloseTimerRef.current = 0
      setPreviewMounted(false)
    }, PREVIEW_ANIM_MS)
  }

  const togglePreview = () => {
    if (previewOpen) closePreview()
    else openPreview()
  }

  /** Live drag update: move the panes without touching localStorage. */
  const handleRatioChange = (ratio: number) => {
    // Grabbing the divider cancels a pending open/close hand-off.
    previewOpenFramesRef.current.forEach((id) => cancelAnimationFrame(id))
    previewOpenFramesRef.current = []
    if (previewCloseTimerRef.current) {
      window.clearTimeout(previewCloseTimerRef.current)
      previewCloseTimerRef.current = 0
    }
    if (!previewOpenRef.current) {
      previewOpenRef.current = true
      setPreviewOpen(true)
    }
    setRenderedRatio(ratio)
  }

  /** Drag / keys finished: remember the divider position for the next session. */
  const handleRatioCommit = (ratio: number) => {
    setRenderedRatio(ratio)
    setSplitRatio(ratio)
    setLayoutPrefs({ ratio })
    // Snapping the divider to the bottom hides the preview entirely, so the
    // state follows: the preview closes (and its toolbar button turns off)
    // instead of staying "open" at zero height.
    if (ratio >= MAX_SPLIT_RATIO) closePreview()
  }

  // Drop pending open frames / close timer when the editor page goes away.
  useEffect(
    () => () => {
      if (previewCloseTimerRef.current) window.clearTimeout(previewCloseTimerRef.current)
      previewOpenFramesRef.current.forEach((id) => cancelAnimationFrame(id))
      previewOpenFramesRef.current = []
    },
    [],
  )

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
  const wordCountLabel = wordCount.toLocaleString('zh-CN')
  // The status strip only carries the last update time and the live word count.
  const updatedAtLabel = updatedAt ? formatAmPmDateTime(updatedAt) : null
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
              onClick={() => fileInputRef.current?.click()}
              onPointerDown={keepFieldFocus}
              aria-label="插入图片"
            >
              <IconImage size={22} />
            </button>
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
          {isNoteDoc ? (
            <button
              type="button"
              className="editor-folder"
              onClick={openFolderMenu}
            >
              <IconFolder size={15} />
              <span>{folderName || '选择文件夹'}</span>
            </button>
          ) : (
            <span className="editor-folder static">
              {mode === 'diary' ? <IconCalendar size={15} /> : <IconFolder size={15} />}
              <span>{mode === 'diary' ? (diaryDate ?? '日记') : docPath || '文档'}</span>
            </span>
          )}
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
                ? {
                    paddingBottom: `calc(${kbInset}px + var(--safe-bottom) + ${QUICK_BAR_SPACE}px)`,
                  }
                : undefined
            }
          >
            {/* Scroll-collapsible YAML head: in normal flow above the title so
                it can never cover the title or the status line; its height maps
                1:1 to the scrollers' offset and snaps on release. */}
            {metaYaml && (
              <div className="editor-yaml" ref={metaWrapRef} aria-hidden={!metaExpanded}>
                <div className="editor-yaml-inner" ref={metaInnerRef}>
                  <button
                    type="button"
                    className="editor-yaml-head"
                    onClick={() => metaToggleRef.current?.()}
                    aria-expanded={metaExpanded}
                    aria-controls="editor-yaml-body"
                    aria-label="展开或收起元数据"
                    tabIndex={metaExpanded ? 0 : -1}
                  >
                    <span>元数据 · 系统生成（只读）</span>
                    <span className="editor-yaml-arrow">▾</span>
                  </button>
                  <pre className="editor-yaml-body" id="editor-yaml-body">
                    {metaYaml}
                  </pre>
                </div>
              </div>
            )}
            <input
              ref={titleRef}
              className="editor-title-input"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onFocus={enterEditing}
              placeholder="标题"
            />
            {/* Status strip: last update time + live word count only. */}
            <div className="editor-meta">
              <span className="editor-meta-item" title="上次更新时间">
                {updatedAtLabel ? `编辑于 ${updatedAtLabel}` : '尚未保存'}
              </span>
              <span className="editor-meta-sep" aria-hidden="true">
                ·
              </span>
              <span className="editor-meta-count" title="正文字数">
                {wordCountLabel} 字
              </span>
            </div>
            <div className="editor-split">
              <div
                className="editor-main"
                style={{
                  flex: `0 0 ${renderedRatio}%`,
                  opacity: renderedRatio <= MIN_SPLIT_RATIO ? 0 : 1,
                }}
                onClick={handleEditorPaneClick}
              >
                <div className="markdown-editor-host" onFocus={enterEditing}>
                  <MarkdownEditor
                    ref={editorRef}
                    value={content}
                    prefs={editorPrefs}
                    kbInset={kbInset}
                    onChange={setContent}
                    onHistoryChange={handleHistoryChange}
                    onScrollLine={handleEditorScroll}
                    onPasteImages={insertImages}
                  />
                </div>
              </div>
              {previewMounted && (
                <>
                  <SplitHandle
                    ratio={renderedRatio}
                    onChange={handleRatioChange}
                    onCommit={handleRatioCommit}
                  />
                  <div
                    className="editor-preview"
                    style={{ opacity: renderedRatio >= MAX_SPLIT_RATIO ? 0 : 1 }}
                    aria-label="Markdown 预览"
                  >
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
          </div>

          {/* Quick syntax bar: only while the soft keyboard is up, pinned above it. */}
          {editing && kbInset > 0 && (
            <div
              className="quick-bar"
              style={{ bottom: `calc(${kbInset}px + var(--safe-bottom))` }}
              role="toolbar"
              aria-label="快捷语法"
            >
              {QUICK_ACTIONS.map((item) => (
                <button
                  key={item.action}
                  type="button"
                  className="quick-bar-btn"
                  onClick={() => handleQuickAction(item.action)}
                  onPointerDown={keepFieldFocus}
                >
                  {item.label}
                </button>
              ))}
            </div>
          )}
        </>
      )}

      {/* ---- Unsaved-changes leave interception (manual strategy) ---- */}
      {leaveConfirm && (
        <div className="modal-overlay" onClick={() => setLeaveConfirm(false)}>
          <div className="dialog" onClick={(e) => e.stopPropagation()}>
            <div className="dialog-title">未保存的更改</div>
            <div className="dialog-message">当前文档有未保存的修改，离开前要保存吗？</div>
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

      {/* ---- Folder selector popover (notes only) ---- */}
      {folderMenuOpen && folderMenuPos && (
        <>
          <div className="scope-backdrop" onClick={() => setFolderMenuOpen(false)} />
          <div className="folder-popover" style={folderMenuPos}>
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
          </div>
        </>
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
          {versions.length > 0 && (
            <div className="settings-note">
              仅可删除最新版本；中间版本参与 diff 链，删除会破坏历史回放。
            </div>
          )}
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
                {v.id === versions[0]?.id && v.versionNumber > 1 && (
                  <button
                    type="button"
                    className="icon-btn"
                    aria-label="删除版本"
                    onClick={() => setDeleteVersionConfirm(v)}
                  >
                    <IconTrash size={18} />
                  </button>
                )}
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

      {/* Hidden picker: selected images become assets referenced by id. */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        multiple
        hidden
        onChange={(e) => {
          const files = Array.from(e.target.files ?? [])
          e.target.value = ''
          void insertImages(files)
        }}
      />

      {/* Full-screen viewer for a tapped note picture. */}
      {zoomImage && <ImageZoom image={zoomImage} onClose={() => setZoomImage(null)} />}

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
          message={`确定要删除 ${fmtVersion(deleteVersionConfirm.versionNumber)} 这个版本吗？仅最新版本可删除，此操作不可撤销。`}
          confirmText="删除"
          danger
          onConfirm={() => void handleDeleteVersion(deleteVersionConfirm)}
          onCancel={() => setDeleteVersionConfirm(null)}
        />
      )}


    </div>
  )
}
