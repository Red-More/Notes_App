import { invoke } from '@tauri-apps/api/core'
import type {
  AgentModelInfo,
  AgentRun,
  AgentRunStart,
  AgentRunState,
  AgentRunStatus,
  AgentRunTrigger,
  AgentSettings,
  AssetData,
  AssetInfo,
  ChatConversation,
  ChatMessageRecord,
  ConnectionTestResult,
  Contact,
  Doc,
  DocFields,
  DocSaveReceipt,
  DocVersion,
  Folder,
  FolderCrumb,
  FolderStats,
  LlmParams,
  McpServerInfo,
  McpToolInfo,
  ModelApiFormat,
  NewChatMessage,
  Note,
  NoteVersion,
  SkillDetail,
  SkillInput,
  SkillSummary,
  Todo,
  VfsEditReceipt,
  VfsGlobEntry,
  VfsGrepResponse,
  VfsReadResult,
  VfsWriteReceipt,
} from './types'
import {
  contactBase,
  contactDisplayName,
  contactIdOf,
  contactNameError,
  newContactId,
} from './contacts/contactFile'
import { baseNameOf } from './fileTypes'
import { localStamp, newTodoId, todayLocal } from './todos/todoFile'
import { TodoStore, type TodoDoc, type TodoPort } from './todos/todoStore'

/** Legacy note list ordering, now implemented by the generic doc layer. */
export type NoteSort = 'updated' | 'created' | 'title'

export type DocListParams = {
  kind?: string
  folderId?: number
  /** Recursive virtual-directory scope, e.g. `/life/ai_default`. */
  root?: string
  unclassified?: boolean
  search?: string
  sort?: string
  deleted?: boolean
  tag?: string
  month?: string
  limit?: number
  /** Skip document bodies; list views only need metadata and fields. */
  includeContent?: boolean
  /** Truncate bodies to this many characters when content is included. */
  previewChars?: number
  /** Restrict to these virtual paths, reusing a preceding `fs_grep` result. */
  paths?: string[]
}

export type DocCreateParams = {
  kind: string
  title: string
  content: string
  folderId?: number | null
  fields?: DocFields
  /** Optional extension without the dot; defaults to `md`. */
  ext?: string
}

export type DocSaveParams = {
  id: number
  title?: string
  content?: string
  fields?: DocFields
  folderId?: number | null
  expectRev?: number
}

/**
 * 通用文档 API：整个应用唯一的内容入口。
 * 领域适配（Note/Diary/Todo/Contact）全部在下方 `api` 中完成。
 */
export const docApi = {
  list: (params: DocListParams) => invoke<Doc[]>('doc_list', params),
  get: (id: number, includeDeleted = false) => invoke<Doc>('doc_get', { id, includeDeleted }),
  create: (params: DocCreateParams) => invoke<Doc>('doc_create', params),
  rename: (params: { id: number; base: string; ext: string }) =>
    invoke<Doc>('doc_rename', params),
  save: (params: DocSaveParams) => invoke<DocSaveReceipt>('doc_save', params),
  delete: (ids: number[]) => invoke<void>('doc_delete', { ids }),
  restore: (ids: number[]) => invoke<void>('doc_restore', { ids }),
  purge: (ids: number[]) => invoke<void>('doc_purge', { ids }),
  emptyTrash: () => invoke<void>('doc_empty_trash'),
  setPinned: (params: { ids: number[]; pinned: boolean }) => invoke<void>('doc_set_pinned', params),
  move: (params: { ids: number[]; folderId: number | null }) => invoke<void>('doc_move', params),
  moveToPath: (params: { ids: number[]; dir: string }) =>
    invoke<void>('doc_move_path', params),

  listFolders: (
    parentId: number | null = null,
    root: string | null = null,
    includeSystem = false,
  ) => invoke<FolderStats>('folder_list', { parentId, root, includeSystem }),
  folderPath: (id: number | null = null, root: string | null = null) =>
    invoke<FolderCrumb[]>('folder_path', { id, root }),
  createFolder: (name: string, parentId: number | null = null, root: string | null = null) =>
    invoke<Folder>('folder_create', { name, parentId, root }),
  reorderFolders: (params: { parentId: number | null; root: string | null; ids: number[] }) =>
    invoke<void>('folder_reorder', params),
  renameFolder: (params: { id: number; name: string }) => invoke<void>('folder_rename', params),
  renameDefaultFolder: (name: string) => invoke<void>('folder_rename_default', { name }),
  deleteFolder: (id: number) => invoke<void>('folder_delete', { id }),
  setFolderPinned: (params: { id: number; pinned: boolean }) =>
    invoke<void>('folder_set_pinned', params),

  listVersions: (docId: number, includeAuto = false) =>
    invoke<DocVersion[]>('version_list', { docId, includeAuto }),
  /** Fetch one version's body on demand; the list omits bodies. */
  versionContent: (versionId: number) => invoke<string>('version_content', { versionId }),
  createVersion: (docId: number) => invoke<DocVersion>('version_create', { docId }),
  restoreVersion: (versionId: number) => invoke<Doc>('version_restore', { versionId }),
  deleteVersion: (versionId: number) => invoke<void>('version_delete', { versionId }),

  exportDoc: (params: { docId: number; destPath: string; withAssets?: boolean }) =>
    invoke<void>('export_doc', params),

  exportDocs: (params: { ids: number[]; destPath: string }) => invoke<void>('export_docs', params),
  exportFolder: (params: { folderId: number; destPath: string }) =>
    invoke<void>('export_folder', params),
}

