//! 模型可见的工具：5 个 `fs_*` + 1 个技能元工具 `load_skill`。
//!
//! 这里不做任何路径或配额判断——真正的边界在 Rust 的 CapGate。
//! 前端只额外挡住 `.lifeos` 与 `ai.policy`，这两类配置对模型永久不可见；
//! `.agent` 是否可读由模型内部配置的 `visible` 决定，交给 Rust 判定。
//! `load_skill` 的 scope 交由 Rust 侧按 `.lifeos` 鉴权，并拒绝已停用技能。

import type { AgentTool } from '@earendil-works/pi-agent-core'
import { Type } from '@earendil-works/pi-ai'
import type { TSchema } from '@earendil-works/pi-ai'
import { api, mcpApi, skillApi } from '../api'
import type { McpToolInfo } from '../types'
import {
  argBoolean,
  argExtension,
  argNumber,
  argString,
  argsObject,
} from './args'
import type {
  SkillSummary,
  VfsGlobEntry,
  VfsGrepResponse,
  VfsReadResult,
  VfsWriteReceipt,
} from '../types'

const LIFEOS_DIR = '.lifeos'
const POLICY_FILE = 'ai.policy'

/**
 * Canonical English descriptors for the model-visible registry.
 * Chinese labels are deprecated; the identifier is the single display name.
 */
export const TOOL_DESCRIPTORS = {
  fs_read: 'fs_read',
  fs_write: 'fs_write',
  fs_edit: 'fs_edit',
  fs_glob: 'fs_glob',
  fs_grep: 'fs_grep',
  load_skill: 'load_skill',
} as const

/** `.lifeos` 与 `ai.policy` 永久不可见；`.agent` 的可见性由 Rust 侧配置决定。 */
function assertReadable(path: string): void {
  const segments = path.split('/').filter((segment) => segment !== '')
  const blocked =
    segments.includes(LIFEOS_DIR) || segments[segments.length - 1] === POLICY_FILE
  if (blocked) {
    throw new Error('该路径属于只读可见性配置，模型不能直接读取；请改为读取用户文档')
  }
}

/**
 * glob 的 root 与 pattern 拼起来才算最终检索范围：
 * 相对 pattern（如 .lifeos/ai.policy）必须和 root 归一化后再校验。
 */
function assertReadableGlob(pattern: string, root?: string): void {
  const base = (root ?? '/life').replace(/\/+$/, '')
  const effective = pattern.startsWith('/') ? pattern : `${base}/${pattern}`
  assertReadable(effective)
}

/** Map a serialized Rust `ToolError` to actionable Chinese text for the model. */
function toolErrorText(error: unknown): string {
  if (error instanceof Error) return error.message
  const err = error as {
    code?: string
    message?: string
    path?: string
    hint?: string
    root?: string
    permission?: string
    got?: string
    current?: number
    expect?: number
    limit?: number
    actual?: number
  }
  switch (err?.code) {
    case 'pathEscape':
      return `路径越界：${err.got} 必须位于 ${err.root} 内`
    case 'notFound':
      return `目标不存在：${err.path}`
    case 'notADirectory':
      return `不是目录：${err.path}`
    case 'isDirectory':
      return `目标是目录，不能按文件编辑：${err.path}`
    case 'alreadyExists':
      return `目标已存在，fs_write 不能覆盖：${err.path}；追加请先 read 再用 fs_edit`
    case 'parentMissing':
      return `父目录不存在：${err.path}`
    case 'readOnlyArea':
      return `该路径属于只读区，禁止写入：${err.path}`
    case 'permissionDenied':
      return `该路径未授权给 AI（需要 ${err.permission ?? 'read'} 权限）：${err.path}；默认只能访问 /life/ai_default，请让用户在设置中授权该文件夹`
    case 'conflict':
      return `版本冲突：当前 rev=${err.current}，期望 rev=${err.expect}；请重新 read 后再编辑`
    case 'noMatch':
      return `old_string 未命中：${err.hint}`
    case 'contentTooLarge':
      return `内容过大：${err.actual} 字节，上限 ${err.limit} 字节`
    case 'storage':
      return `存储错误：${err.message ?? '未知'}`
    default:
      return err?.message ?? '工具执行失败'
  }
}

