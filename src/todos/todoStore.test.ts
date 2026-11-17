import { describe, expect, it } from 'vitest'
import { legacyTodoId, parseTodoEntries, todoDocPath } from './todoFile'
import { TodoStore, type TodoDoc, type TodoPort } from './todoStore'

interface Fake {
  store: TodoStore
  docs: TodoDoc[]
  /** Ids soft-deleted (moved to the trash). */
  archived: Set<number>
  /** Ids hard-deleted (container files only). */
  deleted: Set<number>
  /** Move the fake clock, so "today" can change between calls. */
  advance: (today: string, now: string) => void
}

/**
 * In-memory stand-in for the VFS document API.
 *
 * It implements exactly the port the store is allowed to use, which keeps the
 * day-file rules testable without Tauri and proves the backend needs nothing
 * todo-specific.
 */
function makeFake(seed: Partial<TodoDoc>[] = []): Fake {
  const docs: TodoDoc[] = seed.map((doc, index) => ({
    id: doc.id ?? index + 1,
    rev: 1,
    path: doc.path ?? '/life/todos/legacy.md',
    title: doc.title ?? '',
    content: doc.content ?? '',
    fields: doc.fields ?? {},
    createdAt: doc.createdAt ?? '2026-11-17 09:00:00',
    updatedAt: doc.updatedAt ?? '2026-11-17 09:00:00',
  }))
  let nextDocId = docs.reduce((max, doc) => Math.max(max, doc.id), 0) + 1
  let nextTodoId = 1
  const state = { today: '2026-11-17', now: '2026-11-17T09:00:00' }
  const archived = new Set<number>()
  const deleted = new Set<number>()

  const port: TodoPort = {
    async listDocuments() {
      // The backend's default listing hides trashed documents.
      return docs.filter((doc) => !archived.has(doc.id)).map((doc) => ({ ...doc }))
    },
    async createDayFile(date, body) {
      const path = todoDocPath(date)
      // Mirrors the backend's alreadyExists on a duplicate create, including
      // the race the store has to tolerate.
      if (docs.some((doc) => doc.path === path)) throw new Error('alreadyExists')
      const doc: TodoDoc = {
        id: nextDocId++,
        rev: 1,
        path,
        title: `todo-${date}`,
        content: body,
        fields: {},
        createdAt: state.now,
        updatedAt: state.now,
      }
      docs.push(doc)
      return { ...doc }
    },
    async saveDayFile(doc, body) {
      const target = docs.find((item) => item.id === doc.id)
      if (!target) throw new Error('missing document')
      target.content = body
      target.rev += 1
    },
    async deleteDocument(id) {
      const index = docs.findIndex((item) => item.id === id)
      if (index >= 0) docs.splice(index, 1)
      deleted.add(id)
    },
    async archiveDocument(id) {
      archived.add(id)
    },
    now: () => state.now,
    today: () => state.today,
    newId: () => `t_n${nextTodoId++}`,
  }

  return {
    store: new TodoStore(port),
    docs,
    archived,
    deleted,
    advance: (today, now) => {
      state.today = today
      state.now = now
    },
  }
}

function dayFile(docs: TodoDoc[], date: string): TodoDoc {
  const doc = docs.find((item) => item.path === todoDocPath(date))
  if (!doc) throw new Error(`no day file for ${date}`)
  return doc
}

describe('one file per day', () => {
  it('puts several todos created the same day into a single file', async () => {
    const fake = makeFake()
    await fake.store.create({ title: '买菜' })
    await fake.store.create({ title: '发布 v1.2 给 Dr. Smith' })

    expect(fake.docs).toHaveLength(1)
    expect(fake.docs[0]?.path).toBe('/life/todos/todo-2026-11-17.md')
    expect(parseTodoEntries(dayFile(fake.docs, '2026-11-17').content).map((e) => e.title)).toEqual([
      '买菜',
      '发布 v1.2 给 Dr. Smith',
    ])
  })

  it('starts a new file when the day changes', async () => {
    const fake = makeFake()
    await fake.store.create({ title: '一' })
    fake.advance('2026-11-18', '2026-11-18T08:00:00')
    await fake.store.create({ title: '二' })

    expect(fake.docs.map((doc) => doc.path).sort()).toEqual([
      '/life/todos/todo-2026-11-17.md',
      '/life/todos/todo-2026-11-18.md',
    ])
    expect(await fake.store.list()).toHaveLength(2)
  })

  it('allows dots in titles: only file names reserve them for the extension', async () => {
    const fake = makeFake()
    const todo = await fake.store.create({ title: 'Dr. Smith 的 v1.2 评审' })
    expect(todo.title).toBe('Dr. Smith 的 v1.2 评审')
    expect((await fake.store.list())[0]?.title).toBe('Dr. Smith 的 v1.2 评审')
  })
})

