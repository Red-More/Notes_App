import { beforeEach, describe, expect, it, vi } from 'vitest'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke }))

import { api } from '../api'

/** A `Doc` DTO as the backend returns it. */
function doc(overrides: Record<string, unknown> = {}) {
  return {
    id: 7,
    path: '/life/contacts/Dr. Smith-c_abc123.md',
    ext: 'md',
    format: 'markdown',
    kind: 'contact',
    title: 'Dr. Smith-c_abc123',
    content: '',
    fields: { id: 'c_abc123' },
    folderId: null,
    folderName: null,
    pinned: 0,
    rev: 1,
    createdAt: '2026-11-17 09:00:00',
    updatedAt: '2026-11-17 09:00:00',
    deletedAt: null,
    ...overrides,
  }
}

beforeEach(() => {
  invoke.mockReset()
})

describe('createContact', () => {
  it('names the file {name}-{id}.md and writes the details into the body', async () => {
    invoke.mockResolvedValueOnce(doc())

    const contact = await api.createContact({
      name: 'Dr. Smith',
      tags: [{ key: '类别', values: ['客户'], multiple: false }],
      phone: '123',
    })

    const [command, args] = invoke.mock.calls[0] as [string, Record<string, unknown>]
    expect(command).toBe('doc_create')
    expect(args.kind).toBe('contact')
    expect(args.ext).toBe('md')
    // The dot in the name is preserved; only the id makes it unique.
    expect(args.title).toMatch(/^Dr\. Smith-c_[a-z0-9]{10}$/)
    // The body carries what the user typed; frontmatter only keeps the id.
    const content = args.content as string
    expect(content).toContain('- 电话：123')
    expect(content).toContain('- 标签：类别=客户')
    const fields = args.fields as Record<string, unknown>
    expect(fields.id).toMatch(/^c_[a-z0-9]{10}$/)
    expect(fields.name).toBeNull()
    expect(fields.phone).toBeNull()
    expect(contact.name).toBe('Dr. Smith')
  })

  it('refuses an illegal name before touching the backend', async () => {
    await expect(api.createContact({ name: 'A/B' })).rejects.toThrow('不能包含')
    expect(invoke).not.toHaveBeenCalled()
  })
})

describe('updateContact', () => {
  it('renames and saves in one call so a failure cannot half-apply', async () => {
    invoke
      .mockResolvedValueOnce(doc())
      .mockResolvedValueOnce({ id: 7, path: '/life/contacts/Dr. Jane-c_abc123.md', rev: 2 })
      .mockResolvedValueOnce(
        doc({
          path: '/life/contacts/Dr. Jane-c_abc123.md',
          title: 'Dr. Jane-c_abc123',
          content: '- 标签：类别=客户',
        }),
      )

    const contact = await api.updateContact({
      id: 7,
      name: 'Dr. Jane',
      tags: [{ key: '类别', values: ['客户'], multiple: false }],
    })

    const commands = invoke.mock.calls.map((call) => call[0])
    // One write command: the rename travels with the body update.
    expect(commands).toEqual(['doc_get', 'doc_save', 'doc_get'])
    const saveArgs = invoke.mock.calls[1]?.[1] as {
      content: string
      fields: Record<string, unknown>
      renameBase: string
      renameExt: string
    }
    expect(saveArgs.renameBase).toBe('Dr. Jane-c_abc123')
    expect(saveArgs.renameExt).toBe('md')
    expect(saveArgs.content).toContain('- 标签：类别=客户')
    expect(saveArgs.fields.id).toBe('c_abc123')
    expect(saveArgs.fields.name).toBeNull()
    expect(contact.name).toBe('Dr. Jane')
    expect(contact.contactId).toBe('c_abc123')
  })

  it('keeps paragraphs the user added in the note editor', async () => {
    invoke
      .mockResolvedValueOnce(
        doc({ content: '- 电话：123\n\n## 备注\n\n老备注\n\n## 其他\n\n别删我' }),
      )
      .mockResolvedValueOnce({ id: 7, path: doc().path, rev: 2 })
      .mockResolvedValueOnce(doc({ content: '- 电话：456' }))

    await api.updateContact({ id: 7, name: 'Dr. Smith', phone: '456' })

    const saveArgs = invoke.mock.calls[1]?.[1] as { content: string }
    expect(saveArgs.content).toContain('- 电话：456')
    expect(saveArgs.content).not.toContain('- 电话：123')
    // 未在表单里出现的段落必须原样保留。
    expect(saveArgs.content).toContain('## 其他')
    expect(saveArgs.content).toContain('别删我')
  })

  it('still sends the current name so a field-only edit keeps the file name', async () => {
    invoke
      .mockResolvedValueOnce(doc())
      .mockResolvedValueOnce({ id: 7, path: doc().path, rev: 2 })
      .mockResolvedValueOnce(doc({ content: '- 电话：123' }))

    await api.updateContact({ id: 7, name: 'Dr. Smith', phone: '123' })

    const commands = invoke.mock.calls.map((call) => call[0])
    expect(commands).toEqual(['doc_get', 'doc_save', 'doc_get'])
    const saveArgs = invoke.mock.calls[1]?.[1] as Record<string, unknown>
    expect(saveArgs.renameBase).toBe('Dr. Smith-c_abc123')
    expect(saveArgs.content).toContain('- 电话：123')
  })

  it('refuses an illegal name before touching the backend', async () => {
    await expect(api.updateContact({ id: 7, name: 'A:B' })).rejects.toThrow('不能包含')
    expect(invoke).not.toHaveBeenCalled()
  })

  it('moves a legacy contact onto the {name}-{id} file name on first edit', async () => {
    invoke
      .mockResolvedValueOnce(
        doc({
          id: 9,
          path: '/life/contacts/老联系人.md',
          title: '老联系人',
          content: '- 电话：110',
          fields: {},
        }),
      )
      .mockResolvedValueOnce({ id: 9, path: '/life/contacts/新名字-c_9.md', rev: 2 })
      .mockResolvedValueOnce(
        doc({
          id: 9,
          path: '/life/contacts/新名字-c_9.md',
          title: '新名字-c_9',
          content: '- 电话：110',
          fields: { id: 'c_9' },
        }),
      )

    const contact = await api.updateContact({ id: 9, name: '新名字', phone: '110' })

    const saveArgs = invoke.mock.calls[1]?.[1] as Record<string, unknown>
    expect(saveArgs.renameBase).toBe('新名字-c_9')
    expect(saveArgs.content).toContain('- 电话：110')
    expect(contact.contactId).toBe('c_9')
    expect(contact.name).toBe('新名字')
  })
})

