import { describe, expect, it } from 'vitest'
import { argBoolean, argExtension, argNumber, argString, argsObject } from './args'

describe('tool argument normalization', () => {
  it('parses JSON-string arguments and rejects malformed payloads', () => {
    expect(argsObject('{"path":"/life/notes/a.md"}')).toEqual({ path: '/life/notes/a.md' })
    expect(argsObject('not-json')).toEqual({})
    expect(argsObject(null)).toEqual({})
    expect(argsObject({ path: '/life/a.md' })).toEqual({ path: '/life/a.md' })
  })

  it('coerces numbers and booleans written as strings', () => {
    expect(argNumber('12')).toBe(12)
    expect(argNumber(' 3.5 ')).toBe(3.5)
    expect(argNumber('abc')).toBeUndefined()
    expect(argBoolean('true')).toBe(true)
    expect(argBoolean('0')).toBe(false)
    expect(argBoolean('yes')).toBe(true)
    expect(argBoolean('maybe')).toBeUndefined()
  })

  it('trims strings and normalizes extensions', () => {
    expect(argString('  /life ')).toBe('/life')
    expect(argExtension(' MD ')).toBe('md')
    expect(argExtension('.py')).toBe('py')
    expect(argExtension('..tar.gz')).toBe('tar.gz')
    expect(argExtension('')).toBeUndefined()
    expect(argExtension('  .  ')).toBeUndefined()
    expect(argExtension(undefined)).toBeUndefined()
  })
})
