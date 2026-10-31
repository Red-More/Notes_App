//! 模型可见的工具：5 个 `fs_*` + 1 个技能元工具 `load_skill`。
//!
//! 这里不做任何路径或配额判断——真正的边界在 Rust 的 CapGate。
//! 前端只额外挡住 `/life/.agents` 的读取，避免技能正文被 fs_* 直接翻出来；
//! `load_skill` 只能按已启用技能的名称/id 读取正文，不暴露任意路径。

import type { AgentTool } from '@earendil-works/pi-agent-core'
import { Type } from '@earendil-works/pi-ai'
import { api, skillApi } from '../api'
import type {
  SkillSummary,
  VfsGlobEntry,
  VfsGrepResponse,
  VfsReadResult,
  VfsWriteReceipt,
} from '../types'

const AGENTS_PREFIX = '/life/.agents'

/** `.agents` 只读且不对模型开放：技能正文由 loader 按需注入（M3）。 */
function assertReadable(path: string): void {
  if (path === AGENTS_PREFIX || path.startsWith(`${AGENTS_PREFIX}/`)) {
    throw new Error('该路径属于只读技能区，模型不能直接读取；请改为读取 /life 下的用户文档')
  }
}

/**
 * glob 的 root 与 pattern 拼起来才算最终检索范围：
 * 相对 pattern（如 .agents/*.md）必须和 root 归一化后再校验。
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
export function createTools(skills: SkillSummary[] = []): AgentTool[] {
  const read: AgentTool = {
    name: 'fs_read',
    label: '读取文档',
    description:
      '读取 /life 下的一个文件，或列出目录。文件返回正文、行数与 rev。修改前先 read 拿到最新 rev。',
    parameters: Type.Object({
      path: Type.String({ description: '虚拟路径，如 /life/diary/2026-10-30.md' }),
      rev: Type.Optional(Type.Number({ description: '指定历史版本；省略读当前版本' })),
      startLine: Type.Optional(Type.Number({ description: '起始行（1 起）' })),
      endLine: Type.Optional(Type.Number({ description: '结束行（含）' })),
      includeMeta: Type.Optional(Type.Boolean({ description: '是否返回 frontmatter 元数据' })),
    }),
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
    label: '新建文档',
    description:
      '新建一个 Markdown 文档。只能新建，不能覆盖：目标已存在会返回 alreadyExists。追加内容请先 read 文件尾部，再用 fs_edit 锚定追加。',
    parameters: Type.Object({
      path: Type.String({ description: '虚拟路径；省略 .md 会自动补' }),
      content: Type.String({ description: 'Markdown 正文（可含 frontmatter）' }),
      createParents: Type.Optional(Type.Boolean({ description: '自动创建父目录，默认 true' })),
      autoFrontmatter: Type.Optional(
        Type.Boolean({ description: '按路径自动补 frontmatter，默认 true' }),
      ),
    }),
    executionMode: 'sequential',
    execute: async (_toolCallId, params) => {
      const input = params as {
        path: string
        content: string
        createParents?: boolean
        autoFrontmatter?: boolean
      }
      const outcome = await runTool(() =>
        api.fsWrite({
          path: input.path,
          content: input.content,
          createParents: input.createParents ?? true,
          autoFrontmatter: input.autoFrontmatter ?? true,
        }),
      )
      if (!outcome.ok) return toolFailure(outcome.text)
      const receipt = outcome.value
      return { content: [{ type: 'text', text: renderWrite(receipt) }], details: receipt }
    },
  }

  const edit: AgentTool = {
    name: 'fs_edit',
    label: '编辑文档',
    description:
      '按字符串替换修改已有文档，追加新 rev。old_string 必须唯一命中；追加内容时把它设为文件末尾附近的一段原文。带上 expectRev 可在版本冲突时被拒绝。',
    parameters: Type.Object({
      path: Type.String({ description: '虚拟路径' }),
      oldString: Type.String({ description: '要被替换的原文，必须唯一命中' }),
      newString: Type.String({ description: '替换后的文本；可包含追加内容' }),
      replaceAll: Type.Optional(Type.Boolean({ description: '是否替换全部命中，默认 false' })),
      expectRev: Type.Optional(
        Type.Number({ description: '乐观锁：read 到的 rev；不一致返回 conflict' }),
      ),
    }),
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
    label: '查找路径',
    description: '按路径模式查找文件或目录，最多 200 条。用于确认某类文档是否存在。',
    parameters: Type.Object({
      pattern: Type.String({
        description: 'GLOB 模式：绝对路径（如 /life/diary/*.md）或相对模式（配合 root）',
      }),
      root: Type.Optional(Type.String({ description: '相对模式的根目录，默认 /life' })),
      caseSensitive: Type.Optional(Type.Boolean({ description: '是否区分大小写' })),
    }),
    execute: async (_toolCallId, params) => {
      const input = params as { pattern: string; root?: string; caseSensitive?: boolean }
      assertReadableGlob(input.pattern, input.root)
      const outcome = await runTool(() => api.fsGlob(input))
      if (!outcome.ok) return toolFailure(outcome.text)
      const entries = outcome.value
      return { content: [{ type: 'text', text: renderGlob(entries) }], details: entries }
    },
  }

  const grep: AgentTool = {
    name: 'fs_grep',
    label: '内容搜索',
    description: '在 /life 下按内容搜索，返回 path:line 与上下文片段。默认最多 50 条。',
    parameters: Type.Object({
      pattern: Type.String({ description: '要搜索的文字' }),
      path: Type.Optional(Type.String({ description: '限定路径或目录，默认 /life' })),
      type: Type.Optional(
        Type.String({ description: '限定文档类型：note/todo/event/contact/diary' }),
      ),
      maxResults: Type.Optional(Type.Number({ description: '最多返回条数，上限 200' })),
      contextLines: Type.Optional(Type.Number({ description: '上下文行数，上限 3' })),
    }),
    execute: async (_toolCallId, params) => {
      const input = params as {
        pattern: string
        path?: string
        type?: string
        maxResults?: number
        contextLines?: number
      }
      if (input.path) assertReadable(input.path)
      const outcome = await runTool(() => api.fsGrep(input))
      if (!outcome.ok) return toolFailure(outcome.text)
      const result = outcome.value
      return { content: [{ type: 'text', text: renderGrep(result) }], details: result }
    },
  }

  const loadSkill: AgentTool = {
    name: 'load_skill',
    label: '加载技能',
    description:
      '按需读取一个已启用技能的完整指令。参数 name 使用技能索引中的 id 或名称；命中技能触发词后应先调用它，再按正文步骤执行。',
    parameters: Type.Object({
      name: Type.String({ description: '技能索引中的 id 或名称，例如 daily-review' }),
    }),
    execute: async (_toolCallId, params) => {
      const input = params as { name: string }
      const wanted = input.name.trim()
      const target = skills.find(
        (skill) => skill.enabled && (skill.id === wanted || skill.name === wanted),
      )
      if (!target) {
        return toolFailure(
          `未找到已启用的技能「${wanted}」；请只使用系统提示【技能索引】里的 id 或名称`,
        )
      }
      const outcome = await runTool(() => skillApi.read(target.id))
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

  return [read, write, edit, glob, grep, loadSkill]
}