describe('listContacts', () => {
  it('reads the details from the body and falls back to legacy frontmatter', async () => {
    invoke.mockResolvedValueOnce([
      doc({ content: '- 电话：123\n- 公司：星尘\n- 标签：类别=客户' }),
      // 旧联系人：字段还在 frontmatter，正文是空的。
      doc({
        id: 9,
        path: '/life/contacts/老联系人.md',
        title: '老联系人',
        fields: { name: '老联系人', phone: '110', tag: '朋友' },
      }),
    ])

    const contacts = await api.listContacts({})

    expect(contacts.map((contact) => contact.name)).toEqual(['Dr. Smith', '老联系人'])
    expect(contacts.map((contact) => contact.contactId)).toEqual(['c_abc123', 'c_9'])
    expect(contacts[0]?.phone).toBe('123')
    expect(contacts[0]?.company).toBe('星尘')
    expect(contacts[0]?.tags).toEqual([{ key: '类别', values: ['客户'], multiple: false }])
    expect(contacts[1]?.phone).toBe('110')
    // 旧的单标签包成默认分组，界面仍然能显示。
    expect(contacts[1]?.tags).toEqual([{ key: '类别', values: ['朋友'], multiple: false }])
  })

  it('filters by any tag value in the frontend because tags live in the body', async () => {
    invoke.mockResolvedValueOnce([
      doc({ content: '- 标签：类别=客户' }),
      doc({
        id: 9,
        path: '/life/contacts/甲-c_9.md',
        title: '甲-c_9',
        content: '- 标签：类别=朋友',
        fields: {},
      }),
      doc({
        id: 10,
        path: '/life/contacts/乙-c_10.md',
        title: '乙-c_10',
        content: '- 标签：城市（多选）=北京、上海',
        fields: {},
      }),
    ])

    const contacts = await api.listContacts({ tag: '上海' })

    const [command, args] = invoke.mock.calls[0] as [string, Record<string, unknown>]
    expect(command).toBe('doc_list')
    // 正文必须取回，否则解析不出标签。
    expect(args.includeContent).toBe(true)
    expect(args.tag).toBeUndefined()
    expect(contacts.map((contact) => contact.contactId)).toEqual(['c_10'])
  })
})
