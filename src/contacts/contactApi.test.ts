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
    fields: { id: 'c_abc123', name: 'Dr. Smith' },
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
  it('names the file {name}-{id}.md and stores name + id in frontmatter', async () => {
    invoke.mockResolvedValueOnce(doc())

    const contact = await api.createContact({ name: 'Dr. Smith', tag: '客户' })

    const [command, args] = invoke.mock.calls[0] as [string, Record<string, unknown>]
    expect(command).toBe('doc_create')
    expect(args.kind).toBe('contact')
    expect(args.ext).toBe('md')
    // The dot in the name is preserved; only the id makes it unique.
    expect(args.title).toMatch(/^Dr\. Smith-c_[a-z0-9]{10}$/)
    const fields = args.fields as Record<string, unknown>
    expect(fields.name).toBe('Dr. Smith')
    expect(fields.id).toMatch(/^c_[a-z0-9]{10}$/)
    expect(fields.tag).toBe('客户')
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
          fields: { id: 'c_abc123', name: 'Dr. Jane' },
        }),
      )

    const contact = await api.updateContact({ id: 7, name: 'Dr. Jane' })

    const commands = invoke.mock.calls.map((call) => call[0])
    // One write command: the rename travels with the field update.
    expect(commands).toEqual(['doc_get', 'doc_save', 'doc_get'])
    const saveArgs = invoke.mock.calls[1]?.[1] as {
      fields: Record<string, unknown>
      renameBase: string
      renameExt: string
    }
    expect(saveArgs.renameBase).toBe('Dr. Jane-c_abc123')
    expect(saveArgs.renameExt).toBe('md')
    expect(saveArgs.fields.name).toBe('Dr. Jane')
    expect(saveArgs.fields.id).toBe('c_abc123')
    expect(contact.name).toBe('Dr. Jane')
    expect(contact.contactId).toBe('c_abc123')
  })

  it('still sends the current name so a field-only edit keeps the file name', async () => {
    invoke
      .mockResolvedValueOnce(doc())
      .mockResolvedValueOnce({ id: 7, path: doc().path, rev: 2 })
      .mockResolvedValueOnce(doc({ fields: { id: 'c_abc123', name: 'Dr. Smith', phone: '123' } }))

    await api.updateContact({ id: 7, name: 'Dr. Smith', phone: '123' })

    const commands = invoke.mock.calls.map((call) => call[0])
    expect(commands).toEqual(['doc_get', 'doc_save', 'doc_get'])
    const saveArgs = invoke.mock.calls[1]?.[1] as Record<string, unknown>
    expect(saveArgs.renameBase).toBe('Dr. Smith-c_abc123')
    expect((saveArgs.fields as Record<string, unknown>).phone).toBe('123')
  })

  it('refuses an illegal name before touching the backend', async () => {
    await expect(api.updateContact({ id: 7, name: 'A:B' })).rejects.toThrow('不能包含')
    expect(invoke).not.toHaveBeenCalled()
  })

  it('moves a legacy contact onto the {name}-{id} file name on first edit', async () => {
    invoke
      .mockResolvedValueOnce(
        doc({ id: 9, path: '/life/contacts/老联系人.md', title: '老联系人', fields: {} }),
      )
      .mockResolvedValueOnce({ id: 9, path: '/life/contacts/新名字-c_9.md', rev: 2 })
      .mockResolvedValueOnce(
        doc({
          id: 9,
          path: '/life/contacts/新名字-c_9.md',
          title: '新名字-c_9',
          fields: { id: 'c_9', name: '新名字' },
        }),
      )

    const contact = await api.updateContact({ id: 9, name: '新名字' })

    const saveArgs = invoke.mock.calls[1]?.[1] as Record<string, unknown>
    expect(saveArgs.renameBase).toBe('新名字-c_9')
    expect(contact.contactId).toBe('c_9')
    expect(contact.name).toBe('新名字')
  })
})

describe('listContacts', () => {
  it('reads the display name from frontmatter, falling back to a legacy title', async () => {
    invoke.mockResolvedValueOnce([
      doc(),
      doc({
        id: 9,
        path: '/life/contacts/老联系人.md',
        title: '老联系人',
        fields: {},
      }),
    ])

    const contacts = await api.listContacts({})

    expect(contacts.map((contact) => contact.name)).toEqual(['Dr. Smith', '老联系人'])
    expect(contacts.map((contact) => contact.contactId)).toEqual(['c_abc123', 'c_9'])
  })
})
