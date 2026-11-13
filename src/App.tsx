import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ToastHost } from './components/ui'
import ReminderScheduler from './components/ReminderScheduler'
import { IconCalendar, IconChat, IconNote, IconTodo, IconUsers } from './components/Icons'
import { applyTheme, getStoredTheme } from './theme'
import { applyFontScale } from './appPrefs'
import { installKeyboardViewport } from './system/keyboard'
import type { FolderScope } from './types'
import { NOTES_ROOT_SCOPE } from './types'
import NoteListPage from './pages/notes/NoteListPage'
import FolderManagePage from './pages/notes/FolderManagePage'
import TodoPage from './pages/todos/TodoPage'
import DiaryPage from './pages/diary/DiaryPage'
import ContactPage from './pages/contacts/ContactPage'

// The editor carries CodeMirror + the preview renderer; keep them out of the
// initial list-page bundle and load them when a note is opened.
const NoteEditorPage = lazy(() => import('./pages/notes/NoteEditorPage'))
// Agent runtime + chat UI live in their own chunk; list pages stay light.
const ChatPage = lazy(() => import('./pages/chat/ChatPage'))
const SettingsPage = lazy(() => import('./pages/settings/SettingsPage'))

type Tab = 'chat' | 'notes' | 'todos' | 'diary' | 'contacts'

type EditorMode = 'note' | 'diary'

type Overlay =
  | { kind: 'editor'; noteId: number | null; folderId?: number | null; mode?: EditorMode; diaryDate?: string }
  | { kind: 'folders'; folderId: number | null }
  | { kind: 'settings' }

const TABS: Array<{ key: Tab; label: string; icon: typeof IconNote }> = [
  { key: 'chat', label: '对话', icon: IconChat },
  { key: 'notes', label: '笔记', icon: IconNote },
  { key: 'todos', label: '待办', icon: IconTodo },
  { key: 'diary', label: '日记', icon: IconCalendar },
  { key: 'contacts', label: '人脉', icon: IconUsers },
]

/** Horizontal paging constants: snap threshold, slop, direction angle ratio, edge zones. */
const SNAP_RATIO = 0.2
const SLOP = 6
const ANGLE_RATIO = 1.15
const EDGE_ZONE = 24
const TRANSITION = 'transform 0.32s cubic-bezier(0.22, 1.2, 0.36, 1)'

interface Gesture {
  active: boolean
  startX: number
  startY: number
  lastX: number
  lastT: number
  vx: number
  locked: null | 'h' | 'v' | 'chips'
}