describe('item identity', () => {
  it('ticks only the targeted entry', async () => {
    const fake = makeFake()
    const first = await fake.store.create({ title: '一' })
    const second = await fake.store.create({ title: '二' })

    await fake.store.toggle(first)

    const list = await fake.store.list()
    expect(list.find((todo) => todo.id === first.id)?.isCompleted).toBe(1)
    expect(list.find((todo) => todo.id === second.id)?.isCompleted).toBe(0)
  })

  it('edits title and due time without moving the entry', async () => {
    const fake = makeFake()
    const todo = await fake.store.create({ title: '一' })
    fake.advance('2026-11-18', '2026-11-18T08:00:00')

    await fake.store.update(todo, { title: '一（改名）', dueDate: '2026-11-20T10:00' })

    // Changing the deadline never moves the item to another day file.
    expect(fake.docs).toHaveLength(1)
    const [updated] = await fake.store.list()
    expect(updated?.title).toBe('一（改名）')
    expect(updated?.dueDate).toBe('2026-11-20T10:00')
    expect(updated?.date).toBe('2026-11-17')
  })

  it('tracks the deadline and the reminder independently', async () => {
    const fake = makeFake()
    const todo = await fake.store.create({ title: '一', remindAt: '2026-11-17T18:00' })
    expect(todo.dueDate).toBeNull()
    expect(todo.remindAt).toBe('2026-11-17T18:00')

    await fake.store.update(todo, { dueDate: '2026-11-20T09:00' })
    let [current] = await fake.store.list()
    expect(current?.dueDate).toBe('2026-11-20T09:00')
    expect(current?.remindAt).toBe('2026-11-17T18:00')

    await fake.store.update(todo, { remindAt: '2026-11-19T08:00' })
    ;[current] = await fake.store.list()
    expect(current?.remindAt).toBe('2026-11-19T08:00')
    expect(current?.dueDate).toBe('2026-11-20T09:00')
  })

  it('pins an entry and lists it first', async () => {
    const fake = makeFake()
    const older = await fake.store.create({ title: '先建的' })
    fake.advance('2026-11-17', '2026-11-17T10:00:00')
    await fake.store.create({ title: '后建的' })

    // Newest first by default.
    expect((await fake.store.list()).map((todo) => todo.title)).toEqual(['后建的', '先建的'])

    await fake.store.setPinned(older, true)

    const listed = await fake.store.list()
    expect(listed.map((todo) => todo.title)).toEqual(['先建的', '后建的'])
    expect(listed[0]?.isPinned).toBe(1)
  })

  it('unpins an entry back into creation order', async () => {
    const fake = makeFake()
    const first = await fake.store.create({ title: '一' })
    fake.advance('2026-11-17', '2026-11-17T10:00:00')
    await fake.store.create({ title: '二' })
    await fake.store.setPinned(first, true)
    expect((await fake.store.list())[0]?.title).toBe('一')

    await fake.store.setPinned(first, false)

    const listed = await fake.store.list()
    expect(listed.every((todo) => todo.isPinned === 0)).toBe(true)
    expect(listed[0]?.title).toBe('二')
  })

  it('moves an entry to another day file, keeping its id', async () => {
    const fake = makeFake()
    const moving = await fake.store.create({ title: '搬走的' })
    const staying = await fake.store.create({ title: '留下的' })

    await fake.store.moveToDate(moving, '2026-11-18')

    const sourceEntries = parseTodoEntries(dayFile(fake.docs, '2026-11-17').content)
    const targetEntries = parseTodoEntries(dayFile(fake.docs, '2026-11-18').content)
    expect(sourceEntries.map((entry) => entry.id)).toEqual([staying.id])
    expect(targetEntries.map((entry) => entry.id)).toEqual([moving.id])
    expect(targetEntries[0]?.created).toBe(moving.createdAt)
    expect((await fake.store.list()).find((todo) => todo.id === moving.id)?.date).toBe(
      '2026-11-18',
    )
  })

  it('deletes the day file once its last entry is removed', async () => {
    const fake = makeFake()
    const todo = await fake.store.create({ title: '唯一一条' })

    await fake.store.remove(todo)

    expect(fake.docs).toHaveLength(0)
  })

  it('keeps the day file while other entries remain', async () => {
    const fake = makeFake()
    const first = await fake.store.create({ title: '一' })
    const second = await fake.store.create({ title: '二' })

    await fake.store.remove(first)

    expect(parseTodoEntries(dayFile(fake.docs, '2026-11-17').content).map((e) => e.id)).toEqual([
      second.id,
    ])
  })
})

