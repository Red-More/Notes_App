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

// ---- VirtualFs (fs_*) contracts, mirroring src-tauri/src/vfs/types.rs ----

/** `inodes.kind`：目录或文件。 */
export type VfsEntryKind = 'directory' | 'file'

/** `fs_read` 指向目录时的条目。 */
export interface VfsDirEntry {
  path: string
  kind: VfsEntryKind
  mtime: string
  headRev: number
}

/** `fs_read` 文件响应的 meta 镜像。 */
export interface VfsMeta {
  kind: string | null
  title: string | null
  status: string | null
  due: string | null
  tags: string | null
  extra: string | null
}

/** `fs_read` 响应：`kind` 区分目录列举与文件内容。 */
export type VfsReadResult =
  | { kind: 'dir'; entries: VfsDirEntry[] }
  | {
      kind: 'file'
      path: string
      rev: number
      content: string
      totalLines: number
      meta: VfsMeta | null
    }

/** `fs_write` 回执。 */
export interface VfsWriteReceipt {
  path: string
  rev: number
  bytes: number
}

/** `fs_edit` 回执。 */
export interface VfsEditReceipt {
  path: string
  rev: number
  bytes: number
}

/** `fs_glob` 命中项。 */
export interface VfsGlobEntry {
  path: string
  kind: VfsEntryKind
  mtime: string
  headRev: number
}

/** `fs_grep` 单条命中。 */
export interface VfsGrepHit {
  path: string
  rev: number
  line: number
  preview: string
}

/** `fs_grep` 响应；P1 走 LIKE 回退，`fallback` 恒为 true。 */
export interface VfsGrepResponse {
  total: number
  hits: VfsGrepHit[]
  fallback: boolean
}

/** 后端 `ToolError` 的判别联合，供 UI 按 `code` 展示可行动提示。 */
export type VfsToolError =
  | { code: 'pathEscape'; root: string; got: string }
  | { code: 'invalidPath'; message: string }
  | { code: 'notFound'; path: string }
  | { code: 'notADirectory'; path: string }
  | { code: 'isDirectory'; path: string }
  | { code: 'alreadyExists'; path: string }
  | { code: 'parentMissing'; path: string }
  | { code: 'readOnlyArea'; path: string }
  | { code: 'conflict'; current: number; expect: number }
  | { code: 'noMatch'; hint: string }
  | { code: 'invalidArgument'; message: string }
  | { code: 'contentTooLarge'; limit: number; actual: number }
  | { code: 'storage'; message: string }

export type VfsErrorCode = VfsToolError['code']

// ---- Generic document layer (doc_*) ----

/** frontmatter 字段：任意结构化键值，前端按领域读取。 */
export type DocFields = Record<string, unknown>

/** 一篇文档（一个 Markdown 文件）的完整视图，id 为 inode。 */
export interface Doc {
  id: number
  path: string
  /** note | todo | event | contact | diary */
  kind: string
  title: string
  /** 正文（已剥离 frontmatter）。 */
  content: string
  fields: DocFields
  folderId: number | null
  folderName: string | null
  pinned: number
  rev: number
  createdAt: string
  updatedAt: string
  deletedAt: string | null
}

/** 文档版本；id 来自 version_meta，全局唯一。 */
export interface DocVersion {
  id: number
  docId: number
  versionNumber: number
  title: string
  content: string
  label: string | null
  labelDescription: string | null
  isManual: number
  createdAt: string
}

/** 交叉索引查询结果。 */
export interface DocRef {
  id: number
  path: string
  kind: string
  title: string
  updatedAt: string
}