/** Run a Tauri call; failures become readable `isError` results instead of thrown objects. */
async function runTool<T>(
  call: () => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; text: string }> {
  try {
    return { ok: true, value: await call() }
  } catch (error) {
    return { ok: false, text: toolErrorText(error) }
  }
}

function toolFailure(text: string) {
  return {
    content: [{ type: 'text' as const, text }],
    details: { error: text },
    isError: true,
  }
}

function renderRead(result: VfsReadResult): string {
  if (result.kind === 'dir') {
    if (result.entries.length === 0) return '（空目录）'
    return result.entries
      .map((entry) => `${entry.kind === 'directory' ? 'd' : 'f'} ${entry.path}`)
      .join('\n')
  }
  const head = [`path: ${result.path}`, `rev: ${result.rev}`, `totalLines: ${result.totalLines}`]
  if (result.meta) head.push(`meta: ${JSON.stringify(result.meta)}`)
  return `${head.join('\n')}\n\n${result.content}`
}

function renderGlob(entries: VfsGlobEntry[]): string {
  if (entries.length === 0) return '没有命中任何路径'
  return entries.map((entry) => `${entry.kind === 'directory' ? 'd' : 'f'} ${entry.path}`).join('\n')
}

function renderGrep(response: VfsGrepResponse): string {
  if (response.hits.length === 0) return '没有命中；可换一个更短的关键词再试'
  const lines = response.hits.map((hit) => `${hit.path}:${hit.line}: ${hit.preview}`)
  if (response.fallback) lines.push('（本次为 LIKE 回退检索）')
  return `共 ${response.total} 条\n${lines.join('\n')}`
}

function renderWrite(receipt: VfsWriteReceipt): string {
  return `已新建 ${receipt.path}（rev=${receipt.rev}，${receipt.bytes} 字节）`
}