/**
 * Todo port: the generic document API adapted to the day-file model.
 *
 * The backend stores documents only — grouping todos into `todo-{date}.md` is a
 * frontend policy, so no todo-specific table or column ever enters the database.
 */
function toTodoDoc(doc: Doc): TodoDoc {
  return {
    id: doc.id,
    rev: doc.rev,
    path: doc.path,
    title: doc.title,
    content: doc.content,
    fields: doc.fields,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  }
}

const todoPort: TodoPort = {
  async listDocuments() {
    const docs = await docApi.list({ kind: 'todo' })
    return docs.map(toTodoDoc)
  },
  async createDayFile(date, body) {
    // The path already encodes the day (`todo-{date}.md`), so no `date` field is
    // written: it would be a second copy that nothing reads back.
    const doc = await docApi.create({
      kind: 'todo',
      title: `todo-${date}`,
      content: body,
      ext: 'md',
    })
    return toTodoDoc(doc)
  },
  async saveDayFile(doc, body) {
    // `expectRev` keeps a concurrent (Agent) edit from being clobbered.
    await docApi.save({ id: doc.id, content: body, expectRev: doc.rev })
  },
  async deleteDocument(id) {
    // Todos have no trash entry: delete then purge keeps "gone means gone".
    await docApi.delete([id])
    await docApi.purge([id])
  },
  async archiveDocument(id) {
    // Soft delete only: the migrated legacy todo stays restorable from the trash
    // (a purge here would be the one irreversible step of the todo model).
    await docApi.delete([id])
  },
  now: () => localStamp(),
  today: () => todayLocal(),
  newId: () => newTodoId(),
}

const todoStore = new TodoStore(todoPort)

function str(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return fallback
}

function nullableStr(value: unknown): string | null {
  const text = str(value, '')
  return text === '' ? null : text
}

function docToNote(doc: Doc): Note {
  return {
    id: doc.id,
    path: doc.path,
    ext: doc.ext ?? '',
    format: doc.format === 'raw' ? 'raw' : 'markdown',
    title: doc.title,
    content: doc.content,
    folderId: doc.folderId,
    folderName: doc.folderName,
    isPinned: doc.pinned,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    deletedAt: doc.deletedAt,
  }
}

/** The day a diary is filed under: frontmatter `date`, else its update time. */
function docDate(doc: Doc): string {
  const date = doc.fields.date
  if (typeof date === 'string' && date) return date.slice(0, 10)
  return doc.updatedAt.slice(0, 10)
}

