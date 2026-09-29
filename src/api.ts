import { invoke } from '@tauri-apps/api/core'
import type { Contact, Folder, FolderStats, Note, NoteVersion, Schedule, Todo } from './types'

// Typed wrappers around Tauri commands. Tauri converts camelCase
// JS arguments to snake_case Rust parameters automatically.
export const api = {
  // ---- Notes ----
  listNotes: (params: { folderId?: number; unclassified?: boolean; search?: string }) =>
    invoke<Note[]>('list_notes', params),
  getNote: (id: number) => invoke<Note>('get_note', { id }),
  createNote: (params: { title: string; content: string; folderId: number | null }) =>
    invoke<Note>('create_note', params),
  saveNote: (params: {
    id: number
    title: string
    content: string
    folderId: number | null
    forceVersion?: boolean
  }) => invoke<Note>('save_note', params),
  deleteNotes: (ids: number[]) => invoke<void>('delete_notes', { ids }),
  setNotesPinned: (params: { ids: number[]; pinned: boolean }) =>
    invoke<void>('set_notes_pinned', params),
  moveNotes: (params: { ids: number[]; folderId: number | null }) =>
    invoke<void>('move_notes', params),

  // ---- Versions & labels ----
  listVersions: (noteId: number) => invoke<NoteVersion[]>('list_versions', { noteId }),
  restoreVersion: (versionId: number) => invoke<Note>('restore_version', { versionId }),
  createLabel: (params: { noteId: number; label: string; description?: string | null }) =>
    invoke<NoteVersion>('create_label', params),
  updateLabel: (params: { versionId: number; label: string; description?: string | null }) =>
    invoke<void>('update_label', params),
  deleteLabel: (versionId: number) => invoke<void>('delete_label', { versionId }),

  // ---- Folders ----
  listFolders: () => invoke<FolderStats>('list_folders'),
  createFolder: (name: string) => invoke<Folder>('create_folder', { name }),
  renameFolder: (params: { id: number; name: string }) => invoke<void>('rename_folder', params),
  deleteFolder: (id: number) => invoke<void>('delete_folder', { id }),
  setFolderPinned: (params: { id: number; pinned: boolean }) =>
    invoke<void>('set_folder_pinned', params),

  // ---- Todos ----
  listTodos: (search?: string) => invoke<Todo[]>('list_todos', { search }),
  createTodo: (params: {
    title: string
    category?: string
    dueDate?: string | null
    reminder?: boolean
  }) => invoke<Todo>('create_todo', params),
  updateTodo: (params: {
    id: number
    title: string
    category?: string
    dueDate?: string | null
    reminder?: boolean
  }) => invoke<Todo>('update_todo', params),
  toggleTodo: (id: number) => invoke<Todo>('toggle_todo', { id }),
  deleteTodo: (id: number) => invoke<void>('delete_todo', { id }),

  // ---- Schedules ----
  listSchedules: (month: string) => invoke<Schedule[]>('list_schedules', { month }),
  createSchedule: (params: {
    title: string
    date: string
    startTime?: string | null
    endTime?: string | null
    note?: string | null
    reminder?: boolean
  }) => invoke<Schedule>('create_schedule', params),
  updateSchedule: (params: {
    id: number
    title: string
    date: string
    startTime?: string | null
    endTime?: string | null
    note?: string | null
    reminder?: boolean
  }) => invoke<Schedule>('update_schedule', params),
  deleteSchedule: (id: number) => invoke<void>('delete_schedule', { id }),

  // ---- Contacts ----
  listContacts: (params: { tag?: string; search?: string }) =>
    invoke<Contact[]>('list_contacts', params),
  createContact: (params: {
    name: string
    phone?: string | null
    email?: string | null
    company?: string | null
    notes?: string | null
    tag?: string
  }) => invoke<Contact>('create_contact', params),
  updateContact: (params: {
    id: number
    name: string
    phone?: string | null
    email?: string | null
    company?: string | null
    notes?: string | null
    tag?: string
  }) => invoke<Contact>('update_contact', params),
  deleteContact: (id: number) => invoke<void>('delete_contact', { id }),
}
