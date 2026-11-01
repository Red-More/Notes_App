import { Channel, invoke } from '@tauri-apps/api/core'
import type {
  AgentModelInfo,
  AgentSettings,
  ChatConversation,
  ChatMessageRecord,
  ConnectionTestResult,
  Contact,
  Doc,
  DocFields,
  DocRef,
  DocVersion,
  Folder,
  FolderStats,
  LlmParams,
  McpServerInfo,
  McpToolInfo,
  MediaAsset,
  MediaGcReport,
  MediaJob,
  MediaJobEvent,
  MediaJobKind,
  ModelApiFormat,
  ModelKind,
  NewChatMessage,
  Note,
  NoteVersion,
  PrivacyAuditEntry,
  PrivacyEntity,
  PrivacyEntityKind,
  PrivacyLabel,
  Schedule,
  SensitivityLevel,
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

/** Legacy note list ordering, now implemented by the generic doc layer. */
export type NoteSort = 'updated' | 'created' | 'title'

export type DocListParams = {
  kind?: string
  folderId?: number
  unclassified?: boolean
  search?: string
  sort?: string
  deleted?: boolean
  tag?: string
  month?: string
  limit?: number
}

export type DocCreateParams = {
  kind: string
  title: string
  content: string
  folderId?: number | null
  fields?: DocFields
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
 * 领域适配（Note/Todo/Schedule/Contact）全部在下方 `api` 中完成。
 */
export const docApi = {
  list: (params: DocListParams) => invoke<Doc[]>('doc_list', params),
  get: (id: number, includeDeleted = false) => invoke<Doc>('doc_get', { id, includeDeleted }),
  create: (params: DocCreateParams) => invoke<Doc>('doc_create', params),
  save: (params: DocSaveParams) => invoke<Doc>('doc_save', params),
  delete: (ids: number[]) => invoke<void>('doc_delete', { ids }),
  restore: (ids: number[]) => invoke<void>('doc_restore', { ids }),
  purge: (ids: number[]) => invoke<void>('doc_purge', { ids }),
  emptyTrash: () => invoke<void>('doc_empty_trash'),
  setPinned: (params: { ids: number[]; pinned: boolean }) => invoke<void>('doc_set_pinned', params),
  move: (params: { ids: number[]; folderId: number | null }) => invoke<void>('doc_move', params),

  listVersions: (docId: number, includeAuto = false) =>
    invoke<DocVersion[]>('version_list', { docId, includeAuto }),
  createVersion: (docId: number) => invoke<DocVersion>('version_create', { docId }),
  restoreVersion: (versionId: number) => invoke<Doc>('version_restore', { versionId }),
  deleteVersion: (versionId: number) => invoke<void>('version_delete', { versionId }),

  listFolders: () => invoke<FolderStats>('folder_list'),
  createFolder: (name: string) => invoke<Folder>('folder_create', { name }),
  renameFolder: (params: { id: number; name: string }) => invoke<void>('folder_rename', params),
  renameDefaultFolder: (name: string) => invoke<void>('folder_rename_default', { name }),
  deleteFolder: (id: number) => invoke<void>('folder_delete', { id }),
  setFolderPinned: (params: { id: number; pinned: boolean }) =>
    invoke<void>('folder_set_pinned', params),

  exportDoc: (params: { docId: number; destPath: string }) => invoke<void>('export_doc', params),
  exportDocs: (params: { ids: number[]; destPath: string }) => invoke<void>('export_docs', params),
  exportFolder: (params: { folderId: number; destPath: string }) =>
    invoke<void>('export_folder', params),

  /** 交叉索引：person / date / time / location / tag / type / due。 */
  indexQuery: (params: { dimension: string; value: string; kind?: string; limit?: number }) =>
    invoke<DocRef[]>('index_query', params),
}

function str(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return fallback
}

function nullableStr(value: unknown): string | null {
  const text = str(value, '')
  return text === '' ? null : text
}

function bool(value: unknown, fallback = false): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  if (typeof value === 'string') return value === 'true' || value === '1'
  return fallback
}

function docToNote(doc: Doc): Note {
  return {
    id: doc.id,
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

/** Derive completion from Markdown checkboxes when an Agent edited the body. */
function checkboxCompleted(content: string): boolean | null {
  let found = false
  let allDone = true
  for (const line of content.split('\n')) {
    const trimmed = line.trimStart()
    if (!trimmed.startsWith('- [')) continue
    const mark = trimmed[3]
    if (trimmed[4] !== ']') continue
    if (mark !== ' ' && mark !== 'x' && mark !== 'X') continue
    found = true
    if (mark === ' ') allDone = false
  }
  return found ? allDone : null
}

function docToTodo(doc: Doc): Todo {
  // Frontmatter wins (UI toggle); otherwise fall back to body checkboxes
  // so Agent edits and UI ticks stay consistent.
  const explicit = doc.fields.completed
  const completed =
    typeof explicit === 'boolean' ? explicit : (checkboxCompleted(doc.content) ?? false)
  return {
    id: doc.id,
    title: doc.title,
    category: str(doc.fields.category) || '默认',
    isCompleted: completed ? 1 : 0,
    dueDate: nullableStr(doc.fields.dueDate),
    reminder: bool(doc.fields.reminder) ? 1 : 0,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  }
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

function docToSchedule(doc: Doc): Schedule {
  return {
    id: doc.id,
    title: doc.title,
    date: str(doc.fields.date) || doc.updatedAt.slice(0, 10),
    startTime: nullableStr(doc.fields.startTime),
    endTime: nullableStr(doc.fields.endTime),
    note: nullableStr(doc.fields.note),
    reminder: bool(doc.fields.reminder) ? 1 : 0,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  }
}

function docToContact(doc: Doc): Contact {
  return {
    id: doc.id,
    name: doc.title,
    phone: nullableStr(doc.fields.phone),
    email: nullableStr(doc.fields.email),
    company: nullableStr(doc.fields.company),
    notes: nullableStr(doc.fields.notes),
    tag: str(doc.fields.tag) || '默认',
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
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
    autoFrontmatter?: boolean
  }) => invoke<VfsWriteReceipt>('fs_write', params),
  fsEdit: (params: {
    path: string
    oldString: string
    newString: string
    replaceAll?: boolean
    expectRev?: number
  }) => invoke<VfsEditReceipt>('fs_edit', params),
  fsGlob: (params: { pattern: string; root?: string; caseSensitive?: boolean }) =>
    invoke<VfsGlobEntry[]>('fs_glob', params),
  fsGrep: (params: {
    pattern: string
    path?: string
    type?: string
    maxResults?: number
    contextLines?: number
  }) => invoke<VfsGrepResponse>('fs_grep', params),

  // ---- Notes (doc kind = note) ----
  listNotes: async (params: { folderId?: number; unclassified?: boolean; sort?: NoteSort }) => {
    const docs = await docApi.list({
      kind: 'note',
      folderId: params.folderId,
      unclassified: params.unclassified,
      sort: params.sort,
    })
    return docs.map(docToNote)
  },
  /**
   * M1-6：笔记搜索统一走 `fs_grep`（FTS5 + LIKE 回退），不再依赖 doc_list 的 instr。
   * grep 返回命中路径，再取同一批文档做领域映射与排序。
   */
  searchNotes: async (params: { search: string; folderId?: number; unclassified?: boolean }) => {
    const hits = await api.fsGrep({ pattern: params.search, type: 'note', maxResults: 200 })
    const docs = await docApi.list({
      kind: 'note',
      folderId: params.folderId,
      unclassified: params.unclassified,
      limit: 2000,
    })
    const matched = new Set(hits.hits.map((hit) => hit.path))
    return {
      notes: docs.filter((doc) => matched.has(doc.path)).map(docToNote),
      fallback: hits.fallback,
    }
  },
  getNote: async (id: number) => docToNote(await docApi.get(id)),
  createNote: async (params: { title: string; content: string; folderId: number | null }) =>
    docToNote(
      await docApi.create({
        kind: 'note',
        title: params.title,
        content: params.content,
        folderId: params.folderId,
      }),
    ),
  saveNote: async (params: {
    id: number
    title: string
    content: string
    folderId: number | null
  }) =>
    docToNote(
      await docApi.save({
        id: params.id,
        title: params.title,
        content: params.content,
        // 后端约定：-1 表示默认文件夹，undefined/null 表示不移动。
        folderId: params.folderId ?? -1,
      }),
    ),
  deleteNotes: (ids: number[]) => docApi.delete(ids),
  setNotesPinned: (params: { ids: number[]; pinned: boolean }) => docApi.setPinned(params),
  moveNotes: (params: { ids: number[]; folderId: number | null }) => docApi.move(params),

  // ---- Export ----
  exportNoteTo: (params: { noteId: number; destPath: string }) =>
    docApi.exportDoc({ docId: params.noteId, destPath: params.destPath }),
  exportNotesTo: (params: { ids: number[]; destPath: string }) =>
    docApi.exportDocs({ ids: params.ids, destPath: params.destPath }),
  exportFolderTo: (params: { folderId: number; destPath: string }) =>
    docApi.exportFolder({ folderId: params.folderId, destPath: params.destPath }),

  // ---- Recycle bin ----
  listDeletedNotes: async () => {
    const docs = await docApi.list({ kind: 'note', deleted: true })
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
    const docs = await docApi.list({ limit: 2000 })
    const doc = docs.find((item) => item.path === path)
    if (!doc) throw new Error(`未找到文档：${path}`)
    return restorePreviousRevision(doc.id)
  },

  // ---- Folders ----
  listFolders: () => docApi.listFolders(),
  createFolder: (name: string) => docApi.createFolder(name),
  renameFolder: (params: { id: number; name: string }) => docApi.renameFolder(params),
  renameDefaultFolder: (name: string) => docApi.renameDefaultFolder(name),
  deleteFolder: (id: number) => docApi.deleteFolder(id),
  setFolderPinned: (params: { id: number; pinned: boolean }) => docApi.setFolderPinned(params),

  /** 手动重建检索索引（M1-5）；正常写入时索引自动维护。 */
  rebuildSearchIndex: () => invoke<number>('search_reindex'),

  // ---- Todos (doc kind = todo) ----
  listTodos: async (search?: string) => {
    const docs = await docApi.list({ kind: 'todo', search: search || undefined })
    return docs.map(docToTodo)
  },
  createTodo: async (params: {
    title: string
    category?: string
    dueDate?: string | null
    reminder?: boolean
  }) =>
    docToTodo(
      await docApi.create({
        kind: 'todo',
        title: params.title,
        content: '',
        fields: {
          category: params.category ?? '默认',
          completed: false,
          dueDate: params.dueDate ?? null,
          reminder: params.reminder ?? false,
        },
      }),
    ),
  updateTodo: async (params: {
    id: number
    title: string
    category?: string
    dueDate?: string | null
    reminder?: boolean
  }) =>
    docToTodo(
      await docApi.save({
        id: params.id,
        title: params.title,
        fields: {
          category: params.category ?? '默认',
          dueDate: params.dueDate ?? null,
          reminder: params.reminder ?? false,
        },
      }),
    ),
  toggleTodo: async (id: number) => {
    const doc = await docApi.get(id)
    return docToTodo(await docApi.save({ id, fields: { completed: !bool(doc.fields.completed) } }))
  },
  deleteTodo: async (id: number) => {
    // 待办没有回收站入口：先软删再物理删除，保持旧版“删除即消失”的语义。
    await docApi.delete([id])
    await docApi.purge([id])
  },

  // ---- Schedules (doc kind = event) ----
  listSchedules: async (month: string) => {
    const docs = await docApi.list({ kind: 'event', month })
    return docs.map(docToSchedule)
  },
  createSchedule: async (params: {
    title: string
    date: string
    startTime?: string | null
    endTime?: string | null
    note?: string | null
    reminder?: boolean
  }) =>
    docToSchedule(
      await docApi.create({
        kind: 'event',
        title: params.title,
        content: '',
        fields: {
          date: params.date,
          startTime: params.startTime ?? null,
          endTime: params.endTime ?? null,
          note: params.note ?? null,
          reminder: params.reminder ?? false,
        },
      }),
    ),
  updateSchedule: async (params: {
    id: number
    title: string
    date: string
    startTime?: string | null
    endTime?: string | null
    note?: string | null
    reminder?: boolean
  }) =>
    docToSchedule(
      await docApi.save({
        id: params.id,
        title: params.title,
        fields: {
          date: params.date,
          startTime: params.startTime ?? null,
          endTime: params.endTime ?? null,
          note: params.note ?? null,
          reminder: params.reminder ?? false,
        },
      }),
    ),
  deleteSchedule: async (id: number) => {
    await docApi.delete([id])
    await docApi.purge([id])
  },

  // ---- Contacts (doc kind = contact) ----
  listContacts: async (params: { tag?: string; search?: string }) => {
    const docs = await docApi.list({
      kind: 'contact',
      tag: params.tag,
      search: params.search,
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
  }) =>
    docToContact(
      await docApi.create({
        kind: 'contact',
        title: params.name,
        content: '',
        fields: {
          phone: params.phone ?? null,
          email: params.email ?? null,
          company: params.company ?? null,
          notes: params.notes ?? null,
          tag: params.tag ?? '默认',
        },
      }),
    ),
  updateContact: async (params: {
    id: number
    name: string
    phone?: string | null
    email?: string | null
    company?: string | null
    notes?: string | null
    tag?: string
  }) =>
    docToContact(
      await docApi.save({
        id: params.id,
        title: params.name,
        fields: {
          phone: params.phone ?? null,
          email: params.email ?? null,
          company: params.company ?? null,
          notes: params.notes ?? null,
          tag: params.tag ?? '默认',
        },
      }),
    ),
  deleteContact: async (id: number) => {
    await docApi.delete([id])
    await docApi.purge([id])
  },
}

/**
 * Agent 会话、自定义模型与参数 API。
 * 添加模型时密钥一次性提交到 Rust，前端不持久化、不回读内容。
 */
export const chatApi = {
  list: () => invoke<ChatConversation[]>('chat_list'),
  create: (params: { title?: string } = {}) => invoke<ChatConversation>('chat_create', params),
  rename: (params: { id: number; title: string }) => invoke<void>('chat_rename', params),
  remove: (id: number) => invoke<void>('chat_delete', { id }),
  messages: (conversationId: number) =>
    invoke<ChatMessageRecord[]>('chat_messages', { conversationId }),
  append: (params: { conversationId: number; messages: NewChatMessage[] }) =>
    invoke<ChatMessageRecord[]>('chat_append', params),
  /** Remove messages newer than `messageId`; retry continues from the kept user turn. */
  truncate: (params: { conversationId: number; messageId: number }) =>
    invoke<number>('chat_truncate', params),
  settings: () => invoke<AgentSettings>('agent_settings'),
  saveModel: (input: {
    id?: string
    label?: string
    format: ModelApiFormat
    baseUrl: string
    modelId: string
    fullUrl?: boolean
    kind?: ModelKind
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
 * Privacy API (phase A): declared tiers, EDM entity vault, egress audit.
 * Entity plaintext never crosses this boundary; only aliases come back.
 */
export const privacyApi = {
  labels: () => invoke<PrivacyLabel[]>('privacy_labels_list'),
  setLabel: (path: string, level: SensitivityLevel) =>
    invoke<PrivacyLabel>('privacy_label_set', { path, level }),
  deleteLabel: (path: string) => invoke<void>('privacy_label_delete', { path }),
  entities: () => invoke<PrivacyEntity[]>('privacy_entities_list'),
  addEntity: (kind: PrivacyEntityKind, value: string) =>
    invoke<PrivacyEntity>('privacy_entity_add', { kind, value }),
  deleteEntity: (alias: string) => invoke<void>('privacy_entity_delete', { alias }),
  audit: (limit?: number) => invoke<PrivacyAuditEntry[]>('privacy_audit_list', { limit }),
}

/**
 * 媒体作业 API：提交后排入 Rust 队列，结果落在 job 或 asset 上。
 */
export const mediaApi = {
  /** Submit a job; `onEvent` receives status/progress through a Tauri Channel. */
  submit: (
    input: { kind: MediaJobKind; modelEntry: string; params?: Record<string, unknown> },
    onEvent?: (event: MediaJobEvent) => void,
  ) => {
    const channel = new Channel<MediaJobEvent>()
    if (onEvent) channel.onmessage = onEvent
    return invoke<MediaJob>('media_job_submit', { input, onEvent: channel })
  },
  list: (limit?: number) => invoke<MediaJob[]>('media_job_list', { limit }),
  get: (id: number) => invoke<MediaJob>('media_job_get', { id }),
  cancel: (id: number) => invoke<MediaJob>('media_job_cancel', { id }),
  asset: (id: number) => invoke<MediaAsset>('media_asset_get', { id }),
  assetPath: (id: number) => invoke<string>('media_asset_path', { id }),
  /** Base64 bytes for one asset; used to rebuild image context after reload. */
  assetData: (id: number) => invoke<{ mime: string; data: string }>('media_asset_data', { id }),
  /** Persist a WebView-supplied audio payload before an ASR job. */
  storeAsset: (input: { mime: string; data: string }) =>
    invoke<MediaAsset>('media_asset_store', { input }),
  /** Reclaim assets not referenced by notes, messages or recent jobs. */
  gcAssets: (retentionDays?: number) =>
    invoke<MediaGcReport>('media_asset_gc', { retentionDays }),
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
  list: () => invoke<SkillSummary[]>('skill_list'),
  read: (id: string) => invoke<SkillDetail>('skill_read', { id }),
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
