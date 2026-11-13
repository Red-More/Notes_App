import { describe, expect, it } from 'vitest'
import { argBoolean, argGrepType, argNumber, argString, argsObject } from './args'

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

  it('trims strings and maps enum aliases', () => {
    expect(argString('  /life ')).toBe('/life')
    expect(argGrepType('TODO')).toBe('todo')
    expect(argGrepType('日记')).toBe('diary')
    expect(argGrepType('schedule')).toBeUndefined()
    expect(argGrepType('unknown-kind')).toBeUndefined()
  })
})
