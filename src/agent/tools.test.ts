//! Proves the model-facing tools cannot smuggle an identity field into the
//! command layer: the agent commands are called, never the user-facing ones.

import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  fsRead: vi.fn(),
  fsWrite: vi.fn(),
  fsEdit: vi.fn(),
  fsGlob: vi.fn(),
  fsGrep: vi.fn(),
  userRead: vi.fn(),
  userSearch: vi.fn(),
}))

vi.mock('../api', () => ({
  api: mocks,
  mcpApi: { callTool: vi.fn() },
  skillApi: { read: vi.fn() },
}))

import { createTools } from './tools'

const fileResult = {
  kind: 'file' as const,
  path: '/life/note.md',
  rev: 1,
  totalLines: 1,
  content: 'body',
  meta: null,
}

function tool(name: string) {
  const found = createTools().find((item) => item.name === name)
  if (!found) throw new Error(`missing tool ${name}`)
  return found
}

/** Call a tool with raw model arguments, bypassing the schema type. */
async function run(name: string, args: unknown): Promise<void> {
  const execute = tool(name).execute as (id: string, params: unknown) => Promise<unknown>
  await execute('call', args)
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.fsRead.mockResolvedValue(fileResult)
  mocks.fsGlob.mockResolvedValue([])
  mocks.fsGrep.mockResolvedValue({ hits: [], total: 0, fallback: false })
})

describe('agent tools cannot forge their principal', () => {
  it('keeps `principal` out of the published schemas', () => {
    for (const name of ['fs_read', 'fs_glob', 'fs_grep']) {
      const schema = tool(name).parameters as { properties?: Record<string, unknown> }
      expect(Object.keys(schema.properties ?? {})).not.toContain('principal')
    }
  })

  it('drops an injected principal before calling fs_read', async () => {
    const read = tool('fs_read')
    const prepared = read.prepareArguments!({ path: '/life/note.md', principal: 'user' })
    await run('fs_read', prepared)

    expect(mocks.fsRead).toHaveBeenCalledWith({ path: '/life/note.md' })
    expect(mocks.fsRead.mock.calls[0][0]).not.toHaveProperty('principal')
    expect(mocks.userRead).not.toHaveBeenCalled()
  })

  it('ignores an injected principal on fs_glob and stays on the agent command', async () => {
    await run('fs_glob', { pattern: '/life/*.md', principal: 'user' })

    expect(mocks.fsGlob).toHaveBeenCalledWith({
      pattern: '/life/*.md',
      root: undefined,
      caseSensitive: undefined,
    })
    expect(mocks.fsGlob.mock.calls[0][0]).not.toHaveProperty('principal')
    expect(mocks.userRead).not.toHaveBeenCalled()
    expect(mocks.userSearch).not.toHaveBeenCalled()
  })

  it('ignores an injected principal on fs_grep and stays on the agent command', async () => {
    await run('fs_grep', { pattern: 'body', principal: 'user' })

    expect(mocks.fsGrep.mock.calls[0][0]).not.toHaveProperty('principal')
    expect(mocks.userSearch).not.toHaveBeenCalled()
  })
})
