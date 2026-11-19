import { describe, expect, it } from 'vitest'
import {
  contactBase,
  contactDisplayName,
  contactIdOf,
  contactNameError,
  newContactId,
} from './contactFile'

describe('contactNameError', () => {
  it('accepts free-text names with dots', () => {
    expect(contactNameError('Dr. Smith')).toBeNull()
    expect(contactNameError('Dr. Jane Smith Jr.')).toBeNull()
    expect(contactNameError('张.三')).toBeNull()
    expect(contactNameError('  Dr. Smith  ')).toBeNull()
  })

  it('rejects path-illegal characters instead of rewriting them', () => {
    expect(contactNameError('A/B')).toContain('不能包含')
    expect(contactNameError('A\\B')).toContain('不能包含')
    expect(contactNameError('A:B')).toContain('不能包含')
    expect(contactNameError('A*B')).toContain('不能包含')
    expect(contactNameError('A\u0000B')).toContain('不能包含')
  })

  it('rejects an empty name', () => {
    expect(contactNameError('   ')).toBe('请输入联系人姓名')
  })

  it('bounds the length so name + id still fit a 120-char file name', () => {
    expect(contactNameError('名'.repeat(100))).toBeNull()
    expect(contactNameError('名'.repeat(101))).toContain('最多')
  })
})

describe('contactBase and ids', () => {
  it('composes {name}-{id}', () => {
    expect(contactBase('Dr. Smith', 'c_abc123')).toBe('Dr. Smith-c_abc123')
    expect(contactBase('  Dr. Smith  ', 'c_abc123')).toBe('Dr. Smith-c_abc123')
  })

  it('generates ids with the c_ prefix', () => {
    expect(newContactId()).toMatch(/^c_[a-z0-9]{10}$/)
    expect(newContactId(() => 0)).toBe('c_aaaaaaaaaa')
  })

  it('reads the stored id, else derives one from the inode', () => {
    expect(contactIdOf({ id: 'c_abc123' }, 7)).toBe('c_abc123')
    expect(contactIdOf({ id: '' }, 7)).toBe('c_7')
    expect(contactIdOf({}, 42)).toBe('c_42')
  })
})

describe('contactDisplayName', () => {
  it('reads the name from the file name, stripping the id suffix', () => {
    expect(contactDisplayName({ id: 'c_abc' }, 'Dr. Smith-c_abc', 'c_abc')).toBe('Dr. Smith')
  })

  it('leaves a legacy title without a suffix alone', () => {
    expect(contactDisplayName({}, 'Dr. Smith', 'c_7')).toBe('Dr. Smith')
  })

  it('falls back to a legacy frontmatter name when the title has no id suffix', () => {
    // 旧文件可能只把姓名写在 frontmatter 里，文件名没有 id 后缀。
    expect(contactDisplayName({ name: 'Dr. Smith' }, '老联系人', 'c_7')).toBe('Dr. Smith')
  })

  it('ignores a blank stored name', () => {
    expect(contactDisplayName({ name: '   ' }, 'Dr. Smith-c_abc', 'c_abc')).toBe('Dr. Smith')
  })
})