/** Restore the revision before the current head; returns the refreshed doc. */
async function restorePreviousRevision(docId: number) {
  const doc = await docApi.get(docId)
  const versions = await docApi.listVersions(docId, true)
  const previous = versions
    .filter((version) => version.versionNumber < doc.rev)
    .sort((a, b) => b.versionNumber - a.versionNumber)[0]
  if (!previous) throw new Error('没有可恢复的历史版本')
  return docApi.restoreVersion(previous.id)
}

/** Resolve one virtual path without loading its body. */
async function docByPath(path: string) {
  const docs = await docApi.list({ paths: [path], includeContent: false })
  const doc = docs.find((item) => item.path === path)
  if (!doc) throw new Error(`未找到文档：${path}`)
  return doc
}

function docToContact(doc: Doc): Contact {
  const contactId = contactIdOf(doc.fields, doc.id)
  return {
    id: doc.id,
    contactId,
    name: contactDisplayName(doc.fields, doc.title, contactId),
    phone: nullableStr(doc.fields.phone),
    email: nullableStr(doc.fields.email),
    company: nullableStr(doc.fields.company),
    notes: nullableStr(doc.fields.notes),
    tag: str(doc.fields.tag) || '默认',
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  }
}

/** Surface a name-validation message through `friendlyError`, not a generic one. */
function contactInputError(message: string): Error {
  return Object.assign(new Error(message), { code: 'invalidArgument' })
}

/** Frontmatter of a contact: the stable id and the display name are the source. */
function contactFields(input: {
  contactId: string
  name: string
  phone?: string | null
  email?: string | null
  company?: string | null
  notes?: string | null
  tag?: string
}): DocFields {
  return {
    id: input.contactId,
    name: input.name.trim(),
    phone: input.phone ?? null,
    email: input.email ?? null,
    company: input.company ?? null,
    notes: input.notes ?? null,
    tag: input.tag ?? '默认',
  }
}

function docToNoteVersion(version: DocVersion): NoteVersion {
  return {
    id: version.id,
    noteId: version.docId,
    versionNumber: version.versionNumber,
    title: version.title,
    content: version.content,
    label: version.label,
    labelDescription: version.labelDescription,
    isManual: version.isManual,
    createdAt: version.createdAt,
  }
}

