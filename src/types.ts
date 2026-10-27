export interface Folder {
  id: number
  name: string
  isPinned: number
  sortOrder: number
  noteCount: number
  createdAt: string
}

export interface FolderStats {
  total: number
  unclassified: number
  defaultFolderName: string
  folders: Folder[]
}

export interface Note {
  id: number
  title: string
  content: string
  folderId: number | null
  folderName: string | null
  isPinned: number
  createdAt: string
  updatedAt: string
  deletedAt: string | null
}

export interface NoteVersion {
  id: number
  noteId: number
  versionNumber: number
  title: string
  content: string
  label: string | null
  labelDescription: string | null
  isManual: number
  createdAt: string
}

export interface Todo {
  id: number
  title: string
  category: string
  isCompleted: number
  dueDate: string | null
  reminder: number
  createdAt: string
  updatedAt: string
}

export interface Schedule {
  id: number
  title: string
  date: string
  startTime: string | null
  endTime: string | null
  note: string | null
  reminder: number
  createdAt: string
  updatedAt: string
}

export interface Contact {
  id: number
  name: string
  phone: string | null
  email: string | null
  company: string | null
  notes: string | null
  tag: string
  createdAt: string
  updatedAt: string
}
