import { describe, expect, test } from 'vitest'
import {
  ASSIGNMENT_OPERATOR_INFO,
  BINARY_OPERATOR_INFO,
  LOGICAL_OPERATOR_INFO,
  UNARY_OPERATOR_INFO,
  UPDATE_OPERATOR_INFO,
} from '../src/expr/operators.js'
import { compileExpression, evaluate, parseExpression } from '../src/index.js'

describe('operator registry contracts', () => {
  test('parses every registered binary operator', () => {
    for (const operator of Object.keys(BINARY_OPERATOR_INFO)) {
      expect(parseExpression(`left ${operator} right`, { allowIn: true })).toMatchObject({
        type: 'BinaryExpression',
        operator,
      })
    }
  })

  test('parses every registered logical operator', () => {
    for (const operator of Object.keys(LOGICAL_OPERATOR_INFO)) {
      expect(parseExpression(`left ${operator} right`)).toMatchObject({
        type: 'LogicalExpression',
        operator,
      })
    }
  })

  test('parses every registered unary operator', () => {
    for (const operator of Object.keys(UNARY_OPERATOR_INFO)) {
      expect(parseExpression(`${operator} value`)).toMatchObject({
        type: 'UnaryExpression',
        operator,
      })
    }
  })

  const assignmentCases: ReadonlyArray<readonly [string, number]> = [
    ['=', 2],
    ['+=', 5],
    ['-=', 1],
    ['*=', 6],
    ['/=', 1.5],
    ['%=', 1],
    ['**=', 9],
    ['<<=', 12],
    ['>>=', 0],
    ['>>>=', 0],
    ['|=', 3],
    ['^=', 1],
    ['&=', 2],
    ['||=', 3],
    ['&&=', 2],
    ['??=', 3],
  ]

  test('the assignment execution matrix covers the complete registry', () => {
    expect(assignmentCases.map(([operator]) => operator).sort()).toEqual(
      Object.keys(ASSIGNMENT_OPERATOR_INFO).sort(),
    )
  })

  test.each(assignmentCases)(
    'supports %s through parse, direct, and compiled paths',
    (operator, expected) => {
      const source = `value ${operator} 2`
      expect(parseExpression(source, { allowAssignments: true })).toMatchObject({
        type: 'AssignmentExpression',
        operator,
      })
      expect(() => parseExpression(source)).toThrow('read-only expressions')
      expect(evaluate(source, { value: 3 }, { writes: 'overlay' })).toBe(expected)
      expect(compileExpression(source, { writes: 'overlay' }).evaluate({ value: 3 })).toBe(expected)
    },
  )

  test('assignment expressions remain right-associative', () => {
    expect(parseExpression('left = right += 2', { allowAssignments: true })).toMatchObject({
      type: 'AssignmentExpression',
      operator: '=',
      right: {
        type: 'AssignmentExpression',
        operator: '+=',
      },
    })
  })

  const binaryCases: ReadonlyArray<readonly [string, unknown, unknown, unknown]> = [
    ['|', 5, 2, 7],
    ['^', 5, 3, 6],
    ['&', 5, 3, 1],
    ['==', '2', 2, true],
    ['!=', '2', 2, false],
    ['===', '2', 2, false],
    ['!==', '2', 2, true],
    ['<', 1, 2, true],
    ['>', 2, 1, true],
    ['<=', 2, 2, true],
    ['>=', 2, 2, true],
    ['in', 'key', { key: true }, true],
    ['instanceof', new Date(0), Date, true],
    ['<<', 3, 2, 12],
    ['>>', -8, 2, -2],
    ['>>>', -1, 1, 2_147_483_647],
    ['+', 3, 2, 5],
    ['-', 3, 2, 1],
    ['*', 3, 2, 6],
    ['/', 3, 2, 1.5],
    ['%', 3, 2, 1],
    ['**', 3, 2, 9],
  ]

  test('the binary execution matrix covers the complete registry', () => {
    expect(binaryCases.map(([operator]) => operator).sort()).toEqual(
      Object.keys(BINARY_OPERATOR_INFO).sort(),
    )
  })

  test.each(binaryCases)(
    'executes binary %s through direct and compiled paths',
    (operator, left, right, expected) => {
      const source = `left ${operator} right`
      const context = { left, right }
      expect(evaluate(source, context, { allowIn: true })).toBe(expected)
      expect(compileExpression(source, { allowIn: true }).evaluate(context)).toBe(expected)
    },
  )

  const logicalCases: ReadonlyArray<readonly [string, unknown, unknown, unknown]> = [
    ['&&', true, 2, 2],
    ['||', false, 2, 2],
    ['??', null, 2, 2],
  ]

  test('the logical execution matrix covers the complete registry', () => {
    expect(logicalCases.map(([operator]) => operator).sort()).toEqual(
      Object.keys(LOGICAL_OPERATOR_INFO).sort(),
    )
  })

  test.each(logicalCases)(
    'executes logical %s through direct and compiled paths',
    (operator, left, right, expected) => {
      const source = `left ${operator} right`
      const context = { left, right }
      expect(evaluate(source, context)).toBe(expected)
      expect(compileExpression(source).evaluate(context)).toBe(expected)
    },
  )

  const unaryCases: ReadonlyArray<readonly [string, unknown, unknown]> = [
    ['!', true, false],
    ['~', 1, -2],
    ['+', '2', 2],
    ['-', 1, -1],
    ['typeof', 1, 'number'],
    ['void', 1, undefined],
  ]

  test('the unary execution matrix covers the complete registry', () => {
    expect(unaryCases.map(([operator]) => operator).sort()).toEqual(
      Object.keys(UNARY_OPERATOR_INFO).sort(),
    )
  })

  test.each(unaryCases)(
    'executes unary %s through direct and compiled paths',
    (operator, value, expected) => {
      const source = `${operator} value`
      const context = { value }
      expect(evaluate(source, context)).toBe(expected)
      expect(compileExpression(source).evaluate(context)).toBe(expected)
    },
  )

  const updateCases = [
    ['++', true, 2, 2],
    ['++', false, 1, 2],
    ['--', true, 0, 0],
    ['--', false, 1, 0],
  ] as const

  test('the update execution matrix covers the complete registry', () => {
    expect([...new Set(updateCases.map(([operator]) => operator))].sort()).toEqual(
      Object.keys(UPDATE_OPERATOR_INFO).sort(),
    )
  })

  test.each(updateCases)(
    'supports %s with prefix=%s through parse, direct, and compiled paths',
    (operator, prefix, expected, updated) => {
      const source = prefix ? `${operator}value` : `value${operator}`
      expect(parseExpression(source, { allowAssignments: true })).toMatchObject({
        type: 'UpdateExpression',
        operator,
        prefix,
        argument: { type: 'Identifier', name: 'value' },
      })
      expect(() => parseExpression(source)).toThrow('read-only expressions')

      const directContext = { value: 1 }
      expect(evaluate(source, directContext, { writes: 'commit' })).toBe(expected)
      expect(directContext.value).toBe(updated)

      const compiledContext = { value: 1 }
      expect(compileExpression(source, { writes: 'commit' }).evaluate(compiledContext)).toBe(
        expected,
      )
      expect(compiledContext.value).toBe(updated)
    },
  )

  test('update expressions implement ToNumeric and preserve BigInt results', () => {
    const numericContext = { value: '41' as string | number }
    expect(evaluate('value++', numericContext, { writes: 'commit' })).toBe(41)
    expect(numericContext.value).toBe(42)

    const bigintContext = { value: 1n }
    expect(compileExpression('++value', { writes: 'commit' }).evaluate(bigintContext)).toBe(2n)
    expect(bigintContext.value).toBe(2n)

    const boxedBigintContext: Record<string, unknown> = { value: Object(1n) }
    expect(evaluate('value++', boxedBigintContext, { writes: 'commit' })).toBe(1n)
    expect(boxedBigintContext.value).toBe(2n)
  })

  test('update expression precedence matches ECMAScript', () => {
    expect(evaluate('++value ** 2', { value: 2 }, { writes: 'overlay' })).toBe(9)
    expect(evaluate('value++ ** 2', { value: 2 }, { writes: 'overlay' })).toBe(4)
    expect(evaluate('-value++', { value: 2 }, { writes: 'overlay' })).toBe(-2)
  })

  test('updates lexical arrow bindings without writing the root context', () => {
    for (const functionMode of ['default', 'performance'] as const) {
      const context = { value: 10 }
      expect(
        evaluate('((value) => [value++, ++value, value])(1)', context, {
          writes: 'overlay',
          functionMode,
        }),
      ).toEqual([1, 3, 3])
      expect(context.value).toBe(10)
    }
  })

  test('rejects invalid update targets and postfix updates across line terminators', () => {
    expect(() => parseExpression('++object.value', { allowAssignments: true })).toThrow(
      'Only identifier bindings can be updated',
    )
    expect(() => parseExpression('(left + right)--', { allowAssignments: true })).toThrow(
      'Only identifier bindings can be updated',
    )
    expect(() => parseExpression('value\n++', { allowAssignments: true })).toThrow(
      "Unexpected token '++' after expression",
    )
  })
})