// Typed wrappers around Tauri commands. Tauri converts camelCase
// JS arguments to snake_case Rust parameters automatically.
export const api = {
  // ---- VirtualFs (fs_*) ----
  // 通用文件工具；领域页面优先使用下方的文档/领域 API。
  fsRead: (params: {
    path: string
    rev?: number
    startLine?: number
    endLine?: number
    includeMeta?: boolean
  }) => invoke<VfsReadResult>('fs_read', params),
  fsWrite: (params: {
    path: string
    content: string
    createParents?: boolean
  }) => invoke<VfsWriteReceipt>('fs_write', params),
  fsEdit: (params: {
    path: string
    oldString: string
    newString: string
    replaceAll?: boolean
    expectRev?: number
  }) => invoke<VfsEditReceipt>('fs_edit', params),
  fsGlob: (params: {
    pattern: string
    root?: string
    caseSensitive?: boolean
  }) => invoke<VfsGlobEntry[]>('fs_glob', params),
  fsGrep: (params: {
    pattern: string
    path?: string
    extension?: string
    maxResults?: number
    contextLines?: number
  }) => invoke<VfsGrepResponse>('fs_grep', params),
  // 界面面命令：身份在 Rust 侧固定为 User，前端不声明 principal。
  userRead: (params: { path: string; includeMeta?: boolean }) =>
    invoke<VfsReadResult>('user_read', params),
  userSearch: (params: {
    pattern: string
    extension?: string
    path?: string
    maxResults?: number
  }) => invoke<VfsGrepResponse>('user_search', params),

  // ---- Notes (doc kind = note) ----
  listNotes: async (
    params: { folderId?: number; unclassified?: boolean; sort?: NoteSort } = {},
  ) => {
    const docs = await docApi.list({
      kind: 'note',
      folderId: params.folderId,
      unclassified: params.unclassified,
      sort: params.sort,
    })
    return docs.map(docToNote)
  },
  /**
   * M1-6：笔记搜索统一走界面面 `user_search`（FTS5 + LIKE 回退），不再依赖 doc_list 的 instr。
   * 命中路径直接作为 doc_list 的过滤条件，避免拉取全量列表再按 path 筛选。
   */
  searchNotes: async (params: { search: string; folderId?: number; unclassified?: boolean }) => {
    const hits = await api.userSearch({
      pattern: params.search,
      path: '/life/notes',
      maxResults: 200,
    })
    const paths = hits.hits.map((hit) => hit.path)
    const docs = paths.length
      ? await docApi.list({
          kind: 'note',
          paths,
          folderId: params.folderId,
          unclassified: params.unclassified,
        })
      : []
    return {
      notes: docs.map(docToNote),
      fallback: hits.fallback,
    }
  },
  getNote: async (id: number) => docToNote(await docApi.get(id)),
  /** Rename the backing file (title + extension) in place. */
  renameNoteFile: async (id: number, base: string, ext: string) =>
    docToNote(await docApi.rename({ id, base, ext })),
  createNote: async (params: {
    title: string
    content: string
    folderId: number | null
    ext?: string
  }) =>
    docToNote(
      await docApi.create({
        kind: 'note',
        title: params.title,
        content: params.content,
        folderId: params.folderId,
        ext: params.ext,
      }),
    ),
  saveNote: async (params: {
    id: number
    title: string
    content: string
    folderId: number | null
  }) =>
    docApi.save({
      id: params.id,
      title: params.title,
      content: params.content,
      // 后端约定：-1 表示默认文件夹，undefined/null 表示不移动。
      folderId: params.folderId ?? -1,
    }),
  deleteNotes: (ids: number[]) => docApi.delete(ids),
  setNotesPinned: (params: { ids: number[]; pinned: boolean }) => docApi.setPinned(params),
  moveNotes: (params: { ids: number[]; folderId: number | null }) => docApi.move(params),

  // ---- Export ----
  exportNoteTo: (params: { noteId: number; destPath: string; withAssets?: boolean }) =>
    docApi.exportDoc({
      docId: params.noteId,
      destPath: params.destPath,
      withAssets: params.withAssets,
    }),
  exportNotesTo: (params: { ids: number[]; destPath: string }) =>
    docApi.exportDocs({ ids: params.ids, destPath: params.destPath }),
  exportFolderTo: (params: { folderId: number; destPath: string }) =>
    docApi.exportFolder({ folderId: params.folderId, destPath: params.destPath }),

  // ---- Recycle bin ----
  listDeletedNotes: async () => {
    // Metadata only: the recycle bin shows title and timestamps.
    const docs = await docApi.list({ kind: 'note', deleted: true, includeContent: false })
    return docs.map(docToNote)
  },
  restoreNotes: (ids: number[]) => docApi.restore(ids),
  purgeNotes: (ids: number[]) => docApi.purge(ids),
  emptyTrash: () => docApi.emptyTrash(),

  // ---- Versions ----
  listVersions: async (noteId: number) => {
    const versions = await docApi.listVersions(noteId)
    return versions.map(docToNoteVersion)
  },
  /** One version's body, fetched when the user previews or compares it. */
  getVersionContent: (versionId: number) => docApi.versionContent(versionId),
  restoreVersion: async (versionId: number) => docToNote(await docApi.restoreVersion(versionId)),
  createVersion: async (noteId: number) => docToNoteVersion(await docApi.createVersion(noteId)),
  deleteVersion: (versionId: number) => docApi.deleteVersion(versionId),

  /** Restore the revision before the current head for a known document id. */
  restorePreviousRevision,

  /**
   * Restore the revision before the current head for any document path.
   * Used by chat tool cards to undo an Agent write/edit.
   */
  restorePreviousDocRevision: async (path: string) => {
    // Only the id is needed here, so ask for the single path without a body.
    const doc = await docByPath(path)
    return restorePreviousRevision(doc.id)
  },

  /** Restore the state just before `beforeRev`, used by turn-level rollback. */
  restoreDocRevision: async (path: string, beforeRev: number) => {
    const doc = await docByPath(path)
    const versions = await docApi.listVersions(doc.id, true)
    const target = versions
      .filter((version) => version.versionNumber < beforeRev)
      .sort((a, b) => b.versionNumber - a.versionNumber)[0]
    if (!target) throw new Error('没有可恢复的历史版本')
    return docApi.restoreVersion(target.id)
  },

  /** Move a document created by the turn into the recycle bin. */
  trashDocByPath: async (path: string) => {
    const doc = await docByPath(path)
    return docApi.delete([doc.id])
  },

  // ---- Folders ----
  listFolders: (parentId: number | null = null, root: string | null = null, includeSystem = false) =>
    docApi.listFolders(parentId, root, includeSystem),
  folderPath: (id: number | null = null, root: string | null = null) =>
    docApi.folderPath(id, root),
  createFolder: (name: string, parentId: number | null = null, root: string | null = null) =>
    docApi.createFolder(name, parentId, root),
  reorderFolders: (params: { parentId: number | null; root: string | null; ids: number[] }) =>
    docApi.reorderFolders(params),
  renameFolder: (params: { id: number; name: string }) => docApi.renameFolder(params),
  renameDefaultFolder: (name: string) => docApi.renameDefaultFolder(name),
  deleteFolder: (id: number) => docApi.deleteFolder(id),
  setFolderPinned: (params: { id: number; pinned: boolean }) => docApi.setFolderPinned(params),

  // ---- Diary (doc kind = diary, path = /life/diary/YYYY-MM-DD.md) ----
  /** One day's diary; null when that date has no document yet. */
  getDiary: async (date: string) => {
    const target = `/life/diary/${date}.md`
    // Canonical path is authoritative: no timezone or timestamp participates.
    const exact = await docApi.list({ kind: 'diary', paths: [target] })
    if (exact.length) return docToNote(exact[0])

    // Legacy fallback for non-canonical filenames lacking a frontmatter date.
    const docs = await docApi.list({ kind: 'diary', month: date.slice(0, 7) })
    const doc = docs.find((item) => docDate(item) === date)
    return doc ? docToNote(doc) : null
  },
  /** Lazily scaffold an empty date; the title doubles as the file stem. */
  createDiary: async (params: { date: string; title?: string; content?: string }) =>
    docToNote(
      await docApi.create({
        kind: 'diary',
        title: params.title?.trim() || params.date,
        content: params.content ?? '',
        fields: { date: params.date },
      }),
    ),
  saveDiary: async (params: { id: number; title: string; content: string }) =>
    docApi.save({ id: params.id, title: params.title, content: params.content }),

  /** 手动重建检索索引（M1-5）；正常写入时索引自动维护。 */
  rebuildSearchIndex: () => invoke<number>('search_reindex'),

  // ---- Todos: one `todo-{date}.md` VFS file per day (no DB-side model) ----
  /**
   * Load todos, folding legacy single-todo documents in on first use.
   *
   * `migrate: false` makes it a pure read; the reminder poller uses that so a
   * background timer never triggers the one-time write.
   */
  listTodos: (search?: string, options?: { migrate?: boolean }) =>
    todoStore.list(search, options),
  createTodo: (params: {
    title: string
    dueDate?: string | null
    remindAt?: string | null
    repeat?: string
  }) => todoStore.create(params),
  updateTodo: (
    todo: Todo,
    patch: {
      title?: string
      dueDate?: string | null
      remindAt?: string | null
      repeat?: string
    },
  ) => todoStore.update(todo, patch),
  toggleTodo: (todo: Todo) => todoStore.toggle(todo),
  /** Pin/unpin one todo; pinned entries sort above the rest. */
  setTodoPinned: (todo: Todo, pinned: boolean) => todoStore.setPinned(todo, pinned),
  deleteTodo: (todo: Todo) => todoStore.remove(todo),
  /** Move a todo to another day file, keeping its id (deadline/reminder never move it). */
  moveTodoDate: (todo: Todo, date: string) => todoStore.moveToDate(todo, date),



  // ---- Contacts: one `{name}-{id}.md` VFS file per contact ----
  listContacts: async (params: { tag?: string; search?: string }) => {
    const docs = await docApi.list({
      kind: 'contact',
      tag: params.tag,
      search: params.search,
      includeContent: false,
    })
    return docs.map(docToContact)
  },
  createContact: async (params: {
    name: string
    phone?: string | null
    email?: string | null
    company?: string | null
    notes?: string | null
    tag?: string
  }) => {
    const nameError = contactNameError(params.name)
    if (nameError) throw contactInputError(nameError)
    const contactId = newContactId()
    const doc = await docApi.create({
      kind: 'contact',
      // The name is free text and may contain dots; the id keeps duplicates apart.
      title: contactBase(params.name, contactId),
      content: '',
      fields: contactFields({ ...params, contactId }),
      ext: 'md',
    })
    return docToContact(doc)
  },
  updateContact: async (params: {
    id: number
    name: string
    phone?: string | null
    email?: string | null
    company?: string | null
    notes?: string | null
    tag?: string
  }) => {
    const nameError = contactNameError(params.name)
    if (nameError) throw contactInputError(nameError)
    const doc = await docApi.get(params.id)
    const contactId = contactIdOf(doc.fields, doc.id)
    const targetBase = contactBase(params.name, contactId)
    if (targetBase !== baseNameOf(doc.path, doc.ext)) {
      // The name is part of the file name; the id and the body stay untouched.
      await docApi.rename({ id: params.id, base: targetBase, ext: doc.ext || 'md' })
    }
    await docApi.save({ id: params.id, fields: contactFields({ ...params, contactId }) })
    return docToContact(await docApi.get(params.id))
  },
  deleteContact: async (id: number) => {
    await docApi.delete([id])
    await docApi.purge([id])
  },
}

