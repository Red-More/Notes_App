import { useState } from 'react'
import { ToastHost } from './components/ui'
import ReminderScheduler from './components/ReminderScheduler'
import { IconCalendar, IconNote, IconTodo, IconUsers } from './components/Icons'
import NoteListPage from './pages/notes/NoteListPage'
import NoteEditorPage from './pages/notes/NoteEditorPage'
import FolderManagePage from './pages/notes/FolderManagePage'
import TodoPage from './pages/todos/TodoPage'
import SchedulePage from './pages/schedules/SchedulePage'
import ContactPage from './pages/contacts/ContactPage'

type Tab = 'notes' | 'todos' | 'schedules' | 'contacts'

type Overlay =
  | { kind: 'editor'; noteId: number | null; folderId: number | null }
  | { kind: 'folders' }

const TABS: Array<{ key: Tab; label: string; icon: typeof IconNote }> = [
  { key: 'notes', label: '笔记', icon: IconNote },
  { key: 'todos', label: '待办', icon: IconTodo },
  { key: 'schedules', label: '日程', icon: IconCalendar },
  { key: 'contacts', label: '人脉', icon: IconUsers },
]

function App() {
  const [tab, setTab] = useState<Tab>('notes')
  const [overlay, setOverlay] = useState<Overlay | null>(null)
  // Bumped when the editor / folder pages close so lists reload.
  const [dataVersion, setDataVersion] = useState(0)

  const closeOverlay = () => {
    setOverlay(null)
    setDataVersion((v) => v + 1)
  }

  if (overlay?.kind === 'editor') {
    return (
      <>
        <NoteEditorPage
          key={overlay.noteId ?? 'new'}
          noteId={overlay.noteId}
          folderId={overlay.folderId}
          onBack={closeOverlay}
        />
        <ToastHost />
      </>
    )
  }
  if (overlay?.kind === 'folders') {
    return (
      <>
        <FolderManagePage onBack={closeOverlay} />
        <ToastHost />
      </>
    )
  }

  return (
    <div className="app">
      <div className="app-body">
        {tab === 'notes' && (
          <NoteListPage
            version={dataVersion}
            onOpenNote={(noteId, folderId) => setOverlay({ kind: 'editor', noteId, folderId })}
            onOpenFolders={() => setOverlay({ kind: 'folders' })}
          />
        )}
        {tab === 'todos' && <TodoPage />}
        {tab === 'schedules' && <SchedulePage />}
        {tab === 'contacts' && <ContactPage />}
      </div>
      <nav className="tabbar">
        {TABS.map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            type="button"
            className={`tabbar-item ${tab === key ? 'active' : ''}`}
            onClick={() => setTab(key)}
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