describe('legacy migration', () => {
  function legacySeed(): Partial<TodoDoc>[] {
    return [
      {
        id: 1,
        path: '/life/todos/买菜.md',
        title: '买菜',
        createdAt: '2026-11-17 09:00:00',
        updatedAt: '2026-11-17 09:30:00',
        fields: { completed: false, dueDate: '2026-11-17T18:00', reminder: true },
      },
      {
        id: 2,
        path: '/life/todos/写周报.md',
        title: '写周报',
        createdAt: '2026-11-17 10:00:00',
        updatedAt: '2026-11-17 10:00:00',
        fields: {},
      },
      {
        id: 3,
        path: '/life/todos/旧事.md',
        title: '旧事',
        createdAt: '2026-11-16 08:00:00',
        updatedAt: '2026-11-16 08:00:00',
        fields: { completed: true },
      },
    ]
  }

  it('groups a legacy todo without a date by its creation date', async () => {
    const fake = makeFake(legacySeed())

    const migrated = await fake.store.migrateLegacy()

    expect(migrated).toBe(3)
    const activePaths = fake.docs
      .filter((doc) => !fake.archived.has(doc.id))
      .map((doc) => doc.path)
      .sort()
    expect(activePaths).toEqual([
      '/life/todos/todo-2026-11-16.md',
      '/life/todos/todo-2026-11-17.md',
    ])
    const titles = (await fake.store.list()).map((todo) => todo.title).sort()
    expect(titles).toEqual(['写周报', '买菜', '旧事'].sort())
    // Archived, never purged: a grouping the user disagrees with stays
    // recoverable from the trash.
    expect([...fake.archived].sort()).toEqual([1, 2, 3])
    expect(fake.deleted.size).toBe(0)
  })

  it('keeps fields that the entry format supports', async () => {
    const fake = makeFake(legacySeed())
    await fake.store.list()

    const done = (await fake.store.list()).find((todo) => todo.title === '旧事')
    const scheduled = (await fake.store.list()).find((todo) => todo.title === '买菜')
    expect(done?.isCompleted).toBe(1)
    expect(scheduled?.dueDate).toBe('2026-11-17T18:00')
    // The old `reminder: true` flag decided that this deadline also notified.
    expect(scheduled?.remindAt).toBe('2026-11-17T18:00')
    expect(scheduled?.createdAt).toBe('2026-11-17T09:00:00')
  })

  it('splits a legacy deadline from a legacy reminder by the old flag', async () => {
    const fake = makeFake([
      {
        id: 1,
        path: '/life/todos/有提醒.md',
        title: '有提醒',
        createdAt: '2026-11-17 09:00:00',
        fields: { dueDate: '2026-11-17T18:00', reminder: true },
      },
      {
        id: 2,
        path: '/life/todos/只截止.md',
        title: '只截止',
        createdAt: '2026-11-17 09:00:00',
        fields: { dueDate: '2026-11-18T09:00', reminder: false },
      },
    ])

    const todos = await fake.store.list()
    const reminded = todos.find((todo) => todo.title === '有提醒')
    const deadlineOnly = todos.find((todo) => todo.title === '只截止')

    expect(reminded?.dueDate).toBe('2026-11-17T18:00')
    expect(reminded?.remindAt).toBe('2026-11-17T18:00')
    expect(deadlineOnly?.dueDate).toBe('2026-11-18T09:00')
    expect(deadlineOnly?.remindAt).toBeNull()
  })

  it('is idempotent across runs', async () => {
    const fake = makeFake(legacySeed())
    await fake.store.migrateLegacy()
    const again = await fake.store.migrateLegacy()

    expect(again).toBe(0)
    expect(await fake.store.list()).toHaveLength(3)
  })

  it('does not duplicate an entry already written before a crash', async () => {
    const already = legacyTodoId(7)
    const fake = makeFake([
      {
        id: 7,
        path: '/life/todos/买菜.md',
        title: '买菜',
        createdAt: '2026-11-17 09:00:00',
        fields: {},
      },
      {
        id: 8,
        path: '/life/todos/todo-2026-11-17.md',
        title: 'todo-2026-11-17',
        createdAt: '2026-11-17 09:00:00',
        content: `- [ ] {id: ${already}} 买菜\n  - created: 2026-11-17T09:00:00\n`,
      },
    ])

    const migrated = await fake.store.migrateLegacy()

    expect(migrated).toBe(0)
    expect(parseTodoEntries(dayFile(fake.docs, '2026-11-17').content)).toHaveLength(1)
    expect(fake.archived.has(7)).toBe(true)
  })

  it('leaves the archive recoverable and purges nothing', async () => {
    const fake = makeFake(legacySeed())
    await fake.store.migrateLegacy()

    // The originals are still in the store, just hidden from the default list.
    expect(fake.docs).toHaveLength(5)
    expect(fake.archived.size).toBe(3)
    expect(fake.deleted.size).toBe(0)
  })

  it('can list without triggering the migration', async () => {
    const fake = makeFake(legacySeed())

    const todos = await fake.store.list(undefined, { migrate: false })

    expect(todos).toEqual([])
    expect(fake.archived.size).toBe(0)
    expect(fake.docs).toHaveLength(3)
  })
})