/**
 * 图片资产 API：字节存入应用私有目录，前端只拿 id 或 base64。
 */
export const assetApi = {
  import: (input: { data: string; source?: 'note' | 'chat' | 'import' }) =>
    invoke<AssetInfo>('asset_import', { input }),
  data: (id: number) => invoke<AssetData>('asset_data', { id }),
}

/**
 * Agent 会话、自定义模型与参数 API。
 * 添加模型时密钥一次性提交到 Rust，前端不持久化、不回读内容。
 */
export const chatApi = {
  list: () => invoke<ChatConversation[]>('chat_list'),
  create: (params: { title?: string } = {}) => invoke<ChatConversation>('chat_create', params),
  rename: (params: { id: number; title: string }) => invoke<void>('chat_rename', params),
  /** Rebind one conversation to another model entry. */
  setConversationModel: (params: { conversationId: number; modelEntry: string }) =>
    invoke<ChatConversation>('chat_set_model', params),
  remove: (id: number) => invoke<void>('chat_delete', { id }),
  messages: (conversationId: number) =>
    invoke<ChatMessageRecord[]>('chat_messages', { conversationId }),
  append: (params: { conversationId: number; messages: NewChatMessage[] }) =>
    invoke<ChatMessageRecord[]>('chat_append', params),
  /** Remove messages newer than `messageId`; retry continues from the kept user turn. */
  truncate: (params: { conversationId: number; messageId: number }) =>
    invoke<number>('chat_truncate', params),
  /** Remove `messageId` and everything newer; editing rewrites that user turn. */
  truncateFrom: (params: { conversationId: number; messageId: number }) =>
    invoke<number>('chat_truncate_from', params),
  /** Remove exactly one row; withdrawing a queued follow-up must not touch later rows. */
  deleteMessage: (params: { conversationId: number; messageId: number }) =>
    invoke<number>('chat_delete_message', params),
  /** Write the run row and its user message in one transaction. */
  runStart: (params: {
    conversationId: number | null
    title?: string
    trigger: AgentRunTrigger
    modelEntry: string
    message?: NewChatMessage | null
  }) => invoke<AgentRunStart>('chat_run_start', params),
  runTransition: (params: { runId: number; status: AgentRunStatus }) =>
    invoke<AgentRun>('chat_run_transition', params),
  runFinish: (params: {
    runId: number
    status: AgentRunStatus
    partial?: string | null
    errorCode?: string | null
    stepCount?: number
    writeCount?: number
    lastSeq?: number
  }) => invoke<AgentRun>('chat_run_finish', params),
  runTouch: (params: {
    runId: number
    stepCount: number
    writeCount: number
    lastSeq: number
  }) => invoke<void>('chat_run_touch', params),
  runState: (conversationId: number) =>
    invoke<AgentRunState>('chat_run_state', { conversationId }),
  runResume: (params: { conversationId: number; modelEntry: string }) =>
    invoke<AgentRunStart>('chat_run_resume', params),
  settings: () => invoke<AgentSettings>('agent_settings'),
  /** Persist the exact prompt payload shown in settings. */
  savePromptConfig: (input: {
    systemPrompt: string
    rules: string
    injectSkills: boolean
  }) => invoke<void>('agent_prompt_config_set', { input }),
  saveModel: (input: {
    id?: string
    label?: string
    format: ModelApiFormat
    baseUrl: string
    modelId: string
    fullUrl?: boolean
    apiKey?: string
  }) => invoke<AgentModelInfo>('agent_model_save', { input }),
  deleteModel: (id: string) => invoke<void>('agent_model_delete', { id }),
  activateModel: (id: string) => invoke<void>('agent_model_activate', { id }),
  testConnection: (input: {
    id?: string
    format: ModelApiFormat
    baseUrl: string
    modelId: string
    fullUrl?: boolean
    apiKey?: string
  }) => invoke<ConnectionTestResult>('agent_test_connection', { input }),
  modelsList: (input: {
    id?: string
    format: ModelApiFormat
    baseUrl: string
    fullUrl?: boolean
    apiKey?: string
  }) => invoke<string[]>('agent_models_list', { input }),
  paramsGet: (modelEntryId: string) =>
    invoke<LlmParams>('agent_params_get', { modelEntryId }),
  paramsSet: (modelEntryId: string, params: LlmParams) =>
    invoke<void>('agent_params_set', { modelEntryId, params }),
  cancel: (requestId: string) => invoke<void>('agent_cancel', { requestId }),
}

