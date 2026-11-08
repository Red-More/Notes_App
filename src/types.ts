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

/** `fs_grep` 响应；`fallback=true` 表示本次由 LIKE 回退完成（FTS 未命中或不可用）。 */
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

/** 保存回执：只携带定位与时间戳，正文留在后端。 */
export interface DocSaveReceipt {
  id: number
  path: string
  rev: number
  updatedAt: string
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

// ---- Skills (M3, skill_*) ----

/** 技能摘要；初始 prompt 只注入这些字段，不含正文。 */
export interface SkillSummary {
  id: string
  name: string
  description: string
  triggers: string[]
  scope: string
  version: string
  enabled: boolean
  builtin: boolean
}

/** 触发后按需读取的完整技能。 */
export interface SkillDetail extends SkillSummary {
  body: string
}

/** 新建/更新技能的入参。 */
export interface SkillInput {
  id?: string
  name: string
  description: string
  triggers: string[]
  scope?: string
  version?: string
  body: string
}

// ---- Agent（chat_* / agent_*） ----

export type ChatRole = 'user' | 'assistant' | 'tool'

/** 一次会话；消息单独存储。 */
export interface ChatConversation {
  id: number
  title: string
  provider: string
  model: string
  createdAt: string
  updatedAt: string
  messageCount: number
}

/** Token usage recorded for one assistant reply. */
export interface MessageUsage {
  input: number
  output: number
  totalTokens: number
  cacheRead: number
  cacheWrite: number
}

/** 已落库的一条消息。 */
export interface ChatMessageRecord {
  id: number
  role: ChatRole
  content: string
  /** assistant 的工具调用 JSON（字符串）。 */
  toolCalls: string | null
  toolCallId: string | null
  toolName: string | null
  isError: boolean
  /** Token usage of this assistant reply; null on older rows. */
  usage: MessageUsage | null
  /** Reasoning text exposed by the model, if any. */
  thinking: string | null
  /** Provider signature required to replay Anthropic thinking blocks. */
  thinkingSignature: string | null
  /** Agent run that owns/produced this row. */
  runId: number | null
  /** JSON arguments of a tool call, kept so history can restore the card. */
  toolArgs: string | null
  toolDurationMs: number | null
  /** True when the answer was cut short by a cancel/interruption. */
  isPartial: boolean
  /** stop | aborted | error, when recorded. */
  stopReason: string | null
  /** Non-null marks a user row as steering guidance for that run. */
  steerOfRun: number | null
  createdAt: string
}

/** 追加消息的入参。 */
export interface NewChatMessage {
  role: ChatRole
  content: string
  toolCalls?: string | null
  toolCallId?: string | null
  toolName?: string | null
  isError?: boolean
  usage?: MessageUsage | null
  thinking?: string | null
  thinkingSignature?: string | null
  runId?: number | null
  toolArgs?: string | null
  toolDurationMs?: number | null
  isPartial?: boolean
  stopReason?: string | null
  steerOfRun?: number | null
}

/** Terminal and non-terminal states of one agent run. */
export type AgentRunStatus =
  | 'queued'
  | 'running'
  | 'cancelling'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'interrupted'

export type AgentRunTrigger = 'prompt' | 'steer' | 'resume' | 'retry'

/** One row of the run ledger. */
export interface AgentRun {
  runId: number
  conversationId: number
  status: AgentRunStatus
  trigger: AgentRunTrigger
  modelEntry: string
  stepCount: number
  writeCount: number
  lastSeq: number
  /** JSON `{ text }` snapshot for cancel/failure banners. */
  partial: string | null
  errorCode: string | null
  resumeFromMessageId: number | null
  createdAt: string
  updatedAt: string
  endedAt: string | null
}

/** Queued run plus the user message that will start it. */
export interface QueuedRun {
  run: AgentRun
  userMessage: ChatMessageRecord | null
}

/** Run state restored when a conversation is (re)opened. */
export interface AgentRunState {
  active: AgentRun | null
  latest: AgentRun | null
  queued: QueuedRun[]
}

/** Result of starting a run and its persisted user message. */
export interface AgentRunStart {
  run: AgentRun
  message: ChatMessageRecord | null
}

/** Wire protocol used by one user-defined model entry. */
export type ModelApiFormat = 'openai-chat' | 'openai-responses' | 'anthropic-messages'

/** One user-added model; never contains the API key itself. */
export interface AgentModelInfo {
  id: string
  label: string
  format: ModelApiFormat
  baseUrl: string
  /** True when the URL is the complete endpoint (no path appended). */
  fullUrl: boolean
  modelId: string
  /** Capability hints mirrored from the per-model params. */
  contextWindowInput?: number
  contextWindowOutput?: number
  /** Optional USD prices mirrored into the capability matrix. */
  inputPrice?: number
  outputPrice?: number
  configured: boolean
}

/** Model list payload; the app ships no preset models. */
export interface AgentSettings {
  activeId: string | null
  models: AgentModelInfo[]
}

/** Layered per-model generation parameters persisted by Rust. */
export interface LlmParams {
  temperature?: number
  topP?: number
  topK?: number
  maxTokens?: number
  stop?: string[]
  stream?: boolean
  timeoutSeconds?: number
  frequencyPenalty?: number
  presencePenalty?: number
  seed?: number
  logitBias?: Record<string, number>
  extra?: Record<string, unknown>
  contextWindowInput?: number
  contextWindowOutput?: number
  toolRounds?: number
  thinkingMode?: 'default' | 'on' | 'off'
  /** Prompt-cache preference; unset sends no cache hints. */
  cacheRetention?: 'none' | 'short' | 'long'
  /** Optional USD prices; metadata only, never sent in request bodies. */
  inputPrice?: number
  outputPrice?: number
}

export interface ConnectionTestResult {
  latencyMs: number
  status: number
  model: string
}

/** Remote MCP server configured by the user (token never returned). */
export interface McpServerInfo {
  id: string
  label: string
  url: string
  enabled: boolean
  configured: boolean
}

/** One tool advertised by an enabled MCP server. */
export interface McpToolInfo {
  serverId: string
  serverLabel: string
  /** Raw tool name on the server. */
  name: string
  /** Model-facing name; always starts with `mcp_`. */
  qualified: string
  description: string
  inputSchema: Record<string, unknown>
}