describe('day files written by hand or by an agent', () => {
  it('lists hand-written checkboxes from two days without collapsing them', async () => {
    // No `{id:}` on either line, so both fall back to a positional id. Before the
    // id was namespaced by day, both were `t_p1` and the listing deduped one away.
    const fake = makeFake([
      {
        id: 1,
        path: '/life/todos/todo-2026-11-16.md',
        content: '- [ ] 周一的事\n',
      },
      {
        id: 2,
        path: '/life/todos/todo-2026-11-17.md',
        content: '- [ ] 周二的事\n',
      },
    ])

    const todos = await fake.store.list()

    expect(todos.map((todo) => todo.title).sort()).toEqual(['周一的事', '周二的事'])
    expect(new Set(todos.map((todo) => todo.id)).size).toBe(2)
  })

  it('ticks one hand-written entry without disturbing the other day', async () => {
    const fake = makeFake([
      { id: 1, path: '/life/todos/todo-2026-11-16.md', content: '- [ ] 周一的事\n' },
      { id: 2, path: '/life/todos/todo-2026-11-17.md', content: '- [ ] 周二的事\n' },
    ])
    const todos = await fake.store.list()
    const tuesday = todos.find((todo) => todo.title === '周二的事')

    await fake.store.toggle(tuesday!)

    const after = await fake.store.list()
    expect(after.find((todo) => todo.title === '周二的事')?.isCompleted).toBe(1)
    expect(after.find((todo) => todo.title === '周一的事')?.isCompleted).toBe(0)
  })
})

describe('day files with hand-written content', () => {
  it('keeps the prose when the last entry is removed', async () => {
    const fake = makeFake([
      {
        id: 1,
        path: '/life/todos/todo-2026-11-17.md',
        title: 'todo-2026-11-17',
        content: '- [ ] {id: t_only} 唯一一条\n\n这里是我手写的备注\n',
      },
    ])
    const [todo] = await fake.store.list()

    await fake.store.remove(todo!)

    expect(fake.deleted.has(1)).toBe(false)
    expect(fake.archived.has(1)).toBe(false)
    expect(parseTodoEntries(fake.docs[0]?.content ?? '')).toHaveLength(0)
    expect(fake.docs[0]?.content).toContain('这里是我手写的备注')
  })

  it('keeps the prose of an entry that is edited', async () => {
    const fake = makeFake([
      {
        id: 1,
        path: '/life/todos/todo-2026-11-17.md',
        title: 'todo-2026-11-17',
        content: '- [ ] {id: t_only} 唯一一条\n\n手写备注\n',
      },
    ])
    const [todo] = await fake.store.list()

    await fake.store.update(todo!, { title: '改过的' })

    expect(fake.docs[0]?.content).toContain('手写备注')
    expect(fake.docs[0]?.content).toContain('- [ ] {id: t_only} 改过的')
  })

  it('leaves a prose-bearing source file in place after a move', async () => {
    const fake = makeFake([
      {
        id: 1,
        path: '/life/todos/todo-2026-11-17.md',
        title: 'todo-2026-11-17',
        content: '- [ ] {id: t_only} 唯一一条\n\n手写备注\n',
      },
    ])
    const [todo] = await fake.store.list()

    await fake.store.moveToDate(todo!, '2026-11-18')

    expect(fake.deleted.has(1)).toBe(false)
    expect(fake.archived.has(1)).toBe(false)
    expect(fake.docs).toHaveLength(2)
    // The entry moved; the prose stayed behind.
    expect(parseTodoEntries(dayFile(fake.docs, '2026-11-17').content)).toHaveLength(0)
    expect(dayFile(fake.docs, '2026-11-17').content).toContain('手写备注')
    expect(parseTodoEntries(dayFile(fake.docs, '2026-11-18').content)).toHaveLength(1)
  })
})
