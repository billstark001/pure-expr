import { describe, expect, test } from 'vitest'
import {
  JSIncompleteParseError,
  parseBindingPattern,
  parseExpression,
  parseIterationClause,
  scanBindingPattern,
  scanExpression,
} from '../src/index.js'

const stopAtOf = ({ token, depth }: { token: { kind: string; value: string }; depth: number }) =>
  depth === 0 && token.kind === 'identifier' && token.value === 'of'

describe('expression scanner', () => {
  test('scans interpolations from absolute source offsets', () => {
    const source = 'You are $name, your job is $job.'
    const name = scanExpression(source, {
      start: source.indexOf('$name'),
      profile: 'interpolation',
    })
    const job = scanExpression(source, {
      start: source.indexOf('$job'),
      profile: 'interpolation',
    })

    expect(name).toMatchObject({
      expression: { type: 'Identifier', name: '$name' },
      end: source.indexOf(','),
      next: source.indexOf(','),
      stoppedBy: 'boundary',
    })
    expect(job).toMatchObject({
      expression: { type: 'Identifier', name: '$job' },
      end: source.indexOf('.'),
      next: source.indexOf('.'),
      stoppedBy: 'boundary',
    })
  })

  test('distinguishes member dots and call-internal commas from sentence punctuation', () => {
    const source = '$format(user.first, user.last).trim(), done'
    const result = scanExpression(source, { profile: 'interpolation' })

    expect(source.slice(result.start, result.end)).toBe('$format(user.first, user.last).trim()')
    expect(source[result.next]).toBe(',')
    expect(result.expression.type).toBe('CallExpression')
  })

  test('stops before postfix-looking punctuation and unknown host characters', () => {
    expect(scanExpression('$props.name!', { profile: 'interpolation' })).toMatchObject({
      expression: { type: 'MemberExpression' },
      end: 11,
      next: 11,
      stoppedBy: 'boundary',
    })
    expect(scanExpression('$name@host')).toMatchObject({
      expression: { type: 'Identifier', name: '$name' },
      end: 5,
      next: 5,
      stoppedBy: 'boundary',
    })
  })

  test.each(['value +', 'object.', 'fn(', 'flag ? yes :', 'value =>'])(
    'lets callers roll back an incomplete continuation in %s',
    (source) => {
      expect(() => scanExpression(source)).toThrow(JSIncompleteParseError)
      const result = scanExpression(source, { incomplete: 'rollback' })
      expect(result.stoppedBy).toBe('incomplete')
      expect(source.slice(result.start, result.end)).toMatch(/^(value|object|fn|flag)$/)
      expect(result.next).toBeGreaterThanOrEqual(result.end)
    },
  )

  test('reports the complete consumed range for parenthesized roots', () => {
    const result = scanExpression('(value), text', { profile: 'interpolation' })
    expect(result).toMatchObject({ end: 7, next: 7, stoppedBy: 'boundary' })
    expect(result.expression).toMatchObject({ type: 'Identifier', name: 'value' })
  })

  test('does not turn hard syntax or unterminated lexical constructs into boundaries', () => {
    expect(() => scanExpression('value + * other', { incomplete: 'rollback' })).toThrow(
      "Unexpected token '*'",
    )
    expect(() => scanExpression('$name "unterminated', { incomplete: 'rollback' })).toThrow(
      'Unterminated string literal',
    )
  })

  test('supports contextual keyword boundaries without changing expression grammar', () => {
    const result = scanExpression('item of collection.filter(active)', { boundary: stopAtOf })
    expect(result).toMatchObject({
      expression: { type: 'Identifier', name: 'item' },
      end: 4,
      next: 5,
      stoppedBy: 'boundary',
    })
    expect(() => parseExpression('item of collection')).toThrow("Unexpected token 'of'")
  })

  test('preserves absolute locations and applies AST budgets', () => {
    const source = 'prefix $user.name, suffix'
    const result = scanExpression(source, {
      start: source.indexOf('$user'),
      profile: 'interpolation',
      locations: true,
    })
    expect(result.expression.loc).toEqual({
      start: { line: 1, column: 7 },
      end: { line: 1, column: 17 },
    })
    expect(() => scanExpression('$user.name', { maxAstNodes: 2 })).toThrow('maximum AST node count')
  })
})

describe('binding-pattern parser and scanner', () => {
  test('parses standalone ESTree binding patterns', () => {
    expect(
      parseBindingPattern('{ id: local, nested: [first, ...rest], value = fallback }'),
    ).toMatchObject({
      type: 'ObjectPattern',
      properties: [
        { value: { type: 'Identifier', name: 'local' } },
        { value: { type: 'ArrayPattern' } },
        { value: { type: 'AssignmentPattern' } },
      ],
    })
  })

  test('scans a destructuring binding before a contextual of keyword', () => {
    const source = '[item, index] of entries'
    const result = scanBindingPattern(source, { boundary: stopAtOf })
    expect(result).toMatchObject({
      pattern: { type: 'ArrayPattern' },
      end: source.indexOf(' of'),
      next: source.indexOf('of'),
      stoppedBy: 'boundary',
    })
  })

  test('supports strict and rollback behavior for binding defaults', () => {
    expect(() => scanBindingPattern('value =')).toThrow(JSIncompleteParseError)
    expect(scanBindingPattern('value =', { incomplete: 'rollback' })).toMatchObject({
      pattern: { type: 'Identifier', name: 'value' },
      end: 5,
      next: 6,
      stoppedBy: 'incomplete',
    })
  })

  test('rejects expression-only and malformed binding syntax', () => {
    expect(() => parseBindingPattern('target.member')).toThrow("Unexpected token '.'")
    expect(() => parseBindingPattern('[first, ...rest, last]')).toThrow(
      'Expected `]` after array binding pattern',
    )
  })

  test('parses contextual iteration clauses without adding an of operator', () => {
    expect(parseIterationClause('{ item: value, index = 0 } of rows.filter(active)')).toMatchObject(
      {
        binding: { type: 'ObjectPattern' },
        iterable: { type: 'CallExpression' },
        separatorStart: 27,
        separatorEnd: 29,
      },
    )
    expect(() => parseIterationClause('item in rows')).toThrow("Expected contextual keyword 'of'")
    expect(() => parseIterationClause('item of')).toThrow(
      "Expected expression after contextual keyword 'of'",
    )
  })
})
