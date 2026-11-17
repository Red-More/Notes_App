//! Todo storage over the VFS day files.
//!
//! The Markdown body of `todo-{date}.md` is the only source of truth; this module
//! is the bridge between that text and the `Todo` DTO. It owns four rules:
//!
//! 1. One file per day — creating a second todo on the same day appends to the
//!    existing `todo-{date}.md` instead of creating another document.
//! 2. The item id survives edits, ticks and moves; it is the only identity.
//! 3. A move writes the destination first, then removes the source, so a failure
//!    can at worst duplicate an entry — never lose one.
//! 4. Legacy single-todo documents are folded into day files by their creation
//!    date, idempotently (deterministic ids, skip-existing, delete last).
//!
//! The backend is generic: it only stores documents and exposes list/create/
//! save/delete. Grouping policy stays here instead of leaking into the VFS.

import type { Todo } from '../types'
import {
  checkboxCompleted,
  isPlainEntryFile,
  isTodoDocPath,
  legacyTodoId,
  normaliseStamp,
  parseTodoEntries,
  renderTodoEntries,
  rewriteTodoBody,
  todoDateOfPath,
  todoDocPath,
  type TodoEntry,
} from './todoFile'

/** A document as this module needs to see it (a subset of the `Doc` DTO). */
export interface TodoDoc {
  id: number
  rev: number
  path: string
  /** Display title of the document (the file stem for a day file). */
  title: string
  content: string
  fields: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

/**
 * The VFS primitives this module is allowed to use.
 *
 * Keeping them behind a port lets the day-file rules be tested without Tauri,
 * and documents exactly which backend operations the migration depends on.
 */
export interface TodoPort {
  /** Every document of kind `todo`, day files and legacy entries alike. */
  listDocuments(): Promise<TodoDoc[]>
  createDayFile(date: string, body: string): Promise<TodoDoc>
  saveDayFile(doc: TodoDoc, body: string): Promise<void>
  /** Hard delete: only for a day file that holds nothing but entries. */
  deleteDocument(id: number): Promise<void>
  /** Soft delete: the file moves to the trash and stays recoverable. */
  archiveDocument(id: number): Promise<void>
  /** Local wall-clock stamp `YYYY-MM-DDTHH:MM:SS`. */
  now(): string
  /** Local date `YYYY-MM-DD` — the day file a new todo lands in. */
  today(): string
  newId(): string
}

export interface TodoInput {
  title: string
  /** Deadline; does not notify. */
  dueDate?: string | null
  /** Reminder time; the only value that triggers a notification. */
  remindAt?: string | null
  repeat?: string
}

export interface TodoPatch {
  title?: string
  dueDate?: string | null
  remindAt?: string | null
  repeat?: string
}

export interface TodoListOptions {
  /** Run the one-time legacy fold-in first (default true). */
  migrate?: boolean
}

function fieldString(fields: Record<string, unknown>, key: string): string {
  const value = fields[key]
  return typeof value === 'string' ? value.trim() : ''
}

function toTodo(doc: TodoDoc, date: string, entry: TodoEntry): Todo {
  return {
    id: entry.id,
    fileId: doc.id,
    date,
    title: entry.title,
    isCompleted: entry.done ? 1 : 0,
    dueDate: entry.due,
    remindAt: entry.remind,
    repeat: entry.repeat || 'none',
    isPinned: entry.pinned ? 1 : 0,
    createdAt: entry.created,
    updatedAt: entry.updated || entry.created,
  }
}

function legacyEntry(doc: TodoDoc): TodoEntry {
  const explicit = doc.fields.completed
  const done =
    typeof explicit === 'boolean' ? explicit : (checkboxCompleted(doc.content) ?? false)
  const due = fieldString(doc.fields, 'dueDate') || fieldString(doc.fields, 'due')
  const repeat = fieldString(doc.fields, 'repeat')
  // Legacy had a single `dueDate` that doubled as the reminder, gated by a
  // boolean `reminder`. Split it: the deadline is kept, and the reminder only
  // exists where the old flag actually enabled notifications.
  const reminded = doc.fields.reminder === true || doc.fields.reminder === 'true'
  const created = normaliseStamp(doc.createdAt)
  return {
    // Deterministic, so a re-run of the migration cannot duplicate the entry.
    id: legacyTodoId(doc.id),
    title: doc.title.trim() || '未命名待办',
    done,
    created,
    updated: normaliseStamp(doc.updatedAt) || created,
    due: due || null,
    remind: due && reminded ? due : null,
    pinned: doc.fields.pinned === true,
    repeat: repeat || 'none',
    extra: [],
  }
}

export class TodoStore {
  private readonly port: TodoPort

