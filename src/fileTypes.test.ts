import { describe, expect, it } from 'vitest'
import {
  baseNameOf,
  exportFileName,
  fileNameError,
  fileTypeLabel,
  normalizeExtension,
} from './fileTypes'

describe('baseNameOf', () => {
  it('strips the persisted extension', () => {
    expect(baseNameOf('/life/notes/报告.md', 'md')).toBe('报告')
    expect(baseNameOf('/life/notes/压缩包.tar.gz', 'tar.gz')).toBe('压缩包')
  })

  it('treats the whole name as the base without an extension', () => {
    expect(baseNameOf('/life/notes/无扩展名', '')).toBe('无扩展名')
  })

  it('matches the suffix case-insensitively', () => {
    expect(baseNameOf('/life/notes/A.MD', 'md')).toBe('A')
    // A suffix that does not match the stored extension stays in the name.
    expect(baseNameOf('/life/notes/notes.2026', 'md')).toBe('notes.2026')
  })
})

describe('normalizeExtension', () => {
  it('accepts dots and preserves the typed case', () => {
    expect(normalizeExtension('MD')).toEqual({ ext: 'MD' })
    expect(normalizeExtension('.tar.gz')).toEqual({ ext: 'tar.gz' })
    expect(normalizeExtension('笔记')).toEqual({ ext: '笔记' })
  })

  it('rejects separators and a trailing dot', () => {
    expect(normalizeExtension('a b').error).toBeTruthy()
    expect(normalizeExtension('a/b').error).toBeTruthy()
    expect(normalizeExtension('tar.').error).toBeTruthy()
  })

  it('only allows empty when the caller opts in', () => {
    expect(normalizeExtension('').error).toBeTruthy()
    expect(normalizeExtension('.', true)).toEqual({ ext: '' })
  })
})

describe('exportFileName', () => {
  it('mirrors the editor name: base + persisted extension', () => {
    expect(exportFileName('报告', 'md', false)).toBe('报告.md')
    expect(exportFileName('规格', 'spec.draft', false)).toBe('规格.spec.draft')
    expect(exportFileName('A', 'MD', false)).toBe('A.MD')
  })

  it('keeps extension-less documents extension-less', () => {
    expect(exportFileName('无扩展名', '', false)).toBe('无扩展名')
  })

  it('changes the container to zip only for the image bundle', () => {
    expect(exportFileName('报告', 'md', true)).toBe('报告.md.zip')
    expect(exportFileName('报告', '', true)).toBe('报告.zip')
  })

  it('falls back for a blank base', () => {
    expect(exportFileName('  ', 'md', false)).toBe('未命名.md')
  })
})

describe('labels and base names', () => {
  it('labels documents without an extension', () => {
    expect(fileTypeLabel('')).toBe('无扩展名')
    expect(fileTypeLabel('tar.gz')).toContain('.tar.gz')
  })

  it('rejects dots in the base name', () => {
    expect(fileNameError('报告', false)).toBeNull()
    expect(fileNameError('版本 v1.2', false)).toBeTruthy()
    expect(fileNameError('.', false)).toBeTruthy()
  })

  it('rejects every control character the backend rejects', () => {
    // C0, DEL and C1 all fail `char::is_control` on the Rust side. The control
    // character sits mid-string because both validators trim the edges first.
    for (const c of ['\u0001', '\u000a', '\u001f', '\u007f', '\u0085', '\u009f']) {
      expect(fileNameError(`报${c}告`, false)).toBeTruthy()
      expect(normalizeExtension(`md${c}x`).error).toBeTruthy()
    }
  })
})
