//! 模型可见的全部工具：只有 5 个 `fs_*`。
//!
//! 这里不做任何路径或配额判断——真正的边界在 Rust 的 CapGate。
//! 前端只额外挡住 `/life/.agents` 的读取，避免技能正文被模型直接翻出来。

import type { AgentTool } from '@earendil-works/pi-agent-core'
import { Type } from '@earendil-works/pi-ai'
import { api } from '../api'
import type {
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

/** 5 个工具，与 `src-tauri/src/commands/fs.rs` 一一对应，不多不少。 */
export function createTools(): AgentTool[] {
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
      const result = await api.fsRead({
        path: input.path,
        rev: input.rev,
        startLine: input.startLine,
        endLine: input.endLine,
        includeMeta: input.includeMeta,
      })
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
      const receipt = await api.fsWrite({
        path: input.path,
        content: input.content,
        createParents: input.createParents ?? true,
        autoFrontmatter: input.autoFrontmatter ?? true,
      })
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
      const receipt = await api.fsEdit({
        path: input.path,
        oldString: input.oldString,
        newString: input.newString,
        replaceAll: input.replaceAll,
        expectRev: input.expectRev,
      })
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
      pattern: Type.String({ description: 'GLOB 模式，如 /life/diary/*.md' }),
      root: Type.Optional(Type.String({ description: '限定根目录，默认 /life' })),
      caseSensitive: Type.Optional(Type.Boolean({ description: '是否区分大小写' })),
    }),
    execute: async (_toolCallId, params) => {
      const input = params as { pattern: string; root?: string; caseSensitive?: boolean }
      assertReadableGlob(input.pattern, input.root)
      const entries = await api.fsGlob(input)
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
      maxResults: Type.Optional(Type.Number({ description: '最多返回条数，上限 200' })),
      contextLines: Type.Optional(Type.Number({ description: '上下文行数，上限 3' })),
    }),
    execute: async (_toolCallId, params) => {
      const input = params as {
        pattern: string
        path?: string
        maxResults?: number
        contextLines?: number
      }
      if (input.path) assertReadable(input.path)
      const result = await api.fsGrep(input)
      return { content: [{ type: 'text', text: renderGrep(result) }], details: result }
    },
  }

  return [read, write, edit, glob, grep]
}