  constructor(port: TodoPort) {
    this.port = port
  }

  /**
   * All todos, newest first.
   *
   * `migrate` defaults to true and is the documented trigger for the one-time
   * legacy fold-in. A background caller (the reminder poller) passes false so a
   * periodic read never writes.
   */
  async list(search?: string, options: TodoListOptions = {}): Promise<Todo[]> {
    let docs = await this.port.listDocuments()
    if (options.migrate ?? true) {
      const legacy = docs.filter((doc) => !isTodoDocPath(doc.path))
      if (legacy.length > 0) {
        await this.foldLegacy(legacy)
        docs = await this.port.listDocuments()
      }
    }
    const todos: Todo[] = []
    const seen = new Set<string>()
    for (const doc of docs) {
      const date = todoDateOfPath(doc.path)
      if (!date) continue
      for (const entry of parseTodoEntries(doc.content, date)) {
        // A move writes the destination before deleting the source, so the same
        // id can briefly live in two files; show it once.
        if (seen.has(entry.id)) continue
        seen.add(entry.id)
        todos.push(toTodo(doc, date, entry))
      }
    }
    const needle = search?.trim()
    const filtered = needle ? todos.filter((todo) => todo.title.includes(needle)) : todos
    return filtered.sort(
      (a, b) =>
        // Pinned entries float above the rest, then newest first.
        b.isPinned - a.isPinned ||
        b.createdAt.localeCompare(a.createdAt) ||
        a.id.localeCompare(b.id),
    )
  }

  /** Add one todo to today's file, creating the file when it is the first. */
  async create(input: TodoInput): Promise<Todo> {
    const title = input.title.trim()
    if (!title) throw new Error('请输入待办内容')
    const now = this.port.now()
    const entry: TodoEntry = {
      id: this.port.newId(),
      title,
      done: false,
      created: now,
      updated: now,
      due: input.dueDate ?? null,
      remind: input.remindAt ?? null,
      pinned: false,
      repeat: input.repeat || 'none',
      extra: [],
    }
    const date = this.port.today()
    const doc = await this.apply(date, (entries) => {
      if (!entries.some((item) => item.id === entry.id)) entries.push(entry)
    })
    return toTodo(doc, date, entry)
  }

  /** Update title, deadline, reminder or repeat. Never moves the entry's day. */
  async update(todo: Todo, patch: TodoPatch): Promise<void> {
    const now = this.port.now()
    await this.apply(todo.date, (entries) => {
      const entry = this.requireEntry(entries, todo)
      if (patch.title != null) entry.title = patch.title.trim() || entry.title
      if (patch.dueDate !== undefined) entry.due = patch.dueDate
      if (patch.remindAt !== undefined) entry.remind = patch.remindAt
      if (patch.repeat !== undefined) entry.repeat = patch.repeat || 'none'
      entry.updated = now
    })
  }

  /** Flip one entry's checkbox. */
  async toggle(todo: Todo): Promise<void> {
    const now = this.port.now()
    await this.apply(todo.date, (entries) => {
      const entry = this.requireEntry(entries, todo)
      entry.done = !entry.done
      entry.updated = now
    })
  }

  /** Flip one entry's pin. Pinned todos sort above the rest in the list. */
  async setPinned(todo: Todo, pinned: boolean): Promise<void> {
    const now = this.port.now()
    await this.apply(todo.date, (entries) => {
      const entry = this.requireEntry(entries, todo)
      entry.pinned = pinned
      entry.updated = now
    })
  }

  /**
   * Remove one entry.
   *
   * A day file that holds nothing but entries disappears with its last todo. If
   * the user wrote prose into it, the file stays (archived when it has no entry
   * left) rather than being silently destroyed.
   */
  async remove(todo: Todo): Promise<void> {
    const docs = await this.port.listDocuments()
    const doc = docs.find((item) => item.path === todoDocPath(todo.date))
    if (!doc) return
    const remaining = parseTodoEntries(doc.content, todo.date).filter(
      (entry) => entry.id !== todo.id,
    )
    if (remaining.length === 0 && isPlainEntryFile(doc.content)) {
      // A pure container: nothing but the entry list, so the file goes too.
      await this.port.deleteDocument(doc.id)
      return
    }
    // Rewrite in place: hand-written prose in the file must survive.
    await this.port.saveDayFile(doc, rewriteTodoBody(doc.content, remaining, todo.date))
  }

