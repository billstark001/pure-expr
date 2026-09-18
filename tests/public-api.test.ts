import { describe, expect, test } from 'vitest'

import {
  allowAllCalls,
  compile,
  compileExpression,
  compileTemplate,
  defaultCallPermissionPolicy,
  JSEvaluator,
  JSLexer,
  parseExpression,
  parseTemplate,
  renderTemplate,
  tokenizeExpression,
} from '../src/index.js'

// #region Public API coverage

describe('public API', () => {
  test('tokenizeExpression exposes lexer output', () => {
    expect(tokenizeExpression('count + 1').map((token) => token.value)).toEqual(['count', '+', '1'])
  })

  test('JSLexer options are available from the package entrypoint', () => {
    const [token] = new JSLexer('0xff', { raw: true, numbers: { radices: [16] } }).tokenize()

    expect(token).toEqual({ kind: 'number', value: '0xff', raw: '0xff', start: 0, end: 4 })
  })

  test('parseExpression exposes the expression AST', () => {
    expect(parseExpression('count + 1')).toMatchObject({
      type: 'BinaryExpression',
      operator: '+',
    })
  })

  test('parseExpression emits restricted ESTree shapes', () => {
    expect(parseExpression('undefined')).toMatchObject({ type: 'Identifier', name: 'undefined' })
    expect(parseExpression('obj?.a.b')).toMatchObject({
      type: 'ChainExpression',
      expression: {
        type: 'MemberExpression',
        object: {
          type: 'MemberExpression',
          optional: true,
        },
        optional: false,
      },
    })
    expect(parseExpression('x => `v:${x}`')).toMatchObject({
      type: 'ArrowFunctionExpression',
      expression: true,
      generator: false,
      async: false,
      params: [{ type: 'Identifier', name: 'x' }],
      body: {
        type: 'TemplateLiteral',
        quasis: [{ type: 'TemplateElement' }, { type: 'TemplateElement', tail: true }],
      },
    })
    expect(parseExpression('1 |> % + 1')).toMatchObject({
      type: 'PipelineExpression',
      right: { type: 'BinaryExpression' },
    })
  })

  test('parseExpression omits parser offsets and can emit ESTree locations', () => {
    const unlocated = parseExpression('count + 1')
    const visit = (value: unknown): void => {
      if (!value || typeof value !== 'object') return
      expect(value).not.toHaveProperty('start')
      expect(value).not.toHaveProperty('end')
      if (Array.isArray(value)) value.forEach(visit)
      else Object.values(value).forEach(visit)
    }
    visit(unlocated)
    expect(unlocated).not.toHaveProperty('loc')

    const located = parseExpression('count +\n value', {
      locations: { startLine: 4, startColumn: 7, source: 'example.expr' },
    })
    expect(located).toMatchObject({
      loc: {
        source: 'example.expr',
        start: { line: 4, column: 7 },
        end: { line: 5, column: 6 },
      },
    })
    if (located.type !== 'BinaryExpression') throw new Error('Expected BinaryExpression')
    expect(located.left.loc).toEqual({
      source: 'example.expr',
      start: { line: 4, column: 7 },
      end: { line: 4, column: 12 },
    })
    expect(located.right.loc).toEqual({
      source: 'example.expr',
      start: { line: 5, column: 1 },
      end: { line: 5, column: 6 },
    })
  })

  test('parseExpression locates template elements and handles CRLF', () => {
    const template = parseExpression('`a${\r\n value}b`', { locations: true })
    expect(template).toMatchObject({
      type: 'TemplateLiteral',
      loc: { start: { line: 1, column: 0 }, end: { line: 2, column: 9 } },
      quasis: [
        { loc: { start: { line: 1, column: 1 }, end: { line: 1, column: 2 } } },
        { loc: { start: { line: 2, column: 7 }, end: { line: 2, column: 8 } } },
      ],
      expressions: [{ loc: { start: { line: 2, column: 1 }, end: { line: 2, column: 6 } } }],
    })
  })

  test('parseExpression rejects invalid location origins', () => {
    expect(() => parseExpression('x', { locations: { startLine: 0 } })).toThrow(
      'locations.startLine',
    )
    expect(() => parseExpression('x', { locations: { startColumn: -1 } })).toThrow(
      'locations.startColumn',
    )
  })

  test('compileExpression supports reusable evaluation', () => {
    const compiled = compileExpression('count + 1')

    expect(compiled.evaluate({ count: 1 })).toBe(2)
    expect(compiled.evaluate({ count: 4 })).toBe(5)
  })

  test('compileExpression preserves optional chains and step accounting', () => {
    const optional = compileExpression('obj?.missing.value')
    expect(optional.evaluate({ obj: null })).toBe(undefined)

    const budgeted = compileExpression('({ 1: value })', { maxSteps: 3 })
    expect(() => budgeted.evaluate({ value: 1 })).toThrow('Maximum evaluation steps')
  })

  test('compileExpression supports generated arrow functions with the default call policy', () => {
    const compiled = compileExpression('(value => value + step)(count)')

    expect(compiled.evaluate({ count: 2, step: 3 })).toBe(5)
  })

  test('compileExpression supports the performance function backend for generated arrows', () => {
    const compiled = compileExpression('(value => value + step)(count)', {
      functionMode: 'performance',
    })

    expect(compiled.evaluate({ count: 2, step: 3 })).toBe(5)
  })

  test('compile alias is exported from the root entrypoint', () => {
    const compiled = compile('count + 2')

    expect(compiled.source).toBe('count + 2')
    expect(compiled.evaluate({ count: 3 })).toBe(5)
  })

  test('allowAllCalls is exported from the root entrypoint', () => {
    const compiled = compileExpression('double(count)', { isCallableAllowed: allowAllCalls })

    expect(compiled.evaluate({ count: 3, double: (value: number) => value * 2 })).toBe(6)
  })

  test('defaultCallPermissionPolicy is exported from the root entrypoint', () => {
    expect(
      defaultCallPermissionPolicy({
        kind: 'call',
        fn: String.prototype.normalize,
        thisValue: 'A\u030A',
        node: parseExpression('"A\\u030A".normalize("NFC")'),
      }),
    ).toBe(true)
  })

  test('parseExpression can disable arrow functions', () => {
    expect(() => parseExpression('value => value', { allowArrowFunctions: false })).toThrow(
      'Arrow functions are not enabled',
    )
  })

  test('JSEvaluator merges base and per-call contexts without leaking overrides', () => {
    const evaluator = new JSEvaluator({ count: 1, step: 2 })
    const ast = parseExpression('count + step')

    expect(evaluator.evaluate(ast)).toBe(3)
    expect(evaluator.evaluate(ast, { count: 5 })).toBe(7)
    expect(evaluator.evaluate(ast)).toBe(3)
  })

  test('template helpers remain available from the root entrypoint', () => {
    expect(parseTemplate('Hi {{ name }}').segments).toHaveLength(2)
    expect(renderTemplate('Hi {{ name }}', { name: 'Ada' }).output).toBe('Hi Ada')
  })

  test('compileTemplate is exported from the root entrypoint', () => {
    const compiled = compileTemplate('Hi {{ name }}')

    expect(compiled.source).toBe('Hi {{ name }}')
    expect(compiled.render({ name: 'Ada' }).output).toBe('Hi Ada')
  })
})

// #endregion
