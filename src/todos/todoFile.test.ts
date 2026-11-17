import { describe, expect, it } from 'vitest'
import {
  checkboxCompleted,
  isPlainEntryFile,
  isTodoDocPath,
  legacyTodoId,
  localStamp,
  newTodoId,
  normaliseStamp,
  parseTodoEntries,
  renderTodoEntries,
  rewriteTodoBody,
  todoDateOfPath,
  todoDocPath,
  todayLocal,
  type TodoEntry,
} from './todoFile'

function entry(overrides: Partial<TodoEntry> = {}): TodoEntry {
  return {
    id: 't_a1',
    title: '买菜',
    done: false,
    created: '2026-11-17T09:00:00',
    updated: '2026-11-17T09:00:00',
    due: null,
    remind: null,
    pinned: false,
    repeat: 'none',
    extra: [],
    ...overrides,
  }
}

describe('day file paths', () => {
  it('maps a day to its file and back', () => {
    expect(todoDocPath('2026-11-17')).toBe('/life/todos/todo-2026-11-17.md')
    expect(todoDateOfPath('/life/todos/todo-2026-11-17.md')).toBe('2026-11-17')
    expect(isTodoDocPath('/life/todos/todo-2026-11-17.md')).toBe(true)
  })

  it('rejects anything that is not a day file', () => {
    expect(todoDateOfPath('/life/todos/买菜.md')).toBeNull()
    expect(todoDateOfPath('/life/todos/todo-2026-11-17.txt')).toBeNull()
    // A same-named document in another folder is an ordinary legacy todo.
    expect(todoDateOfPath('/life/notes/todo-2026-11-17.md')).toBeNull()
    expect(isTodoDocPath('/life/todos/买菜.md')).toBe(false)
  })
})

describe('render and parse', () => {
  it('round-trips a plain todo in two lines', () => {
    const body = renderTodoEntries([entry()])
    expect(body).toBe(
      '- [ ] {id: t_a1} 买菜\n  - created: 2026-11-17T09:00:00\n  - updated: 2026-11-17T09:00:00\n',
    )
    expect(parseTodoEntries(body)).toEqual([entry()])
  })

  it('writes only non-default sub-items', () => {
    const body = renderTodoEntries([entry({ done: true, due: '2026-11-17T18:00', pinned: true, repeat: 'weekly' })])
    expect(body).toContain('- [x] {id: t_a1} 买菜')
    expect(body).toContain('  - due: 2026-11-17T18:00')
    expect(body).toContain('  - pinned: true')
    expect(body).toContain('  - repeat: weekly')
  })

  it('keeps the deadline and the reminder as separate sub-items', () => {
    const body = renderTodoEntries([
      entry({ due: '2026-11-20T09:00', remind: '2026-11-19T09:00' }),
    ])

    expect(body).toContain('  - due: 2026-11-20T09:00')
    expect(body).toContain('  - remind: 2026-11-19T09:00')
    const [parsed] = parseTodoEntries(body)
    expect(parsed?.due).toBe('2026-11-20T09:00')
    expect(parsed?.remind).toBe('2026-11-19T09:00')
  })

  it('keeps dots in titles: they are free text, not file names', () => {
    const body = renderTodoEntries([entry({ title: '发布 v1.2 给 Dr. Smith' })])
    expect(parseTodoEntries(body)[0]?.title).toBe('发布 v1.2 给 Dr. Smith')
  })

  it('collapses newlines so one entry stays one line', () => {
    const body = renderTodoEntries([entry({ title: '第一行\n第二行' })])
    expect(parseTodoEntries(body)[0]?.title).toBe('第一行 第二行')
  })

  it('handles an empty title without leaving a trailing space', () => {
    const body = renderTodoEntries([entry({ title: '' })])
    expect(body.split('\n')[0]).toBe('- [ ] {id: t_a1}')
    expect(parseTodoEntries(body)[0]?.title).toBe('')
  })

  it('preserves unknown sub-items byte for byte', () => {
    const body = renderTodoEntries([entry({ extra: ['  - place: 超市'] })])
    expect(body).toContain('  - place: 超市')
    expect(parseTodoEntries(body)[0]?.extra).toEqual(['  - place: 超市'])
  })

  it('parses several entries in one file in order', () => {
    const body = renderTodoEntries([
      entry({ id: 't_a1', title: '一' }),
      entry({ id: 't_b2', title: '二', done: true }),
    ])
    expect(parseTodoEntries(body).map((item) => [item.id, item.title, item.done])).toEqual([
      ['t_a1', '一', false],
      ['t_b2', '二', true],
    ])
  })

  it('accepts a hand-written line without an id, stably', () => {
    const body = '- [ ] 手写的待办\n- [x] 另一条\n'
    const first = parseTodoEntries(body)
    const second = parseTodoEntries(body)
    expect(first.map((item) => item.id)).toEqual(['t_p1', 't_p2'])
    expect(second.map((item) => item.id)).toEqual(first.map((item) => item.id))
  })

  it('namespaces a positional id by day so two files never collide', () => {
    // Both files start with a hand-written checkbox. A bare ordinal would make
    // both entries `t_p1`, and the listing dedupes by id — one would vanish.
    const monday = parseTodoEntries('- [ ] 周一的事\n', '2026-11-16')
    const tuesday = parseTodoEntries('- [ ] 周二的事\n', '2026-11-17')

    expect(monday[0]?.id).toBe('t_p20261116_1')
    expect(tuesday[0]?.id).toBe('t_p20261117_1')
    expect(monday[0]?.id).not.toBe(tuesday[0]?.id)
  })

  it('keeps a namespaced positional id stable across re-parses', () => {
    const body = '- [ ] 一\n- [x] 二\n'
    const first = parseTodoEntries(body, '2026-11-17')
    const second = parseTodoEntries(body, '2026-11-17')
    expect(first.map((item) => item.id)).toEqual(['t_p20261117_1', 't_p20261117_2'])
    expect(second.map((item) => item.id)).toEqual(first.map((item) => item.id))
  })

  it('tolerates CRLF and an empty body', () => {
    expect(parseTodoEntries('')).toEqual([])
    expect(parseTodoEntries('- [ ] {id: t_a1} 买菜\r\n')[0]?.title).toBe('买菜')
  })
})