  /**
   * Move one entry to another day file, keeping its id and creation time.
   *
   * The explicit "belongs to another day" action; changing the due date does not
   * move anything.
   */
  async moveToDate(todo: Todo, date: string): Promise<void> {
    if (date === todo.date) return
    const docs = await this.port.listDocuments()
    const source = docs.find((item) => item.path === todoDocPath(todo.date))
    if (!source) throw new Error('待办已不存在，请刷新')
    const entries = parseTodoEntries(source.content, todo.date)
    const entry = entries.find((item) => item.id === todo.id)
    if (!entry) throw new Error('待办已不存在，请刷新')

    // Destination first: if this fails the entry is still in its old file.
    await this.apply(date, (target) => {
      if (!target.some((item) => item.id === entry.id)) target.push(entry)
    })
    const remaining = entries.filter((item) => item.id !== todo.id)
    if (remaining.length === 0 && isPlainEntryFile(source.content)) {
      // Nothing left but the container itself.
      await this.port.deleteDocument(source.id)
    } else {
      // Removing the entry rewrites the source in place, so any prose the user
      // wrote into the day file stays where it is.
      await this.port.saveDayFile(source, rewriteTodoBody(source.content, remaining, todo.date))
    }
  }

  /**
   * Fold legacy single-todo documents into day files by their creation date.
   *
   * Idempotent on every axis: ids are derived from the inode, an entry that is
   * already present is skipped, and legacy documents are archived only after all
   * writes succeeded. A crash mid-run simply re-runs the same writes.
   */
  async migrateLegacy(): Promise<number> {
    const docs = await this.port.listDocuments()
    const legacy = docs.filter((doc) => !isTodoDocPath(doc.path))
    if (legacy.length === 0) return 0
    return this.foldLegacy(legacy)
  }

  /** Write the given legacy documents into their day files, then archive them. */
  private async foldLegacy(legacy: TodoDoc[]): Promise<number> {
    const groups = new Map<string, { created: string; entry: TodoEntry }[]>()
    for (const doc of legacy) {
      const entry = legacyEntry(doc)
      // A legacy todo has no day of its own, so the creation date decides.
      const date = entry.created.slice(0, 10) || this.port.today()
      const bucket = groups.get(date) ?? []
      bucket.push({ created: entry.created, entry })
      groups.set(date, bucket)
    }

    let migrated = 0
    for (const date of [...groups.keys()].sort()) {
      const items = (groups.get(date) ?? []).sort((a, b) => a.created.localeCompare(b.created))
      await this.apply(date, (entries) => {
        for (const item of items) {
          if (entries.some((entry) => entry.id === item.entry.id)) continue
          entries.push(item.entry)
          migrated += 1
        }
      })
    }
    // Cleanup only after every write landed, so no todo can be lost. Soft
    // delete: this is the one irreversible step of the whole model, so the
    // original documents stay restorable from the trash instead of being purged.
    for (const doc of legacy) await this.port.archiveDocument(doc.id)
    return migrated
  }

  /**
   * Read the day file, mutate its entries and persist the result.
   *
   * Relisting first keeps the write anchored to the current content; if another
   * writer created the file between the listing and the create, the entry is
   * folded into the file that won the race.
   */
  private async apply(
    date: string,
    mutate: (entries: TodoEntry[]) => void,
  ): Promise<TodoDoc> {
    const docs = await this.port.listDocuments()
    const existing = docs.find((doc) => doc.path === todoDocPath(date))
    if (existing) {
      const entries = parseTodoEntries(existing.content, date)
      mutate(entries)
      await this.port.saveDayFile(existing, rewriteTodoBody(existing.content, entries, date))
      return existing
    }

    const entries: TodoEntry[] = []
    mutate(entries)
    try {
      return await this.port.createDayFile(date, renderTodoEntries(entries))
    } catch (error) {
      const raced = (await this.port.listDocuments()).find(
        (doc) => doc.path === todoDocPath(date),
      )
      if (!raced) throw error
      const merged = parseTodoEntries(raced.content, date)
      mutate(merged)
      await this.port.saveDayFile(raced, rewriteTodoBody(raced.content, merged, date))
      return raced
    }
  }

  private requireEntry(entries: TodoEntry[], todo: Todo): TodoEntry {
    const entry = entries.find((item) => item.id === todo.id)
    if (!entry) throw new Error('待办已不存在，请刷新')
    return entry
  }
}
