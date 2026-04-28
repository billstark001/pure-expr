import { describe, expect, test } from 'vitest'

import {
  allowAllCalls,
  compile,
  compileExpression,
  compileTemplate,
  defaultCallPermissionPolicy,
  JSEvaluator,
  parseExpression,
  parseTemplate,
  renderTemplate,
  tokenizeExpression,
} from '../src/index.js'

// #region Public API coverage

describe('public API', () => {
  test('tokenizeExpression exposes lexer output', () => {
    expect(tokenizeExpression('count + 1').map((token) => token.raw)).toEqual(['count', '+', '1'])
  })

  test('parseExpression exposes the expression AST', () => {
    expect(parseExpression('count + 1')).toMatchObject({
      type: 'binary',
      operator: '+',
    })
  })

  test('compileExpression supports reusable evaluation', () => {
    const compiled = compileExpression('count + 1')

    expect(compiled.evaluate({ count: 1 })).toBe(2)
    expect(compiled.evaluate({ count: 4 })).toBe(5)
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