describe('ids and stamps', () => {
  it('generates ids with the t_ prefix', () => {
    expect(newTodoId()).toMatch(/^t_[a-z0-9]{10}$/)
    expect(newTodoId(() => 0)).toBe('t_aaaaaaaaaa')
  })

  it('derives deterministic legacy ids from the inode', () => {
    expect(legacyTodoId(42)).toBe('t_l42')
    expect(legacyTodoId(42)).toBe(legacyTodoId(42))
  })

  it('normalises database timestamps', () => {
    expect(normaliseStamp('2026-11-17 09:00:00')).toBe('2026-11-17T09:00:00')
    expect(normaliseStamp('2026-11-17T09:00:00')).toBe('2026-11-17T09:00:00')
    expect(normaliseStamp(' 2026-11-17 09:00:00 ')).toBe('2026-11-17T09:00:00')
  })

  it('formats local day and stamp without a timezone offset', () => {
    const when = new Date(2026, 10, 17, 9, 5, 3)
    expect(todayLocal(when)).toBe('2026-11-17')
    expect(localStamp(when)).toBe('2026-11-17T09:05:03')
  })
})

describe('isPlainEntryFile', () => {
  it('recognizes a pure container', () => {
    expect(isPlainEntryFile(renderTodoEntries([entry()]))).toBe(true)
    expect(isPlainEntryFile('')).toBe(true)
    expect(isPlainEntryFile('\n\n')).toBe(true)
  })

  it('reports hand-written content', () => {
    expect(isPlainEntryFile(`${renderTodoEntries([entry()])}\n备注\n`)).toBe(false)
    expect(isPlainEntryFile('> 引用\n')).toBe(false)
    expect(isPlainEntryFile('前言\n- [ ] {id: t_a} 一\n')).toBe(false)
  })
})

describe('rewriteTodoBody', () => {
  it('rewrites an entry in place and keeps the surrounding prose', () => {
    const body = `前言\n\n${renderTodoEntries([
      entry({ id: 't_a', title: '一' }),
    ])}\n尾注\n`
    const next = rewriteTodoBody(body, [
      entry({ id: 't_a', title: '一改', done: true }),
    ])

    expect(next).toContain('前言')
    expect(next).toContain('尾注')
    expect(next).toContain('- [x] {id: t_a} 一改')
    // In place: the rewritten entry stays between the prose blocks.
    expect(next.indexOf('前言')).toBeLessThan(next.indexOf('{id: t_a}'))
    expect(next.indexOf('{id: t_a}')).toBeLessThan(next.indexOf('尾注'))
  })

  it('drops a removed entry but keeps every other line', () => {
    const body = `抬头\n${renderTodoEntries([
      entry({ id: 't_a', title: '一' }),
      entry({ id: 't_b', title: '二' }),
    ])}`
    const next = rewriteTodoBody(body, [entry({ id: 't_b', title: '二' })])

    expect(next).not.toContain('t_a')
    expect(next).toContain('{id: t_b} 二')
    expect(next).toContain('抬头')
  })

  it('appends a new entry after the existing content', () => {
    const body = `前言\n\n${renderTodoEntries([entry({ id: 't_a', title: '一' })])}`
    const next = rewriteTodoBody(body, [
      entry({ id: 't_a', title: '一' }),
      entry({ id: 't_b', title: '二' }),
    ])

    expect(next).toContain('{id: t_a} 一')
    expect(next).toContain('{id: t_b} 二')
    expect(next.indexOf('{id: t_a}')).toBeLessThan(next.indexOf('{id: t_b}'))
  })

  it('keeps an empty body empty and a blank one blank', () => {
    expect(rewriteTodoBody('', [])).toBe('')
    expect(rewriteTodoBody('\n\n', []).trim()).toBe('')
  })
})

describe('checkboxCompleted', () => {
  it('reads the checkbox state of a legacy body', () => {
    expect(checkboxCompleted('- [x] 已做')).toBe(true)
    expect(checkboxCompleted('- [ ] 未做')).toBe(false)
    expect(checkboxCompleted('- [ ] 一\n- [x] 二')).toBe(false)
    expect(checkboxCompleted('没有复选框')).toBeNull()
  })
})