/**
 * 远程 MCP API：配置只存 URL/名称，令牌交给 Rust 私有存储。
 */
export const mcpApi = {
  servers: () => invoke<McpServerInfo[]>('mcp_server_list'),
  saveServer: (input: {
    id?: string
    label: string
    url: string
    enabled: boolean
    /** Empty string clears the stored token. */
    token?: string
  }) => invoke<McpServerInfo>('mcp_server_save', { input }),
  deleteServer: (id: string) => invoke<void>('mcp_server_delete', { id }),
  toolsFor: (id: string) => invoke<McpToolInfo[]>('mcp_server_tools', { id }),
  tools: () => invoke<McpToolInfo[]>('mcp_all_tools'),
  callTool: (params: { serverId: string; tool: string; arguments: Record<string, unknown> }) =>
    invoke<string>('mcp_tool_call', params),
}

/**
 * 技能管理 API（M3）。技能的读写只通过专用命令，模型工具无法触达 `.agents`。
 */
export const skillApi = {
  list: (scope?: string) => invoke<SkillSummary[]>('skill_list', { scope }),
  read: (id: string, scope?: string) => invoke<SkillDetail>('skill_read', { id, scope }),
  readForAgent: (id: string, scope?: string) =>
    invoke<SkillDetail>('agent_skill_read', { id, scope }),
  save: (input: SkillInput) => invoke<SkillSummary>('skill_save', { input }),
  setEnabled: (id: string, enabled: boolean) =>
    invoke<void>('skill_set_enabled', { id, enabled }),
  remove: (id: string) => invoke<void>('skill_delete', { id }),
  importPackage: (input: { filename: string; data: string }) =>
    invoke<SkillSummary>('skill_import', { input }),
  draftList: () => invoke<SkillSummary[]>('skill_draft_list'),
  draftRead: (id: string) => invoke<SkillDetail>('skill_draft_read', { id }),
  draftPromote: (id: string) => invoke<SkillSummary>('skill_draft_promote', { id }),
  draftRemove: (id: string) => invoke<void>('skill_draft_delete', { id }),
}
