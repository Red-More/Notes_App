import { describe, expect, it } from 'vitest'
import { classifyHref } from './links'

describe('classifyHref', () => {
  it('copies and opens absolute web links', () => {
    expect(
      classifyHref('https://example.com/a?b=1', 'https://example.com/a?b=1'),
    ).toEqual({
      address: 'https://example.com/a?b=1',
      internal: false,
      openable: true,
    })
  })

  it('uses the resolved URL for protocol-relative links', () => {
    expect(classifyHref('//example.com/a', 'https://example.com/a')).toEqual({
      address: 'https://example.com/a',
      internal: false,
      openable: true,
    })
  })

  it('keeps in-page anchors internal', () => {
    expect(classifyHref('#fn1', 'https://app.example/#fn1')).toEqual({
      address: '#fn1',
      internal: true,
      openable: false,
    })
  })

  it('supports mailto and tel links', () => {
    expect(classifyHref('mailto:a@example.com', 'mailto:a@example.com')).toEqual({
      address: 'mailto:a@example.com',
      internal: false,
      openable: true,
    })
    expect(classifyHref('tel:+8613800000000', 'tel:+8613800000000')).toEqual({
      address: 'tel:+8613800000000',
      internal: false,
      openable: true,
    })
  })

  it('copies relative links without trying to open them', () => {
    expect(classifyHref('docs/guide.md', 'https://app.example/docs/guide.md')).toEqual({
      address: 'docs/guide.md',
      internal: false,
      openable: false,
    })
  })

  it('ignores empty and javascript links', () => {
    expect(classifyHref('   ', 'https://app.example/')).toBeNull()
    expect(classifyHref('javascript:alert(1)', 'javascript:alert(1)')).toBeNull()
  })
})