function App() {
  const [index, setIndex] = useState(0)
  const [overlay, setOverlay] = useState<Overlay | null>(null)
  // Bumped when the editor / folder pages close so lists reload.
  const [dataVersion, setDataVersion] = useState(0)
  // The notes scope survives overlay unmounts so the title picker, the list and
  // the folder manager always describe the same namespace subtree.
  const [notesScope, setNotesScope] = useState<FolderScope>(NOTES_ROOT_SCOPE)

  const indexRef = useRef(0)
  const trackRef = useRef<HTMLDivElement>(null)
  const pagerRef = useRef<HTMLDivElement>(null)
  const gesture = useRef<Gesture>({
    active: false,
    startX: 0,
    startY: 0,
    lastX: 0,
    lastT: 0,
    vx: 0,
    locked: null,
  })

  // Apply the persisted theme and type scale once on mount.
  useEffect(() => {
    applyTheme(getStoredTheme())
    applyFontScale()
  }, [])

  // Track the visual viewport so the soft keyboard never covers the composer.
  useEffect(() => installKeyboardViewport(), [])

  const closeOverlay = () => {
    setOverlay(null)
    setDataVersion((v) => v + 1)
  }

  /** Snap the track to a page index (with or without a transition). */
  const goTo = useCallback((target: number, animate = true) => {
    const idx = Math.max(0, Math.min(TABS.length - 1, target))
    indexRef.current = idx
    const tr = trackRef.current
    if (tr) {
      tr.style.transition = animate ? TRANSITION : 'none'
      tr.style.transform = `translateX(${-idx * 100}%)`
    }
    setIndex(idx)
  }, [])

  // The pager unmounts while an overlay (editor / folders) is open, so the
  // freshly mounted track starts at translateX(0) and would show the first page
  // (chat) even though the active tab is still "notes". Layout effect so the
  // position is restored before the first paint and no flash is visible.
  useLayoutEffect(() => {
    const tr = trackRef.current
    if (!tr) return
    tr.style.transition = 'none'
    tr.style.transform = `translateX(${-indexRef.current * 100}%)`
  }, [overlay])

  // ---- Horizontal paging gestures (touch + mouse drag) ----
  // `overlay` is a dependency only as a remount signal: closing an overlay
  // creates a new pager element, so the listeners must move with it.
  // The track has no touch-action restriction: the browser handles vertical
  // panning natively (list scrolling / pull-to-refresh) and horizontal moves
  // on overflow elements (chips rows) natively; only horizontal-dominant
  // gestures elsewhere are taken over here.
  useEffect(() => {
    const el = pagerRef.current
    if (!el) return
    const g = gesture.current
    // While this timestamp is in the future, clicks are suppressed: a horizontal
    // drag that just ended would otherwise fire a click on the item under the
    // release point and accidentally open it.
    let clickGuardUntil = 0
    let savedUserSelect = ''

    const drag = (x: number, y: number, target: Element, prevent: () => void) => {
      if (!g.active) return
      const dx = x - g.startX
      const dy = y - g.startY
      if (!g.locked) {
        if (Math.abs(dx) < SLOP && Math.abs(dy) < SLOP) return
        // Text editing keeps native caret/selection gestures: never page from
        // inside an input, textarea, or the expanded composer.
        if (target.closest('input, textarea, select, [contenteditable="true"], .chat-page.expanded')) {
          g.locked = 'v'
          return
        }
        // Horizontal-only scrollable (chips row): let the browser scroll it.
        const chips = target.closest('.chips') as HTMLElement | null
        if (chips && chips.scrollWidth > chips.clientWidth) {
          g.locked = 'chips'
          return
        }
        // Vertical list scrolling keeps priority; only horizontal-dominant
        // gestures past the angle threshold take over the pager.
        if (Math.abs(dx) > Math.abs(dy) * ANGLE_RATIO) {
          // System back-gesture edge zones never page.
          const rect = el.getBoundingClientRect()
          if (g.startX - rect.left < EDGE_ZONE || rect.right - g.startX < EDGE_ZONE) {
            g.locked = 'v'
            return
          }
          g.locked = 'h'
          prevent()
        } else {
          g.locked = 'v'
          return
        }
      }
      if (g.locked !== 'h') return
      prevent()
      const tr = trackRef.current
      if (!tr) return
      const cur = indexRef.current
      let raw = dx
      // Edge damping: no wrap-around, resistance at the outermost pages.
      if (cur === 0 && raw > 0) raw *= 0.35
      if (cur === TABS.length - 1 && raw < 0) raw *= 0.35
      tr.style.transition = 'none'
      tr.style.transform = `translateX(calc(${-cur * 100}% + ${raw}px))`
      const now = performance.now()
      g.vx = (x - g.lastX) / Math.max(1, now - g.lastT)
      g.lastX = x
      g.lastT = now
    }

    const finish = (dx: number, fromMouse: boolean) => {
      if (!g.active) return
      g.active = false
      if (g.locked === 'h') {
        const tr = trackRef.current
        if (tr) {
          const cur = indexRef.current
          const width = el.clientWidth
          let target = cur
          // 20% width threshold or a fast fling switches the page.
          if (dx < -width * SNAP_RATIO || (g.vx < -0.4 && dx < -SLOP)) target = cur + 1
          else if (dx > width * SNAP_RATIO || (g.vx > 0.4 && dx > SLOP)) target = cur - 1
          goTo(target)
        }
        // Guard the click that would otherwise follow a horizontal drag.
        clickGuardUntil = performance.now() + 300
      }
      g.locked = null
      if (fromMouse && document.body.style.userSelect === 'none') {
        document.body.style.userSelect = savedUserSelect
      }
    }

    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) return
      g.active = true
      g.locked = null
      g.startX = e.touches[0].clientX
      g.startY = e.touches[0].clientY
      g.lastX = g.startX
      g.lastT = performance.now()
      g.vx = 0
    }

    const onTouchMove = (e: TouchEvent) => {
      if (!g.active) return
      const t = e.touches[0]
      drag(t.clientX, t.clientY, e.target as Element, () => e.preventDefault())
    }

    const onTouchEnd = (e: TouchEvent) => {
      const t = e.changedTouches[0]
      finish(t ? t.clientX - g.startX : 0, false)
    }

    // ---- Mouse drag (desktop / web preview) ----
    // Pointer events only for mouse; touch keeps the touch-event path above so
    // native scrolling and pull-to-refresh arbitration stay intact.
    const onPointerDown = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse' || e.button !== 0) return
      const target = e.target as Element
      // Text editing keeps native selection/drag behavior.
      if (target.closest('input, textarea, [contenteditable="true"]')) return
      g.active = true
      g.locked = null
      g.startX = e.clientX
      g.startY = e.clientY
      g.lastX = g.startX
      g.lastT = performance.now()
      g.vx = 0
    }

    const onPointerMove = (e: PointerEvent) => {
      if (!g.active || e.pointerType !== 'mouse' || e.buttons !== 1) return
      // Pointer capture retargets events to the pager; ask the browser for the
      // real element under the cursor so scrollable chips rows are respected.
      const under = document.elementFromPoint(e.clientX, e.clientY)
      const before = g.locked
      drag(e.clientX, e.clientY, under ?? (e.target as Element), () => e.preventDefault())
      // Locking horizontal is the first moment capture is needed. Capturing on
      // pointerdown would retarget mouseup/click to the pager and swallow taps
      // on list items (note cards, rows, buttons).
      if (g.locked === 'h' && before !== 'h') {
        try {
          el.setPointerCapture(e.pointerId)
        } catch {
          // Capture can fail on synthetic pointers; dragging still works.
        }
        // Disable native text selection while a horizontal mouse drag is locked.
        savedUserSelect = document.body.style.userSelect
        document.body.style.userSelect = 'none'
      }
    }

    const onPointerUp = (e: PointerEvent) => {
      if (!g.active || e.pointerType !== 'mouse') return
      finish(e.clientX - g.startX, true)
    }

    const onPointerCancel = () => {
      if (!g.active) return
      finish(0, true)
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
    el.addEventListener('pointerdown', onPointerDown)
    el.addEventListener('pointermove', onPointerMove)
    el.addEventListener('pointerup', onPointerUp)
    el.addEventListener('pointercancel', onPointerCancel)
    el.addEventListener('click', onClickCapture, true)
    return () => {
      el.removeEventListener('touchstart', onTouchStart)
      el.removeEventListener('touchmove', onTouchMove)
      el.removeEventListener('touchend', onTouchEnd)
      el.removeEventListener('touchcancel', onTouchEnd)
      el.removeEventListener('pointerdown', onPointerDown)
      el.removeEventListener('pointermove', onPointerMove)
      el.removeEventListener('pointerup', onPointerUp)
      el.removeEventListener('pointercancel', onPointerCancel)
      el.removeEventListener('click', onClickCapture, true)
      if (document.body.style.userSelect === 'none') {
        document.body.style.userSelect = savedUserSelect
      }
    }
  }, [goTo, overlay])

  // ---- Keyboard paging (accessibility: TalkBack / VoiceOver paging actions) ----
  const onPagerKey = (e: React.KeyboardEvent) => {
    const target = e.target as HTMLElement
    if (target.closest('input, textarea, [contenteditable="true"]')) return
    if (e.key === 'ArrowLeft') {
      e.preventDefault()
      goTo(indexRef.current - 1)
    } else if (e.key === 'ArrowRight') {
      e.preventDefault()
      goTo(indexRef.current + 1)
    }
  }

  if (overlay?.kind === 'editor') {
    return (
      <>
        <Suspense fallback={<div className="editor-page note-editor-page" />}>
          <NoteEditorPage
            key={`${overlay.noteId ?? 'new'}-${overlay.diaryDate ?? ''}`}
            noteId={overlay.noteId}
            folderId={overlay.folderId}
            mode={overlay.mode}
            diaryDate={overlay.diaryDate}
            onBack={closeOverlay}
          />
        </Suspense>
        <ToastHost />
      </>
    )
  }
  if (overlay?.kind === 'folders') {
    return (
      <>
        <FolderManagePage initialFolderId={overlay.folderId} onBack={closeOverlay} />
        <ToastHost />
      </>
    )
  }
  if (overlay?.kind === 'settings') {
    return (
      <>
        <Suspense fallback={<div className="editor-page settings-page" />}>
          <SettingsPage onBack={closeOverlay} />
        </Suspense>
        <ToastHost />
      </>
    )
  }

  const openSettings = () => setOverlay({ kind: 'settings' })
  // Folder management is notes-only; other VFS scopes open it at the notes root
  // instead of exposing system directories.
  const notesFolderId =
    notesScope.path === '/life/notes' || notesScope.path.startsWith('/life/notes/')
      ? notesScope.id
      : null

  return (
    <div className="app">
      <div
        className="pager-body"
        ref={pagerRef}
        tabIndex={0}
        role="group"
        aria-label="内容分页"
        onKeyDown={onPagerKey}
      >
        <div className="pager-track" ref={trackRef}>
          <section className="pager-page" role="tabpanel" id="panel-chat" aria-label="对话">
            <Suspense fallback={<div className="page" />}>
              <ChatPage isActive={index === 0} onOpenSettings={openSettings} />
            </Suspense>
          </section>
          <section className="pager-page" role="tabpanel" id="panel-notes" aria-label="笔记">
            <NoteListPage
              isActive={index === 1}
              version={dataVersion}
              scope={notesScope}
              onScopeChange={setNotesScope}
              onOpenSettings={openSettings}
              onOpenNote={(noteId, folderId) =>
                setOverlay({ kind: 'editor', noteId, folderId })
              }
              onOpenFolders={() => setOverlay({ kind: 'folders', folderId: notesFolderId })}
            />
          </section>
          <section className="pager-page" role="tabpanel" id="panel-todos" aria-label="待办">
            <TodoPage isActive={index === 2} onOpenSettings={openSettings} />
          </section>
          <section className="pager-page" role="tabpanel" id="panel-diary" aria-label="日记">
            <DiaryPage
              isActive={index === 3}
              version={dataVersion}
              onOpenSettings={openSettings}
              onOpenDiary={(date, noteId) =>
                setOverlay({ kind: 'editor', noteId, mode: 'diary', diaryDate: date })
              }
            />
          </section>
          <section className="pager-page" role="tabpanel" id="panel-contacts" aria-label="人脉">
            <ContactPage isActive={index === 4} onOpenSettings={openSettings} />
          </section>
        </div>
      </div>
      <nav className="tabbar" role="tablist" aria-label="主导航">
        {TABS.map(({ key, label, icon: Icon }, i) => (
          <button
            key={key}
            type="button"
            role="tab"
            id={`tab-${key}`}
            aria-selected={index === i}
            aria-controls={`panel-${key}`}
            className={`tabbar-item ${index === i ? 'active' : ''}`}
            onClick={() => goTo(i)}
          >
            <Icon size={23} />
            <span>{label}</span>
          </button>
        ))}
      </nav>
      <ToastHost />
      <ReminderScheduler />
    </div>
  )
}

export default App