/** 5 个 fs_* 与 `commands/fs.rs` 一一对应；`load_skill` 只读已启用技能。 */
export function createTools(
  skills: SkillSummary[] = [],
  mcpTools: McpToolInfo[] = [],
): AgentTool[] {
  const read: AgentTool = {
    name: 'fs_read',
    label: TOOL_DESCRIPTORS.fs_read,
    description: '读取文件内容，或列出目录下的条目。',
    parameters: Type.Object({
      path: Type.String({ description: '文件或目录路径' }),
      rev: Type.Optional(Type.Number({ description: '指定历史版本；省略读当前版本' })),
      startLine: Type.Optional(Type.Number({ description: '起始行（1 起）' })),
      endLine: Type.Optional(Type.Number({ description: '结束行（含）' })),
      includeMeta: Type.Optional(
        Type.Boolean({ description: '是否返回元数据（Markdown 为 frontmatter，其它取文件名）' }),
      ),
    }),
    // Weak models often send "10" as a string or a JSON string for args.
    prepareArguments: (raw) => {
      const args = argsObject(raw)
      return {
        path: argString(args.path) ?? '',
        rev: argNumber(args.rev),
        startLine: argNumber(args.startLine),
        endLine: argNumber(args.endLine),
        includeMeta: argBoolean(args.includeMeta),
      }
    },
    execute: async (_toolCallId, params) => {
      const input = params as {
        path: string
        rev?: number
        startLine?: number
        endLine?: number
        includeMeta?: boolean
      }
      assertReadable(input.path)
      const outcome = await runTool(() =>
        api.fsRead({
          path: input.path,
          rev: input.rev,
          startLine: input.startLine,
          endLine: input.endLine,
          includeMeta: input.includeMeta,
        }),
      )
      if (!outcome.ok) return toolFailure(outcome.text)
      const result = outcome.value
      return { content: [{ type: 'text', text: renderRead(result) }], details: result }
    },
  }

  const write: AgentTool = {
    name: 'fs_write',
    label: TOOL_DESCRIPTORS.fs_write,
    description: '新建一个文件并写入内容；目标已存在时返回错误。',
    parameters: Type.Object({
      path: Type.String({ description: '文件路径，按原样写入，不补扩展名' }),
      content: Type.String({ description: '文件内容' }),
      createParents: Type.Optional(Type.Boolean({ description: '自动创建父目录，默认 true' })),
    }),
    prepareArguments: (raw) => {
      const args = argsObject(raw)
      return {
        path: argString(args.path) ?? '',
        content: typeof args.content === 'string' ? args.content : String(args.content ?? ''),
        createParents: argBoolean(args.createParents),
      }
    },
    executionMode: 'sequential',
    execute: async (_toolCallId, params) => {
      const input = params as {
        path: string
        content: string
        createParents?: boolean
      }
      const outcome = await runTool(() =>
        api.fsWrite({
          path: input.path,
          content: input.content,
          createParents: input.createParents ?? true,
        }),
      )
      if (!outcome.ok) return toolFailure(outcome.text)
      const receipt = outcome.value
      return { content: [{ type: 'text', text: renderWrite(receipt) }], details: receipt }
    },
  }

  const edit: AgentTool = {
    name: 'fs_edit',
    label: TOOL_DESCRIPTORS.fs_edit,
    description: '用字符串替换的方式修改文件内容。',
    parameters: Type.Object({
      path: Type.String({ description: '文件路径' }),
      oldString: Type.String({ description: '要被替换的原文，必须唯一命中' }),
      newString: Type.String({ description: '替换后的文本；可包含追加内容' }),
      replaceAll: Type.Optional(Type.Boolean({ description: '是否替换全部命中，默认 false' })),
      expectRev: Type.Optional(
        Type.Number({ description: '乐观锁：read 到的 rev；不一致返回 conflict' }),
      ),
    }),
    prepareArguments: (raw) => {
      const args = argsObject(raw)
      return {
        path: argString(args.path) ?? '',
        oldString: typeof args.oldString === 'string' ? args.oldString : String(args.oldString ?? ''),
        newString: typeof args.newString === 'string' ? args.newString : String(args.newString ?? ''),
        replaceAll: argBoolean(args.replaceAll),
        expectRev: argNumber(args.expectRev),
      }
    },
    executionMode: 'sequential',
    execute: async (_toolCallId, params) => {
      const input = params as {
        path: string
        oldString: string
        newString: string
        replaceAll?: boolean
        expectRev?: number
      }
      assertReadable(input.path)
      const outcome = await runTool(() =>
        api.fsEdit({
          path: input.path,
          oldString: input.oldString,
          newString: input.newString,
          replaceAll: input.replaceAll,
          expectRev: input.expectRev,
        }),
      )
      if (!outcome.ok) return toolFailure(outcome.text)
      const receipt = outcome.value
      return {
        content: [
          { type: 'text', text: `已更新 ${receipt.path}（rev=${receipt.rev}）` },
        ],
        details: receipt,
      }
    },
  }

  const glob: AgentTool = {
    name: 'fs_glob',
    label: TOOL_DESCRIPTORS.fs_glob,
    description: '按 glob 模式查找文件与目录。',
    parameters: Type.Object({
      pattern: Type.String({
        description: 'GLOB 模式：绝对路径（如 /life/ai_default/*.md）或相对模式（配合 root）',
      }),
      root: Type.Optional(Type.String({ description: '相对模式的根目录' })),
      caseSensitive: Type.Optional(Type.Boolean({ description: '是否区分大小写' })),
    }),
    prepareArguments: (raw) => {
      const args = argsObject(raw)
      return {
        pattern: argString(args.pattern) ?? '',
        root: argString(args.root),
        caseSensitive: argBoolean(args.caseSensitive),
      }
    },
    execute: async (_toolCallId, params) => {
      const input = params as { pattern: string; root?: string; caseSensitive?: boolean }
      assertReadableGlob(input.pattern, input.root)
      // Rebuild the request explicitly so model-supplied extras never reach the command.
      const outcome = await runTool(() =>
        api.fsGlob({
          pattern: input.pattern,
          root: input.root,
          caseSensitive: input.caseSensitive,
        }),
      )
      if (!outcome.ok) return toolFailure(outcome.text)
      const entries = outcome.value
      return { content: [{ type: 'text', text: renderGlob(entries) }], details: entries }
    },
  }

  const grep: AgentTool = {
    name: 'fs_grep',
    label: TOOL_DESCRIPTORS.fs_grep,
    description: '按内容搜索文件，返回命中行与上下文。',
    parameters: Type.Object({
      pattern: Type.String({ description: '要搜索的文字' }),
      path: Type.Optional(Type.String({ description: '限定路径或目录' })),
      extension: Type.Optional(
        Type.String({
          description:
            '限定文件扩展名，如 md、py、json；可带或不带点，大小写不敏感。省略表示搜索全部类型',
        }),
      ),
      maxResults: Type.Optional(Type.Number({ description: '最多返回条数，上限 200' })),
      contextLines: Type.Optional(Type.Number({ description: '上下文行数，上限 3' })),
    }),
    prepareArguments: (raw) => {
      const args = argsObject(raw)
      return {
        pattern: argString(args.pattern) ?? '',
        path: argString(args.path),
        extension: argExtension(args.extension),
        // `type` was the removed document-kind filter. Keep it only so the tool
        // can tell the model why it no longer applies, instead of silently
        // matching zero files.
        legacyType: argString(args.type),
        maxResults: argNumber(args.maxResults),
        contextLines: argNumber(args.contextLines),
      }
    },
    execute: async (_toolCallId, params) => {
      const input = params as {
        pattern: string
        path?: string
        extension?: string
        legacyType?: string
        maxResults?: number
        contextLines?: number
      }
      if (input.legacyType) {
        return toolFailure(
          'fs_grep 的 type 参数已移除；请改用 extension（例如 md、json），省略则搜索全部类型',
        )
      }
      if (input.path) assertReadable(input.path)
      // Rebuild the request explicitly so model-supplied extras never reach the command.
      const outcome = await runTool(() =>
        api.fsGrep({
          pattern: input.pattern,
          path: input.path,
          extension: input.extension,
          maxResults: input.maxResults,
          contextLines: input.contextLines,
        }),
      )
      if (!outcome.ok) return toolFailure(outcome.text)
      const result = outcome.value
      return { content: [{ type: 'text', text: renderGrep(result) }], details: result }
    },
  }

  const loadSkill: AgentTool = {
    name: 'load_skill',
    label: TOOL_DESCRIPTORS.load_skill,
    description:
      '按需读取一个已启用技能的完整指令。参数 name 使用已启用技能的 id 或名称；若系统提示词中没有技能索引，请依据用户明确给出的技能名称调用。可选 path 指定当前访问的文件或目录，用于解析该目录及其父级的局部技能。',
    parameters: Type.Object({
      name: Type.String({ description: '技能索引中的 id 或名称，例如 contact-manager' }),
      path: Type.Optional(
        Type.String({ description: '当前访问的文件或目录；省略时使用默认工作区' }),
      ),
    }),
    prepareArguments: (raw) => {
      const args = argsObject(raw)
      return { name: argString(args.name) ?? '', path: argString(args.path) }
    },
    execute: async (_toolCallId, params) => {
      const input = params as { name: string; path?: string }
      const wanted = input.name.trim()
      const scope = input.path?.trim()
      let id = wanted
      if (!scope) {
        const target = skills.find(
          (skill) => skill.enabled && (skill.id === wanted || skill.name === wanted),
        )
        if (!target) {
          return toolFailure(
            `未找到已启用的技能「${wanted}」；请只使用系统提示【技能索引】里的 id 或名称`,
          )
        }
        id = target.id
      }
      const outcome = await runTool(() => skillApi.readForAgent(id, scope))
      if (!outcome.ok) return toolFailure(outcome.text)
      const detail = outcome.value
      return {
        content: [{ type: 'text', text: `技能：${detail.name}\n\n${detail.body}` }],
        details: detail,
      }
    },
    // 只读元数据：允许与其它读工具并行，不占用写配额。
    executionMode: 'parallel',
  }

  // Remote MCP tools are namespaced (`mcp_*`) and always run sequentially.
  const remoteTools: AgentTool[] = mcpTools.map((tool) => ({
    name: tool.qualified,
    label: `${tool.serverLabel} · ${tool.name}`,
    description: tool.description || `调用远程工具 ${tool.name}`,
    parameters: tool.inputSchema as unknown as TSchema,
    executionMode: 'sequential',
    execute: async (_toolCallId, params) => {
      const outcome = await runTool(() =>
        mcpApi.callTool({
          serverId: tool.serverId,
          tool: tool.name,
          arguments: params as Record<string, unknown>,
        }),
      )
      if (!outcome.ok) return toolFailure(outcome.text)
      return {
        content: [{ type: 'text', text: outcome.value }],
        details: { server: tool.serverId, tool: tool.name },
      }
    },
  }))

  return [read, write, edit, glob, grep, loadSkill, ...remoteTools]
}
